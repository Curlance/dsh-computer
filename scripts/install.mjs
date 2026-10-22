#!/usr/bin/env node
/**
 * Install dsh-computer without a preset:
 *   1. migrate the legacy `dsh-computer-use` install into a rollback point;
 *   2. copy this package to `<dsh-home>/plugins/dsh-computer/<version>/`;
 *   3. point `<dsh-home>/profiles/<profile>/node_modules/dsh-computer` at it;
 *   4. install `skills/computer-use` into `<dsh-home>/skills/computer-use`
 *      (backing up an existing copy under `<dsh-home>/computer/backup/`);
 *   5. write the managed root plugin row into `<dsh-home>/cordis.patch.yml`.
 *
 * With --home, `<dsh-home>` is `<home>/.dsh`; without it, `$DSH_HOME` is the
 * DSH root itself (or `~/.dsh`). `$DSH_HOME` is ignored when --home is given.
 * Every path can be redirected (--home/--profile/--patch) so tests never touch
 * the real `~/.dsh`; --dry-run prints the plan without writing anything.
 * --rollback restores the patch and legacy package recorded by the last migration.
 */

import { cp, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { applyMigration, planMigration, rollbackMigration } from '../lib/install/migrate.js'
import { ensurePluginRow } from '../lib/install/patch.js'

const PACKAGE_NAME = 'dsh-computer'
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_ENTRIES = ['package.json', 'index.js', 'lib', 'README.md']
const SKILL_NAME = 'computer-use'
const SKILL_SOURCE = join(PACKAGE_ROOT, 'skills', SKILL_NAME)
const PATCH_CONFIG = {
  ...structuredClone(DEFAULT_CONFIG),
  audit: { ...DEFAULT_CONFIG.audit, path: '~/.dsh/computer/audit.jsonl' },
}

const USAGE = `Usage: node scripts/install.mjs [options]

Options:
  --home <path>     User home directory; the DSH root becomes <path>/.dsh.
                    Without --home, $DSH_HOME is used directly as the DSH root
                    (default: ~/.dsh when DSH_HOME is unset). DSH_HOME is
                    ignored when --home is given; do not combine them.
  --profile <name>  DSH profile name (default: desktop)
  --patch <path>    Patch file to edit (default: <dsh-home>/cordis.patch.yml)
  --rollback        Restore the patch and legacy package recorded by the last
                    migration (run uninstall first to unregister this plugin)
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

  if (values.rollback) {
    const result = await rollbackMigration({
      pluginsDir: layout.pluginsDir,
      backupDir: layout.migrationBackupDir,
      ...(values.patch === undefined ? {} : { patchPath: layout.patchPath }),
      dryRun,
    })
    const prefix = dryRun ? '[dry-run] ' : ''
    for (const name of result.restored) actions.push(`${prefix}rollback: restore ${name}`)
    actions.push(`${prefix}rollback: patch <- ${result.backupPath}`)
    actions.push(`${prefix}rollback: ${dryRun ? 'would write' : 'wrote'} ${result.patchPath}`)
    print(actions)
    return
  }

  const previousPatch = await readTextIfExists(layout.patchPath)
  const plan = await planMigration({
    patchText: previousPatch ?? '',
    pluginsDir: layout.pluginsDir,
    profileNodeModules: layout.profileNodeModules,
    patchPath: layout.patchPath,
  })
  const nextPatch = ensurePluginRow(plan.nextPatchText, {
    id: PACKAGE_NAME,
    name: PACKAGE_NAME,
    config: PATCH_CONFIG,
  })
  const patchChanged = nextPatch !== (previousPatch ?? '')

  const skillSource = await lstatIfExists(SKILL_SOURCE)
  const skillExisting = await lstatIfExists(layout.skillDir)

  if (dryRun) {
    for (const action of plan.actions) actions.push(`[dry-run] migrate: ${describeAction(action)}`)
    actions.push(`[dry-run] copy ${PACKAGE_NAME}@${manifest.version} -> ${layout.versionDir}`)
    actions.push(`[dry-run] link ${layout.linkPath} -> ${layout.versionDir}`)
    if (skillSource === null) {
      actions.push(`[dry-run] skill skipped: ${SKILL_SOURCE} not found`)
    } else {
      if (skillExisting) {
        actions.push(`[dry-run] backup skill -> ${await availableSkillBackupPath(layout)}`)
      }
      actions.push(`[dry-run] skill ${SKILL_SOURCE} -> ${layout.skillDir}`)
    }
    actions.push(
      patchChanged
        ? `[dry-run] patch ${layout.patchPath}${backupHint(plan, layout)}`
        : `[dry-run] patch unchanged: ${layout.patchPath}`,
    )
    print(actions)
    return
  }

  await copyPackage(layout.versionDir)
  actions.push(`copy: ${PACKAGE_NAME}@${manifest.version} -> ${layout.versionDir}`)

  const linkChanged = await ensurePackageLink(layout.linkPath, layout.versionDir)
  actions.push(`${linkChanged ? 'link' : 'link unchanged'}: ${layout.linkPath} -> ${layout.versionDir}`)

  actions.push(...(await installSkill(layout)))

  if (plan.actions.length > 0) {
    for (const action of plan.actions) actions.push(`migrate: ${describeAction(action)}`)
    const applied = await applyMigration({ ...plan, nextPatchText: nextPatch })
    if (applied.backupPath) actions.push(`backup: ${applied.backupPath}`)
    actions.push(
      applied.writtenPatch
        ? `patch: wrote ${layout.patchPath}`
        : `patch unchanged: ${layout.patchPath}`,
    )
  } else if (patchChanged) {
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

  print(actions)
}

function describeAction(action) {
  if (action.kind === 'remove-preset') {
    const rows = action.detail.rows.length > 0 ? ` (${action.detail.rows.join(', ')})` : ''
    return `remove legacy dsh-computer-use preset block${rows}`
  }
  if (action.kind === 'move-package') return `move ${action.detail.name} -> ${action.detail.to}`
  if (action.kind === 'write-backup') return `back up patch -> ${action.detail.patchPath}`
  return action.kind
}

function backupHint(plan, layout) {
  return plan.backupPath ? ` (backup in ${plan.backupPath})` : ` (backup old patch in ${layout.backupDir})`
}

function parseCli(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        home: { type: 'string' },
        profile: { type: 'string', default: 'desktop' },
        patch: { type: 'string' },
        rollback: { type: 'boolean', default: false },
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
  const pluginsDir = join(dshHome, 'plugins')
  const profileNodeModules = join(dshHome, 'profiles', values.profile, 'node_modules')
  return {
    pluginsDir,
    profileNodeModules,
    versionDir: join(pluginsDir, PACKAGE_NAME, version),
    linkPath: join(profileNodeModules, PACKAGE_NAME),
    skillsDir: join(dshHome, 'skills'),
    skillDir: join(dshHome, 'skills', SKILL_NAME),
    patchPath: resolve(values.patch ?? join(dshHome, 'cordis.patch.yml')),
    backupDir: join(dshHome, 'computer', 'backup'),
    migrationBackupDir: join(pluginsDir, '_backup'),
  }
}

async function copyPackage(targetDir) {
  await mkdir(targetDir, { recursive: true })
  for (const entry of PACKAGE_ENTRIES) {
    const source = join(PACKAGE_ROOT, entry)
    if ((await lstatIfExists(source)) === null) continue
    await cp(source, join(targetDir, entry), { recursive: true, force: true })
  }
}

async function ensurePackageLink(linkPath, targetDir) {
  const existing = await lstatIfExists(linkPath)
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace existing non-link path: ${linkPath}`)
    }
    const current = await readlink(linkPath)
    if (samePath(resolve(dirname(linkPath), current), targetDir)) return false
    await unlink(linkPath)
  }

  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(targetDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

async function installSkill(layout) {
  if ((await lstatIfExists(SKILL_SOURCE)) === null) {
    return [`skill skipped: ${SKILL_SOURCE} not found`]
  }

  const actions = []
  if (await lstatIfExists(layout.skillDir)) {
    const backupPath = await availableSkillBackupPath(layout)
    await mkdir(layout.backupDir, { recursive: true })
    await rename(layout.skillDir, backupPath)
    actions.push(`backup: skill -> ${backupPath}`)
  }

  await mkdir(layout.skillsDir, { recursive: true })
  await cp(SKILL_SOURCE, layout.skillDir, { recursive: true, force: true })
  actions.push(`skill: ${layout.skillDir}`)
  return actions
}

async function skillBackupPath(layout) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(layout.backupDir, `skills-${stamp}`)
}

async function availableSkillBackupPath(layout) {
  const candidate = await skillBackupPath(layout)
  return (await lstatIfExists(candidate)) === null ? candidate : `${candidate}-${process.pid}`
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

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function print(actions) {
  for (const action of actions) console.log(action)
}

main().catch((error) => {
  console.error(`install: ${error.message}`)
  process.exitCode = 1
})
