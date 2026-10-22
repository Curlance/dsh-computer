/**
 * tool.js —— 统一 `computer` 工具的定义与分发。
 *
 * 只组合已注入的依赖（observer/render/act/policy/control/session/audit），
 * 不导入 DSH host，也不做任何持久化。
 */
import { execute, executeBatch } from './act.js'
import { redactText } from './audit.js'
import { renderTree } from './render.js'

const ACT_OPS = [
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
]
const SESSION_OPS = ['status', 'begin', 'end', 'takeover', 'resume']
const OBSERVE_MODES = ['tree', 'screenshot', 'both']
const WAIT_CONDITIONS = [
  'text_exists',
  'active_window',
  'element_exists',
  'element_enabled',
  'focused_element',
]
const DELIVERY_MODES = ['auto', 'background', 'foreground']
const ACT_FIELDS = [
  'op',
  'target',
  'text',
  'keys',
  'direction',
  'amount',
  'from',
  'to',
  'frame',
  'delivery',
  'observeAfter',
]
const OBSERVE_FIELDS = ['mode', 'query', 'maxElements', 'includeScreenshot', 'waitFor']

const DESCRIPTION =
  'Observe and control the Windows desktop. Coordinates are window-local pixels in the most ' +
  "recent observation's screenshot space (see space/scale). Observe before acting: actions " +
  'require a current observation and are verified by readback; unverifiable outcomes are never ' +
  'reported as success. Approval, the user-activity control gate, and non-overridable hard ' +
  'blocks (password fields, UAC/secure desktop) apply. Use action "session" to inspect or manage ' +
  'the desktop lease; act begins one automatically.'

// The most recent observation per injected deps object, used when act has no revision.
const lastObservations = new WeakMap()

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const TARGET_SCHEMA = {
  type: 'object',
  description:
    'observe: {kind:"active"} | {kind:"window",pid,windowId} | {kind:"screen",index?}; ' +
    'act: {element:id} | {x,y} | launch {name|aumid|path} | kill {pid}',
}

const KEYS_SCHEMA = {
  oneOf: [
    { type: 'string', minLength: 1 },
    { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
  ],
}

const POINT_SCHEMA = {
  type: 'object',
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
}

const WAIT_FOR_SCHEMA = {
  type: 'object',
  description: 'Poll once inside this observe call and return when the condition matches.',
  properties: {
    condition: { type: 'string', enum: WAIT_CONDITIONS },
    text: { type: 'string', minLength: 1 },
    windowName: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
    intervalMs: { type: 'integer', minimum: 1, maximum: 5000 },
    target: TARGET_SCHEMA,
  },
  required: ['condition'],
}

const ACT_STEP_SCHEMA = {
  type: 'object',
  required: ['op'],
  properties: {
    op: { type: 'string', enum: ACT_OPS },
    target: TARGET_SCHEMA,
    text: { type: 'string' },
    keys: KEYS_SCHEMA,
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'number', minimum: 0 },
    from: POINT_SCHEMA,
    to: POINT_SCHEMA,
    frame: {
      type: 'object',
      required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
    },
    delivery: { type: 'string', enum: DELIVERY_MODES },
    observeAfter: { type: 'boolean' },
  },
}

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['observe', 'act', 'session'],
      description: 'observe: read the desktop; act: perform actions; session: manage the lease.',
    },
    revision: {
      type: 'integer',
      minimum: 1,
      description: 'Observation revision for act; omit to use the most recent observation.',
    },
    target: TARGET_SCHEMA,
    mode: { type: 'string', enum: OBSERVE_MODES },
    query: { type: 'string', minLength: 1 },
    maxElements: { type: 'integer', minimum: 1 },
    includeScreenshot: { type: 'boolean' },
    waitFor: WAIT_FOR_SCHEMA,
    op: {
      type: 'string',
      enum: [...ACT_OPS, ...SESSION_OPS],
      description: `act: ${ACT_OPS.join('|')}; session: ${SESSION_OPS.join('|')}`,
    },
    steps: {
      type: 'array',
      minItems: 1,
      description: 'Sequential act batch; each step is authorized, executed and audited separately.',
      items: ACT_STEP_SCHEMA,
    },
    stopOnError: { type: 'boolean' },
    text: { type: 'string' },
    keys: KEYS_SCHEMA,
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'number', minimum: 0 },
    from: POINT_SCHEMA,
    to: POINT_SCHEMA,
    frame: {
      type: 'object',
      required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
    },
    delivery: { type: 'string', enum: DELIVERY_MODES },
    observeAfter: { type: 'boolean' },
    note: { type: 'string', description: 'Optional takeover note.' },
    sessionId: { type: 'string', minLength: 1, description: 'Lease id for end/takeover/resume.' },
  },
}

