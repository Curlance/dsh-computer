import { resolveTarget, toLocalPoint } from './observe.js'

const OPS = new Set([
  'click',
  'doubleClick',
  'rightClick',
  'move',
  'type',
  'key',
  'scroll',
  'drag',
  'wait',
  'launch',
  'focus',
  'resize',
  'kill',
])

const EFFECTS = new Set(['confirmed', 'unverifiable', 'refused', 'noop'])
const DIRECTIONS = new Set(['up', 'down', 'left', 'right'])
const DELIVERY_MODES = new Set(['auto', 'background', 'foreground'])
const READBACK_OPS = new Set(['click', 'doubleClick', 'rightClick', 'type'])
const REFUSED_ROLES = /^(dialog|alert|popup|messagebox)$/i
const PASSWORD_ROLE = /password|密码/i
// A failed action with one of these codes has an unknown outcome, not a refusal.
const AMBIGUOUS_CODES = new Set(['background_unavailable', 'timeout', 'unknown', 'unverifiable'])
const EFFECT_RANK = { confirmed: 0, noop: 1, unverifiable: 2, refused: 3 }

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const nonEmptyText = (value) => typeof value === 'string' && value.trim().length > 0

/**
 * The action has no usable target. Validation errors like this are thrown
 * before any backend call so a caller can correct the request.
 */
export class MissingTarget extends Error {
  constructor(op, detail) {
    super(`${op ?? 'action'} requires a target${detail === undefined ? '' : `: ${detail}`}`)
    this.name = 'MissingTarget'
  }
}

function explicitEffect(raw) {
  if (!isObject(raw)) return null
  for (const candidate of [raw.effect, raw.structured?.effect]) {
    if (typeof candidate === 'string' && EFFECTS.has(candidate)) return candidate
  }
  return null
}

function failureInfo(raw) {
  if (!isObject(raw)) return null
  const sources = [raw, isObject(raw.structured) ? raw.structured : null].filter(isObject)
  for (const source of sources) {
    if (source.ok === false || source.success === false || source.refused === true) {
      const error = isObject(source.error) ? source.error : null
      const code = source.code ?? error?.code ?? null
      const message =
        (typeof error?.message === 'string' && error.message) ||
        (typeof source.error === 'string' && source.error) ||
        (typeof source.message === 'string' && source.message) ||
        (typeof source.reason === 'string' && source.reason) ||
        code ||
        null
      return { code, message, unverifiable: typeof code === 'string' && AMBIGUOUS_CODES.has(code) }
    }
    if (source.error !== undefined && source.error !== null && source.error !== false) {
      const error = isObject(source.error) ? source.error : null
      const code = source.code ?? error?.code ?? null
      const message =
        (typeof error?.message === 'string' && error.message) ||
        (typeof source.error === 'string' && source.error) ||
        code ||
        null
      return { code, message, unverifiable: typeof code === 'string' && AMBIGUOUS_CODES.has(code) }
    }
  }
  return null
}

/**
 * Classify one backend result. An explicit `effect` wins; a plain string or a
 * normalized result with text is confirmed; a failure is refused unless its
 * code means the outcome is ambiguous; anything else is unverifiable.
 * Unverifiable is never promoted to confirmed.
 * @param {unknown} raw
 * @returns {'confirmed' | 'unverifiable' | 'refused' | 'noop'}
 */
export function classifyEffect(raw) {
  if (typeof raw === 'string') {
    if (EFFECTS.has(raw)) return raw
    if (AMBIGUOUS_CODES.has(raw)) return 'unverifiable'
    return 'confirmed'
  }
  if (raw instanceof Error) return 'refused'
  if (!isObject(raw)) return 'unverifiable'

  const effect = explicitEffect(raw)
  if (effect !== null) return effect

  const failure = failureInfo(raw)
  if (failure !== null) return failure.unverifiable ? 'unverifiable' : 'refused'

  if (typeof raw.text === 'string' && raw.text.trim().length > 0) return 'confirmed'
  return 'unverifiable'
}

