import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MissingTarget,
  buildActionSummary,
  classifyEffect,
  execute,
  executeBatch,
} from '../lib/act.js'
import { createPolicy } from '../lib/policy.js'

const PID = 100
const WINDOW_ID = 200

const stateElements = () => [
  {
    element_token: 'window',
    role: 'Window',
    label: 'Editor',
    frame: { x: 0, y: 0, w: 2880, h: 1800 },
    actions: [],
  },
  {
    element_token: 'save',
    role: 'Button',
    label: 'Save',
    frame: { x: 282, y: 644, w: 72, h: 38 },
    actions: ['invoke'],
  },
  {
    element_token: 'name',
    role: 'Edit',
    label: 'Name',
    frame: { x: 282, y: 700, w: 200, h: 40 },
    actions: ['set_value'],
    value: 'hello',
  },
  {
    element_token: 'password',
    role: 'PasswordBox',
    label: 'Password',
    frame: { x: 500, y: 700, w: 200, h: 40 },
    actions: ['set_value'],
  },
  {
    element_token: 'dialog',
    role: 'Dialog',
    label: 'Confirm',
    frame: { x: 600, y: 500, w: 300, h: 200 },
    actions: [],
  },
]

const observationWith = (elements = stateElements()) => ({
  revision: 7,
  pid: PID,
  windowId: WINDOW_ID,
  title: 'Editor',
  bounds: { x: 0, y: 0, width: 2880, height: 1800 },
  space: { width: 1456, height: 910, scaleX: 0.5056, scaleY: 0.5056 },
  tree: elements.map((element) => ({
    id: element.element_token,
    role: element.role,
    label: element.label,
    frame: { ...element.frame },
    actions: [...element.actions],
    ...(element.value === undefined ? {} : { value: element.value }),
  })),
})

const OBSERVATION = observationWith()

function stateWith(value = 'hello') {
  const elements = stateElements()
  elements.find((element) => element.element_token === 'name').value = value
  return { text: 'state', structured: { elements } }
}

/**
 * Fake backend with the Task 9 surface. Methods record `{method, args}` and
 * return a plain success string unless `results` overrides them.
 */
function createFakeBackend({ results = {}, state = stateWith() } = {}) {
  const calls = []
  const backend = { calls }
  for (const method of [
    'click',
    'typeText',
    'pressKey',
    'hotkey',
    'scroll',
    'drag',
    'moveCursor',
    'launchApp',
    'bringToFront',
    'setWindowFrame',
    'killApp',
    'getWindowState',
  ]) {
    backend[method] = async (args) => {
      calls.push({ method, args })
      if (Object.hasOwn(results, method)) {
        const value = results[method]
        return typeof value === 'function' ? value(args) : value
      }
      return method === 'getWindowState' ? state : 'ok'
    }
  }
  return backend
}

const actionCalls = (backend) =>
  backend.calls.filter((call) => call.method !== 'getWindowState')

// --- effect classification -------------------------------------------------

test('classifyEffect lets an explicit backend effect win', () => {
  for (const effect of ['confirmed', 'unverifiable', 'refused', 'noop']) {
    assert.equal(classifyEffect({ effect }), effect)
    assert.equal(classifyEffect({ structured: { effect } }), effect)
  }
})

test('classifyEffect treats a plain backend string as confirmed', () => {
  assert.equal(classifyEffect('ok'), 'confirmed')
  assert.equal(classifyEffect('clicked'), 'confirmed')
  assert.equal(classifyEffect({ text: 'clicked' }), 'confirmed')
})

test('classifyEffect maps failures to refused', () => {
  assert.equal(classifyEffect({ ok: false }), 'refused')
  assert.equal(classifyEffect({ success: false }), 'refused')
  assert.equal(classifyEffect({ refused: true, reason: 'password-field' }), 'refused')
  assert.equal(classifyEffect({ error: { message: 'no such element' } }), 'refused')
  assert.equal(classifyEffect(new Error('driver exploded')), 'refused')
})

test('classifyEffect keeps missing evidence unverifiable and never promotes it', () => {
  for (const raw of [null, undefined, {}, { ok: true }, { effect: 'something-else' }, 'background_unavailable']) {
    assert.equal(classifyEffect(raw), 'unverifiable')
    assert.notEqual(classifyEffect(raw), 'confirmed')
  }
})

