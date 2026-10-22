#!/usr/bin/env node
/**
 * Update dsh-computer from a signed-by-sha256 release manifest:
 *   1. select the highest release compatible with the running DSH version;
 *   2. download, verify and extract it under `<dsh-home>/plugins/`;
 *   3. atomically repoint `<dsh-home>/profiles/<profile>/node_modules/dsh-computer`;
 *   4. leave previous/pending markers so `--rollback` can restore the old version.
 *
 * Running-DSH detection: DSH has no portable single-instance lock, so the
 * default treats a heartbeat younger than 10 minutes, written by a non-updater
 * source (`source !== 'updater'`), as "DSH is running" and refuses to switch.
 * The DSH runtime owns that heartbeat; `isDshRunning` is injectable for tests.
 *
 * Every path can be redirected with `--home`, so nothing touches the real
 * `~/.dsh`. `--check` prints the selected release; `--apply` performs the
 * switch; `--rollback` restores the previous version and patch backup.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import { detectDshVersion } from '../lib/compat.js'
import { selectVersion } from '../lib/update/compat.js'
import {
  clearPending,
  installVersion,
  needsRollback,
  recordHeartbeat,
  rollback,
  switchCurrent,
} from '../lib/update/install.js'

const execFileAsync = promisify(execFile)

const PACKAGE_NAME = 'dsh-computer'
const PROFILE = 'desktop'
const DEFAULT_STALE_MS = 600000

const USAGE = `Usage: node scripts/update.mjs [options]

Options:
  --home <path>      User home directory; DSH files live in <home>/.dsh
                     (default: $DSH_HOME, or ~/.dsh when DSH_HOME is unset)
  --manifest <src>   Release manifest: a local file path or an http(s) URL
                     (required for --check and --apply)
  --check            Report the installed and selected versions without writing
  --apply            Download, verify and switch to the selected version
  --rollback         Restore the version and patch backup from the last switch
  --json             Print the result as JSON
  -h, --help         Show this help
`

/**
 * Run the updater without writing to stdout (the CLI entry point prints).
 *
 * @param {{
 *   argv?: string[], env?: Record<string,string>,
 *   fetchImpl?: Function, extractImpl?: Function,
 *   isDshRunning?: Function, now?: Date|(() => Date),
 * }} options
 * @returns {Promise<object>}
 */
export async function runUpdate(options = {}) {
  const argv = options.argv ?? process.argv.slice(2)
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? ((url) => globalThis.fetch(url))
  const now = options.now ?? (() => new Date())
  const values = parseCli(argv)
  if (values.help) return { action: 'help', usage: USAGE }

  const layout = resolveLayout(values, env)

  if (values.rollback) {
    const result = await rollback({
      pluginsDir: layout.pluginsDir,
      profileNodeModules: layout.profileNodeModules,
      stateDir: layout.stateDir,
    })
    return { action: 'rollback', restored: result.restored, patch: result.patch }
  }

  const manifest = await loadManifest(values.manifest, fetchImpl)
  const dshVersion = await detectDshVersion({
    env,
    readFile,
    exec: async () => (await execFileAsync('dsh', ['--version'])).stdout,
  })

  if (values.check) {
    const current = await installedVersion(layout)
    const available = dshVersion ? selectVersion(manifest, dshVersion) : null
    return {
      action: 'check',
      current,
      dshVersion,
      available,
      changed: available !== null && available.version !== current,
    }
  }

  if (!dshVersion) {
    throw new Error('Cannot detect the DSH version (set DSH_VERSION or run from an installed DSH)')
  }
  const selected = selectVersion(manifest, dshVersion)
  if (!selected) throw new Error(`No release in the manifest supports DSH ${dshVersion}`)

  const current = await installedVersion(layout)
  if (current === selected.version) {
    return { action: 'apply', changed: false, from: current, to: current, path: null }
  }

  const running = options.isDshRunning
    ? await options.isDshRunning({ stateDir: layout.stateDir, now })
    : await defaultIsDshRunning({ stateDir: layout.stateDir, now })
  if (running) {
    throw new Error('DSH is running; exit DSH completely and retry the update')
  }
  if (await needsRollback({ stateDir: layout.stateDir, now })) {
    throw new Error('A previous update is unconfirmed; run --rollback first')
  }

  const installed = await installVersion({
    cacheDir: layout.cacheDir,
    pluginsDir: layout.pluginsDir,
    tarballUrl: selected.tarball,
    sha256: selected.sha256,
    version: selected.version,
    fetchImpl,
    extractImpl: options.extractImpl,
  })
  const patchBackupPath = await backupPatch(layout, now)

  await switchCurrent({
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    version: selected.version,
    stateDir: layout.stateDir,
    patchBackupPath,
    now,
  })
  await recordHeartbeat({
    stateDir: layout.stateDir,
    version: selected.version,
    dshVersion,
    source: 'updater',
    now,
  })
  await clearPending({ stateDir: layout.stateDir })

  return {
    action: 'apply',
    changed: true,
    from: current,
    to: selected.version,
    path: installed.path,
  }
}

