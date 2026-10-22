import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { selectVersion } from '../lib/update/compat.js'
import {
  IntegrityError,
  installVersion,
  needsRollback,
  recordHeartbeat,
  rollback,
  switchCurrent,
} from '../lib/update/install.js'
import { printError, printResult, runUpdate } from '../scripts/update.mjs'

const execFileAsync = promisify(execFile)
const PACKAGE_NAME = 'dsh-computer'
const DSH_VERSION = '0.2.2'

/** sha256 of bytes / a file, lowercase hex. */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Fake fetch response for raw bytes. */
function bytesResponse(bytes, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => Buffer.from(bytes).toString('utf8'),
  }
}

/** Fake fetchImpl that always returns the same bytes. */
function fetchBytes(bytes, status = 200) {
  return async () => bytesResponse(bytes, status)
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function linkPointsTo(linkPath, target) {
  const actual = resolve(dirname(linkPath), await readlink(linkPath))
  return process.platform === 'win32'
    ? actual.toLowerCase() === resolve(target).toLowerCase()
    : actual === resolve(target)
}

/** Capture console.log/error while running a synchronous printer function. */
function captureConsole(fn) {
  const logs = []
  const errors = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => errors.push(args.join(' '))
  try {
    fn()
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  return { logs, errors }
}

/** Create a scratch DSH layout. Nothing here touches the real `~/.dsh`. */
async function createLayout(t, options = {}) {
  const { version = '0.1.0', patch = 'plugins:\n  existing: true\n', profile = 'desktop' } = options
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const home = join(root, 'home')
  const dshHome = join(home, '.dsh')
  const pluginsDir = join(dshHome, 'plugins')
  const profileDir = join(dshHome, 'profiles', profile)
  const profileNodeModules = join(profileDir, 'node_modules')
  const stateDir = join(dshHome, 'computer', 'update')
  const patchPath = join(dshHome, 'cordis.patch.yml')

  await mkdir(pluginsDir, { recursive: true })
  await mkdir(profileNodeModules, { recursive: true })
  if (patch !== null) {
    await mkdir(dirname(patchPath), { recursive: true })
    await writeFile(patchPath, patch, 'utf8')
  }

  let versionDir = null
  if (version !== null) {
    versionDir = await installPackageDir(pluginsDir, version)
    await symlink(
      versionDir,
      join(profileNodeModules, PACKAGE_NAME),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }

  return {
    root,
    home,
    dshHome,
    pluginsDir,
    profile,
    profileDir,
    profileNodeModules,
    stateDir,
    patchPath,
    versionDir,
    linkPath: join(profileNodeModules, PACKAGE_NAME),
  }
}

async function installPackageDir(pluginsDir, version, name = PACKAGE_NAME) {
  const dir = join(pluginsDir, `${PACKAGE_NAME}-${version}`)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'package.json'), { name, version })
  await writeFile(join(dir, 'index.js'), 'export default 1\n', 'utf8')
  return dir
}

/** Build a real npm-style tarball (`package/` prefix) with the system tar. */
async function makeTarball(root, version, options = {}) {
  const { name = PACKAGE_NAME, prefix = 'package' } = options
  const staging = await mkdtemp(join(root, 'stage-'))
  const packageDir = join(staging, prefix)
  await mkdir(packageDir, { recursive: true })
  await writeJson(join(packageDir, 'package.json'), { name, version })
  await writeFile(join(packageDir, 'index.js'), 'export default 1\n', 'utf8')

  const tarballName = `${PACKAGE_NAME}-${version}.tgz`
  await execFileAsync('tar', ['-czf', tarballName, prefix], { cwd: staging })
  return join(staging, tarballName)
}

/** Inject an extractor: writes the package.json the install must validate. */
function extractAs(version, name = PACKAGE_NAME) {
  return async (_tarballPath, destDir) => {
    await writeJson(join(destDir, 'package.json'), { name, version })
    await writeFile(join(destDir, 'index.js'), 'export default 1\n', 'utf8')
  }
}

function manifest(entries) {
  return { versions: entries }
}

function release(version, options = {}) {
  const { dsh = '>=0.2.1-rc.2 <0.3.0', tarball = `https://releases.test/${PACKAGE_NAME}-${version}.tgz` } = options
  return { version, dsh, tarball, sha256: sha256(Buffer.from(`tarball-${version}`)) }
}

// ---------------------------------------------------------------- selectVersion

test('selectVersion picks the highest version whose dsh range matches', () => {
  const selected = selectVersion(
    manifest([
      release('0.1.9'),
      release('0.3.0', { dsh: '>=0.3.0 <0.4.0' }),
      release('0.2.0'),
    ]),
    DSH_VERSION,
  )

  assert.deepEqual(selected, {
    version: '0.2.0',
    tarball: `https://releases.test/${PACKAGE_NAME}-0.2.0.tgz`,
    sha256: sha256(Buffer.from('tarball-0.2.0')),
  })
})

test('selectVersion returns null when no release supports the current DSH', () => {
  const selected = selectVersion(
    manifest([release('0.3.0', { dsh: '>=0.3.0 <0.4.0' }), release('0.4.0', { dsh: '>=0.4.0' })]),
    DSH_VERSION,
  )

  assert.equal(selected, null)
})

test('selectVersion orders prerelease identifiers numerically', () => {
  const selected = selectVersion(
    manifest([
      release('0.2.0'),
      release('0.2.1-rc.1', { dsh: '>=0.2.1-rc.1 <0.3.0' }),
      release('0.2.1-rc.3', { dsh: '>=0.2.1-rc.1 <0.3.0' }),
    ]),
    DSH_VERSION,
  )

  assert.equal(selected.version, '0.2.1-rc.3')
})

test('selectVersion prefers a stable release over a prerelease of the same version', () => {
  const selected = selectVersion(
    manifest([
      release('0.2.1-rc.3', { dsh: '>=0.2.1-rc.1 <0.3.0' }),
      release('0.2.1'),
    ]),
    DSH_VERSION,
  )

  assert.equal(selected.version, '0.2.1')
})

test('selectVersion fails closed on an unknown DSH version or a malformed entry', () => {
  const entries = [
    { version: '0.2.0', dsh: '>=0.2.1-rc.2 <0.3.0', tarball: 'https://releases.test/x.tgz' },
    { version: 'not-a-version', dsh: '*', tarball: 'https://releases.test/y.tgz', sha256: 'a'.repeat(64) },
    null,
  ]

  assert.equal(selectVersion(manifest(entries), DSH_VERSION), null)
  assert.equal(selectVersion(manifest([release('0.2.0')]), null), null)
  assert.equal(selectVersion({}, DSH_VERSION), null)
})

// ---------------------------------------------------------------- installVersion

test('installVersion downloads, verifies and installs into pluginsDir', async (t) => {
  const layout = await createLayout(t, { version: null })
  const bytes = Buffer.from('fake-tarball-bytes')
  const cacheDir = join(layout.stateDir, 'cache')
  const calls = []

  const result = await installVersion({
    cacheDir,
    pluginsDir: layout.pluginsDir,
    tarballUrl: 'https://releases.test/dsh-computer-0.2.0.tgz',
    sha256: sha256(bytes),
    fetchImpl: async (url) => {
      calls.push(url)
      return bytesResponse(bytes)
    },
    extractImpl: extractAs('0.2.0'),
    version: '0.2.0',
  })

  assert.deepEqual(calls, ['https://releases.test/dsh-computer-0.2.0.tgz'])
  assert.equal(result.version, '0.2.0')
  assert.equal(result.path, join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`))
  assert.equal(await exists(join(result.path, 'package.json')), true)
  assert.equal(sha256(await readFile(join(cacheDir, `${PACKAGE_NAME}-0.2.0.tgz`))), sha256(bytes))
})

test('installVersion rejects a sha256 mismatch without leaving a partial install', async (t) => {
  const layout = await createLayout(t, { version: null })
  const bytes = Buffer.from('fake-tarball-bytes')

  await assert.rejects(
    installVersion({
      cacheDir: join(layout.stateDir, 'cache'),
      pluginsDir: layout.pluginsDir,
      tarballUrl: 'https://releases.test/dsh-computer-0.2.0.tgz',
      sha256: 'b'.repeat(64),
      fetchImpl: fetchBytes(bytes),
      extractImpl: extractAs('0.2.0'),
      version: '0.2.0',
    }),
    (error) => {
      assert.ok(error instanceof IntegrityError)
      assert.equal(error.name, 'IntegrityError')
      assert.equal(error.expectedSha256, 'b'.repeat(64))
      assert.equal(error.actualSha256, sha256(bytes))
      return true
    },
  )

  assert.equal(await exists(join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`)), false)
  assert.deepEqual(
    (await readdir(layout.pluginsDir)).filter((name) => name.startsWith('.install-')),
    [],
  )
})