test('classifyEffect treats an ambiguous thrown error as unverifiable', () => {
  const coded = Object.assign(new Error('delivery failed'), { code: 'background_unavailable' })
  assert.equal(classifyEffect(coded), 'unverifiable')
  assert.equal(classifyEffect(new Error('timeout waiting for the driver')), 'unverifiable')
  assert.equal(classifyEffect(new Error('suspected_noop')), 'unverifiable')
})

test('classifyEffect keeps an ambiguous background failure unverifiable', () => {
  assert.equal(classifyEffect({ ok: false, code: 'background_unavailable' }), 'unverifiable')
  assert.equal(
    classifyEffect({ ok: false, error: { code: 'background_unavailable' } }),
    'unverifiable',
  )
  assert.equal(
    classifyEffect({ structured: { ok: false, code: 'background_unavailable' } }),
    'unverifiable',
  )
})

// --- action summaries ------------------------------------------------------

test('buildActionSummary names the op and its target', () => {
  assert.equal(buildActionSummary('click', { element: 12 }), 'click element 12')
  assert.equal(buildActionSummary('click', { element: 's1:2' }), 'click element s1:2')
  assert.equal(buildActionSummary('click', { x: 640, y: 360 }), 'click at (640, 360)')
  assert.equal(buildActionSummary('launch', { name: 'Notepad' }), 'launch Notepad')
  assert.equal(buildActionSummary('kill', { pid: 42 }), 'kill pid 42')
  assert.equal(buildActionSummary('wait'), 'wait')
})

// --- click -----------------------------------------------------------------

test('click resolves an element frame center through observation space', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
  })

  assert.equal(result.effect, 'confirmed')
  assert.equal(result.detail, 'click element save: confirmed')
  assert.deepEqual(actionCalls(backend)[0], {
    method: 'click',
    args: {
      pid: PID,
      window_id: WINDOW_ID,
      x: 160.77,
      y: 335.18,
      element_token: 'save',
      count: 1,
      button: 'left',
      delivery_mode: 'auto',
    },
  })
  assert.equal(result.verification.observed, true)
})

test('click accepts pixel targets and double/right click map count and button', async () => {
  const backend = createFakeBackend()

  const click = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { x: 640, y: 360 },
  })
  assert.equal(click.effect, 'confirmed')
  assert.deepEqual(actionCalls(backend)[0].args, {
    pid: PID,
    window_id: WINDOW_ID,
    x: 640,
    y: 360,
    count: 1,
    button: 'left',
    delivery_mode: 'auto',
  })

  await execute(backend, {
    observation: OBSERVATION,
    op: 'doubleClick',
    target: { element: 'save' },
  })
  assert.equal(actionCalls(backend)[1].args.count, 2)
  assert.equal(actionCalls(backend)[1].args.button, 'left')

  await execute(backend, {
    observation: OBSERVATION,
    op: 'rightClick',
    target: { x: 10, y: 20 },
  })
  assert.equal(actionCalls(backend)[2].args.count, 1)
  assert.equal(actionCalls(backend)[2].args.button, 'right')
  assert.equal('element_token' in actionCalls(backend)[2].args, false)
})

test('click without an element or point throws MissingTarget before the backend', async () => {
  const backend = createFakeBackend()

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'click' }),
    (error) => {
      assert.ok(error instanceof MissingTarget)
      assert.equal(error.name, 'MissingTarget')
      assert.match(error.message, /click/)
      assert.match(error.message, /target/)
      return true
    },
  )
  assert.equal(backend.calls.length, 0)
})

test('an unknown element is a readable error and never calls the backend', async () => {
  const backend = createFakeBackend()

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'click', target: { element: 'nope' } }),
    /Unknown element nope/,
  )
  assert.equal(backend.calls.length, 0)
})

test('password fields and dialogs are refused without a backend call', async () => {
  const backend = createFakeBackend()

  const password = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'password' },
  })
  assert.equal(password.effect, 'refused')
  assert.match(password.detail, /password/)

  const dialog = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'dialog' },
  })
  assert.equal(dialog.effect, 'refused')
  assert.match(dialog.detail, /dialog/)

  const typed = await execute(backend, {
    observation: OBSERVATION,
    op: 'type',
    target: { element: 'password' },
    text: 'secret',
  })
  assert.equal(typed.effect, 'refused')
  assert.match(typed.detail, /password/)

  assert.equal(backend.calls.length, 0)
})

// --- type / key ------------------------------------------------------------

