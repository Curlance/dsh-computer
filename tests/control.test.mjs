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

test('an agent action inside the gate window is not treated as user activity', async () => {
  const clock = makeClock(10000)
  let idle = 120
  const gate = createControlGate({ now: clock.now, idleProvider: async () => idle, gateMs: 700 })

  gate.noteAgentAction()
  assert.deepEqual(await gate.status(), {
    control: 'ready',
    lastInputAgeMs: 120,
    waitSeconds: 0,
  })
  assert.equal((await gate.assertAgentAllowed()).allowed, true)

  clock.advance(700)
  assert.equal((await gate.status()).control, 'ready')

  clock.advance(1)
  idle = 701
  assert.deepEqual(await gate.status(), {
    control: 'user',
    lastInputAgeMs: 701,
    waitSeconds: 2.3,
  })
})

test('own-action gating does not suppress user control once the window passes', async () => {
  const clock = makeClock(0)
  const gate = createControlGate({ now: clock.now, idleProvider: async () => 50, gateMs: 100 })
  gate.noteAgentAction()

  clock.advance(101)
  const result = await gate.assertAgentAllowed()
  assert.equal(result.allowed, false)
  assert.equal(result.reason, 'user-active')
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
