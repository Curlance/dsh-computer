import test from 'node:test'
import assert from 'node:assert/strict'

import { createObserver, resolveTarget, toLocalPoint, waitFor } from '../lib/observe.js'

const PID = 100
const WINDOW_ID = 200
const TITLE = 'Editor'
const BOUNDS = { x: 0, y: 0, width: 2880, height: 1800 }
const SCREENSHOT = { width: 1456, height: 910 }
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const WINDOW_TARGET = { kind: 'window', pid: PID, windowId: WINDOW_ID }

const WINDOW = {
  pid: PID,
  window_id: WINDOW_ID,
  title: TITLE,
  bounds: { ...BOUNDS },
  is_on_screen: true,
  minimized: false,
  z_index: 5,
}

const BASE_ELEMENTS = [
  {
    element_token: 's00000001:0',
    element_index: 0,
    role: 'Window',
    label: TITLE,
    frame: { x: 0, y: 0, w: 2880, h: 1800 },
    actions: ['invoke'],
    enabled: true,
    parent_index: null,
  },
  {
    element_token: 's00000001:1',
    element_index: 1,
    role: 'Button',
    label: 'Save',
    frame: { x: 282, y: 644, w: 72, h: 38 },
    actions: ['invoke'],
    enabled: true,
    parent_index: 0,
  },
  {
    element_token: 's00000001:2',
    element_index: 2,
    role: 'Button',
    label: 'Cancel',
    frame: { x: 400, y: 644, w: 72, h: 38 },
    actions: ['invoke'],
    enabled: false,
    parent_index: 0,
  },
  {
    element_token: 's00000001:3',
    element_index: 3,
    role: 'Edit',
    label: 'Name',
    frame: { x: 282, y: 700, w: 200, h: 40 },
    actions: ['set_value'],
    enabled: true,
    value: 'hello',
    parent_index: 0,
  },
]