function resolveAgentId(exec) {
  const candidate = isObject(exec)
    ? (exec.agentId ?? exec.agent?.id ?? exec.sessionId ?? exec.session?.id)
    : typeof exec === 'string'
      ? exec
      : undefined
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'agent'
}

function sessionErrorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  return `session ${error?.code ?? 'error'}: ${message}`
}

function sessionFailure(error) {
  return {
    ok: false,
    result: sessionErrorText(error),
    ...(error?.code === undefined ? {} : { code: error.code }),
  }
}

/**
 * Resolve the observation an act call runs against. An explicit revision is the
 * caller's contract; otherwise the last observation is re-read through the
 * observer so its TTL is still enforced.
 */
function currentObservation(deps, args) {
  if (args.revision !== undefined && args.revision !== null) return deps.observer.get(args.revision)
  const last = lastObservations.get(deps)
  if (last === undefined) {
    throw new Error('act requires a current observation: call action "observe" first or pass revision')
  }
  if (typeof deps.observer.get === 'function') return deps.observer.get(last.revision)
  return last
}

async function ensureSession(deps, exec) {
  const status = await deps.sessions.status()
  let sessionId = status?.sessionId
  let agentId = status?.agentId ?? resolveAgentId(exec)

  if (status?.active !== true) {
    try {
      const begun = await deps.sessions.begin(resolveAgentId(exec))
      sessionId = begun.sessionId
      agentId = begun.agentId ?? agentId
    } catch (error) {
      return sessionFailure(error)
    }
  }

  try {
    const renewed = await deps.sessions.renew(sessionId)
    return { session: { sessionId, agentId: renewed?.agentId ?? agentId } }
  } catch (error) {
    return sessionFailure(error)
  }
}

/**
 * Per-step authorization: policy first, then the user-activity gate. Returning a
 * string is execute()'s denial contract; the full decision stays in `calls` so
 * dispatch can audit and report it.
 */
function createGate(deps, session) {
  const calls = []
  let lastDenial = null

  async function authorize({ action, target }) {
    const decision = await deps.policy.authorize({ action, session, target })
    const risk = decision?.risk
    if (decision?.allowed !== true) {
      const denial = {
        by: 'policy',
        reason: decision?.reason ?? 'approval-denied',
        risk,
      }
      calls.push({ op: action?.op, target, risk, decision: 'denied', denial })
      lastDenial = denial
      return denial.reason
    }

    const control = await deps.control.assertAgentAllowed()
    if (control?.allowed !== true) {
      const controlName = control?.control ?? 'unknown'
      const waitSeconds = control?.waitSeconds ?? 0
      const denial = {
        by: 'control',
        reason: `control ${controlName}${waitSeconds > 0 ? `; retry in ${waitSeconds}s` : ''}`,
        control: controlName,
        waitSeconds,
      }
      calls.push({ op: action?.op, target, risk, decision: 'denied', denial })
      lastDenial = denial
      return denial.reason
    }

    calls.push({ op: action?.op, target, risk, decision: 'allowed' })
    return null
  }

  return {
    authorize,
    calls,
    get lastDenial() {
      return lastDenial
    },
  }
}

