import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyRisk, createPolicy, isHardBlocked } from '../lib/policy.js'

const config = (mode) => ({ approvals: { mode } })

function makeApproval(outcome = 'allowed-once') {
  const calls = []
  return {
    calls,
    async request(request) {
      calls.push(request)
      if (outcome instanceof Error) throw outcome
      return outcome
    },
  }
}

test('classifyRisk rates read and element interactions low', () => {
  assert.equal(classifyRisk({ op: 'observe' }), 'low')
  assert.equal(classifyRisk({ op: 'focus' }), 'low')
  assert.equal(classifyRisk({ op: 'wait' }), 'low')
  assert.equal(classifyRisk({ op: 'move', target: { x: 1, y: 2 } }), 'low')
  assert.equal(classifyRisk({ op: 'hover', target: { element: 1 } }), 'low')
  assert.equal(classifyRisk({ op: 'click', target: { element: 12 } }), 'low')
  assert.equal(classifyRisk({ op: 'doubleClick', target: { element: 7 } }), 'low')
  assert.equal(classifyRisk({ op: 'rightClick', target: { element: 3 } }), 'low')
  assert.equal(
    classifyRisk({ op: 'click', target: { element: 4 }, delivery: 'foreground' }),
    'low',
  )
})

test('classifyRisk rates typing, keys, scrolling and dragging medium', () => {
  assert.equal(classifyRisk({ op: 'type', target: { element: 1 }, text: 'hello' }), 'medium')
  assert.equal(classifyRisk({ op: 'key', target: { element: 1 }, text: 'ctrl+c' }), 'medium')
  assert.equal(classifyRisk({ op: 'scroll', target: { element: 1 } }), 'medium')
  assert.equal(classifyRisk({ op: 'drag', target: { x: 10, y: 20 } }), 'medium')
  assert.equal(
    classifyRisk({ op: 'type', target: { element: 1 }, text: 'hello', delivery: 'background' }),
    'medium',
  )
})

test('classifyRisk escalates foreground typing and coordinate input high', () => {
  assert.equal(
    classifyRisk({ op: 'click', target: { x: 1, y: 2 }, delivery: 'foreground' }),
    'high',
  )
  assert.equal(
    classifyRisk({ op: 'type', target: { element: 4 }, text: 'hello', delivery: 'foreground' }),
    'high',
  )
  assert.equal(
    classifyRisk({ op: 'key', target: { element: 4 }, text: 'ctrl+c', delivery: 'foreground' }),
    'high',
  )
  assert.equal(
    classifyRisk({ op: 'hotkey', target: { element: 4 }, text: 'alt+tab', delivery: 'foreground' }),
    'high',
  )
  assert.equal(
    classifyRisk({ op: 'scroll', target: { element: 4 }, delivery: 'foreground' }),
    'high',
  )
  assert.equal(
    classifyRisk({ op: 'drag', target: { element: 4 }, delivery: 'foreground' }),
    'high',
  )
})

test('classifyRisk rates launch, kill, window switch and pixel clicks high', () => {
  assert.equal(classifyRisk({ op: 'click', target: { x: 640, y: 360 } }), 'high')
  assert.equal(classifyRisk({ op: 'click', target: {} }), 'high')
  assert.equal(classifyRisk({ op: 'launch' }), 'high')
  assert.equal(classifyRisk({ op: 'kill', target: { element: 4 } }), 'high')
  assert.equal(classifyRisk({ op: 'switchWindow' }), 'high')
})

test('classifyRisk rates typing sensitive text high', () => {
  const texts = [
    '输入密码',
    '支付 100 元',
    '确认转账',
    '删除这个文件',
    '发送邮件',
    '提交表单',
    'Password',
    'pay now',
    'DELETE',
    'send it',
    'Submit',
  ]
  for (const text of texts) {
    assert.equal(classifyRisk({ op: 'type', target: { element: 2 }, text }), 'high', text)
  }
})

test('classifyRisk does not treat non-typing operations with sensitive words as sensitive', () => {
  assert.equal(classifyRisk({ op: 'key', text: 'password' }), 'medium')
  assert.equal(classifyRisk({ op: 'scroll', text: '删除' }), 'medium')
})

test('classifyRisk fails closed for unknown ops', () => {
  assert.equal(classifyRisk({ op: 'frobnicate' }), 'high')
  assert.equal(classifyRisk({}), 'high')
})