test('type sends pid, element token, text and delivery mode, then verifies readback', async () => {
  const backend = createFakeBackend({ state: stateWith('hello world') })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'type',
    target: { element: 'name' },
    text: 'hello world',
    delivery: 'background',
  })

  assert.equal(result.effect, 'confirmed')
  assert.equal(result.detail, 'type element name: confirmed')
  assert.deepEqual(backend.calls[0], {
    method: 'typeText',
    args: {
      pid: PID,
      window_id: WINDOW_ID,
      element_token: 'name',
      text: 'hello world',
      delivery_mode: 'background',
    },
  })
  assert.deepEqual(backend.calls[1], {
    method: 'getWindowState',
    args: { pid: PID, windowId: WINDOW_ID, treeFormat: 'elements' },
  })
  assert.deepEqual(result.verification, { observed: true, changed: true, updated: 1 })
})

test('type without an element targets the observed foreground window', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'type',
    text: 'hi',
    delivery: 'foreground',
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(actionCalls(backend)[0].args, {
    pid: PID,
    window_id: WINDOW_ID,
    text: 'hi',
    delivery_mode: 'foreground',
  })
})

test('type requires text and an element or an observed foreground window', async () => {
  const backend = createFakeBackend()

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'type', target: { element: 'name' } }),
    /text/,
  )
  await assert.rejects(
    execute(backend, { op: 'type', text: 'hi' }),
    (error) => error instanceof MissingTarget,
  )
  assert.equal(backend.calls.length, 0)
})

test('key presses one key and routes key arrays through hotkey', async () => {
  const backend = createFakeBackend()

  const single = await execute(backend, {
    observation: OBSERVATION,
    op: 'key',
    keys: 'return',
  })
  assert.equal(single.effect, 'confirmed')
  assert.deepEqual(backend.calls[0], {
    method: 'pressKey',
    args: { key: 'return', delivery_mode: 'auto' },
  })

  await execute(backend, { observation: OBSERVATION, op: 'key', keys: ['ctrl', 'c'] })
  assert.deepEqual(backend.calls[1], {
    method: 'hotkey',
    args: { keys: ['ctrl', 'c'], delivery_mode: 'auto' },
  })
})

test('key requires keys and a foreground target', async () => {
  const backend = createFakeBackend()

  await assert.rejects(execute(backend, { observation: OBSERVATION, op: 'key' }), /keys/)
  await assert.rejects(
    execute(backend, { op: 'key', keys: 'return' }),
    (error) => error instanceof MissingTarget,
  )
  assert.equal(backend.calls.length, 0)
})

// --- scroll / drag / move / wait ------------------------------------------

test('scroll maps direction, amount, delivery and optional element token', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'scroll',
    target: { element: 'name' },
    direction: 'down',
    amount: 3,
    delivery: 'background',
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(backend.calls[0], {
    method: 'scroll',
    args: {
      pid: PID,
      window_id: WINDOW_ID,
      element_token: 'name',
      direction: 'down',
      amount: 3,
      delivery_mode: 'background',
    },
  })
})

test('scroll rejects an invalid direction before the backend', async () => {
  const backend = createFakeBackend()

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'scroll', direction: 'sideways' }),
    /direction/,
  )
  assert.equal(backend.calls.length, 0)
})

test('scroll defaults to three notches and auto delivery', async () => {
  const backend = createFakeBackend()

  await execute(backend, { observation: OBSERVATION, op: 'scroll', direction: 'up' })

  assert.equal(backend.calls[0].args.amount, 3)
  assert.equal(backend.calls[0].args.delivery_mode, 'auto')
  assert.equal('element_token' in backend.calls[0].args, false)
})

test('drag maps from/to points and requires both', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'drag',
    from: { x: 1, y: 2 },
    to: { x: 3, y: 4 },
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(actionCalls(backend)[0], {
    method: 'drag',
    args: {
      pid: PID,
      window_id: WINDOW_ID,
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4,
      delivery_mode: 'auto',
    },
  })

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'drag', to: { x: 3, y: 4 } }),
    /from/,
  )
})

test('move resolves a pixel target without a readback', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'move',
    target: { x: 10, y: 20 },
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(backend.calls, [
    {
      method: 'moveCursor',
      args: {
        x: 10,
        y: 20,
        target: { kind: 'window', pid: PID, window_id: WINDOW_ID },
        delivery_mode: 'auto',
      },
    },
  ])
  assert.equal('verification' in result, false)
})