function actFields(source) {
  const fields = {}
  for (const key of ACT_FIELDS) {
    if (source[key] !== undefined) fields[key] = source[key]
  }
  return fields
}

function markUnverifiable(result) {
  if (!isObject(result) || result.effect !== 'unverifiable') return result
  return { ...result, detail: `⚠️ ${String(result.detail ?? 'unverifiable')}` }
}

function inputSummaryOf(step) {
  return typeof step?.text === 'string' ? redactText(step.text) : undefined
}

function recordAudit(deps, event) {
  if (deps.audit === undefined || deps.audit === null) return Promise.resolve()
  if (typeof deps.audit.record !== 'function') {
    throw new TypeError('deps.audit.record must be a function')
  }
  return deps.audit.record(event)
}

function auditEntry(deps, session, observation, step, call, result, durationMs) {
  const summary = inputSummaryOf(step)
  const decision = call?.decision ?? (result.effect === 'refused' ? 'denied' : 'allowed')
  return recordAudit(deps, {
    sessionId: session.sessionId,
    agentId: session.agentId,
    action: call?.op ?? step?.op,
    target: call?.target ?? step?.target,
    risk: call?.risk ?? 'high',
    decision,
    effect: result.effect,
    durationMs,
    observationRevision: observation.revision,
    ...(summary === undefined ? {} : { inputSummary: summary }),
  })
}

function noteAction(deps, result) {
  if (result.effect === 'refused') return
  if (typeof deps.control.noteAgentAction === 'function') deps.control.noteAgentAction()
}

async function act(deps, args, exec) {
  const observation = currentObservation(deps, args)
  const ensured = await ensureSession(deps, exec)
  if (ensured.error !== undefined) return ensured

  const session = ensured.session
  const gate = createGate(deps, session)
  const started = Date.now()

  if (Array.isArray(args.steps)) {
    if (args.steps.length === 0) throw new TypeError('act steps must be a non-empty array')
    const steps = args.steps.map((step) => (isObject(step) ? actFields(step) : step))
    const batch = await executeBatch(deps.backend, {
      steps,
      stopOnError: args.stopOnError ?? true,
      observation,
      authorize: gate.authorize,
    })
    const durationMs = Date.now() - started
    const results = batch.results.map((result) => markUnverifiable(result))

    for (let index = 0; index < results.length; index += 1) {
      await auditEntry(deps, session, observation, steps[index], gate.calls[index], results[index], durationMs)
      noteAction(deps, results[index])
    }

    const denied = gate.calls.find((call) => call.decision === 'denied')
    return {
      ok: denied === undefined,
      result: {
        effect: batch.effect,
        results,
        ...(batch.failedAt === undefined ? {} : { failedAt: batch.failedAt }),
        summary: results.map((entry) => entry.detail).join('\n'),
        ...(denied === undefined ? {} : { denied: denied.denial }),
      },
    }
  }

  if (typeof args.op !== 'string') throw new Error('act requires op or steps')
  const step = actFields(args)
  const raw = await execute(deps.backend, { ...step, observation, authorize: gate.authorize })
  const durationMs = Date.now() - started
  const result = markUnverifiable(raw)
  const denial = gate.lastDenial

  await auditEntry(deps, session, observation, step, gate.calls[0], result, durationMs)
  noteAction(deps, result)

  return {
    ok: denial === null,
    result: {
      ...result,
      summary: result.detail,
      ...(denial === null ? {} : { denied: denial }),
    },
  }
}

function waitForLabel(args) {
  const condition = args.waitFor?.condition
  const subject = args.waitFor?.text ?? args.waitFor?.windowName
  return `waitFor${condition === undefined ? '' : ` ${condition}`}${subject === undefined ? '' : ` ${JSON.stringify(subject)}`}`
}

