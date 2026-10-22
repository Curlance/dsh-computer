/**
 * install.js —— 更新器的文件系统核心：下载/校验/解包/原子切换/心跳/回滚。
 *
 * 布局与 installer 一致：`<dsh-home>/plugins`、`<dsh-home>/profiles/<p>/node_modules`
 * 和 `<dsh-home>/cordis.patch.yml`。更新状态（heartbeat/pending/previous）放在注入的
 * `stateDir`（CLI 用 `<dsh-home>/computer/update`），因此测试不会碰真实 `~/.dsh`。
 *
 * 安全不变量：
 * - 先校验 sha256 再写任何插件目录；不匹配抛 IntegrityError 且无半成品。
 * - 只有 package.json 声明 `dsh-computer@<version>` 的目录才能发布/切换。
 * - 切换前写 previous/pending 标记，失败后 rollback 可恢复。
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { parseVersion } from '../install/version.js'

const execFileAsync = promisify(execFile)

const PACKAGE_NAME = 'dsh-computer'
const LINK_NAME = 'dsh-computer'
const HEARTBEAT_FILE = 'heartbeat.json'
const PENDING_FILE = 'pending.json'
const PREVIOUS_FILE = 'previous.json'
const STATE_DIR_NAME = '_update'
const DEFAULT_STALE_MS = 600000
const SHA256_RE = /^[0-9a-f]{64}$/
const PROFILE_RE = /^[A-Za-z0-9._-]+$/
const REPLACE_FALLBACK_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** sha256 不匹配：已下载内容不可信，调用方必须保留旧版本。 */
export class IntegrityError extends Error {
  constructor(expectedSha256, actualSha256, tarballUrl) {
    super(`SHA-256 mismatch for ${tarballUrl}: expected ${expectedSha256}, got ${actualSha256}`)
    this.name = 'IntegrityError'
    this.code = 'integrity-mismatch'
    this.expectedSha256 = expectedSha256
    this.actualSha256 = actualSha256
    this.tarballUrl = tarballUrl
  }
}

/**
 * 下载 tarball、校验 sha256、解包并原子发布到 `pluginsDir/dsh-computer-<version>`。
 * 已存在且身份匹配时直接复用（不重复下载）；身份不匹配则拒绝覆盖。
 * `version` 必填，且必须与 tarball 内 package.json 的 version 一致。
 *
 * @param {{
 *   cacheDir: string, pluginsDir: string, tarballUrl: string, sha256: string,
 *   version: string, fetchImpl?: Function, extractImpl?: Function,
 * }} options
 * @returns {Promise<{version: string, path: string}>}
 */