test('installVersion reuses an existing identical version without downloading', async (t) => {
  const layout = await createLayout(t, { version: null })
  const existing = await installPackageDir(layout.pluginsDir, '0.2.0')

  const result = await installVersion({
    cacheDir: join(layout.stateDir, 'cache'),
    pluginsDir: layout.pluginsDir,
    tarballUrl: 'https://releases.test/dsh-computer-0.2.0.tgz',
    sha256: sha256(Buffer.from('unused')),
    fetchImpl: async () => {
      throw new Error('fetch must not run for an existing identical install')
    },
    extractImpl: extractAs('0.2.0'),
    version: '0.2.0',
  })

  assert.equal(result.path, existing)
})

test('installVersion rejects a tarball whose package identity does not match', async (t) => {
  const layout = await createLayout(t, { version: null })
  const bytes = Buffer.from('fake-tarball-bytes')

  await assert.rejects(
    installVersion({
      cacheDir: join(layout.stateDir, 'cache'),
      pluginsDir: layout.pluginsDir,
      tarballUrl: 'https://releases.test/dsh-computer-0.2.0.tgz',
      sha256: sha256(bytes),
      fetchImpl: fetchBytes(bytes),
      extractImpl: extractAs('0.2.0', 'some-other-package'),
      version: '0.2.0',
    }),
    /package name/,
  )

  assert.equal(await exists(join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`)), false)
  assert.deepEqual(
    (await readdir(layout.pluginsDir)).filter((name) => name.startsWith('.install-')),
    [],
  )
})

test('installVersion extracts a real npm-style tarball with the system tar', async (t) => {
  const layout = await createLayout(t, { version: null })
  const tarballPath = await makeTarball(layout.root, '0.3.0')
  const bytes = await readFile(tarballPath)

  const result = await installVersion({
    cacheDir: join(layout.stateDir, 'cache'),
    pluginsDir: layout.pluginsDir,
    tarballUrl: 'https://releases.test/dsh-computer-0.3.0.tgz',
    sha256: sha256(bytes),
    fetchImpl: fetchBytes(bytes),
    version: '0.3.0',
  })

  assert.deepEqual(await readJson(join(result.path, 'package.json')), {
    name: PACKAGE_NAME,
    version: '0.3.0',
  })
  assert.equal(await exists(join(result.path, 'package')), false)
})

// ---------------------------------------------------------------- switchCurrent

test('switchCurrent repoints the link atomically and records the previous version', async (t) => {
  const layout = await createLayout(t)
  const next = await installPackageDir(layout.pluginsDir, '0.2.0')

  const result = await switchCurrent({
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    version: '0.2.0',
    stateDir: layout.stateDir,
  })

  assert.equal(result.changed, true)
  assert.equal(result.previous, '0.1.0')
  assert.equal(await linkPointsTo(layout.linkPath, next), true)

  const previous = await readJson(join(layout.stateDir, 'previous.json'))
  assert.equal(previous.version, '0.1.0')
  assert.equal(previous.path, layout.versionDir)
  assert.equal((await readJson(join(layout.stateDir, 'pending.json'))).version, '0.2.0')

  assert.deepEqual(
    (await readdir(layout.profileNodeModules)).filter((name) => name.includes('.tmp-')),
    [],
  )
})

test('switchCurrent refuses to replace a real directory at the link path', async (t) => {
  const layout = await createLayout(t, { version: null })
  await mkdir(layout.linkPath, { recursive: true })
  await installPackageDir(layout.pluginsDir, '0.2.0')

  await assert.rejects(
    switchCurrent({
      pluginsDir: layout.pluginsDir,
      profileNodeModules: layout.profileNodeModules,
      version: '0.2.0',
      stateDir: layout.stateDir,
    }),
    /non-link/,
  )
})

// ---------------------------------------------------------------- heartbeat

test('recordHeartbeat writes heartbeat JSON atomically', async (t) => {
  const layout = await createLayout(t, { version: null })
  const now = () => new Date('2026-10-22T00:00:00.000Z')

  const result = await recordHeartbeat({
    stateDir: layout.stateDir,
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    now,
  })

  assert.equal(result.path, join(layout.stateDir, 'heartbeat.json'))
  assert.deepEqual(await readJson(result.path), {
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    source: 'runtime',
    at: '2026-10-22T00:00:00.000Z',
  })
  assert.deepEqual(
    (await readdir(layout.stateDir)).filter((name) => name.includes('.tmp-')),
    [],
  )
})

test('needsRollback is true only for a pending switch without a fresh heartbeat', async (t) => {
  const layout = await createLayout(t, { version: null })
  const now = () => new Date('2026-10-22T00:10:00.000Z')

  assert.equal(await needsRollback({ stateDir: layout.stateDir, now }), false)

  await mkdir(layout.stateDir, { recursive: true })
  await writeJson(join(layout.stateDir, 'pending.json'), { version: '0.2.0', at: now().toISOString() })
  assert.equal(await needsRollback({ stateDir: layout.stateDir, now }), true)

  await writeJson(join(layout.stateDir, 'heartbeat.json'), {
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    source: 'runtime',
    at: '2026-10-22T00:09:00.000Z',
  })
  assert.equal(await needsRollback({ stateDir: layout.stateDir, now }), false)

  await writeJson(join(layout.stateDir, 'heartbeat.json'), {
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    source: 'runtime',
    at: '2026-10-21T23:50:00.000Z',
  })
  assert.equal(await needsRollback({ stateDir: layout.stateDir, now }), true)
})

test('needsRollback does not accept an updater-source heartbeat as confirmation', async (t) => {
  const layout = await createLayout(t, { version: null })
  const now = () => new Date('2026-10-22T00:10:00.000Z')
  await mkdir(layout.stateDir, { recursive: true })
  await writeJson(join(layout.stateDir, 'pending.json'), {
    version: '0.2.0',
    at: '2026-10-22T00:09:00.000Z',
  })

  // The updater writes its own heartbeat after switching; that must never be
  // mistaken for the runtime confirming the new version.
  await writeJson(join(layout.stateDir, 'heartbeat.json'), {
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    source: 'updater',
    at: '2026-10-22T00:09:30.000Z',
  })
  assert.equal(await needsRollback({ stateDir: layout.stateDir, now }), true)

  await writeJson(join(layout.stateDir, 'heartbeat.json'), {
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    at: '2026-10-22T00:09:30.000Z',
  })
  assert.equal(await needsRollback({ stateDir: layout.stateDir, now }), true)
})

// ---------------------------------------------------------------- rollback

test('rollback restores the previous link and patch backup, then is idempotent', async (t) => {
  const layout = await createLayout(t)
  const next = await installPackageDir(layout.pluginsDir, '0.2.0')
  const patchBackupPath = join(layout.stateDir, 'patch-before.yml')
  await mkdir(layout.stateDir, { recursive: true })
  await writeFile(patchBackupPath, 'plugins:\n  existing: true\n', 'utf8')

  await switchCurrent({
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    version: '0.2.0',
    stateDir: layout.stateDir,
    patchBackupPath,
  })
  assert.equal(await linkPointsTo(layout.linkPath, next), true)
  await writeFile(layout.patchPath, 'plugins:\n  existing: false\n', 'utf8')

  const result = await rollback({
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    stateDir: layout.stateDir,
  })

  assert.equal(result.restored, '0.1.0')
  assert.equal(result.patch, layout.patchPath)
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
  assert.deepEqual(
    (await readdir(layout.profileNodeModules)).filter((name) => name.includes('.tmp-')),
    [],
  )
  assert.equal(await readFile(layout.patchPath, 'utf8'), 'plugins:\n  existing: true\n')
  assert.equal(await exists(join(layout.stateDir, 'pending.json')), false)
  assert.equal(await exists(join(layout.stateDir, 'previous.json')), false)

  const again = await rollback({
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    stateDir: layout.stateDir,
  })
  assert.deepEqual(again, { restored: null, patch: null })
})

test('rollback clears a pending marker that has no previous version', async (t) => {
  const layout = await createLayout(t, { version: null })
  await mkdir(layout.stateDir, { recursive: true })
  await writeJson(join(layout.stateDir, 'pending.json'), {
    version: '0.2.0',
    at: '2026-10-22T00:00:00.000Z',
  })

  const result = await rollback({
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    stateDir: layout.stateDir,
  })

  assert.deepEqual(result, { restored: null, patch: null })
  assert.equal(await exists(join(layout.stateDir, 'pending.json')), false)
})

// ---------------------------------------------------------------- CLI

test('runUpdate --apply refuses to switch while DSH is running', async (t) => {
  const layout = await createLayout(t)
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(
    manifestPath,
    manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]),
  )
  let fetched = false

  await assert.rejects(
    runUpdate({
      argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
      env: { DSH_VERSION },
      fetchImpl: async () => {
        fetched = true
        return bytesResponse(targetBytes)
      },
      isDshRunning: async () => true,
      extractImpl: extractAs('0.2.0'),
    }),
    /DSH is running/,
  )

  assert.equal(fetched, false)
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
  assert.equal(await exists(join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`)), false)
})