test('move resolves an element frame center', async () => {
  const backend = createFakeBackend()

  await execute(backend, { observation: OBSERVATION, op: 'move', target: { element: 'save' } })

  assert.deepEqual(backend.calls[0].args, {
    x: 160.77,
    y: 335.18,
    target: { kind: 'window', pid: PID, window_id: WINDOW_ID },
    delivery_mode: 'auto',
  })
})

test('click, key, drag and move forward the delivery mode', async () => {
  const backend = createFakeBackend()

  await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    delivery: 'background',
    observeAfter: false,
  })
  await execute(backend, {
    observation: OBSERVATION,
    op: 'key',
    keys: 'return',
    delivery: 'foreground',
  })
  await execute(backend, {
    observation: OBSERVATION,
    op: 'drag',
    from: { x: 1, y: 2 },
    to: { x: 3, y: 4 },
    delivery: 'background',
  })
  await execute(backend, {
    observation: OBSERVATION,
    op: 'move',
    target: { x: 10, y: 20 },
    delivery: 'foreground',
  })

  assert.deepEqual(
    actionCalls(backend).map((call) => call.args.delivery_mode),
    ['background', 'foreground', 'background', 'foreground'],
  )
})

test('wait sleeps, reports noop, and never calls the backend', async () => {
  const backend = createFakeBackend()
  const sleeps = []

  const result = await execute(backend, {
    op: 'wait',
    amount: 5,
    sleep: async (ms) => sleeps.push(ms),
  })

  assert.equal(result.effect, 'noop')
  assert.equal(result.detail, 'wait: noop')
  assert.deepEqual(sleeps, [5])
  assert.equal(backend.calls.length, 0)
})

// --- launch / focus / resize / kill ---------------------------------------

test('launch passes name, aumid or path through and requires one', async () => {
  const backend = createFakeBackend()

  await execute(backend, { op: 'launch', target: { name: 'Notepad' } })
  assert.deepEqual(backend.calls[0], { method: 'launchApp', args: { name: 'Notepad' } })

  await execute(backend, {
    op: 'launch',
    target: { aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe' },
  })
  assert.deepEqual(backend.calls[1], {
    method: 'launchApp',
    args: { aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe' },
  })

  await execute(backend, { op: 'launch', target: { path: 'C:\\Apps\\notepad.exe' } })
  assert.deepEqual(backend.calls[2], {
    method: 'launchApp',
    args: { path: 'C:\\Apps\\notepad.exe' },
  })

  await assert.rejects(
    execute(backend, { op: 'launch' }),
    (error) => error instanceof MissingTarget,
  )
  await assert.rejects(
    execute(backend, { op: 'launch', target: { name: '   ' } }),
    (error) => error instanceof MissingTarget,
  )
  assert.equal(backend.calls.length, 3)
})

test('focus brings the observed window to the front', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, { observation: OBSERVATION, op: 'focus' })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(backend.calls[0], {
    method: 'bringToFront',
    args: { pid: PID, windowId: WINDOW_ID },
  })
})

test('focus requires an observation with pid and windowId', async () => {
  const backend = createFakeBackend()

  await assert.rejects(
    execute(backend, { op: 'focus' }),
    (error) => error instanceof MissingTarget,
  )
  assert.equal(backend.calls.length, 0)
})

test('resize sets the observed window frame and validates it', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'resize',
    frame: { x: 10, y: 20, width: 800, height: 600 },
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(backend.calls[0], {
    method: 'setWindowFrame',
    args: { pid: PID, windowId: WINDOW_ID, x: 10, y: 20, width: 800, height: 600 },
  })

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'resize' }),
    /frame/,
  )
  await assert.rejects(
    execute(backend, {
      observation: OBSERVATION,
      op: 'resize',
      frame: { x: 10, y: 20, width: 0, height: 600 },
    }),
    /frame/,
  )
})

test('kill uses the target pid or observed pid and requires one', async () => {
  const backend = createFakeBackend()

  const targeted = await execute(backend, { op: 'kill', target: { pid: 42 } })
  assert.equal(targeted.effect, 'confirmed')
  assert.deepEqual(backend.calls[0], { method: 'killApp', args: { pid: 42 } })

  await execute(backend, { observation: OBSERVATION, op: 'kill' })
  assert.deepEqual(backend.calls[1], { method: 'killApp', args: { pid: PID } })

  await assert.rejects(
    execute(backend, { op: 'kill' }),
    (error) => error instanceof MissingTarget,
  )
})

