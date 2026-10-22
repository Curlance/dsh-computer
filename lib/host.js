/**
 * host.js —— DSH host 边界：把配置与宿主服务接到统一 `computer` 工具。
 *
 * 不 import 宿主包：`defineTool` 由入口注入，附件服务经 `ctx.get('attachments')`
 * 读取。后端在首次执行工具时才启动，插件加载阶段不碰驱动；启动失败返回可操作
 * 错误并允许下一次调用重试。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

import { createAudit } from './audit.js'
import { createCuaBackend } from './backend/cua.js'
import { McpError, createMcpClient, createProcessTransport } from './backend/mcp.js'
import { normalizeConfig } from './config.js'
import { createControlGate, createWindowsIdleProvider } from './control.js'
import { ensureCursor, glideTo } from './cursor.js'
import { createObserver } from './observe.js'
import { createPolicy } from './policy.js'
import { IMAGE_FIELD, persistImage, renderWithImage } from './render.js'
import { createSessionManager } from './session.js'
import { buildComputerTool } from './tool.js'

const DRIVER_ARGS = ['mcp']
const DEFAULT_BACKEND_TIMEOUT_MS = 15000
const IDENTITY_TOOL = (tool) => tool

/**
 * Locate the cua-driver executable.
 * Precedence: CUA_DRIVER_BIN, PATH, the official installer locations, then the
 * bare command so spawn reports its own ENOENT.
 * @param {{platform?: NodeJS.Platform, env?: Record<string, string>, home?: string,
 *   exists?: (path: string) => boolean}} [options]
 * @returns {string}
 */
export function resolveDriverCommand({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
} = {}) {
  const explicit = env.CUA_DRIVER_BIN
  if (typeof explicit === 'string' && explicit.length > 0) return explicit

  const exe = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const join = platform === 'win32' ? win32.join : posix.join
  const separator = platform === 'win32' ? ';' : ':'
  const path = typeof env.PATH === 'string' ? env.PATH : ''
  for (const dir of path.split(separator)) {
    if (dir === '') continue
    const candidate = join(dir, exe)
    if (exists(candidate)) return candidate
  }

  const installed = [
    join(home, '.cua-driver', 'packages', 'current', exe),
    join(home, 'AppData', 'Local', 'cua-driver', exe),
    join(home, 'AppData', 'Local', 'Programs', 'Cua', 'cua-driver', 'bin', exe),
  ]
  for (const candidate of installed) {
    if (exists(candidate)) return candidate
  }
  return 'cua-driver'
}

/**
 * Default backend factory: one persistent `cua-driver mcp` stdio session.
 * @param {{config?: object, command?: string}} [options]
 * @returns {Promise<{backend: object, close: () => Promise<void>}>}
 */
