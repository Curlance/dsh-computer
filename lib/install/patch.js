/**
 * Pure text helpers for the managed HOME patch (`$DSH_HOME/cordis.patch.yml`).
 *
 * No filesystem access and no DSH host imports. Input is normalized to LF and
 * every writer emits the same canonical block, so repeated runs are byte-stable.
 */

/** @typedef {'# >>> dsh-computer (managed)' | '# <<< dsh-computer'} Marker */

export const BEGIN_MARKER = '# >>> dsh-computer (managed)'
export const END_MARKER = '# <<< dsh-computer'
export const MARKER = Object.freeze({ begin: BEGIN_MARKER, end: END_MARKER })

const MANAGED_BEGIN = /^#\s*>>>\s*dsh-computer\s+\(managed[^)]*\)$/
const MANAGED_END = /^#\s*<<<\s*dsh-computer$/
const LEGACY_BEGIN = /^#\s*>>>\s*dsh-computer-use\b/
const LEGACY_END = /^#\s*<<<\s*dsh-computer-use\b/
const ROW_ID_LINE = /^\s*(?:-\s+)?id:\s*(['"]?)([^'"\s#]+)\1\s*(?:#.*)?$/
const SAFE_YAML_STRING = /^[A-Za-z_~/][A-Za-z0-9_./~-]*$/
const RESERVED_YAML_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'])

/**
 * Insert or refresh the managed root plugin row.
 * @param {string} patchText existing `cordis.patch.yml` contents
 * @param {{id: string, name: string, config?: object}} options
 * @returns {string} LF-normalized patch text
 */
export function ensurePluginRow(patchText, options) {
  const { id, name, config } = validatePluginRow(options)
  const text = normalizePatchText(patchText)
  const lines = text.split('\n')
  const range = managedBlockRange(lines)
  const block = renderPluginBlock({ id, name, config }).split('\n')

  if (range) {
    validateManagedBlock(lines, range)
    return [...lines.slice(0, range.begin), ...block, ...lines.slice(range.end + 1)].join('\n')
  }

  const body = text.replace(/\n+$/, '')
  return body.length > 0 ? `${body}\n\n${block.join('\n')}\n` : `${block.join('\n')}\n`
}

/**
 * Remove the managed root plugin row when it contains `id`.
 * @param {string} patchText
 * @param {string} id
 * @returns {string} LF-normalized patch text
 */
export function removePluginRow(patchText, id) {
  assertRowId(id)
  const text = normalizePatchText(patchText)
  const lines = text.split('\n')
  const range = managedBlockRange(lines)
  if (!range) return text

  const body = validateManagedBlock(lines, range)
  if (!rowIds(body).includes(id)) return text
  return removeRange(lines, range)
}

/**
 * Remove a legacy `# >>> dsh-computer-use` block entirely.
 * @param {string} patchText
 * @returns {{text: string, removedPreset: boolean, removedRows: string[]}}
 */
export function ensureLegacyMigration(patchText) {
  let text = normalizePatchText(patchText)
  const removedRows = []
  let removedPreset = false

  for (;;) {
    const lines = text.split('\n')
    const range = legacyBlockRange(lines)
    if (!range) break

    removedPreset = true
    for (const id of rowIds(lines.slice(range.begin, range.end + 1))) {
      if (!removedRows.includes(id)) removedRows.push(id)
    }
    text = removeRange(lines, range)
  }

  return { text, removedPreset, removedRows }
}

function normalizePatchText(text) {
  if (typeof text !== 'string') throw new Error('Invalid patch text: expected a string')
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function managedBlockRange(lines) {
  const begins = []
  const ends = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (MANAGED_BEGIN.test(trimmed)) begins.push(index)
    else if (MANAGED_END.test(trimmed)) ends.push(index)
  })

  if (begins.length === 0 && ends.length === 0) return null
  if (begins.length > 1) throw malformed('duplicate begin marker')
  if (ends.length > 1) throw malformed('duplicate end marker')
  if (begins.length === 0) throw malformed('found end marker without begin marker')
  if (ends.length === 0) throw malformed(`missing "${END_MARKER}" end marker`)
  if (ends[0] < begins[0]) throw malformed('end marker appears before begin marker')

  return { begin: begins[0], end: ends[0] }
}

function validateManagedBlock(lines, range) {
  const body = lines.slice(range.begin + 1, range.end)
  const insertIndex = body.findIndex((line) => line.trim() === '- insert:')
  if (insertIndex === -1) throw malformed('expected a top-level "- insert:" line')

  // No YAML parser in the dependency-free installer, so protect the indentation
  // contract the patch loader relies on and fail before rewriting a broken block.
  for (const line of body.slice(insertIndex + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (line.includes('\t')) throw malformed('tabs are not allowed for indentation')
    if (!line.startsWith('  ')) throw malformed('invalid indentation under "- insert:"')
  }

  return body
}

function legacyBlockRange(lines) {
  let begin = -1
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (LEGACY_BEGIN.test(trimmed)) {
      if (begin !== -1) throw legacyMalformed('duplicate begin marker')
      begin = index
    } else if (LEGACY_END.test(trimmed)) {
      if (begin === -1) throw legacyMalformed('found end marker without begin marker')
      return { begin, end: index }
    }
  }

  if (begin !== -1) {
    throw legacyMalformed('missing "# <<< dsh-computer-use" end marker')
  }
  return null
}

function removeRange(lines, { begin, end }) {
  const before = lines.slice(0, begin)
  const after = lines.slice(end + 1)

  if (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
  else if (after.length > 0 && after[0].trim() === '') after.shift()

  let remaining = [...before, ...after].join('\n')
  if (before.length === 0) remaining = remaining.replace(/^\n+/, '')

  const trimmed = remaining.replace(/\n+$/, '')
  return trimmed.length > 0 ? `${trimmed}\n` : ''
}

function rowIds(lines) {
  const ids = []
  for (const line of lines) {
    const match = line.match(ROW_ID_LINE)
    if (match) ids.push(match[2])
  }
  return ids
}

function renderPluginBlock({ id, name, config }) {
  const lines = [
    BEGIN_MARKER,
    '- insert:',
    `    - id: ${renderString(id)}`,
    `      name: ${renderString(name)}`,
  ]

  if (Object.keys(config).length === 0) {
    lines.push('      config: {}')
  } else {
    lines.push('      config:')
    lines.push(...renderMapping(config, 8))
  }

  lines.push(END_MARKER)
  return lines.join('\n')
}

function renderMapping(value, indent) {
  const pad = ' '.repeat(indent)
  const lines = []

  for (const [key, item] of Object.entries(value)) {
    const renderedKey = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key)
    if (isPlainObject(item)) {
      if (Object.keys(item).length === 0) {
        lines.push(`${pad}${renderedKey}: {}`)
      } else {
        lines.push(`${pad}${renderedKey}:`)
        lines.push(...renderMapping(item, indent + 2))
      }
    } else if (Array.isArray(item)) {
      lines.push(`${pad}${renderedKey}: ${JSON.stringify(item)}`)
    } else {
      lines.push(`${pad}${renderedKey}: ${renderScalar(item)}`)
    }
  }

  return lines
}

function renderScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  return renderString(value)
}

