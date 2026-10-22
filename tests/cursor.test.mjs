import test from 'node:test'
import assert from 'node:assert/strict'

import { cursorSummary, ensureCursor, glideTo } from '../lib/cursor.js'

const OBSERVATION = {
  pid: 10,
  windowId: 20,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  space: { width: 800, height: 600 },
}
const WINDOW_TARGET = { kind: 'window', pid: 10, window_id: 20 }

function createFakeBackend({ cursor = { x: 0, y: 0 }, state, fail = {} } = {}) {
  const calls = []
  function record(name, args) {
    calls.push(args === undefined ? [name] : [name, args])
  }

  return {
    calls,
    fail,
    async startSession(args) {
      record('startSession', args)
      if (fail.startSession) throw new Error('startSession failed')
    },
    async setAgentCursorEnabled(enabled) {
      record('setAgentCursorEnabled', enabled)
      if (fail.setAgentCursorEnabled) throw new Error('enabled failed')
    },
    async setAgentCursorMotion(motion) {
      record('setAgentCursorMotion', motion)
      if (fail.setAgentCursorMotion) throw new Error('motion failed')
    },
    async getCursorPosition() {
      record('getCursorPosition')
      if (fail.getCursorPosition) throw new Error('cursor position failed')
      return { text: '', structured: cursor }
    },
    async moveCursor(args) {
      record('moveCursor', args)
      const count = calls.filter(([name]) => name === 'moveCursor').length
      if (fail.moveCursorAt === count) throw new Error('move failed')
    },
    async getAgentCursorState() {
      record('getAgentCursorState')
      if (fail.getAgentCursorState) throw new Error('state failed')
      return { text: '', structured: state }
    },
  }
}

function movesOf(backend) {
  return backend.calls.filter(([name]) => name === 'moveCursor').map(([, args]) => args)
}

test('ensureCursor configures each backend once, including concurrent calls', async () => {
  const backend = createFakeBackend()

  await Promise.all([ensureCursor(backend), ensureCursor(backend)])
  await ensureCursor(backend, { theme: 'ignored.after.first' })

  assert.deepEqual(backend.calls, [
    ['startSession', { theme: 'cua.default' }],
    ['setAgentCursorEnabled', true],
    ['setAgentCursorMotion', { idle_hide_ms: 0, glide_duration_ms: 600 }],
  ])

  const other = createFakeBackend()
  await ensureCursor(other)
  assert.equal(other.calls.length, 3)
})

test('ensureCursor passes theme, label and motion timings through', async () => {
  const backend = createFakeBackend()

  await ensureCursor(backend, { theme: 'cua.dark', glideMs: 0, idleHideMs: 1500, label: 'run-1' })

  assert.deepEqual(backend.calls, [
    ['startSession', { theme: 'cua.dark', label: 'run-1' }],
    ['setAgentCursorEnabled', true],
    ['setAgentCursorMotion', { idle_hide_ms: 1500, glide_duration_ms: 0 }],
  ])
})

test('ensureCursor swallows backend failures and retries on the next call', async () => {
  const backend = createFakeBackend()
  backend.fail.startSession = true

  await assert.doesNotReject(ensureCursor(backend))
  assert.deepEqual(
    backend.calls.map(([name]) => name),
    ['startSession', 'setAgentCursorEnabled', 'setAgentCursorMotion'],
  )

  backend.fail.startSession = false
  backend.calls.length = 0
  await ensureCursor(backend)
  assert.equal(backend.calls.length, 3)
})

test('ensureCursor swallows enabled and motion failures too', async () => {
  for (const key of ['setAgentCursorEnabled', 'setAgentCursorMotion']) {
    const backend = createFakeBackend()
    backend.fail[key] = true
    await assert.doesNotReject(ensureCursor(backend))
    assert.equal(backend.calls.length, 3)
  }
})

