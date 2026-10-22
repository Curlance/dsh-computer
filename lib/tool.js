/**
 * tool.js —— 统一 `computer` 工具的定义与分发。
 *
 * 只组合已注入的依赖（observer/render/act/policy/control/session/audit），
 * 不导入 DSH host，也不做任何持久化。
 */
import { buildActionSummary, execute } from './act.js'
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
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const EFFECT_RANK = { confirmed: 0, noop: 1, unverifiable: 2, refused: 3 }

function errorReason(error) {
  return error instanceof Error ? error.message : String(error)
}

const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: true,
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
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
}

const WAIT_FOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
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
  additionalProperties: false,
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
      additionalProperties: false,
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
      additionalProperties: false,
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

// dsh-tools author DSL: annotations per value node, `required` only inline on a
// property. Numeric/length keywords (minimum, minLength, minItems, ...) are not
// expressible there, so they stay in this raw schema for reference only.
const DSL_ANNOTATIONS = ['description', 'title', 'default', 'examples']

function dslAnnotations(node) {
  const spec = {}
  for (const key of DSL_ANNOTATIONS) {
    if (node[key] !== undefined) spec[key] = node[key]
  }
  return spec
}

function toDslValue(node) {
  if (node.oneOf !== undefined) {
    return { ...dslAnnotations(node), oneOf: node.oneOf.map(toDslValue) }
  }
  switch (node.type) {
    case 'object': {
      const spec = {
        type: 'object',
        additionalProperties: node.additionalProperties === true,
        ...dslAnnotations(node),
      }
      if (node.properties !== undefined) {
        spec.properties = toDslProperties(node.properties, node.required)
      }
      return spec
    }
    case 'array': {
      const spec = { type: 'array', ...dslAnnotations(node) }
      if (node.items !== undefined) spec.items = toDslValue(node.items)
      return spec
    }
    default: {
      const spec = { ...dslAnnotations(node) }
      if (node.type !== undefined) spec.type = node.type
      if (node.enum !== undefined) spec.enum = [...node.enum]
      if (node.const !== undefined) spec.const = node.const
      return spec
    }
  }
}

function toDslProperties(properties, required = []) {
  const specs = {}
  for (const [key, value] of Object.entries(properties)) {
    const spec = toDslValue(value)
    if (required.includes(key)) spec.required = true
    specs[key] = spec
  }
  return specs
}

/**
 * Convert the internal JSON-Schema-shaped parameters to the dsh-tools author
 * DSL: a per-property spec map with inline `required` flags.
 * @param {{properties?: object, required?: string[]}} schema
 * @returns {object}
 */
