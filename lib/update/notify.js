import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

const defaultExec = promisify(nodeExecFile)

/** Toast failures should never hold up an update; keep the timeout short. */
export const NOTIFY_TIMEOUT_MS = 5000

const LEVELS = new Set(['info', 'warn', 'error'])
const TOAST_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * Show a best-effort Windows toast. Never rejects: a non-Windows host or a
 * broken PowerShell invocation resolves to false, optionally through `logger`.
 *
 * @param {{
 *   title: string,
 *   message: string,
 *   level?: 'info'|'warn'|'error',
 *   exec?: (file: string, args: string[], options: object) => Promise<unknown>,
 *   logger?: { warn?: (message: string) => void } | null,
 *   platform?: NodeJS.Platform,
 * }} options
 * @returns {Promise<boolean>}
 */
export async function notify({
  title,
  message,
  level = 'info',
  exec = defaultExec,
  logger = null,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return false

  const safeLevel = LEVELS.has(level) ? level : 'info'
  try {
    await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        renderToastScript({ title, message, level: safeLevel }),
      ],
      { timeout: NOTIFY_TIMEOUT_MS, windowsHide: true },
    )
    return true
  } catch (error) {
    logger?.warn?.(`notify: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function psString(value) {
  const text = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/'/g, "''")
  return `'${text}'`
}

function renderToastScript({ title, message, level }) {
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$text = $template.GetElementsByTagName('text')",
    `$text.Item(0).AppendChild($template.CreateTextNode(${psString(title)})) > $null`,
    `$text.Item(1).AppendChild($template.CreateTextNode(${psString(message)})) > $null`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    `$toast.Tag = ${psString(level)}`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psString(TOAST_APP_ID)}).Show($toast)`,
  ].join('\n')
}