function observationText(observation, args) {
  const rendered = renderTree(
    observation,
    args.maxElements === undefined ? {} : { maxElements: args.maxElements },
  )
  if (observation.waitFor === undefined) return rendered
  const label = waitForLabel(args)
  const evidence = `matched=${observation.waitFor.matched === true} elapsedMs=${observation.waitFor.elapsedMs}`
  return observation.waitFor.matched === true
    ? `${rendered}\n${label}: ${evidence}`
    : `${rendered}\n⚠️ ${label}: ${evidence}`
}

async function observe(deps, args) {
  const started = Date.now()
  const options = {}
  for (const key of OBSERVE_FIELDS) {
    if (args[key] !== undefined) options[key] = args[key]
  }

  const observation = await deps.observer.observe(args.target, options)
  lastObservations.set(deps, observation)

  let image
  if (observation.screenshotPng !== undefined && typeof deps.persistImage === 'function') {
    const persisted = await deps.persistImage(observation)
    image = persisted?.image ?? persisted ?? undefined
  }

  await recordAudit(deps, {
    action: 'observe',
    target: args.target,
    risk: 'low',
    decision: 'allowed',
    effect: observation.waitFor?.matched === false ? 'unverifiable' : 'confirmed',
    durationMs: Date.now() - started,
    observationRevision: observation.revision,
  })

  const text = observationText(observation, args)
  return image === undefined ? { ok: true, result: text } : { ok: true, result: text, image }
}

async function sessionAction(deps, args, exec) {
  switch (args.op) {
    case 'status': {
      const lease = await deps.sessions.status()
      let activity
      try {
        activity = await deps.control.status()
      } catch {
        activity = { control: 'unavailable', lastInputAgeMs: null, waitSeconds: 0 }
      }
      return { ok: true, result: { ...lease, ...activity } }
    }
    case 'begin': {
      try {
        return { ok: true, result: await deps.sessions.begin(resolveAgentId(exec)) }
      } catch (error) {
        return sessionFailure(error)
      }
    }
    case 'end':
    case 'takeover':
    case 'resume': {
      try {
        const status = await deps.sessions.status()
        const sessionId = args.sessionId ?? status?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { ok: false, result: `session ${args.op} requires a sessionId` }
        }
        const result =
          args.op === 'end'
            ? await deps.sessions.end(sessionId)
            : args.op === 'takeover'
              ? await deps.sessions.takeover(sessionId, args.note)
              : await deps.sessions.resume(sessionId)
        return { ok: true, result }
      } catch (error) {
        return sessionFailure(error)
      }
    }
    default:
      throw new Error(`Unknown session op: ${String(args.op)}`)
  }
}

/**
 * Dispatch one `computer` tool call.
 * @param {object} deps {backend, observer, policy, sessions, control, audit, persistImage, config?}
 * @param {object} args tool arguments
 * @param {object} [exec] host execution context; agentId/sessionId are used for the lease
 * @returns {Promise<{ok: boolean, result: unknown, image?: object}>}
 */
export async function dispatch(deps, args, exec) {
  if (!isObject(deps)) throw new TypeError('dispatch requires a deps object')
  if (!isObject(args)) throw new TypeError('computer arguments must be an object')

  switch (args.action) {
    case 'observe':
      return observe(deps, args)
    case 'act':
      return act(deps, args, exec)
    case 'session':
      return sessionAction(deps, args, exec)
    default:
      throw new Error(`Unknown computer action: ${String(args.action)}`)
  }
}

/**
 * Build the defineTool() argument object for the unified computer tool.
 * @param {object} deps injected dependencies, see dispatch()
 */
export function buildComputerTool(deps) {
  if (!isObject(deps)) throw new TypeError('buildComputerTool requires a deps object')
  return {
    name: 'computer',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    execute(args, exec) {
      return dispatch(deps, args, exec)
    },
  }
}
