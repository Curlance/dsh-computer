#!/usr/bin/env node
/**
 * `dsh-computer` doctor: verify a DSH install without starting the desktop.
 *
 * Checks each return `{name, ok, detail}`. A missing or broken install becomes a
 * failed check instead of a throw; unexpected filesystem errors still reject.
 *   - dsh-version     the DSH runtime version can be detected
 *   - dsh-compat      the detected DSH satisfies `lib/compat.js`'s requirement
 *   - cua-driver      an injected backend answers, or the driver executable exists
 *   - cordis-patch    `<dsh-home>/cordis.patch.yml` carries the managed root row
 *   - plugin-install  `<plugins>/dsh-computer/<version>` exists and the profile link points at it
 *
 * The CLI exits 1 when any check fails. `--json` prints the machine-readable result.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { DSH_REQUIREMENT } from '../lib/compat.js'
import { resolveDriverCommand } from '../lib/host.js'
import { MANAGED_BEGIN_RE, MANAGED_END_RE, ROW_ID_RE } from '../lib/install/patch.js'
import { parseVersion, satisfiesRange } from '../lib/install/version.js'

const PACKAGE_NAME = 'dsh-computer'
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_PROFILE = 'desktop'
const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/
// A manifest is only trusted as DSH's own: `@deepseek-ai/dsh*` or any
// deepseek+harness package name. Generic `<home>/package.json` must not win.
const DSH_PACKAGE_RE = /^@deepseek-ai\/dsh(?:-[a-z0-9.-]+)?$/

const USAGE = `Usage: node scripts/doctor.mjs [options]

Options:
  --home <path>     User home directory; DSH files live in <home>/.dsh
                    (default: $DSH_HOME, or ~/.dsh when DSH_HOME is unset)
  --profile <name>  DSH profile name (default: desktop)
  --json            Print the checks as JSON
  -h, --help        Show this help
`

const execFileAsync = promisify(execFile)
const defaultReadText = (path) => readFile(path, 'utf8')
const defaultExecFile = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { timeout: 5000, windowsHide: true })
  return stdout
}

/**
 * Detect the DSH runtime version. Priority (first valid version wins):
 *   1. env `DSH_VERSION`
 *   2. `env.DSH_APP_PACKAGE_JSON` (explicit package.json for packaged/dev hosts)
 *   3. known install files relative to the DSH home:
 *      `<dshHome>/version` (version sentinel),
 *      `<install-root>/resources/app/package.json` (unpacked desktop),
 *      `<install-root>/package.json` (portable/dev install).
 *      Package manifests are only accepted when `name` is a DSH package name,
 *      so an unrelated `<home>/package.json` is ignored.
 *   4. `dsh --version` from PATH; on win32 through
 *      `cmd.exe /d /s /c "dsh --version"` so the `.cmd` shim can launch
 *   5. null when nothing is detectable
 *
 * `readFile` and `execFile` are injectable so the order can be tested without a
 * real DSH install.
 *
 * @param {{dshHome?: string, env?: Record<string, string | undefined>,
 *          readFile?: (path: string) => Promise<string> | string,
 *          execFile?: (file: string, args: string[]) => Promise<any>,
 *          platform?: string}} [options]
 * @returns {Promise<string|null>}
 */
export async function detectDshVersion({
  dshHome,
  env = process.env,
  readFile: readText = defaultReadText,
  execFile: runExecFile = defaultExecFile,
  platform = process.platform,
} = {}) {
  const fromEnv = normaliseVersion(env?.DSH_VERSION)
  if (fromEnv !== null) return fromEnv

  const explicitPackage = env?.DSH_APP_PACKAGE_JSON
  if (typeof explicitPackage === 'string' && explicitPackage.length > 0) {
    const fromPackage = await readPackageVersion(explicitPackage, readText)
    if (fromPackage !== null) return fromPackage
  }

  if (typeof dshHome === 'string' && dshHome.length > 0) {
    const fromVersionFile = await readVersionFile(join(dshHome, 'version'), readText)
    if (fromVersionFile !== null) return fromVersionFile

    const installRoot = dirname(resolve(dshHome))
    for (const candidate of [
      join(installRoot, 'resources', 'app', 'package.json'),
      join(installRoot, 'package.json'),
    ]) {
      const fromPackage = await readPackageVersion(candidate, readText, { requireDshName: true })
      if (fromPackage !== null) return fromPackage
    }
  }

  try {
    const output =
      platform === 'win32'
        ? await runExecFile('cmd.exe', ['/d', '/s', '/c', 'dsh --version'])
        : await runExecFile('dsh', ['--version'])
    const text = typeof output === 'string' ? output : output?.stdout
    const fromExec = normaliseVersion(String(text ?? '').match(VERSION_RE)?.[0])
    if (fromExec !== null) return fromExec
  } catch {
    // dsh is not on PATH or has no --version: version stays unknown
  }

  return null
}

