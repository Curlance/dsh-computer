import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// MCP revision sent in initialize; the server may negotiate down to its own
// version and the client accepts whatever it returns.
const PROTOCOL_VERSION = '2025-06-18'
// Keep in sync with package.json `version`.
const CLIENT_INFO = { name: 'dsh-computer', version: '0.1.0' }
const DEFAULT_TIMEOUT_MS = 15000

function ignore() {}

/**
 * Base error for MCP client and transport failures.
 */
export class McpError extends Error {
  constructor(message) {
    super(message)
    this.name = 'McpError'
  }
}

/**
 * JSON-RPC error returned by the server.
 */
export class McpRpcError extends McpError {
  constructor(message, { code, data } = {}) {
    super(message)
    this.name = 'McpRpcError'
    this.code = code
    this.data = data
  }
}

/**
 * Successful JSON-RPC response whose tool result has `isError: true`.
 */
export class McpToolError extends McpError {
  constructor(message, { toolName = null, content = [] } = {}) {
    super(message)
    this.name = 'McpToolError'
    this.toolName = toolName
    this.content = content
  }
}

/**
 * A request received no response within the configured timeout.
 */
export class TimeoutError extends McpError {
  constructor(message, { timeoutMs, method } = {}) {
    super(message)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
    this.method = method
  }
}

function textContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (item) =>
        item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
}

/**
 * Newline-delimited JSON transport over an existing readable/writable pair.
 * Malformed lines are dropped so one bad line cannot desynchronize the stream;
 * fatal stream errors and an unexpected end of input are reported to `onError`.
 * @param {{stdin: import('node:stream').Readable, stdout: import('node:stream').Writable}} options
 */
export function createLineTransport({ stdin, stdout } = {}) {
  if (stdin === undefined || stdout === undefined) {
    throw new TypeError('createLineTransport requires stdin and stdout streams')
  }

  const messageListeners = new Set()
  const errorListeners = new Set()
  // Decodes across chunk boundaries so a multibyte character split between
  // reads is not replaced with U+FFFD.
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let closed = false

  function emitError(error) {
    for (const callback of [...errorListeners]) callback(error)
  }

  function deliver(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      // MCP has no reply channel for a malformed response; dropping it lets a
      // pending request time out instead of hanging the stream.
      return
    }
    for (const callback of [...messageListeners]) callback(message)
  }

  function onData(chunk) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      deliver(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
  }

  function onEnd() {
    if (closed) return
    buffer += decoder.end()
    if (buffer.length > 0) {
      deliver(buffer)
      buffer = ''
    }
    emitError(new McpError('MCP transport stream ended'))
  }

  function onStreamError(error) {
    if (closed) return
    emitError(error instanceof Error ? error : new McpError(String(error)))
  }

  stdin.on('data', onData)
  stdin.on('end', onEnd)
  stdin.on('error', onStreamError)
  stdout.on('error', onStreamError)

  return {
    send(message) {
      if (closed) throw new McpError('MCP transport is closed')
      stdout.write(`${JSON.stringify(message)}\n`)
    },

    onMessage(callback) {
      messageListeners.add(callback)
      return () => messageListeners.delete(callback)
    },

    onError(callback) {
      errorListeners.add(callback)
      return () => errorListeners.delete(callback)
    },

    close() {
      if (closed) return
      closed = true
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onStreamError)
      stdout.off('error', onStreamError)
      // Keep a sink for late EPIPE errors from writes already in flight.
      stdin.on('error', ignore)
      stdout.on('error', ignore)
      messageListeners.clear()
      errorListeners.clear()
    },
  }
}

/**
 * Spawn a child process and speak newline-delimited JSON-RPC over its stdio.
 * `env` is merged over the inherited environment. stderr is inherited so driver
 * diagnostics stay visible to the host.
 * @param {{command: string, args?: string[], env?: Record<string, string>}} options
 */
