import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DSH_REQUIREMENT,
  IncompatibleDshError,
  assertCompatible,
  detectCapabilities,
  detectDshVersion,
} from '../lib/compat.js'
import { compareVersions, parseVersion, satisfiesRange } from '../lib/install/version.js'

test('parseVersion parses release, prerelease, build metadata and v prefix', () => {
  assert.deepEqual(parseVersion('0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, prerelease: 'rc.2' })
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null })
  assert.deepEqual(parseVersion('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: null })
  assert.equal(parseVersion('1.2'), null)
  assert.equal(parseVersion('not-a-version'), null)
  assert.equal(parseVersion(undefined), null)
})

test('compareVersions orders numeric components numerically', () => {
  assert.ok(compareVersions(parseVersion('0.2.10'), parseVersion('0.2.9')) > 0)
  assert.ok(compareVersions(parseVersion('0.10.0'), parseVersion('0.9.9')) > 0)
  assert.equal(compareVersions(parseVersion('0.2.1'), parseVersion('0.2.1')), 0)
})

test('compareVersions treats a release as greater than its prereleases', () => {
  assert.ok(compareVersions(parseVersion('0.2.1'), parseVersion('0.2.1-rc.2')) > 0)
  assert.ok(compareVersions(parseVersion('0.2.1-rc.2'), parseVersion('0.2.1-rc.1')) > 0)
})

test('satisfiesRange handles the DSH requirement range', () => {
  assert.equal(DSH_REQUIREMENT, '>=0.2.1-rc.2 <0.3.0')
  assert.equal(satisfiesRange(DSH_REQUIREMENT, '0.2.1-rc.2'), true)
  assert.equal(satisfiesRange(DSH_REQUIREMENT, '0.2.1'), true)
  assert.equal(satisfiesRange(DSH_REQUIREMENT, '0.2.9'), true)
  assert.equal(satisfiesRange(DSH_REQUIREMENT, '0.2.1-rc.1'), false)
  assert.equal(satisfiesRange(DSH_REQUIREMENT, '0.3.0'), false)
  assert.equal(satisfiesRange(DSH_REQUIREMENT, '0.1.9'), false)
})

test('satisfiesRange supports exact versions, caret and tilde', () => {
  assert.equal(satisfiesRange('0.2.1', '0.2.1'), true)
  assert.equal(satisfiesRange('0.2.1', '0.2.1-rc.2'), false)
  assert.equal(satisfiesRange('^0.2.1', '0.2.5'), true)
  assert.equal(satisfiesRange('^0.2.1', '0.3.0'), false)
  assert.equal(satisfiesRange('~0.2.1', '0.2.9'), true)
  assert.equal(satisfiesRange('~0.2.1', '0.3.0'), false)
  assert.equal(satisfiesRange('*', '9.9.9'), true)
  assert.equal(satisfiesRange('>=0.2.1', 'garbage'), false)
})

test('detectDshVersion prefers DSH_VERSION', async () => {
  const version = await detectDshVersion({ env: { DSH_VERSION: '0.2.1-rc.2' } })
  assert.equal(version, '0.2.1-rc.2')
})

test('detectDshVersion reads the app package.json when env path is provided', async () => {
  const version = await detectDshVersion({
    env: { DSH_APP_PACKAGE_JSON: 'C:/app/package.json' },
    readFile: async (path) => {
      assert.equal(path, 'C:/app/package.json')
      return JSON.stringify({ version: '0.2.1-rc.2' })
    },
  })
  assert.equal(version, '0.2.1-rc.2')
})

test('detectDshVersion falls back to exec and returns null when unknown', async () => {
  const version = await detectDshVersion({
    env: {},
    exec: async (command) => {
      assert.equal(command, 'dsh --version')
      return 'dsh 0.2.1-rc.2'
    },
  })
  assert.equal(version, '0.2.1-rc.2')
  assert.equal(await detectDshVersion({ env: {}, readFile: async () => '{}' }), null)
  assert.equal(await detectDshVersion({ env: {}, exec: async () => 'no version here' }), null)
})

test('detectCapabilities checks the injected host services', () => {
  const all = detectCapabilities({
    approval: { request: async () => ({}) },
    attachments: { saveImage: async () => ({}) },
    tools: { register: () => {} },
  })
  assert.deepEqual(all, { approval: true, attachments: true, tools: true })

  const none = detectCapabilities({})
  assert.deepEqual(none, { approval: false, attachments: false, tools: false })
  assert.deepEqual(detectCapabilities(), { approval: false, attachments: false, tools: false })
})

test('assertCompatible throws a typed error with version and requirements', () => {
  assert.equal(assertCompatible('0.2.1-rc.2'), '0.2.1-rc.2')
  assert.throws(
    () => assertCompatible('0.3.0'),
    (error) => {
      assert.ok(error instanceof IncompatibleDshError)
      assert.equal(error.name, 'IncompatibleDshError')
      assert.equal(error.code, 'incompatible-version')
      assert.equal(error.runtimeVersion, '0.3.0')
      assert.equal(error.requirements, DSH_REQUIREMENT)
      return true
    },
  )
  assert.throws(() => assertCompatible(null), /unknown/)
})
