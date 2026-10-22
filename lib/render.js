/**
 * render.js —— 观察结果的文本树与图片块渲染。
 *
 * 不依赖宿主包：图片持久化由调用方注入 attachments（`saveImage`），
 * 因此本模块可在纯 Node 测试里直接使用。
 */
import { toLocalPoint } from './observe.js'

const DEFAULT_MAX_ELEMENTS = 250
const DEFAULT_IMAGE_NAME = 'screen.png'

/**
 * DSH 工具结果 image schema 段（与已验证插件一致，供 defineTool output 复用）。
 */
export const IMAGE_FIELD = {
  image: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: {
        type: 'string',
        enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        required: true,
      },
      bytes: { type: 'integer', required: true },
      width: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      height: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      name: { type: 'string' },
    },
  },
}

/** 元素中心点映射到观察的截图空间；frame 或坐标空间缺失时省略。 */
function centerPoint(frame, observation) {
  if (frame === null || typeof frame !== 'object') return null
  if (
    observation.bounds === null ||
    typeof observation.bounds !== 'object' ||
    observation.space === null ||
    typeof observation.space !== 'object'
  ) {
    return null
  }
  const point = toLocalPoint({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }, observation)
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

/** `[id] role "label" @(x,y) actions`；空字段整段省略。 */
function renderLine(entry, observation) {
  const parts = [`[${entry.id}]`]
  if (typeof entry.role === 'string' && entry.role !== '') parts.push(entry.role)
  if (typeof entry.label === 'string' && entry.label !== '') parts.push(`"${entry.label}"`)
  const point = centerPoint(entry.frame, observation)
  if (point !== null) parts.push(`@(${point.x},${point.y})`)
  if (Array.isArray(entry.actions) && entry.actions.length > 0) parts.push(entry.actions.join(','))
  return parts.join(' ')
}

/**
 * 渲染观察的文本树。坐标是元素中心在截图空间中的像素，可直接用于像素动作。
 * @param {object} observation Task 10 的 Observation
 * @param {{maxElements?: number}} [options]
 * @returns {string}
 */
export function renderTree(observation, { maxElements = DEFAULT_MAX_ELEMENTS } = {}) {
  const tree = Array.isArray(observation.tree) ? observation.tree : []
  const shown = tree.slice(0, maxElements)
  const lines = [
    `revision=${observation.revision} window="${observation.title}" space=${observation.space.width}x${observation.space.height}`,
    ...shown.map((entry) => renderLine(entry, observation)),
  ]
  if (tree.length === 0) lines.push('(无可交互元素)')
  if (tree.length > maxElements) {
    lines.push(`... 截断（共 ${tree.length} 个，显示 ${shown.length} 个）`)
  }
  return lines.join('\n')
}

/**
 * 把观察里的截图持久化为 DSH attachment，返回工具结果 image 字段。
 * 没有截图时返回 null；saveImage 结果缺 attachmentId 时抛出可读错误。
 * @param {{saveImage: Function}} attachments
 * @param {object} observation
 * @param {{name?: string}} [options]
 * @returns {Promise<{image: object}|null>}
 */
export async function persistImage(attachments, observation, { name = DEFAULT_IMAGE_NAME } = {}) {
  const data = observation.screenshotPng
  if (data === undefined || data === null) return null
  if (
    attachments === null ||
    typeof attachments !== 'object' ||
    typeof attachments.saveImage !== 'function'
  ) {
    throw new Error('persistImage requires an attachments service with saveImage()')
  }

  const ref = await attachments.saveImage({ data, mediaType: 'image/png', name })
  if (
    ref === null ||
    typeof ref !== 'object' ||
    typeof ref.attachmentId !== 'string' ||
    ref.attachmentId === ''
  ) {
    throw new Error('attachments.saveImage returned no attachmentId; the screenshot was not persisted')
  }

  const space = observation.space ?? {}
  return {
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType ?? 'image/png',
      bytes: ref.bytes ?? data.length,
      width: ref.width ?? space.width,
      height: ref.height ?? space.height,
      name: ref.name ?? name,
    },
  }
}

/** 工具结果 render：文本块 +（有图时）图片块。 */
export function renderWithImage(_args, value) {
  if (!value.image) return [{ type: 'text', text: value.result }]
  return [
    { type: 'text', text: value.result },
    {
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
        ...(value.image.name === undefined ? {} : { name: value.image.name }),
      },
    },
  ]
}
