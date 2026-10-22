import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { notify } from '../lib/update/notify.js'
import {
  TASK_NAME,
  main as registerMain,
  registerTask,
  renderTaskCommand,
} from '../scripts/register-task.mjs'
import {
  isTaskMissing,
  main as unregisterMain,
  renderDeleteCommand,
  unregisterTask,
} from '../scripts/unregister-task.mjs'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const REGISTER = join(REPO_ROOT, 'scripts', 'register-task.mjs')
const UNREGISTER = join(REPO_ROOT, 'scripts', 'unregister-task.mjs')

const HOME = join(tmpdir(), 'dsh-task-home')
const SCRIPT = join(tmpdir(), 'dsh-task-script', 'update.mjs')

function noExec() {
  return async (...args) => {
    throw new Error(`unexpected exec: ${args.join(' ')}`)
  }
}

test('renderTaskCommand registers a logon task that repeats every 6 hours', () => {
  const task = renderTaskCommand({ home: HOME, scriptPath: SCRIPT })

  const scriptPath = resolve(SCRIPT)
  const homePath = resolve(HOME)

  assert.equal(task.name, TASK_NAME)
  assert.equal(task.name, 'dsh-computer-updater')
  assert.ok(task.command.includes(scriptPath), 'command carries the absolute script path')
  assert.ok(task.command.includes(homePath), 'command carries the absolute home path')
  assert.ok(task.command.includes(`"${scriptPath}"`), 'command quotes spaced paths for CreateProcess')
  assert.ok(task.command.includes(`"${homePath}"`))

  // One wrapper registers both triggers: schtasks /RI is not valid with ONLOGON,
  // and a second /Create would replace the first trigger.
  assert.equal(task.schedule.length, 1)
  const schedule = task.schedule[0]
  assert.match(schedule, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.match(schedule, /New-TimeSpan -Hours 6/)
  assert.ok(schedule.includes(scriptPath))
  assert.ok(schedule.includes(homePath))
  assert.ok(
    schedule.includes(`-Argument '"${scriptPath}" --home "${homePath}"'`),
    'action arguments double-quote spaced paths',
  )
  assert.doesNotMatch(schedule, /\/RI\b/)
})

test('renderTaskCommand honors a custom interval and resolves relative paths', () => {
  const task = renderTaskCommand({
    home: 'relative-home',
    scriptPath: 'scripts/update.mjs',
    intervalHours: 12,
  })

  assert.match(task.schedule[0], /New-TimeSpan -Hours 12/)
  assert.ok(task.command.includes(resolve('relative-home')))
  assert.ok(task.command.includes(resolve('scripts/update.mjs')))
})

test('renderTaskCommand rejects an unusable interval', () => {
  assert.throws(
    () => renderTaskCommand({ home: HOME, scriptPath: SCRIPT, intervalHours: 0 }),
    /intervalHours/,
  )
  assert.throws(
    () => renderTaskCommand({ home: HOME, scriptPath: SCRIPT, intervalHours: Number.NaN }),
    /intervalHours/,
  )
})

test('registerTask runs the logon registration command with a bounded timeout', async () => {
  const calls = []
  const logs = []
  const result = await registerTask({
    home: HOME,
    scriptPath: SCRIPT,
    exec: async (...args) => {
      calls.push(args)
    },
    log: (line) => logs.push(line),
  })

  const task = renderTaskCommand({ home: HOME, scriptPath: SCRIPT })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], task.schedule[0])
  assert.ok(Number.isFinite(calls[0][1].timeout))
  assert.ok(calls[0][1].timeout > 0 && calls[0][1].timeout <= 30_000)
  assert.equal(result.name, TASK_NAME)
  assert.equal(result.dryRun, false)
  assert.match(logs.join('\n'), /registered: dsh-computer-updater/)
})

