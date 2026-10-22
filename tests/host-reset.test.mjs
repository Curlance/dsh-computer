import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { McpError } from '../lib/backend/mcp.js'
import { register } from '../lib/host.js'

const OBSERVE = { action: 'observe', target: { kind: 'active' } }

function windowState() {
  return {
    structured: {
      window_title: 'Editor',
      pid: 100,
      window_id: 200,
      window_bounds: { x: 0, y: 0, width: 200, height: 100 },
      screenshot_width: 200,
      screenshot_height: 100,
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
}

test('a dead driver is replaced on the next call instead of poisoning the tool', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-computer-reset-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const state = { creates: 0, closes: 0 }
  const factory = {
    async create() {
      state.creates += 1
      const failing = state.creates === 1
      const backend = {
        async listWindows() {
          return {
            structured: {
              windows: [
                {
                  pid: 100,
                  window_id: 200,
                  title: 'Editor',
                  is_foreground: true,
                  bounds: { x: 0, y: 0, width: 200, height: 100 },
                },
              ],
            },
          }
        },
        async getWindowState() {
          return windowState()
        },
        async click() {
          if (failing) throw new McpError('driver connection closed', { code: 'transport' })
          return { structured: { effect: 'confirmed' } }
        },
      }
      return {
        backend,
        close: async () => {
          state.closes += 1
        },
      }
    },
  }

  const tools = []
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    approval: { request: async () => 'allowed-once' },
    get: () => undefined,
    logger: { info() {} },
    on() {},
  }
  const handle = register(
    ctx,
    normalizeConfig({ audit: { path: join(dir, 'audit.jsonl') }, cursor: { enabled: false } }),
    { defineTool: (tool) => tool, createBackend: factory.create, idleProvider: async () => 60_000 },
  )

  const observed = await tools[0].execute(OBSERVE, { agentId: 'agent-1' })
  assert.equal(observed.ok, true)

  const failed = await tools[0].execute(
    { action: 'act', op: 'click', target: { element: 'e1' } },
    { agentId: 'agent-1' },
  )
  // The failed call may surface as a refusal or an unverifiable effect, but it
  // must not leave the dead backend cached.
  assert.ok(failed)
  assert.equal(state.creates, 1)

  const retried = await tools[0].execute(
    { action: 'act', op: 'click', target: { element: 'e1' } },
    { agentId: 'agent-1' },
  )
  assert.equal(retried.ok, true)
  assert.equal(state.creates, 2)
  assert.ok(state.closes >= 1)

  await handle.dispose()
})
