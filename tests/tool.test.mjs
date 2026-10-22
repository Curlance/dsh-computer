import test from 'node:test'
import assert from 'node:assert/strict'

import { buildComputerTool, dispatch } from '../lib/tool.js'

const OBSERVATION = () => ({
  revision: 4,
  pid: 100,
  windowId: 200,
  title: 'Editor',
  bounds: { x: 0, y: 0, width: 1000, height: 800 },
  space: { width: 1000, height: 800, scaleX: 1, scaleY: 1 },
  tree: [
    {
      id: 'save',
      role: 'Button',
      label: 'Save',
      frame: { x: 10, y: 10, w: 20, h: 20 },
      actions: ['invoke'],
    },
    {
      id: 'name',
      role: 'Edit',
      label: 'Name',
      frame: { x: 10, y: 40, w: 100, h: 20 },
      actions: ['set_value'],
      value: 'old',
    },
  ],
  truncated: false,
  at: 1000,
  screenshotPng: Buffer.from('fake-png'),
})

function fixture({
  policyDecision,
  policyImplementation,
  controlDecision,
  controlStatus,
  clickResult,
  typeResult,
  beginError,
  observation = OBSERVATION(),
} = {}) {
  const log = []
  const auditEvents = []
  const policyCalls = []
  const persistCalls = []
  const backendCalls = []

  const sessions = {
    current: null,
    beginCalls: [],
    renewCalls: [],
    endCalls: [],
    takeoverCalls: [],
    resumeCalls: [],
    beginError,
    begin(agentId) {
      log.push('session.begin')
      sessions.beginCalls.push(agentId)
      if (sessions.beginError) throw sessions.beginError
      sessions.current = { sessionId: 'session-1', agentId }
      return { ...sessions.current }
    },
    renew(sessionId) {
      log.push('session.renew')
      sessions.renewCalls.push(sessionId)
      return {
        sessionId,
        agentId: sessions.current?.agentId ?? 'agent',
        expiresAt: 0,
        remainingMs: 60000,
        takeover: null,
      }
    },
    end(sessionId) {
      log.push('session.end')
      sessions.endCalls.push(sessionId)
      sessions.current = null
      return { ended: true }
    },
    takeover(sessionId, note) {
      log.push('session.takeover')
      sessions.takeoverCalls.push([sessionId, note])
      return { sessionId, takeover: { at: 1, note: note ?? null } }
    },
    resume(sessionId) {
      log.push('session.resume')
      sessions.resumeCalls.push(sessionId)
      return { sessionId, takeover: null }
    },
    status() {
      if (sessions.current === null) {
        return {
          active: false,
          state: 'idle',
          sessionId: null,
          agentId: null,
          expiresAt: null,
          remainingMs: 0,
          takeover: null,
        }
      }
      return {
        active: true,
        state: 'active',
        ...sessions.current,
        expiresAt: 0,
        remainingMs: 60000,
        takeover: null,
      }
    },
  }

  const policy = {
    async authorize(input) {
      log.push('policy')
      policyCalls.push(input)
      if (typeof policyImplementation === 'function') return policyImplementation(input)
      return policyDecision ?? { allowed: true, reason: 'allowed', risk: 'low' }
    },
  }

  const control = {
    calls: 0,
    async status() {
      log.push('control.status')
      return controlStatus ?? { control: 'ready', lastInputAgeMs: 5000, waitSeconds: 0 }
    },
    async assertAgentAllowed() {
      log.push('control.assert')
      control.calls += 1
      return controlDecision ?? { allowed: true, control: 'ready', waitSeconds: 0 }
    },
    noteAgentAction() {
      log.push('note')
    },
  }

  const audit = {
    events: auditEvents,
    async record(event) {
      log.push('audit')
      auditEvents.push(event)
    },
    async flush() {},
  }

  const observer = {
    calls: [],
    async observe(target, options = {}) {
      observer.calls.push({ target, options })
      if (options.waitFor !== undefined) {
        return { ...observation, waitFor: { matched: true, elapsedMs: 12 } }
      }
      return observation
    },
    get(revision) {
      if (revision !== observation.revision) {
        throw new Error(`Unknown observation revision: ${revision}`)
      }
      return observation
    },
  }

  const backend = {
    calls: backendCalls,
    async click(args) {
      log.push('backend.click')
      backendCalls.push({ op: 'click', args })
      return clickResult ?? { text: 'clicked' }
    },
    async typeText(args) {
      log.push('backend.typeText')
      backendCalls.push({ op: 'type', args })
      return typeResult ?? { text: 'typed' }
    },
  }

  const persistImage = async (observed) => {
    log.push('persistImage')
    persistCalls.push(observed)
    return {
      image: {
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: observed.screenshotPng.length,
        width: observed.space.width,
        height: observed.space.height,
        name: 'screen.png',
      },
    }
  }

  return {
    deps: { backend, observer, policy, sessions, control, audit, persistImage, config: {} },
    log,
    auditEvents,
    policyCalls,
    persistCalls,
    backendCalls,
    observer,
    sessions,
    control,
    audit,
    backend,
  }
}