test('isHardBlocked blocks password fields by role or by label on editable roles', () => {
  const byRole = isHardBlocked({ target: { role: 'password' } })
  assert.equal(byRole.blocked, true)
  assert.match(byRole.reason, /password/i)

  const byLabel = isHardBlocked({ target: { role: 'textfield', label: 'Password' } })
  assert.equal(byLabel.blocked, true)

  const chinese = isHardBlocked({ target: { role: 'textfield', label: '密码' } })
  assert.equal(chinese.blocked, true)

  const button = isHardBlocked({ target: { role: 'button', label: 'Password' } })
  assert.equal(button.blocked, false)

  assert.deepEqual(isHardBlocked({ target: { role: 'button', label: 'Sign in' } }), {
    blocked: false,
  })
})

test('isHardBlocked blocks UAC and secure desktop titles', () => {
  for (const target of [
    { title: 'User Account Control' },
    { title: '用户账户控制' },
    { title: '安全桌面' },
    { title: 'Secure Desktop' },
    { title: 'UAC' },
    { process: 'consent.exe' },
    { role: 'window', label: 'UAC prompt' },
  ]) {
    const result = isHardBlocked({ target })
    assert.equal(result.blocked, true, JSON.stringify(target))
    assert.match(result.reason, /secure|desktop|uac/i)
  }

  const fromAction = isHardBlocked({
    target: { role: 'window', label: 'Dialog' },
    action: { markers: ['secure-desktop'] },
  })
  assert.equal(fromAction.blocked, true)
})

test('isHardBlocked requires a fresh observation for action-bearing ops', () => {
  const absent = isHardBlocked({ target: { element: 1 }, action: { op: 'click' } })
  assert.deepEqual(absent, { blocked: true, reason: 'unobserved-action' })

  const explicitUndefined = isHardBlocked({
    target: { element: 1 },
    action: { op: 'click', observed: undefined },
  })
  assert.equal(explicitUndefined.blocked, true)

  assert.equal(
    isHardBlocked({ target: { element: 1 }, action: { op: 'click', observed: true } }).blocked,
    false,
  )

  for (const op of ['observe', 'session', 'wait']) {
    assert.equal(isHardBlocked({ target: {}, action: { op } }).blocked, false, op)
  }
})

test('createPolicy rejects an invalid approval mode', () => {
  assert.throws(() => createPolicy({ config: config('sometimes') }), TypeError)
})

test('ask mode allows low and medium without approval and asks for high', async () => {
  const approval = makeApproval('allowed-once')
  const policy = createPolicy({ config: config('ask'), approval })

  const low = await policy.authorize({ action: { op: 'observe' }, session: { sessionId: 's1' } })
  assert.deepEqual(low, { allowed: true, reason: 'allowed', risk: 'low' })

  const medium = await policy.authorize({
    action: { op: 'type', text: 'hello', observed: true },
    target: { element: 1 },
  })
  assert.deepEqual(medium, { allowed: true, reason: 'allowed', risk: 'medium' })
  assert.equal(approval.calls.length, 0)

  const high = await policy.authorize({
    action: { op: 'launch', target: { app: 'notepad' }, observed: true },
  })
  assert.deepEqual(high, { allowed: true, reason: 'allowed', risk: 'high' })
  assert.equal(approval.calls.length, 1)
  assert.equal(approval.calls[0].toolName, 'computer')
  assert.equal(typeof approval.calls[0].reason, 'string')
  assert.equal(typeof approval.calls[0].detail, 'object')
})

test('ask mode denies high risk when approval is denied', async () => {
  const policy = createPolicy({ config: config('ask'), approval: makeApproval('denied') })
  const result = await policy.authorize({
    action: { op: 'kill', target: { element: 1 }, observed: true },
  })
  assert.deepEqual(result, { allowed: false, reason: 'approval-denied', risk: 'high' })
})

test('strict mode asks for medium and high but not low', async () => {
  const approval = makeApproval('approved')
  const policy = createPolicy({ config: config('strict'), approval })

  const low = await policy.authorize({ action: { op: 'focus', observed: true } })
  assert.equal(low.allowed, true)
  assert.equal(approval.calls.length, 0)

  const medium = await policy.authorize({
    action: { op: 'scroll', observed: true },
    target: { element: 2 },
  })
  assert.equal(medium.allowed, true)
  assert.equal(medium.risk, 'medium')
  assert.equal(approval.calls.length, 1)

  const high = await policy.authorize({ action: { op: 'launch', observed: true } })
  assert.equal(high.allowed, true)
  assert.equal(approval.calls.length, 2)
})

