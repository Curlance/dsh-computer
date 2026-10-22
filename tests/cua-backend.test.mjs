import test from 'node:test'
import assert from 'node:assert/strict'

import { McpError, McpRpcError, McpToolError, TimeoutError } from '../lib/backend/mcp.js'
import { createCuaBackend, normalizeToolResult, ToolCallError } from '../lib/backend/cua.js'

const DEFAULT_SESSION = 'dsh-computer'
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function textResult(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured }
}

function createFakeClient(handler = () => textResult('ok')) {
  const calls = []
  const state = { starts: 0, closes: 0 }
  return {
    calls,
    state,
    async start() {
      state.starts += 1
    },
    async call(name, args) {
      calls.push({ name, args })
      return handler(name, args, calls.length)
    },
    async close() {
      state.closes += 1
    },
  }
}

function withSession(args, session = DEFAULT_SESSION) {
  return { ...args, session }
}

test('normalizeToolResult concatenates text and preserves structured content', () => {
  const structured = { windows: [{ window_id: 20 }] }
  const result = normalizeToolResult({
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
    structuredContent: structured,
  })
  assert.deepEqual(result, { text: 'first\nsecond', structured })
})

test('normalizeToolResult decodes image/png content and ignores other image types', () => {
  const result = normalizeToolResult({
    content: [
      { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
      { type: 'image', mimeType: 'image/jpeg', data: 'ignored' },
    ],
    structuredContent: { screenshot_width: 1456 },
  })
  assert.equal(Buffer.isBuffer(result.image), true)
  assert.deepEqual(result.image, PNG)
  assert.equal(result.text, '')
  assert.deepEqual(result.structured, { screenshot_width: 1456 })
})

test('normalizeToolResult returns empty text and no image when there is no content', () => {
  for (const raw of [undefined, null, {}, { content: [] }]) {
    const result = normalizeToolResult(raw)
    assert.deepEqual(result, { text: '', structured: undefined })
    assert.equal('image' in result, false)
  }
})

test('getWindowState maps camelCase options to cua-driver arguments with the single session label', async () => {
  const client = createFakeClient(() => textResult('tree', { elements: [] }))
  const backend = createCuaBackend({ client, session: 'run-7' })

  const result = await backend.getWindowState({
    pid: 10,
    windowId: 20,
    includeScreenshot: true,
    treeFormat: 'elements',
    maxElements: 200,
    query: 'Save',
  })

  assert.deepEqual(client.calls, [
    {
      name: 'get_window_state',
      args: {
        pid: 10,
        window_id: 20,
        include_screenshot: true,
        tree_format: 'elements',
        max_elements: 200,
        query: 'Save',
        session: 'run-7',
      },
    },
  ])
  assert.deepEqual(result, { text: 'tree', structured: { elements: [] } })
})

test('getWindowState defaults to the elements tree and omits unset options', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client })

  await backend.getWindowState({ pid: 10, windowId: 20 })

  assert.deepEqual(client.calls[0].args, {
    pid: 10,
    window_id: 20,
    tree_format: 'elements',
    session: DEFAULT_SESSION,
  })
})

test('getWindowState passes screenshot sizing options through', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client })

  await backend.getWindowState({
    pid: 10,
    windowId: 20,
    includeScreenshot: true,
    maxImageDimension: 1456,
    screenshotOutFile: 'C:\\Temp\\shot.png',
  })

  assert.deepEqual(client.calls[0].args, {
    pid: 10,
    window_id: 20,
    include_screenshot: true,
    tree_format: 'elements',
    max_image_dimension: 1456,
    screenshot_out_file: 'C:\\Temp\\shot.png',
    session: DEFAULT_SESSION,
  })
})