test('a policy denial refuses kill without calling the backend', async () => {
  const backend = createFakeBackend()
  const seen = []
  const policy = {
    authorize: async (request) => {
      seen.push(request)
      return { allowed: false, reason: 'approval-denied', risk: 'high' }
    },
  }

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'kill',
    target: { pid: 42 },
    policy,
  })

  assert.equal(result.effect, 'refused')
  assert.match(result.detail, /approval-denied/)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].action.op, 'kill')
  assert.equal(seen[0].action.observed, true)
  assert.equal(backend.calls.length, 0)
})

test('an injected authorize function can deny any action', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    authorize: async () => ({ allowed: false, reason: 'not now' }),
  })

  assert.equal(result.effect, 'refused')
  assert.match(result.detail, /not now/)
  assert.equal(backend.calls.length, 0)
})

test('policy receives the caller target shape and keeps an element click low risk', async () => {
  const backend = createFakeBackend()
  const seen = []
  let decision
  const policy = createPolicy({
    config: { approvals: { mode: 'ask' } },
    approval: {
      request: async () => {
        throw new Error('approval must not be requested for a low-risk element click')
      },
    },
  })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    authorize: async (request) => {
      seen.push(request)
      decision = await policy.authorize(request)
      return decision
    },
    observeAfter: false,
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(seen[0].target, { element: 'save' })
  assert.equal(seen[0].action.target.element, 'save')
  assert.equal(seen[0].observation, OBSERVATION)
  assert.equal(decision.allowed, true)
  assert.equal(decision.risk, 'low')
  assert.deepEqual(actionCalls(backend).map((call) => call.method), ['click'])
})

// --- backend effects and readback -----------------------------------------

test('a backend throw becomes a refused result, not a thrown action', async () => {
  const backend = createFakeBackend({
    results: {
      click: () => {
        throw new Error('driver refused the click')
      },
    },
  })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
  })

  assert.equal(result.effect, 'refused')
  assert.match(result.detail, /driver refused the click/)
  assert.equal('verification' in result, false)
})

test('background_unavailable is unverifiable and suggests a foreground retry', async () => {
  const backend = createFakeBackend({
    results: { typeText: { ok: false, code: 'background_unavailable' } },
  })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'type',
    target: { element: 'name' },
    text: 'hello',
    delivery: 'background',
  })

  assert.equal(result.effect, 'unverifiable')
  assert.match(result.detail, /foreground/)
  assert.match(result.advice, /foreground/)
  assert.doesNotMatch(result.detail, /confirmed/)
})

test('an ambiguous backend throw is unverifiable with foreground advice', async () => {
  const backend = createFakeBackend({
    results: {
      click: () => {
        throw Object.assign(new Error('delivery failed'), { code: 'background_unavailable' })
      },
    },
  })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    observeAfter: false,
  })

  assert.equal(result.effect, 'unverifiable')
  assert.match(result.detail, /delivery failed/)
  assert.match(result.advice, /foreground/)
})

test('every unverifiable result carries a next-step advice', async () => {
  const backend = createFakeBackend({ results: { click: { ok: true } } })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    observeAfter: false,
  })

  assert.equal(result.effect, 'unverifiable')
  assert.match(result.advice, /screen_observe|重新/)
})

test('readback never upgrades unverifiable to confirmed', async () => {
  const backend = createFakeBackend({
    results: { typeText: { ok: false, code: 'background_unavailable' } },
    state: stateWith('hello world'),
  })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'type',
    target: { element: 'name' },
    text: 'hello world',
    delivery: 'background',
  })

  assert.equal(result.effect, 'unverifiable')
  assert.deepEqual(result.verification, { observed: true, changed: true, updated: 1 })
})

test('observeAfter false skips readback and omits verification', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    observeAfter: false,
  })

  assert.equal(result.effect, 'confirmed')
  assert.equal('verification' in result, false)
  assert.deepEqual(actionCalls(backend).map((call) => call.method), ['click'])
})

test('a failed readback keeps the action effect and reports an unobserved verification', async () => {
  const backend = createFakeBackend({
    results: {
      getWindowState: () => {
        throw new Error('window closed')
      },
    },
  })

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
  })

  assert.equal(result.effect, 'confirmed')
  assert.equal(result.verification.observed, false)
  assert.match(result.verification.error, /window closed/)
})

