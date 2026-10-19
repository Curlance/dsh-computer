import test from 'node:test'
import assert from 'node:assert/strict'

import { elementLocalPoint, windowCenter, windowLocalOf } from '../lib/human.js'

const snap = {
  windowBounds: { x: 100, y: 50, width: 2000, height: 1000 },
  screenshotWidth: 1000,
  screenshotHeight: 500,
  entries: new Map([[7, { x: 1100, y: 550, token: 't' }]]),
}

test('element screen pixels map into resized screenshot space', () => {
  assert.deepEqual(windowLocalOf(1100, 550, snap), { x: 500, y: 250 })
})

test('elementLocalPoint resolves an element center in screenshot space', () => {
  assert.deepEqual(elementLocalPoint(7, snap), { x: 500, y: 250 })
  assert.equal(elementLocalPoint(8, snap), null)
})

test('windowLocalOf falls back to identity without bounds or shot size', () => {
  assert.deepEqual(windowLocalOf(33, 44, { entries: new Map() }), { x: 33, y: 44 })
})

test('windowCenter is the middle of the screenshot', () => {
  assert.deepEqual(windowCenter(snap), { x: 500, y: 250 })
  assert.equal(windowCenter({}), null)
})