test('relaxed mode asks only for high risk', async () => {
  const approval = makeApproval('allowed')
  const policy = createPolicy({ config: config('relaxed'), approval })

  const medium = await policy.authorize({
    action: { op: 'drag', target: { x: 1, y: 2 }, observed: true },
  })
  assert.equal(medium.allowed, true)
  assert.equal(approval.calls.length, 0)

  const high = await policy.authorize({
    action: { op: 'click', target: { x: 9, y: 9 }, observed: true },
  })
  assert.equal(high.allowed, true)
  assert.equal(high.risk, 'high')
  assert.equal(approval.calls.length, 1)
})

test('approval outcomes allowed-once, allowed and approved allow the action', async () => {
  for (const outcome of ['allowed-once', 'allowed', 'approved']) {
    const policy = createPolicy({ config: config('ask'), approval: makeApproval(outcome) })
    const result = await policy.authorize({ action: { op: 'launch', observed: true } })
    assert.equal(result.allowed, true, outcome)
    assert.equal(result.reason, 'allowed')
  }
})

test('denied, rejected, cancelled, unavailable and timeout outcomes deny the action', async () => {
  for (const outcome of ['denied', 'rejected', 'cancelled', 'unavailable', 'timeout']) {
    const policy = createPolicy({ config: config('ask'), approval: makeApproval(outcome) })
    const result = await policy.authorize({ action: { op: 'launch', observed: true } })
    assert.deepEqual(result, { allowed: false, reason: 'approval-denied', risk: 'high' }, outcome)
  }
})

test('a throwing approval denies instead of auto-allowing', async () => {
  const policy = createPolicy({
    config: config('ask'),
    approval: makeApproval(new Error('host approval crashed')),
  })
  const result = await policy.authorize({ action: { op: 'launch', observed: true } })
  assert.deepEqual(result, { allowed: false, reason: 'approval-denied', risk: 'high' })
})

test('a missing approval host denies high risk actions', async () => {
  const policy = createPolicy({ config: config('ask') })
  const result = await policy.authorize({ action: { op: 'launch', observed: true } })
  assert.deepEqual(result, { allowed: false, reason: 'approval-denied', risk: 'high' })
})

test('hard blocks always win and never ask for approval', async () => {
  const approval = makeApproval('approved')
  const policy = createPolicy({ config: config('ask'), approval })

  const password = await policy.authorize({
    action: { op: 'type', text: 'hunter2', observed: true },
    target: { role: 'password', label: '密码' },
  })
  assert.equal(password.allowed, false)
  assert.match(password.reason, /^hard-blocked: /)

  const uac = await policy.authorize({
    action: { op: 'click', observed: true },
    target: { role: 'window', title: 'Secure Desktop' },
  })
  assert.equal(uac.allowed, false)
  assert.match(uac.reason, /^hard-blocked: /)

  const unobserved = await policy.authorize({
    action: { op: 'launch', observed: false },
    target: { app: 'notepad' },
  })
  assert.equal(unobserved.allowed, false)
  assert.match(unobserved.reason, /^hard-blocked: /)

  assert.equal(approval.calls.length, 0)
})

test('hard blocks apply at low and medium risk too', async () => {
  const approval = makeApproval('approved')
  const policy = createPolicy({ config: config('ask'), approval })

  const low = await policy.authorize({
    action: { op: 'click', observed: true },
    target: { element: 1, title: 'User Account Control' },
  })
  assert.deepEqual(low, { allowed: false, reason: 'hard-blocked: secure-desktop', risk: 'low' })

  const medium = await policy.authorize({
    action: { op: 'scroll', observed: true },
    target: { element: 1, title: '安全桌面' },
  })
  assert.deepEqual(medium, { allowed: false, reason: 'hard-blocked: secure-desktop', risk: 'medium' })

  const unobservedLow = await policy.authorize({
    action: { op: 'click' },
    target: { element: 1 },
  })
  assert.deepEqual(unobservedLow, {
    allowed: false,
    reason: 'hard-blocked: unobserved-action',
    risk: 'low',
  })

  assert.equal(approval.calls.length, 0)
})

test('use target passed to authorize when the action has none', async () => {
  const approval = makeApproval('allowed-once')
  const policy = createPolicy({ config: config('ask'), approval })
  const result = await policy.authorize({
    action: { op: 'type', text: 'hello', observed: true },
    target: { element: 5 },
  })
  assert.deepEqual(result, { allowed: true, reason: 'allowed', risk: 'medium' })
})