test('registerTask dry-run prints the command without invoking schtasks', async () => {
  const logs = []
  const result = await registerTask({
    home: HOME,
    scriptPath: SCRIPT,
    dryRun: true,
    exec: noExec(),
    log: (line) => logs.push(line),
  })

  assert.equal(result.dryRun, true)
  const output = logs.join('\n')
  assert.match(output, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.ok(output.includes(resolve(SCRIPT)))
  assert.ok(output.includes(resolve(HOME)))
})

test('registerTask rejects when schtasks fails', async () => {
  await assert.rejects(
    registerTask({
      home: HOME,
      scriptPath: SCRIPT,
      exec: async () => {
        throw new Error('Access is denied.')
      },
      log: () => {},
    }),
    /Access is denied\./,
  )
})

test('register CLI reports an actionable error and returns exit code 1', async () => {
  const errors = []
  const code = await registerMain({
    argv: ['--home', HOME, '--script', SCRIPT],
    exec: async () => {
      throw new Error('Access is denied.')
    },
    log: () => {},
    error: (line) => errors.push(line),
  })

  assert.equal(code, 1)
  const output = errors.join('\n')
  assert.match(output, /failed to register/)
  assert.match(output, /dsh-computer-updater/)
  assert.match(output, /Access is denied\./)
  assert.match(output, /powershell\.exe/)
})

test('register CLI --dry-run prints the command without touching the real scheduler', async () => {
  const { stdout } = await run(
    process.execPath,
    [REGISTER, '--home', HOME, '--script', SCRIPT, '--dry-run'],
    { cwd: REPO_ROOT },
  )

  assert.match(stdout, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.ok(stdout.includes(resolve(SCRIPT)))
})

test('register CLI exits 1 for invalid arguments', async () => {
  await assert.rejects(
    run(process.execPath, [REGISTER, '--not-an-option'], { cwd: REPO_ROOT }),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(String(error.stderr), /register-task:/)
      return true
    },
  )
})

test('renderDeleteCommand deletes the updater task', () => {
  assert.equal(
    renderDeleteCommand(),
    'schtasks.exe /Delete /TN "dsh-computer-updater" /F',
  )
})

test('unregisterTask dry-run prints the delete command without invoking schtasks', async () => {
  const logs = []
  const result = await unregisterTask({
    dryRun: true,
    exec: noExec(),
    log: (line) => logs.push(line),
  })

  assert.equal(result.dryRun, true)
  assert.equal(logs.join('\n'), renderDeleteCommand())
})

test('unregisterTask deletes the task', async () => {
  const calls = []
  const logs = []
  const result = await unregisterTask({
    exec: async (...args) => {
      calls.push(args)
    },
    log: (line) => logs.push(line),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], renderDeleteCommand())
  assert.ok(calls[0][1].timeout > 0)
  assert.deepEqual(result, { removed: true, alreadyAbsent: false, dryRun: false })
  assert.match(logs.join('\n'), /unregistered: dsh-computer-updater/)
})

test('unregisterTask treats an already-absent task as success', async () => {
  const logs = []
  const error = Object.assign(new Error('Command failed'), {
    stderr: 'ERROR: The system cannot find the file specified.',
  })

  const result = await unregisterTask({
    exec: async () => {
      throw error
    },
    log: (line) => logs.push(line),
  })

  assert.deepEqual(result, { removed: false, alreadyAbsent: true, dryRun: false })
  assert.match(logs.join('\n'), /already absent/i)
})

test('isTaskMissing does not treat a missing schtasks binary as an absent task', () => {
  const error = Object.assign(new Error('spawn schtasks.exe ENOENT'), { code: 'ENOENT' })
  assert.equal(isTaskMissing(error), false)
})

test('unregisterTask rethrows failures that are not an absent task', async () => {
  const error = Object.assign(new Error('Access is denied.'), { stderr: 'Access is denied.' })
  assert.equal(isTaskMissing(error), false)
  await assert.rejects(
    unregisterTask({ exec: async () => Promise.reject(error), log: () => {} }),
    /Access is denied\./,
  )
})

test('unregister CLI reports an actionable error and returns exit code 1', async () => {
  const errors = []
  const code = await unregisterMain({
    exec: async () => {
      throw new Error('Access is denied.')
    },
    log: () => {},
    error: (line) => errors.push(line),
  })

  assert.equal(code, 1)
  const output = errors.join('\n')
  assert.match(output, /failed to delete/)
  assert.match(output, /dsh-computer-updater/)
  assert.match(output, /Access is denied\./)
})

test('unregister CLI --dry-run prints only the delete command', async () => {
  const { stdout } = await run(process.execPath, [UNREGISTER, '--dry-run'], { cwd: REPO_ROOT })

  assert.equal(stdout.trim(), renderDeleteCommand())
})

test('notify returns false without invoking exec off Windows', async () => {
  let called = false
  const shown = await notify({
    title: 'Update failed',
    message: 'rollback complete',
    platform: 'linux',
    exec: async () => {
      called = true
    },
  })

  assert.equal(shown, false)
  assert.equal(called, false)
})

test('notify shows a Windows toast with escaped text and a bounded timeout', async () => {
  let call
  const shown = await notify({
    title: "It's done",
    message: "a 'quoted' update\nsecond line",
    level: 'error',
    platform: 'win32',
    exec: async (...args) => {
      call = args
    },
  })

  assert.equal(shown, true)
  assert.equal(call[0], 'powershell.exe')
  const args = call[1]
  const script = args[args.indexOf('-Command') + 1]
  assert.ok(script.includes("It''s done"), 'single quotes are doubled')
  assert.ok(script.includes("a ''quoted'' update second line"), 'newlines are flattened')
  assert.ok(script.includes("'error'"))
  assert.equal(call[2].windowsHide, true)
  assert.ok(call[2].timeout > 0 && call[2].timeout <= 10_000)
})

test('notify swallows PowerShell failures and logs through the optional logger', async () => {
  const logs = []
  const shown = await notify({
    title: 'Update failed',
    message: 'rollback complete',
    platform: 'win32',
    exec: async () => {
      throw new Error('powershell.exe not found')
    },
    logger: { warn: (line) => logs.push(line) },
  })

  assert.equal(shown, false)
  assert.match(logs.join('\n'), /powershell\.exe not found/)
})

test('notify never throws when no logger is supplied', async () => {
  const shown = await notify({
    title: 'Update failed',
    message: 'rollback complete',
    platform: 'win32',
    exec: async () => {
      throw new Error('boom')
    },
  })

  assert.equal(shown, false)
})

test('notify clamps an unknown level instead of interpolating it', async () => {
  let script = ''
  await notify({
    title: 't',
    message: 'm',
    level: "'; Start-Process calc; '",
    platform: 'win32',
    exec: async (...args) => {
      script = args[1][args[1].indexOf('-Command') + 1]
    },
  })

  assert.ok(!script.includes('Start-Process'))
  assert.ok(script.includes("'info'"))
})
