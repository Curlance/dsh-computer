#!/usr/bin/env node
/**
 * Uninstall dsh-computer:
 *   1. remove the managed root plugin row from `<dsh-home>/cordis.patch.yml`;
 *   2. unlink `<dsh-home>/profiles/<profile>/node_modules/dsh-computer`;
 *   3. delete `<dsh-home>/plugins/dsh-computer/<version>/`.
 *
 * `<dsh-home>` is `<home>/.dsh`, `$DSH_HOME` or `~/.dsh`. User data
 * (`<dsh-home>/computer/**`, including audit logs and backups) is kept.
 * Every path can be redirected (--home/--profile/--patch); --dry-run only prints.
 */

import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { removePluginRow } from '../lib/install/patch.js'

const PACKAGE_NAME = 'dsh-computer'
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const USAGE = `Usage: node scripts/uninstall.mjs [options]

Options:
  --home <path>     User home directory; DSH files live in <home>/.dsh
                    (default: $DSH_HOME, or ~/.dsh when DSH_HOME is unset)
  --profile <name>  DSH profile name (default: desktop)
  --patch <path>    Patch file to edit (default: <dsh-home>/cordis.patch.yml)
  --dry-run         Print planned actions without writing anything
  -h, --help        Show this help
`

async function main() {
  const values = parseCli(process.argv.slice(2))
  if (values.help) {
    console.log(USAGE)
    return
  }

  const manifest = await readManifest()
  const layout = resolveLayout(values, manifest.version)
  const dryRun = values['dry-run'] === true
  const actions = []

  const linkStats = await lstatIfExists(layout.linkPath)
  if (linkStats && !linkStats.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-link path: ${layout.linkPath}`)
  }

  const previousPatch = await readTextIfExists(layout.patchPath)
  const nextPatch = previousPatch === null ? null : removePluginRow(previousPatch, PACKAGE_NAME)
  const patchChanged = previousPatch !== nextPatch

  if (dryRun) {
    actions.push(
      patchChanged
        ? `[dry-run] patch ${layout.patchPath} (backup old patch in ${layout.backupDir})`
        : `[dry-run] patch unchanged: ${layout.patchPath}`,
    )
    actions.push(
      linkStats
        ? `[dry-run] unlink ${layout.linkPath}`
        : `[dry-run] link absent: ${layout.linkPath}`,
    )
    actions.push(`[dry-run] remove ${layout.versionDir}`)
    print(actions)
    return
  }

  if (patchChanged) {
    const backupPath = await backupAndWritePatch(
      layout.patchPath,
      nextPatch,
      previousPatch,
      layout.backupDir,
    )
    actions.push(`patch: wrote ${layout.patchPath}`)
    if (backupPath) actions.push(`backup: ${backupPath}`)
  } else {
    actions.push(`patch unchanged: ${layout.patchPath}`)
  }

  if (linkStats) {
    await unlink(layout.linkPath)
    actions.push(`unlink: ${layout.linkPath}`)
  } else {
    actions.push(`link absent: ${layout.linkPath}`)
  }

  await rm(layout.versionDir, { recursive: true, force: true })
  actions.push(`remove: ${layout.versionDir}`)

  print(actions)
}

function parseCli(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        home: { type: 'string' },
        profile: { type: 'string', default: 'desktop' },
        patch: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
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

async function readManifest() {
  const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  if (manifest.name !== PACKAGE_NAME) {
    throw new Error(`Unexpected package name in package.json: ${manifest.name}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('package.json is missing a version')
  }
  return manifest
}

function resolveLayout(values, version) {
  const home = values.home === undefined ? null : resolve(values.home)
  const envHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dshHome = home === null ? resolve(envHome) : join(home, '.dsh')
  return {
    versionDir: join(dshHome, 'plugins', PACKAGE_NAME, version),
    linkPath: join(dshHome, 'profiles', values.profile, 'node_modules', PACKAGE_NAME),
    patchPath: resolve(values.patch ?? join(dshHome, 'cordis.patch.yml')),
    backupDir: join(dshHome, 'computer', 'backup'),
  }
}

async function backupAndWritePatch(patchPath, nextText, previousText, backupDir) {
  let backupPath = null
  if (previousText !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    backupPath = join(backupDir, `patch-${stamp}.yml`)
    await mkdir(backupDir, { recursive: true })
    await writeFile(backupPath, previousText, 'utf8')
  }

  await mkdir(dirname(patchPath), { recursive: true })
  const tempPath = `${patchPath}.tmp-${process.pid}`
  await writeFile(tempPath, nextText, 'utf8')
  await rename(tempPath, patchPath)
  return backupPath
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function lstatIfExists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function print(actions) {
  for (const action of actions) console.log(action)
}

main().catch((error) => {
  console.error(`uninstall: ${error.message}`)
  process.exitCode = 1
})
