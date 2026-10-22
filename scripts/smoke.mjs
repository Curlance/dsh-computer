#!/usr/bin/env node
/**
 * Real Windows smoke test for the dsh-computer cua-driver stack.
 *
 * Starts one `cua-driver mcp` session, lists windows, and observes the active
 * window with both the UIA tree and a screenshot. `observe` over 1500ms is
 * reported as `slow` but does not fail. Every stage is wrapped so a thrown error
 * is recorded and fails the run; the top-level catch records a `fatal` check.
 *
 * Negative test (no desktop work): set SMOKE_FORCE_FAIL to a stage name, e.g.
 *   SMOKE_FORCE_FAIL=backend-start node scripts/smoke.mjs
 *
 * Prints one JSON document and exits 1 if any check failed.
 */
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

import { createCuaBackend } from '../lib/backend/cua.js'
import { createMcpClient, createProcessTransport } from '../lib/backend/mcp.js'
import { resolveDriverCommand } from '../lib/host.js'
import { createObserver } from '../lib/observe.js'

const OBSERVE_BUDGET_MS = 1500
const TIMEOUT_MS = 20000

const STAGES = ['driver', 'backend-start', 'list-windows', 'observe-active']
const FORCE_FAIL = process.env.SMOKE_FORCE_FAIL

const checks = []
const cleanupWarnings = []

let client
let currentStage = 'main'

function record(name, started, detail, { ok = true, slow = false } = {}) {
  const entry = { name, ok, ms: Math.round(performance.now() - started), detail }
  if (slow) entry.slow = true
  checks.push(entry)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function stage(name, fn) {
  currentStage = name
  const started = performance.now()
  try {
    if (FORCE_FAIL === name) {
      throw new Error(`forced failure at stage "${name}" (negative test)`)
    }
    return await fn(started)
  } catch (error) {
    if (!checks.some((check) => check.name === name && !check.ok)) {
      record(name, started, messageOf(error), { ok: false })
    }
    throw error
  }
}

async function main() {
  const command = await stage('driver', (started) => {
    const resolved = resolveDriverCommand()
    if (!existsSync(resolved)) {
      record('driver', started, `cua-driver not found (${resolved}); install Cua Driver or set CUA_DRIVER_BIN`, {
        ok: false,
      })
      throw new Error('cua-driver executable not found')
    }
    record('driver', started, resolved)
    return resolved
  })

  try {
    const backend = await stage('backend-start', async (started) => {
      const transport = createProcessTransport({ command, args: ['mcp'] })
      client = createMcpClient({ transport, timeoutMs: TIMEOUT_MS })
      const serverInfo = (await client.start()).serverInfo
      const created = createCuaBackend({ client })
      record('backend-start', started, `cua-driver ${serverInfo?.version ?? 'unknown'} ready`)
      return created
    })

    await stage('list-windows', async (started) => {
      const windows = (await backend.listWindows()).structured?.windows
      if (!Array.isArray(windows)) {
        record('list-windows', started, 'list_windows returned no windows array', { ok: false })
        throw new Error('list_windows returned no windows array')
      }
      record('list-windows', started, `${windows.length} windows`)
    })

    const observer = createObserver({ backend, budgetMs: OBSERVE_BUDGET_MS })
    await stage('observe-active', async (started) => {
      const observation = await observer.observe({ kind: 'active' }, { mode: 'both' })
      const screenshot = Buffer.isBuffer(observation.screenshotPng) ? observation.screenshotPng.length : 0
      const truncation =
        observation.truncationReason === undefined ? '' : `(${observation.truncationReason})`
      record(
        'observe-active',
        started,
        `title=${JSON.stringify(observation.title)}; tree=${observation.tree.length}; screenshot=${screenshot}B; truncated=${observation.truncated}${truncation}; budget=${OBSERVE_BUDGET_MS}ms`,
        { ok: screenshot > 0, slow: performance.now() - started >= OBSERVE_BUDGET_MS },
      )
    })
  } finally {
    if (client !== undefined) {
      try {
        await client.close()
      } catch (error) {
        cleanupWarnings.push(`client close failed: ${messageOf(error)}`)
      }
    }
  }
}

async function run() {
  try {
    if (FORCE_FAIL !== undefined && !STAGES.includes(FORCE_FAIL)) {
      throw new Error(
        `unknown SMOKE_FORCE_FAIL stage "${FORCE_FAIL}"; expected one of: ${STAGES.join(', ')}`,
      )
    }
    await main()
  } catch (error) {
    record('fatal', performance.now(), `${currentStage}: ${messageOf(error)}`, { ok: false })
  }
}

function report() {
  const warnings = checks
    .filter((check) => check.slow)
    .map((check) => `${check.name} took ${check.ms}ms (>= ${OBSERVE_BUDGET_MS}ms)`)
  warnings.push(...cleanupWarnings)
  const ok = checks.every((check) => check.ok)
  console.log(
    JSON.stringify({ ok, checks, ...(warnings.length > 0 ? { warnings } : {}) }, null, 2),
  )
  process.exitCode = ok ? 0 : 1
}

run().then(report, (error) => {
  record('fatal', performance.now(), messageOf(error), { ok: false })
  report()
})
