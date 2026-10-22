/**
 * version.js —— 轻量版本解析与范围匹配（不引入 semver 依赖）。
 *
 * 支持 DSH 使用的子集：`>=x.y.z <a.b.c`、`^x.y.z`、`~x.y.z`、精确版本。
 * 预发布标签（如 0.2.1-rc.2）参与比较：无标签版本 > 同版本预发布。
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本字符串；非法输入返回 null。 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const match = input.trim().match(VERSION_RE)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4],
  }
}

/** 比较预发布标识：数字段按数值，混合按字符串；数字 < 字符串。 */
function comparePrerelease(left, right) {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  const a = left.split('.')
  const b = right.split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const an = /^\d+$/.test(a[i])
    const bn = /^\d+$/.test(b[i])
    if (an && bn) {
      const diff = Number(a[i]) - Number(b[i])
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (an !== bn) return an ? -1 : 1
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/** 比较两个已解析版本：-1 / 0 / 1。 */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** caret 上界：^0.0.3 -> <0.0.4，^0.2.1 -> <0.3.0，^1.2.3 -> <2.0.0。 */
function caretUpper(base) {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, prerelease: null }
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, prerelease: null }
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: null }
}

function comparatorSatisfied(version, token) {
  const match = token.match(/^(>=|<=|>|<|=)?\s*(.+)$/)
  if (!match) return false
  const operator = match[1] || '='
  const target = parseVersion(match[2])
  if (!target) return false
  const delta = compareVersions(version, target)
  if (operator === '>=') return delta >= 0
  if (operator === '>') return delta > 0
  if (operator === '<=') return delta <= 0
  if (operator === '<') return delta < 0
  return delta === 0
}

/** 判断版本是否满足范围表达式（`>=a <b` / `^a` / `~a` / 精确）。 */
export function satisfiesRange(range, version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (!parsed) return false
  // 只有空串 / '*' 表示任意版本；null、undefined 等非法范围一律不匹配（fail closed）。
  if (typeof range !== 'string') return false
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*') return true

  const tokens = trimmed.split(/\s+/)
  for (const token of tokens) {
    if (token.startsWith('^')) {
      const base = parseVersion(token.slice(1))
      if (!base) return false
      if (compareVersions(parsed, base) < 0) return false
      const upper = caretUpper(base)
      if (compareVersions(parsed, upper) >= 0) return false
      continue
    }
    if (token.startsWith('~')) {
      const base = parseVersion(token.slice(1))
      if (!base) return false
      if (compareVersions(parsed, base) < 0) return false
      const upper = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: null }
      if (compareVersions(parsed, upper) >= 0) return false
      continue
    }
    if (!comparatorSatisfied(parsed, token)) return false
  }
  return true
}
