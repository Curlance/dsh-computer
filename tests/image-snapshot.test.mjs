import test from 'node:test'
import assert from 'node:assert/strict'

import { typeText, click, drag } from '../lib/actions.js'
import { clearSnapshot, setSnapshot } from '../lib/snapshot.js'

test('type without an element still requires a fresh snapshot', async () => {
  clearSnapshot()
  await assert.rejects(
    typeText({ text: 'safe test text' }, { ttlMs: 1000 }),
    /观察快照/,
  )
})

test('coordinate click is refused on an AX-only snapshot', async () => {
  setSnapshot({ at: Date.now(), ttlMs: 60000, pid: 1, windowId: 2, appName: 'x', entries: new Map(), mode: 'ax' })
  await assert.rejects(click({ x: 10, y: 10 }, { ttlMs: 60000 }), /mode="native"/)
  clearSnapshot()
})

test('coordinate drag is refused on an AX-only snapshot', async () => {
  setSnapshot({ at: Date.now(), ttlMs: 60000, pid: 1, windowId: 2, appName: 'x', entries: new Map(), mode: 'ax' })
  await assert.rejects(
    drag({ from_x: 1, from_y: 1, to_x: 2, to_y: 2 }, { ttlMs: 60000 }, { call: async () => ({}) }),
    /mode="native"/,
  )
  clearSnapshot()
})
