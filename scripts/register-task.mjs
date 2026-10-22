#!/usr/bin/env node
/**
 * Register the cross-version updater as a Windows scheduled task.
 *
 * The task `dsh-computer-updater` fires at logon and repeats every 6 hours while
 * the user is signed in. `--dry-run` prints the registration command and never
 * touches the real scheduler; tests inject `exec`.
 */

import { exec as nodeExec } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

export const TASK_NAME = 'dsh-computer-updater'

const defaultExec = promisify(nodeExec)
const DEFAULT_SCRIPT = fileURLToPath(new URL('./update.mjs', import.meta.url))
const RUN_TIMEOUT_MS = 15_000

const USAGE = `Usage: node scripts/register-task.mjs [options]

Options:
  --home <path>     User home directory passed to the updater (default: ~)
  --script <path>   Updater script to run (default: scripts/update.mjs)
  --dry-run         Print the registration command without registering anything
  -h, --help        Show this help
`

/**
 * Build the scheduled-task action and its registration command.
 *
 * `schtasks` cannot attach two triggers to one task (`/RI` is not valid with
 * `ONLOGON`, and a second `/Create` replaces the first), so the registration
 * wrapper creates the logon trigger and the 6-hour repetition trigger together.
 *
 * @param {{home: string, scriptPath: string, intervalHours?: number}} options
 * @returns {{name: string, command: string, schedule: string[]}}
 */
export function renderTaskCommand({ home, scriptPath, intervalHours = 6 } = {}) {
  if (typeof home !== 'string' || home.length === 0) {
    throw new TypeError('home must be a non-empty path')
  }
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
    throw new TypeError('scriptPath must be a non-empty path')
  }
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new TypeError('intervalHours must be a positive number')
  }

  const nodePath = resolve(process.execPath)
  const scriptPathAbs = resolve(scriptPath)
  const homePathAbs = resolve(home)
  const command = `"${nodePath}" "${scriptPathAbs}" --home "${homePathAbs}"`
  // The action argument is parsed by CreateProcess, so paths need double quotes.
  const argument = psQuote(`"${scriptPathAbs}" --home "${homePathAbs}"`)
  const schedule = [
    `powershell.exe -NoProfile -NonInteractive -Command "$action = New-ScheduledTaskAction -Execute ${psQuote(nodePath)} -Argument ${argument}; $logon = New-ScheduledTaskTrigger -AtLogOn; $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours ${intervalHours}); Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Trigger @($logon, $repeat) -Force | Out-Null"`,
  ]

  return { name: TASK_NAME, command, schedule }
}

/**
 * Register the updater task. The logon+repetition command is the one that runs;
 * failures reject so the CLI can print an actionable error and exit 1.
 *
 * @param {{
 *   home: string,
 *   scriptPath: string,
 *   intervalHours?: number,
 *   dryRun?: boolean,
 *   exec?: (command: string, options: object) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} options
 */
export async function registerTask({
  home,
  scriptPath,
  intervalHours = 6,
  dryRun = false,
  exec = defaultExec,
  log = console.log,
} = {}) {
  const task = renderTaskCommand({ home, scriptPath, intervalHours })
  if (dryRun) {
    log(task.schedule[0])
    return { ...task, dryRun: true }
  }

  await exec(task.schedule[0], { timeout: RUN_TIMEOUT_MS, windowsHide: true })
  log(`registered: ${task.name}`)
  return { ...task, dryRun: false }
}

/**
 * CLI entry point. Returns the process exit code so tests can exercise failure
 * paths without spawning the real scheduler.
 *
 * @param {{
 *   argv?: string[],
 *   exec?: (command: string, options: object) => Promise<unknown>,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} [options]
 */
export async function main({
  argv = process.argv.slice(2),
  exec = defaultExec,
  log = console.log,
  error = console.error,
} = {}) {
  let values
  try {
    values = parseRegisterArgs(argv)
  } catch (parseError) {
    error(`register-task: ${parseError.message}`)
    return 1
  }

  if (values.help) {
    log(USAGE)
    return 0
  }

  try {
    await registerTask({
      home: values.home ?? homedir(),
      scriptPath: values.script ?? DEFAULT_SCRIPT,
      dryRun: values['dry-run'] === true,
      exec,
      log,
    })
    return 0
  } catch (registerError) {
    error(
      `register-task: failed to register "${TASK_NAME}": ${registerError.message}`,
    )
    error(
      'Check that powershell.exe (Windows PowerShell 5.1) is available and that this account may create scheduled tasks, then retry.',
    )
    return 1
  }
}

function parseRegisterArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      home: { type: 'string' },
      script: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  return values
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function isMain(metaUrl) {
  if (process.argv[1] === undefined) return false
  const self = fileURLToPath(metaUrl)
  const entry = resolve(process.argv[1])
  return process.platform === 'win32'
    ? self.toLowerCase() === entry.toLowerCase()
    : self === entry
}

if (isMain(import.meta.url)) {
  const code = await main()
  if (code !== 0) process.exitCode = code
}
