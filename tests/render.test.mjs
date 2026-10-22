import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_FIELD,
  persistImage,
  renderTree,
  renderWithImage,
} from '../lib/render.js'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')

function observation(overrides = {}) {
  return {
    revision: 7,
    pid: 100,
    windowId: 200,
    title: 'Editor',
    bounds: { x: 0, y: 0, width: 2880, height: 1800 },
    space: { width: 1456, height: 910, scaleX: 0.5056, scaleY: 0.5056 },
    tree: [],
    truncated: false,
    at: 1234,
    ...overrides,
  }
}

function element(overrides = {}) {
  return {
    id: 1,
    role: 'Button',
    label: 'Save',
    frame: { x: 0, y: 0, w: 100, h: 40 },
    actions: ['invoke'],
    ...overrides,
  }
}

test('renderTree renders a minimal header and element lines in tree order', () => {
  const observationWithTree = observation({
    tree: [
      element({ id: 1, role: 'Window', label: 'Editor', frame: { x: 0, y: 0, w: 2880, h: 1800 }, actions: [] }),
      element({
        id: 's00000001:1',
        role: 'Button',
        label: 'Save',
        frame: { x: 282, y: 644, w: 72, h: 38 },
        actions: ['invoke'],
      }),
      element({
        id: 3,
        role: 'Edit',
        label: 'Name',
        frame: { x: 282, y: 700, w: 200, h: 40 },
        actions: ['invoke', 'setValue'],
      }),
    ],
  })

  assert.equal(
    renderTree(observationWithTree),
    [
      'revision=7 window="Editor" space=1456x910',
      '[1] Window "Editor" @(728,455)',
      '[s00000001:1] Button "Save" @(161,335) invoke',
      '[3] Edit "Name" @(193,364) invoke,setValue',
    ].join('\n'),
  )
})

test('renderTree omits empty label, missing frame and empty actions without leaving gaps', () => {
  const result = renderTree(
    observation({
      tree: [
        element({ id: 1, role: 'Button', label: '', frame: null, actions: [] }),
        element({ id: 2, role: '', label: 'Untitled', frame: { x: 0, y: 0, w: 20, h: 10 }, actions: [] }),
      ],
    }),
  )

  assert.equal(
    result,
    [
      'revision=7 window="Editor" space=1456x910',
      '[1] Button',
      '[2] "Untitled" @(5,3)',
    ].join('\n'),
  )
})

test('renderTree truncates beyond maxElements and states the total', () => {
  const tree = Array.from({ length: 5 }, (_, index) =>
    element({ id: index + 1, label: `B${index + 1}`, frame: null }),
  )

  assert.equal(
    renderTree(observation({ tree }), { maxElements: 2 }),
    [
      'revision=7 window="Editor" space=1456x910',
      '[1] Button "B1" invoke',
      '[2] Button "B2" invoke',
      '... 截断（共 5 个，显示 2 个）',
    ].join('\n'),
  )
})

test('renderTree marks an empty tree', () => {
  assert.equal(
    renderTree(observation()),
    ['revision=7 window="Editor" space=1456x910', '(无可交互元素)'].join('\n'),
  )
})

test('renderTree renders at most 250 elements by default', () => {
  const tree = Array.from({ length: 251 }, (_, index) => element({ id: index + 1, frame: null }))
  const lines = renderTree(observation({ tree })).split('\n')

  assert.equal(lines.length, 1 + 250 + 1)
  assert.equal(lines[1], '[1] Button "Save" invoke')
  assert.equal(lines[250], '[250] Button "Save" invoke')
  assert.equal(lines.at(-1), '... 截断（共 251 个，显示 250 个）')
})

test('renderTree notes driver truncation even when the tree fits the limit', () => {
  const tree = Array.from({ length: 250 }, (_, index) => element({ id: index + 1, frame: null }))
  const lines = renderTree(
    observation({ tree, truncated: true, truncationReason: 'budget' }),
  ).split('\n')

  assert.equal(lines.length, 1 + 250 + 1)
  assert.equal(lines.at(-1), '... 观察被截断（原因: budget，显示 250 个）')
})

test('renderTree notes driver truncation below the limit and defaults the reason', () => {
  const lines = renderTree(
    observation({ tree: [element({ id: 1, frame: null })], truncated: true }),
  ).split('\n')

  assert.equal(lines.at(-1), '... 观察被截断（原因: driver，显示 1 个）')
  assert.equal(
    renderTree(observation({ tree: [], truncated: true })).split('\n').at(-1),
    '... 观察被截断（原因: driver，显示 0 个）',
  )
})

test('renderTree reports the render slice and driver truncation separately', () => {
  const tree = Array.from({ length: 5 }, (_, index) => element({ id: index + 1, frame: null }))
  const lines = renderTree(
    observation({ tree, truncated: true, truncationReason: 'budget' }),
    { maxElements: 2 },
  ).split('\n')

  assert.deepEqual(lines.slice(-2), [
    '... 截断（共 5 个，显示 2 个）',
    '... 观察被截断（原因: budget，显示 2 个）',
  ])
})