const DONE_ELEMENT = {
  element_token: 's00000001:4',
  element_index: 4,
  role: 'Text',
  label: 'Done',
  frame: { x: 282, y: 760, w: 80, h: 24 },
  actions: [],
  enabled: true,
  parent_index: 0,
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function cloneElements(elements) {
  return elements.map((element) => ({
    ...element,
    frame: { ...element.frame },
    actions: [...element.actions],
  }))
}

/** Project the fixture tree the way cua-driver's `query` does: matches plus ancestors. */
function projectQuery(elements, query) {
  const needle = String(query).toLowerCase()
  const byIndex = new Map(elements.map((element) => [element.element_index, element]))
  const keep = new Set()
  for (const element of elements) {
    const haystack = [element.label, element.value, element.role]
    const hit = haystack.some(
      (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
    )
    if (!hit) continue
    keep.add(element.element_index)
    let parent = element.parent_index
    while (parent !== null && parent !== undefined) {
      keep.add(parent)
      parent = byIndex.get(parent)?.parent_index ?? null
    }
  }
  return elements.filter((element) => keep.has(element.element_index))
}

function windowStateResult({
  pid = PID,
  windowId = WINDOW_ID,
  title = TITLE,
  bounds = BOUNDS,
  elements = BASE_ELEMENTS,
  includeScreenshot = true,
  screenshot = SCREENSHOT,
  truncated = false,
  truncationReason,
  elementsComplete,
  image = PNG,
} = {}) {
  const structured = {
    app_name: 'Test App',
    pid,
    window_id: windowId,
    window_title: title,
    window_bounds: { ...bounds },
    snapshot_id: 's00000001',
    elements: cloneElements(elements),
    total_element_count: elements.length,
    returned_element_count: elements.length,
    truncated,
  }
  if (truncationReason !== undefined) structured.truncation_reason = truncationReason
  if (elementsComplete !== undefined) structured.elements_complete = elementsComplete
  if (includeScreenshot) {
    structured.screenshot_width = screenshot.width
    structured.screenshot_height = screenshot.height
    structured.screenshot_mime_type = 'image/png'
  }
  const result = { text: '', structured }
  if (includeScreenshot) result.image = image
  return result
}

function desktopStateResult() {
  return {
    text: '',
    image: PNG,
    structured: {
      display: 'primary',
      screen_width: BOUNDS.width,
      screen_height: BOUNDS.height,
      screenshot_width: SCREENSHOT.width,
      screenshot_height: SCREENSHOT.height,
    },
  }
}

function createFakeBackend({ windows = [{ ...WINDOW }], elements = BASE_ELEMENTS, getWindowState, getDesktopState } = {}) {
  const calls = []
  return {
    calls,
    async listWindows(args) {
      calls.push({ name: 'list_windows', args })
      return { text: '', structured: { windows } }
    },
    async getWindowState(args) {
      calls.push({ name: 'get_window_state', args: { ...args } })
      if (getWindowState) return getWindowState(args, calls)
      const rows = args.query !== undefined ? projectQuery(elements, args.query) : elements
      return windowStateResult({
        elements: rows,
        includeScreenshot: args.includeScreenshot !== false,
      })
    },
    async getDesktopState(args) {
      calls.push({ name: 'get_desktop_state', args: { ...args } })
      if (getDesktopState) return getDesktopState(args, calls)
      return desktopStateResult()
    },
  }
}

function createObserverWith(backend, options = {}) {
  return createObserver({ backend, budgetMs: 5000, ttlMs: 60000, ...options })
}

test('createObserver validates the backend and numeric budgets', () => {
  const backend = createFakeBackend()

  assert.throws(() => createObserver(), /backend/)
  assert.throws(() => createObserver({}), /backend/)
  assert.throws(() => createObserver({ backend: {} }), /backend/)
  assert.throws(() => createObserver({ backend, maxElements: 0 }), /maxElements/)
  assert.throws(() => createObserver({ backend, maxImageDimension: 0 }), /maxImageDimension/)
  assert.throws(() => createObserver({ backend, ttlMs: 0 }), /ttlMs/)
  assert.throws(() => createObserver({ backend, budgetMs: -1 }), /budgetMs/)
  assert.throws(() => createObserver({ backend, now: 'later' }), /now/)
})

test('observing a window maps bounds, screenshot space and the element tree', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'both' })

  assert.deepEqual(backend.calls, [
    {
      name: 'get_window_state',
      args: {
        pid: PID,
        windowId: WINDOW_ID,
        includeScreenshot: true,
        treeFormat: 'elements',
        maxElements: 250,
        maxImageDimension: 1456,
      },
    },
  ])
  assert.equal(observation.pid, PID)
  assert.equal(observation.windowId, WINDOW_ID)
  assert.equal(observation.title, TITLE)
  assert.deepEqual(observation.bounds, BOUNDS)
  assert.deepEqual(observation.space, {
    width: 1456,
    height: 910,
    scaleX: 0.5056,
    scaleY: 0.5056,
  })
  assert.deepEqual(observation.tree, [
    {
      id: 's00000001:0',
      role: 'Window',
      label: TITLE,
      frame: { x: 0, y: 0, w: 2880, h: 1800 },
      actions: ['invoke'],
      enabled: true,
    },
    {
      id: 's00000001:1',
      role: 'Button',
      label: 'Save',
      frame: { x: 282, y: 644, w: 72, h: 38 },
      actions: ['invoke'],
      enabled: true,
    },
    {
      id: 's00000001:2',
      role: 'Button',
      label: 'Cancel',
      frame: { x: 400, y: 644, w: 72, h: 38 },
      actions: ['invoke'],
      enabled: false,
    },
    {
      id: 's00000001:3',
      role: 'Edit',
      label: 'Name',
      frame: { x: 282, y: 700, w: 200, h: 40 },
      actions: ['set_value'],
      enabled: true,
      value: 'hello',
    },
  ])
  assert.deepEqual(observation.screenshotPng, PNG)
  assert.equal(observation.truncated, false)
  assert.equal(typeof observation.revision, 'number')
  assert.equal(typeof observation.at, 'number')
})

