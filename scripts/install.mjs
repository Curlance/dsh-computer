#!/usr/bin/env node
/**
 * Install dsh-computer without a preset:
 *   1. copy this package to `<dsh-home>/plugins/dsh-computer/<version>/`;
 *   2. point `<dsh-home>/profiles/<profile>/node_modules/dsh-computer` at it;
 *   3. write the managed root plugin row into `<dsh-home>/cordis.patch.yml`.
 *
 * `<dsh-home>` is `<home>/.dsh`, `$DSH_HOME` or `~/.dsh`. Every path can be
 * redirected (--home/--profile/--patch) so tests never touch the real `~/.dsh`;
 * --dry-run prints the plan without writing anything.
 */

import { cp, lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_CONFIG } from '../lib/config.js'
import { ensureLegacyMigration, ensurePluginRow } from '../lib/install/patch.js'

const PACKAGE_NAME = 'dsh-computer'
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_ENTRIES = ['package.json', 'index.js', 'lib', 'README.md']
const PATCH_CONFIG = {
  ...structuredClone(DEFAULT_CONFIG),
  audit: { ...DEFAULT_CONFIG.audit, path: '~/.dsh/computer/audit.jsonl' },
}

const USAGE = `Usage: node scripts/install.mjs [options]

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

  const previousPatch = await readTextIfExists(layout.patchPath)
  const migration = ensureLegacyMigration(previousPatch ?? '')
  if (migration.removedPreset) {
    const rows = migration.removedRows.length > 0 ? ` (${migration.removedRows.join(', ')})` : ''
    actions.push(`migrate: removed legacy dsh-computer-use block${rows}`)
  }

  const nextPatch = ensurePluginRow(migration.text, {
    id: PACKAGE_NAME,
    name: PACKAGE_NAME,
    config: PATCH_CONFIG,
  })

  if (dryRun) {
    actions.push(`[dry-run] copy ${PACKAGE_NAME}@${manifest.version} -> ${layout.versionDir}`)
    actions.push(`[dry-run] link ${layout.linkPath} -> ${layout.versionDir}`)
    actions.push(
      nextPatch === previousPatch
        ? `[dry-run] patch unchanged: ${layout.patchPath}`
        : `[dry-run] patch ${layout.patchPath} (backup old patch in ${layout.backupDir})`,
    )
    print(actions)
    return
  }

  await copyPackage(layout.versionDir)
  actions.push(`copy: ${PACKAGE_NAME}@${manifest.version} -> ${layout.versionDir}`)

  const linkChanged = await ensurePackageLink(layout.linkPath, layout.versionDir)
  actions.push(`${linkChanged ? 'link' : 'link unchanged'}: ${layout.linkPath} -> ${layout.versionDir}`)

  if (nextPatch === previousPatch) {
    actions.push(`patch unchanged: ${layout.patchPath}`)
  } else {
    const backupPath = await backupAndWritePatch(
      layout.patchPath,
      nextPatch,
      previousPatch,
      layout.backupDir,
    )
    actions.push(`patch: wrote ${layout.patchPath}`)
    if (backupPath) actions.push(`backup: ${backupPath}`)
  }

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
