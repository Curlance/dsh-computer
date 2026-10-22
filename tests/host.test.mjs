import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { createPlugin, register, resolveDriverCommand } from '../lib/host.js'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const IDLE_READY = async () => 60000

function config(dir, overrides = {}) {
  return normalizeConfig({ audit: { path: join(dir, 'audit.jsonl') }, ...overrides })
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-computer-host-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function windowState(image) {
  const state = {
    structured: {
      window_title: 'Notepad',
      pid: 100,
      window_id: 200,
      window_bounds: { x: 0, y: 0, width: 800, height: 600 },
      screenshot_width: 800,
      screenshot_height: 600,
      elements: [
        {
          element_token: 'e1',
          role: 'Button',
          label: 'Save',
          frame: { x: 10, y: 10, w: 20, h: 20 },
          actions: ['invoke'],
        },
      ],
    },
  }
  if (image !== undefined) state.image = image
  return state
}

function createBackend({ image } = {}) {
  const calls = []
  return {
    calls,
    async listWindows() {
      calls.push({ name: 'listWindows' })
      return {
        structured: {
          windows: [
            {
              pid: 100,
              window_id: 200,
              title: 'Notepad',
              is_foreground: true,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
            },
          ],
        },
      }
    },
    async getWindowState(args) {
      calls.push({ name: 'getWindowState', args })
      return windowState(args.includeScreenshot ? image : undefined)
    },
    async click(args) {
      calls.push({ name: 'click', args })
      return { structured: { effect: 'confirmed' } }
    },
  }
}

function createFactory(options = {}) {
  const state = { creates: 0, closes: 0 }
  const backend = createBackend(options)
  return {
    state,
    backend,
    async create() {
      state.creates += 1
      return {
        backend,
        close: async () => {
          state.closes += 1
        },
      }
    },
  }
}

function createCtx({ attachments, replies } = {}) {
  const tools = []
  const approvalRequests = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
    approval: {
      async request(request) {
        approvalRequests.push(request)
        const reply = typeof replies === 'function' ? replies(request) : replies
        return reply ?? 'allowed-once'
      },
    },
    get(name) {
      return name === 'attachments' ? attachments : undefined
    },
    logger: { info() {} },
    on() {},
  }
  return { ctx, tools, approvalRequests }
}

function registerTest(ctx, cfg, factory, overrides = {}) {
  return register(ctx, cfg, {
    defineTool: (tool) => tool,
    createBackend: factory.create,
    idleProvider: IDLE_READY,
    ...overrides,
  })
}

const OBSERVE = { action: 'observe', target: { kind: 'active' } }

test('register registers one computer tool without starting the backend', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()

  const handle = registerTest(ctx, config(dir), factory)

  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'computer')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 0)
  // buildComputerTool exposes the dsh-tools author DSL, not raw JSON Schema.
  assert.equal(tool.parameters.type, undefined)
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.parameters.action.required, true)
  assert.deepEqual(tool.parameters.action.enum, ['observe', 'act', 'session'])
  assert.deepEqual(tool.parameters.op.enum.slice(-5), [
    'status',
    'begin',
    'end',
    'takeover',
    'resume',
  ])
  assert.equal(tool.parameters.waitFor.additionalProperties, false)
  assert.equal(tool.parameters.waitFor.properties.condition.required, true)
  assert.equal(tool.parameters.steps.items.properties.op.required, true)
  assert.equal(tool.output.schema.properties.ok.type, 'boolean')
  assert.equal(tool.output.schema.properties.ok.required, true)
  assert.ok(tool.output.schema.properties.result.oneOf)
  assert.ok(tool.output.schema.properties.image)
  assert.equal(tool.output.schema.properties.code.type, 'string')
  assert.equal(tool.output.schema.properties.denied.type, 'boolean')
  assert.equal(tool.output.schema.properties.sessionId.type, 'string')
  assert.equal(tool.output.schema.properties.agentId.type, 'string')
  assert.equal(tool.output.schema.additionalProperties, false)
  assert.equal(typeof tool.output.render, 'function')
  // Lazy: registration must not touch the driver.
  assert.equal(factory.state.creates, 0)

  await handle.dispose()
})

test('the backend starts on the first execute and is reused afterwards', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  const first = await tools[0].execute(OBSERVE, { agent: { id: 'agent-1' } })
  assert.equal(first.ok, true)
  const second = await tools[0].execute(OBSERVE, { agent: { id: 'agent-1' } })
  assert.equal(second.ok, true)

  assert.equal(factory.state.creates, 1)
  assert.equal(factory.backend.calls.filter((call) => call.name === 'getWindowState').length, 2)

  await handle.dispose()
})

test('observe delegates to the backend and renders the tree', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  const result = await tools[0].execute(OBSERVE, {})

  assert.equal(result.ok, true)
  assert.match(result.result, /revision=1/)
  assert.match(result.result, /window="Notepad"/)
  assert.match(result.result, /\[e1\] Button "Save"/)
  assert.deepEqual(
    factory.backend.calls.map((call) => call.name),
    ['listWindows', 'getWindowState'],
  )

  await handle.dispose()
})