test('action methods pass snake_case fields through unchanged and add the session label', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client, session: 'actions' })

  const cases = [
    [
      'click',
      'click',
      {
        pid: 10,
        window_id: 20,
        x: 5,
        y: 6,
        element_token: 's0000001:3',
        button: 'right',
        count: 2,
        delivery_mode: 'background',
      },
    ],
    [
      'typeText',
      'type_text',
      { pid: 10, window_id: 20, text: 'hello', x: 5, y: 6, delay_ms: 10 },
    ],
    [
      'pressKey',
      'press_key',
      { pid: 10, window_id: 20, key: 'return', modifiers: ['ctrl'], delivery_mode: 'background' },
    ],
    ['hotkey', 'hotkey', { pid: 10, window_id: 20, keys: ['ctrl', 'c'] }],
    ['scroll', 'scroll', { pid: 10, window_id: 20, direction: 'down', amount: 3, x: 5, y: 6 }],
    [
      'drag',
      'drag',
      { pid: 10, window_id: 20, from_x: 1, from_y: 2, to_x: 3, to_y: 4, duration_ms: 400 },
    ],
    ['moveCursor', 'move_cursor', { x: 100, y: 200, target: { kind: 'window', pid: 10, window_id: 20 } }],
  ]

  for (const [method, tool, args] of cases) {
    const snapshot = structuredClone(args)
    const result = await backend[method](args)
    assert.deepEqual(client.calls.at(-1), { name: tool, args: withSession(args, 'actions') })
    assert.deepEqual(args, snapshot, `${method} must not mutate its arguments`)
    assert.deepEqual(result, { text: 'ok', structured: undefined })
  }

  assert.equal(client.calls.length, cases.length)
})

test('the adapter session label wins over a session supplied in arguments', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client, session: 'owned' })

  await backend.click({ pid: 10, session: 'someone-else' })

  assert.equal(client.calls[0].args.session, 'owned')
  assert.equal(client.calls[0].args.pid, 10)
})

test('listWindows, listApps, getDesktopState and getCursorPosition map tool names and options', async () => {
  const client = createFakeClient((name) => textResult(name, { tool: name }))
  const backend = createCuaBackend({ client, session: 'reads' })

  await backend.listWindows({ on_screen_only: true, pid: 10, app: 'Notepad' })
  await backend.listWindows()
  await backend.listApps()
  await backend.getDesktopState({ maxImageDimension: 1456, screenshotOutFile: '/tmp/shot.png' })
  await backend.getCursorPosition()

  assert.deepEqual(
    client.calls.map((call) => call.name),
    ['list_windows', 'list_windows', 'list_apps', 'get_desktop_state', 'get_cursor_position'],
  )
  assert.deepEqual(client.calls[0].args, {
    on_screen_only: true,
    pid: 10,
    app: 'Notepad',
    session: 'reads',
  })
  assert.deepEqual(client.calls[1].args, { session: 'reads' })
  assert.deepEqual(client.calls[2].args, { session: 'reads' })
  assert.deepEqual(client.calls[3].args, {
    max_image_dimension: 1456,
    screenshot_out_file: '/tmp/shot.png',
    session: 'reads',
  })
  assert.deepEqual(client.calls[4].args, { session: 'reads' })
})

test('window and process management methods map camelCase targets to snake_case', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client, session: 'manage' })

  await backend.launchApp({ name: 'Notepad', start_minimized: true })
  await backend.bringToFront({ pid: 10, windowId: 20 })
  await backend.setWindowFrame({ pid: 10, windowId: 20, x: 1, y: 2, width: 300, height: 200 })
  await backend.killApp({ pid: 10 })

  assert.deepEqual(
    client.calls.map((call) => call.name),
    ['launch_app', 'bring_to_front', 'set_window_frame', 'kill_app'],
  )
  assert.deepEqual(client.calls[0].args, {
    name: 'Notepad',
    start_minimized: true,
    session: 'manage',
  })
  assert.deepEqual(client.calls[1].args, { pid: 10, window_id: 20, session: 'manage' })
  assert.deepEqual(client.calls[2].args, {
    pid: 10,
    window_id: 20,
    x: 1,
    y: 2,
    width: 300,
    height: 200,
    session: 'manage',
  })
  assert.deepEqual(client.calls[3].args, { pid: 10, session: 'manage' })
})