test('glideTo moves through five intermediates and lands exactly on the target', async () => {
  const backend = createFakeBackend()

  await glideTo(backend, { x: 400, y: 300 }, OBSERVATION)

  assert.equal(backend.calls.filter(([name]) => name === 'getCursorPosition').length, 1)
  const moves = movesOf(backend)
  assert.equal(moves.length, 6)
  for (const move of moves) assert.deepEqual(move.target, WINDOW_TARGET)
  assert.deepEqual(moves.at(-1), { x: 400, y: 300, target: WINDOW_TARGET })

  const intermediates = moves.slice(0, 5)
  for (let index = 1; index < intermediates.length; index += 1) {
    assert.ok(intermediates[index].x > intermediates[index - 1].x)
  }
  // The arc lifts the path above the straight interpolation.
  assert.ok(intermediates[2].y < 150)
})

test('glideTo honors custom segment and arc options', async () => {
  const backend = createFakeBackend()

  await glideTo(backend, { x: 400, y: 300 }, OBSERVATION, { segments: 2, arcHeight: 0 })

  const moves = movesOf(backend)
  assert.equal(moves.length, 3)
  assert.deepEqual(moves.at(-1), { x: 400, y: 300, target: WINDOW_TARGET })
  for (const { x, y } of moves.slice(0, 2)) {
    assert.ok(x > 0 && x < 400)
    assert.ok(y > 0 && y < 300)
  }
})

test('glideTo clamps every move to the observation space', async () => {
  const backend = createFakeBackend({ cursor: { x: 5000, y: -50 } })

  await glideTo(backend, { x: -50, y: 900 }, OBSERVATION)

  const moves = movesOf(backend)
  assert.equal(moves.length, 6)
  assert.deepEqual(moves.at(-1), { x: 0, y: 600, target: WINDOW_TARGET })
  for (const { x, y } of moves) {
    assert.ok(x >= 0 && x <= 800)
    assert.ok(y >= 0 && y <= 600)
  }
})

test('glideTo falls back to the target when the cursor position is unavailable', async () => {
  const backend = createFakeBackend()
  backend.fail.getCursorPosition = true

  await glideTo(backend, { x: 200, y: 100 }, OBSERVATION)

  const moves = movesOf(backend)
  assert.equal(moves.length, 6)
  for (const { x, y } of moves) assert.deepEqual({ x, y }, { x: 200, y: 100 })
})

test('glideTo swallows move failures and still lands on the target', async () => {
  const backend = createFakeBackend()
  backend.fail.moveCursorAt = 2

  await assert.doesNotReject(glideTo(backend, { x: 400, y: 300 }, OBSERVATION))

  const moves = movesOf(backend)
  assert.equal(moves.length, 6)
  assert.deepEqual(moves.at(-1), { x: 400, y: 300, target: WINDOW_TARGET })
})

test('cursorSummary maps the agent cursor state', async () => {
  const backend = createFakeBackend({
    state: { enabled: true, position: { x: 12, y: 34 }, theme: 'cua.default' },
  })

  assert.deepEqual(await cursorSummary(backend), {
    enabled: true,
    position: { x: 12, y: 34 },
    theme: 'cua.default',
  })

  const wrapped = createFakeBackend({
    state: { enabled: false, position: { x: 1, y: 2 }, theme: { theme_id: 'cua.dark' } },
  })
  assert.deepEqual(await cursorSummary(wrapped), {
    enabled: false,
    position: { x: 1, y: 2 },
    theme: 'cua.dark',
  })
})

test('cursorSummary returns null when the backend fails or has no state', async () => {
  assert.equal(await cursorSummary(undefined), null)
  assert.equal(await cursorSummary(createFakeBackend()), null)

  const backend = createFakeBackend({
    state: { enabled: true, position: { x: 0, y: 0 }, theme: 'cua.default' },
  })
  backend.fail.getAgentCursorState = true
  assert.equal(await cursorSummary(backend), null)
})
