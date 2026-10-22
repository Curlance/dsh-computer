import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { doctor } from '../scripts/doctor.mjs'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const INSTALL = join(REPO_ROOT, 'scripts', 'install.mjs')
const UNINSTALL = join(REPO_ROOT, 'scripts', 'uninstall.mjs')
const PACKAGE = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
const DSH_VERSION = '0.2.1-rc.2'

const USER_PATCH = 'plugins:\n  existing: true\n'

/**
 * A scratch HOME with a DSH-like layout. The fake `@deepseek-ai/dsh` package is
 * what doctor's package.json fallback reads; nothing here touches the real
 * `~/.dsh`.
 */
async function createHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-install-e2e-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  const dshPackageDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(dshPackageDir, { recursive: true })
  const dshPackageJson = join(dshPackageDir, 'package.json')
  await writeFile(
    dshPackageJson,
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION }, null, 2)}\n`,
  )
  await writeFile(join(dshHome, 'cordis.patch.yml'), USER_PATCH)

  return {
    home,
    dshHome,
    profileDir,
    dshPackageJson,
    patchPath: join(dshHome, 'cordis.patch.yml'),
    versionDir: join(dshHome, 'plugins', PACKAGE.name, PACKAGE.version),
    linkPath: join(profileDir, 'node_modules', PACKAGE.name),
  }
}

async function linkPointsTo(linkPath, target) {
  const actual = resolve(dirname(linkPath), await readlink(linkPath))
  return process.platform === 'win32'
    ? actual.toLowerCase() === resolve(target).toLowerCase()
    : actual === resolve(target)
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

function checksByName(result) {
  return Object.fromEntries(result.checks.map((check) => [check.name, check]))
}

async function install(home) {
  return run(process.execPath, [INSTALL, '--home', home], { cwd: REPO_ROOT })
}

async function uninstall(home) {
  return run(process.execPath, [UNINSTALL, '--home', home], { cwd: REPO_ROOT })
}

test('install writes the managed root row, version dir and profile link', async (t) => {
  const layout = await createHome(t)

  const { stdout } = await install(layout.home)
  assert.match(stdout, new RegExp(`copy: ${PACKAGE.name}@${PACKAGE.version}`))

  const patch = await readFile(layout.patchPath, 'utf8')
  assert.match(patch, /^# >>> dsh-computer \(managed\)$/m)
  assert.match(patch, /^\s+- id: dsh-computer$/m)
  assert.match(patch, /^\s+name: dsh-computer$/m)
  assert.doesNotMatch(patch, /preset-computer-use/)
  assert.match(patch, /^plugins:\n {2}existing: true$/m)

  const installed = JSON.parse(await readFile(join(layout.versionDir, 'package.json'), 'utf8'))
  assert.equal(installed.name, PACKAGE.name)
  assert.equal(installed.version, PACKAGE.version)
  assert.ok(await exists(join(layout.versionDir, 'lib', 'host.js')))

  assert.ok((await lstat(layout.linkPath)).isSymbolicLink())
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
})

test('repeated install is idempotent', async (t) => {
  const layout = await createHome(t)

  await install(layout.home)
  const firstPatch = await readFile(layout.patchPath, 'utf8')
  const { stdout } = await install(layout.home)

  assert.match(stdout, /link unchanged:/)
  assert.match(stdout, /patch unchanged:/)
  assert.equal(await readFile(layout.patchPath, 'utf8'), firstPatch)
  assert.equal(await linkPointsTo(layout.linkPath, layout.versionDir), true)
})

test('uninstall removes the row/link/version dir and keeps a patch backup', async (t) => {
  const layout = await createHome(t)
  await install(layout.home)
  const installedPatch = await readFile(layout.patchPath, 'utf8')

  const { stdout } = await uninstall(layout.home)
  assert.match(stdout, /unlink:/)

  assert.equal(await readFile(layout.patchPath, 'utf8'), USER_PATCH)
  assert.equal(await exists(layout.linkPath), false)
  assert.equal(await exists(layout.versionDir), false)

  const backupDir = join(layout.dshHome, 'computer', 'backup')
  const backups = (await readdir(backupDir)).filter((name) => name.startsWith('patch-')).sort()
  assert.ok(backups.length >= 2, 'install and uninstall each keep a patch backup')
  assert.equal(await readFile(join(backupDir, backups[0]), 'utf8'), USER_PATCH)
  assert.equal(await readFile(join(backupDir, backups[backups.length - 1]), 'utf8'), installedPatch)
})

test('doctor reports every check ok for a completed install', async (t) => {
  const layout = await createHome(t)
  await install(layout.home)

  const result = await doctor({
    home: layout.home,
    profileDir: layout.profileDir,
    backend: { doctor: async () => ({ ok: true, detail: 'fake driver ready' }) },
    env: { DSH_APP_PACKAGE_JSON: layout.dshPackageJson },
  })

  assert.equal(result.ok, true)
  const checks = checksByName(result)
  for (const name of ['dsh-version', 'dsh-compat', 'cua-driver', 'cordis-patch', 'plugin-install']) {
    assert.ok(checks[name], `missing check ${name}`)
    assert.equal(checks[name].ok, true, `${name}: ${checks[name].detail}`)
    assert.equal(typeof checks[name].detail, 'string')
    assert.ok(checks[name].detail.length > 0)
  }
  assert.match(checks['dsh-version'].detail, new RegExp(DSH_VERSION))
  assert.match(checks['cua-driver'].detail, /fake driver ready/)
})

test('doctor finds cua-driver on PATH when no backend is injected', async (t) => {
  const layout = await createHome(t)
  await install(layout.home)

  const binDir = join(layout.home, 'bin')
  await mkdir(binDir, { recursive: true })
  await writeFile(
    join(binDir, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'),
    'fake driver',
  )

  const result = await doctor({
    home: layout.home,
    profileDir: layout.profileDir,
    env: { DSH_VERSION, PATH: binDir },
  })

  assert.equal(result.ok, true)
  const driver = checksByName(result)['cua-driver']
  assert.equal(driver.ok, true)
  assert.match(driver.detail, /cua-driver(\.exe)?$/)
})

test('doctor fails with actionable details when the environment is not installed', async (t) => {
  const layout = await createHome(t)

  const result = await doctor({
    home: layout.home,
    profileDir: layout.profileDir,
    backend: { doctor: async () => ({ ok: false, detail: 'fake driver missing' }) },
    env: { DSH_VERSION: '0.1.0' },
  })

  assert.equal(result.ok, false)
  const checks = checksByName(result)
  assert.equal(checks['dsh-version'].ok, true)
  assert.equal(checks['dsh-compat'].ok, false)
  assert.match(checks['dsh-compat'].detail, /does not satisfy/)
  assert.equal(checks['cua-driver'].ok, false)
  assert.match(checks['cua-driver'].detail, /fake driver missing/)
  assert.equal(checks['cordis-patch'].ok, false)
  assert.match(checks['cordis-patch'].detail, /install\.mjs/)
  assert.equal(checks['plugin-install'].ok, false)
  assert.match(checks['plugin-install'].detail, /install\.mjs/)
})

test('doctor CLI prints JSON and exits 1 when checks fail', async (t) => {
  const layout = await createHome(t)

  await assert.rejects(
    run(process.execPath, [join(REPO_ROOT, 'scripts', 'doctor.mjs'), '--home', layout.home, '--json'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DSH_VERSION: DSH_VERSION },
    }),
    (error) => {
      assert.equal(error.code, 1)
      const parsed = JSON.parse(error.stdout)
      assert.equal(parsed.ok, false)
      assert.ok(Array.isArray(parsed.checks))
      assert.ok(parsed.checks.some((check) => check.ok === false))
      return true
    },
  )
})