const OBSERVE_ARGS = {
  action: 'observe',
  target: { kind: 'active' },
  mode: 'both',
}

test('buildComputerTool exposes the unified schema for observe, act and session', () => {
  const f = fixture()
  const tool = buildComputerTool(f.deps)

  assert.equal(tool.name, 'computer')
  assert.equal(typeof tool.description, 'string')
  assert.match(tool.description, /observe/i)
  assert.match(tool.description, /coordinate/i)
  assert.equal(typeof tool.execute, 'function')

  const parameters = tool.parameters
  assert.equal(parameters.type, 'object')
  assert.deepEqual(parameters.required, ['action'])
  assert.deepEqual(parameters.properties.action.enum, ['observe', 'act', 'session'])

  const waitFor = parameters.properties.waitFor
  assert.equal(waitFor.type, 'object')
  assert.deepEqual(waitFor.properties.condition.enum, [
    'text_exists',
    'active_window',
    'element_exists',
    'element_enabled',
    'focused_element',
  ])
  assert.equal(waitFor.properties.timeoutMs.type, 'integer')

  assert.equal(parameters.properties.mode.enum.includes('both'), true)
  assert.equal(parameters.properties.maxElements.type, 'integer')
  assert.equal(parameters.properties.includeScreenshot.type, 'boolean')

  const actOps = parameters.properties.op.enum
  for (const op of ['click', 'type', 'key', 'scroll', 'wait', 'launch', 'kill']) {
    assert.equal(actOps.includes(op), true, `missing act op ${op}`)
  }
  for (const op of ['status', 'begin', 'end', 'takeover', 'resume']) {
    assert.equal(actOps.includes(op), true, `missing session op ${op}`)
  }

  const steps = parameters.properties.steps
  assert.equal(steps.type, 'array')
  assert.equal(steps.items.type, 'object')
  assert.deepEqual(steps.items.required, ['op'])
  assert.equal(steps.items.properties.op.enum.includes('click'), true)
  assert.equal(steps.items.properties.op.enum.includes('status'), false)
  assert.equal(parameters.properties.delivery.enum.includes('foreground'), true)
})

test('tool.execute delegates to dispatch', async () => {
  const f = fixture()
  const tool = buildComputerTool(f.deps)
  const out = await tool.execute({ action: 'session', op: 'status' }, { agentId: 'agent-1' })
  assert.equal(out.ok, true)
  assert.equal(out.result.control, 'ready')
})

