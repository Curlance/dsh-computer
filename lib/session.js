const DEFAULT_TTL_MS = 120000

/**
 * Lease error with a stable machine-readable code.
 */
export class SessionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}

function fail(code, message) {
  throw new SessionError(code, message)
}

/**
 * In-memory single-session lease manager. Only one agent may hold the desktop at
 * a time; a held lease is `busy` until it is renewed, taken over, released, or
 * expires. A user takeover suspends the lease without releasing it.
 * @param {{now?: () => number, ttlMs?: number}} [options]
 */
export function createSessionManager({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive number')
  }

  let nextId = 1
  let lease = null

  function snapshot(at) {
    return {
      sessionId: lease.sessionId,
      agentId: lease.agentId,
      expiresAt: lease.expiresAt,
      remainingMs: Math.max(0, lease.expiresAt - at),
      takeover: lease.takeover === null ? null : { ...lease.takeover },
    }
  }

  function requireActive(sessionId, at) {
    if (lease === null || lease.sessionId !== sessionId) {
      fail('unknown_session', `unknown session: ${sessionId}`)
    }
    if (at >= lease.expiresAt) {
      fail('expired', `session expired: ${sessionId}`)
    }
    return lease
  }

  return {
    begin(agentId) {
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new TypeError('agentId must be a non-empty string')
      }
      const at = now()
      if (lease !== null && at < lease.expiresAt) {
        fail('busy', `session ${lease.sessionId} holds the lease`)
      }
      lease = {
        sessionId: `session-${nextId++}`,
        agentId,
        expiresAt: at + ttlMs,
        takeover: null,
      }
      return { sessionId: lease.sessionId, agentId: lease.agentId }
    },

    renew(sessionId) {
      const at = now()
      requireActive(sessionId, at)
      if (lease.takeover !== null) {
        fail('takeover', `session ${sessionId} is under user takeover`)
      }
      lease.expiresAt = at + ttlMs
      return snapshot(at)
    },

    end(sessionId) {
      if (lease === null || lease.sessionId !== sessionId) {
        fail('unknown_session', `unknown session: ${sessionId}`)
      }
      lease = null
      return { ended: true }
    },

    takeover(sessionId, note) {
      const at = now()
      requireActive(sessionId, at)
      lease.takeover = {
        at,
        note: typeof note === 'string' && note.length > 0 ? note : null,
      }
      return snapshot(at)
    },

    resume(sessionId) {
      const at = now()
      requireActive(sessionId, at)
      lease.takeover = null
      return snapshot(at)
    },

    status() {
      const at = now()
      if (lease === null) {
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
      const expired = at >= lease.expiresAt
      const takeover = lease.takeover === null ? null : { ...lease.takeover }
      return {
        active: !expired && takeover === null,
        state: expired ? 'expired' : takeover === null ? 'active' : 'takeover',
        sessionId: lease.sessionId,
        agentId: lease.agentId,
        expiresAt: lease.expiresAt,
        remainingMs: Math.max(0, lease.expiresAt - at),
        takeover,
      }
    },

    assertActive(sessionId) {
      const at = now()
      requireActive(sessionId, at)
      if (lease.takeover !== null) {
        fail('takeover', `session ${sessionId} is under user takeover`)
      }
      return {
        sessionId: lease.sessionId,
        agentId: lease.agentId,
        expiresAt: lease.expiresAt,
      }
    },
  }
}
