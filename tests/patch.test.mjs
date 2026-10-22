import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BEGIN_MARKER,
  END_MARKER,
  ensureLegacyMigration,
  ensurePluginRow,
  removePluginRow,
} from '../lib/install/patch.js'

const ROW = {
  id: 'dsh-computer',
  name: 'dsh-computer',
  config: {
    cursor: { enabled: true, theme: 'cua.default' },
    approvals: { mode: 'ask' },
    policy: { allowedApps: [], blockedApps: [], maxActionsPerMinute: 60 },
  },
}

const EXPECTED_BLOCK = [
  BEGIN_MARKER,
  '- insert:',
  '    - id: dsh-computer',
  '      name: dsh-computer',
  '      config:',
  '        cursor:',
  '          enabled: true',
  '          theme: cua.default',
  '        approvals:',
  '          mode: ask',
  '        policy:',
  '          allowedApps: []',
  '          blockedApps: []',
  '          maxActionsPerMinute: 60',
  END_MARKER,
].join('\n')

const LEGACY_BLOCK = [
  '# >>> dsh-computer-use (managed)',
  '- insert:',
  '    - id: preset-computer-use',
  '      name: dsh-computer-use',
  '    - id: dsh-computer-use',
  '      name: other-name',
  '# <<< dsh-computer-use',
].join('\n')

test('ensurePluginRow inserts a managed root plugin row into empty patch text', () => {
  const text = ensurePluginRow('', ROW)

  assert.equal(text, `${EXPECTED_BLOCK}\n`)
  assert.ok(text.includes('- insert:'))
  assert.ok(text.includes('    - id: dsh-computer'))
  assert.ok(text.includes('      name: dsh-computer'))
})

