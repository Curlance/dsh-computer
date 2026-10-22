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

const SENSITIVE_TEXT = /密码|支付|转账|删除|发送|提交|password|pay|delete|send|submit/i
const PASSWORD_FIELD = /password|密码/i
const SECURE_DESKTOP = /\buac\b|secure[-_ ]?desktop|consent\.exe/i

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

function hasElementTarget(target) {
  return target !== null && typeof target === 'object' && target.element !== undefined && target.element !== null
}

function passwordFieldReason(target) {
  if (target === null || typeof target !== 'object') return null
  const role = asText(target.role)
  const label = asText(target.label)
  if (PASSWORD_FIELD.test(role) || PASSWORD_FIELD.test(label)) return 'password-field'
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
  // Foreground input has no background safety net, so it always needs approval.
  if (delivery === 'foreground' && !LOW_OPS.has(name)) return 'high'
  if (TYPING_OPS.has(name)) {
    if (passwordFieldReason(subject) !== null || SENSITIVE_TEXT.test(asText(text))) return 'high'
    return 'medium'
  }
  if (CLICK_OPS.has(name)) return hasElementTarget(subject) ? 'low' : 'high'
  if (name === 'focus' || name === 'wait' || name === 'move') return 'low'
  if (MEDIUM_OPS.has(name)) return 'medium'
  return 'high'
}

/**
 * Non-overridable blocks: password/secure fields, UAC/secure desktop, and
 * actions against a snapshot that was never observed.
 * @param {{target?: object, action?: object}} [input]
 * @returns {{blocked: boolean, reason?: string}}
 */
export function isHardBlocked({ target, action } = {}) {
  const subject = target ?? action?.target ?? {}
  const password = passwordFieldReason(subject)
  if (password !== null) return { blocked: true, reason: password }

  const markers = `${markersOf(subject, TARGET_MARKER_FIELDS)} ${markersOf(action, ACTION_MARKER_FIELDS)}`
  if (SECURE_DESKTOP.test(markers)) return { blocked: true, reason: 'secure-desktop' }

  if (action !== null && typeof action === 'object' && action.observed === false) {
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
 * @param {{config?: object, approval?: {request?: Function}}} [options]
 */
export function createPolicy({ config, approval } = {}) {
  const mode = config?.approvals?.mode ?? 'ask'
  if (!APPROVAL_MODES.includes(mode)) {
    throw new TypeError(`Invalid approvals.mode: expected one of ${APPROVAL_MODES.join(', ')}`)
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

      if (!approvalRequired(mode, risk)) {
        return { allowed: true, reason: 'allowed', risk }
      }

      const allowed = await askApproval(approval, { action: act, session, target: subject, risk, mode })
      return allowed
        ? { allowed: true, reason: 'allowed', risk }
        : { allowed: false, reason: 'approval-denied', risk }
    },
  }
}
