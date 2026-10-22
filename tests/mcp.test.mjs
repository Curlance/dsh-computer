import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  createLineTransport,
  createMcpClient,
  createProcessTransport,
  McpError,
  McpRpcError,
  McpToolError,
  TimeoutError,
} from '../lib/backend/mcp.js'

function createFakeTransport() {
  const sent = []
  const messageListeners = new Set()
  const errorListeners = new Set()
  let closeCount = 0
  return {
    sent,
    get closeCount() {
      return closeCount
    },
    send(message) {
      sent.push(message)
    },
    onMessage(callback) {
      messageListeners.add(callback)
      return () => messageListeners.delete(callback)
    },
    onError(callback) {
      errorListeners.add(callback)
      return () => errorListeners.delete(callback)
    },
    receive(message) {
      for (const callback of [...messageListeners]) callback(message)
    },
    fail(error) {
      for (const callback of [...errorListeners]) callback(error)
    },
    close() {
      closeCount += 1
      messageListeners.clear()
      errorListeners.clear()
    },
  }
}

const SERVER_INFO = { name: 'cua-driver', version: '0.36.0' }

async function startClient(transport, options = {}) {
  const client = createMcpClient({ transport, ...options })
  const startPromise = client.start()
  transport.receive({
    jsonrpc: '2.0',
    id: transport.sent[0].id,
    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: SERVER_INFO },
  })
  const started = await startPromise
  return { client, started }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

const FAKE_SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.0.0' } }
      : { echoed: message.params }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
