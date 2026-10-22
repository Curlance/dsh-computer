import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

const DEFAULT_IDLE_TIMEOUT_MS = 3000
const DEFAULT_GATE_MS = 700
const DEFAULT_CACHE_MS = 1000
const POWERSHELL = 'powershell.exe'

// Counts milliseconds since the last keyboard/mouse input in this Windows
// session. GetLastInputInfo also counts our own SendInput, which is exactly the
// ambiguity the control gate's own-action heuristic compensates for.
const WINDOWS_IDLE_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshLastInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")]
  public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint IdleMilliseconds() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref info)) { throw new InvalidOperationException("GetLastInputInfo failed"); }
    return (uint)Environment.TickCount - info.dwTime;
  }
}
'@
[Console]::Out.Write([DshLastInput]::IdleMilliseconds())
`.trim()

const defaultExecFile = promisify(nodeExecFile)

function roundSeconds(ms) {
  return Math.round(ms / 100) / 10
}

/**
 * Human-activity gate. `ready` means the desktop belongs to the agent, `user`
 * means the user is active and the agent should wait, `unknown` means the idle
 * provider failed and `onUnknown` decides.
 * @param {{
 *   now?: () => number,
 *   idleProvider: () => number | null | Promise<number | null>,
 *   idleTimeoutMs?: number,
 *   gateMs?: number,
 *   onUnknown?: 'allow' | 'block',
 * }} options
 */
export function createControlGate({
  now = Date.now,
  idleProvider,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  gateMs = DEFAULT_GATE_MS,
  onUnknown = 'allow',
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  if (typeof idleProvider !== 'function') throw new TypeError('idleProvider must be a function')
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new TypeError('idleTimeoutMs must be a positive number')
  }
  if (!Number.isFinite(gateMs) || gateMs < 0) {
    throw new TypeError('gateMs must be a non-negative number')
  }
  if (onUnknown !== 'allow' && onUnknown !== 'block') {
    throw new TypeError("onUnknown must be 'allow' or 'block'")
  }

  let lastAgentActionAt = null

  async function status() {
    let age = null
    try {
      age = await idleProvider()
    } catch {
      age = null
    }
    if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) {
      return { control: 'unknown', lastInputAgeMs: null, waitSeconds: 0 }
    }
    if (age >= idleTimeoutMs) {
      return { control: 'ready', lastInputAgeMs: age, waitSeconds: 0 }
    }
    // Windows counts our own SendInput in GetLastInputInfo. If the last input is
    // not newer than our own action (age >= time since the action), that input
    // is ours, not the user's — regardless of how long the model round-trip
    // took. Only input that landed after our action means the user took over.
    // shortcut: input within clock-skew tolerance of our action is attributed to
    // us; a native input-event listener is the only exact separation.
    if (lastAgentActionAt !== null) {
      const elapsed = now() - lastAgentActionAt
      if (elapsed >= 0 && age >= elapsed - 50) {
        return { control: 'ready', lastInputAgeMs: age, waitSeconds: 0 }
      }
    }
    return {
      control: 'user',
      lastInputAgeMs: age,
      waitSeconds: roundSeconds(idleTimeoutMs - age),
    }
  }

  async function assertAgentAllowed() {
    const current = await status()
    if (current.control === 'ready') {
      return { allowed: true, control: 'ready', waitSeconds: 0 }
    }
    if (current.control === 'user') {
      return {
        allowed: false,
        control: 'user',
        waitSeconds: current.waitSeconds,
        reason: 'user-active',
      }
    }
    if (onUnknown === 'allow') {
      return { allowed: true, control: 'unknown', waitSeconds: 0 }
    }
    return { allowed: false, control: 'unknown', waitSeconds: 0, reason: 'control-unknown' }
  }

  function noteAgentAction() {
    lastAgentActionAt = now()
  }

  return { status, assertAgentAllowed, noteAgentAction }
}

/**
 * Idle provider backed by PowerShell `GetLastInputInfo`. Failures resolve to
 * null (unknown control) and never reject. Consecutive reads within `cacheMs`
 * share one PowerShell invocation.
 * @param {{
 *   execFile?: (file: string, args: string[]) => Promise<{stdout?: string} | string>,
 *   cacheMs?: number,
 *   platform?: NodeJS.Platform,
 * }} [options]
 */
export function createWindowsIdleProvider({
  execFile = defaultExecFile,
  cacheMs = DEFAULT_CACHE_MS,
  platform = process.platform,
} = {}) {
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function')
  if (!Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new TypeError('cacheMs must be a non-negative number')
  }
  if (platform !== 'win32') return async () => null

  let lastRunAt = Number.NEGATIVE_INFINITY
  let lastValue = null
  let inFlight = null

  async function readIdle() {
    const startedAt = Date.now()
    if (startedAt - lastRunAt < cacheMs) return lastValue
    if (inFlight !== null) return inFlight

    const running = (async () => {
      let value = null
      try {
        const output = await execFile(
          POWERSHELL,
          ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDLE_SCRIPT],
          { timeout: 3000, windowsHide: true },
        )
        const text = typeof output === 'string' ? output : output?.stdout
        const parsed = Number.parseInt(String(text ?? '').trim(), 10)
        if (Number.isFinite(parsed) && parsed >= 0) value = parsed
      } catch {
        value = null
      } finally {
        lastRunAt = Date.now()
        lastValue = value
        inFlight = null
      }
      return value
    })()

    inFlight = running
    return running
  }

  return readIdle
}
