/**
 * Legacy `dsh-computer-use` migration: one rollback point for the old patch,
 * the old package directories and the old profile link.
 *
 * Pure text handling stays in `patch.js`; this module owns filesystem access.
 * `planMigration` only observes. `applyMigration` and `rollbackMigration`
 * validate every path before writing, so a failed run leaves a resumable state.
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { ensureLegacyMigration } from './patch.js'

const BACKUP_DIR_NAME = '_backup'
const MANIFEST_NAME = 'migration.json'
const LEGACY_PACKAGE = 'dsh-computer-use'
const LEGACY_LINK_NAME = 'dsh-computer-use'
const LEGACY_DIR_NAME = /^dsh-computer-use-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/
const MANIFEST_VERSION = 1

/**
 * Observe the legacy install and describe the migration, without writing.
 *
 * @param {{
 *   patchText: string,
 *   pluginsDir: string,
 *   profileNodeModules?: string,
 *   patchPath?: string,
 *   now?: () => Date,
 * }} options
 * @returns {Promise<object>} plan consumed by `applyMigration`
 */
export async function planMigration(options) {
  const { patchText, pluginsDir, profileNodeModules, patchPath, now } = normalizePlanInput(options)
  const migration = ensureLegacyMigration(patchText)
  const createdAt = toDate(now).toISOString()
  const backupDir = join(pluginsDir, BACKUP_DIR_NAME)
  const backupPath = join(backupDir, `patch-${stampOf(createdAt)}.yml`)
  const manifestPath = join(backupDir, MANIFEST_NAME)

  const actions = []
  if (migration.removedPreset) {
    actions.push({ kind: 'remove-preset', detail: { rows: migration.removedRows } })
  }

  const packages = await findLegacyPackages(pluginsDir)
  const links = await findLegacyLinks(profileNodeModules, packages)
  for (const pkg of packages) {
    const link = links.find((candidate) => candidate.package === pkg.name)
    const detail = { name: pkg.name, from: pkg.from, to: join(backupDir, pkg.name) }
    if (link) detail.link = { path: link.path, target: link.target }
    actions.push({ kind: 'move-package', detail })
  }

  if (actions.length > 0) {
    actions.push({ kind: 'write-backup', detail: { patchPath: backupPath, manifestPath } })
  }

  return {
    actions,
    backupPath: actions.length > 0 ? backupPath : null,
    manifestPath: actions.length > 0 ? manifestPath : null,
    backupDir,
    patchPath,
    patchText,
    nextPatchText: migration.text,
    createdAt,
  }
}

/**
 * Apply a plan. Re-applying the same plan is a no-op; a resumed run continues
 * from the recorded manifest instead of duplicating backups.
 *
 * @param {object} plan
 * @returns {Promise<{backupPath: string|null, moved: string[], writtenPatch: boolean}>}
 */