test('observe renders the tree, persists the screenshot and audits the result', async () => {
  const f = fixture()
  const out = await dispatch(f.deps, OBSERVE_ARGS, { agentId: 'agent-1' })

  assert.equal(out.ok, true)
  assert.match(out.result, /revision=4/)
  assert.match(out.result, /\[save\] Button/)
  assert.match(out.result, /space=1000x800/)
  assert.deepEqual(out.image, {
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 8,
    width: 1000,
    height: 800,
    name: 'screen.png',
  })
  assert.equal(f.persistCalls.length, 1)
  assert.equal(f.persistCalls[0].revision, 4)
  assert.equal(f.observer.calls[0].target.kind, 'active')
  assert.equal(f.observer.calls[0].options.mode, 'both')
  assert.equal(f.auditEvents.length, 1)
  assert.equal(f.auditEvents[0].action, 'observe')
  assert.equal(f.auditEvents[0].decision, 'allowed')
  assert.equal(f.auditEvents[0].effect, 'confirmed')
  assert.equal(f.auditEvents[0].observationRevision, 4)
})

test('observe returns waitFor evidence when the condition matches', async () => {
  const f = fixture()
  const out = await dispatch(f.deps, {
    action: 'observe',
    mode: 'tree',
    includeScreenshot: false,
    waitFor: { condition: 'text_exists', text: '完成', timeoutMs: 1000, intervalMs: 100 },
  })

  assert.equal(out.ok, true)
  assert.match(out.result, /waitFor text_exists "完成": matched=true elapsedMs=12/)
  assert.equal(f.auditEvents[0].effect, 'confirmed')
  assert.equal(f.observer.calls[0].options.waitFor.condition, 'text_exists')
})

test('a missed waitFor is flagged and audited as unverifiable', async () => {
  const f = fixture()
  f.observer.observe = async () => ({
    ...OBSERVATION(),
    waitFor: { matched: false, elapsedMs: 30 },
  })

  const out = await dispatch(f.deps, {
    action: 'observe',
    mode: 'tree',
    waitFor: { condition: 'text_exists', text: '完成' },
  })

  assert.equal(out.ok, true)
  assert.match(out.result, /⚠️ waitFor text_exists "完成": matched=false elapsedMs=30/)
  assert.equal(f.auditEvents[0].effect, 'unverifiable')
})

test('act order is policy -> control -> execute -> audit, with observed:true', async () => {
  const f = fixture()
  await dispatch(f.deps, OBSERVE_ARGS, { agentId: 'agent-1' })
  f.log.length = 0
  f.auditEvents.length = 0

  const out = await dispatch(
    f.deps,
    { action: 'act', op: 'click', target: { element: 'save' }, delivery: 'background' },
    { agentId: 'agent-1' },
  )

  assert.equal(out.ok, true)
  assert.equal(out.result.effect, 'confirmed')
  assert.match(out.result.detail, /confirmed/)
  assert.equal(f.backendCalls.length, 1)
  assert.equal(f.backendCalls[0].op, 'click')

  const policyAt = f.log.indexOf('policy')
  const controlAt = f.log.indexOf('control.assert')
  const executeAt = f.log.indexOf('backend.click')
  const auditAt = f.log.indexOf('audit')
  assert.ok(policyAt >= 0, 'policy was not consulted')
  assert.ok(policyAt < controlAt, 'control must run after policy')
  assert.ok(controlAt < executeAt, 'execute must run after control')
  assert.ok(executeAt < auditAt, 'audit must run after execute')
  assert.ok(f.log.includes('note'), 'noteAgentAction was not called')

  assert.deepEqual(f.sessions.beginCalls, ['agent-1'])
  assert.deepEqual(f.sessions.renewCalls, ['session-1'])

  const authorized = f.policyCalls[0]
  assert.equal(authorized.action.op, 'click')
  assert.equal(authorized.action.observed, true)
  assert.equal(authorized.action.delivery, 'background')
  assert.deepEqual(authorized.target, { element: 'save' })
  assert.equal(authorized.session.sessionId, 'session-1')

  assert.equal(f.auditEvents.length, 1)
  assert.equal(f.auditEvents[0].action, 'click')
  assert.deepEqual(f.auditEvents[0].target, { element: 'save' })
  assert.equal(f.auditEvents[0].sessionId, 'session-1')
  assert.equal(f.auditEvents[0].agentId, 'agent-1')
  assert.equal(f.auditEvents[0].decision, 'allowed')
  assert.equal(f.auditEvents[0].effect, 'confirmed')
  assert.equal(f.auditEvents[0].observationRevision, 4)
  assert.equal(typeof f.auditEvents[0].durationMs, 'number')
})