async function readPackageVersion(path, readText, { requireDshName = false } = {}) {
  try {
    const manifest = JSON.parse(await readText(path))
    if (requireDshName && !isDshManifestName(manifest?.name)) return null
    return normaliseVersion(manifest?.version)
  } catch {
    return null
  }
}

function isDshManifestName(name) {
  if (typeof name !== 'string') return false
  const value = name.trim().toLowerCase()
  return DSH_PACKAGE_RE.test(value) || (value.includes('deepseek') && value.includes('harness'))
}

async function readVersionFile(path, readText) {
  try {
    const text = String(await readText(path)).trim()
    const value = text.startsWith('{') ? JSON.parse(text)?.version : text.match(VERSION_RE)?.[0]
    return normaliseVersion(value)
  } catch {
    return null
  }
}

function normaliseVersion(value) {
  if (typeof value !== 'string') return null
  const candidate = value.trim().replace(/^v/, '')
  return parseVersion(candidate) ? candidate : null
}

/**
 * Inspect the DSH install rooted at `dshHome` (or at `<home>/.dsh`, or
 * `$DSH_HOME`, matching `scripts/install.mjs`).
 *
 * @param {{
 *   home?: string,
 *   dshHome?: string,
 *   profileDir?: string,
 *   backend?: {doctor?: () => any, ping?: () => any},
 *   patchPath?: string,
 *   env?: Record<string, string | undefined>,
 *   readFile?: (path: string) => Promise<string> | string,
 *   execFile?: (file: string, args: string[]) => Promise<any>,
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>}>}
 */
export async function doctor({
  home,
  dshHome,
  profileDir,
  backend,
  patchPath,
  env = process.env,
  readFile: readFileOption,
  execFile: runExecFile,
  exists = existsSync,
} = {}) {
  const resolvedDshHome = resolveDshHome({ dshHome, home, patchPath, profileDir, env })
  const userHome = resolveUserHome({ home, dshHome, env })
  const profile = profileDir === undefined ? join(resolvedDshHome, 'profiles', DEFAULT_PROFILE) : resolve(profileDir)
  const resolvedPatchPath =
    patchPath === undefined ? join(resolvedDshHome, 'cordis.patch.yml') : resolve(patchPath)

  const version = await detectDshVersion({
    dshHome: resolvedDshHome,
    env,
    readFile: readFileOption ?? defaultReadText,
    ...(runExecFile === undefined ? {} : { execFile: runExecFile }),
  })
  const manifest = await readManifest()
  const checks = [
    versionCheck(version),
    compatCheck(version),
    await driverCheck({ backend, home: userHome, env, exists }),
    await patchCheck(resolvedPatchPath),
    await pluginCheck({ dshHome: resolvedDshHome, profile, manifest }),
  ]

  return { ok: checks.every((check) => check.ok), checks }
}

/**
 * Mirror `scripts/install.mjs`: explicit DSH home wins, then `<home>/.dsh`, then
 * paths derived from the injected patch/profile, then `$DSH_HOME`, then `~/.dsh`.
 */
