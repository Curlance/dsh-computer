import test from 'node:test'
import assert from 'node:assert/strict'

import { createControlGate, createWindowsIdleProvider } from '../lib/control.js'

function makeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
  }
}

test('status is ready once the user has been idle for the timeout', async () => {
  const gate = createControlGate({ now: () => 10, idleProvider: async () => 3000 })
  assert.deepEqual(await gate.status(), {
    control: 'ready',
    lastInputAgeMs: 3000,
    waitSeconds: 0,
  })

  const longIdle = createControlGate({ now: () => 10, idleProvider: async () => 60000 })
  assert.equal((await longIdle.status()).control, 'ready')
})

test('status is user with a rounded wait when the user is still active', async () => {
  const gate = createControlGate({ now: () => 10, idleProvider: async () => 1234 })
  assert.deepEqual(await gate.status(), {
    control: 'user',
    lastInputAgeMs: 1234,
    waitSeconds: 1.8,
  })
})

test('assertAgentAllowed allows ready control', async () => {
  const gate = createControlGate({ now: () => 0, idleProvider: async () => 5000 })
  assert.deepEqual(await gate.assertAgentAllowed(), {
    allowed: true,
    control: 'ready',
    waitSeconds: 0,
  })
})

test('assertAgentAllowed denies active user control with the wait', async () => {
  const gate = createControlGate({ now: () => 0, idleProvider: async () => 1000 })
  assert.deepEqual(await gate.assertAgentAllowed(), {
    allowed: false,
    control: 'user',
    waitSeconds: 2,
    reason: 'user-active',
  })
})

test('a null idle reading is unknown and allowed by default', async () => {
  const gate = createControlGate({ now: () => 0, idleProvider: async () => null })
  assert.deepEqual(await gate.status(), {
    control: 'unknown',
    lastInputAgeMs: null,
    waitSeconds: 0,
  })
  assert.deepEqual(await gate.assertAgentAllowed(), {
    allowed: true,
    control: 'unknown',
    waitSeconds: 0,
  })
})

test('provider failures are unknown and can be configured to block', async () => {
  const rejecting = createControlGate({
    now: () => 0,
    idleProvider: async () => {
      throw new Error('powershell missing')
    },
  })
  assert.equal((await rejecting.status()).control, 'unknown')

  const blocking = createControlGate({
    now: () => 0,
    idleProvider: async () => null,
    onUnknown: 'block',
  })
  assert.deepEqual(await blocking.assertAgentAllowed(), {
    allowed: false,
    control: 'unknown',
    waitSeconds: 0,
    reason: 'control-unknown',
  })
})

test('invalid idle readings are treated as unknown and never throw', async () => {
  for (const value of [Number.NaN, -5, Number.POSITIVE_INFINITY, 'soon', undefined]) {
    const gate = createControlGate({ now: () => 0, idleProvider: async () => value })
    assert.deepEqual(await gate.status(), {
      control: 'unknown',
      lastInputAgeMs: null,
      waitSeconds: 0,
    })
    await assert.doesNotReject(() => gate.assertAgentAllowed())
  }

  const syncThrow = createControlGate({
    now: () => 0,
    idleProvider: () => {
      throw 'not an error'
    },
  })
  assert.equal((await syncThrow.status()).control, 'unknown')
})

test('an agent action stays attributed to the agent across a slow model round-trip', async () => {
  const clock = makeClock(10000)
  let lastInput = 10000
  const gate = createControlGate({
    now: clock.now,
    idleProvider: async () => clock.now() - lastInput,
    gateMs: 700,
  })

  gate.noteAgentAction()
  assert.equal((await gate.status()).control, 'ready')

  clock.advance(1900) // normal model round-trip: 1.9s idle, no user input
  assert.deepEqual(await gate.status(), {
    control: 'ready',
    lastInputAgeMs: 1900,
    waitSeconds: 0,
  })
  assert.equal((await gate.assertAgentAllowed()).allowed, true)

  clock.advance(5000)
  assert.equal((await gate.status()).control, 'ready')
})

test('real user input after an agent action takes control', async () => {
  const clock = makeClock(0)
  let lastInput = 0
  const gate = createControlGate({
    now: clock.now,
    idleProvider: async () => clock.now() - lastInput,
    gateMs: 100,
  })
  gate.noteAgentAction()

  clock.advance(1500)
  lastInput = 1100 // user moved the mouse 400ms ago
  const result = await gate.assertAgentAllowed()
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'user-active')
  assert.equal(result.control, 'user')
})

test('input at the same instant as the agent action is attributed to the agent', async () => {
  const clock = makeClock(0)
  let lastInput = 0
  const gate = createControlGate({
    now: clock.now,
    idleProvider: async () => clock.now() - lastInput,
  })
  clock.advance(800)
  gate.noteAgentAction()
  clock.advance(2000)
  assert.equal((await gate.status()).control, 'ready')
})

test('control gate rejects invalid construction options', () => {
  assert.throws(() => createControlGate({ idleProvider: async () => 0, onUnknown: 'maybe' }), TypeError)
  assert.throws(() => createControlGate({ now: () => 0 }), TypeError)
})

test('windows idle provider caches consecutive reads', async () => {
  let calls = 0
  const execFile = async (file, args) => {
    calls += 1
    assert.equal(file, 'powershell.exe')
    assert.ok(args.join(' ').includes('GetLastInputInfo'))
    return { stdout: '1500\r\n' }
  }
  const idle = createWindowsIdleProvider({ execFile, cacheMs: 1000, platform: 'win32' })

  assert.equal(await idle(), 1500)
  assert.equal(await idle(), 1500)
  assert.equal(calls, 1)
})

test('windows idle provider deduplicates concurrent reads', async () => {
  let calls = 0
  let release
  const execFile = () => {
    calls += 1
    return new Promise((resolve) => {
      release = () => resolve({ stdout: '0' })
    })
  }
  const idle = createWindowsIdleProvider({ execFile, cacheMs: 1000, platform: 'win32' })

  const pending = [idle(), idle()]
  await new Promise((resolve) => setImmediate(resolve))
  release()
  assert.deepEqual(await Promise.all(pending), [0, 0])
  assert.equal(calls, 1)
})

test('windows idle provider returns null on failures and bad output', async () => {
  const throwing = createWindowsIdleProvider({
    execFile: async () => {
      throw new Error('no powershell')
    },
    platform: 'win32',
  })
  assert.equal(await throwing(), null)

  const garbage = createWindowsIdleProvider({
    execFile: async () => ({ stdout: 'not-a-number' }),
    platform: 'win32',
  })
  assert.equal(await garbage(), null)

  const plainString = createWindowsIdleProvider({
    execFile: async () => '42\n',
    platform: 'win32',
  })
  assert.equal(await plainString(), 42)
})

test('windows idle provider is a no-op outside win32', async () => {
  let calls = 0
  const idle = createWindowsIdleProvider({
    execFile: async () => {
      calls += 1
      return { stdout: '10' }
    },
    platform: 'linux',
  })
  assert.equal(await idle(), null)
  assert.equal(calls, 0)
})
