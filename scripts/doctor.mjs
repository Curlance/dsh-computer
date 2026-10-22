#!/usr/bin/env node
/**
 * `dsh-computer` doctor: verify a DSH install without starting the desktop.
 *
 * Checks (each returns `{name, ok, detail}`, never throws):
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

import { DSH_REQUIREMENT, detectDshVersion } from '../lib/compat.js'
import { resolveDriverCommand } from '../lib/host.js'
import { satisfiesRange } from '../lib/install/version.js'

const PACKAGE_NAME = 'dsh-computer'
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_PROFILE = 'desktop'

const BEGIN_MARKER = /^#\s*>>>\s*dsh-computer\s+\(managed[^)]*\)$/
const END_MARKER = /^#\s*<<<\s*dsh-computer$/
const ROOT_ROW_ID = /^\s*(?:-\s+)?id:\s*(['"]?)dsh-computer\1\s*(?:#.*)?$/

const USAGE = `Usage: node scripts/doctor.mjs [options]

Options:
  --home <path>     User home directory; DSH files live in <home>/.dsh
                    (default: $DSH_HOME, or ~/.dsh when DSH_HOME is unset)
  --profile <name>  DSH profile name (default: desktop)
  --json            Print the checks as JSON
  -h, --help        Show this help
`

const execAsync = promisify(execFile)
const defaultExec = async (command) => {
  const [file, ...args] = command.split(/\s+/)
  const { stdout } = await execAsync(file, args, { timeout: 5000, windowsHide: true })
  return stdout
}

/**
 * Inspect the DSH install rooted at `home`.
 *
 * @param {{
 *   home?: string,
 *   profileDir?: string,
 *   backend?: {doctor?: () => any, ping?: () => any},
 *   patchPath?: string,
 *   env?: Record<string, string | undefined>,
 *   readFile?: (path: string) => Promise<string> | string,
 *   exec?: (command: string) => Promise<string> | string,
 *   exists?: (path: string) => boolean,
 * }} [options]
 * @returns {Promise<{ok: boolean, checks: Array<{name: string, ok: boolean, detail: string}>}>}
 */
export async function doctor({
  home,
  profileDir,
  backend,
  patchPath,
  env = process.env,
  readFile: readFileOption,
  exec = defaultExec,
  exists = existsSync,
} = {}) {
  const userHome = home === undefined ? homedir() : resolve(home)
  const dshHome = join(userHome, '.dsh')
  const profile = profileDir === undefined ? join(dshHome, 'profiles', DEFAULT_PROFILE) : resolve(profileDir)
  const resolvedPatchPath = patchPath === undefined ? join(dshHome, 'cordis.patch.yml') : resolve(patchPath)
  const readText = readFileOption ?? ((path) => readFile(path, 'utf8'))

  const version = await detectDshVersion({ env, readFile: readText, exec })
  const manifest = await readManifest()
  const checks = [
    versionCheck(version),
    compatCheck(version),
    await driverCheck({ backend, home: userHome, env, exists }),
    await patchCheck(resolvedPatchPath),
    await pluginCheck({ dshHome, profile, manifest }),
  ]

  return { ok: checks.every((check) => check.ok), checks }
}

function versionCheck(version) {
  return version === null
    ? check('dsh-version', false, "DSH runtime not detected; set DSH_VERSION or run 'dsh --version'")
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
      if (BEGIN_MARKER.test(trimmed)) inside = true
    } else if (END_MARKER.test(trimmed)) {
      return found
    } else if (ROOT_ROW_ID.test(line)) {
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