test('toLocalPoint maps physical screen frames into screenshot pixels', () => {
  const observation = {
    bounds: { x: 100, y: 50, width: 2880, height: 1800 },
    space: { width: 1456, height: 910, scaleX: 0.5056, scaleY: 0.5056 },
  }

  assert.deepEqual(toLocalPoint({ x: 382, y: 694, w: 72, h: 38 }, observation), {
    x: 142.57,
    y: 325.58,
  })
  assert.deepEqual(toLocalPoint({ x: 100, y: 50 }, observation), { x: 0, y: 0 })
  assert.throws(() => toLocalPoint({ y: 1 }, observation), /frame/)
  assert.throws(() => toLocalPoint({ x: 1, y: 1 }, null), /observation/)
  assert.throws(
    () =>
      toLocalPoint(
        { x: 1, y: 1 },
        {
          bounds: { x: Number.NaN, y: 0, width: 100, height: 100 },
          space: { width: 50, height: 50 },
        },
      ),
    /bounds/,
  )
  assert.throws(
    () =>
      toLocalPoint(
        { x: 1, y: 1 },
        {
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          space: { width: 0, height: 50 },
        },
      ),
    /space/,
  )
})

test('tree mode requests no screenshot and derives the space from maxImageDimension', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend, { maxImageDimension: 720 })

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  assert.equal(backend.calls[0].args.includeScreenshot, false)
  assert.equal(backend.calls[0].args.maxImageDimension, 720)
  assert.equal('screenshotPng' in observation, false)
  assert.deepEqual(observation.space, { width: 720, height: 450, scaleX: 0.25, scaleY: 0.25 })
  assert.deepEqual(toLocalPoint({ x: 282, y: 644 }, observation), { x: 70.5, y: 161 })
})

test('both mode and the default mode include a screenshot, explicit false wins', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  const both = await observer.observe(WINDOW_TARGET, { mode: 'both' })
  assert.equal(backend.calls.at(-1).args.includeScreenshot, true)
  assert.deepEqual(both.screenshotPng, PNG)

  const byDefault = await observer.observe(WINDOW_TARGET)
  assert.equal(backend.calls.at(-1).args.includeScreenshot, true)
  assert.deepEqual(byDefault.screenshotPng, PNG)

  const disabled = await observer.observe(WINDOW_TARGET, { mode: 'both', includeScreenshot: false })
  assert.equal(backend.calls.at(-1).args.includeScreenshot, false)
  assert.equal('screenshotPng' in disabled, false)
})

test('query is forwarded and matching rows keep their ancestors', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree', query: 'save' })

  assert.equal(backend.calls[0].args.query, 'save')
  assert.deepEqual(
    observation.tree.map((element) => element.id),
    ['s00000001:0', 's00000001:1'],
  )
  assert.equal(observation.tree[0].label, TITLE)
  assert.equal(observation.tree[1].label, 'Save')
})