function parseCli(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        home: { type: 'string' },
        manifest: { type: 'string' },
        check: { type: 'boolean', default: false },
        apply: { type: 'boolean', default: false },
        rollback: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }))
  } catch (error) {
    throw new Error(`${error.message}\n\n${USAGE}`)
  }

  if (values.help) return values
  const modes = [values.check, values.apply, values.rollback].filter(Boolean).length
  if (modes !== 1) throw new Error(`Exactly one of --check, --apply or --rollback is required\n\n${USAGE}`)
  if (!values.rollback && values.manifest === undefined) {
    throw new Error(`--manifest is required for --check and --apply\n\n${USAGE}`)
  }
  return values
}

function resolveLayout(values, env) {
  const home = values.home === undefined ? null : resolve(values.home)
  const envHome = env.DSH_HOME || join(homedir(), '.dsh')
  const dshHome = home === null ? resolve(envHome) : join(home, '.dsh')
  const stateDir = join(dshHome, 'computer', 'update')
  return {
    dshHome,
    pluginsDir: join(dshHome, 'plugins'),
    profileNodeModules: join(dshHome, 'profiles', PROFILE, 'node_modules'),
    stateDir,
    cacheDir: join(stateDir, 'cache'),
    patchPath: join(dshHome, 'cordis.patch.yml'),
  }
}

async function loadManifest(source, fetchImpl) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error('Invalid manifest: expected a local path or http(s) URL')
  }

  let text
  if (/^https?:\/\//i.test(source)) {
    const response = await fetchImpl(source)
    if (!response || response.ok !== true) {
      throw new Error(`Manifest download failed: HTTP ${response?.status ?? 'unknown'}`)
    }
    text =
      typeof response.text === 'function'
        ? await response.text()
        : Buffer.from(await response.arrayBuffer()).toString('utf8')
  } else {
    text = await readFile(resolve(source), 'utf8')
  }

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`Invalid manifest at ${source}: malformed JSON`)
  }
  if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.versions)) {
    throw new Error(`Invalid manifest at ${source}: expected a versions array`)
  }
  return manifest
}

async function installedVersion(layout) {
  let text
  try {
    text = await readFile(join(layout.profileNodeModules, PACKAGE_NAME, 'package.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`Malformed installed package.json under ${layout.profileNodeModules}`)
  }
  if (manifest?.name !== PACKAGE_NAME || typeof manifest.version !== 'string') {
    throw new Error(`Malformed installed package.json under ${layout.profileNodeModules}`)
  }
  return manifest.version
}

async function backupPatch(layout, now) {
  let text
  try {
    text = await readFile(layout.patchPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }

  const stamp = toDate(now).toISOString().replace(/[:.]/g, '-')
  const backupPath = join(layout.stateDir, `patch-${stamp}.yml`)
  await mkdir(dirname(backupPath), { recursive: true })
  const tempPath = `${backupPath}.tmp-${process.pid}`
  await writeFile(tempPath, text, 'utf8')
  await rename(tempPath, backupPath)
  return backupPath
}

async function defaultIsDshRunning({ stateDir, now, staleMs = DEFAULT_STALE_MS }) {
  let heartbeat
  try {
    heartbeat = JSON.parse(await readFile(join(stateDir, 'heartbeat.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    return true // 心跳不可读时按“在运行”处理，避免带病切换
  }
  if (typeof heartbeat?.at !== 'string') return false
  if (heartbeat.source === 'updater') return false

  const at = Date.parse(heartbeat.at)
  if (Number.isNaN(at)) return true
  return toDate(now).getTime() - at <= staleMs
}

function toDate(now) {
  const date = typeof now === 'function' ? now() : (now ?? new Date())
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid update input: now must return a valid Date')
  }
  return date
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result))
    return
  }

  if (result.action === 'help') {
    console.log(result.usage)
    return
  }
  if (result.action === 'check') {
    console.log(`current: ${result.current ?? 'not installed'}`)
    console.log(`dsh: ${result.dshVersion ?? 'unknown'}`)
    if (result.available === null) {
      console.log('available: none (no release supports this DSH)')
    } else {
      console.log(`${result.changed ? 'available' : 'up to date'}: ${result.available.version}`)
    }
    return
  }
  if (result.action === 'apply') {
    console.log(
      result.changed
        ? `updated: ${result.from ?? 'none'} -> ${result.to}`
        : `up to date: ${result.from}`,
    )
    if (result.changed) console.log(`installed: ${result.path}`)
    return
  }
  console.log(result.restored ? `rolled back to ${result.restored}` : 'nothing to roll back')
  if (result.patch) console.log(`patch: ${result.patch}`)
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  runUpdate({ argv })
    .then((result) => printResult(result, json))
    .catch((error) => {
      console.error(`update: ${error.message}`)
      process.exitCode = 1
    })
}