test('control=user refuses the action before the backend runs', async () => {
  const f = fixture({
    controlDecision: { allowed: false, control: 'user', waitSeconds: 2.5, reason: 'user-active' },
  })
  await dispatch(f.deps, OBSERVE_ARGS, { agentId: 'agent-1' })
  f.log.length = 0
  f.auditEvents.length = 0

  const out = await dispatch(
    f.deps,
    { action: 'act', op: 'click', target: { element: 'save' } },
    { agentId: 'agent-1' },
  )

  assert.equal(out.ok, false)
  assert.match(out.result.detail, /control user/)
  assert.equal(out.result.denied.by, 'control')
  assert.equal(out.result.denied.control, 'user')
  assert.equal(out.result.denied.waitSeconds, 2.5)
  assert.equal(f.backendCalls.length, 0)
  assert.equal(f.auditEvents.length, 1)
  assert.equal(f.auditEvents[0].decision, 'denied')
  assert.equal(f.auditEvents[0].effect, 'refused')
})

test('policy denial refuses the action before control or the backend run', async () => {
  const f = fixture({
    policyDecision: { allowed: false, reason: 'approval-denied', risk: 'high' },
  })
  await dispatch(f.deps, OBSERVE_ARGS, { agentId: 'agent-1' })
  f.log.length = 0
  f.auditEvents.length = 0

  const out = await dispatch(
    f.deps,
    { action: 'act', op: 'kill', target: { pid: 100 } },
    { agentId: 'agent-1' },
  )

  assert.equal(out.ok, false)
  assert.match(out.result.detail, /approval-denied/)
  assert.equal(out.result.denied.by, 'policy')
  assert.equal(out.result.denied.reason, 'approval-denied')
  assert.equal(out.result.denied.risk, 'high')
  assert.ok(!f.log.includes('control.assert'), 'control must not run after a policy denial')
  assert.equal(f.backendCalls.length, 0)
  assert.equal(f.auditEvents[0].decision, 'denied')
  assert.equal(f.auditEvents[0].risk, 'high')
})

test('batch steps run in order and each step is authorized and audited', async () => {
  const f = fixture()
  await dispatch(f.deps, OBSERVE_ARGS, { agentId: 'agent-1' })
  f.log.length = 0
  f.auditEvents.length = 0

  const out = await dispatch(
    f.deps,
    {
      action: 'act',
      steps: [
        { op: 'click', target: { element: 'save' } },
        { op: 'type', target: { element: 'name' }, text: 'secret-password' },
      ],
    },
    { agentId: 'agent-1' },
  )

  assert.equal(out.ok, true)
  assert.equal(out.result.effect, 'confirmed')
  assert.equal(out.result.results.length, 2)
  assert.deepEqual(
    out.result.results.map((entry) => entry.effect),
    ['confirmed', 'confirmed'],
  )
  assert.equal(f.policyCalls.length, 2)
  assert.equal(f.control.calls, 2)
  assert.deepEqual(
    f.backendCalls.map((entry) => entry.op),
    ['click', 'type'],
  )
  assert.equal(f.auditEvents.length, 2)
  assert.equal(f.auditEvents[0].action, 'click')
  assert.equal(f.auditEvents[1].action, 'type')
  assert.equal(f.auditEvents[0].decision, 'allowed')
  assert.equal(f.auditEvents[1].decision, 'allowed')

  const typed = f.auditEvents[1]
  assert.equal(typed.inputSummary.length, 'secret-password'.length)
  assert.match(typed.inputSummary.sha256Prefix, /^[a-f0-9]{16}$/)
  assert.equal(JSON.stringify(typed).includes('secret-password'), false)
})

test('act without a current observation fails before touching any dependency', async () => {
  const f = fixture()
  await assert.rejects(
    dispatch(f.deps, { action: 'act', op: 'click', target: { element: 'save' } }, { agentId: 'a' }),
    /current observation/,
  )
  assert.equal(f.backendCalls.length, 0)
  assert.equal(f.policyCalls.length, 0)
})