test('observe persists screenshots through the ctx attachments service', async () => {
  const dir = await tempDir(test)
  const factory = createFactory({ image: PNG })
  const saved = []
  const attachments = {
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: input.data.length,
        width: 800,
        height: 600,
        name: input.name,
      }
    },
  }
  const { ctx, tools } = createCtx({ attachments })
  const handle = registerTest(ctx, config(dir), factory)

  const result = await tools[0].execute({ ...OBSERVE, includeScreenshot: true }, {})

  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0].data, PNG)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(saved[0].name, 'screen.png')
  assert.equal(result.image.attachmentId, 'att-1')

  const blocks = tools[0].output.render({}, result)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att-1')

  await handle.dispose()
})

test('approval adapter forwards the executing agent to ctx.approval.request', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const agent = { id: 'agent-7' }
  const { ctx, tools, approvalRequests } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  const observed = await tools[0].execute(OBSERVE, { agent })
  assert.equal(observed.ok, true)

  const acted = await tools[0].execute(
    { action: 'act', target: { x: 10, y: 10 }, op: 'click' },
    { agent },
  )

  assert.equal(acted.ok, true)
  assert.equal(approvalRequests.length, 1)
  assert.equal(approvalRequests[0].toolName, 'computer')
  assert.equal(approvalRequests[0].agent, agent)
  assert.match(approvalRequests[0].reason, /high risk click/)
  assert.equal(factory.backend.calls.filter((call) => call.name === 'click').length, 1)

  await handle.dispose()
})

test('a denied approval never reaches the backend', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx({ replies: 'rejected' })
  const handle = registerTest(ctx, config(dir), factory)

  await tools[0].execute(OBSERVE, {})
  const acted = await tools[0].execute({ action: 'act', target: { x: 10, y: 10 }, op: 'click' }, {})

  assert.equal(acted.ok, false)
  assert.equal(acted.result.denied.reason, 'approval-denied')
  assert.equal(factory.backend.calls.filter((call) => call.name === 'click').length, 0)

  await handle.dispose()
})

test('a driver start failure returns an actionable error and is retried', async () => {
  const dir = await tempDir(test)
  let attempts = 0
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), {
    async create() {
      attempts += 1
      throw new Error('spawn cua-driver ENOENT')
    },
  })

  const first = await tools[0].execute(OBSERVE, {})
  assert.equal(first.ok, false)
  assert.match(first.result, /^✗ /)
  assert.match(first.result, /无法启动 cua-driver 后端/)
  assert.match(first.result, /ENOENT/)
  assert.match(first.result, /CUA_DRIVER_BIN/)

  const second = await tools[0].execute(OBSERVE, {})
  assert.equal(second.ok, false)
  assert.equal(attempts, 2)

  await handle.dispose()
})

test('dispose closes the started backend once and is idempotent', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  await tools[0].execute(OBSERVE, {})
  await handle.dispose()
  await handle.dispose()
  assert.equal(factory.state.closes, 1)

  const idle = createCtx()
  const idleFactory = createFactory()
  const idleHandle = registerTest(idle.ctx, config(dir), idleFactory)
  await idleHandle.dispose()
  assert.equal(idleFactory.state.closes, 0)
})

test('observe appends an audit record at the configured path', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  await tools[0].execute(OBSERVE, {})

  const lines = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.equal(entry.action, 'observe')
  assert.equal(entry.decision, 'allowed')
  assert.equal(entry.effect, 'confirmed')

  await handle.dispose()
})

test('createPlugin is the documented createPlugin({defineTool, ctx, config}) entry point', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()

  const handle = createPlugin({
    defineTool: (tool) => tool,
    ctx,
    config: config(dir),
    createBackend: factory.create,
    idleProvider: IDLE_READY,
  })

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'computer')
  await handle.dispose()
})

test('register validates the config before touching the host', async () => {
  const dir = await tempDir(test)
  const { ctx, tools } = createCtx()

  assert.throws(
    () => register(ctx, { approvals: { mode: 'bogus' }, audit: { path: join(dir, 'a.jsonl') } }),
    /Invalid approvals\.mode/,
  )
  assert.equal(tools.length, 0)
})

test('concurrent calls keep each call approval agent through serialized executions', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools, approvalRequests } = createCtx()
  const inner = ctx.approval.request
  ctx.approval.request = async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return inner(request)
  }
  const handle = registerTest(ctx, config(dir), factory)
  const agentA = { id: 'shared-agent', label: 'A' }
  const agentB = { id: 'shared-agent', label: 'B' }

  await tools[0].execute(OBSERVE, { agent: agentA })

  const [first, second] = await Promise.all([
    tools[0].execute({ action: 'act', op: 'click', target: { x: 10, y: 10 } }, { agent: agentA }),
    tools[0].execute({ action: 'act', op: 'click', target: { x: 10, y: 10 } }, { agent: agentB }),
  ])

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(approvalRequests.length, 2)
  assert.deepEqual(
    approvalRequests.map((request) => request.agent.label),
    ['A', 'B'],
  )

  await handle.dispose()
})