test('ensurePluginRow is idempotent', () => {
  const once = ensurePluginRow('', ROW)
  const twice = ensurePluginRow(once, ROW)

  assert.equal(twice, once)
  assert.equal((twice.match(/^# >>> dsh-computer/mg) ?? []).length, 1)
})

test('ensurePluginRow preserves user content and normalizes CRLF to LF', () => {
  const text = ensurePluginRow('plugins:\r\n  existing: true\r\n', ROW)

  assert.equal(text, `plugins:\n  existing: true\n\n${EXPECTED_BLOCK}\n`)
  assert.ok(!text.includes('\r'))
})

test('ensurePluginRow replaces an existing managed block when config changes', () => {
  const first = ensurePluginRow('keep: 1\n', ROW)
  const second = ensurePluginRow(first, { ...ROW, config: { approvals: { mode: 'strict' } } })

  assert.equal((second.match(/^# >>> dsh-computer/mg) ?? []).length, 1)
  assert.match(second, /mode: strict/)
  assert.ok(!second.includes('mode: ask'))
  assert.match(second, /^keep: 1$/m)
})

test('removePluginRow removes only the managed block', () => {
  const user = 'plugins:\n  existing: true\n'
  const installed = ensurePluginRow(user, ROW)

  assert.equal(removePluginRow(installed, 'dsh-computer'), user)
})

test('removePluginRow preserves user content around the block and leaves no stray blank lines', () => {
  const withUserAfter = `${ensurePluginRow('top: 1\n', ROW)}\nbottom: 2\n`
  const removed = removePluginRow(withUserAfter, 'dsh-computer')

  assert.equal(removed, 'top: 1\n\nbottom: 2\n')
  assert.ok(!removed.includes(BEGIN_MARKER))
  assert.ok(!removed.includes(END_MARKER))
})

test('removePluginRow returns text unchanged when no managed block exists', () => {
  assert.equal(removePluginRow('user: true\n', 'dsh-computer'), 'user: true\n')
})

test('removePluginRow leaves the managed block when asked for another id', () => {
  const installed = ensurePluginRow('', ROW)

  assert.equal(removePluginRow(installed, 'other'), installed)
})

test('ensureLegacyMigration removes the legacy dsh-computer-use block', () => {
  const result = ensureLegacyMigration(`user: true\n\n${LEGACY_BLOCK}\n`)

  assert.equal(result.removedPreset, true)
  assert.deepEqual(result.removedRows, ['preset-computer-use', 'dsh-computer-use'])
  assert.equal(result.text, 'user: true\n')
  assert.ok(!result.text.includes('dsh-computer-use'))
})

test('ensureLegacyMigration is a no-op without a legacy block', () => {
  const text = 'user: true\n'

  assert.deepEqual(ensureLegacyMigration(text), { text, removedPreset: false, removedRows: [] })
})

test('ensureLegacyMigration removes an old root dsh-computer-use row and keeps the rest', () => {
  const text = [
    'plugins:',
    '  existing: true',
    '',
    '- insert:',
    '    - id: dsh-computer-use',
    '      name: dsh-computer-use',
    '      config:',
    '        id: preset-computer-use',
    '    - id: user-row',
    '      name: user-plugin',
    '      config:',
    '        id: dsh-computer-use',
    '',
    '- insert:',
    '    - id: untouched',
    '      name: dsh-computer-use-helper',
    '',
  ].join('\n')

  const result = ensureLegacyMigration(text)

  assert.equal(result.removedPreset, false)
  assert.deepEqual(result.removedRows, ['dsh-computer-use'])
  assert.equal(
    result.text,
    [
      'plugins:',
      '  existing: true',
      '',
      '- insert:',
      '    - id: user-row',
      '      name: user-plugin',
      '      config:',
      '        id: dsh-computer-use',
      '',
      '- insert:',
      '    - id: untouched',
      '      name: dsh-computer-use-helper',
      '',
    ].join('\n'),
  )
})

test('ensureLegacyMigration removes a root row matched by name only', () => {
  const text = [
    '- insert:',
    '    - id: renamed-row',
    '      name: dsh-computer-use',
    '      config:',
    '        id: dsh-computer-use',
    '    - id: keep',
    '      config:',
    '        id: dsh-computer-use',
    '',
  ].join('\n')

  const result = ensureLegacyMigration(text)

  assert.deepEqual(result.removedRows, ['renamed-row'])
  assert.equal(
    result.text,
    ['- insert:', '    - id: keep', '      config:', '        id: dsh-computer-use', ''].join('\n'),
  )
})

test('ensureLegacyMigration root row removal is idempotent', () => {
  const once = ensureLegacyMigration(
    ['- insert:', '    - id: dsh-computer-use', '      name: dsh-computer-use', ''].join('\n'),
  )
  const twice = ensureLegacyMigration(once.text)

  assert.deepEqual(twice, { text: once.text, removedPreset: false, removedRows: [] })
})

test('ensurePluginRow throws a readable error on a truncated managed block', () => {
  const broken = `${BEGIN_MARKER}\n- insert:\n    - id: dsh-computer\n`

  assert.throws(
    () => ensurePluginRow(broken, ROW),
    /Malformed dsh-computer marker block.*missing.*# <<< dsh-computer/,
  )
})

test('ensurePluginRow throws a readable error when the managed block lost its insert row', () => {
  const broken = `${BEGIN_MARKER}\nwhatever: true\n${END_MARKER}\n`

  assert.throws(
    () => ensurePluginRow(broken, ROW),
    /Malformed dsh-computer marker block.*- insert:/,
  )
})

test('ensurePluginRow throws a readable error on broken block indentation', () => {
  const broken = `${BEGIN_MARKER}\n- insert:\nname: dsh-computer\n${END_MARKER}\n`

  assert.throws(
    () => ensurePluginRow(broken, ROW),
    /Malformed dsh-computer marker block.*indentation/,
  )
})

test('removePluginRow throws on an orphan end marker', () => {
  assert.throws(
    () => removePluginRow(`${END_MARKER}\n`, 'dsh-computer'),
    /Malformed dsh-computer marker block/,
  )
})

test('ensureLegacyMigration throws a readable error on a truncated legacy block', () => {
  assert.throws(
    () => ensureLegacyMigration('# >>> dsh-computer-use\n- insert:\n'),
    /Malformed dsh-computer-use marker block.*missing.*# <<< dsh-computer-use/,
  )
})

test('ensurePluginRow rejects incomplete plugin row options', () => {
  assert.throws(() => ensurePluginRow('', { id: 'dsh-computer' }), /name/)
  assert.throws(
    () => ensurePluginRow('', { id: 'dsh-computer', name: 'dsh-computer', config: [] }),
    /config/,
  )
})
