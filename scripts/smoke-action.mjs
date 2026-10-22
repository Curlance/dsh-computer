#!/usr/bin/env node
/**
 * Real Windows action smoke test: launch a target we own, observe it, click its
 * text area, type a unique marker, read it back from the editor's `Edit.value`,
 * and close the target by pid.
 *
 * Target: a generated .hta document hosting a <textarea>, launched through
 * mshta.exe. Notepad is deliberately not used on this Windows build: packaged
 * Notepad restores the user's previous tabs on activation, so the driver cannot
 * prove an isolated instance and closing it could touch user data. The .hta is
 * a native UIA Edit in a process launched by this run and closed by pid.
 *
 * The AI cursor session is unique to this run and ended in cleanup. Budgets:
 * observe < 1500ms, element click < 800ms, readback < 1500ms; exceeding one is a
 * `slow` warning, not a failure. Every stage is wrapped so a thrown error is
 * recorded and fails the run; the top-level catch records a `fatal` check.
 *
 * Negative test (no desktop work): set SMOKE_FORCE_FAIL to a stage name, e.g.
 *   SMOKE_FORCE_FAIL=backend-start node scripts/smoke-action.mjs
 * The named stage throws before doing its work, so the run prints ok:false and
 * exits 1.
 *
 * Prints one JSON document; exits 1 if any check failed.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

import { execute } from '../lib/act.js'
import { createCuaBackend } from '../lib/backend/cua.js'
import { createMcpClient, createProcessTransport } from '../lib/backend/mcp.js'
import { resolveDriverCommand } from '../lib/host.js'
import { createObserver, toLocalPoint } from '../lib/observe.js'

const TIMEOUT_MS = 20000
const OBSERVE_BUDGET_MS = 1500
const CLICK_BUDGET_MS = 800
const READBACK_BUDGET_MS = 1500
const WAIT_AFTER_TYPE_MS = 300

const STAGES = [
  'driver',
  'backend-start',
  'target-setup',
  'cursor-session',
  'launch-target',
  'observe',
  'click-editor',
  'type-marker',
  'readback',
  'cursor-position',
]
const FORCE_FAIL = process.env.SMOKE_FORCE_FAIL

const checks = []
const cleanupWarnings = []

let backend
let client
let pid
let session
let tempDir
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

function targetDocument(title) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<hta:application id="smoke" border="thin" caption="yes" maximizebutton="no" minimizebutton="yes" showintaskbar="yes" />
<style>html,body{margin:0;height:100%;overflow:hidden}textarea{width:100%;height:100%;font:16px Consolas;border:0;outline:0}</style>
</head>
<body><textarea id="editor" autofocus></textarea></body>
</html>
`
}

function editorRow(tree) {
  return (
    tree.find((row) => /^edit$/i.test(row.role) && row.actions?.includes('set_value')) ??
    tree.find((row) => /^(edit|document)$/i.test(row.role)) ??
    null
  )
}

function editValueOf(tree) {
  return tree.find((row) => /^edit$/i.test(row.role))?.value
}

function includesMarker(value, marker) {
  return typeof value === 'string' && value.includes(marker)
}

function editorPoint(row, observation) {
  if (row?.frame !== null && row?.frame !== undefined) {
    try {
      return toLocalPoint(
        { x: row.frame.x + row.frame.w / 2, y: row.frame.y + row.frame.h / 2 },
        observation,
      )
    } catch {
      // fall through to the screenshot centre
    }
  }
  return {
    x: Math.round(observation.space.width / 2),
    y: Math.round(observation.space.height / 2),
  }
}

async function clickEditor(observation, row) {
  if (row !== null) {
    const result = await execute(backend, { observation, op: 'click', target: { element: row.id } })
    if (result.effect !== 'refused') return { result, via: `element ${row.id}` }
  }
  const point = editorPoint(row, observation)
  const result = await execute(backend, { observation, op: 'click', target: point })
  return { result, via: `pixel (${point.x},${point.y})` }
}

async function waitForWindow(pidValue, title, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs
  let windows = []
  for (;;) {
    windows = (await backend.listWindows({ pid: pidValue })).structured?.windows ?? []
    const match = windows.find((window) => window.title?.includes(title))
    if (match !== undefined) return match
    if (performance.now() >= deadline) return windows.find((window) => window.is_on_screen !== false) ?? null
    await sleep(200)
  }
}

function observationDetail(observation, screenshot) {
  const truncation = observation.truncationReason === undefined ? '' : `(${observation.truncationReason})`
  return `title=${JSON.stringify(observation.title)}; tree=${observation.tree.length}; screenshot=${screenshot}B; truncated=${observation.truncated}${truncation}; budget=${OBSERVE_BUDGET_MS}ms`
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

  await stage('backend-start', async (started) => {
    const transport = createProcessTransport({ command, args: ['mcp'] })
    client = createMcpClient({ transport, timeoutMs: TIMEOUT_MS })
    const serverInfo = (await client.start()).serverInfo
    backend = createCuaBackend({ client })
    record('backend-start', started, `cua-driver ${serverInfo?.version ?? 'unknown'} ready`)
  })

  const target = await stage('target-setup', async (started) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const mshta = join(systemRoot, 'System32', 'mshta.exe')
    if (!existsSync(mshta)) {
      record('target-setup', started, `mshta.exe not found at ${mshta}`, { ok: false })
      throw new Error('no isolated text target available')
    }
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
    const stamp = Date.now()
    const title = `DSH-SMOKE-TARGET-${stamp}`
    const marker = `DSH-MARKER-${stamp}`
    const htaPath = join(tempDir, 'target.hta')
    await writeFile(htaPath, targetDocument(title))
    record('target-setup', started, `hta=${htaPath}`)
    return { htaPath, marker, mshta, title }
  })

  session = `dsh-smoke-${process.pid}-${Date.now()}`
  const cursorStart = performance.now()
  try {
    if (FORCE_FAIL === 'cursor-session') {
      throw new Error('forced failure at stage "cursor-session" (negative test)')
    }
    await backend.startSession({ label: session })
    await backend.setAgentCursorEnabled(true)
    record('cursor-session', cursorStart, `session=${session}`)
  } catch (error) {
    record('cursor-session', cursorStart, messageOf(error), { ok: false })
  }

  const window = await stage('launch-target', async (started) => {
    const launch = await backend.launchApp({
      path: target.mshta,
      additional_arguments: [target.htaPath],
    })
    pid = launch.structured?.pid
    if (!Number.isInteger(pid)) {
      record('launch-target', started, 'launch_app returned no pid', { ok: false })
      throw new Error('launch_app returned no pid')
    }
    const match =
      (launch.structured?.windows ?? []).find((entry) => entry.title?.includes(target.title)) ??
      (await waitForWindow(pid, target.title))
    if (match === null) {
      record('launch-target', started, `pid=${pid}; no window appeared`, { ok: false })
      throw new Error('launched target showed no window')
    }
    record(
      'launch-target',
      started,
      `pid=${pid}; window=${match.window_id}; title=${JSON.stringify(match.title)}`,
    )
    return match
  })

  const observer = createObserver({ backend, budgetMs: OBSERVE_BUDGET_MS })
  const observation = await stage('observe', async (started) => {
    const observed = await observer.observe(
      { kind: 'window', pid, windowId: window.window_id },
      { mode: 'both' },
    )
    const screenshot = Buffer.isBuffer(observed.screenshotPng) ? observed.screenshotPng.length : 0
    record('observe', started, observationDetail(observed, screenshot), {
      ok: screenshot > 0,
      slow: performance.now() - started >= OBSERVE_BUDGET_MS,
    })
    return observed
  })

  await stage('click-editor', async (started) => {
    const click = await clickEditor(observation, editorRow(observation.tree))
    record(
      'click-editor',
      started,
      `${click.via}; effect=${click.result.effect}; budget=${CLICK_BUDGET_MS}ms`,
      { ok: click.result.effect !== 'refused', slow: performance.now() - started >= CLICK_BUDGET_MS },
    )
  })

  await stage('type-marker', async () => {
    // The click's readback replaces the driver snapshot, so observe again before
    // typing instead of reusing the now-stale element tokens.
    await sleep(100)
    const typingObservation = await observer.observe(
      { kind: 'window', pid, windowId: window.window_id },
      { mode: 'tree' },
    )
    const typeStart = performance.now()
    let typeResult = await execute(backend, {
      observation: typingObservation,
      op: 'type',
      text: target.marker,
    })
    if (typeResult.effect === 'refused') {
      const row = editorRow(typingObservation.tree)
      if (row !== null) {
        typeResult = await execute(backend, {
          observation: typingObservation,
          op: 'type',
          target: { element: row.id },
          text: target.marker,
        })
      }
    }
    record('type-marker', typeStart, `effect=${typeResult.effect}; marker=${target.marker}`, {
      ok: typeResult.effect !== 'refused',
    })
  })

  await stage('readback', async () => {
    await sleep(WAIT_AFTER_TYPE_MS)
    let readbackStart = performance.now()
    let after = await observer.observe(
      { kind: 'window', pid, windowId: window.window_id },
      { mode: 'tree' },
    )
    let editValue = editValueOf(after.tree)
    let rowMatches = after.tree.filter((row) => JSON.stringify(row).includes(target.marker)).length

    if (!includesMarker(editValue, target.marker)) {
      // One pixel-click retry: some hosts need a real pointer focus before
      // PostMessage WM_CHAR reaches the editor.
      const row = editorRow(after.tree)
      await execute(backend, { observation: after, op: 'click', target: editorPoint(row, after) })
      await sleep(100)
      await execute(backend, { observation: after, op: 'type', text: target.marker })
      await sleep(WAIT_AFTER_TYPE_MS)
      readbackStart = performance.now()
      after = await observer.observe(
        { kind: 'window', pid, windowId: window.window_id },
        { mode: 'tree' },
      )
      editValue = editValueOf(after.tree)
      rowMatches = after.tree.filter((row) => JSON.stringify(row).includes(target.marker)).length
    }

    const value = typeof editValue === 'string' ? editValue.slice(0, 120) : editValue
    record(
      'readback',
      readbackStart,
      `edit.value=${JSON.stringify(value)}; valueMatch=${includesMarker(editValue, target.marker)}; markerRows=${rowMatches}; budget=${READBACK_BUDGET_MS}ms`,
      { ok: includesMarker(editValue, target.marker), slow: performance.now() - readbackStart >= READBACK_BUDGET_MS },
    )
  })

  await stage('cursor-position', async (started) => {
    if (!checks.find((check) => check.name === 'cursor-session')?.ok) {
      record('cursor-position', started, 'skipped: cursor session not started')
      return
    }
    const point = editorPoint(editorRow(observation.tree), observation)
    await backend.moveCursor({
      x: point.x,
      y: point.y,
      target: { kind: 'window', pid, window_id: window.window_id },
    })
    let state = await backend.getAgentCursorState()
    let position = state.structured?.position ?? null
    if (position === null) {
      // The cursor glides by default; let the animation settle.
      await sleep(800)
      state = await backend.getAgentCursorState()
      position = state.structured?.position ?? null
    }
    record('cursor-position', started, JSON.stringify(position), {
      ok: Number.isFinite(position?.x) && Number.isFinite(position?.y),
    })
  })
}

async function cleanup() {
  if (backend !== undefined && Number.isInteger(pid)) {
    const killStart = performance.now()
    try {
      await backend.killApp({ pid })
      record('kill-target', killStart, `pid=${pid}`)
    } catch (error) {
      record('kill-target', killStart, `pid=${pid}: ${messageOf(error)}`, { ok: false })
    }
  }
  if (client !== undefined) {
    if (session !== undefined) {
      try {
        await client.call('end_session', { session })
      } catch (error) {
        cleanupWarnings.push(`end_session failed: ${messageOf(error)}`)
      }
    }
    try {
      await client.close()
    } catch (error) {
      cleanupWarnings.push(`client close failed: ${messageOf(error)}`)
    }
  }
  if (tempDir !== undefined) {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch (error) {
      cleanupWarnings.push(`temp cleanup failed: ${messageOf(error)}`)
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
  } finally {
    await cleanup()
  }
}

function report() {
  const warnings = checks
    .filter((check) => check.slow)
    .map((check) => `${check.name} took ${check.ms}ms (over budget)`)
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