test('runUpdate --apply downloads, switches and records a heartbeat', async (t) => {
  const layout = await createLayout(t)
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestText = JSON.stringify(
    manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]),
  )
  const now = () => new Date('2026-10-22T00:00:00.000Z')

  const result = await runUpdate({
    argv: ['--home', layout.home, '--manifest', 'https://releases.test/manifest.json', '--apply'],
    env: { DSH_VERSION },
    fetchImpl: async (url) => {
      if (url === 'https://releases.test/manifest.json') return bytesResponse(Buffer.from(manifestText))
      if (url === `https://releases.test/${PACKAGE_NAME}-0.2.0.tgz`) return bytesResponse(targetBytes)
      throw new Error(`unexpected url: ${url}`)
    },
    extractImpl: extractAs('0.2.0'),
    isDshRunning: async () => false,
    now,
  })

  assert.equal(result.action, 'apply')
  assert.equal(result.changed, true)
  assert.equal(result.from, '0.1.0')
  assert.equal(result.to, '0.2.0')
  assert.equal(
    await linkPointsTo(layout.linkPath, join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`)),
    true,
  )

  const heartbeat = await readJson(join(layout.stateDir, 'heartbeat.json'))
  assert.equal(heartbeat.version, '0.2.0')
  assert.equal(heartbeat.dshVersion, DSH_VERSION)
  assert.equal(heartbeat.at, now().toISOString())
  assert.equal(await exists(join(layout.stateDir, 'pending.json')), false)

  const check = await runUpdate({
    argv: ['--home', layout.home, '--manifest', 'https://releases.test/manifest.json', '--check'],
    env: { DSH_VERSION },
    fetchImpl: async () => bytesResponse(Buffer.from(manifestText)),
    isDshRunning: async () => false,
    now,
  })
  assert.equal(check.action, 'check')
  assert.equal(check.current, '0.2.0')
  assert.equal(check.changed, false)
  assert.equal(check.available.version, '0.2.0')
})

test('runUpdate --apply leaves the old version when integrity verification fails', async (t) => {
  const layout = await createLayout(t)
  const manifestPath = join(layout.root, 'manifest.json')
  const targetBytes = Buffer.from('tarball-0.2.0')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: 'c'.repeat(64) }]))

  await assert.rejects(
    runUpdate({
      argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
      env: { DSH_VERSION },
      fetchImpl: fetchBytes(targetBytes),
      extractImpl: extractAs('0.2.0'),
      isDshRunning: async () => false,
    }),
    (error) => {
      assert.ok(error instanceof IntegrityError)
      return true
    },
  )

  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
  assert.equal(await exists(join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`)), false)
  assert.equal(await exists(join(layout.stateDir, 'pending.json')), false)
})