test('readback normalizes raw backend rows before comparing', async () => {
  const observation = {
    ...OBSERVATION,
    tree: [
      {
        id: 0,
        role: 'Window',
        label: 'Editor',
        frame: { x: 0, y: 0, w: 2880, h: 1800 },
        actions: [],
        focused: true,
      },
      {
        id: 1,
        role: 'Button',
        label: 'Save',
        frame: { x: 282, y: 644, w: 72, h: 38 },
        actions: ['invoke'],
      },
    ],
  }
  const backend = createFakeBackend({
    state: {
      structured: {
        elements: [
          {
            element_index: 0,
            role: 'Window',
            name: 'Editor',
            frame: { x: 0, y: 0, width: 2880, height: 1800 },
            actions: [],
            has_keyboard_focus: true,
          },
          {
            element_index: 1,
            role: 'Button',
            name: 'Save',
            frame: { x: 282, y: 644, width: 72, height: 38 },
            actions: ['invoke'],
          },
        ],
      },
    },
  })

  const result = await execute(backend, {
    observation,
    op: 'click',
    target: { element: 1 },
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(result.verification, { observed: true, changed: false, updated: 0 })
})

test('a pixel click works without observation.tree and skips readback', async () => {
  const backend = createFakeBackend()
  const observation = { ...OBSERVATION }
  delete observation.tree

  const result = await execute(backend, {
    observation,
    op: 'click',
    target: { x: 640, y: 360 },
  })

  assert.equal(result.effect, 'confirmed')
  assert.equal('verification' in result, false)
  assert.deepEqual(actionCalls(backend).map((call) => call.method), ['click'])
})

test('an invalid op is a readable validation error', async () => {
  const backend = createFakeBackend()

  await assert.rejects(
    execute(backend, { observation: OBSERVATION, op: 'hover' }),
    /Invalid action op/,
  )
  assert.equal(backend.calls.length, 0)
})

// --- batch ----------------------------------------------------------------

test('executeBatch runs steps in order and stops on the first refusal', async () => {
  const backend = createFakeBackend({ results: { typeText: { ok: false, error: 'blocked' } } })
  const steps = [
    { op: 'click', target: { element: 'save' } },
    { op: 'type', target: { element: 'name' }, text: 'hello' },
    { op: 'click', target: { element: 'save' } },
  ]

  const batch = await executeBatch(backend, {
    steps,
    observation: OBSERVATION,
    observeAfter: false,
  })

  assert.equal(batch.effect, 'refused')
  assert.equal(batch.failedAt, 1)
  assert.deepEqual(batch.results, [
    { index: 0, effect: 'confirmed', detail: 'click element save: confirmed' },
    { index: 1, effect: 'refused', detail: 'type element name: refused (blocked)' },
  ])
  assert.deepEqual(actionCalls(backend).map((call) => call.method), ['click', 'typeText'])
})

test('executeBatch with stopOnError false continues after a refusal', async () => {
  const backend = createFakeBackend({ results: { typeText: { ok: false, error: 'blocked' } } })
  const steps = [
    { op: 'click', target: { element: 'save' } },
    { op: 'type', target: { element: 'name' }, text: 'hello' },
    { op: 'click', target: { element: 'save' } },
  ]

  const batch = await executeBatch(backend, {
    steps,
    stopOnError: false,
    observation: OBSERVATION,
    observeAfter: false,
  })

  assert.equal(batch.effect, 'refused')
  assert.equal('failedAt' in batch, false)
  assert.deepEqual(batch.results.map((result) => result.index), [0, 1, 2])
  assert.deepEqual(batch.results.map((result) => result.effect), [
    'confirmed',
    'refused',
    'confirmed',
  ])
})

test('executeBatch reports the worst effect across all steps', async () => {
  const backend = createFakeBackend({
    results: { typeText: { ok: false, code: 'background_unavailable' } },
  })

  const batch = await executeBatch(backend, {
    steps: [
      { op: 'click', target: { element: 'save' } },
      { op: 'type', target: { element: 'name' }, text: 'hello' },
      { op: 'wait', amount: 1, sleep: async () => {} },
    ],
    observation: OBSERVATION,
    observeAfter: false,
  })

  assert.equal(batch.effect, 'unverifiable')
  assert.deepEqual(batch.results.map((result) => result.effect), [
    'confirmed',
    'unverifiable',
    'noop',
  ])
  assert.match(batch.results[1].advice, /screen_observe|重新/)
})

test('executeBatch records per-step validation errors instead of losing earlier results', async () => {
  const backend = createFakeBackend()

  await assert.rejects(executeBatch(backend, { steps: 'nope' }), /steps/)

  const batch = await executeBatch(backend, {
    steps: [{ op: 'click', target: { element: 'save' } }, { op: 'click' }],
    observation: OBSERVATION,
    observeAfter: false,
  })

  assert.equal(batch.effect, 'refused')
  assert.equal(batch.failedAt, 1)
  assert.equal(batch.results.length, 2)
  assert.equal(batch.results[0].effect, 'confirmed')
  assert.equal(batch.results[1].effect, 'refused')
  assert.match(batch.results[1].detail, /requires a target/)
  assert.deepEqual(actionCalls(backend).map((call) => call.method), ['click'])
})

test('an empty batch is a noop with no results', async () => {
  const backend = createFakeBackend()

  const batch = await executeBatch(backend, { steps: [] })

  assert.deepEqual(batch, { effect: 'noop', results: [] })
  assert.equal(backend.calls.length, 0)
})

test('executeBatch lets a step override the shared observation and options', async () => {
  const backend = createFakeBackend()
  const otherObservation = { ...OBSERVATION, pid: 300, windowId: 400 }

  await executeBatch(backend, {
    steps: [{ op: 'click', target: { element: 'save' }, observation: otherObservation }],
    observation: OBSERVATION,
    observeAfter: false,
  })

  assert.equal(backend.calls[0].args.pid, 300)
  assert.equal(backend.calls[0].args.window_id, 400)
})

// --- cursor glide wiring ---------------------------------------------------

test('click glides once to the resolved element center before the backend runs', async () => {
  const backend = createFakeBackend()
  const events = []
  const glides = []
  const click = backend.click
  backend.click = async (args) => {
    events.push('click')
    return click(args)
  }

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    glide: async (point) => {
      events.push('glide')
      glides.push(point)
    },
  })

  assert.equal(result.effect, 'confirmed')
  assert.deepEqual(events, ['glide', 'click'])
  assert.equal(glides.length, 1)
  assert.ok(Math.abs(glides[0].x - 160.77) < 0.01, String(glides[0].x))
  assert.ok(Math.abs(glides[0].y - 335.18) < 0.01, String(glides[0].y))
})