function failureReason(raw) {
  if (raw instanceof Error) return raw.message
  const failure = failureInfo(raw)
  if (failure !== null) return failure.message
  if (isObject(raw)) {
    if (nonEmptyText(raw.detail)) return raw.detail
    if (nonEmptyText(raw.reason)) return raw.reason
  }
  return null
}

/**
 * Short human-readable action name used in result details and logs.
 * @param {string} op
 * @param {object} [target]
 */
export function buildActionSummary(op, target) {
  if (!isObject(target)) return op
  if (target.element !== undefined) return `${op} element ${target.element}`
  if (isFiniteNumber(target.x) && isFiniteNumber(target.y)) {
    return `${op} at (${target.x}, ${target.y})`
  }
  if (nonEmptyText(target.name)) return `${op} ${target.name}`
  if (nonEmptyText(target.aumid)) return `${op} ${target.aumid}`
  if (nonEmptyText(target.path)) return `${op} ${target.path}`
  if (target.pid !== undefined) return `${op} pid ${target.pid}`
  return op
}

function requireObservation(observation, op, detail = 'an observation with pid and windowId') {
  if (
    !isObject(observation) ||
    !isFiniteNumber(observation.pid) ||
    !isFiniteNumber(observation.windowId)
  ) {
    throw new MissingTarget(op, detail)
  }
  return observation
}

function windowArgs(observation) {
  return { pid: observation.pid, window_id: observation.windowId }
}

function outputDetail(summary, effect, raw) {
  let reason = null
  if (effect === 'refused' || effect === 'unverifiable') {
    reason = failureReason(raw)
    if (
      effect === 'unverifiable' &&
      typeof reason === 'string' &&
      reason.includes('background_unavailable')
    ) {
      reason = `${reason}; retry with foreground delivery`
    }
  }
  return `${summary}: ${effect}${reason === null ? '' : ` (${reason})`}`
}

function refusedResult(op, target, reason) {
  return { effect: 'refused', detail: `${buildActionSummary(op, target)}: refused (${reason})` }
}

function refusalReason(element) {
  if (PASSWORD_ROLE.test(String(element.role ?? ''))) return 'password-field'
  if (REFUSED_ROLES.test(String(element.role ?? ''))) return 'dialog-element'
  return null
}

function elementPoint(observation, element) {
  const frame = element.frame
  if (
    !isObject(frame) ||
    !isFiniteNumber(frame.x) ||
    !isFiniteNumber(frame.y) ||
    !isFiniteNumber(frame.w) ||
    !isFiniteNumber(frame.h)
  ) {
    throw new TypeError(`Element ${String(element.id)} has no usable frame`)
  }
  return toLocalPoint({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }, observation)
}

function resolvePoint(observation, target, op) {
  requireObservation(observation, op)
  if (!isObject(target)) throw new MissingTarget(op, 'expected {element: id} or {x, y}')
  const resolved = resolveTarget(observation, target)
  if (resolved.point !== undefined) return { point: resolved.point }
  const refusal = refusalReason(resolved.element)
  if (refusal !== null) return { refusal }
  return { point: elementPoint(observation, resolved.element), element: resolved.element }
}

function resolveElement(observation, id, op) {
  requireObservation(observation, op)
  const { element } = resolveTarget(observation, { element: id })
  const refusal = refusalReason(element)
  return refusal === null ? { element } : { refusal }
}

function validateDelivery(delivery) {
  const mode = delivery ?? 'auto'
  if (!DELIVERY_MODES.has(mode)) {
    throw new TypeError(
      `Invalid delivery: expected one of ${[...DELIVERY_MODES].join(', ')}`,
    )
  }
  return mode
}

function validateKeys(keys) {
  if (nonEmptyText(keys)) return { single: keys }
  if (
    Array.isArray(keys) &&
    keys.length > 0 &&
    keys.every((key) => nonEmptyText(key))
  ) {
    return { hotkey: keys }
  }
  throw new TypeError('key requires keys: a key name or a non-empty array of key names')
}