export async function applyMigration(plan) {
  validatePlan(plan)
  if (plan.actions.length === 0) {
    return { backupPath: null, moved: [], writtenPatch: false }
  }

  const backupAction = plan.actions.find((action) => action.kind === 'write-backup')
  if (!backupAction) throw new Error('Invalid migration plan: missing write-backup action')
  if (
    !isPlainObject(backupAction.detail) ||
    typeof backupAction.detail.patchPath !== 'string' ||
    !isAbsolute(backupAction.detail.patchPath) ||
    typeof backupAction.detail.manifestPath !== 'string' ||
    !isAbsolute(backupAction.detail.manifestPath)
  ) {
    throw new Error('Invalid migration plan: write-backup detail must contain absolute paths')
  }
  if (!plan.patchPath) throw new Error('Cannot apply migration without patchPath')
  if (typeof plan.patchText !== 'string') {
    throw new Error('Invalid migration plan: patchText must be a string')
  }
  if (typeof plan.nextPatchText !== 'string') {
    throw new Error('Invalid migration plan: nextPatchText must be a string')
  }

  const { patchPath } = plan
  const backupPath = backupAction.detail.patchPath
  const manifestPath = backupAction.detail.manifestPath
  const moves = plan.actions
    .filter((action) => action.kind === 'move-package')
    .map((action) => validateMoveDetail(action.detail))
  const desiredManifest = {
    version: MANIFEST_VERSION,
    createdAt: plan.createdAt,
    patchPath,
    patchBackup: basename(backupPath),
    packages: moves.map(({ name, from, to }) => ({ name, from, to })),
    links: moves.flatMap(({ link }) => (link ? [{ path: link.path, target: link.target }] : [])),
  }
  if (typeof desiredManifest.createdAt !== 'string') {
    throw new Error('Invalid migration plan: createdAt must be an ISO timestamp string')
  }

  // Validate every move and link before the first write.
  for (const { name, from, to, link } of moves) {
    const fromStats = await lstatIfExists(from)
    const toStats = await lstatIfExists(to)
    if (fromStats && toStats) {
      throw new Error(`Cannot migrate ${name}: destination already exists: ${to}`)
    }
    if (!fromStats && !toStats) {
      throw new Error(`Cannot migrate ${name}: legacy package not found at ${from}`)
    }
    if (link) await validateExistingLink(link)
  }

  const existingManifest = await readMigrationManifest(manifestPath, { optional: true })
  if (existingManifest && !sameManifest(existingManifest, desiredManifest)) {
    throw new Error(
      `Migration backup already exists with different contents: ${manifestPath} (run --rollback first)`,
    )
  }

  const existingBackup = await readTextIfExists(backupPath)
  if (existingBackup !== null && existingBackup !== plan.patchText) {
    throw new Error(
      `Migration backup already exists with different content: ${backupPath} (run --rollback first)`,
    )
  }

  await mkdir(dirname(backupPath), { recursive: true })
  if (existingBackup === null) await writeFile(backupPath, plan.patchText, 'utf8')
  if (!existingManifest) {
    await writeFile(manifestPath, `${JSON.stringify(desiredManifest, null, 2)}\n`, 'utf8')
  }

  const moved = []
  for (const { name, from, to, link } of moves) {
    if (await lstatIfExists(from)) {
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
      moved.push(name)
    }
    if (link && (await lstatIfExists(link.path))) await unlink(link.path)
  }

  const writtenPatch = await writePatchIfChanged(patchPath, plan.nextPatchText)
  return { backupPath, moved, writtenPatch }
}

/**
 * Undo the last migration: restore the old patch text, the package directories
 * and the legacy profile links. The current patch is kept as a safety copy.
 *
 * @param {{pluginsDir: string, backupDir?: string, patchPath?: string, dryRun?: boolean, now?: () => Date}} options
 * @returns {Promise<{patchPath: string, backupPath: string, restored: string[], dryRun: boolean}>}
 */
export async function rollbackMigration(options) {
  const input = normalizeRollbackInput(options)
  const backupDir = input.backupDir ?? join(input.pluginsDir, BACKUP_DIR_NAME)
  const manifestPath = join(backupDir, MANIFEST_NAME)
  const manifest = await readMigrationManifest(manifestPath)
  const patchPath = input.patchPath ?? manifest.patchPath

  const restored = []
  for (const pkg of manifest.packages) {
    const fromStats = await lstatIfExists(pkg.from)
    const toStats = await lstatIfExists(pkg.to)
    if (fromStats && toStats) {
      throw new Error(`Cannot roll back migration: ${pkg.from} already exists`)
    }
    if (!fromStats && !toStats) {
      throw new Error(`Cannot roll back migration: backup package missing at ${pkg.to}`)
    }
    restored.push(pkg.name)
  }

  for (const link of manifest.links) {
    const stats = await lstatIfExists(link.path)
    if (!stats) continue
    if (!stats.isSymbolicLink()) {
      throw new Error(`Cannot restore legacy link ${link.path}: path exists and is not a link`)
    }
    const actual = resolve(dirname(link.path), await readlink(link.path))
    if (!samePath(actual, link.target)) {
      throw new Error(`Cannot restore legacy link ${link.path}: it points to ${actual}`)
    }
  }

  const backupPath = join(backupDir, manifest.patchBackup)
  const backupText = await readTextIfExists(backupPath)
  if (backupText === null) {
    throw new Error(`Malformed migration backup: patch backup file missing: ${backupPath}`)
  }

  if (input.dryRun) {
    return { patchPath, backupPath, restored, dryRun: true }
  }

  for (const pkg of manifest.packages) {
    if (await lstatIfExists(pkg.to)) {
      await mkdir(dirname(pkg.from), { recursive: true })
      await rename(pkg.to, pkg.from)
    }
  }
  for (const link of manifest.links) {
    if (await lstatIfExists(link.path)) continue
    await mkdir(dirname(link.path), { recursive: true })
    await symlink(link.target, link.path, process.platform === 'win32' ? 'junction' : 'dir')
  }

  const currentText = await readTextIfExists(patchPath)
  if (currentText !== backupText) {
    if (currentText !== null) {
      const stamp = stampOf(toDate(input.now).toISOString())
      await writeFile(join(backupDir, `patch-pre-rollback-${stamp}.yml`), currentText, 'utf8')
    }
    await writePatchIfChanged(patchPath, backupText)
  }

  await rm(manifestPath, { force: true })
  return { patchPath, backupPath, restored, dryRun: false }
}

