/**
 * compat.js —— DSH 运行时版本与能力探测。
 *
 * 所有外部依赖（环境变量、文件读取、命令执行）都通过参数注入，
 * 便于单测且不 import 宿主包。探测失败返回 null / 全 false，不抛错；
 * 只有 assertCompatible 在明确不兼容时抛出带字段的错误。
 */
import { readFile as nodeReadFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parseVersion, satisfiesRange } from './install/version.js'

const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/
// 只信任 DSH 自己的 manifest：`@deepseek-ai/dsh*` 或 deepseek+harness 包名；
// 不能把用户目录里无关的 `<home>/package.json` 当成 DSH。
const DSH_PACKAGE_RE = /^@deepseek-ai\/dsh(?:-[a-z0-9.-]+)?$/

/** 本插件要求的 DSH 运行时范围（与 package.json engines.dsh 保持一致）。 */
export const DSH_REQUIREMENT = '>=0.2.1-rc.2 <0.3.0'

/** 明确的版本不兼容错误，供 upper layer 生成可操作提示。 */
export class IncompatibleDshError extends Error {
  constructor(runtimeVersion, requirements = DSH_REQUIREMENT) {
    super(`DSH ${runtimeVersion ?? 'unknown'} does not satisfy required range ${requirements}`)
    this.name = 'IncompatibleDshError'
    this.code = 'incompatible-version'
    this.runtimeVersion = runtimeVersion ?? null
    this.requirements = requirements
  }
}

/**
 * 探测 DSH 运行时版本。优先级（第一个有效版本胜出）：
 *   1. env `DSH_VERSION`
 *   2. `env.DSH_APP_PACKAGE_JSON`（显式给定的宿主 package.json）
 *   3. 相对 DSH home 的已知安装文件：
 *      `<dshHome>/version`（版本哨兵，优先），
 *      `<install-root>/resources/app/package.json`（解包桌面版）、
 *      `<install-root>/package.json`（便携/dev 安装）。
 *      package manifest 只在 `name` 是 DSH 包名时采信，
 *      因此无关的 `<home>/package.json` 会被忽略。
 *   4. PATH 上的 `dsh --version`；win32 走
 *      `cmd.exe /d /s /c "dsh --version"`，这样 `.cmd` shim 也能启动
 *   5. 全部失败返回 null
 *
 * `readFile`/`execFile` 可注入，便于在不装真实 DSH 的情况下测试顺序。
 * 旧的 `exec(command)` 注入保留兼容；优先级低于 `execFile`。
 *
 * @param {{dshHome?: string, env?: Record<string, string | undefined>,
 *          readFile?: (path: string) => Promise<string> | string,
 *          execFile?: (file: string, args: string[]) => Promise<any>,
 *          exec?: (command: string) => Promise<string> | string,
 *          platform?: string}} [options]
 * @returns {Promise<string|null>}
 */
export async function detectDshVersion(options = {}) {
  const {
    dshHome,
    env = {},
    readFile: readText = (path) => nodeReadFile(path, 'utf8'),
    execFile: runExecFile,
    exec,
    platform = process.platform,
  } = options ?? {}

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
    let output
    if (typeof runExecFile === 'function') {
      output =
        platform === 'win32'
          ? await runExecFile('cmd.exe', ['/d', '/s', '/c', 'dsh --version'])
          : await runExecFile('dsh', ['--version'])
    } else if (typeof exec === 'function') {
      output = await exec('dsh --version')
    } else {
      return null
    }
    const text = typeof output === 'string' ? output : output?.stdout
    const fromExec = normaliseVersion(String(text ?? '').match(VERSION_RE)?.[0])
    if (fromExec !== null) return fromExec
  } catch {
    // dsh 不在 PATH 或没有 --version：继续尝试已安装应用
  }

  // Desktop installs often have no `dsh` on PATH. Ask the running app for its
  // file version (0.2.1-rc.2), which is the DSH runtime version.
  if (platform === 'win32' && typeof runExecFile === 'function') {
    try {
      const output = await runExecFile('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$p=(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path; if($p){(Get-Item $p).VersionInfo.FileVersion}",
      ])
      const text = typeof output === 'string' ? output : output?.stdout
      const fromApp = normaliseVersion(String(text ?? '').trim().match(VERSION_RE)?.[0])
      if (fromApp !== null) return fromApp
    } catch {
      // 应用未运行或 PowerShell 不可用：版本保持未知
    }
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
 * 探测宿主能力（approval / attachments / tools）。未知 ctx 返回全 false。
 * @param {object} ctx
 * @returns {{approval:boolean, attachments:boolean, tools:boolean}}
 */
export function detectCapabilities(ctx = {}) {
  return {
    approval: typeof ctx?.approval?.request === 'function',
    attachments: typeof ctx?.attachments?.saveImage === 'function',
    tools: typeof ctx?.tools?.register === 'function',
  }
}

/**
 * 断言运行时版本满足要求；不满足抛 IncompatibleDshError。
 * @param {string|null} runtimeVersion
 * @param {string} requirements
 */
export function assertCompatible(runtimeVersion, requirements = DSH_REQUIREMENT) {
  if (typeof runtimeVersion !== 'string' || !satisfiesRange(requirements, runtimeVersion)) {
    throw new IncompatibleDshError(runtimeVersion, requirements)
  }
  return runtimeVersion
}
