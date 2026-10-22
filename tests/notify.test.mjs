import test from 'node:test'
import assert from 'node:assert/strict'
import { exec, execFile } from 'node:child_process'
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
  main as unregisterMain,
  renderDeleteCommand,
  unregisterTask,
} from '../scripts/unregister-task.mjs'

const run = promisify(execFile)
const runCommand = promisify(exec)
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

/** Decode the UTF-16LE `-EncodedCommand` payload of a registration command. */
function decodeWrapper(command) {
  const match = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)
  assert.ok(match, `expected an -EncodedCommand wrapper, got: ${command}`)
  return Buffer.from(match[1], 'base64').toString('utf16le')
}

/** Read a single-quoted PowerShell literal assigned to `$name`. */
function psLiteral(script, name) {
  const match = new RegExp(`(?:^|; )\\$${name} = '((?:[^']|'')*)'(?=;|$)`).exec(script)
  assert.ok(match, `expected $${name} to be assigned a literal`)
  return match[1].replace(/''/g, "'")
}

test('renderTaskCommand registers a logon task that repeats every 6 hours', () => {
  const task = renderTaskCommand({ home: HOME, scriptPath: SCRIPT })

  const scriptPath = resolve(SCRIPT)
  const homePath = resolve(HOME)

  assert.equal(task.name, TASK_NAME)
  assert.equal(task.name, 'dsh-computer-updater')
  assert.equal(
    task.command,
    `"${resolve(process.execPath)}" "${scriptPath}" --home "${homePath}"`,
  )

  // One wrapper registers both triggers: schtasks /RI is not valid with ONLOGON,
  // and a second /Create would replace the first trigger.
  assert.equal(task.schedule.length, 1)
  const wrapper = decodeWrapper(task.schedule[0])
  assert.match(wrapper, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.match(wrapper, /New-TimeSpan -Hours 6/)
  assert.doesNotMatch(wrapper, /\/RI\b/)

  // Regression: `-Command` strips literal double quotes, so the wrapper must
  // build them at runtime and contain none of its own.
  assert.ok(wrapper.includes('$q = [char]34'))
  assert.ok(
    wrapper.includes("$argument = $q + $script + $q + ' --home ' + $q + $homePath + $q"),
    'action argument is assembled with the runtime quote character',
  )
  assert.ok(!wrapper.includes('"'), 'wrapper carries no literal double quotes')

  // Single source of truth: the wrapper's literals reconstruct exactly the
  // action command that renderTaskCommand exposes and tests assert on.
  assert.equal(
    `"${psLiteral(wrapper, 'node')}" "${psLiteral(wrapper, 'script')}" --home "${psLiteral(wrapper, 'homePath')}"`,
    task.command,
  )
})

test('renderTaskCommand keeps spaced paths quoted in the encoded action', () => {
  const spacedHome = join(tmpdir(), 'dsh task home')
  const spacedScript = join(tmpdir(), 'dsh task script', 'update.mjs')
  const task = renderTaskCommand({ home: spacedHome, scriptPath: spacedScript })
  const wrapper = decodeWrapper(task.schedule[0])

  assert.equal(
    `"${psLiteral(wrapper, 'script')}" --home "${psLiteral(wrapper, 'homePath')}"`,
    `"${resolve(spacedScript)}" --home "${resolve(spacedHome)}"`,
  )
  assert.ok(task.command.includes(`"${resolve(spacedScript)}"`))
  assert.ok(task.command.includes(`"${resolve(spacedHome)}"`))
})

test('renderTaskCommand honors a custom interval and resolves relative paths', () => {
  const task = renderTaskCommand({
    home: 'relative-home',
    scriptPath: 'scripts/update.mjs',
    intervalHours: 12,
  })

  assert.match(decodeWrapper(task.schedule[0]), /New-TimeSpan -Hours 12/)
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

test('registerTask dry-run prints the encoded command without invoking the scheduler', async () => {
  const logs = []
  const result = await registerTask({
    home: HOME,
    scriptPath: SCRIPT,
    dryRun: true,
    exec: noExec(),
    log: (line) => logs.push(line),
  })

  assert.equal(result.dryRun, true)
  const wrapper = decodeWrapper(logs.join('\n'))
  assert.match(wrapper, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.ok(wrapper.includes(resolve(SCRIPT)))
  assert.ok(wrapper.includes(resolve(HOME)))
})

test('registerTask rejects when the scheduler fails', async () => {
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

  const wrapper = decodeWrapper(stdout.trim())
  assert.match(wrapper, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.ok(wrapper.includes(resolve(SCRIPT)))
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

test('encoded wrapper composes a quoted action argument in real PowerShell', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell only')
    return
  }

  const spacedHome = join(tmpdir(), 'dsh task home')
  const spacedScript = join(tmpdir(), 'dsh task script', 'update.mjs')
  const task = renderTaskCommand({ home: spacedHome, scriptPath: spacedScript })
  const wrapper = decodeWrapper(task.schedule[0])

  // Run everything except the registration call, then print the action that
  // would have been registered. This exercises the same encoded payload without
  // touching the real task scheduler.
  const probe = wrapper.replace(
    /Register-ScheduledTask[^;]*/,
    "Write-Output ($action.Execute + '|' + $action.Arguments)",
  )
  assert.notEqual(probe, wrapper, 'probe replaced the registration call')
  const encoded = Buffer.from(probe, 'utf16le').toString('base64')

  let stdout
  try {
    const result = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 30_000, windowsHide: true },
    )
    stdout = result.stdout
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('powershell.exe unavailable')
      return
    }
    throw error
  }

  assert.equal(
    stdout.trim(),
    `${resolve(process.execPath)}|"${resolve(spacedScript)}" --home "${resolve(spacedHome)}"`,
    'spaced paths keep their quotes in the registered action argument',
  )
})

test('renderDeleteCommand removes the task through PowerShell without localised text', () => {
  const command = renderDeleteCommand()

  assert.match(command, /^powershell\.exe .* -Command "/)
  assert.ok(
    command.includes(
      "Get-ScheduledTask -TaskName 'dsh-computer-updater' -ErrorAction SilentlyContinue",
    ),
  )
  assert.ok(
    command.includes(
      "Unregister-ScheduledTask -TaskName 'dsh-computer-updater' -Confirm:$false -ErrorAction Stop",
    ),
  )
  assert.ok(!/schtasks/i.test(command), 'does not depend on schtasks')
  assert.ok(!/(cannot find|does not exist|找不到|不存在)/i.test(command))
  assert.ok(command.includes("'absent'; exit 0"), 'absence is signalled by the script itself')
})

test('unregisterTask dry-run prints the delete command without invoking the scheduler', async () => {
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
      return { stdout: 'removed\r\n', stderr: '' }
    },
    log: (line) => logs.push(line),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], renderDeleteCommand())
  assert.ok(calls[0][1].timeout > 0)
  assert.deepEqual(result, { removed: true, alreadyAbsent: false, dryRun: false })
  assert.match(logs.join('\n'), /unregistered: dsh-computer-updater/)
})

