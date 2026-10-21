import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { normalizeConfig, validateConfig } from '../lib/config.js'

const home = homedir()
const defaultAuditPath = resolve(home, '.dsh', 'computer', 'audit.jsonl')

test('normalizeConfig({}) returns every default value', () => {
  assert.deepEqual(normalizeConfig({}), {
    cursor: { enabled: true, theme: 'cua.default', idleHideMs: 0, glideMs: 600 },
    approvals: { mode: 'ask' },
    policy: { allowedApps: [], blockedApps: [], maxActionsPerMinute: 60 },
    audit: { path: defaultAuditPath, includeScreenshots: false },
    backend: { timeoutMs: 15000 },
    observation: { maxElements: 250, maxImageDimension: 1456, ttlMs: 60000 },
  })
})

test('normalizeConfig throws on an invalid approvals.mode', () => {
  assert.throws(
    () => normalizeConfig({ approvals: { mode: 'bogus' } }),
    /Invalid approvals\.mode/,
  )
})

test('normalizeConfig deep-merges partial config over defaults', () => {
  const config = normalizeConfig({
    cursor: { glideMs: 0 },
    policy: { blockedApps: ['taskmgr.exe'] },
    observation: { maxElements: 100 },
  })

  assert.equal(config.cursor.glideMs, 0)
  assert.equal(config.cursor.enabled, true)
  assert.equal(config.cursor.theme, 'cua.default')
  assert.deepEqual(config.policy.blockedApps, ['taskmgr.exe'])
  assert.deepEqual(config.policy.allowedApps, [])
  assert.equal(config.policy.maxActionsPerMinute, 60)
  assert.equal(config.observation.maxElements, 100)
  assert.equal(config.observation.ttlMs, 60000)
  assert.equal(config.backend.timeoutMs, 15000)
})

test('normalizeConfig expands ~ in audit.path', () => {
  const config = normalizeConfig({ audit: { path: '~/.dsh/computer/custom.jsonl' } })
  assert.equal(config.audit.path, resolve(home, '.dsh', 'computer', 'custom.jsonl'))
})

test('validateConfig reports problems without throwing', () => {
  assert.deepEqual(validateConfig({}), { ok: true, errors: [] })

  const result = validateConfig({
    approvals: { mode: 'bogus' },
    observation: { maxElements: 0 },
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /Invalid approvals\.mode/)
  assert.match(result.errors.join('\n'), /Invalid observation\.maxElements/)
})