test('runUpdate --rollback restores the previous install', async (t) => {
  const layout = await createLayout(t)
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]))

  const options = {
    env: { DSH_VERSION },
    fetchImpl: fetchBytes(targetBytes),
    extractImpl: extractAs('0.2.0'),
    isDshRunning: async () => false,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  }
  await runUpdate({
    ...options,
    argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
  })

  const result = await runUpdate({
    ...options,
    argv: ['--home', layout.home, '--rollback'],
  })

  assert.equal(result.action, 'rollback')
  assert.equal(result.restored, '0.1.0')
  assert.equal(result.patch, layout.patchPath)
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
  assert.equal(await readFile(layout.patchPath, 'utf8'), 'plugins:\n  existing: true\n')
})

test('runUpdate defaults to refusing while a fresh runtime heartbeat exists', async (t) => {
  const layout = await createLayout(t)
  const now = () => new Date('2026-10-22T00:10:00.000Z')
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]))
  await mkdir(layout.stateDir, { recursive: true })
  await writeJson(join(layout.stateDir, 'heartbeat.json'), {
    version: '0.1.0',
    dshVersion: DSH_VERSION,
    source: 'runtime',
    at: '2026-10-22T00:09:00.000Z',
  })

  await assert.rejects(
    runUpdate({
      argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
      env: { DSH_VERSION },
      fetchImpl: fetchBytes(targetBytes),
      extractImpl: extractAs('0.2.0'),
      now,
    }),
    /DSH is running/,
  )
})