export async function installVersion(options) {
  const input = normalizeInstallInput(options)
  const targetDir = join(input.pluginsDir, `${PACKAGE_NAME}-${input.version}`)

  if (await lstatIfExists(targetDir)) {
    await assertPackageDir(targetDir, input.version)
    return { version: input.version, path: targetDir }
  }

  const response = await input.fetchImpl(input.tarballUrl)
  if (!response || response.ok !== true) {
    throw new Error(`Download failed for ${input.tarballUrl}: HTTP ${response?.status ?? 'unknown'}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== input.sha256) {
    throw new IntegrityError(input.sha256, actualSha256, input.tarballUrl)
  }

  await mkdir(input.cacheDir, { recursive: true })
  const tarballPath = join(input.cacheDir, `${PACKAGE_NAME}-${input.version}.tgz`)
  await writeFileAtomic(tarballPath, bytes)

  await mkdir(input.pluginsDir, { recursive: true })
  const tempDir = join(
    input.pluginsDir,
    `.install-${input.version}-${process.pid}-${randomUUID().slice(0, 8)}`,
  )
  await mkdir(tempDir)
  try {
    await input.extractImpl(tarballPath, tempDir)
    const packageRoot = await findPackageRoot(tempDir, input.version)
    await rename(packageRoot, targetDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  await assertPackageDir(targetDir, input.version)
  return { version: input.version, path: targetDir }
}

/**
 * 原子地把 `profileNodeModules/dsh-computer` 指向新版本，并记录 previous/pending。
 * pending 表示“这次切换还没被新版本的心跳确认”，needsRollback 据此兜底。
 *
 * @param {{
 *   pluginsDir: string, profileNodeModules: string, version: string,
 *   stateDir?: string, patchBackupPath?: string, patchPath?: string,
 *   profile?: string, now?: Date|(() => Date),
 * }} options
 * @returns {Promise<{version: string, path: string, changed: boolean, previous: string|null}>}
 */
export async function switchCurrent(options) {
  const input = normalizeSwitchInput(options)
  const targetDir = join(input.pluginsDir, `${PACKAGE_NAME}-${input.version}`)
  await assertPackageDir(targetDir, input.version)

  const linkPath = join(input.profileNodeModules, LINK_NAME)
  const current = await readLinkTarget(linkPath)
  if (current && samePath(current.path, targetDir)) {
    return { version: input.version, path: targetDir, changed: false, previous: current.version }
  }

  const previous = current
    ? { version: current.version, path: current.path }
    : { version: null, path: null }
  const at = toDate(input.now).toISOString()

  await mkdir(input.stateDir, { recursive: true })
  await writeJsonAtomic(join(input.stateDir, PREVIOUS_FILE), {
    ...previous,
    // Record the profile so `rollback` can restore the same profile when the
    // caller does not pass one again.
    profile: input.profile,
    patchBackup: input.patchBackupPath,
    patchPath: input.patchPath,
    at,
  })
  await writeJsonAtomic(join(input.stateDir, PENDING_FILE), { version: input.version, at })

  await mkdir(input.profileNodeModules, { recursive: true })
  await replaceLink(linkPath, targetDir)

  return { version: input.version, path: targetDir, changed: true, previous: previous.version }
}

/**
 * 原子写入心跳；`source: 'runtime'` 是 DSH 运行时，`updater` 是更新器自己。
 *
 * @param {{stateDir: string, version: string, dshVersion?: string|null,
 *          source?: string, now?: Date|(() => Date)}} options
 * @returns {Promise<{path: string}>}
 */
export async function recordHeartbeat(options) {
  const input = normalizeHeartbeatInput(options)
  const path = join(input.stateDir, HEARTBEAT_FILE)
  await mkdir(input.stateDir, { recursive: true })
  await writeJsonAtomic(path, {
    version: input.version,
    dshVersion: input.dshVersion,
    source: input.source,
    at: toDate(input.now).toISOString(),
  })
  return { path }
}

/**
 * 有待确认的切换且没有运行时心跳确认时为 true。
 * 只有 `source === 'runtime'` 且未过期的心跳才算确认；updater 自己写的心跳、
 * 缺失、非法或过期心跳都视为“需要回滚”。
 *
 * @param {{stateDir: string, now?: Date|(() => Date), staleMs?: number}} options
 * @returns {Promise<boolean>}
 */
export async function needsRollback(options) {
  const input = normalizeRollbackCheckInput(options)

  let pending
  try {
    pending = await readJsonIfExists(join(input.stateDir, PENDING_FILE))
  } catch {
    return true
  }
  if (!pending) return false

  let heartbeat
  try {
    heartbeat = await readJsonIfExists(join(input.stateDir, HEARTBEAT_FILE))
  } catch {
    return true
  }
  if (!heartbeat || typeof heartbeat.at !== 'string') return true
  // 更新器自己的心跳只证明“切换已写入”，不证明新版本真的启动过。
  if (heartbeat.source !== 'runtime') return true

  const at = Date.parse(heartbeat.at)
  if (Number.isNaN(at)) return true
  return toDate(input.now).getTime() - at > input.staleMs
}

/**
 * 清除 pending 标记（切换已由心跳确认）。
 * @param {{stateDir: string}} options
 */
export async function clearPending(options) {
  const stateDir = requireAbsolutePath(options?.stateDir, 'stateDir')
  await rm(join(stateDir, PENDING_FILE), { force: true })
}

/**
 * 恢复 previous 链接与切换前的 patch 备份，并清除 pending/previous 标记。
 * 没有标记时为空操作（可重复调用）；恢复前先验证 previous 目录与备份都存在。
 *
 * @param {{pluginsDir: string, profileNodeModules?: string, stateDir?: string,
 *          patchBackupPath?: string, patchPath?: string}} options
 * @returns {Promise<{restored: string|null, patch: string|null}>}
 */
export async function rollback(options) {
  const input = normalizeRollbackInput(options)
  const pendingPath = join(input.stateDir, PENDING_FILE)
  const previousPath = join(input.stateDir, PREVIOUS_FILE)
  const pending = await readJsonIfExists(pendingPath)
  const previous = await readJsonIfExists(previousPath)
  if (!pending && !previous) return { restored: null, patch: null }

  // Without an explicit --profile, restore the profile recorded by the switch
  // instead of the default one (older markers without a profile use desktop).
  const profileNodeModules =
    input.profileNodeModules ?? deriveProfileNodeModules(input.pluginsDir, previous)
  const backupPath = input.patchBackupPath ?? previous?.patchBackup ?? null
  let backupText = null
  if (backupPath !== null) {
    backupText = await readTextIfExists(requireAbsolutePath(backupPath, 'patchBackupPath'))
    if (backupText === null) {
      throw new Error(`Cannot roll back: patch backup is missing at ${backupPath}`)
    }
  }

  let restored = null
  if (previous && previous.path !== null) {
    const previousDir = requireAbsolutePath(previous.path, 'previous version path')
    if (!(await lstatIfExists(previousDir))) {
      throw new Error(`Cannot roll back: previous version is missing at ${previousDir}`)
    }
    await replaceLink(join(profileNodeModules, LINK_NAME), previousDir)
    restored = typeof previous.version === 'string' ? previous.version : null
  } else if (previous) {
    // 首次安装被回滚：恢复“没有链接”的旧状态。
    const linkPath = join(profileNodeModules, LINK_NAME)
    const stats = await lstatIfExists(linkPath)
    if (stats) {
      await assertLink(linkPath)
      await unlink(linkPath)
    }
  }

  let patchPath = null
  if (backupText !== null && backupPath !== null) {
    patchPath =
      input.patchPath ??
      (typeof previous?.patchPath === 'string'
        ? requireAbsolutePath(previous.patchPath, 'patchPath')
        : join(dirname(input.pluginsDir), 'cordis.patch.yml'))
    await writeFileAtomic(patchPath, backupText)
  }

  await rm(pendingPath, { force: true })
  await rm(previousPath, { force: true })
  return { restored, patch: patchPath }
}

// ------------------------------------------------------------------ internals

function normalizeInstallInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid install options: expected an object')
  const { cacheDir, pluginsDir, tarballUrl, sha256, version, fetchImpl, extractImpl } = options
  if (typeof tarballUrl !== 'string' || tarballUrl.trim() === '') {
    throw new Error('Invalid install input: tarballUrl must be a non-empty string')
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256.trim().toLowerCase())) {
    throw new Error('Invalid install input: sha256 must be 64 hex characters')
  }
  const parsedVersion = parseVersion(version)
  if (!parsedVersion) throw new Error('Invalid install input: version must be a valid semver')
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new Error('Invalid install input: fetchImpl must be a function')
  }
  if (extractImpl !== undefined && typeof extractImpl !== 'function') {
    throw new Error('Invalid install input: extractImpl must be a function')
  }

  return {
    cacheDir: requireAbsolutePath(cacheDir, 'cacheDir'),
    pluginsDir: requireAbsolutePath(pluginsDir, 'pluginsDir'),
    tarballUrl,
    sha256: sha256.trim().toLowerCase(),
    version,
    fetchImpl: fetchImpl ?? defaultFetch,
    extractImpl: extractImpl ?? extractTarball,
  }
}

function normalizeSwitchInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid switch options: expected an object')
  const {
    pluginsDir,
    profileNodeModules,
    version,
    stateDir,
    patchBackupPath,
    patchPath,
    profile,
    now,
  } = options
  const parsedVersion = parseVersion(version)
  if (!parsedVersion) throw new Error('Invalid switch input: version must be a valid semver')

  const resolvedPluginsDir = requireAbsolutePath(pluginsDir, 'pluginsDir')
  return {
    pluginsDir: resolvedPluginsDir,
    profileNodeModules: requireAbsolutePath(profileNodeModules, 'profileNodeModules'),
    version,
    profile: normalizeProfile(profile),
    stateDir:
      stateDir === undefined
        ? join(resolvedPluginsDir, STATE_DIR_NAME)
        : requireAbsolutePath(stateDir, 'stateDir'),
    patchBackupPath:
      patchBackupPath === undefined || patchBackupPath === null
        ? null
        : requireAbsolutePath(patchBackupPath, 'patchBackupPath'),
    patchPath:
      patchPath === undefined || patchPath === null
        ? null
        : requireAbsolutePath(patchPath, 'patchPath'),
    now,
  }
}

function normalizeHeartbeatInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid heartbeat options: expected an object')
  const { stateDir, version, dshVersion = null, source = 'runtime', now } = options
  if (!parseVersion(version)) throw new Error('Invalid heartbeat input: version must be a valid semver')
  if (dshVersion !== null && typeof dshVersion !== 'string') {
    throw new Error('Invalid heartbeat input: dshVersion must be a string or null')
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('Invalid heartbeat input: source must be a non-empty string')
  }
  return { stateDir: requireAbsolutePath(stateDir, 'stateDir'), version, dshVersion, source, now }
}

function normalizeRollbackCheckInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid needsRollback options: expected an object')
  const { stateDir, now, staleMs = DEFAULT_STALE_MS } = options
  if (typeof staleMs !== 'number' || !Number.isFinite(staleMs) || staleMs <= 0) {
    throw new Error('Invalid needsRollback input: staleMs must be a positive number')
  }
  return { stateDir: requireAbsolutePath(stateDir, 'stateDir'), now, staleMs }
}

function normalizeRollbackInput(options) {
  if (!isPlainObject(options)) throw new Error('Invalid rollback options: expected an object')
  const { pluginsDir, profileNodeModules, stateDir, patchBackupPath, patchPath } = options
  const resolvedPluginsDir = requireAbsolutePath(pluginsDir, 'pluginsDir')
  return {
    pluginsDir: resolvedPluginsDir,
    profileNodeModules:
      profileNodeModules === undefined
        ? null
        : requireAbsolutePath(profileNodeModules, 'profileNodeModules'),
    stateDir:
      stateDir === undefined
        ? join(resolvedPluginsDir, STATE_DIR_NAME)
        : requireAbsolutePath(stateDir, 'stateDir'),
    patchBackupPath:
      patchBackupPath === undefined || patchBackupPath === null
        ? null
        : requireAbsolutePath(patchBackupPath, 'patchBackupPath'),
    patchPath:
      patchPath === undefined || patchPath === null
        ? null
        : requireAbsolutePath(patchPath, 'patchPath'),
  }
}

function defaultFetch(url) {
  return globalThis.fetch(url)
}

async function extractTarball(tarballPath, destDir) {
  // Extract from inside destDir using a relative archive name: GNU tar on
  // Windows treats the colon in `C:\...` as a remote host and rejects it.
  const localName = `.update-${randomUUID().slice(0, 8)}.tgz`
  const localPath = join(destDir, localName)
  await copyFile(tarballPath, localPath)
  try {
    await execFileAsync('tar', ['-xzf', localName], { cwd: destDir })
  } finally {
    await rm(localPath, { force: true })
  }
}

async function findPackageRoot(tempDir, version) {
  const direct = join(tempDir, 'package.json')
  if ((await readTextIfExists(direct)) !== null) {
    await assertPackageDir(tempDir, version)
    return tempDir
  }
  const nested = join(tempDir, 'package')
  if ((await readTextIfExists(join(nested, 'package.json'))) !== null) {
    await assertPackageDir(nested, version)
    return nested
  }
  throw new Error(`Extracted tarball is missing package.json in ${tempDir}`)
}

async function assertPackageDir(dir, version) {
  const manifestPath = join(dir, 'package.json')
  const text = await readTextIfExists(manifestPath)
  if (text === null) throw new Error(`Missing package.json in ${dir}`)

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new Error(`Malformed package.json in ${dir}`)
  }
  if (!isPlainObject(manifest) || manifest.name !== PACKAGE_NAME) {
    throw new Error(
      `Unexpected package name in ${dir}: ${JSON.stringify(manifest?.name)}, expected ${PACKAGE_NAME}`,
    )
  }
  if (manifest.version !== version) {
    throw new Error(
      `Unexpected package version in ${dir}: ${JSON.stringify(manifest.version)}, expected ${version}`,
    )
  }
}

async function readLinkTarget(linkPath) {
  const stats = await lstatIfExists(linkPath)
  if (!stats) return null
  if (!stats.isSymbolicLink()) {
    throw new Error(`Refusing to replace existing non-link path: ${linkPath}`)
  }
  const target = resolve(dirname(linkPath), await readlink(linkPath))
  const match = basename(target).match(new RegExp(`^${PACKAGE_NAME}-(.+)$`))
  return { path: target, version: match ? match[1] : null }
}

async function assertLink(linkPath) {
  const stats = await lstat(linkPath)
  if (!stats.isSymbolicLink()) {
    throw new Error(`Cannot roll back: ${linkPath} exists and is not a link`)
  }
}

async function replaceLink(linkPath, targetDir) {
  const tempPath = `${linkPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  await symlink(targetDir, tempPath, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    try {
      await rename(tempPath, linkPath)
    } catch (error) {
      if (!REPLACE_FALLBACK_CODES.has(error.code)) throw error
      // Windows 无法用 rename 覆盖已有 junction：退化为 unlink+symlink 的短暂空窗，
      // 此前的 previous/pending 标记保证失败后仍可回滚。
      await unlink(linkPath).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError
      })
      await rename(tempPath, linkPath)
    }
  } catch (error) {
    // 切换失败时不留下 `<link>.tmp-*` 链接。
    await rm(tempPath, { force: true })
    throw error
  }

  const actual = resolve(dirname(linkPath), await readlink(linkPath))
  if (!samePath(actual, targetDir)) {
    throw new Error(`Failed to point ${linkPath} at ${targetDir}`)
  }
}

async function writeJsonAtomic(path, value) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeFileAtomic(path, content) {
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  await writeFile(tempPath, content)
  await rename(tempPath, path)
}

async function readJsonIfExists(path) {
  const text = await readTextIfExists(path)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Malformed JSON at ${path}`)
  }
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

function normalizeProfile(profile) {
  if (profile === undefined || profile === null) return null
  if (
    typeof profile !== 'string' ||
    !PROFILE_RE.test(profile) ||
    profile === '.' ||
    profile === '..'
  ) {
    throw new Error('Invalid switch input: profile must be a simple profile name')
  }
  return profile
}

function deriveProfileNodeModules(pluginsDir, previous) {
  const profile = previous?.profile ?? 'desktop'
  if (
    typeof profile !== 'string' ||
    !PROFILE_RE.test(profile) ||
    profile === '.' ||
    profile === '..'
  ) {
    throw new Error(`Cannot roll back: invalid recorded profile ${JSON.stringify(profile)}`)
  }
  return join(dirname(pluginsDir), 'profiles', profile, 'node_modules')
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`Invalid update input: ${name} must be an absolute path`)
  }
  return resolve(value)
}

function toDate(now) {
  const date = typeof now === 'function' ? now() : (now ?? new Date())
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Invalid update input: now must return a valid Date')
  }
  return date
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