function renderString(value) {
  return SAFE_YAML_STRING.test(value) && !RESERVED_YAML_WORDS.has(value.toLowerCase())
    ? value
    : JSON.stringify(value)
}

function validatePluginRow(options) {
  if (!isPlainObject(options)) throw new Error('Invalid plugin row options: expected an object')

  const { id, name, config = {} } = options
  assertRowId(id)

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Invalid plugin row name: expected a non-empty string')
  }
  if (/[\r\n]/.test(name)) throw new Error('Invalid plugin row name: must not contain newlines')
  if (!isPlainObject(config)) throw new Error('Invalid plugin row config: expected a plain object')

  validateConfigValue(config, 'config')
  return { id, name, config }
}

function assertRowId(id) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('Invalid plugin row id: expected a non-empty string')
  }
  if (/\s/.test(id)) throw new Error('Invalid plugin row id: must not contain whitespace')
}

function validateConfigValue(value, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid plugin row config at ${path}: not a finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateConfigValue(item, `${path}[${index}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) validateConfigValue(item, `${path}.${key}`)
    return
  }
  throw new Error(`Invalid plugin row config at ${path}: unsupported ${typeof value} value`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function malformed(detail) {
  return new Error(`Malformed dsh-computer marker block: ${detail}`)
}

function legacyMalformed(detail) {
  return new Error(`Malformed dsh-computer-use marker block: ${detail}`)
}
