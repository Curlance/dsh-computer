import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Approval modes accepted by `approvals.mode`. */
export const APPROVAL_MODES = ['ask', 'strict', 'relaxed']

/** Default plugin config. `normalizeConfig()` returns a deep copy of this shape. */
export const DEFAULT_CONFIG = {
  cursor: { enabled: true, theme: 'cua.default', idleHideMs: 0, glideMs: 600 },
  approvals: { mode: 'ask' },
  policy: { allowedApps: [], blockedApps: [], maxActionsPerMinute: 60 },
  audit: {
    path: resolve(homedir(), '.dsh', 'computer', 'audit.jsonl'),
    includeScreenshots: false,
  },
  backend: { timeoutMs: 15000 },
  observation: { maxElements: 250, maxImageDimension: 1456, ttlMs: 60000 },
}

/**
 * @typedef {object} ConfigValues
 * @property {{enabled: boolean, theme: string, idleHideMs: number, glideMs: number}} cursor
 * @property {{mode: 'ask' | 'strict' | 'relaxed'}} approvals
 * @property {{allowedApps: string[], blockedApps: string[], maxActionsPerMinute: number}} policy
 * @property {{path: string, includeScreenshots: boolean}} audit
 * @property {{timeoutMs: number}} backend
 * @property {{maxElements: number, maxImageDimension: number, ttlMs: number}} observation
 */

const SECTIONS = ['cursor', 'approvals', 'policy', 'audit', 'backend', 'observation']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isBoolean = (value) => typeof value === 'boolean'
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0
const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0

const RULES = {
  'cursor.enabled': { valid: isBoolean, expected: 'a boolean' },
  'cursor.theme': { valid: isNonEmptyString, expected: 'a non-empty string' },
  'cursor.idleHideMs': { valid: isNonNegativeInteger, expected: 'a non-negative integer' },
  'cursor.glideMs': { valid: isNonNegativeInteger, expected: 'a non-negative integer' },
  'approvals.mode': {
    valid: (value) => APPROVAL_MODES.includes(value),
    expected: `one of ${APPROVAL_MODES.join(', ')}`,
  },
  'policy.allowedApps': { valid: isStringArray, expected: 'an array of strings' },
  'policy.blockedApps': { valid: isStringArray, expected: 'an array of strings' },
  'policy.maxActionsPerMinute': { valid: isPositiveInteger, expected: 'a positive integer' },
  'audit.path': { valid: isNonEmptyString, expected: 'a non-empty string' },
  'audit.includeScreenshots': { valid: isBoolean, expected: 'a boolean' },
  'backend.timeoutMs': { valid: isPositiveInteger, expected: 'a positive integer' },
  'observation.maxElements': { valid: isPositiveInteger, expected: 'a positive integer' },
  'observation.maxImageDimension': { valid: isPositiveInteger, expected: 'a positive integer' },
  'observation.ttlMs': { valid: isPositiveInteger, expected: 'a positive integer' },
}

/**
 * Validate a partial config without throwing.
 * @param {object} [partial]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateConfig(partial = {}) {
  if (!isObject(partial)) {
    return { ok: false, errors: ['Invalid config: expected an object'] }
  }

  const errors = []
  for (const section of SECTIONS) {
    const value = partial[section]
    if (value !== undefined && !isObject(value)) {
      errors.push(`Invalid ${section}: expected an object`)
    }
  }

  for (const [path, rule] of Object.entries(RULES)) {
    const value = getPath(partial, path)
    if (value !== undefined && !rule.valid(value)) {
      errors.push(`Invalid ${path}: expected ${rule.expected}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Merge a partial config over the defaults, rejecting invalid values.
 * @param {object} [partial]
 * @returns {ConfigValues}
 */
export function normalizeConfig(partial = {}) {
  const { ok, errors } = validateConfig(partial)
  if (!ok) throw new Error(errors[0])

  const config = merge(DEFAULT_CONFIG, partial)
  config.audit.path = expandHome(config.audit.path)
  return config
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => (isObject(value) ? value[key] : undefined), object)
}

function merge(base, patch) {
  const merged = {}
  for (const [key, baseValue] of Object.entries(base)) {
    const patchValue = patch[key]
    if (isObject(baseValue)) {
      merged[key] = merge(baseValue, isObject(patchValue) ? patchValue : {})
    } else if (Array.isArray(patchValue)) {
      merged[key] = [...patchValue]
    } else if (patchValue === undefined) {
      merged[key] = Array.isArray(baseValue) ? [...baseValue] : baseValue
    } else {
      merged[key] = patchValue
    }
  }
  return merged
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolve(homedir(), value.slice(2))
  }
  return value
}
