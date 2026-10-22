import { McpError, McpRpcError, McpToolError, TimeoutError } from './mcp.js'

// Single lifecycle session label shared by every tool call that accepts one.
const DEFAULT_SESSION = 'dsh-computer'

/**
 * A cua-driver tool call failed. `cause` keeps the original MCP error.
 */
export class ToolCallError extends Error {
  constructor(toolName, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`cua-driver ${toolName} failed: ${detail}`, { cause })
    this.name = 'ToolCallError'
    this.toolName = toolName
  }
}

/**
 * Normalize an MCP tools/call result: concatenate text blocks, decode the
 * image/png attachment, and preserve structuredContent.
 * @param {{content?: Array<object>, structuredContent?: any}} raw
 */
export function normalizeToolResult(raw = {}) {
  const content = Array.isArray(raw?.content) ? raw.content : []
  const texts = []
  let image
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue
    if (item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text)
    } else if (
      image === undefined &&
      item.type === 'image' &&
      item.mimeType === 'image/png' &&
      typeof item.data === 'string'
    ) {
      image = Buffer.from(item.data, 'base64')
    }
  }
  const result = { text: texts.join('\n'), structured: raw?.structuredContent }
  if (image !== undefined) result.image = image
  return result
}

/**
 * Only transport-level failures are retryable. Tool/RPC errors are business
 * outcomes, and a timeout has an ambiguous outcome — retrying it could
 * duplicate a click or keypress.
 */
function isRetryableTransportError(error) {
  return (
    error instanceof McpError &&
    !(error instanceof McpToolError) &&
    !(error instanceof McpRpcError) &&
    !(error instanceof TimeoutError)
  )
}

function windowStateArgs(options = {}) {
  const {
    pid,
    windowId,
    includeScreenshot,
    treeFormat = 'elements',
    maxElements,
    query,
    maxImageDimension,
    screenshotOutFile,
  } = options
  const args = { pid, window_id: windowId, tree_format: treeFormat }
  if (includeScreenshot !== undefined) args.include_screenshot = includeScreenshot
  if (maxElements !== undefined) args.max_elements = maxElements
  if (query !== undefined) args.query = query
  if (maxImageDimension !== undefined) args.max_image_dimension = maxImageDimension
  if (screenshotOutFile !== undefined) args.screenshot_out_file = screenshotOutFile
  return args
}

function desktopStateArgs(options = {}) {
  const args = { ...options }
  if (args.maxImageDimension !== undefined) {
    args.max_image_dimension = args.maxImageDimension
    delete args.maxImageDimension
  }
  if (args.screenshotOutFile !== undefined) {
    args.screenshot_out_file = args.screenshotOutFile
    delete args.screenshotOutFile
  }
  return args
}

/**
 * Adapter over a cua-driver MCP client. Tool names and argument shapes follow
 * cua-driver 0.36; every call carries one lifecycle session label.
 * @param {{client: {call: Function, start?: Function, close?: Function}, createClient?: Function, session?: string}} options
 */
export function createCuaBackend({ client, createClient, session = DEFAULT_SESSION } = {}) {
  if (client === undefined || client === null || typeof client.call !== 'function') {
    throw new TypeError('createCuaBackend requires a client with call()')
  }
  if (createClient !== undefined && typeof createClient !== 'function') {
    throw new TypeError('createCuaBackend createClient must be a function')
  }
  if (typeof session !== 'string' || session.length === 0) {
    throw new TypeError('createCuaBackend session must be a non-empty string')
  }

  let currentClient = client
  let currentSession = session

  function withSession(args = {}) {
    // The adapter owns the label; a session supplied by a caller cannot fork it.
    return { ...args, session: currentSession }
  }

  async function callTool(toolName, args) {
    try {
      return normalizeToolResult(await currentClient.call(toolName, args))
    } catch (error) {
      if (createClient === undefined || !isRetryableTransportError(error)) {
        throw new ToolCallError(toolName, error)
      }
      try {
        // The old client may already be dead; closing it is best-effort.
        await currentClient.close()
      } catch {
        // ignore
      }
      try {
        currentClient = createClient()
        await currentClient.start()
        return normalizeToolResult(await currentClient.call(toolName, args))
      } catch (retryError) {
        throw new ToolCallError(toolName, retryError)
      }
    }
  }

  return {
    listWindows(options) {
      return callTool('list_windows', withSession(options))
    },

    listApps() {
      return callTool('list_apps', withSession())
    },

    getWindowState(options) {
      return callTool('get_window_state', withSession(windowStateArgs(options)))
    },

    getDesktopState(options) {
      return callTool('get_desktop_state', withSession(desktopStateArgs(options)))
    },

    click(args) {
      return callTool('click', withSession(args))
    },

    typeText(args) {
      return callTool('type_text', withSession(args))
    },

    pressKey(args) {
      return callTool('press_key', withSession(args))
    },

    hotkey(args) {
      return callTool('hotkey', withSession(args))
    },

    scroll(args) {
      return callTool('scroll', withSession(args))
    },

    drag(args) {
      return callTool('drag', withSession(args))
    },

    moveCursor(args) {
      return callTool('move_cursor', withSession(args))
    },

    getCursorPosition() {
      return callTool('get_cursor_position', withSession())
    },

    launchApp(args) {
      return callTool('launch_app', withSession(args))
    },

    bringToFront({ pid, windowId } = {}) {
      return callTool('bring_to_front', withSession({ pid, window_id: windowId }))
    },

    setWindowFrame({ pid, windowId, x, y, width, height } = {}) {
      return callTool(
        'set_window_frame',
        withSession({ pid, window_id: windowId, x, y, width, height }),
      )
    },

    killApp({ pid } = {}) {
      return callTool('kill_app', withSession({ pid }))
    },

    startSession({ label, theme } = {}) {
      if (label !== undefined) {
        if (typeof label !== 'string' || label.length === 0) {
          throw new TypeError('startSession label must be a non-empty string')
        }
      }
      // The driver requires a theme object; callers configure a theme id string.
      const cursorTheme = typeof theme === 'string' ? { theme_id: theme } : theme
      const nextSession = label === undefined ? currentSession : label
      const args = { session: nextSession }
      if (theme !== undefined) args.cursor_theme = cursorTheme
      // Only commit the new label once the driver accepted the session.
      return callTool('start_session', args).then((result) => {
        currentSession = nextSession
        return result
      })
    },

    setAgentCursorEnabled(enabled) {
      return callTool('set_agent_cursor_enabled', withSession({ enabled }))
    },

    setAgentCursorMotion(motion) {
      return callTool('set_agent_cursor_motion', withSession(motion))
    },

    getAgentCursorState() {
      return callTool('get_agent_cursor_state', withSession())
    },

    setAgentCursorTheme(themeId) {
      return callTool('set_agent_cursor_theme', withSession({ theme_id: themeId }))
    },
  }
}