test('cursor.enabled=false skips cursor session setup entirely', async () => {
  const dir = await tempDir(test)

  async function run(enabled) {
    const calls = []
    const backend = createBackend()
    backend.startSession = async (options) => calls.push({ name: 'startSession', options })
    backend.setAgentCursorEnabled = async (value) =>
      calls.push({ name: 'setAgentCursorEnabled', value })
    backend.setAgentCursorMotion = async (options) =>
      calls.push({ name: 'setAgentCursorMotion', options })
    const { ctx, tools } = createCtx()
    const handle = registerTest(ctx, config(dir, { cursor: { enabled } }), {
      create: async () => ({ backend, close: async () => {} }),
    })

    const result = await tools[0].execute(OBSERVE, {})
    assert.equal(result.ok, true)
    await handle.dispose()
    return calls.map((call) => call.name)
  }

  assert.deepEqual(await run(false), [])
  assert.deepEqual(await run(true), [
    'startSession',
    'setAgentCursorEnabled',
    'setAgentCursorMotion',
  ])
})

test('host glides the cursor before a pointer action when cursor is enabled', async () => {
  const dir = await tempDir(test)
  const calls = []
  const backend = createBackend()
  backend.getCursorPosition = async () => ({ structured: { x: 0, y: 0 } })
  backend.moveCursor = async (args) => calls.push({ name: 'moveCursor', args })
  backend.click = async (args) => {
    calls.push({ name: 'click', args })
    return { structured: { effect: 'confirmed' } }
  }
  const factory = {
    async create() {
      return { backend, close: async () => {} }
    },
  }
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  assert.equal((await tools[0].execute(OBSERVE, {})).ok, true)
  const clicked = await tools[0].execute(
    { action: 'act', op: 'click', target: { element: 'e1' } },
    { agent: { id: 'agent-1' } },
  )
  assert.equal(clicked.ok, true)

  const moves = calls.filter((call) => call.name === 'moveCursor')
  const clickAt = calls.findIndex((call) => call.name === 'click')
  const firstMoveAt = calls.findIndex((call) => call.name === 'moveCursor')
  assert.ok(moves.length > 0, 'cursor did not move')
  assert.ok(firstMoveAt < clickAt, 'the glide must finish before the click')
  const landing = moves.at(-1)
  assert.equal(landing.args.x, 20)
  assert.equal(landing.args.y, 20)
  assert.equal(landing.args.target.pid, 100)
  assert.equal(landing.args.target.window_id, 200)

  await handle.dispose()
})

test('host results carry only declared keys and object results render as JSON', async () => {
  const dir = await tempDir(test)
  const factory = createFactory()
  const { ctx, tools } = createCtx()
  const handle = registerTest(ctx, config(dir), factory)

  await tools[0].execute({ action: 'session', op: 'begin' }, { agent: { id: 'agent-1' } })
  const refused = await tools[0].execute(
    { action: 'session', op: 'end' },
    { agent: { id: 'agent-2' } },
  )
  assert.deepEqual(Object.keys(refused).sort(), [
    'agentId',
    'code',
    'denied',
    'ok',
    'result',
    'sessionId',
  ])
  assert.equal(refused.denied, true)
  assert.equal(refused.code, 'busy')

  const status = await tools[0].execute({ action: 'session', op: 'status' }, {})
  assert.deepEqual(Object.keys(status).sort(), ['ok', 'result'])
  const blocks = tools[0].output.render({}, { ...status, extra: 'not-declared' })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[0].text, JSON.stringify(status.result))

  await handle.dispose()
})

test('resolveDriverCommand prefers CUA_DRIVER_BIN, then PATH, then install locations', () => {
  const exe = 'cua-driver.exe'
  const home = 'C:\\Users\\tester'

  assert.equal(
    resolveDriverCommand({
      platform: 'win32',
      env: { CUA_DRIVER_BIN: 'D:\\cua\\cua-driver.exe', PATH: '' },
      home,
      exists: () => false,
    }),
    'D:\\cua\\cua-driver.exe',
  )

  assert.equal(
    resolveDriverCommand({
      platform: 'win32',
      env: { PATH: 'C:\\tools' },
      home,
      exists: (path) => path === `C:\\tools\\${exe}`,
    }),
    `C:\\tools\\${exe}`,
  )

  const installed = `${home}\\.cua-driver\\packages\\current\\${exe}`
  assert.equal(
    resolveDriverCommand({
      platform: 'win32',
      env: { PATH: '' },
      home,
      exists: (path) => path === installed,
    }),
    installed,
  )

  assert.equal(
    resolveDriverCommand({ platform: 'win32', env: { PATH: '' }, home, exists: () => false }),
    'cua-driver',
  )
})