test('a failing glide never blocks the action', async () => {
  const backend = createFakeBackend()

  const result = await execute(backend, {
    observation: OBSERVATION,
    op: 'click',
    target: { element: 'save' },
    glide: async () => {
      throw new Error('cursor unavailable')
    },
  })

  assert.equal(result.effect, 'confirmed')
  assert.equal(actionCalls(backend)[0].method, 'click')
})

test('drag and element scroll glide to their resolved start points', async () => {
  const backend = createFakeBackend()
  const glides = []

  await execute(backend, {
    observation: OBSERVATION,
    op: 'drag',
    from: { x: 10, y: 20 },
    to: { x: 30, y: 40 },
    glide: async (point) => glides.push(point),
  })
  await execute(backend, {
    observation: OBSERVATION,
    op: 'scroll',
    target: { element: 'save' },
    direction: 'down',
    glide: async (point) => glides.push(point),
  })

  assert.deepEqual(glides[0], { x: 10, y: 20 })
  assert.equal(glides.length, 2)
  assert.ok(Math.abs(glides[1].x - 160.77) < 0.01)
  assert.ok(Math.abs(glides[1].y - 335.18) < 0.01)
})

test('glide is not used for type, key, wait, launch, focus, resize or kill', async () => {
  const backend = createFakeBackend()
  let glides = 0
  const glide = async () => {
    glides += 1
  }

  await execute(backend, {
    observation: OBSERVATION,
    op: 'type',
    target: { element: 'name' },
    text: 'hello',
    glide,
  })
  await execute(backend, { observation: OBSERVATION, op: 'key', keys: 'return', glide })
  await execute(backend, { op: 'wait', amount: 0, sleep: async () => {}, glide })
  await execute(backend, { op: 'launch', target: { name: 'Notepad' }, glide })
  await execute(backend, { observation: OBSERVATION, op: 'focus', glide })
  await execute(backend, {
    observation: OBSERVATION,
    op: 'resize',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    glide,
  })
  await execute(backend, { observation: OBSERVATION, op: 'kill', target: { pid: 999 }, glide })

  assert.equal(glides, 0)
})
