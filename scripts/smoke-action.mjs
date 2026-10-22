#!/usr/bin/env node
/**
 * Real Windows action smoke test: launch a target we own, observe it, click its
 * text area, type a unique marker, read it back, and close the target by pid.
 *
 * Target: a generated .hta document hosting a <textarea>, launched through
 * mshta.exe. Notepad is deliberately not used on this Windows build: packaged
 * Notepad restores the user's previous tabs on activation, so the driver cannot
 * prove an isolated instance and closing it could touch user data. The .hta is
 * a native UIA Edit in a process launched by this run and closed by pid.
 *
 * The AI cursor session is unique to this run and ended in cleanup. Budgets:
 * observe < 1500ms, element click < 800ms, readback < 1500ms; exceeding one is a
 * `slow` warning, not a failure. Prints one JSON document; exits 1 only on a
 * failed check.
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

const checks = []

let backend
let client
let pid
let session
let tempDir

function record(name, started, detail, { ok = true, slow = false } = {}) {
  const entry = { name, ok, ms: Math.round(performance.now() - started), detail }
  if (slow) entry.slow = true
  checks.push(entry)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
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
  client = createMcpClient({ transport, timeoutMs: TIMEOUT_MS })
  const backendStart = performance.now()
  let serverInfo
  try {
    serverInfo = (await client.start()).serverInfo
  } catch (error) {
    record('backend-start', backendStart, messageOf(error), { ok: false })
    throw error
  }
  record('backend-start', backendStart, `cua-driver ${serverInfo?.version ?? 'unknown'} ready`)
  backend = createCuaBackend({ client })

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const mshta = join(systemRoot, 'System32', 'mshta.exe')
  if (!existsSync(mshta)) {
    record('launch-target', performance.now(), `mshta.exe not found at ${mshta}`, { ok: false })
    throw new Error('no isolated text target available')
  }

  session = `dsh-smoke-${process.pid}-${Date.now()}`
  const cursorStart = performance.now()
  try {
    await backend.startSession({ label: session })
    await backend.setAgentCursorEnabled(true)
    record('cursor-session', cursorStart, `session=${session}`)
  } catch (error) {
    record('cursor-session', cursorStart, messageOf(error), { ok: false })
  }

  tempDir = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
  const stamp = Date.now()
  const title = `DSH-SMOKE-TARGET-${stamp}`
  const marker = `DSH-MARKER-${stamp}`
  const htaPath = join(tempDir, 'target.hta')
  await writeFile(htaPath, targetDocument(title))

  const launchStart = performance.now()
  let launch
  try {
    launch = await backend.launchApp({ path: mshta, additional_arguments: [htaPath] })
  } catch (error) {
    record('launch-target', launchStart, messageOf(error), { ok: false })
    throw error
  }
  pid = launch.structured?.pid
  if (!Number.isInteger(pid)) {
    record('launch-target', launchStart, 'launch_app returned no pid', { ok: false })
    throw new Error('launch_app returned no pid')
  }
  const window =
    (launch.structured?.windows ?? []).find((entry) => entry.title?.includes(title)) ??
    (await waitForWindow(pid, title))
  if (window === null) {
    record('launch-target', launchStart, `pid=${pid}; no window appeared`, { ok: false })
    throw new Error('launched target showed no window')
  }
  record('launch-target', launchStart, `pid=${pid}; window=${window.window_id}; title=${JSON.stringify(window.title)}`)

  const observer = createObserver({ backend })
  const observeStart = performance.now()
  let observation
  try {
    observation = await observer.observe(
      { kind: 'window', pid, windowId: window.window_id },
      { mode: 'both' },
    )
  } catch (error) {
    record('observe', observeStart, messageOf(error), { ok: false })
    throw error
  }
  const observeMs = performance.now() - observeStart
  const screenshot = Buffer.isBuffer(observation.screenshotPng) ? observation.screenshotPng.length : 0
  record(
    'observe',
    observeStart,
    `title=${JSON.stringify(observation.title)}; tree=${observation.tree.length}; screenshot=${screenshot}B; budget=${OBSERVE_BUDGET_MS}ms`,
    { ok: screenshot > 0, slow: observeMs >= OBSERVE_BUDGET_MS },
  )

  const clickStart = performance.now()
  const click = await clickEditor(observation, editorRow(observation.tree))
  const clickMs = performance.now() - clickStart
  record('click-editor', clickStart, `${click.via}; effect=${click.result.effect}; budget=${CLICK_BUDGET_MS}ms`, {
    ok: click.result.effect !== 'refused',
    slow: clickMs >= CLICK_BUDGET_MS,
  })

  // The click's readback replaces the driver snapshot, so observe again before
  // typing instead of reusing the now-stale element tokens.
  await sleep(100)
  const typingObservation = await observer.observe(
    { kind: 'window', pid, windowId: window.window_id },
    { mode: 'tree' },
  )
  const typeStart = performance.now()
  let typeResult = await execute(backend, { observation: typingObservation, op: 'type', text: marker })
  if (typeResult.effect === 'refused') {
    const row = editorRow(typingObservation.tree)
    if (row !== null) {
      typeResult = await execute(backend, {
        observation: typingObservation,
        op: 'type',
        target: { element: row.id },
        text: marker,
      })
    }
  }
  record('type-marker', typeStart, `effect=${typeResult.effect}; marker=${marker}`, {
    ok: typeResult.effect !== 'refused',
  })

  await sleep(WAIT_AFTER_TYPE_MS)
  let readbackStart = performance.now()
  let after = await observer.observe(
    { kind: 'window', pid, windowId: window.window_id },
    { mode: 'tree' },
  )
  let matched = after.tree.filter((row) => JSON.stringify(row).includes(marker))

  if (matched.length === 0) {
    // One pixel-click retry: some hosts need a real pointer focus before
    // PostMessage WM_CHAR reaches the editor.
    const row = editorRow(after.tree)
    await execute(backend, { observation: after, op: 'click', target: editorPoint(row, after) })
    await sleep(100)
    await execute(backend, { observation: after, op: 'type', text: marker })
    await sleep(WAIT_AFTER_TYPE_MS)
    readbackStart = performance.now()
    after = await observer.observe(
      { kind: 'window', pid, windowId: window.window_id },
      { mode: 'tree' },
    )
    matched = after.tree.filter((row) => JSON.stringify(row).includes(marker))
  }

  const readbackMs = performance.now() - readbackStart
  const editValue = after.tree.find((row) => /^edit$/i.test(row.role))?.value
  record(
    'readback',
    readbackStart,
    `marker rows=${matched.length}; value=${JSON.stringify(typeof editValue === 'string' ? editValue.slice(0, 120) : editValue)}; budget=${READBACK_BUDGET_MS}ms`,
    { ok: matched.length > 0, slow: readbackMs >= READBACK_BUDGET_MS },
  )

  const cursorStateStart = performance.now()
  if (!checks.find((check) => check.name === 'cursor-session')?.ok) {
    record('cursor-position', cursorStateStart, 'skipped: cursor session not started')
  } else {
    try {
      const point = editorPoint(editorRow(after.tree), after)
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
      record('cursor-position', cursorStateStart, JSON.stringify(position), {
        ok: Number.isFinite(position?.x) && Number.isFinite(position?.y),
      })
    } catch (error) {
      record('cursor-position', cursorStateStart, messageOf(error), { ok: false })
    }
  }
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
    if (session !== undefined) await client.call('end_session', { session }).catch(() => {})
    await client.close().catch(() => {})
  }
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}

main()
  .catch(() => {})
  .finally(cleanup)
  .finally(() => {
    const warnings = checks
      .filter((check) => check.slow)
      .map((check) => `${check.name} took ${check.ms}ms (over budget)`)
    const ok = checks.every((check) => check.ok)
    console.log(
      JSON.stringify({ ok, checks, ...(warnings.length > 0 ? { warnings } : {}) }, null, 2),
    )
    process.exitCode = ok ? 0 : 1
  })