test('runUpdate --apply is a no-op when the selected version is installed', async (t) => {
  const layout = await createLayout(t, { version: '0.2.0' })
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([release('0.2.0')]))
  let fetched = false

  const result = await runUpdate({
    argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
    env: { DSH_VERSION },
    fetchImpl: async () => {
      fetched = true
      return bytesResponse(Buffer.from('unused'))
    },
    isDshRunning: async () => false,
  })

  assert.deepEqual(result, {
    action: 'apply',
    changed: false,
    from: '0.2.0',
    to: '0.2.0',
    path: null,
  })
  assert.equal(fetched, false)
  assert.equal(await exists(join(layout.stateDir, 'pending.json')), false)
})

test('runUpdate --apply refuses while a previous update is unconfirmed', async (t) => {
  const layout = await createLayout(t)
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]))
  await mkdir(layout.stateDir, { recursive: true })
  await writeJson(join(layout.stateDir, 'pending.json'), {
    version: '0.2.0',
    at: '2026-10-22T00:00:00.000Z',
  })
  let fetched = false

  await assert.rejects(
    runUpdate({
      argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
      env: { DSH_VERSION },
      fetchImpl: async () => {
        fetched = true
        return bytesResponse(targetBytes)
      },
      extractImpl: extractAs('0.2.0'),
      isDshRunning: async () => false,
      now: () => new Date('2026-10-22T00:10:00.000Z'),
    }),
    /previous update is unconfirmed/,
  )

  assert.equal(fetched, false)
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
})