test('cursor methods reuse the session label established by startSession', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client })

  await backend.startSession({ label: 'run-9', theme: { theme_id: 'cua.default' } })
  await backend.setAgentCursorEnabled(true)
  await backend.setAgentCursorMotion({ idle_hide_ms: 0, glide_duration_ms: 600 })
  await backend.getAgentCursorState()
  await backend.setAgentCursorTheme('cua.default')
  await backend.listApps()

  assert.deepEqual(
    client.calls.map((call) => call.name),
    [
      'start_session',
      'set_agent_cursor_enabled',
      'set_agent_cursor_motion',
      'get_agent_cursor_state',
      'set_agent_cursor_theme',
      'list_apps',
    ],
  )
  assert.deepEqual(client.calls[0].args, {
    session: 'run-9',
    cursor_theme: { theme_id: 'cua.default' },
  })
  assert.deepEqual(client.calls[1].args, { session: 'run-9', enabled: true })
  assert.deepEqual(client.calls[2].args, {
    session: 'run-9',
    idle_hide_ms: 0,
    glide_duration_ms: 600,
  })
  assert.deepEqual(client.calls[3].args, { session: 'run-9' })
  assert.deepEqual(client.calls[4].args, { session: 'run-9', theme_id: 'cua.default' })
  assert.deepEqual(client.calls[5].args, { session: 'run-9' })
})

test('startSession wraps a string cursor theme in the driver theme object', async () => {
  const client = createFakeClient()
  const backend = createCuaBackend({ client })

  await backend.startSession({ label: 'run-10', theme: 'cua.dark' })
  await backend.listApps()

  assert.deepEqual(client.calls[0].args, {
    session: 'run-10',
    cursor_theme: { theme_id: 'cua.dark' },
  })
  assert.deepEqual(client.calls[1].args, { session: 'run-10' })
})

test('a failed startSession does not advance the session label used by later calls', async () => {
  const failure = new McpToolError('session label already in use', { toolName: 'start_session' })
  const client = createFakeClient((name) => {
    if (name === 'start_session') throw failure
    return textResult('ok')
  })
  const backend = createCuaBackend({ client, session: 'original' })

  await assert.rejects(backend.startSession({ label: 'replacement' }), (error) => {
    assert.ok(error instanceof ToolCallError)
    assert.equal(error.cause, failure)
    return true
  })
  assert.deepEqual(client.calls[0].args, { session: 'replacement' })

  await backend.listApps()
  assert.deepEqual(client.calls[1].args, { session: 'original' })
})

test('isError from the client becomes ToolCallError with tool name and cause', async () => {
  const failure = new McpToolError('window 20 does not belong to pid 10', {
    toolName: 'get_window_state',
  })
  const client = createFakeClient(() => {
    throw failure
  })
  const backend = createCuaBackend({ client })

  await assert.rejects(backend.getWindowState({ pid: 10, windowId: 20 }), (error) => {
    assert.ok(error instanceof ToolCallError)
    assert.equal(error.name, 'ToolCallError')
    assert.equal(error.toolName, 'get_window_state')
    assert.equal(error.cause, failure)
    assert.match(error.message, /get_window_state/)
    assert.match(error.message, /does not belong/)
    return true
  })

  assert.equal(client.calls.length, 1)
  assert.equal(client.state.closes, 0)
})

test('business errors are not retried even when a client factory is available', async () => {
  const failure = new McpToolError('refused: foreground approval required', { toolName: 'click' })
  const client = createFakeClient(() => {
    throw failure
  })
  let factoryCalls = 0
  const backend = createCuaBackend({
    client,
    createClient: () => {
      factoryCalls += 1
      return createFakeClient()
    },
  })

  await assert.rejects(backend.click({ pid: 10 }), ToolCallError)

  assert.equal(factoryCalls, 0)
  assert.equal(client.calls.length, 1)
  assert.equal(client.state.closes, 0)
})