test('unregisterTask reports an absent task from the script marker, not localised text', async () => {
  const logs = []
  const result = await unregisterTask({
    exec: async () => ({ stdout: 'absent\r\n', stderr: '' }),
    log: (line) => logs.push(line),
  })

  assert.deepEqual(result, { removed: false, alreadyAbsent: true, dryRun: false })
  assert.match(logs.join('\n'), /already absent/i)
})

test('unregisterTask rethrows real failures even when the message looks localised', async () => {
  // The old implementation matched English/Chinese "not found" text; absence is
  // now decided by the script's own marker and exit code.
  const error = Object.assign(new Error('找不到指定的文件'), { stderr: '找不到指定的文件' })
  await assert.rejects(
    unregisterTask({ exec: async () => Promise.reject(error), log: () => {} }),
    /找不到指定的文件/,
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
  assert.match(output, /powershell\.exe/)
})

test('unregister CLI exits 0 when the task is already absent', async () => {
  const logs = []
  const code = await unregisterMain({
    exec: async () => ({ stdout: 'absent', stderr: '' }),
    log: (line) => logs.push(line),
    error: () => {},
  })

  assert.equal(code, 0)
  assert.match(logs.join('\n'), /already absent: dsh-computer-updater/)
})

test('unregister CLI --dry-run prints only the delete command', async () => {
  const { stdout } = await run(process.execPath, [UNREGISTER, '--dry-run'], { cwd: REPO_ROOT })

  assert.equal(stdout.trim(), renderDeleteCommand())
})

test('delete command reports an absent task without localised text', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell only')
    return
  }

  // A synthetic task name proves the script parses and reports absence without
  // ever touching the real updater task.
  const command = renderDeleteCommand().replaceAll(
    `'${TASK_NAME}'`,
    "'dsh-computer-updater-probe-absent'",
  )
  assert.notEqual(command, renderDeleteCommand(), 'probe retargets the task name')

  let stdout
  try {
    const result = await runCommand(command, { timeout: 30_000, windowsHide: true })
    stdout = result.stdout
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('powershell.exe unavailable')
      return
    }
    throw error
  }

  assert.equal(stdout.trim(), 'absent')
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

test('notify flattens a lone carriage return too', async () => {
  let script = ''
  await notify({
    title: 't',
    message: 'line one\rline two',
    platform: 'win32',
    exec: async (...args) => {
      script = args[1][args[1].indexOf('-Command') + 1]
    },
  })

  assert.ok(script.includes("'line one line two'"))
  assert.ok(!script.includes('\r'))
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
