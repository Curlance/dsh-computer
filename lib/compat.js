/**
 * compat.js —— DSH 运行时版本与能力探测。
 *
 * 所有外部依赖（环境变量、文件读取、命令执行）都通过参数注入，
 * 便于单测且不 import 宿主包。探测失败返回 null / 全 false，不抛错；
 * 只有 assertCompatible 在明确不兼容时抛出带字段的错误。
 */
import { parseVersion, satisfiesRange } from './install/version.js'

/** 本插件要求的 DSH 运行时范围（与 package.json engines.dsh 保持一致）。 */
export const DSH_REQUIREMENT = '>=0.2.1-rc.2 <0.3.0'

/** 明确的版本不兼容错误，供 upper layer 生成可操作提示。 */
export class IncompatibleDshError extends Error {
  constructor(runtimeVersion, requirements = DSH_REQUIREMENT) {
    super(`DSH ${runtimeVersion} does not satisfy required range ${requirements}`)
    this.name = 'IncompatibleDshError'
    this.code = 'incompatible-version'
    this.runtimeVersion = runtimeVersion
    this.requirements = requirements
  }
}

/**
 * 探测 DSH 版本。顺序：env.DSH_VERSION → env.DSH_APP_PACKAGE_JSON 指向文件的
 * `version` 字段 → 注入的 exec（如 `dsh --version`）。全部失败返回 null。
 *
 * @param {{env?:Record<string,string>, readFile?:(path:string)=>Promise<string>|string,
 *          exec?:(command:string)=>Promise<string>|string}} options
 * @returns {Promise<string|null>}
 */
export async function detectDshVersion({ env = {}, readFile, exec } = {}) {
  const fromEnv = normaliseVersion(env?.DSH_VERSION)
  if (fromEnv) return fromEnv

  const packageJsonPath = typeof env?.DSH_APP_PACKAGE_JSON === 'string' && env.DSH_APP_PACKAGE_JSON.length > 0
    ? env.DSH_APP_PACKAGE_JSON
    : null
  if (packageJsonPath && typeof readFile === 'function') {
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath))
      const fromFile = normaliseVersion(parsed?.version)
      if (fromFile) return fromFile
    } catch {
      // 读不到就继续尝试下一种来源
    }
  }

  if (typeof exec === 'function') {
    try {
      const output = await exec('dsh --version')
      const match = String(output ?? '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
      const fromExec = normaliseVersion(match?.[0])
      if (fromExec) return fromExec
    } catch {
      // 命令不存在或失败时视为未知
    }
  }

  return null
}

function normaliseVersion(value) {
  if (typeof value !== 'string') return null
  return parseVersion(value.trim()) ? value.trim().replace(/^v/, '') : null
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
    throw new IncompatibleDshError(runtimeVersion ?? 'unknown', requirements)
  }
  return runtimeVersion
}