function validateFrame(frame) {
  if (
    !isObject(frame) ||
    !isFiniteNumber(frame.x) ||
    !isFiniteNumber(frame.y) ||
    !isFiniteNumber(frame.width) ||
    !isFiniteNumber(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    throw new TypeError('resize requires a frame with x, y, and positive width and height')
  }
  return frame
}

function planClick(options, count, button) {
  const { observation, op, target } = options
  if (target === undefined || target === null) {
    throw new MissingTarget(op, 'expected {element: id} or {x, y}')
  }
  const resolved = resolvePoint(observation, target, op)
  if (resolved.refusal !== undefined) return { refused: resolved.refusal }
  const args = {
    ...windowArgs(observation),
    x: resolved.point.x,
    y: resolved.point.y,
    count,
    button,
  }
  if (resolved.element !== undefined) args.element_token = resolved.element.id
  return {
    method: 'click',
    args,
    target: resolved.element ?? resolved.point,
  }
}

function planType(options) {
  const { observation, op, target, text, delivery } = options
  if (typeof text !== 'string') throw new TypeError('type requires text')
  const deliveryMode = validateDelivery(delivery)
  if (target !== undefined && target !== null) {
    if (!isObject(target) || target.element === undefined) {
      throw new TypeError('type target must be {element: id}')
    }
    const resolved = resolveElement(observation, target.element, op)
    if (resolved.refusal !== undefined) return { refused: resolved.refusal }
    return {
      method: 'typeText',
      args: {
        ...windowArgs(observation),
        element_token: resolved.element.id,
        text,
        delivery_mode: deliveryMode,
      },
    }
  }
  requireObservation(observation, op, 'an element or an observed foreground window')
  return {
    method: 'typeText',
    args: { ...windowArgs(observation), text, delivery_mode: deliveryMode },
  }
}

function planKey(options) {
  const { observation, op, target, keys } = options
  const validated = validateKeys(keys)
  requireObservation(observation, op, 'an element or an observed foreground window')
  if (target !== undefined && target !== null && target.element !== undefined) {
    const resolved = resolveElement(observation, target.element, op)
    if (resolved.refusal !== undefined) return { refused: resolved.refusal }
  }
  return validated.single !== undefined
    ? { method: 'pressKey', args: { key: validated.single } }
    : { method: 'hotkey', args: { keys: validated.hotkey } }
}

function planScroll(options) {
  const { observation, op, target, direction, amount, delivery } = options
  if (!DIRECTIONS.has(direction)) {
    throw new TypeError(
      `Invalid scroll direction: expected one of ${[...DIRECTIONS].join(', ')}`,
    )
  }
  const notches = amount ?? 3
  if (!isFiniteNumber(notches) || notches <= 0) {
    throw new TypeError('scroll requires amount to be a positive number')
  }
  requireObservation(observation, op)
  const args = {
    ...windowArgs(observation),
    direction,
    amount: notches,
    delivery_mode: validateDelivery(delivery),
  }
  if (target !== undefined && target !== null && target.element !== undefined) {
    const resolved = resolveElement(observation, target.element, op)
    if (resolved.refusal !== undefined) return { refused: resolved.refusal }
    args.element_token = resolved.element.id
  }
  return { method: 'scroll', args }
}

function planDrag(options) {
  const { observation, op, from, to } = options
  if (!isObject(from) || !isFiniteNumber(from.x) || !isFiniteNumber(from.y)) {
    throw new TypeError('drag requires from {x, y}')
  }
  if (!isObject(to) || !isFiniteNumber(to.x) || !isFiniteNumber(to.y)) {
    throw new TypeError('drag requires to {x, y}')
  }
  requireObservation(observation, op)
  return {
    method: 'drag',
    args: {
      ...windowArgs(observation),
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
    },
  }
}

function planMove(options) {
  const { observation, op, target } = options
  if (target === undefined || target === null) {
    throw new MissingTarget(op, 'expected {element: id} or {x, y}')
  }
  const resolved = resolvePoint(observation, target, op)
  if (resolved.refusal !== undefined) return { refused: resolved.refusal }
  return {
    method: 'moveCursor',
    args: {
      x: resolved.point.x,
      y: resolved.point.y,
      target: { kind: 'window', pid: observation.pid, window_id: observation.windowId },
    },
  }
}

function planLaunch(options) {
  const { op, target } = options
  if (!isObject(target)) throw new MissingTarget(op, '{name}, {aumid}, or {path}')
  for (const key of ['name', 'aumid', 'path']) {
    if (nonEmptyText(target[key])) return { method: 'launchApp', args: { [key]: target[key] } }
  }
  throw new MissingTarget(op, '{name}, {aumid}, or {path}')
}

function planFocus(options) {
  const { observation, op } = options
  requireObservation(observation, op)
  return {
    method: 'bringToFront',
    args: { pid: observation.pid, windowId: observation.windowId },
  }
}

function planResize(options) {
  const { observation, op, frame } = options
  requireObservation(observation, op)
  const usable = validateFrame(frame)
  return {
    method: 'setWindowFrame',
    args: {
      pid: observation.pid,
      windowId: observation.windowId,
      x: usable.x,
      y: usable.y,
      width: usable.width,
      height: usable.height,
    },
  }
}

function planKill(options) {
  const { observation, target, op } = options
  const pid = (isObject(target) ? target.pid : undefined) ?? observation?.pid
  if (!Number.isInteger(pid) || pid <= 0) throw new MissingTarget(op, 'pid')
  return { method: 'killApp', args: { pid }, target: { pid } }
}

function prepare(options) {
  const { op, amount, sleep } = options
  switch (op) {
    case 'click':
      return planClick(options, 1, 'left')
    case 'doubleClick':
      return planClick(options, 2, 'left')
    case 'rightClick':
      return planClick(options, 1, 'right')
    case 'type':
      return planType(options)
    case 'key':
      return planKey(options)
    case 'scroll':
      return planScroll(options)
    case 'drag':
      return planDrag(options)
    case 'move':
      return planMove(options)
    case 'wait':
      return {
        wait: amount ?? 1000,
        sleep:
          typeof sleep === 'function'
            ? sleep
            : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }
    case 'launch':
      return planLaunch(options)
    case 'focus':
      return planFocus(options)
    case 'resize':
      return planResize(options)
    case 'kill':
      return planKill(options)
    default:
      throw new TypeError(`Invalid action op: ${String(op)}`)
  }
}

async function authorize(options, action) {
  const authorizeFn =
    typeof options.authorize === 'function'
      ? options.authorize
      : typeof options.policy?.authorize === 'function'
        ? options.policy.authorize.bind(options.policy)
        : null
  if (authorizeFn === null) return null
  let decision
  try {
    decision = await authorizeFn({
      action,
      target: action.target,
      session: options.session,
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (decision === true) return null
  if (decision === false) return 'denied'
  if (typeof decision === 'string') {
    return ['allowed', 'approved', 'allow'].includes(decision) ? null : decision
  }
  if (!isObject(decision)) return null
  if (decision.allowed === false || decision.approved === false) {
    return decision.reason ?? 'denied'
  }
  if (typeof decision.decision === 'string') {
    return ['allowed', 'approved', 'allow'].includes(decision.decision)
      ? null
      : (decision.reason ?? decision.decision)
  }
  return null
}

function changed(previous, next) {
  if (
    previous.role !== next.role ||
    previous.label !== next.label ||
    previous.value !== next.value ||
    previous.focused !== next.focused
  ) {
    return true
  }
  if (JSON.stringify(previous.actions ?? []) !== JSON.stringify(next.actions ?? [])) return true
  const a = previous.frame
  const b = next.frame
  return (
    isObject(a) &&
    isObject(b) &&
    (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)
  )
}

async function verifyAfter(backend, observation) {
  if (typeof backend.getWindowState !== 'function') return undefined
  try {
    const state = await backend.getWindowState({
      pid: observation.pid,
      windowId: observation.windowId,
      treeFormat: 'elements',
    })
    const elements = state?.structured?.elements ?? state?.elements
    if (!Array.isArray(elements)) {
      return { observed: false, error: 'readback returned no elements' }
    }
    const previous = new Map(observation.tree.map((element) => [element.id, element]))
    let updated = 0
    for (const element of elements) {
      const id = element?.element_token ?? element?.id
      const before = previous.get(id)
      if (before === undefined || changed(before, element)) updated += 1
    }
    return { observed: true, changed: updated > 0, updated }
  } catch (error) {
    return { observed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Execute one action against a backend adapter.
 * @param {object} backend Task 9 backend surface
 * @param {{observation?: object, op: string, target?: object, text?: string, keys?: string | string[], direction?: string, amount?: number, from?: object, to?: object, frame?: object, delivery?: string, observeAfter?: boolean, policy?: object, authorize?: Function, sleep?: Function}} options
 */
export async function execute(backend, options = {}) {
  if (!isObject(backend)) throw new TypeError('execute requires a backend object')
  if (!isObject(options)) throw new TypeError('execute requires an options object')
  const op = options.op
  if (!OPS.has(op)) throw new TypeError(`Invalid action op: ${String(op)}`)

  const plan = prepare(options)
  if (plan.refused !== undefined) {
    return refusedResult(op, options.target, plan.refused)
  }

  if (plan.wait !== undefined) {
    if (!isFiniteNumber(plan.wait) || plan.wait < 0) {
      throw new TypeError('wait requires a non-negative amount in milliseconds')
    }
    await plan.sleep(plan.wait)
    return { effect: 'noop', detail: `${buildActionSummary(op, options.target)}: noop` }
  }

  const action = {
    op,
    target: plan.target ?? options.target,
    text: options.text,
    delivery: options.delivery,
    observed:
      isObject(options.observation) &&
      isFiniteNumber(options.observation.pid) &&
      isFiniteNumber(options.observation.windowId),
  }
  const denial = await authorize(options, action)
  if (denial !== null) return refusedResult(op, options.target, denial)

  const summary = buildActionSummary(op, options.target)
  if (typeof backend[plan.method] !== 'function') {
    throw new TypeError(`Backend does not support ${plan.method}`)
  }
  let raw
  try {
    raw = await backend[plan.method](plan.args)
  } catch (error) {
    raw = error
  }

  const effect = classifyEffect(raw)
  const result = { effect, detail: outputDetail(summary, effect, raw) }

  if (
    effect !== 'refused' &&
    options.observeAfter !== false &&
    READBACK_OPS.has(op) &&
    isObject(options.observation)
  ) {
    const verification = await verifyAfter(backend, options.observation)
    if (verification !== undefined) result.verification = verification
  }
  return result
}

/**
 * Execute steps sequentially. The worst effect wins; refusals stop the batch
 * by default. Invalid step definitions (e.g. a missing target) still throw so a
 * caller sees its programming error instead of a fake action outcome.
 * @param {object} backend
 * @param {{steps: object[], stopOnError?: boolean, observation?: object}} batch
 */
export async function executeBatch(backend, batch = {}) {
  if (!isObject(batch)) throw new TypeError('executeBatch requires a batch object')
  const { steps, stopOnError = true } = batch
  if (!Array.isArray(steps)) throw new TypeError('executeBatch requires an array of steps')

  if (steps.length === 0) return { effect: 'noop', results: [] }

  const shared = { ...batch }
  delete shared.steps
  delete shared.stopOnError

  const results = []
  let worst = 'confirmed'
  let failedAt
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (!isObject(step)) throw new TypeError(`Invalid step ${index}: expected an object`)
    const result = await execute(backend, { ...shared, ...step })
    results.push({ index, effect: result.effect, detail: result.detail })
    if (EFFECT_RANK[result.effect] > EFFECT_RANK[worst]) worst = result.effect
    if (stopOnError && result.effect === 'refused') {
      failedAt = index
      break
    }
  }

  const output = { effect: worst, results }
  if (failedAt !== undefined) output.failedAt = failedAt
  return output
}