export function toDshParameters(schema) {
  if (!isObject(schema)) throw new TypeError('toDshParameters requires a schema object')
  return toDslProperties(schema.properties ?? {}, schema.required ?? [])
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

function sessionFailure(error, { sessionId, agentId } = {}) {
  return {
    ok: false,
    result: sessionErrorText(error),
    ...(error?.code === undefined ? {} : { code: error.code }),
    denied: true,
    ...(sessionId === undefined || sessionId === null ? {} : { sessionId }),
    ...(agentId === undefined ? {} : { agentId }),
  }
}

function leaseBusy(status, requester) {
  const owner = status?.agentId ?? 'another agent'
  return sessionFailure(
    Object.assign(new Error(`session ${status?.sessionId ?? 'unknown'} is held by ${owner}`), {
      code: 'busy',
    }),
    { sessionId: status?.sessionId, agentId: requester },
  )
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
  const requester = resolveAgentId(exec)
  const status = await deps.sessions.status()
  let sessionId = status?.sessionId
  let agentId = status?.agentId ?? requester

  // A live lease belongs to its holder; another agent must not renew or use it.
  if (status?.active === true && status.agentId !== undefined && status.agentId !== requester) {
    return leaseBusy(status, requester)
  }

  if (status?.active !== true) {
    try {
      const begun = await deps.sessions.begin(requester)
      sessionId = begun.sessionId
      agentId = begun.agentId ?? agentId
    } catch (error) {
      return sessionFailure(error, { sessionId, agentId: requester })
    }
  }

  try {
    const renewed = await deps.sessions.renew(sessionId)
    return { session: { sessionId, agentId: renewed?.agentId ?? agentId } }
  } catch (error) {
    return sessionFailure(error, { sessionId, agentId: requester })
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

  function deny(call) {
    calls.push(call)
    lastDenial = call.denial
    return call.denial.reason
  }

  async function authorize({ action, target, index }) {
    const op = action?.op
    let decision
    try {
      decision = await deps.policy.authorize({ action, session, target })
    } catch (error) {
      return deny({
        index,
        op,
        target,
        decision: 'denied',
        denial: { by: 'policy', reason: errorReason(error), thrown: true },
      })
    }

    const risk = decision?.risk
    if (decision?.allowed !== true) {
      return deny({
        index,
        op,
        target,
        risk,
        decision: 'denied',
        denial: { by: 'policy', reason: decision?.reason ?? 'approval-denied', risk },
      })
    }

    let control
    try {
      control = await deps.control.assertAgentAllowed()
    } catch (error) {
      return deny({
        index,
        op,
        target,
        risk,
        decision: 'denied',
        denial: { by: 'control', reason: errorReason(error), thrown: true },
      })
    }

    if (control?.allowed !== true) {
      const controlName = control?.control ?? 'unknown'
      const waitSeconds = control?.waitSeconds ?? 0
      return deny({
        index,
        op,
        target,
        risk,
        decision: 'denied',
        denial: {
          by: 'control',
          reason: `control ${controlName}${waitSeconds > 0 ? `; retry in ${waitSeconds}s` : ''}`,
          control: controlName,
          waitSeconds,
        },
      })
    }

    calls.push({ index, op, target, risk, decision: 'allowed' })
    return null
  }

  return {
    authorize,
    calls,
    get lastCall() {
      return calls.at(-1)
    },
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

function actionOf(step, observation) {
  return {
    op: step.op,
    target: step.target,
    text: step.text,
    delivery: step.delivery,
    observation,
    app: observation?.title,
    pid: observation?.pid,
    observed:
      isObject(observation) &&
      isFiniteNumber(observation.pid) &&
      isFiniteNumber(observation.windowId),
  }
}

async function auditActFailure(deps, args, exec, failure, observation, started) {
  await recordAudit(deps, {
    sessionId: failure.sessionId,
    agentId: resolveAgentId(exec),
    action: typeof args.op === 'string' ? args.op : 'act',
    target: args.target,
    risk: 'high',
    decision: 'denied',
    effect: 'refused',
    durationMs: Date.now() - started,
    observationRevision: observation.revision,
  })
}

async function actBatch(deps, args, observation, session, gate) {
  if (args.steps.length === 0) throw new TypeError('act steps must be a non-empty array')
  const steps = args.steps.map((step) => (isObject(step) ? actFields(step) : step))
  const stopOnError = args.stopOnError ?? true
  const results = []
  let worst = 'confirmed'
  let failedAt

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const stepStarted = Date.now()
    let call
    let result

    if (!isObject(step)) {
      call = { index, risk: 'high', decision: 'refused' }
      result = {
        effect: 'refused',
        detail: `action: refused (Invalid step ${index}: expected an object)`,
      }
    } else {
      const denial = await gate.authorize({
        action: actionOf(step, observation),
        target: step.target,
        index,
      })
      call = gate.lastCall

      if (denial === null) {
        try {
          // Dispatch already authorized this step; execute must not gate it twice.
          const raw = await execute(deps.backend, {
            ...step,
            observation,
            glide: deps.glide,
            authorize: async () => null,
          })
          result = {
            effect: raw.effect,
            detail: raw.detail,
            ...(raw.advice === undefined ? {} : { advice: raw.advice }),
          }
        } catch (error) {
          result = {
            effect: 'refused',
            detail: `${buildActionSummary(step.op ?? 'action', step.target)}: refused (${errorReason(error)})`,
          }
        }
      } else {
        result = {
          effect: 'refused',
          detail: `${buildActionSummary(step.op ?? 'action', step.target)}: refused (${denial})`,
        }
      }
    }

    const entry = markUnverifiable({
      index,
      effect: result.effect,
      detail: result.detail,
      ...(result.advice === undefined ? {} : { advice: result.advice }),
    })
    results.push(entry)

    await auditEntry(deps, session, observation, step, call, entry, Date.now() - stepStarted)
    noteAction(deps, entry)

    if (EFFECT_RANK[entry.effect] > EFFECT_RANK[worst]) worst = entry.effect
    if (stopOnError && entry.effect === 'refused') {
      failedAt = index
      break
    }
  }

  const denied = gate.calls.find((call) => call.decision === 'denied')
  return {
    ok: denied === undefined,
    result: {
      effect: worst,
      results,
      ...(failedAt === undefined ? {} : { failedAt }),
      summary: results.map((entry) => entry.detail).join('\n'),
      ...(denied === undefined ? {} : { denied: denied.denial }),
    },
  }
}

async function act(deps, args, exec) {
  const observation = currentObservation(deps, args)
  const started = Date.now()
  const ensured = await ensureSession(deps, exec)
  if (ensured.session === undefined || ensured.ok === false) {
    await auditActFailure(deps, args, exec, ensured, observation, started)
    return ensured
  }

  const session = ensured.session
  const gate = createGate(deps, session)

  if (Array.isArray(args.steps)) {
    return actBatch(deps, args, observation, session, gate)
  }

  if (typeof args.op !== 'string') throw new Error('act requires op or steps')
  const step = actFields(args)
  const denial = await gate.authorize({ action: actionOf(step, observation), target: step.target })
  let result
  if (denial === null) {
    result = markUnverifiable(
      await execute(deps.backend, {
        ...step,
        observation,
        glide: deps.glide,
        authorize: async () => null,
      }),
    )
  } else {
    result = {
      effect: 'refused',
      detail: `${buildActionSummary(step.op, step.target)}: refused (${denial})`,
    }
  }

  await auditEntry(
    deps,
    session,
    observation,
    step,
    gate.lastCall ?? gate.calls[0],
    result,
    Date.now() - started,
  )
  noteAction(deps, result)

  return {
    ok: denial === null,
    result: {
      ...result,
      summary: result.detail,
      ...(denial === null ? {} : { denied: gate.lastDenial }),
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
  const text = observationText(observation, args)

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

  lastObservations.set(deps, observation)
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
        const requester = resolveAgentId(exec)
        if (typeof status?.agentId === 'string' && status.agentId !== requester) {
          return leaseBusy(status, requester)
        }
        const sessionId = args.sessionId ?? status?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { ok: false, result: `session ${args.op} requires a sessionId`, denied: true }
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
    parameters: toDshParameters(PARAMETERS),
    execute(args, exec) {
      return dispatch(deps, args, exec)
    },
  }
}
