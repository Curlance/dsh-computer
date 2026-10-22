const DEFAULT_THEME = 'cua.default'
const DEFAULT_GLIDE_MS = 600
const DEFAULT_IDLE_HIDE_MS = 0
const DEFAULT_SEGMENTS = 5
const DEFAULT_ARC_HEIGHT = 40

// A backend is configured once per module lifetime; a failed attempt is not
// cached so the next call can retry.
const ensured = new WeakMap()

const isObject = (value) => value !== null && typeof value === 'object'
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

function clamp(value, max) {
  return Math.min(max, Math.max(0, value))
}

function cursorPoint(result) {
  const structured = isObject(result) && isObject(result.structured) ? result.structured : result
  const x = structured?.x ?? structured?.position?.x
  const y = structured?.y ?? structured?.position?.y
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : null
}

function themeId(theme) {
  if (typeof theme === 'string') return theme
  if (isObject(theme) && typeof theme.theme_id === 'string') return theme.theme_id
  return null
}

async function configureCursor(backend, { theme, glideMs, idleHideMs, label }) {
  let ok = true
  async function attempt(call) {
    try {
      await call()
    } catch {
      ok = false
    }
  }

  const session = { theme }
  if (label !== undefined) session.label = label
  await attempt(() => backend.startSession?.(session))
  await attempt(() => backend.setAgentCursorEnabled?.(true))
  await attempt(() =>
    backend.setAgentCursorMotion?.({
      idle_hide_ms: idleHideMs,
      glide_duration_ms: glideMs,
    }),
  )
  return ok
}

/**
 * Configure the visible agent cursor for a backend. Best-effort: resolves
 * without throwing and only caches a fully successful configuration.
 * @param {object} backend
 * @param {{theme?: string, glideMs?: number, idleHideMs?: number, label?: string}} [options]
 * @returns {Promise<void>}
 */
export function ensureCursor(backend, options = {}) {
  if (!isObject(backend)) return Promise.resolve()
  const cached = ensured.get(backend)
  if (cached !== undefined) return cached

  const {
    theme = DEFAULT_THEME,
    glideMs = DEFAULT_GLIDE_MS,
    idleHideMs = DEFAULT_IDLE_HIDE_MS,
    label,
  } = options ?? {}

  const run = (async () => {
    let ok = false
    try {
      ok = await configureCursor(backend, { theme, glideMs, idleHideMs, label })
    } catch {
      ok = false
    }
    if (!ok) ensured.delete(backend)
  })()
  ensured.set(backend, run)
  return run
}

async function moveBestEffort(backend, args) {
  try {
    await backend.moveCursor?.(args)
  } catch {
    // The glide is cosmetic; a failed frame must not fail the action.
  }
}

/**
 * Glide the agent cursor to a point in screenshot space (5 segments plus the
 * exact landing by default). Best-effort: never rejects.
 * @param {object} backend
 * @param {{x: number, y: number}} point
 * @param {object} observation observation with `space` and window identity
 * @param {{segments?: number, arcHeight?: number}} [options]
 * @returns {Promise<void>}
 */
export async function glideTo(
  backend,
  point,
  observation,
  { segments = DEFAULT_SEGMENTS, arcHeight = DEFAULT_ARC_HEIGHT } = {},
) {
  if (!isObject(backend) || !isObject(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
    return
  }
  const space = observation?.space
  if (
    !isObject(space) ||
    !isFiniteNumber(space.width) ||
    !isFiniteNumber(space.height) ||
    space.width <= 0 ||
    space.height <= 0
  ) {
    return
  }

  const target = {
    x: clamp(point.x, space.width),
    y: clamp(point.y, space.height),
  }
  const window = { kind: 'window', pid: observation.pid, window_id: observation.windowId }

  let start = target
  try {
    const current = cursorPoint(await backend.getCursorPosition?.())
    if (current !== null) start = current
  } catch {
    start = target
  }

  const dx = target.x - start.x
  const dy = target.y - start.y
  const arc = dx === 0 && dy === 0 ? 0 : arcHeight
  const steps = Number.isInteger(segments) && segments >= 0 ? segments : DEFAULT_SEGMENTS

  for (let index = 1; index <= steps; index += 1) {
    const t = index / (steps + 1)
    await moveBestEffort(backend, {
      x: clamp(start.x + dx * t, space.width),
      y: clamp(start.y + dy * t - arc * Math.sin(Math.PI * t), space.height),
      target: window,
    })
  }
  await moveBestEffort(backend, { ...target, target: window })
}

/**
 * Snapshot the agent cursor state for status/render surfaces.
 * @param {object} backend
 * @returns {Promise<{enabled: boolean, position: {x: number, y: number} | null,
 *   theme: string | null} | null>}
 */
export async function cursorSummary(backend) {
  if (!isObject(backend)) return null
  try {
    const result = await backend.getAgentCursorState?.()
    const state = isObject(result?.structured) ? result.structured : null
    if (state === null) return null
    const position =
      isObject(state.position) &&
      isFiniteNumber(state.position.x) &&
      isFiniteNumber(state.position.y)
        ? { x: state.position.x, y: state.position.y }
        : null
    return {
      enabled: state.enabled === true,
      position,
      theme: themeId(state.theme),
    }
  } catch {
    return null
  }
}