test('runUpdate --rollback is a no-op when nothing was switched', async (t) => {
  const layout = await createLayout(t)

  const result = await runUpdate({
    argv: ['--home', layout.home, '--rollback'],
    env: { DSH_VERSION },
  })

  assert.deepEqual(result, { action: 'rollback', restored: null, patch: null })
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
})

test('runUpdate --check detects DSH through the injected win32 cmd shim', async (t) => {
  const layout = await createLayout(t)
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([release('0.2.0')]))
  const calls = []

  const result = await runUpdate({
    argv: ['--home', layout.home, '--manifest', manifestPath, '--check'],
    env: {},
    platform: 'win32',
    execFile: async (file, args) => {
      calls.push([file, args])
      return { stdout: 'DeepSeek Harness 0.2.2\n' }
    },
  })

  assert.equal(result.dshVersion, '0.2.2')
  assert.equal(result.available.version, '0.2.0')
  assert.deepEqual(calls, [['cmd.exe', ['/d', '/s', '/c', 'dsh --version']]])
})

test('runUpdate --check detects DSH from <dshHome>/version before PATH', async (t) => {
  const layout = await createLayout(t)
  await writeFile(join(layout.dshHome, 'version'), '0.2.2\n', 'utf8')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([release('0.2.0')]))
  let execCalled = false

  const result = await runUpdate({
    argv: ['--home', layout.home, '--manifest', manifestPath, '--check'],
    env: {},
    execFile: async () => {
      execCalled = true
      return { stdout: '0.3.0' }
    },
  })

  assert.equal(result.dshVersion, '0.2.2')
  assert.equal(execCalled, false)
})

test('runUpdate --apply switches a non-default profile', async (t) => {
  const layout = await createLayout(t, { profile: 'beta' })
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]))

  const result = await runUpdate({
    argv: ['--home', layout.home, '--profile', 'beta', '--manifest', manifestPath, '--apply'],
    env: { DSH_VERSION },
    fetchImpl: fetchBytes(targetBytes),
    extractImpl: extractAs('0.2.0'),
    isDshRunning: async () => false,
  })

  assert.equal(result.from, '0.1.0')
  assert.equal(result.to, '0.2.0')
  assert.equal(
    await linkPointsTo(layout.linkPath, join(layout.pluginsDir, `${PACKAGE_NAME}-0.2.0`)),
    true,
  )
  // The default profile is untouched when --profile selects another one.
  assert.equal(
    await exists(join(layout.dshHome, 'profiles', 'desktop', 'node_modules', PACKAGE_NAME)),
    false,
  )
})

