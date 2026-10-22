#!/usr/bin/env node
/**
 * Remove the `dsh-computer-updater` scheduled task. Already-absent is success so
 * uninstall/rollback can call this repeatedly; tests inject `exec`.
 */

import { exec as nodeExec } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

export const TASK_NAME = 'dsh-computer-updater'

const defaultExec = promisify(nodeExec)
const RUN_TIMEOUT_MS = 15_000

const USAGE = `Usage: node scripts/unregister-task.mjs [options]

Options:
  --dry-run         Print the PowerShell delete command without deleting anything
  -h, --help        Show this help
`

/**
 * The command that deletes the updater task. Existence is checked with
 * `Get-ScheduledTask` and reported through the script's own `absent` marker, so
 * nothing depends on the English/Chinese wording of scheduler errors.
 */
export function renderDeleteCommand() {
  const script = [
    `$existing = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`,
    "if ($null -eq $existing) { 'absent'; exit 0 }",
    `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop`,
    "'removed'",
  ].join('; ')
  return `powershell.exe -NoProfile -NonInteractive -Command "${script}"`
}

/**
 * Delete the updater task. Absent tasks resolve as success; other failures
 * reject so the CLI can print an actionable error and exit 1.
 *
 * @param {{
 *   dryRun?: boolean,
 *   exec?: (command: string, options: object) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{removed: boolean, alreadyAbsent: boolean, dryRun: boolean}>}
 */
export async function unregisterTask({
  dryRun = false,
  exec = defaultExec,
  log = console.log,
} = {}) {
  const command = renderDeleteCommand()
  if (dryRun) {
    log(command)
    return { removed: false, alreadyAbsent: false, dryRun: true }
  }

  const result = await exec(command, { timeout: RUN_TIMEOUT_MS, windowsHide: true })
  if (String(result?.stdout ?? '').trim() === 'absent') {
    log(`already absent: ${TASK_NAME}`)
    return { removed: false, alreadyAbsent: true, dryRun: false }
  }
  log(`unregistered: ${TASK_NAME}`)
  return { removed: true, alreadyAbsent: false, dryRun: false }
}

/**
 * CLI entry point. Returns the process exit code so tests can exercise failure
 * paths without spawning the real scheduler.
 */
export async function main({
  argv = process.argv.slice(2),
  exec = defaultExec,
  log = console.log,
  error = console.error,
} = {}) {
  let values
  try {
    values = parseUnregisterArgs(argv)
  } catch (parseError) {
    error(`unregister-task: ${parseError.message}`)
    return 1
  }

  if (values.help) {
    log(USAGE)
    return 0
  }

  try {
    await unregisterTask({ dryRun: values['dry-run'] === true, exec, log })
    return 0
  } catch (unregisterError) {
    error(
      `unregister-task: failed to delete "${TASK_NAME}": ${unregisterError.message}`,
    )
    error(
      'Check that powershell.exe (Windows PowerShell 5.1) is available and that this account may delete scheduled tasks, then retry.',
    )
    return 1
  }
}

function parseUnregisterArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  return values
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
