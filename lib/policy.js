import { APPROVAL_MODES } from './config.js'

const LOW_OPS = new Set(['observe', 'focus', 'wait', 'move', 'hover'])
const MEDIUM_OPS = new Set([
  'type',
  'typeText',
  'setText',
  'key',
  'pressKey',
  'hotkey',
  'scroll',
  'drag',
  'resize',
])
const HIGH_OPS = new Set([
  'launch',
  'launchApp',
  'kill',
  'switchWindow',
  'switch-window',
  'windowSwitch',
  'window-switch',
  'switch',
  'activateWindow',
])
const CLICK_OPS = new Set(['click', 'doubleClick', 'rightClick', 'middleClick', 'tripleClick'])
const TYPING_OPS = new Set(['type', 'typeText', 'setText'])
// Foreground removes the background safety net for input that injects typed data.
const FOREGROUND_HIGH_OPS = new Set([...TYPING_OPS, 'key', 'pressKey', 'hotkey', 'scroll', 'drag'])
const OBSERVED_EXEMPT_OPS = new Set(['observe', 'session', 'wait'])
const RATE_WINDOW_MS = 60_000

const SENSITIVE_TEXT = /密码|支付|转账|删除|发送|提交|password|pay|delete|send|submit/i
const PASSWORD_FIELD = /password|密码/i
const EDITABLE_ROLE = /password|edit|textbox|textfield|text field|input|textarea|text area/i
const SECURE_DESKTOP =
  /user account control|用户账户控制|安全桌面|secure[\s_-]*desktop|consent\.exe|\buac\b/i

const ALLOWED_OUTCOMES = new Set(['allowed-once', 'allowed', 'approved'])

const TARGET_MARKER_FIELDS = [
  'role',
  'label',
  'name',
  'title',
  'windowTitle',
  'app',
  'appName',
  'process',
  'processName',
  'path',
  'executable',
  'markers',
]
const ACTION_MARKER_FIELDS = [
  'op',
  'label',
  'name',
  'title',
  'windowTitle',
  'app',
  'process',
  'reason',
  'markers',
]

const asText = (value) => (typeof value === 'string' ? value : '')

function markerText(value) {
  if (Array.isArray(value)) return value.map(markerText).filter(Boolean).join(' ')
  return asText(value)
}

function markersOf(source, fields) {
  if (source === null || typeof source !== 'object') return ''
  return fields.map((field) => markerText(source[field])).filter(Boolean).join(' ')
}

function appName(action, target) {
  return asText(action?.app) || asText(target?.app)
}

/** Case-insensitive substring match against a configured app-name list. */
function matchesApp(app, entries) {
  if (!Array.isArray(entries) || app === '') return false
  const name = app.toLowerCase()
  return entries.some((entry) => {
    const text = asText(entry).trim().toLowerCase()
    return text !== '' && name.includes(text)
  })
}

function hasElementTarget(target) {
  return target !== null && typeof target === 'object' && target.element !== undefined && target.element !== null
}

function passwordFieldReason(target) {
  if (target === null || typeof target !== 'object') return null
  const role = asText(target.role)
  const label = asText(target.label)
  if (PASSWORD_FIELD.test(role)) return 'password-field'
  // A label alone proves nothing: "Password" may name a button, not a field.
  if (EDITABLE_ROLE.test(role) && PASSWORD_FIELD.test(label)) return 'password-field'
  return null
}

/**
 * Classify an action's risk from its op, target and typed text.
 * Unknown ops fail closed as high risk.
 * @param {{op?: string, target?: object, text?: string, delivery?: string}} [input]
 * @returns {'low' | 'medium' | 'high'}
 */
export function classifyRisk({ op, target, text, delivery } = {}) {
  const name = asText(op)
  const subject = target ?? {}

  if (name === 'observe') return 'low'
  if (HIGH_OPS.has(name)) return 'high'
  // Foreground escalates typed input and coordinate clicks; element-token clicks stay low.
  if (delivery === 'foreground') {
    if (FOREGROUND_HIGH_OPS.has(name)) return 'high'
    if (CLICK_OPS.has(name) && !hasElementTarget(subject)) return 'high'
  }
  if (TYPING_OPS.has(name)) {
    if (passwordFieldReason(subject) !== null || SENSITIVE_TEXT.test(asText(text))) return 'high'
    return 'medium'
  }
  if (CLICK_OPS.has(name)) return hasElementTarget(subject) ? 'low' : 'high'
  if (LOW_OPS.has(name)) return 'low'
  if (MEDIUM_OPS.has(name)) return 'medium'
  return 'high'
}

/**
 * Non-overridable blocks: password/secure fields, UAC/secure desktop, and
 * actions against a snapshot that was never observed.
 * Action-bearing ops (everything except `observe`, `session`, `wait`) must carry
 * `observed: true` from a fresh observation; the Task 14 tool dispatch sets it.
 * @param {{target?: object, action?: object}} [input]
 * @returns {{blocked: boolean, reason?: string}}
 */
