import { setTimeout as sleep } from 'node:timers/promises'

const OBSERVE_MODES = ['tree', 'screenshot', 'both']
const WAIT_CONDITIONS = [
  'text_exists',
  'active_window',
  'element_exists',
  'element_enabled',
  'focused_element',
]// Internal, non-enumerable hooks so the standalone waitFor() can reuse the
// observer's clock-free last target without widening the public surface.
const LAST_TARGET = Symbol('lastTarget')

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

function round2(value) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100
  return Object.is(rounded, -0) ? 0 : rounded
}

function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000
}

function normalizeFrame(frame) {
  if (frame === null || typeof frame !== 'object') return null
  const x = frame.x
  const y = frame.y
  const w = frame.w ?? frame.width
  const h = frame.h ?? frame.height
  if (![x, y, w, h].every(isFiniteNumber)) return null
  return { x, y, w, h }
}

function normalizeBounds(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const x = raw.x ?? 0
  const y = raw.y ?? 0
  const width = raw.width ?? raw.w
  const height = raw.height ?? raw.h
  if (![x, y, width, height].every(isFiniteNumber)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function mapTree(elements) {
  if (!Array.isArray(elements)) return []
  const tree = []
  for (const [index, row] of elements.entries()) {
    if (row === null || typeof row !== 'object') continue
    const entry = {
      id: row.element_token ?? row.id ?? row.element_index ?? index,
      role: typeof row.role === 'string' ? row.role : '',
      label: typeof row.label === 'string' ? row.label : '',
      frame: normalizeFrame(row.frame),
      actions: Array.isArray(row.actions) ? [...row.actions] : [],
    }
    if (row.value !== undefined) entry.value = row.value
    if (typeof row.enabled === 'boolean') entry.enabled = row.enabled
    if (row.focused === true || row.has_keyboard_focus === true) entry.focused = true
    tree.push(entry)
  }
  return tree
}

function buildSpace(bounds, screenshot, maxImageDimension) {
  let width
  let height
  if (
    screenshot !== undefined &&
    isFiniteNumber(screenshot.width) &&
    isFiniteNumber(screenshot.height) &&
    screenshot.width > 0 &&
    screenshot.height > 0
  ) {
    width = screenshot.width
    height = screenshot.height
  } else {
    const factor = Math.min(1, maxImageDimension / Math.max(bounds.width, bounds.height))
    width = Math.round(bounds.width * factor)
    height = Math.round(bounds.height * factor)
  }
  return {
    width,
    height,
    scaleX: round4(width / bounds.width),
    scaleY: round4(height / bounds.height),
  }
}

function requireStructured(result, tool) {
  const structured = result?.structured
  if (structured === null || typeof structured !== 'object') {
    throw new Error(`${tool} returned no structured state`)
  }
  return structured
}

function extractWindows(result) {
  const structured = result?.structured
  if (Array.isArray(structured)) return structured
  if (Array.isArray(structured?.windows)) return structured.windows
  if (Array.isArray(structured?._legacy_windows)) return structured._legacy_windows
  return []
}

function normalizeWindow(window) {
  if (window === null || typeof window !== 'object') return null
  const pid = window.pid
  const windowId = window.window_id ?? window.windowId
  if (!isPositiveInteger(pid) || !isPositiveInteger(windowId)) return null
  return {
    pid,
    windowId,
    title: typeof window.title === 'string' ? window.title : '',
    bounds: normalizeBounds(window.bounds ?? window),
    onScreen: window.is_on_screen !== false && window.minimized !== true,
    foreground: window.is_foreground === true || window.active === true || window.is_active === true,
    zIndex: isFiniteNumber(window.z_index) ? window.z_index : null,
  }
}

/**
 * The driver on Windows reports stacking via z_index instead of an `active`
 * flag, and its docs forbid inferring frontmost order from array position, so
 * the fallback is the highest on-screen z_index. Off-screen or minimized
 * windows are never candidates, even when they claim foreground.
 */
function chooseActiveWindow(windows) {
  const onScreen = windows
    .map(normalizeWindow)
    .filter((window) => window !== null && window.onScreen)
  if (onScreen.length === 0) return null

  const foreground = onScreen.find((window) => window.foreground)
  if (foreground !== undefined) return foreground

  const stacked = onScreen.filter((window) => window.zIndex !== null)
  if (stacked.length === 0) {
    throw new Error('无法确定活动窗口：请显式传 pid/windowId（或先 bring_to_front）')
  }
  return stacked.reduce((best, window) => (window.zIndex > best.zIndex ? window : best))
}

async function resolveObserveTarget(target, backend) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError(
      'Invalid observe target: expected {kind:"active"}, {kind:"window",pid,windowId} or {kind:"screen"}',
    )
  }

  switch (target.kind) {
    case 'active': {
      if (typeof backend.listWindows !== 'function') {
        throw new TypeError('observe target "active" requires a backend with listWindows()')
      }
      const chosen = chooseActiveWindow(extractWindows(await backend.listWindows()))
      if (chosen === null) {
        throw new Error('No active window found: list_windows returned no on-screen windows')
      }
      return { kind: 'active', ...chosen }
    }
    case 'window': {
      if (!isPositiveInteger(target.pid)) {
        throw new TypeError('observe target window requires a positive integer pid')
      }
      if (!isPositiveInteger(target.windowId)) {
        throw new TypeError('observe target window requires a positive integer windowId')
      }
      return {
        kind: 'window',
        pid: target.pid,
        windowId: target.windowId,
        title: '',
        bounds: null,
      }
    }
    case 'screen': {
      if (target.index !== undefined) {
        if (!isNonNegativeInteger(target.index)) {
          throw new TypeError('observe target screen index must be a non-negative integer')
        }
        if (target.index !== 0) {
          throw new Error('observe target screen only supports the primary display (index 0)')
        }
      }
      return { kind: 'screen' }
    }
    default:
      throw new TypeError(`Invalid observe target kind: ${String(target.kind)}`)
  }
}

function validateObserveOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('observe options must be an object')
  }
  const mode = options.mode ?? 'both'
  if (!OBSERVE_MODES.includes(mode)) {
    throw new TypeError(`Invalid observe mode "${String(mode)}": expected tree, screenshot or both`)
  }
  if (
    options.query !== undefined &&
    (typeof options.query !== 'string' || options.query.length === 0)
  ) {
    throw new TypeError('observe query must be a non-empty string')
  }
  if (options.includeScreenshot !== undefined && typeof options.includeScreenshot !== 'boolean') {
    throw new TypeError('observe includeScreenshot must be a boolean')
  }
  if (
    options.waitFor !== undefined &&
    (options.waitFor === null || typeof options.waitFor !== 'object' || Array.isArray(options.waitFor))
  ) {
    throw new TypeError('observe waitFor must be an options object')
  }
}

function validateWaitOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('waitFor options must be an object')
  }
  const condition = options.condition
  if (!WAIT_CONDITIONS.includes(condition)) {
    throw new TypeError(
      `Unknown waitFor condition: ${String(condition)} (expected ${WAIT_CONDITIONS.join(', ')})`,
    )
  }

  const timeoutMs = options.timeoutMs ?? 10000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new TypeError('waitFor timeoutMs must be an integer between 1 and 120000')
  }
  const intervalMs = options.intervalMs ?? 250
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 5000) {
    throw new TypeError('waitFor intervalMs must be an integer between 1 and 5000')
  }

  const { text, windowName } = options
  if (text !== undefined && (typeof text !== 'string' || text.length === 0)) {
    throw new TypeError('waitFor text must be a non-empty string')
  }
  if (
    windowName !== undefined &&
    (typeof windowName !== 'string' || windowName.length === 0)
  ) {
    throw new TypeError('waitFor windowName must be a non-empty string')
  }

  const needsText =
    condition === 'text_exists' || condition === 'element_exists' || condition === 'element_enabled'
  if (needsText && text === undefined) {
    throw new TypeError(`waitFor condition "${condition}" requires text`)
  }
  if (condition === 'active_window' && text === undefined && windowName === undefined) {
    throw new TypeError('waitFor condition "active_window" requires windowName or text')
  }

  return { condition, text, windowName, timeoutMs, intervalMs }
}

