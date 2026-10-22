import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAudit, redactText } from '../lib/audit.js'

const makeTempDir = () => mkdtemp(join(tmpdir(), 'dsh-audit-'))

function baseEvent(overrides = {}) {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    action: 'click',
    target: { x: 10, y: 20 },
    risk: 'low',
    decision: 'allow',
    effect: 'clicked',
    durationMs: 5,
    observationRevision: 1,
    ...overrides,
  }
}

async function readRecords(path) {
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n')
  assert.equal(lines.at(-1), '', 'file should end with a newline')
  return lines.slice(0, -1).map((line) => JSON.parse(line))
}

test('redactText returns a deterministic length and sha256 prefix', () => {
  assert.deepEqual(redactText('hello world'), {
    length: 11,
    sha256Prefix: 'b94d27b9934d3e08',
  })
  assert.deepEqual(redactText('hello world'), redactText('hello world'))
  assert.deepEqual(redactText(''), { length: 0, sha256Prefix: 'e3b0c44298fc1c14' })
  assert.notEqual(redactText('hunter2').sha256Prefix, redactText('hunter3').sha256Prefix)
})

test('record appends one JSON object per line with a stamped ts', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  const audit = createAudit({ path, now: () => 1000 })
  assert.equal(audit.path, path)

  await audit.record({ ...baseEvent(), ts: 999 })
  await audit.record(baseEvent({ action: 'type', effect: 'typed' }))

  const records = await readRecords(path)
  assert.equal(records.length, 2)
  assert.deepEqual(records[0], {
    ts: 1000,
    sessionId: 'session-1',
    agentId: 'agent-1',
    action: 'click',
    target: { x: 10, y: 20 },
    risk: 'low',
    decision: 'allow',
    effect: 'clicked',
    durationMs: 5,
    observationRevision: 1,
  })
  assert.equal(records[1].action, 'type')
  assert.equal(records[1].effect, 'typed')
})

test('record redacts input text so plaintext never reaches the file', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  const audit = createAudit({ path, now: () => 1 })
  const secret = 'correct horse battery staple'

  await audit.record(baseEvent({ action: 'type', inputSummary: secret }))
  await audit.record(
    baseEvent({ action: 'type', inputSummary: redactText(secret) }),
  )

  const raw = await readFile(path, 'utf8')
  assert.equal(raw.includes(secret), false)
  assert.equal(raw.includes('"input"'), false)

  const records = await readRecords(path)
  assert.deepEqual(records[0].inputSummary, {
    length: 28,
    sha256Prefix: 'c4bbcb1fbec99d65',
  })
  assert.deepEqual(records[1].inputSummary, records[0].inputSummary)
})

test('record auto-creates a missing nested directory', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'deeper', 'audit.jsonl')
  const audit = createAudit({ path, now: () => 42 })

  await audit.record(baseEvent())

  const records = await readRecords(path)
  assert.equal(records.length, 1)
  assert.equal(records[0].ts, 42)
})

test('concurrent record calls land in call order as valid JSONL', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  let clock = 0
  const audit = createAudit({ path, now: () => ++clock })

  await Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      audit.record(baseEvent({ target: { index } })),
    ),
  )

  const records = await readRecords(path)
  assert.equal(records.length, 25)
  assert.deepEqual(
    records.map((record) => record.target.index),
    Array.from({ length: 25 }, (_, index) => index),
  )
  assert.deepEqual(
    records.map((record) => record.ts),
    Array.from({ length: 25 }, (_, index) => index + 1),
  )
})

test('record resolves only after its line is appended', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  const audit = createAudit({ path, now: () => 7 })

  await audit.record(baseEvent())

  const records = await readRecords(path)
  assert.equal(records.length, 1)
})

test('flush waits for queued records to be written', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  const audit = createAudit({ path, now: () => 3 })

  const pending = [
    audit.record(baseEvent({ target: { index: 0 } })),
    audit.record(baseEvent({ target: { index: 1 } })),
  ]
  await audit.flush()

  const records = await readRecords(path)
  assert.equal(records.length, 2)
  assert.deepEqual(
    records.map((record) => record.target.index),
    [0, 1],
  )
  await Promise.all(pending)
})

test('record rejects on fs errors instead of silently dropping', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const blocked = join(dir, 'blocked')
  await mkdir(blocked)

  const audit = createAudit({ path: blocked, now: () => 1 })

  await assert.rejects(audit.record(baseEvent()), (error) => error.code === 'EISDIR')

  await rm(blocked, { recursive: true })
  await writeFile(blocked, '')
  await audit.record(baseEvent({ action: 'after-error' }))

  const records = await readRecords(blocked)
  assert.equal(records.length, 1)
  assert.equal(records[0].action, 'after-error')
})

test('includeScreenshots is accepted but screenshot bytes are never written', async (t) => {
  const dir = await makeTempDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  const audit = createAudit({ path, now: () => 2, includeScreenshots: true })

  await audit.record(
    baseEvent({
      screenshot: 'data:image/png;base64,AAAA',
      screenshotPng: Buffer.from('PNGDATA'),
    }),
  )

  const raw = await readFile(path, 'utf8')
  assert.equal(raw.includes('base64'), false)
  assert.equal(raw.includes('PNGDATA'), false)
  const [record] = await readRecords(path)
  assert.equal('screenshot' in record, false)
  assert.equal('screenshotPng' in record, false)
  assert.equal(record.ts, 2)
})