test('runUpdate --patch backs up and restores the configured patch file', async (t) => {
  const layout = await createLayout(t)
  const customPatch = join(layout.root, 'custom', 'cordis.patch.yml')
  await mkdir(dirname(customPatch), { recursive: true })
  await writeFile(customPatch, 'plugins:\n  custom: true\n', 'utf8')
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]))

  const options = {
    env: { DSH_VERSION },
    fetchImpl: fetchBytes(targetBytes),
    extractImpl: extractAs('0.2.0'),
    isDshRunning: async () => false,
  }
  await runUpdate({
    ...options,
    argv: ['--home', layout.home, '--patch', customPatch, '--manifest', manifestPath, '--apply'],
  })

  // The default patch file was not the configured one, so it was not backed up.
  assert.equal(await readFile(layout.patchPath, 'utf8'), 'plugins:\n  existing: true\n')
  await writeFile(customPatch, 'plugins:\n  custom: false\n', 'utf8')

  const result = await runUpdate({
    ...options,
    argv: ['--home', layout.home, '--patch', customPatch, '--rollback'],
  })

  assert.equal(result.restored, '0.1.0')
  assert.equal(result.patch, customPatch)
  assert.equal(await readFile(customPatch, 'utf8'), 'plugins:\n  custom: true\n')
})

test('runUpdate --apply refuses to overwrite previous.json while a switch is unconfirmed', async (t) => {
  const layout = await createLayout(t)
  const targetBytes = Buffer.from('tarball-0.2.0')
  const manifestPath = join(layout.root, 'manifest.json')
  await writeJson(manifestPath, manifest([{ ...release('0.2.0'), sha256: sha256(targetBytes) }]))
  const now = () => new Date('2026-10-22T00:10:00.000Z')
  await mkdir(layout.stateDir, { recursive: true })
  const previous = {
    version: '0.1.0',
    path: layout.versionDir,
    patchBackup: null,
    at: '2026-10-22T00:00:00.000Z',
  }
  await writeJson(join(layout.stateDir, 'previous.json'), previous)
  await writeJson(join(layout.stateDir, 'pending.json'), {
    version: '0.2.0',
    at: '2026-10-22T00:00:00.000Z',
  })
  // A fresh heartbeat from the updater itself must not be treated as runtime
  // confirmation, so --apply has to refuse instead of replacing previous.json.
  await writeJson(join(layout.stateDir, 'heartbeat.json'), {
    version: '0.2.0',
    dshVersion: DSH_VERSION,
    source: 'updater',
    at: '2026-10-22T00:09:30.000Z',
  })
  let fetched = false

  await assert.rejects(
    runUpdate({
      argv: ['--home', layout.home, '--manifest', manifestPath, '--apply'],
      env: { DSH_VERSION },
      fetchImpl: async () => {
        fetched = true
        return bytesResponse(targetBytes)
      },
      extractImpl: extractAs('0.2.0'),
      now,
    }),
    /previous update is unconfirmed/,
  )

  assert.equal(fetched, false)
  assert.deepEqual(await readJson(join(layout.stateDir, 'previous.json')), previous)
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
})

test('printResult --check reports an unknown DSH version instead of no release', () => {
  const { logs } = captureConsole(() => {
    printResult(
      { action: 'check', current: null, dshVersion: null, available: null, changed: false },
      false,
    )
  })

  assert.ok(logs.some((line) => line.includes('dsh: unknown')))
  assert.ok(logs.some((line) => line.includes('available: unknown')))
  assert.ok(!logs.some((line) => line.includes('no release supports')))
})

test('printError emits {ok:false,error} for --json failures', () => {
  const json = captureConsole(() => printError(new Error('boom'), true))
  assert.deepEqual(JSON.parse(json.logs[0]), { ok: false, error: 'boom' })

  const human = captureConsole(() => printError(new Error('boom'), false))
  assert.deepEqual(human.logs, [])
  assert.deepEqual(human.errors, ['update: boom'])
})