function includesText(value, needle) {
  return typeof value === 'string' && typeof needle === 'string'
    ? value.toLowerCase().includes(needle.toLowerCase())
    : false
}

function elementHasText(element, text) {
  return includesText(element.label, text) || includesText(element.value, text)
}

function matchesWait(observation, options) {
  const tree = Array.isArray(observation?.tree) ? observation.tree : []
  const title = typeof observation?.title === 'string' ? observation.title : ''
  const { condition, text, windowName } = options

  switch (condition) {
    case 'text_exists':
      return includesText(title, text) || tree.some((element) => elementHasText(element, text))
    case 'active_window':
      return includesText(title, windowName ?? text)
    case 'element_exists':
      return tree.some((element) => elementHasText(element, text))
    case 'element_enabled':
      return tree.some((element) => elementHasText(element, text) && element.enabled === true)
    case 'focused_element':
      // cua-driver does not report a focused element on Windows yet; this only
      // matches when a row carries explicit focus metadata.
      return tree.some(
        (element) =>
          element.focused === true && (text === undefined || elementHasText(element, text)),
      )
    default:
      return false
  }
}

/**
 * Poll one cheap observation per interval until the condition matches or the
 * timeout elapses. Returns the last polled observation for diagnostics.
 */
async function pollUntilMatch(observe, waitOptions) {
  const started = Date.now()

  for (;;) {
    const observation = await observe()
    if (matchesWait(observation, waitOptions)) {
      return { matched: true, elapsedMs: Date.now() - started, observation }
    }
    const elapsed = Date.now() - started
    if (elapsed >= waitOptions.timeoutMs) {
      return { matched: false, elapsedMs: elapsed, observation }
    }
    await sleep(Math.min(waitOptions.intervalMs, waitOptions.timeoutMs - elapsed))
  }
}

/**
 * Observe a desktop target and cache the result under a revision.
 *
 * @param {object} options
 * @param {object} options.backend cua backend adapter (getWindowState/listWindows/getDesktopState)
 * @param {number} [options.maxElements]
 * @param {number} [options.maxImageDimension]
 * @param {number} [options.ttlMs]
 * @param {number} [options.budgetMs]
 * @param {() => number} [options.now]
 */
