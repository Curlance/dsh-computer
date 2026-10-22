/**
 * compat.js —— 从更新清单中选择与当前 DSH 兼容的最高版本。
 *
 * 纯函数：不读文件、不联网。清单条目缺字段或格式不对就跳过（fail closed），
 * 当前 DSH 版本未知时返回 null，调用方必须显式处理而不是猜一个版本。
 */
import { compareVersions, parseVersion, satisfiesRange } from '../install/version.js'

const SHA256_RE = /^[0-9a-f]{64}$/
const HTTP_URL_RE = /^https?:\/\//i

/**
 * @param {{versions?: Array<{version: string, dsh: string, tarball: string, sha256: string}>}} manifest
 * @param {string} currentDsh
 * @returns {{version: string, tarball: string, sha256: string}|null}
 */
export function selectVersion(manifest, currentDsh) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.versions)) return null
  const current = typeof currentDsh === 'string' ? parseVersion(currentDsh.trim()) : null
  if (!current) return null

  const candidates = []
  for (const entry of manifest.versions) {
    if (!isPlainObject(entry)) continue
    const parsed = parseVersion(typeof entry.version === 'string' ? entry.version.trim() : null)
    if (!parsed) continue
    if (typeof entry.dsh !== 'string' || entry.dsh.trim() === '') continue
    if (typeof entry.tarball !== 'string' || !HTTP_URL_RE.test(entry.tarball)) continue
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256.toLowerCase())) continue
    if (!satisfiesRange(entry.dsh, currentDsh.trim())) continue

    candidates.push({
      version: entry.version.trim().replace(/^v/, ''),
      parsed,
      tarball: entry.tarball,
      sha256: entry.sha256.toLowerCase(),
    })
  }

  if (candidates.length === 0) return null
  candidates.sort((left, right) => compareVersions(right.parsed, left.parsed))
  const top = candidates[0]
  return { version: top.version, tarball: top.tarball, sha256: top.sha256 }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
