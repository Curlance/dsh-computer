import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const EVENT_FIELDS = [
  'sessionId',
  'agentId',
  'action',
  'target',
  'risk',
  'decision',
  'effect',
  'durationMs',
  'observationRevision',
]

const SHA256_PREFIX_LENGTH = 16

/**
 * Summarize text for the audit log without keeping the plaintext.
 * @param {string} text
 * @returns {{length: number, sha256Prefix: string}}
 */
export function redactText(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return {
    length: value.length,
    sha256Prefix: createHash('sha256').update(value).digest('hex').slice(0, SHA256_PREFIX_LENGTH),
  }
}

function summarizeInput(value) {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.length === 'number' &&
    typeof value.sha256Prefix === 'string'
  ) {
    return { length: value.length, sha256Prefix: value.sha256Prefix }
  }
  return redactText(value)
}

/**
 * Append-only JSONL audit log. Writes are serialized so concurrent records keep
 * call order, and a failed write rejects its own record instead of being dropped.
 * `includeScreenshots` is accepted for config parity; image bytes are never stored.
 * @param {{path: string, now?: () => number, includeScreenshots?: boolean}} options
 */
export function createAudit({ path, now = Date.now } = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('audit path must be a non-empty string')
  }

  let tail = Promise.resolve()

  async function appendLine(line) {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, line, 'utf8')
  }

  return {
    path,

    record(event = {}) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)) {
        return Promise.reject(new TypeError('audit event must be an object'))
      }

      const entry = { ts: now() }
      for (const field of EVENT_FIELDS) {
        if (event[field] !== undefined) entry[field] = event[field]
      }
      if (event.inputSummary !== undefined) {
        entry.inputSummary = summarizeInput(event.inputSummary)
      }
      const line = `${JSON.stringify(entry)}\n`

      const write = tail.then(() => appendLine(line))
      // Keep the queue alive after a rejected write; `write` still reports the error.
      tail = write.catch(() => {})
      return write
    },

    flush() {
      return tail
    },
  }
}