export function isHardBlocked({ target, action } = {}) {
  const subject = target ?? action?.target ?? {}
  const password = passwordFieldReason(subject)
  if (password !== null) return { blocked: true, reason: password }

  const markers = `${markersOf(subject, TARGET_MARKER_FIELDS)} ${markersOf(action, ACTION_MARKER_FIELDS)}`
  if (SECURE_DESKTOP.test(markers)) return { blocked: true, reason: 'secure-desktop' }

  if (
    action !== null &&
    typeof action === 'object' &&
    !OBSERVED_EXEMPT_OPS.has(asText(action.op)) &&
    action.observed !== true
  ) {
    return { blocked: true, reason: 'unobserved-action' }
  }
  return { blocked: false }
}

function approvalRequired(mode, risk) {
  if (risk === 'high') return true
  if (risk === 'medium') return mode === 'strict'
  return false
}

function normalizeOutcome(result) {
  if (typeof result === 'string') {
    return result.trim().toLowerCase().replaceAll('_', '-')
  }
  if (result === null || typeof result !== 'object') return null
  for (const key of ['decision', 'outcome', 'status', 'result']) {
    const value = result[key]
    if (typeof value === 'string') return normalizeOutcome(value)
  }
  if (result.allowed === true || result.approved === true) return 'approved'
  return null
}

async function askApproval(approval, { action, session, target, risk, mode }) {
  if (approval === null || typeof approval !== 'object' || typeof approval.request !== 'function') {
    return false
  }
  const request = {
    toolName: 'computer',
    reason: `${risk} risk ${asText(action.op) || 'action'} requires approval`,
    detail: {
      op: asText(action.op) || null,
      risk,
      mode,
      target,
      delivery: asText(action.delivery) || null,
      textLength: typeof action.text === 'string' ? action.text.length : null,
      sessionId: typeof session === 'string' ? session : (session?.sessionId ?? null),
    },
  }
  try {
    return ALLOWED_OUTCOMES.has(normalizeOutcome(await approval.request(request)))
  } catch {
    // Approval is a trust boundary: any failure or rejection is a denial.
    return false
  }
}

/**
 * Build the policy gate. Approval is injected so this module never imports the host.
 * @param {{config?: object, approval?: {request?: Function}, now?: () => number}} [options]
 */
export function createPolicy({ config, approval, now } = {}) {
  const mode = config?.approvals?.mode ?? 'ask'
  if (!APPROVAL_MODES.includes(mode)) {
    throw new TypeError(`Invalid approvals.mode: expected one of ${APPROVAL_MODES.join(', ')}`)
  }
  const settings = config?.policy ?? {}
  const clock = typeof now === 'function' ? now : Date.now
  // Per-process action timestamps; only consulted when a positive limit is set.
  const recent = []

  function appGate(act, subject, risk) {
    if (OBSERVED_EXEMPT_OPS.has(asText(act.op))) return null
    const app = appName(act, subject)
    if (matchesApp(app, settings.blockedApps)) {
      return { allowed: false, reason: 'blocked-app', risk }
    }
    if (Array.isArray(settings.allowedApps) && settings.allowedApps.length > 0) {
      if (!matchesApp(app, settings.allowedApps)) {
        return { allowed: false, reason: 'app-not-allowed', risk }
      }
    }
    return null
  }

  function rateGate(act, risk) {
    const limit = settings.maxActionsPerMinute
    if (!Number.isInteger(limit) || limit <= 0) return { limited: false, at: null }
    if (OBSERVED_EXEMPT_OPS.has(asText(act.op))) return { limited: false, at: null }
    const at = clock()
    while (recent.length > 0 && recent[0] <= at - RATE_WINDOW_MS) recent.shift()
    if (recent.length >= limit) return { limited: true, at }
    return { limited: false, at }
  }

  return {
    /**
     * @param {{action?: object, session?: object | string, target?: object}} [input]
     * @returns {Promise<{allowed: boolean, reason: string, risk: 'low' | 'medium' | 'high'}>}
     */
    async authorize({ action, session, target } = {}) {
      const act = action ?? {}
      const subject = target ?? act.target ?? {}
      const risk = classifyRisk({
        op: act.op,
        target: subject,
        text: act.text,
        delivery: act.delivery,
      })

      const block = isHardBlocked({ target: subject, action: act })
      if (block.blocked) {
        return { allowed: false, reason: `hard-blocked: ${block.reason}`, risk }
      }

      const appDenial = appGate(act, subject, risk)
      if (appDenial !== null) return appDenial

      const rate = rateGate(act, risk)
      if (rate.limited) return { allowed: false, reason: 'rate-limited', risk }

      let allowed = true
      if (approvalRequired(mode, risk)) {
        allowed = await askApproval(approval, { action: act, session, target: subject, risk, mode })
        if (!allowed) return { allowed: false, reason: 'approval-denied', risk }
      }

      if (rate.at !== null) recent.push(rate.at)
      return { allowed: true, reason: 'allowed', risk }
    },
  }
}
