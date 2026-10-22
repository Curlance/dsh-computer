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

test('satisfiesRange fails closed for invalid ranges', () => {
  assert.equal(satisfiesRange(null, '1.0.0'), false)
  assert.equal(satisfiesRange(undefined, '1.0.0'), false)
  assert.equal(satisfiesRange(123, '1.0.0'), false)
  assert.equal(satisfiesRange('not-a-range', '1.0.0'), false)
  assert.equal(satisfiesRange('', '1.0.0'), true)
  assert.equal(satisfiesRange('*', '1.0.0'), true)
})

test('satisfiesRange applies npm caret semantics to 0.0.x', () => {
  assert.equal(satisfiesRange('^0.0.3', '0.0.3'), true)
  assert.equal(satisfiesRange('^0.0.3', '0.0.4'), false)
  assert.equal(satisfiesRange('^0.0.3', '0.1.0'), false)
  assert.equal(satisfiesRange('^0.2.1', '0.2.9'), true)
  assert.equal(satisfiesRange('^0.2.1', '0.3.0'), false)
  assert.equal(satisfiesRange('^1.2.3', '1.9.9'), true)
  assert.equal(satisfiesRange('^1.2.3', '2.0.0'), false)
})

test('caret keeps prerelease bounds inclusive of the requested prerelease', () => {
  assert.equal(satisfiesRange('^0.2.1-rc.2', '0.2.1-rc.2'), true)
  assert.equal(satisfiesRange('^0.2.1-rc.2', '0.2.1-rc.1'), false)
  assert.equal(satisfiesRange('^0.2.1-rc.2', '0.2.1'), true)
  assert.equal(satisfiesRange('^0.2.1-rc.2', '0.3.0'), false)
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

test('detectDshVersion resolves conflicting sources in documented order', async () => {
  const calls = []
  const version = await detectDshVersion({
    env: { DSH_VERSION: '0.2.1-rc.2', DSH_APP_PACKAGE_JSON: 'pkg.json' },
    readFile: async () => {
      calls.push('readFile')
      return JSON.stringify({ version: '0.1.0' })
    },
    exec: async () => {
      calls.push('exec')
      return '0.0.1'
    },
  })
  assert.equal(version, '0.2.1-rc.2')
  assert.deepEqual(calls, [])
})

test('detectDshVersion skips invalid env and uses a valid file version', async () => {
  const version = await detectDshVersion({
    env: { DSH_VERSION: 'invalid', DSH_APP_PACKAGE_JSON: 'pkg.json' },
    readFile: async () => JSON.stringify({ version: '0.2.1-rc.2' }),
    exec: async () => 'not a version',
  })
  assert.equal(version, '0.2.1-rc.2')
})

test('detectDshVersion falls back to exec when the package file is invalid', async () => {
  const version = await detectDshVersion({
    env: { DSH_APP_PACKAGE_JSON: 'pkg.json' },
    readFile: async () => '{ not json',
    exec: async () => 'dsh 0.2.1-rc.2',
  })
  assert.equal(version, '0.2.1-rc.2')
})

test('detectDshVersion returns null when every source throws', async () => {
  const version = await detectDshVersion({
    env: { DSH_APP_PACKAGE_JSON: 'pkg.json' },
    readFile: async () => {
      throw new Error('ENOENT')
    },
    exec: async () => {
      throw new Error('spawn ENOENT')
    },
  })
  assert.equal(version, null)
})

test('detectDshVersion tolerates missing options', async () => {
  assert.equal(await detectDshVersion(), null)
  assert.equal(await detectDshVersion(null), null)
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
  assert.throws(() => assertCompatible(null), (error) => {
    assert.equal(error.runtimeVersion, null)
    assert.match(error.message, /unknown/)
    return true
  })
})

test('assertCompatible rejects null requirements instead of failing open', () => {
  assert.throws(
    () => assertCompatible('0.3.0', null),
    (error) => error instanceof IncompatibleDshError && error.requirements === null,
  )
})