test('RPC and ambiguous timeout errors are wrapped without retry', async () => {
  const failures = [
    new McpRpcError('invalid params', { code: -32602 }),
    new TimeoutError('MCP request timed out after 15000ms (tools/call)', {
      timeoutMs: 15000,
      method: 'tools/call',
    }),
  ]

  for (const failure of failures) {
    const client = createFakeClient(() => {
      throw failure
    })
    let factoryCalls = 0
    const backend = createCuaBackend({
      client,
      createClient: () => {
        factoryCalls += 1
        return createFakeClient()
      },
    })

    await assert.rejects(backend.listWindows(), (error) => {
      assert.ok(error instanceof ToolCallError)
      assert.equal(error.cause, failure)
      if (failure instanceof TimeoutError) {
        assert.equal(error.code, 'timeout')
        assert.equal(error.cause.code, 'timeout')
      }
      return true
    })
    assert.equal(factoryCalls, 0, `${failure.name} must not be retried`)
    assert.equal(client.calls.length, 1)
    assert.equal(client.state.closes, 0)
  }
})

test('a transport error retries once through createClient and uses the replacement afterwards', async () => {
  const transportFailure = new McpError('MCP transport stream ended')
  const first = createFakeClient(() => {
    throw transportFailure
  })
  const replacement = createFakeClient(() => textResult('recovered', { windows: [] }))
  let factoryCalls = 0
  const backend = createCuaBackend({
    client: first,
    createClient: () => {
      factoryCalls += 1
      return replacement
    },
    session: 'retry-run',
  })

  const result = await backend.listWindows({ on_screen_only: true })

  assert.equal(factoryCalls, 1)
  assert.equal(first.state.closes, 1)
  assert.equal(replacement.state.starts, 1)
  assert.deepEqual(first.calls, [
    { name: 'list_windows', args: { on_screen_only: true, session: 'retry-run' } },
  ])
  assert.deepEqual(replacement.calls, first.calls)
  assert.deepEqual(result, { text: 'recovered', structured: { windows: [] } })

  await backend.listApps()
  assert.equal(replacement.calls.length, 2)
  assert.equal(first.calls.length, 1)
})

test('a rejecting close() on the old transport still allows the one retry', async () => {
  const transportFailure = new McpError('MCP transport stream ended')
  const first = createFakeClient(() => {
    throw transportFailure
  })
  first.close = async () => {
    first.state.closes += 1
    throw new Error('already closed')
  }
  const replacement = createFakeClient(() => textResult('recovered'))
  let factoryCalls = 0
  const backend = createCuaBackend({
    client: first,
    createClient: () => {
      factoryCalls += 1
      return replacement
    },
  })

  const result = await backend.listWindows()

  assert.equal(factoryCalls, 1)
  assert.equal(first.state.closes, 1)
  assert.equal(replacement.state.starts, 1)
  assert.equal(replacement.calls.length, 1)
  assert.deepEqual(result, { text: 'recovered', structured: undefined })
})

test('a transport error without a client factory is wrapped without retry', async () => {
  const failure = new McpError('MCP transport stream ended')
  const client = createFakeClient(() => {
    throw failure
  })
  const backend = createCuaBackend({ client })

  await assert.rejects(backend.listWindows(), (error) => {
    assert.ok(error instanceof ToolCallError)
    assert.equal(error.toolName, 'list_windows')
    assert.equal(error.cause, failure)
    return true
  })

  assert.equal(client.calls.length, 1)
  assert.equal(client.state.closes, 0)
})

test('a retry that fails again is wrapped once and not retried a second time', async () => {
  const firstFailure = new McpError('MCP transport stream ended')
  const secondFailure = new McpError('MCP process exited (code 1, signal null)')
  const first = createFakeClient(() => {
    throw firstFailure
  })
  const replacement = createFakeClient(() => {
    throw secondFailure
  })
  let factoryCalls = 0
  const backend = createCuaBackend({
    client: first,
    createClient: () => {
      factoryCalls += 1
      return replacement
    },
  })

  await assert.rejects(backend.listWindows(), (error) => {
    assert.ok(error instanceof ToolCallError)
    assert.equal(error.cause, secondFailure)
    return true
  })

  assert.equal(factoryCalls, 1)
  assert.equal(first.calls.length, 1)
  assert.equal(replacement.calls.length, 1)
})

test('createCuaBackend requires a client with call()', () => {
  assert.throws(() => createCuaBackend({}), /client/)
  assert.throws(() => createCuaBackend({ client: {} }), /client/)
  assert.throws(() => createCuaBackend({ client: createFakeClient(), createClient: 42 }), /createClient/)
})