async function findLegacyPackages(pluginsDir) {
  const entries = await readdir(pluginsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })

  const packages = []
  for (const entry of entries) {
    const match = entry.name.match(LEGACY_DIR_NAME)
    if (!match) continue
    const from = join(pluginsDir, entry.name)
    const stats = await lstat(from)
    if (!stats.isDirectory() && !stats.isSymbolicLink()) {
      throw new Error(`Malformed legacy package: ${from} is not a directory`)
    }
    await validateLegacyManifest(from, match[1])
    packages.push({ name: entry.name, from })
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name))
}

async function validateLegacyManifest(dir, expectedVersion) {
  const manifestPath = join(dir, 'package.json')
  const text = await readTextIfExists(manifestPath)
  if (text === null) {
    throw new Error(`Malformed legacy package: missing package.json in ${dir}`)
  }

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`Malformed legacy package: invalid package.json in ${dir}`)
  }
  if (!isPlainObject(manifest) || manifest.name !== LEGACY_PACKAGE) {
    throw new Error(
      `Malformed legacy package: ${dir} declares package name ${JSON.stringify(manifest?.name)}, expected ${LEGACY_PACKAGE}`,
    )
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Malformed legacy package: ${dir} declares version ${JSON.stringify(manifest.version)}, expected ${expectedVersion}`,
    )
  }
}

async function findLegacyLinks(profileNodeModules, packages) {
  // Only a link owned by a package we are about to move is part of this migration.
  // An npm-style `node_modules/dsh-computer-use` installed without a plugin dir
  // stays valid and is restored by the patch rollback alone.
  if (!profileNodeModules || packages.length === 0) return []
  const linkPath = join(profileNodeModules, LEGACY_LINK_NAME)
  const stats = await lstatIfExists(linkPath)
  if (!stats) return []
  if (!stats.isSymbolicLink()) {
    throw new Error(
      `Ambiguous legacy link ${linkPath}: expected a symbolic link or junction; remove it manually and retry`,
    )
  }

  const target = resolve(dirname(linkPath), await readlink(linkPath))
  const owner = packages.find((pkg) => samePath(pkg.from, target))
  // A link to an external source checkout stays valid after migration; leave it alone.
  return owner ? [{ path: linkPath, target, package: owner.name }] : []
}

async function validateExistingLink(link) {
  const stats = await lstatIfExists(link.path)
  if (!stats) return
  if (!stats.isSymbolicLink()) {
    throw new Error(`Cannot migrate legacy link ${link.path}: not a symbolic link`)
  }
  const actual = resolve(dirname(link.path), await readlink(link.path))
  if (!samePath(actual, link.target)) {
    throw new Error(`Cannot migrate legacy link ${link.path}: it points to ${actual}`)
  }
}

async function readMigrationManifest(manifestPath, { optional = false } = {}) {
  const text = await readTextIfExists(manifestPath)
  if (text === null) {
    if (optional) return null
    throw new Error(`No migration backup found: ${manifestPath}`)
  }

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`Malformed migration backup at ${manifestPath}: invalid JSON`)
  }
  validateMigrationManifest(manifest, manifestPath)
  return manifest
}

function validateMigrationManifest(manifest, manifestPath) {
  const fail = (detail) => {
    throw new Error(`Malformed migration backup at ${manifestPath}: ${detail}`)
  }

  if (!isPlainObject(manifest) || manifest.version !== MANIFEST_VERSION) fail('unsupported version')
  if (typeof manifest.createdAt !== 'string') fail('missing createdAt')
  if (typeof manifest.patchPath !== 'string' || !isAbsolute(manifest.patchPath)) {
    fail('missing patchPath')
  }
  if (
    typeof manifest.patchBackup !== 'string' ||
    basename(manifest.patchBackup) !== manifest.patchBackup
  ) {
    fail('missing patchBackup')
  }
  if (!Array.isArray(manifest.packages)) fail('missing packages')
  for (const pkg of manifest.packages) {
    if (!isPlainObject(pkg) || typeof pkg.name !== 'string' || pkg.name.length === 0) fail('invalid package name')
    if (typeof pkg.from !== 'string' || !isAbsolute(pkg.from)) fail(`invalid package path for ${pkg.name}`)
    if (typeof pkg.to !== 'string' || !isAbsolute(pkg.to)) fail(`invalid backup path for ${pkg.name}`)
  }
  if (!Array.isArray(manifest.links)) fail('missing links')
  for (const link of manifest.links) {
    if (typeof link?.path !== 'string' || !isAbsolute(link.path)) fail('invalid link path')
    if (typeof link.target !== 'string' || !isAbsolute(link.target)) fail('invalid link target')
  }
}

function normalizePlanInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid migration options: expected an object')
  const { patchText, pluginsDir, profileNodeModules, patchPath, now } = options
  if (typeof patchText !== 'string') {
    throw new Error('Invalid migration input: patchText must be a string')
  }
  assertAbsolutePath(pluginsDir, 'pluginsDir', true)
  if (profileNodeModules !== undefined) assertAbsolutePath(profileNodeModules, 'profileNodeModules')
  if (patchPath !== undefined) assertAbsolutePath(patchPath, 'patchPath')

  return {
    patchText,
    pluginsDir: resolve(pluginsDir),
    profileNodeModules: profileNodeModules === undefined ? null : resolve(profileNodeModules),
    patchPath: patchPath === undefined ? null : resolve(patchPath),
    now,
  }
}

function normalizeRollbackInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid rollback options: expected an object')
  const { pluginsDir, backupDir, patchPath, dryRun, now } = options
  assertAbsolutePath(pluginsDir, 'pluginsDir', true)
  if (backupDir !== undefined) assertAbsolutePath(backupDir, 'backupDir')
  if (patchPath !== undefined) assertAbsolutePath(patchPath, 'patchPath')

  return {
    pluginsDir: resolve(pluginsDir),
    backupDir: backupDir === undefined ? null : resolve(backupDir),
    patchPath: patchPath === undefined ? null : resolve(patchPath),
    dryRun: dryRun === true,
    now,
  }
}

function validatePlan(plan) {
  if (!isPlainObject(plan)) throw new Error('Invalid migration plan: expected an object')
  if (!Array.isArray(plan.actions)) throw new Error('Invalid migration plan: actions must be an array')
  for (const action of plan.actions) {
    if (!isPlainObject(action)) throw new Error('Invalid migration plan: action must be an object')
    if (!['remove-preset', 'move-package', 'write-backup'].includes(action.kind)) {
      throw new Error(`Invalid migration plan: unknown action ${JSON.stringify(action.kind)}`)
    }
  }
}

function validateMoveDetail(detail) {
  if (!isPlainObject(detail)) throw new Error('Invalid migration plan: move-package detail expected')
  const { name, from, to, link } = detail
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Invalid migration plan: move-package name must be a non-empty string')
  }
  if (typeof from !== 'string' || !isAbsolute(from)) {
    throw new Error(`Invalid migration plan: source path for ${name} must be absolute`)
  }
  if (typeof to !== 'string' || !isAbsolute(to)) {
    throw new Error(`Invalid migration plan: backup path for ${name} must be absolute`)
  }
  if (link !== undefined) {
    if (!isPlainObject(link)) throw new Error(`Invalid migration plan: invalid link for ${name}`)
    if (typeof link.path !== 'string' || !isAbsolute(link.path)) {
      throw new Error(`Invalid migration plan: link path for ${name} must be absolute`)
    }
    if (typeof link.target !== 'string' || !isAbsolute(link.target)) {
      throw new Error(`Invalid migration plan: link target for ${name} must be absolute`)
    }
  }
  return { name, from, to, link }
}

function sameManifest(left, right) {
  return (
    left.patchPath === right.patchPath &&
    left.patchBackup === right.patchBackup &&
    JSON.stringify(left.packages) === JSON.stringify(right.packages) &&
    JSON.stringify(left.links) === JSON.stringify(right.links)
  )
}

async function writePatchIfChanged(patchPath, text) {
  const current = await readTextIfExists(patchPath)
  if (current === text) return false

  await mkdir(dirname(patchPath), { recursive: true })
  const tempPath = `${patchPath}.tmp-${process.pid}`
  await writeFile(tempPath, text, 'utf8')
  await rename(tempPath, patchPath)
  return true
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

function assertAbsolutePath(value, name, required = false) {
  if (value === undefined || value === null) {
    if (!required) return
    throw new Error(`Invalid migration input: ${name} must be an absolute path`)
  }
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`Invalid migration input: ${name} must be an absolute path`)
  }
}

function toDate(now) {
  const date = typeof now === 'function' ? now() : (now ?? new Date())
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid migration input: now must return a valid Date')
  }
  return date
}

function stampOf(iso) {
  return iso.replace(/[:.]/g, '-')
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