test('renderTree escapes quotes and backslashes in labels and titles', () => {
  const result = renderTree(
    observation({
      title: 'say "hi"',
      tree: [
        element({ id: 1, role: 'Button', label: 'Say "hi"', frame: null, actions: [] }),
        element({ id: 2, role: 'Button', label: 'C:\\tmp\\', frame: null, actions: [] }),
      ],
    }),
  )

  assert.deepEqual(result.split('\n'), [
    'revision=7 window="say \\"hi\\"" space=1456x910',
    '[1] Button "Say \\"hi\\""',
    '[2] Button "C:\\\\tmp\\\\"',
  ])
})

test('renderTree collapses CR/LF in labels and titles to spaces', () => {
  const result = renderTree(
    observation({
      title: 'a\r\nb',
      tree: [element({ id: 1, label: 'one\ntwo\r\nthree', frame: null, actions: [] })],
    }),
  )

  assert.equal(
    result,
    ['revision=7 window="a b" space=1456x910', '[1] Button "one two three"'].join('\n'),
  )
  assert.equal(result.split('\n').length, 2)
})

test('renderTree replaces lone surrogates so the output stays well formed', () => {
  const result = renderTree(
    observation({
      title: 'A\uD800B',
      tree: [element({ id: 1, label: 'x\uDC00y', frame: null, actions: [] })],
    }),
  )

  assert.equal(
    result,
    ['revision=7 window="A\uFFFDB" space=1456x910', '[1] Button "x\uFFFDy"'].join('\n'),
  )
  assert.equal(result.isWellFormed(), true)
})

test('persistImage saves the observation screenshot and maps the attachment', async () => {
  const calls = []
  const attachments = {
    async saveImage(request) {
      calls.push(request)
      return { attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 1456, height: 910 }
    },
  }

  const field = await persistImage(attachments, observation({ screenshotPng: PNG }))

  assert.deepEqual(calls, [{ data: PNG, mediaType: 'image/png', name: 'screen.png' }])
  assert.deepEqual(field, {
    image: {
      attachmentId: 'att-1',
      mediaType: 'image/png',
      bytes: 8,
      width: 1456,
      height: 910,
      name: 'screen.png',
    },
  })
})

test('persistImage honours a custom attachment name', async () => {
  const calls = []
  const attachments = {
    async saveImage(request) {
      calls.push(request)
      return { attachmentId: 'att-2', mediaType: 'image/png', bytes: 8, width: 1456, height: 910 }
    },
  }

  const field = await persistImage(attachments, observation({ screenshotPng: PNG }), {
    name: 'window.png',
  })

  assert.equal(calls[0].name, 'window.png')
  assert.equal(field.image.name, 'window.png')
})

test('persistImage fills missing metadata from the observation', async () => {
  const attachments = { async saveImage() { return { attachmentId: 'att-3' } } }

  const field = await persistImage(attachments, observation({ screenshotPng: PNG }))

  assert.deepEqual(field, {
    image: {
      attachmentId: 'att-3',
      mediaType: 'image/png',
      bytes: PNG.length,
      width: 1456,
      height: 910,
      name: 'screen.png',
    },
  })
})

test('persistImage returns null without a screenshot and does not call saveImage', async () => {
  let calls = 0
  const attachments = { async saveImage() { calls += 1; return { attachmentId: 'unused' } } }

  assert.equal(await persistImage(attachments, observation()), null)
  assert.equal(calls, 0)
})

test('persistImage rejects a save result without attachmentId', async () => {
  const attachments = { async saveImage() { return { bytes: 8, width: 10, height: 10 } } }

  await assert.rejects(
    persistImage(attachments, observation({ screenshotPng: PNG })),
    /attachmentId/,
  )
})

test('persistImage rejects a missing attachments service', async () => {
  await assert.rejects(
    persistImage(undefined, observation({ screenshotPng: PNG })),
    /attachments/,
  )
})

test('IMAGE_FIELD describes the DSH tool result image field', () => {
  assert.equal(IMAGE_FIELD.image.type, 'object')
  assert.equal(IMAGE_FIELD.image.additionalProperties, false)
  assert.deepEqual(Object.keys(IMAGE_FIELD.image.properties), [
    'attachmentId',
    'mediaType',
    'bytes',
    'width',
    'height',
    'name',
  ])
  assert.equal(IMAGE_FIELD.image.properties.attachmentId.required, true)
  assert.equal(IMAGE_FIELD.image.properties.mediaType.required, true)
  assert.deepEqual(IMAGE_FIELD.image.properties.mediaType.enum, [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ])
  assert.equal(IMAGE_FIELD.image.properties.bytes.required, true)
  assert.equal(IMAGE_FIELD.image.properties.name.type, 'string')
})

test('renderWithImage returns a single text block without an image', () => {
  assert.deepEqual(renderWithImage({}, { result: 'text only' }), [
    { type: 'text', text: 'text only' },
  ])
})

test('renderWithImage appends an image attachment block', () => {
  const image = {
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 8,
    width: 1456,
    height: 910,
    name: 'screen.png',
  }

  assert.deepEqual(renderWithImage({}, { result: 'with image', image }), [
    { type: 'text', text: 'with image' },
    { type: 'image', attachment: image },
  ])
})

test('renderWithImage omits an absent optional name', () => {
  const image = { attachmentId: 'att-2', mediaType: 'image/png', bytes: 8, width: 10, height: 10 }

  assert.deepEqual(renderWithImage({}, { result: 'no name', image }), [
    { type: 'text', text: 'no name' },
    { type: 'image', attachment: image },
  ])
})