export async function createDefaultBackend({ config, command } = {}) {
  const executable = command ?? resolveDriverCommand()
  const timeoutMs = config?.backend?.timeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS

  const makeClient = () => {
    const transport = createProcessTransport({ command: executable, args: DRIVER_ARGS })
    return createMcpClient({ transport, timeoutMs })
  }

  const client = makeClient()
  try {
    await client.start()
  } catch (error) {
    await client.close().catch(() => {})
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cua-driver 连接失败 (${executable})：${detail}`)
  }
  // createClient lets the adapter reconnect once if the driver process dies.
  // Close through the adapter so a reconnected client is also shut down.
  const backend = createCuaBackend({ client, createClient: makeClient })
  return {
    backend,
    close: () => backend.close(),
  }
}

function isTransportDeath(error) {
  return error instanceof McpError || error?.cause instanceof McpError
}

/**
 * A backend-shaped object whose methods start the real backend on first use.
 * The observer is built at registration time, so it needs callable methods
 * without starting the driver then.
 */
function createLazyBackend(ensureBackend, resetBackend) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string') return undefined
        return (...args) =>
          ensureBackend()
            .then((backend) => backend[property](...args))
            .catch(async (error) => {
              // A dead driver must not poison the tool until DSH restarts:
              // drop the cached backend so the next call starts a fresh one.
              if (isTransportDeath(error)) await resetBackend()
              throw error
            })
      },
    },
  )
}

function resolveAttachments(ctx) {
  const viaGet = typeof ctx?.get === 'function' ? ctx.get('attachments') : undefined
  return viaGet ?? ctx?.attachments
}

/**
 * Policy asks for approval without an agent; bind the executing call's agent so
 * the host can route the prompt. Calls on one desktop are serialized by the
 * session lease, so one mutable slot matches that ownership model.
 */
function createApprovalAdapter(ctx, currentAgent) {
  if (typeof ctx?.approval?.request !== 'function') {
    // Fail closed: policy treats anything but an allow outcome as a denial.
    return { request: async () => 'unavailable' }
  }
  return {
    request: ({ agent, toolName, reason } = {}) =>
      ctx.approval.request({ agent: agent ?? currentAgent(), toolName, reason }),
  }
}

const RESULT_KEYS = ['ok', 'result', 'image', 'code', 'denied', 'sessionId', 'agentId']

/** Tool output render: text plus an image block when a screenshot was attached. */
function renderResult(_args, value) {
  const result = value?.result
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null)
  if (value?.image === undefined) return [{ type: 'text', text }]
  return renderWithImage(_args, { ...value, result: text })
}

/** Keep the host return shape to the declared output keys. */
function projectResult(value) {
  const projected = {}
  if (value === null || typeof value !== 'object') return projected
  for (const key of RESULT_KEYS) {
    if (value[key] !== undefined) projected[key] = value[key]
  }
  return projected
}

export const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      result: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] },
      ...IMAGE_FIELD,
      code: { type: 'string' },
      denied: { type: 'boolean' },
      sessionId: { type: 'string' },
      agentId: { type: 'string' },
    },
  },
  render: renderResult,
}

function backendStartError(error) {
  const detail = error instanceof Error ? error.message : String(error)
  const hint = /ENOENT|not found|no such file|无法找到/i.test(detail)
    ? '；请安装 Cua Driver（cua-driver mcp）或设置 CUA_DRIVER_BIN 指向 cua-driver.exe'
    : ''
  return new Error(`无法启动 cua-driver 后端：${detail}${hint}`)
}

/**
 * Wire the unified `computer` tool into one host context.
 * @param {object} ctx host context (`tools.register`, `approval.request`,
 *   `get('attachments')`, optional `logger`)
 * @param {object} config plugin config; normalized here so partial input is safe
 * @param {{defineTool?: Function, createBackend?: Function,
 *   idleProvider?: Function}} [options] host-injected adapters and test seams
 * @returns {{dispose: () => Promise<void>}}
 */
export function register(ctx, config, options = {}) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.tools?.register !== 'function') {
    throw new TypeError('register requires a ctx with tools.register()')
  }
  const {
    defineTool = IDENTITY_TOOL,
    createBackend = createDefaultBackend,
    idleProvider,
  } = options ?? {}
  if (typeof defineTool !== 'function') {
    throw new TypeError('register defineTool must be a function')
  }
  if (typeof createBackend !== 'function') {
    throw new TypeError('register createBackend must be a function')
  }

  const cfg = normalizeConfig(config ?? {})

  let backend = null
  let closeBackend = null
  let starting = null
  let disposed = false
  let currentAgent

  function ensureBackend() {
    if (disposed) return Promise.reject(new Error('computer tool is disposed'))
    if (backend !== null) return Promise.resolve(backend)
    if (starting !== null) return starting

    starting = (async () => {
      try {
        const created = await createBackend({ config: cfg })
        const value = created?.backend ?? created
        if (value === null || typeof value !== 'object') {
          throw new TypeError('backend factory returned no backend')
        }
        backend = value
        closeBackend = typeof created?.close === 'function' ? created.close : null
        // Cursor is opt-out: disabling it skips startSession and every cursor
        // call, leaving the driver headless. ensureCursor never rejects, so a
        // failed cursor is a cosmetic downgrade.
        if (cfg.cursor.enabled !== false) await ensureCursor(value, cfg.cursor)
        return value
      } catch (error) {
        // A failed start must not poison the plugin; the next call retries.
        starting = null
        throw backendStartError(error)
      }
    })()
    return starting
  }

  async function resetBackend() {
    const closer = closeBackend
    backend = null
    closeBackend = null
    starting = null
    if (closer !== null) await closer().catch(() => {})
  }

  const lazyBackend = createLazyBackend(ensureBackend, resetBackend)
  // Cursor disabled means no glide callback at all, not a no-op call per action.
  const glide =
    cfg.cursor.enabled === false
      ? undefined
      : (point, observation) =>
          ensureBackend().then((value) => glideTo(value, point, observation, { ...cfg.cursor }))
  const deps = {
    backend: lazyBackend,
    glide,
    observer: createObserver({
      backend: lazyBackend,
      maxElements: cfg.observation.maxElements,
      maxImageDimension: cfg.observation.maxImageDimension,
      ttlMs: cfg.observation.ttlMs,
    }),
    policy: createPolicy({ config: cfg, approval: createApprovalAdapter(ctx, () => currentAgent) }),
    sessions: createSessionManager(),
    control: createControlGate({ idleProvider: idleProvider ?? createWindowsIdleProvider() }),
    audit: createAudit({ path: cfg.audit.path, includeScreenshots: cfg.audit.includeScreenshots }),
    persistImage(observation, persistOptions) {
      const attachments = resolveAttachments(ctx)
      // Without an attachments service the observation still renders; it just
      // carries no image.
      if (attachments === null || attachments === undefined) return Promise.resolve(undefined)
      return persistImage(attachments, observation, persistOptions)
    },
    config: cfg,
  }

  const base = buildComputerTool(deps)

  // One desktop means one execution at a time. The queue also keeps the
  // approval agent slot bound to the call actually running.
  let executions = Promise.resolve()
  function serialize(task) {
    const run = executions.then(task, task)
    executions = run.then(
      () => {},
      () => {},
    )
    return run
  }

  ctx.tools.register(
    defineTool({
      ...base,
      output: OUTPUT,
      execute(args, exec) {
        return serialize(async () => {
          try {
            await ensureBackend()
            currentAgent = exec?.agent
            return projectResult(await base.execute(args, exec))
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            return { ok: false, result: `✗ ${detail}` }
          } finally {
            currentAgent = undefined
          }
        })
      },
    }),
  )

  async function dispose() {
    if (disposed) return
    disposed = true
    if (starting !== null) {
      try {
        await starting
      } catch {
        return
      }
    }
    const close = closeBackend
    backend = null
    closeBackend = null
    starting = null
    if (close !== null) {
      try {
        await close()
      } catch {
        // Shutdown is best-effort: a dead driver already closed its pipe.
      }
    }
  }

  return { dispose }
}

/**
 * The documented entry point from the task brief; `register` is the direct
 * signature used by `index.js`.
 */
export function createPlugin({ defineTool, ctx, config, createBackend, idleProvider } = {}) {
  return register(ctx, config, { defineTool, createBackend, idleProvider })
}
