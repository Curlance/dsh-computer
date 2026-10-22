#!/usr/bin/env node
/**
 * Uninstall dsh-computer:
 *   1. remove the managed root plugin row from `<dsh-home>/cordis.patch.yml`;
 *   2. unlink `<dsh-home>/profiles/<profile>/node_modules/dsh-computer`;
 *   3. delete `<dsh-home>/plugins/dsh-computer/` (nested layout) and any legacy
 *      flat `plugins/dsh-computer-*` dirs left by old updater versions;
 *   4. remove the installed `<dsh-home>/skills/computer-use`, restoring the most
 *      recent `skills-*` backup from `<dsh-home>/computer/backup/` if present.
 *
 * With --home, `<dsh-home>` is `<home>/.dsh`; without it, `$DSH_HOME` is the
 * DSH root itself (or `~/.dsh`). `$DSH_HOME` is ignored when --home is given.
 * User data (`<dsh-home>/computer/**`, including audit logs and backups) is
 * kept. Every path can be redirected (--home/--profile/--patch); --dry-run only prints.
 */

import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { removePluginRow } from '../lib/install/patch.js'

const PACKAGE_NAME = 'dsh-computer'
const SKILL_NAME = 'computer-use'
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const USAGE = `Usage: node scripts/uninstall.mjs [options]

Options:
  --home <path>     User home directory; the DSH root becomes <path>/.dsh.
                    Without --home, $DSH_HOME is used directly as the DSH root
                    (default: ~/.dsh when DSH_HOME is unset). DSH_HOME is
                    ignored when --home is given; do not combine them.
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

  await readManifest()
  const layout = resolveLayout(values)
  const dryRun = values['dry-run'] === true
  const actions = []

  const linkStats = await lstatIfExists(layout.linkPath)
  if (linkStats && !linkStats.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-link path: ${layout.linkPath}`)
  }

  const legacyDirs = await legacyVersionDirs(layout.pluginsDir)

  const previousPatch = await readTextIfExists(layout.patchPath)
  const nextPatch = previousPatch === null ? null : removePluginRow(previousPatch, PACKAGE_NAME)
  const patchChanged = previousPatch !== nextPatch
  const skillStats = await lstatIfExists(layout.skillDir)
  const skillBackup = await latestSkillBackup(layout)

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
    actions.push(`[dry-run] remove ${layout.packageDir}`)
    for (const dir of legacyDirs) actions.push(`[dry-run] remove legacy ${dir}`)
    actions.push(
      skillStats
        ? `[dry-run] remove ${layout.skillDir}`
        : `[dry-run] skill absent: ${layout.skillDir}`,
    )
    if (skillBackup) actions.push(`[dry-run] restore skill <- ${skillBackup}`)
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

  await rm(layout.packageDir, { recursive: true, force: true })
  actions.push(`remove: ${layout.packageDir}`)
  for (const dir of legacyDirs) {
    await rm(dir, { recursive: true, force: true })
    actions.push(`remove legacy: ${dir}`)
  }

  await uninstallSkill(layout, actions)

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

function resolveLayout(values) {
  const home = values.home === undefined ? null : resolve(values.home)
  const envHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dshHome = home === null ? resolve(envHome) : join(home, '.dsh')
  const pluginsDir = join(dshHome, 'plugins')
  return {
    pluginsDir,
    packageDir: join(pluginsDir, PACKAGE_NAME),
    linkPath: join(dshHome, 'profiles', values.profile, 'node_modules', PACKAGE_NAME),
    skillsDir: join(dshHome, 'skills'),
    skillDir: join(dshHome, 'skills', SKILL_NAME),
    patchPath: resolve(values.patch ?? join(dshHome, 'cordis.patch.yml')),
    backupDir: join(dshHome, 'computer', 'backup'),
  }
}

/** Legacy updater layout: `plugins/dsh-computer-<version>` directories. */
async function legacyVersionDirs(pluginsDir) {
  let names
  try {
    names = await readdir(pluginsDir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const prefix = `${PACKAGE_NAME}-`
  const dirs = []
  for (const name of names.filter((entry) => entry.startsWith(prefix)).sort()) {
    const candidate = join(pluginsDir, name)
    const stats = await lstatIfExists(candidate)
    if (stats?.isDirectory()) dirs.push(candidate)
  }
  return dirs
}

async function uninstallSkill(layout, actions) {
  if (await lstatIfExists(layout.skillDir)) {
    await rm(layout.skillDir, { recursive: true, force: true })
    actions.push(`remove: ${layout.skillDir}`)
  } else {
    actions.push(`skill absent: ${layout.skillDir}`)
  }

  const backupPath = await latestSkillBackup(layout)
  if (!backupPath) return
  await mkdir(layout.skillsDir, { recursive: true })
  await rename(backupPath, layout.skillDir)
  actions.push(`restore: skill <- ${backupPath}`)
}

async function latestSkillBackup(layout) {
  let names
  try {
    names = await readdir(layout.backupDir)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }

  for (const name of names.filter((entry) => entry.startsWith('skills-')).sort().reverse()) {
    const candidate = join(layout.backupDir, name)
    const stats = await lstatIfExists(candidate)
    if (stats?.isDirectory()) return candidate
  }
  return null
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