test('active target uses the foreground window and exposes it as focusedWindow', async () => {
  const windows = [
    {
      pid: 10,
      window_id: 11,
      title: 'Background',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      is_on_screen: true,
      z_index: 2,
    },
    {
      pid: 20,
      window_id: 22,
      title: 'Foreground',
      bounds: { x: 10, y: 20, width: 900, height: 700 },
      is_on_screen: true,
      z_index: 3,
      is_foreground: true,
    },
  ]
  const backend = createFakeBackend({
    windows,
    getWindowState: (args) =>
      windowStateResult({
        pid: args.pid,
        windowId: args.windowId,
        title: 'Foreground',
        bounds: { x: 10, y: 20, width: 900, height: 700 },
        includeScreenshot: false,
      }),
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe({ kind: 'active' }, { mode: 'tree' })

  assert.deepEqual(backend.calls[0], { name: 'list_windows', args: undefined })
  assert.equal(backend.calls[1].args.pid, 20)
  assert.equal(backend.calls[1].args.windowId, 22)
  assert.equal(observation.pid, 20)
  assert.equal(observation.windowId, 22)
  assert.equal(observation.title, 'Foreground')
  assert.deepEqual(observation.focusedWindow, { pid: 20, windowId: 22, title: 'Foreground' })
  assert.deepEqual(observation.bounds, { x: 10, y: 20, width: 900, height: 700 })
})

test('active target falls back to the frontmost on-screen window', async () => {
  const windows = [
    { pid: 1, window_id: 1, title: 'Back', bounds: BOUNDS, is_on_screen: true, z_index: 2 },
    { pid: 2, window_id: 2, title: 'Front', bounds: BOUNDS, is_on_screen: true, z_index: 9 },
    { pid: 3, window_id: 3, title: 'Off-screen', is_on_screen: false, z_index: 99 },
  ]
  const backend = createFakeBackend({
    windows,
    getWindowState: (args) =>
      windowStateResult({ pid: args.pid, windowId: args.windowId, title: 'Front', includeScreenshot: false }),
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe({ kind: 'active' }, { mode: 'tree' })

  assert.equal(observation.pid, 2)
  assert.equal(observation.windowId, 2)
})

test('active target with no on-screen window throws a readable error', async () => {
  const backend = createFakeBackend({ windows: [] })
  const observer = createObserverWith(backend)

  await assert.rejects(observer.observe({ kind: 'active' }), /active window/)
})

test('active target throws when no on-screen window reports z_index or a foreground flag', async () => {
  const windows = [
    { pid: 1, window_id: 1, title: 'First', bounds: BOUNDS, is_on_screen: true },
    { pid: 2, window_id: 2, title: 'Second', bounds: BOUNDS, is_on_screen: true },
  ]
  const backend = createFakeBackend({ windows })
  const observer = createObserverWith(backend)

  await assert.rejects(
    observer.observe({ kind: 'active' }, { mode: 'tree' }),
    /无法确定活动窗口：请显式传 pid\/windowId（或先 bring_to_front）/,
  )
  assert.equal(backend.calls.some((call) => call.name === 'get_window_state'), false)
})

test('active target prefers an on-screen foreground window over a higher z_index', async () => {
  const windows = [
    { pid: 1, window_id: 1, title: 'Stacked higher', bounds: BOUNDS, is_on_screen: true, z_index: 9 },
    {
      pid: 2,
      window_id: 2,
      title: 'Focused',
      bounds: BOUNDS,
      is_on_screen: true,
      z_index: 2,
      is_foreground: true,
    },
  ]
  const backend = createFakeBackend({
    windows,
    getWindowState: (args) =>
      windowStateResult({ pid: args.pid, windowId: args.windowId, title: 'Focused', includeScreenshot: false }),
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe({ kind: 'active' }, { mode: 'tree' })

  assert.equal(observation.pid, 2)
  assert.equal(observation.windowId, 2)
})

test('active target ignores minimized or off-screen foreground windows', async () => {
  const windows = [
    {
      pid: 1,
      window_id: 1,
      title: 'Minimized foreground',
      bounds: BOUNDS,
      is_on_screen: true,
      minimized: true,
      is_foreground: true,
      z_index: 100,
    },
    {
      pid: 3,
      window_id: 3,
      title: 'Off-screen foreground',
      bounds: BOUNDS,
      is_on_screen: false,
      is_foreground: true,
      z_index: 100,
    },
    { pid: 2, window_id: 2, title: 'Visible', bounds: BOUNDS, is_on_screen: true, z_index: 5 },
  ]
  const backend = createFakeBackend({
    windows,
    getWindowState: (args) =>
      windowStateResult({ pid: args.pid, windowId: args.windowId, title: 'Visible', includeScreenshot: false }),
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe({ kind: 'active' }, { mode: 'tree' })

  assert.equal(observation.pid, 2)
  assert.equal(observation.windowId, 2)
})

test('screen target uses desktop bounds and the desktop screenshot space', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  const observation = await observer.observe({ kind: 'screen' }, { mode: 'both' })

  assert.deepEqual(backend.calls, [
    { name: 'get_desktop_state', args: { maxImageDimension: 1456 } },
  ])
  assert.equal(observation.pid, null)
  assert.equal(observation.windowId, null)
  assert.equal(observation.title, 'Desktop')
  assert.deepEqual(observation.bounds, BOUNDS)
  assert.deepEqual(observation.space, {
    width: 1456,
    height: 910,
    scaleX: 0.5056,
    scaleY: 0.5056,
  })
  assert.deepEqual(observation.tree, [])
  assert.deepEqual(observation.screenshotPng, PNG)
})

test('screen target validates the display index', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  const observation = await observer.observe({ kind: 'screen', index: 0 }, { mode: 'tree' })
  assert.equal(observation.title, 'Desktop')

  await assert.rejects(observer.observe({ kind: 'screen', index: 1 }), /screen|display|index/)
  await assert.rejects(observer.observe({ kind: 'screen', index: -1 }), /screen|display|index/)
})

test('get returns cached observations until ttlMs expires', async () => {
  let clock = 1000
  const backend = createFakeBackend()
  const observer = createObserverWith(backend, {
    ttlMs: 1000,
    now: () => clock,
  })

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree' })
  const revision = observation.revision

  clock = 1500
  assert.equal(observer.get(revision), observation)

  clock = 2001
  assert.throws(() => observer.get(revision), /expired/)
  assert.throws(() => observer.get(revision), /unknown/i)
  assert.throws(() => observer.get(123456), /unknown/i)
})

test('an observation over budgetMs is marked truncated with the budget reason', async () => {
  const backend = createFakeBackend({
    getWindowState: async () => {
      await delay(30)
      return windowStateResult({ includeScreenshot: false })
    },
  })
  const observer = createObserverWith(backend, { budgetMs: 5 })

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  assert.equal(observation.truncated, true)
  assert.equal(observation.truncationReason, 'budget')
})

test('driver truncation and its reason are preserved', async () => {
  const backend = createFakeBackend({
    getWindowState: () =>
      windowStateResult({
        includeScreenshot: false,
        truncated: true,
        truncationReason: 'node_budget',
      }),
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  assert.equal(observation.truncated, true)
  assert.equal(observation.truncationReason, 'node_budget')
})

test('elements_complete alone does not mark an observation truncated', async () => {
  const backend = createFakeBackend({
    getWindowState: () =>
      windowStateResult({
        includeScreenshot: false,
        truncated: false,
        elementsComplete: false,
      }),
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  assert.equal(observation.truncated, false)
  assert.equal('truncationReason' in observation, false)
})

test('resolveTarget resolves element ids, numeric indices and pixel points', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)
  const observation = await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  assert.deepEqual(resolveTarget(observation, { element: 's00000001:1' }), {
    element: observation.tree[1],
  })
  assert.deepEqual(resolveTarget(observation, { element: 2 }), {
    element: observation.tree[2],
  })
  assert.deepEqual(resolveTarget(observation, { x: 12, y: 34 }), { point: { x: 12, y: 34 } })

  assert.throws(() => resolveTarget(observation, null), /target/)
  assert.throws(() => resolveTarget(observation, {}), /target/)
  assert.throws(() => resolveTarget(observation, { element: 'missing' }), /element/)
  assert.throws(() => resolveTarget(observation, { x: '12', y: 34 }), /x|y|point/)
  assert.throws(() => resolveTarget(observation, { x: 12 }), /x|y|point/)
})

test('observe rejects invalid targets, modes and option types', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  await assert.rejects(observer.observe(), /target/)
  await assert.rejects(observer.observe({ kind: 'bogus' }), /target/)
  await assert.rejects(observer.observe({ kind: 'window', pid: '1', windowId: 2 }), /pid/)
  await assert.rejects(observer.observe({ kind: 'window', pid: 1, windowId: '2' }), /windowId/)
  await assert.rejects(observer.observe(WINDOW_TARGET, { mode: 'diff' }), /mode/)
  await assert.rejects(observer.observe(WINDOW_TARGET, { query: 42 }), /query/)
  await assert.rejects(observer.observe(WINDOW_TARGET, { includeScreenshot: 'yes' }), /includeScreenshot/)
  await assert.rejects(observer.observe(WINDOW_TARGET, { waitFor: 'soon' }), /waitFor/)
})

test('waitFor polls until text exists and reports the elapsed time', async () => {
  let polls = 0
  const backend = createFakeBackend({
    getWindowState: (args) => {
      polls += 1
      const elements = polls >= 3 ? [...BASE_ELEMENTS, DONE_ELEMENT] : BASE_ELEMENTS
      return windowStateResult({ elements, includeScreenshot: args.includeScreenshot !== false })
    },
  })
  const observer = createObserverWith(backend)
  await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  const result = await waitFor(observer, {
    condition: 'text_exists',
    text: 'Done',
    timeoutMs: 1000,
    intervalMs: 20,
  })

  assert.equal(result.matched, true)
  assert.ok(result.elapsedMs >= 10, `expected elapsed >= 10ms, got ${result.elapsedMs}`)
  assert.ok(result.observation.tree.some((element) => element.label === 'Done'))
})

test('waitFor returns matched false after the timeout', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)
  await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  const result = await waitFor(observer, {
    condition: 'text_exists',
    text: 'Never',
    timeoutMs: 40,
    intervalMs: 10,
  })

  assert.equal(result.matched, false)
  assert.ok(result.elapsedMs >= 30, `expected elapsed >= 30ms, got ${result.elapsedMs}`)
  assert.ok(result.observation.tree.length > 0)
})

test('waitFor validates the condition, text and timing arguments', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  await assert.rejects(waitFor(observer, { condition: 'nope', text: 'x' }), /condition/)
  await assert.rejects(waitFor(observer, { condition: 'text_exists' }), /text/)
  await assert.rejects(waitFor(observer, { condition: 'text_exists', text: '' }), /text/)
  await assert.rejects(waitFor(observer, { condition: 'active_window' }), /windowName|text/)
  await assert.rejects(
    waitFor(observer, { condition: 'text_exists', text: 'x', timeoutMs: 0 }),
    /timeoutMs/,
  )
  await assert.rejects(
    waitFor(observer, { condition: 'text_exists', text: 'x', timeoutMs: 120001 }),
    /timeoutMs/,
  )
  await assert.rejects(
    waitFor(observer, { condition: 'text_exists', text: 'x', intervalMs: 0 }),
    /intervalMs/,
  )
  await assert.rejects(
    waitFor(observer, { condition: 'text_exists', text: 'x', intervalMs: 5001 }),
    /intervalMs/,
  )
})

async function waitForFixture(options, { elements = BASE_ELEMENTS, ...observerOptions } = {}) {
  const backend = createFakeBackend({ elements })
  const observer = createObserverWith(backend, observerOptions)
  await observer.observe(WINDOW_TARGET, { mode: 'tree' })
  return waitFor(observer, { timeoutMs: 500, intervalMs: 20, ...options })
}

test('waitFor supports text_exists and active_window', async () => {
  const text = await waitForFixture({ condition: 'text_exists', text: 'Save' })
  assert.equal(text.matched, true)

  const active = await waitForFixture({ condition: 'active_window', windowName: 'edit' })
  assert.equal(active.matched, true)

  const notActive = await waitForFixture({
    condition: 'active_window',
    windowName: 'notepad',
    timeoutMs: 20,
  })
  assert.equal(notActive.matched, false)
})

test('active_window polls the foreground window instead of the last observed window', async () => {
  const backend = createFakeBackend({
    windows: [
      {
        pid: 2,
        window_id: 22,
        title: 'Notepad',
        bounds: BOUNDS,
        is_on_screen: true,
        z_index: 3,
      },
    ],
    getWindowState: (args) =>
      windowStateResult({
        pid: args.pid,
        windowId: args.windowId,
        title: args.pid === 2 ? 'Notepad' : 'Background',
        includeScreenshot: false,
      }),
  })
  const observer = createObserverWith(backend)
  await observer.observe(WINDOW_TARGET, { mode: 'tree' })

  const result = await waitFor(observer, {
    condition: 'active_window',
    windowName: 'Notepad',
    timeoutMs: 100,
    intervalMs: 20,
  })

  assert.equal(result.matched, true)
  assert.equal(result.observation.pid, 2)
})

test('waitFor supports element_exists and element_enabled', async () => {
  const exists = await waitForFixture({ condition: 'element_exists', text: 'Save' })
  assert.equal(exists.matched, true)

  const enabled = await waitForFixture({ condition: 'element_enabled', text: 'Save' })
  assert.equal(enabled.matched, true)

  const disabled = await waitForFixture({
    condition: 'element_enabled',
    text: 'Cancel',
    timeoutMs: 20,
  })
  assert.equal(disabled.matched, false)

  const missingEnabled = cloneElements(BASE_ELEMENTS)
  delete missingEnabled[1].enabled
  const unknown = await waitForFixture(
    { condition: 'element_enabled', text: 'Save', timeoutMs: 20 },
    { elements: missingEnabled },
  )
  assert.equal(unknown.matched, false)
})

test('waitFor supports focused_element', async () => {
  const elements = cloneElements(BASE_ELEMENTS)
  elements[1] = { ...elements[1], focused: true }

  const focused = await waitForFixture(
    { condition: 'focused_element', text: 'Save' },
    { elements },
  )
  assert.equal(focused.matched, true)

  const wrongText = await waitForFixture(
    { condition: 'focused_element', text: 'Cancel', timeoutMs: 20 },
    { elements },
  )
  assert.equal(wrongText.matched, false)
})

test('observe can wait internally and reports the wait result', async () => {
  let polls = 0
  const backend = createFakeBackend({
    getWindowState: (args) => {
      polls += 1
      const elements = polls >= 2 ? [...BASE_ELEMENTS, DONE_ELEMENT] : BASE_ELEMENTS
      return windowStateResult({ elements, includeScreenshot: args.includeScreenshot !== false })
    },
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, {
    mode: 'tree',
    waitFor: { condition: 'text_exists', text: 'Done', timeoutMs: 500, intervalMs: 20 },
  })

  assert.equal(observation.waitFor.matched, true)
  assert.ok(observation.tree.some((element) => element.label === 'Done'))
})

test('observe with waitFor returns a final observation with the caller options', async () => {
  let calls = 0
  const backend = createFakeBackend({
    getWindowState: (args) => {
      calls += 1
      const elements = calls >= 2 ? [...BASE_ELEMENTS, DONE_ELEMENT] : BASE_ELEMENTS
      return windowStateResult({
        elements: args.query !== undefined ? projectQuery(elements, args.query) : elements,
        includeScreenshot: args.includeScreenshot !== false,
      })
    },
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, {
    mode: 'both',
    waitFor: { condition: 'text_exists', text: 'Done', timeoutMs: 500, intervalMs: 20 },
  })

  assert.equal(observation.waitFor.matched, true)
  assert.deepEqual(observation.screenshotPng, PNG)
  assert.equal(backend.calls[0].args.includeScreenshot, true)
  assert.equal(backend.calls.at(-1).args.includeScreenshot, true)
  assert.ok(backend.calls.slice(1, -1).some((call) => call.args.includeScreenshot === false))
  assert.equal(backend.calls.at(-1).args.query, undefined)
})

test('observe with waitFor forwards query on the initial, poll and final observations', async () => {
  let calls = 0
  const backend = createFakeBackend({
    getWindowState: (args) => {
      calls += 1
      const elements = calls >= 3 ? [...BASE_ELEMENTS, DONE_ELEMENT] : BASE_ELEMENTS
      return windowStateResult({
        elements: args.query !== undefined ? projectQuery(elements, args.query) : elements,
        includeScreenshot: args.includeScreenshot !== false,
      })
    },
  })
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, {
    mode: 'both',
    query: 'done',
    waitFor: { condition: 'text_exists', text: 'Done', timeoutMs: 500, intervalMs: 20 },
  })

  assert.equal(observation.waitFor.matched, true)
  assert.ok(backend.calls.every((call) => call.args.query === 'done'))
  assert.equal(backend.calls[0].args.includeScreenshot, true)
  assert.equal(backend.calls.at(-1).args.includeScreenshot, true)
  assert.ok(backend.calls.slice(1, -1).some((call) => call.args.includeScreenshot === false))
  assert.deepEqual(
    observation.tree.map((element) => element.label),
    [TITLE, 'Done'],
  )
  assert.deepEqual(observation.screenshotPng, PNG)
})

test('observe with an already-matched waitFor condition does not poll', async () => {
  const backend = createFakeBackend()
  const observer = createObserverWith(backend)

  const observation = await observer.observe(WINDOW_TARGET, {
    mode: 'both',
    query: 'save',
    waitFor: { condition: 'text_exists', text: 'Save', timeoutMs: 500, intervalMs: 20 },
  })

  assert.equal(backend.calls.length, 1)
  assert.equal(backend.calls[0].args.includeScreenshot, true)
  assert.equal(backend.calls[0].args.query, 'save')
  assert.equal(observation.waitFor.matched, true)
  assert.equal(typeof observation.waitFor.elapsedMs, 'number')
  assert.deepEqual(observation.screenshotPng, PNG)
  assert.deepEqual(
    observation.tree.map((element) => element.label),
    [TITLE, 'Save'],
  )
})