test('act with an explicit revision uses observer.get and rejects stale revisions', async () => {
  const f = fixture()
  const ok = await dispatch(
    f.deps,
    { action: 'act', revision: 4, op: 'click', target: { element: 'save' } },
    { agentId: 'a' },
  )
  assert.equal(ok.ok, true)

  await assert.rejects(
    dispatch(
      f.deps,
      { action: 'act', revision: 99, op: 'click', target: { element: 'save' } },
      { agentId: 'a' },
    ),
    /Unknown observation revision: 99/,
  )
})

test('unverifiable effects are never presented as success text', async () => {
  const f = fixture({ clickResult: { structured: { clicked: true } } })
  await dispatch(f.deps, OBSERVE_ARGS, { agentId: 'agent-1' })

  const out = await dispatch(
    f.deps,
    { action: 'act', op: 'click', target: { element: 'save' } },
    { agentId: 'agent-1' },
  )

  assert.equal(out.ok, true)
  assert.equal(out.result.effect, 'unverifiable')
  assert.match(out.result.detail, /^⚠️ /)
  assert.match(out.result.summary, /^⚠️ /)
  assert.equal(f.auditEvents.at(-1).effect, 'unverifiable')
})

test('session status merges lease and control state', async () => {
  const f = fixture()
  f.sessions.current = { sessionId: 'session-9', agentId: 'agent-7' }

  const out = await dispatch(f.deps, { action: 'session', op: 'status' }, { agentId: 'agent-7' })

  assert.equal(out.ok, true)
  assert.equal(out.result.sessionId, 'session-9')
  assert.equal(out.result.agentId, 'agent-7')
  assert.equal(out.result.state, 'active')
  assert.equal(out.result.control, 'ready')
  assert.equal(out.result.waitSeconds, 0)
  assert.equal(out.result.lastInputAgeMs, 5000)
})

test('session begin returns the new lease', async () => {
  const f = fixture()
  const out = await dispatch(f.deps, { action: 'session', op: 'begin' }, { agentId: 'agent-1' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.result, { sessionId: 'session-1', agentId: 'agent-1' })
})

test('session begin busy is reported as a failed dispatch, not an exception', async () => {
  const f = fixture()
  f.sessions.beginError = Object.assign(new Error('session-1 holds the lease'), { code: 'busy' })

  const out = await dispatch(f.deps, { action: 'session', op: 'begin' }, { agentId: 'agent-1' })

  assert.equal(out.ok, false)
  assert.match(String(out.result), /busy/)
  assert.equal(out.code, 'busy')
})

test('session end, takeover and resume reach the lease manager', async () => {
  const f = fixture()
  await dispatch(f.deps, { action: 'session', op: 'begin' }, { agentId: 'agent-1' })

  const takeover = await dispatch(
    f.deps,
    { action: 'session', op: 'takeover', note: 'user typing' },
    { agentId: 'agent-1' },
  )
  assert.equal(takeover.ok, true)
  assert.deepEqual(f.sessions.takeoverCalls, [['session-1', 'user typing']])

  const resume = await dispatch(f.deps, { action: 'session', op: 'resume' }, { agentId: 'agent-1' })
  assert.equal(resume.ok, true)
  assert.deepEqual(f.sessions.resumeCalls, ['session-1'])

  const end = await dispatch(f.deps, { action: 'session', op: 'end' }, { agentId: 'agent-1' })
  assert.equal(end.ok, true)
  assert.deepEqual(f.sessions.endCalls, ['session-1'])
})

test('unknown actions and unknown session ops throw readable errors', async () => {
  const f = fixture()
  await assert.rejects(dispatch(f.deps, { action: 'teleport' }), /Unknown computer action: teleport/)
  await assert.rejects(
    dispatch(f.deps, { action: 'session', op: 'teleport' }),
    /Unknown session op: teleport/,
  )
})
