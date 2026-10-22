import test from 'node:test'
import assert from 'node:assert/strict'

import { createSessionManager, SessionError } from '../lib/session.js'

function makeClock(start = 0) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
    },
  }
}

function codeOf(error) {
  return typeof error === 'object' && error !== null ? error.code : undefined
}

test('begin grants the first lease and status reports it active', () => {
  const clock = makeClock(1000)
  const sessions = createSessionManager({ now: clock.now, ttlMs: 120000 })

  const lease = sessions.begin('agent-a')
  assert.equal(lease.agentId, 'agent-a')
  assert.equal(typeof lease.sessionId, 'string')
  assert.ok(lease.sessionId.length > 0)

  const status = sessions.status()
  assert.equal(status.active, true)
  assert.equal(status.state, 'active')
  assert.equal(status.sessionId, lease.sessionId)
  assert.equal(status.agentId, 'agent-a')
  assert.equal(status.expiresAt, 121000)
  assert.equal(status.remainingMs, 120000)
  assert.deepEqual(sessions.assertActive(lease.sessionId), {
    sessionId: lease.sessionId,
    agentId: 'agent-a',
    expiresAt: 121000,
  })
})

test('a second begin while the lease is held throws busy', () => {
  const clock = makeClock()
  const sessions = createSessionManager({ now: clock.now })
  sessions.begin('agent-a')

  assert.throws(() => sessions.begin('agent-b'), (error) => {
    assert.ok(error instanceof SessionError)
    assert.equal(codeOf(error), 'busy')
    return true
  })
})

test('default TTL is 120s and the lease expires exactly at the boundary', () => {
  const clock = makeClock(500)
  const sessions = createSessionManager({ now: clock.now })
  const { sessionId } = sessions.begin('agent-a')

  clock.advance(119999)
  assert.equal(sessions.assertActive(sessionId).agentId, 'agent-a')

  clock.advance(1)
  assert.throws(() => sessions.assertActive(sessionId), (error) => codeOf(error) === 'expired')
  const status = sessions.status()
  assert.equal(status.active, false)
  assert.equal(status.state, 'expired')
  assert.equal(status.remainingMs, 0)
})

test('an expired lease can be replaced by a new begin', () => {
  const clock = makeClock()
  const sessions = createSessionManager({ now: clock.now, ttlMs: 100 })
  const first = sessions.begin('agent-a')

  clock.advance(100)
  const second = sessions.begin('agent-b')

  assert.notEqual(second.sessionId, first.sessionId)
  assert.equal(second.agentId, 'agent-b')
  assert.equal(sessions.status().active, true)
  assert.throws(() => sessions.assertActive(first.sessionId), (error) => codeOf(error) === 'unknown_session')
})

test('renew extends the lease from the current time', () => {
  const clock = makeClock()
  const sessions = createSessionManager({ now: clock.now, ttlMs: 1000 })
  const { sessionId } = sessions.begin('agent-a')

  clock.advance(900)
  const renewed = sessions.renew(sessionId)
  assert.equal(renewed.expiresAt, 1900)

  clock.advance(900)
  assert.equal(sessions.assertActive(sessionId).expiresAt, 1900)

  clock.advance(100)
  assert.throws(() => sessions.renew(sessionId), (error) => codeOf(error) === 'expired')
})

test('renew rejects an unknown session', () => {
  const sessions = createSessionManager({ now: () => 0 })
  assert.throws(() => sessions.renew('missing'), (error) => codeOf(error) === 'unknown_session')
})

test('takeover suspends the lease until resume', () => {
  const clock = makeClock(1000)
  const sessions = createSessionManager({ now: clock.now })
  const { sessionId } = sessions.begin('agent-a')

  const taken = sessions.takeover(sessionId, 'user grabbed the mouse')
  assert.deepEqual(taken.takeover, { at: 1000, note: 'user grabbed the mouse' })

  assert.throws(() => sessions.assertActive(sessionId), (error) => codeOf(error) === 'takeover')
  assert.throws(() => sessions.renew(sessionId), (error) => codeOf(error) === 'takeover')
  const status = sessions.status()
  assert.equal(status.active, false)
  assert.equal(status.state, 'takeover')
  assert.equal(status.takeover.note, 'user grabbed the mouse')

  const resumed = sessions.resume(sessionId)
  assert.equal(resumed.takeover, null)
  assert.equal(sessions.assertActive(sessionId).agentId, 'agent-a')
  assert.equal(sessions.status().state, 'active')
})

test('takeover and resume reject unknown or expired sessions', () => {
  const clock = makeClock()
  const sessions = createSessionManager({ now: clock.now, ttlMs: 50 })
  const { sessionId } = sessions.begin('agent-a')

  assert.throws(() => sessions.takeover('missing', 'x'), (error) => codeOf(error) === 'unknown_session')
  assert.throws(() => sessions.resume('missing'), (error) => codeOf(error) === 'unknown_session')

  clock.advance(50)
  assert.throws(() => sessions.takeover(sessionId, 'x'), (error) => codeOf(error) === 'expired')
  assert.throws(() => sessions.resume(sessionId), (error) => codeOf(error) === 'expired')
})

test('end releases the lease for the next begin', () => {
  const clock = makeClock()
  const sessions = createSessionManager({ now: clock.now })
  const { sessionId } = sessions.begin('agent-a')

  assert.deepEqual(sessions.end(sessionId), { ended: true })
  assert.throws(() => sessions.assertActive(sessionId), (error) => codeOf(error) === 'unknown_session')
  assert.equal(sessions.status().state, 'idle')

  const next = sessions.begin('agent-b')
  assert.equal(next.agentId, 'agent-b')
  assert.throws(() => sessions.end(sessionId), (error) => codeOf(error) === 'unknown_session')
})

test('status on a fresh manager is idle with null lease fields', () => {
  const sessions = createSessionManager({ now: () => 0 })
  assert.deepEqual(sessions.status(), {
    active: false,
    state: 'idle',
    sessionId: null,
    agentId: null,
    expiresAt: null,
    remainingMs: 0,
    takeover: null,
  })
})

test('begin requires a non-empty agent id', () => {
  const sessions = createSessionManager({ now: () => 0 })
  assert.throws(() => sessions.begin(''), TypeError)
  assert.throws(() => sessions.begin(42), TypeError)
})
