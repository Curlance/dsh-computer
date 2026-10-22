import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { applyMigration, planMigration, rollbackMigration } from '../lib/install/migrate.js'
import { ensurePluginRow } from '../lib/install/patch.js'

const LEGACY_VERSION = '0.4.1'
const LEGACY_NAME = `dsh-computer-use-${LEGACY_VERSION}`

const LEGACY_PATCH = [
  'plugins:',
  '  existing: true',
  '',
  '# >>> dsh-computer-use (HOME layer preset; managed by install.sh)',
  '- insert:',
  '    - id: preset-computer-use',
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  '        id: computer-use',
  '# <<< dsh-computer-use',
  '',
].join('\n')

const MIGRATED_PATCH = 'plugins:\n  existing: true\n'

const ROW = {
  id: 'dsh-computer',
  name: 'dsh-computer',
  config: { approvals: { mode: 'ask' } },
}

/**
 * Build a temp `--home` layout with the legacy install artifacts. Nothing here
 * touches the real `~/.dsh`; every path is rooted at a fresh mkdtemp directory.
 */
async function createHome(options = {}) {
  const {
    version = LEGACY_VERSION,
    patch = LEGACY_PATCH,
    link = true,
    unrelated = true,
    packageName = 'dsh-computer-use',
  } = options

  const root = await mkdtemp(join(tmpdir(), 'dsh-migrate-'))
  const dshHome = join(root, '.dsh')
  const pluginsDir = join(dshHome, 'plugins')
  const profileNodeModules = join(dshHome, 'profiles', 'desktop', 'node_modules')
  const patchPath = join(dshHome, 'cordis.patch.yml')
  await mkdir(profileNodeModules, { recursive: true })

  let legacyDir = null
  if (version !== null) {
    legacyDir = join(pluginsDir, `dsh-computer-use-${version}`)
    await mkdir(legacyDir, { recursive: true })
    await writeFile(
      join(legacyDir, 'package.json'),
      `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
    )
  }

  // A different plugin whose name also starts with the legacy prefix.
  if (unrelated) await mkdir(join(pluginsDir, 'dsh-computer-use-virtual-cursor'), { recursive: true })

  if (link && legacyDir) {
    await symlink(
      legacyDir,
      join(profileNodeModules, 'dsh-computer-use'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }

  if (patch !== null) await writeFile(patchPath, patch, 'utf8')

  let tick = 0
  const now = () => new Date(Date.parse('2026-10-21T12:00:00.000Z') + tick++ * 1000)

  return {
    root,
    dshHome,
    pluginsDir,
    profileNodeModules,
    patchPath,
    legacyDir,
    now,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function planOptions(home, overrides = {}) {
  return {
    patchText: LEGACY_PATCH,
    pluginsDir: home.pluginsDir,
    profileNodeModules: home.profileNodeModules,
    patchPath: home.patchPath,
    now: home.now,
    ...overrides,
  }
}

async function migrate(home) {
  const plan = await planMigration(planOptions(home))
  const nextPatchText = ensurePluginRow(plan.nextPatchText, ROW)
  const applied = await applyMigration({ ...plan, nextPatchText })
  return { plan, nextPatchText, applied }
}

test('planMigration plans preset removal, package move and patch backup', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  const plan = await planMigration(planOptions(home))

  assert.deepEqual(plan.actions.map((action) => action.kind), [
    'remove-preset',
    'move-package',
    'write-backup',
  ])
  assert.ok(plan.actions[0].detail.rows.includes('preset-computer-use'))

  const move = plan.actions[1]
  assert.equal(move.detail.name, LEGACY_NAME)
  assert.equal(move.detail.from, home.legacyDir)
  assert.equal(move.detail.to, join(home.pluginsDir, '_backup', LEGACY_NAME))
  assert.deepEqual(move.detail.link, {
    path: join(home.profileNodeModules, 'dsh-computer-use'),
    target: home.legacyDir,
  })

  assert.equal(plan.actions[2].detail.patchPath, plan.backupPath)
  assert.ok(plan.backupPath.startsWith(join(home.pluginsDir, '_backup')))
  assert.match(plan.backupPath, /patch-.*\.yml$/)
  assert.equal(plan.nextPatchText, MIGRATED_PATCH)
  assert.ok(!plan.nextPatchText.includes('preset-computer-use'))
  assert.ok(!plan.actions.some((action) => action.detail?.name?.includes('virtual-cursor')))

  // Planning observes, it never writes.
  assert.equal(await readFile(home.patchPath, 'utf8'), LEGACY_PATCH)
  assert.deepEqual((await readdir(home.pluginsDir)).sort(), [
    LEGACY_NAME,
    'dsh-computer-use-virtual-cursor',
  ])
  await assert.rejects(lstat(join(home.pluginsDir, '_backup')), { code: 'ENOENT' })
})

test('planMigration is empty and applyMigration is a no-op once migrated', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  await migrate(home)

  const second = await planMigration(
    planOptions(home, { patchText: await readFile(home.patchPath, 'utf8') }),
  )
  assert.deepEqual(second.actions, [])
  assert.equal(second.backupPath, null)

  assert.deepEqual(await applyMigration(second), {
    backupPath: null,
    moved: [],
    writtenPatch: false,
  })
})

test('applyMigration backs up the old patch, moves the old package and writes the new patch', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  const { plan, nextPatchText, applied } = await migrate(home)

  assert.deepEqual(applied.moved, [LEGACY_NAME])
  assert.equal(applied.backupPath, plan.backupPath)
  assert.equal(applied.writtenPatch, true)
  assert.equal(await readFile(home.patchPath, 'utf8'), nextPatchText)
  assert.equal(await readFile(plan.backupPath, 'utf8'), LEGACY_PATCH)

  const backupDir = join(home.pluginsDir, '_backup')
  assert.equal(
    await readFile(join(backupDir, LEGACY_NAME, 'package.json'), 'utf8'),
    `${JSON.stringify({ name: 'dsh-computer-use', version: LEGACY_VERSION }, null, 2)}\n`,
  )
  await assert.rejects(lstat(home.legacyDir), { code: 'ENOENT' })
  await assert.rejects(lstat(join(home.profileNodeModules, 'dsh-computer-use')), { code: 'ENOENT' })
  assert.ok((await lstat(join(home.pluginsDir, 'dsh-computer-use-virtual-cursor'))).isDirectory())

  const manifest = JSON.parse(await readFile(join(backupDir, 'migration.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.patchPath, home.patchPath)
  assert.equal(manifest.patchBackup, basename(plan.backupPath))
  assert.deepEqual(manifest.packages, [
    { name: LEGACY_NAME, from: home.legacyDir, to: join(backupDir, LEGACY_NAME) },
  ])
  assert.deepEqual(manifest.links, [
    { path: join(home.profileNodeModules, 'dsh-computer-use'), target: home.legacyDir },
  ])

  // Re-applying the same stale plan is idempotent: no duplicate backups, no error.
  const again = await applyMigration({ ...plan, nextPatchText })
  assert.deepEqual(again.moved, [])
  assert.equal(again.writtenPatch, false)
  const ymlBackups = (await readdir(backupDir)).filter((entry) => entry.endsWith('.yml'))
  assert.equal(ymlBackups.length, 1)
})

test('preset-only migration writes an empty-packages manifest and rolls back', async (t) => {
  const home = await createHome({ version: null })
  t.after(home.cleanup)

  const plan = await planMigration(planOptions(home))
  assert.deepEqual(plan.actions.map((action) => action.kind), ['remove-preset', 'write-backup'])

  const nextPatchText = ensurePluginRow(plan.nextPatchText, ROW)
  const applied = await applyMigration({ ...plan, nextPatchText })
  assert.equal(applied.writtenPatch, true)
  assert.equal(await readFile(home.patchPath, 'utf8'), nextPatchText)

  const manifestPath = join(home.pluginsDir, '_backup', 'migration.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(manifest.packages, [])
  assert.deepEqual(manifest.links, [])

  // Re-applying the same plan reads the empty-packages manifest again.
  const again = await applyMigration({ ...plan, nextPatchText })
  assert.deepEqual(again, { backupPath: plan.backupPath, moved: [], writtenPatch: false })

  const result = await rollbackMigration({ pluginsDir: home.pluginsDir })
  assert.deepEqual(result.restored, [])
  assert.equal(await readFile(home.patchPath, 'utf8'), LEGACY_PATCH)
  await assert.rejects(lstat(manifestPath), { code: 'ENOENT' })
})

test('rollbackMigration restores the legacy patch, package location and link', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  const { nextPatchText } = await migrate(home)

  const result = await rollbackMigration({ pluginsDir: home.pluginsDir })

  assert.equal(result.dryRun, false)
  assert.deepEqual(result.restored, [LEGACY_NAME])
  assert.equal(result.patchPath, home.patchPath)
  assert.equal(await readFile(home.patchPath, 'utf8'), LEGACY_PATCH)
  assert.equal(
    await readFile(join(home.legacyDir, 'package.json'), 'utf8'),
    `${JSON.stringify({ name: 'dsh-computer-use', version: LEGACY_VERSION }, null, 2)}\n`,
  )

  const linkPath = join(home.profileNodeModules, 'dsh-computer-use')
  assert.ok((await lstat(linkPath)).isSymbolicLink())
  assert.equal(resolve(dirname(linkPath), await readlink(linkPath)), home.legacyDir)

  await assert.rejects(lstat(join(home.pluginsDir, '_backup', 'migration.json')), { code: 'ENOENT' })
  await assert.rejects(rollbackMigration({ pluginsDir: home.pluginsDir }), /No migration backup found/)
  assert.notEqual(await readFile(home.patchPath, 'utf8'), nextPatchText)

  // The pre-rollback patch is kept as a safety copy before it is overwritten.
  const backupDir = join(home.pluginsDir, '_backup')
  const safetyCopies = (await readdir(backupDir)).filter((entry) =>
    /^patch-pre-rollback-.*\.yml$/.test(entry),
  )
  assert.equal(safetyCopies.length, 1)
  assert.equal(await readFile(join(backupDir, safetyCopies[0]), 'utf8'), nextPatchText)

  // The legacy state is detectable again after rollback.
  const replanned = await planMigration(
    planOptions(home, { patchText: await readFile(home.patchPath, 'utf8') }),
  )
  assert.deepEqual(replanned.actions.map((action) => action.kind), [
    'remove-preset',
    'move-package',
    'write-backup',
  ])
})

test('rollbackMigration dry-run reports the restore without writing', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  const { plan, nextPatchText } = await migrate(home)

  const result = await rollbackMigration({ pluginsDir: home.pluginsDir, dryRun: true })

  assert.equal(result.dryRun, true)
  assert.deepEqual(result.restored, [LEGACY_NAME])
  assert.equal(await readFile(home.patchPath, 'utf8'), nextPatchText)
  await assert.rejects(lstat(home.legacyDir), { code: 'ENOENT' })
  assert.ok((await lstat(join(home.pluginsDir, '_backup', LEGACY_NAME))).isDirectory())
  assert.ok((await lstat(plan.backupPath)).isFile())
})

test('rollbackMigration refuses to overwrite a package at the original location', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  const { nextPatchText } = await migrate(home)
  await mkdir(home.legacyDir, { recursive: true })

  await assert.rejects(rollbackMigration({ pluginsDir: home.pluginsDir }), /already exists/)
  // Pre-validation runs before any write.
  assert.equal(await readFile(home.patchPath, 'utf8'), nextPatchText)
  assert.ok((await lstat(join(home.pluginsDir, '_backup', LEGACY_NAME))).isDirectory())
})

test('planMigration rejects malformed inputs with readable errors', async (t) => {
  const home = await createHome({ version: null, patch: null })
  t.after(home.cleanup)

  await assert.rejects(planMigration(null), /Invalid migration options/)
  await assert.rejects(planMigration({ patchText: '' }), /pluginsDir/)
  await assert.rejects(
    planMigration({ patchText: '', pluginsDir: 'relative/plugins' }),
    /absolute path/,
  )
  await assert.rejects(
    planMigration({ patchText: 42, pluginsDir: home.pluginsDir }),
    /patchText/,
  )
  await assert.rejects(
    planMigration({ patchText: '# >>> dsh-computer-use\n- insert:\n', pluginsDir: home.pluginsDir }),
    /Malformed dsh-computer-use marker block/,
  )

  const wrongPackage = await createHome({ version: '9.9.9', packageName: 'evil-package' })
  t.after(wrongPackage.cleanup)
  await assert.rejects(
    planMigration({ patchText: '', pluginsDir: wrongPackage.pluginsDir }),
    /dsh-computer-use/,
  )

  const planWithoutPatchPath = await planMigration({
    patchText: LEGACY_PATCH,
    pluginsDir: home.pluginsDir,
  })
  await assert.rejects(applyMigration(planWithoutPatchPath), /patchPath/)
})

test('planMigration ignores a legacy link with no plugin directory to move', async (t) => {
  const home = await createHome({ version: null })
  t.after(home.cleanup)

  // npm-style old install: a real directory in the profile, no plugins/ package.
  await mkdir(join(home.profileNodeModules, 'dsh-computer-use'))

  const plan = await planMigration(planOptions(home))

  assert.deepEqual(plan.actions.map((action) => action.kind), ['remove-preset', 'write-backup'])
})

test('rollbackMigration rejects missing or malformed backup metadata', async (t) => {
  const home = await createHome({ version: null, patch: null })
  t.after(home.cleanup)

  await assert.rejects(rollbackMigration({ pluginsDir: home.pluginsDir }), /No migration backup found/)

  const backupDir = join(home.pluginsDir, '_backup')
  await mkdir(backupDir, { recursive: true })
  await writeFile(join(backupDir, 'migration.json'), '{not json', 'utf8')

  await assert.rejects(
    rollbackMigration({ pluginsDir: home.pluginsDir }),
    /Malformed migration backup/,
  )
})

test('planMigration keeps every resolved path inside the provided temp home', async (t) => {
  const home = await createHome()
  t.after(home.cleanup)

  const plan = await planMigration(planOptions(home))
  const move = plan.actions.find((action) => action.kind === 'move-package')
  const backup = plan.actions.find((action) => action.kind === 'write-backup')

  const paths = [
    plan.patchPath,
    plan.backupPath,
    move.detail.from,
    move.detail.to,
    move.detail.link.path,
    move.detail.link.target,
    backup.detail.patchPath,
    backup.detail.manifestPath,
  ]
  for (const path of paths) {
    assert.equal(typeof path, 'string')
    assert.ok(path.startsWith(home.root), `${path} is outside ${home.root}`)
  }
})