export function createProcessTransport({ command, args = [], env } = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('createProcessTransport requires a non-empty command')
  }

  const child = spawn(command, args, {
    env: env === undefined ? process.env : { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  })
  const line = createLineTransport({ stdin: child.stdout, stdout: child.stdin })
  const errorListeners = new Set()
  let closed = false

  function emitError(error) {
    for (const callback of [...errorListeners]) callback(error)
  }

  line.onError((error) => {
    if (!closed) emitError(error)
  })
  child.on('error', (error) => {
    if (!closed) emitError(error)
  })
  child.on('exit', (code, signal) => {
    if (!closed) emitError(new McpError(`MCP process exited (code ${code}, signal ${signal})`))
  })

  return {
    send(message) {
      line.send(message)
    },

    onMessage(callback) {
      return line.onMessage(callback)
    },

    onError(callback) {
      errorListeners.add(callback)
      return () => errorListeners.delete(callback)
    },

    close() {
      if (closed) return
      closed = true
      line.close()
      errorListeners.clear()
      try {
        child.stdin?.end()
      } catch {
        // The child may already have exited; nothing left to flush.
      }
      child.kill()
    },
  }
}

/**
 * Minimal MCP client: JSON-RPC 2.0 request correlation, per-request timeout,
 * initialize handshake, and fail-fast shutdown.
 * @param {{transport: {send: Function, onMessage: Function, onError?: Function, close: Function}, timeoutMs?: number}} options
 */
export function createMcpClient({ transport, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (
    transport === undefined ||
    typeof transport.send !== 'function' ||
    typeof transport.onMessage !== 'function' ||
    typeof transport.close !== 'function'
  ) {
    throw new TypeError('createMcpClient requires a transport with send/onMessage/close')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number')
  }

  const pending = new Map()
  let nextId = 1
  let closed = false
  let started = false
  let fatalError = null
  let startPromise = null

  function failAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  transport.onMessage((message) => {
    if (message === null || typeof message !== 'object') return
    if (message.id === undefined || message.id === null) return
    const entry = pending.get(message.id)
    if (entry === undefined) return // unknown or late response
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined && message.error !== null) {
      entry.reject(
        new McpRpcError(message.error.message ?? 'MCP request failed', {
          code: message.error.code,
          data: message.error.data,
        }),
      )
    } else if ('result' in message) {
      entry.resolve(message.result)
    } else {
      entry.reject(new McpError('malformed JSON-RPC response'))
    }
  })

  transport.onError?.((error) => {
    if (closed || fatalError !== null) return
    fatalError =
      error instanceof McpError
        ? error
        : new McpError(`MCP transport failed: ${error instanceof Error ? error.message : String(error)}`)
    failAll(fatalError)
  })

  function request(method, params) {
    if (closed) return Promise.reject(new McpError('MCP client is closed'))
    if (fatalError !== null) return Promise.reject(fatalError)

    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return
        reject(new TimeoutError(`MCP request timed out after ${timeoutMs}ms (${method})`, { timeoutMs, method }))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        transport.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(
          error instanceof McpError
            ? error
            : new McpError(`MCP send failed: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    })
  }

  return {
    start() {
      if (closed) return Promise.reject(new McpError('MCP client is closed'))
      if (fatalError !== null) return Promise.reject(fatalError)
      if (startPromise !== null) return startPromise
      startPromise = (async () => {
        const result = await request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { ...CLIENT_INFO },
        })
        if (closed) throw new McpError('MCP client is closed')
        transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        started = true
        return { serverInfo: result?.serverInfo }
      })()
      return startPromise
    },

    call(name, args = {}) {
      if (closed) return Promise.reject(new McpError('MCP client is closed'))
      if (fatalError !== null) return Promise.reject(fatalError)
      if (!started) return Promise.reject(new McpError('MCP client is not started'))
      if (typeof name !== 'string' || name.length === 0) {
        return Promise.reject(new TypeError('tool name must be a non-empty string'))
      }

      return request('tools/call', { name, arguments: args }).then((result) => {
        if (result !== null && typeof result === 'object' && result.isError) {
          const text = textContent(result.content)
          throw new McpToolError(text.length > 0 ? text : `MCP tool ${name} failed`, {
            toolName: name,
            content: result.content,
          })
        }
        return result
      })
    },

    async close() {
      if (closed) return
      closed = true
      failAll(new McpError('MCP client is closed'))
      transport.close()
    },
  }
}