function resolveDshHome({ dshHome, home, patchPath, profileDir, env }) {
  if (dshHome !== undefined) return resolve(dshHome)
  if (home !== undefined) return join(resolve(home), '.dsh')
  if (patchPath !== undefined) return dirname(resolve(patchPath))
  if (profileDir !== undefined) return dirname(dirname(resolve(profileDir)))
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return resolve(env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/**
 * Driver defaults resolve against the real user home. A custom `DSH_HOME` can
 * live anywhere (e.g. `<home>/nested/custom-dsh`), so its parent is only a last
 * resort when neither `USERPROFILE` nor `HOME` is available.
 */
function resolveUserHome({ home, dshHome, env }) {
  if (home !== undefined) return resolve(home)
  for (const candidate of [env?.USERPROFILE, env?.HOME]) {
    if (typeof candidate === 'string' && candidate.length > 0) return resolve(candidate)
  }
  if (dshHome !== undefined) return dirname(resolve(dshHome))
  if (typeof env?.DSH_HOME === 'string' && env.DSH_HOME.length > 0) return dirname(resolve(env.DSH_HOME))
  return homedir()
}

function versionCheck(version) {
  return version === null
    ? check(
        'dsh-version',
        false,
        "DSH runtime not detected; set DSH_VERSION or DSH_APP_PACKAGE_JSON, add <dsh-home>/version, or run 'dsh --version'",
      )
    : check('dsh-version', true, `detected DSH ${version}`)
}

function compatCheck(version) {
  if (version === null) {
    return check('dsh-compat', false, `DSH version unknown; required ${DSH_REQUIREMENT}`)
  }
  return satisfiesRange(DSH_REQUIREMENT, version)
    ? check('dsh-compat', true, `DSH ${version} satisfies ${DSH_REQUIREMENT}`)
    : check('dsh-compat', false, `DSH ${version} does not satisfy ${DSH_REQUIREMENT}; upgrade DSH`)
}

async function driverCheck({ backend, home, env, exists }) {
  if (backend !== undefined) {
    try {
      if (typeof backend?.doctor === 'function') {
        return normalizeDriverResult(await backend.doctor())
      }
      if (typeof backend?.ping === 'function') {
        await backend.ping()
        return check('cua-driver', true, 'injected backend responded to ping()')
      }
      return check('cua-driver', false, 'injected backend has no doctor()/ping(); cannot verify cua-driver')
    } catch (error) {
      return check(
        'cua-driver',
        false,
        `cua-driver backend failed: ${messageOf(error)}; start cua-driver or set CUA_DRIVER_BIN`,
      )
    }
  }

  const command = resolveDriverCommand({ home, env, exists })
  return exists(command)
    ? check('cua-driver', true, `found ${command}`)
    : check('cua-driver', false, `cua-driver not found at ${command}; install Cua Driver or set CUA_DRIVER_BIN`)
}

function normalizeDriverResult(result) {
  if (result !== null && typeof result === 'object') {
    const ok = result.ok !== false
    return check('cua-driver', ok, result.detail ?? result.message ?? (ok ? 'backend ready' : 'backend unavailable'))
  }
  if (typeof result === 'boolean') {
    return check('cua-driver', result, result ? 'backend ready' : 'backend unavailable')
  }
  return check('cua-driver', true, String(result ?? 'backend ready'))
}

async function patchCheck(patchPath) {
  const text = await readTextOrNull(patchPath)
  if (text === null) {
    return check('cordis-patch', false, `patch file missing at ${patchPath}; run node scripts/install.mjs`)
  }
  return hasManagedRow(text)
    ? check('cordis-patch', true, `managed ${PACKAGE_NAME} row present in ${patchPath}`)
    : check('cordis-patch', false, `managed ${PACKAGE_NAME} row missing from ${patchPath}; run node scripts/install.mjs`)
}

function hasManagedRow(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  let inside = false
  let found = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!inside) {
      if (MANAGED_BEGIN_RE.test(trimmed)) inside = true
    } else if (MANAGED_END_RE.test(trimmed)) {
      return found
    } else if (line.match(ROW_ID_RE)?.[2] === PACKAGE_NAME) {
      found = true
    }
  }
  return false
}

async function pluginCheck({ dshHome, profile, manifest }) {
  if (manifest === null) {
    return check('plugin-install', false, 'cannot read this package.json; reinstall dsh-computer')
  }

  const versionDir = join(dshHome, 'plugins', PACKAGE_NAME, manifest.version)
  const linkPath = join(profile, 'node_modules', PACKAGE_NAME)

  if (!(await isDirectory(versionDir))) {
    return check('plugin-install', false, `plugin directory missing at ${versionDir}; run node scripts/install.mjs`)
  }
  try {
    const stats = await lstat(linkPath)
    const target = stats.isSymbolicLink() ? resolve(dirname(linkPath), await readlink(linkPath)) : null
    if (target !== null && samePath(target, versionDir)) {
      return check('plugin-install', true, `${linkPath} -> ${versionDir}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return check('plugin-install', false, `plugin link missing or stale at ${linkPath}; run node scripts/install.mjs`)
}

async function readManifest() {
  try {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    if (typeof manifest?.version !== 'string' || manifest.version.length === 0) return null
    return manifest
  } catch {
    return null
  }
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function check(name, ok, detail) {
  return { name, ok, detail }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function main(argv = process.argv.slice(2)) {
  const values = parseCli(argv)
  if (values.help) {
    console.log(USAGE)
    return
  }

  const home = values.home === undefined ? undefined : resolve(values.home)
  const dshHome =
    home === undefined
      ? resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
      : join(home, '.dsh')
  const result = await doctor({
    ...(home === undefined ? {} : { home }),
    dshHome,
    profileDir: join(dshHome, 'profiles', values.profile),
    patchPath: join(dshHome, 'cordis.patch.yml'),
  })

  if (values.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const item of result.checks) {
      console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}`)
    }
  }
  if (!result.ok) process.exitCode = 1
}

function parseCli(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        home: { type: 'string' },
        profile: { type: 'string', default: DEFAULT_PROFILE },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    })
    if (!/^[A-Za-z0-9._-]+$/.test(values.profile) || values.profile === '.' || values.profile === '..') {
      throw new Error(`Invalid profile name: ${values.profile}`)
    }
    return values
  } catch (error) {
    throw new Error(`${error.message}\n\n${USAGE}`)
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch((error) => {
    console.error(`doctor: ${error.message}`)
    process.exitCode = 1
  })
}
