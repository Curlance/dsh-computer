#!/usr/bin/env node
/**
 * Register the cross-version updater as a Windows scheduled task.
 *
 * The task `dsh-computer-updater` fires at logon and repeats every 6 hours while
 * the user is signed in. The action runs `update.mjs --apply --home <home>
 * --manifest <manifestUrl>` (plus `--profile <name>` when given), because a bare
 * updater invocation exits for a missing mode. `--dry-run` prints the
 * registration command and never touches the real scheduler; tests inject
 * `exec`.
 */

import { exec as nodeExec } from 'node:child_process'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

export const TASK_NAME = 'dsh-computer-updater'
export const DEFAULT_MANIFEST_URL =
  'https://github.com/Curlance/dsh-computer-use/releases/latest/download/compat.json'

const defaultExec = promisify(nodeExec)
const DEFAULT_SCRIPT = fileURLToPath(new URL('./update.mjs', import.meta.url))
const RUN_TIMEOUT_MS = 15_000
const PROFILE_RE = /^[A-Za-z0-9._-]+$/

const USAGE = `Usage: node scripts/register-task.mjs [options]

Options:
  --home <path>          User home directory passed to the updater (default: ~)
  --script <path>        Updater script to run (default: scripts/update.mjs)
  --manifest-url <url>   Release manifest passed to \`--apply\`
                         (default: ${DEFAULT_MANIFEST_URL})
  --profile <name>       DSH profile passed to \`--apply\` (default: updater's)
  --dry-run              Print the registration command without registering anything
  -h, --help             Show this help
`

/**
 * Build the scheduled-task action and its registration command.
 *
 * `schtasks` cannot attach two triggers to one task (`/RI` is not valid with
 * `ONLOGON`, and a second `/Create` replaces the first), so the registration
 * wrapper creates the logon trigger and the 6-hour repetition trigger together.
 *
 * The wrapper is passed with `-EncodedCommand`: PowerShell strips literal double
 * quotes out of a `-Command` string, which used to drop the quoting from spaced
 * script/home paths. The wrapper builds its action argument from `$q`, and
 * `command` is derived from the same resolved paths, so the tested action string
 * and the registered action cannot drift apart.
 *
 * @param {{home: string, scriptPath: string, intervalHours?: number,
 *          manifestUrl?: string, profile?: string}} options
 * @returns {{name: string, command: string, schedule: string[]}}
 */
export function renderTaskCommand({
  home,
  scriptPath,
  intervalHours = 6,
  manifestUrl = DEFAULT_MANIFEST_URL,
  profile,
} = {}) {
  if (typeof home !== 'string' || home.length === 0) {
    throw new TypeError('home must be a non-empty path')
  }
  if (typeof scriptPath !== 'string' || scriptPath.length === 0) {
    throw new TypeError('scriptPath must be a non-empty path')
  }
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    throw new TypeError('intervalHours must be a positive number')
  }
  if (!isHttpUrl(manifestUrl)) {
    throw new TypeError('manifestUrl must be an http(s) URL')
  }
  if (profile !== undefined && !isProfileName(profile)) {
    throw new TypeError('profile must be a simple profile name')
  }

  const nodePath = resolve(process.execPath)
  const scriptPathAbs = resolve(scriptPath)
  const homePathAbs = resolve(home)
  // The action argument is parsed by CreateProcess, so paths need double quotes.
  // `--apply` is mandatory: a bare `update.mjs` exits because it requires a mode.
  let command = `"${nodePath}" "${scriptPathAbs}" --apply --home "${homePathAbs}" --manifest "${manifestUrl}"`
  if (profile !== undefined) command += ` --profile "${profile}"`

  // `$home` is PowerShell's read-only automatic variable, hence `$homePath`.
  const wrapper = [
    '$q = [char]34',
    `$node = ${psQuote(nodePath)}`,
    `$script = ${psQuote(scriptPathAbs)}`,
    `$homePath = ${psQuote(homePathAbs)}`,
    `$manifest = ${psQuote(manifestUrl)}`,
    ...(profile === undefined ? [] : [`$profile = ${psQuote(profile)}`]),
    `$argument = $q + $script + $q + ' --apply --home ' + $q + $homePath + $q + ' --manifest ' + $q + $manifest + $q${
      profile === undefined ? '' : " + ' --profile ' + $q + $profile + $q"
    }`,
    '$action = New-ScheduledTaskAction -Execute $node -Argument $argument',
    '$logon = New-ScheduledTaskTrigger -AtLogOn',
    `$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours ${intervalHours})`,
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Action $action -Trigger @($logon, $repeat) -Force | Out-Null`,
  ].join('; ')
  const schedule = [
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(wrapper, 'utf16le').toString('base64')}`,
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
 *   manifestUrl?: string,
 *   profile?: string,
 *   dryRun?: boolean,
 *   exec?: (command: string, options: object) => Promise<unknown>,
 *   log?: (line: string) => void,
 * }} options
 */
export async function registerTask({
  home,
  scriptPath,
  intervalHours = 6,
  manifestUrl = DEFAULT_MANIFEST_URL,
  profile,
  dryRun = false,
  exec = defaultExec,
  log = console.log,
} = {}) {
  const task = renderTaskCommand({ home, scriptPath, intervalHours, manifestUrl, profile })
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
      manifestUrl: values['manifest-url'] ?? DEFAULT_MANIFEST_URL,
      profile: values.profile,
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
      'manifest-url': { type: 'string' },
      profile: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  })
  return values
}

function isProfileName(profile) {
  return (
    typeof profile === 'string' && PROFILE_RE.test(profile) && profile !== '.' && profile !== '..'
  )
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
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
