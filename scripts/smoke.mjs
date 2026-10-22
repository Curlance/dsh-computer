#!/usr/bin/env node
/**
 * Real Windows smoke test for the dsh-computer cua-driver stack.
 *
 * Starts one `cua-driver mcp` session, lists windows, and observes the active
 * window with both the UIA tree and a screenshot. `observe` over 1500ms is
 * reported as `slow` but does not fail. Prints one JSON document and exits 1
 * only on a failed check.
 */
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { createCuaBackend } from '../lib/backend/cua.js'
import { createMcpClient, createProcessTransport } from '../lib/backend/mcp.js'
import { resolveDriverCommand } from '../lib/host.js'
import { createObserver } from '../lib/observe.js'

const OBSERVE_BUDGET_MS = 1500
const TIMEOUT_MS = 20000

const checks = []

function record(name, started, detail, { ok = true, slow = false } = {}) {
  const entry = { name, ok, ms: Math.round(performance.now() - started), detail }
  if (slow) entry.slow = true
  checks.push(entry)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const driverStart = performance.now()
  const command = resolveDriverCommand()
  if (!existsSync(command)) {
    record('driver', driverStart, `cua-driver not found (${command}); install Cua Driver or set CUA_DRIVER_BIN`, {
      ok: false,
    })
    throw new Error('cua-driver executable not found')
  }
  record('driver', driverStart, command)

  const transport = createProcessTransport({ command, args: ['mcp'] })
  const client = createMcpClient({ transport, timeoutMs: TIMEOUT_MS })
  try {
    const backendStart = performance.now()
    let serverInfo
    try {
      serverInfo = (await client.start()).serverInfo
    } catch (error) {
      record('backend-start', backendStart, messageOf(error), { ok: false })
      throw error
    }
    record('backend-start', backendStart, `cua-driver ${serverInfo?.version ?? 'unknown'} ready`)

    const backend = createCuaBackend({ client })
    const listStart = performance.now()
    let windows
    try {
      windows = (await backend.listWindows()).structured?.windows
    } catch (error) {
      record('list-windows', listStart, messageOf(error), { ok: false })
      throw error
    }
    if (!Array.isArray(windows)) {
      record('list-windows', listStart, 'list_windows returned no windows array', { ok: false })
      throw new Error('list_windows returned no windows array')
    }
    record('list-windows', listStart, `${windows.length} windows`)

    const observer = createObserver({ backend })
    const observeStart = performance.now()
    let observation
    try {
      observation = await observer.observe({ kind: 'active' }, { mode: 'both' })
    } catch (error) {
      record('observe-active', observeStart, messageOf(error), { ok: false })
      throw error
    }
    const elapsedMs = performance.now() - observeStart
    const screenshot = Buffer.isBuffer(observation.screenshotPng) ? observation.screenshotPng.length : 0
    record(
      'observe-active',
      observeStart,
      `title=${JSON.stringify(observation.title)}; tree=${observation.tree.length}; screenshot=${screenshot}B; budget=${OBSERVE_BUDGET_MS}ms`,
      { ok: screenshot > 0, slow: elapsedMs >= OBSERVE_BUDGET_MS },
    )
  } finally {
    await client.close().catch(() => {})
  }
}

main()
  .catch(() => {})
  .finally(() => {
    const warnings = checks
      .filter((check) => check.slow)
      .map((check) => `${check.name} took ${check.ms}ms (>= ${OBSERVE_BUDGET_MS}ms)`)
    const ok = checks.every((check) => check.ok)
    console.log(
      JSON.stringify({ ok, checks, ...(warnings.length > 0 ? { warnings } : {}) }, null, 2),
    )
    process.exitCode = ok ? 0 : 1
  })