export function createObserver({
  backend,
  maxElements = 250,
  maxImageDimension = 1456,
  ttlMs = 60000,
  budgetMs = 1200,
  now = Date.now,
} = {}) {
  if (
    backend === null ||
    typeof backend !== 'object' ||
    typeof backend.getWindowState !== 'function'
  ) {
    throw new TypeError('createObserver requires a backend with getWindowState()')
  }
  if (!isPositiveInteger(maxElements)) {
    throw new TypeError('createObserver maxElements must be a positive integer')
  }
  if (!isPositiveInteger(maxImageDimension)) {
    throw new TypeError('createObserver maxImageDimension must be a positive integer')
  }
  if (!isPositiveInteger(ttlMs)) {
    throw new TypeError('createObserver ttlMs must be a positive integer')
  }
  if (!isNonNegativeInteger(budgetMs)) {
    throw new TypeError('createObserver budgetMs must be a non-negative integer')
  }
  if (typeof now !== 'function') {
    throw new TypeError('createObserver now must be a function')
  }

  const cache = new Map()
  let nextRevision = 0
  let lastTarget

  const api = {
    observe,
    get,
  }
  Object.defineProperty(api, LAST_TARGET, {
    value: undefined,
    writable: true,
    enumerable: false,
  })

  function pruneExpired() {
    const current = now()
    for (const [revision, entry] of cache) {
      if (current - entry.at > ttlMs) cache.delete(revision)
    }
  }

  function get(revision) {
    const entry = cache.get(revision)
    if (entry === undefined) {
      throw new Error(`Unknown observation revision: ${String(revision)}`)
    }
    if (now() - entry.at > ttlMs) {
      cache.delete(revision)
      throw new Error(`Observation revision ${String(revision)} expired after ${ttlMs}ms`)
    }
    return entry.observation
  }

  async function observe(target, options = {}) {
    const resolvedTarget = target === undefined ? lastTarget : target
    if (resolvedTarget === undefined) {
      throw new TypeError('observe target is required: {kind:"active"} or {kind:"window",pid,windowId}')
    }
    validateObserveOptions(options)
    const waitOptions =
      options.waitFor === undefined ? undefined : validateWaitOptions(options.waitFor)

    const started = Date.now()
    const observation = await observeOnce(resolvedTarget, options)
    lastTarget = resolvedTarget
    api[LAST_TARGET] = resolvedTarget

    if (waitOptions === undefined) return observation
    if (matchesWait(observation, waitOptions)) {
      return { ...observation, waitFor: { matched: true, elapsedMs: Date.now() - started } }
    }

    // Poll tree-only with the caller's query; the final observation below is
    // re-created with the caller's mode/screenshot options.
    const pollTarget =
      options.waitFor.target ??
      (waitOptions.condition === 'active_window' ? { kind: 'active' } : resolvedTarget)
    const pollOptions =
      options.query === undefined ? { mode: 'tree' } : { mode: 'tree', query: options.query }
    const waited = await pollUntilMatch(() => api.observe(pollTarget, pollOptions), waitOptions)
    const finalObservation = await observeOnce(resolvedTarget, options)

    return {
      ...finalObservation,
      waitFor: { matched: waited.matched, elapsedMs: Date.now() - started },
    }
  }

  async function observeOnce(target, options) {
    const started = now()
    const mode = options.mode ?? 'both'
    const includeScreenshot = options.includeScreenshot ?? mode !== 'tree'
    const resolved = await resolveObserveTarget(target, backend)

    let result
    let structured
    let bounds
    let title
    let pid
    let windowId
    let focusedWindow

    if (target.kind === 'screen') {
      if (typeof backend.getDesktopState !== 'function') {
        throw new TypeError('observe target "screen" requires a backend with getDesktopState()')
      }
      result = await backend.getDesktopState({ maxImageDimension })
      structured = requireStructured(result, 'get_desktop_state')
      bounds = normalizeBounds({
        x: 0,
        y: 0,
        width: structured.screen_width,
        height: structured.screen_height,
      })
      if (bounds === null) {
        throw new Error('get_desktop_state returned no usable screen bounds')
      }
      pid = null
      windowId = null
      title = 'Desktop'
    } else {
      const args = {
        pid: resolved.pid,
        windowId: resolved.windowId,
        includeScreenshot,
        treeFormat: 'elements',
        maxElements,
        maxImageDimension,
      }
      if (options.query !== undefined) args.query = options.query
      result = await backend.getWindowState(args)
      structured = requireStructured(result, 'get_window_state')
      bounds = normalizeBounds(structured.window_bounds) ?? resolved.bounds
      if (bounds === null) {
        throw new Error('get_window_state returned no usable window bounds')
      }
      title =
        typeof structured.window_title === 'string'
          ? structured.window_title
          : (resolved.title ?? '')
      pid = isPositiveInteger(structured.pid) ? structured.pid : resolved.pid
      windowId = isPositiveInteger(structured.window_id)
        ? structured.window_id
        : resolved.windowId
      if (target.kind === 'active') {
        focusedWindow = {
          pid: resolved.pid,
          windowId: resolved.windowId,
          title,
        }
      }
    }

    const screenshotPng =
      includeScreenshot && Buffer.isBuffer(result.image) ? result.image : undefined
    const screenshot =
      screenshotPng === undefined
        ? undefined
        : { width: structured.screenshot_width, height: structured.screenshot_height }
    const space = buildSpace(bounds, screenshot, maxImageDimension)
    const tree = mapTree(structured.elements)

    const at = now()
    // The driver's `truncated` flag is authoritative; `elements_complete` can be
    // false even when the walk returned every element, so it is not truncation.
    let truncated = structured.truncated === true
    let truncationReason =
      truncated && typeof structured.truncation_reason === 'string'
        ? structured.truncation_reason
        : undefined
    // shortcut: budgetMs flags an over-budget call after it returns; it cannot
    // cancel the in-flight driver walk (the backend adapter exposes no timeout arg).
    if (at - started > budgetMs) {
      truncated = true
      truncationReason = 'budget'
    }
    if (truncated && truncationReason === undefined) truncationReason = 'driver'

    nextRevision += 1
    const observation = {
      revision: nextRevision,
      pid,
      windowId,
      title,
      bounds,
      ...(focusedWindow === undefined ? {} : { focusedWindow }),
      space,
      ...(screenshotPng === undefined ? {} : { screenshotPng }),
      tree,
      truncated,
      ...(truncationReason === undefined ? {} : { truncationReason }),
      at,
    }

    pruneExpired()
    cache.set(observation.revision, { observation, at })
    return observation
  }

  return api
}