`

test('start sends initialize params then notifications/initialized', async () => {
  const transport = createFakeTransport()
  const client = createMcpClient({ transport })
  const startPromise = client.start()

  assert.equal(transport.sent.length, 1)
  assert.deepEqual(transport.sent[0], {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-computer', version: '0.1.0' },
    },
  })

  transport.receive({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: SERVER_INFO },
  })
  const started = await startPromise
  assert.deepEqual(started, { serverInfo: SERVER_INFO })

  assert.equal(transport.sent.length, 2)
  assert.deepEqual(transport.sent[1], { jsonrpc: '2.0', method: 'notifications/initialized' })

  assert.deepEqual(await client.start(), started)
  assert.equal(transport.sent.length, 2)
  await client.close()
})

test('call sends tools/call and resolves the result', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport)

  const pending = client.call('get_window_state', { pid: 10, window_id: 20 })
  assert.deepEqual(transport.sent[2], {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_window_state', arguments: { pid: 10, window_id: 20 } },
  })

  const result = {
    content: [{ type: 'text', text: '{"elements":[]}' }],
    structuredContent: { elements: [] },
    isError: false,
  }
  transport.receive({ jsonrpc: '2.0', id: 2, result })
  assert.deepEqual(await pending, result)
  await client.close()
})

test('request ids increase and responses are matched by id', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport)

  const first = client.call('first', {})
  const second = client.call('second', {})
  const third = client.call('third', {})
  assert.deepEqual(transport.sent.slice(2).map((message) => message.id), [2, 3, 4])

  transport.receive({ jsonrpc: '2.0', id: 999, result: { ignored: true } })
  transport.receive({ jsonrpc: '2.0', id: 4, result: { value: 'third' } })
  transport.receive({ jsonrpc: '2.0', id: 2, result: { value: 'first' } })
  transport.receive({ jsonrpc: '2.0', id: 3, result: { value: 'second' } })

  assert.deepEqual(await Promise.all([first, second, third]), [
    { value: 'first' },
    { value: 'second' },
    { value: 'third' },
  ])
  await client.close()
})

test('a tool result with isError throws McpToolError with the text content', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport)

  const pending = client.call('click', { element_id: 3 })
  transport.receive({
    jsonrpc: '2.0',
    id: 2,
    result: {
      content: [
        { type: 'text', text: 'window not found' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 're-run observe' },
      ],
      isError: true,
    },
  })

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof McpToolError)
    assert.equal(error.name, 'McpToolError')
    assert.equal(error.toolName, 'click')
    assert.match(error.message, /window not found\nre-run observe/)
    assert.ok(!error.message.includes('AAAA'))
    return true
  })
  await client.close()
})

test('a JSON-RPC error rejects with McpRpcError carrying code and message', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport)

  const pending = client.call('missing_tool', {})
  transport.receive({
    jsonrpc: '2.0',
    id: 2,
    error: { code: -32602, message: 'Invalid params', data: { tool: 'missing_tool' } },
  })

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof McpRpcError)
    assert.equal(error.code, -32602)
    assert.equal(error.message, 'Invalid params')
    assert.deepEqual(error.data, { tool: 'missing_tool' })
    return true
  })
  await client.close()
})

test('an unanswered request rejects with TimeoutError', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport, { timeoutMs: 25 })

  const pending = client.call('slow', {})
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof TimeoutError)
    assert.equal(error.name, 'TimeoutError')
    assert.equal(error.code, 'timeout')
    assert.match(error.message, /timed out after 25ms/)
    assert.match(error.message, /tools\/call/)
    return true
  })

  // A late response for the timed-out request is ignored.
  transport.receive({ jsonrpc: '2.0', id: 2, result: { content: [] } })
  await client.close()
})

test('close rejects pending requests, blocks later calls, and is idempotent', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport)

  const pending = client.call('slow', {})
  await client.close()

  await assert.rejects(pending, (error) => error instanceof McpError && /closed/.test(error.message))
  await assert.rejects(
    client.call('later', {}),
    (error) => error instanceof McpError && /closed/.test(error.message),
  )
  await assert.rejects(
    client.start(),
    (error) => error instanceof McpError && /closed/.test(error.message),
  )

  await client.close()
  assert.equal(transport.closeCount, 1)
})

test('call before start rejects with McpError', async () => {
  const client = createMcpClient({ transport: createFakeTransport() })
  await assert.rejects(
    client.call('list_windows', {}),
    (error) => error instanceof McpError && /not started/.test(error.message),
  )
})

test('a transport error rejects pending requests and later calls', async () => {
  const transport = createFakeTransport()
  const client = createMcpClient({ transport, timeoutMs: 5000 })

  const startPromise = client.start()
  transport.fail(new Error('pipe broke'))

  await assert.rejects(
    startPromise,
    (error) => error instanceof McpError && /pipe broke/.test(error.message),
  )
  await assert.rejects(client.call('list_windows', {}), McpError)
  await client.close()
})

test('start after a fatal transport error rejects instead of returning a stale handshake', async () => {
  const transport = createFakeTransport()
  const { client } = await startClient(transport)

  transport.fail(new Error('driver crashed'))
  await assert.rejects(
    client.start(),
    (error) => error instanceof McpError && /driver crashed/.test(error.message),
  )
  await client.close()
})

test('line transport parses partial chunks and multiple messages per chunk', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createLineTransport({ stdin: input, stdout: output })
  const messages = []
  transport.onMessage((message) => messages.push(message))

  input.write('{"jsonrpc":"2.0","id":1,')
  input.write('"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,')
  input.write('"result":{"ok":false}}\r\n\n')
  await tick()

  assert.deepEqual(messages, [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', id: 2, result: { ok: false } },
  ])
  transport.close()
})

test('line transport decodes a multibyte character split across chunks', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createLineTransport({ stdin: input, stdout: output })
  const messages = []
  transport.onMessage((message) => messages.push(message))

  const payload = Buffer.from('{"jsonrpc":"2.0","id":3,"result":{"title":"A中B"}}\n', 'utf8')
  const split = payload.indexOf(Buffer.from('中', 'utf8')) + 1 // inside 中: 0xE4 | 0xB8 0xAD
  input.write(payload.subarray(0, split))
  input.write(payload.subarray(split))
  await tick()

  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 3, result: { title: 'A中B' } }])
  transport.close()
})

test('line transport drops malformed lines and keeps parsing', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createLineTransport({ stdin: input, stdout: output })
  const messages = []
  transport.onMessage((message) => messages.push(message))

  input.write('not json\n{"partial":\n\n{"jsonrpc":"2.0","id":7,"result":{}}\n')
  await tick()

  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 7, result: {} }])
  transport.close()
})

test('line transport flushes a final message without a trailing newline', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createLineTransport({ stdin: input, stdout: output })
  const messages = []
  transport.onMessage((message) => messages.push(message))

  input.end('{"jsonrpc":"2.0","id":8,"result":{"ok":true}}')
  await tick()

  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 8, result: { ok: true } }])
  transport.close()
})

test('line transport writes newline-delimited JSON and close stops delivery', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createLineTransport({ stdin: input, stdout: output })
  const messages = []
  transport.onMessage((message) => messages.push(message))

  const chunks = []
  output.on('data', (chunk) => chunks.push(chunk.toString('utf8')))

  transport.send({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  const lines = chunks.join('').split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: { ok: true } })

  transport.close()
  input.write('{"jsonrpc":"2.0","id":2,"result":{}}\n')
  await tick()
  assert.equal(messages.length, 0)
})

test('line transport forwards stream errors to onError', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const transport = createLineTransport({ stdin: input, stdout: output })
  const errors = []
  transport.onError((error) => errors.push(error))

  input.destroy(new Error('broken pipe'))
  await tick()

  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /broken pipe/)
  transport.close()
})

test('process transport exchanges JSON-RPC with a child process', { timeout: 10000 }, async () => {
  const transport = createProcessTransport({
    command: process.execPath,
    args: ['-e', FAKE_SERVER],
  })
  const client = createMcpClient({ transport, timeoutMs: 5000 })

  try {
    const { serverInfo } = await client.start()
    assert.deepEqual(serverInfo, { name: 'fake-mcp', version: '1.0.0' })

    const result = await client.call('echo', { value: 42 })
    assert.deepEqual(result, { echoed: { name: 'echo', arguments: { value: 42 } } })
  } finally {
    await client.close()
  }
})

test('a missing MCP executable rejects start promptly with McpError', { timeout: 10000 }, async () => {
  const transport = createProcessTransport({ command: 'dsh-computer-missing-driver-xyz' })
  const client = createMcpClient({ transport, timeoutMs: 5000 })

  await assert.rejects(client.start(), (error) => {
    assert.ok(error instanceof McpError)
    assert.match(error.message, /spawn|ENOENT/i)
    return true
  })
  await assert.rejects(client.call('list_windows', {}), McpError)
  await client.close()
})