/**
 * Map an element's physical screen frame into the observation's screenshot space.
 */
export function toLocalPoint(frame, observation) {
  if (frame === null || typeof frame !== 'object') {
    throw new TypeError('toLocalPoint requires a frame with numeric x and y')
  }
  if (!isFiniteNumber(frame.x) || !isFiniteNumber(frame.y)) {
    throw new TypeError('toLocalPoint requires a frame with numeric x and y')
  }
  if (
    observation === null ||
    typeof observation !== 'object' ||
    observation.bounds === null ||
    typeof observation.bounds !== 'object' ||
    observation.space === null ||
    typeof observation.space !== 'object'
  ) {
    throw new TypeError('toLocalPoint requires an observation with bounds and space')
  }
  const { bounds, space } = observation
  if (
    !isFiniteNumber(bounds.x) ||
    !isFiniteNumber(bounds.y) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    throw new TypeError('toLocalPoint requires an observation with usable bounds')
  }
  if (
    !isFiniteNumber(space.width) ||
    !isFiniteNumber(space.height) ||
    space.width <= 0 ||
    space.height <= 0
  ) {
    throw new TypeError('toLocalPoint requires an observation with positive space dimensions')
  }
  return {
    x: round2(((frame.x - bounds.x) * space.width) / bounds.width),
    y: round2(((frame.y - bounds.y) * space.height) / bounds.height),
  }
}

/**
 * Resolve an action target against one observation.
 *
 * @returns {{element: object} | {point: {x: number, y: number}}}
 */
export function resolveTarget(observation, target) {
  if (observation === null || typeof observation !== 'object' || !Array.isArray(observation.tree)) {
    throw new TypeError('resolveTarget requires an observation with a tree')
  }
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('Invalid action target: expected {element: id} or {x, y}')
  }

  if ('element' in target) {
    const id = target.element
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new TypeError('Invalid action target: element id must be a string or number')
    }
    const element = observation.tree.find(
      (entry) =>
        entry.id === id ||
        (typeof id === 'number' &&
          typeof entry.id === 'string' &&
          entry.id.endsWith(`:${id}`)),
    )
    if (element === undefined) {
      throw new Error(`Unknown element ${String(id)} in observation revision ${observation.revision}`)
    }
    return { element }
  }

  if ('x' in target || 'y' in target) {
    if (!isFiniteNumber(target.x) || !isFiniteNumber(target.y)) {
      throw new TypeError('Invalid action target: x and y must be finite numbers')
    }
    return { point: { x: target.x, y: target.y } }
  }

  throw new TypeError('Invalid action target: expected {element: id} or {x, y}')
}

/**
 * Poll observations until a condition matches or timeoutMs elapses.
 * Re-observes the last observed target, except active_window which polls the
 * live foreground target. An explicit `target` overrides both.
 *
 * @param {{observe: Function, get: Function}} observer
 * @param {{condition: string, text?: string, windowName?: string, timeoutMs?: number, intervalMs?: number, target?: object}} options
 */
export async function waitFor(observer, options = {}) {
  const waitOptions = validateWaitOptions(options)
  if (observer === null || typeof observer !== 'object' || typeof observer.observe !== 'function') {
    throw new TypeError('waitFor requires an observer with observe()')
  }
  // "active_window" is about the foreground window, so it must poll the live
  // foreground target rather than a previously observed background window.
  const target =
    options.target ??
    (waitOptions.condition === 'active_window'
      ? { kind: 'active' }
      : (observer[LAST_TARGET] ?? { kind: 'active' }))

  return pollUntilMatch(() => observer.observe(target, { mode: 'tree' }), waitOptions)
}
