/**
 * render.js —— 图片块输出 schema 与 renderer（index.js 与测试共用）。
 *
 * 图片通过 DSH attachments 持久化后以 `{ type: 'image', attachment }` 内容块
 * 返回；模型支持 image 输入时可直接看图。拆出本文件是为了让
 * tests/observe-output.test.mjs 不必 import 宿主包（@deepseek-ai/dsh-tools）。
 */

/** 图片块输出 schema 段（native 直读工具共用）。 */
export const IMAGE_FIELD = {
  image: {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
      bytes: { type: 'integer', required: true },
      width: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      height: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      name: { type: 'string' },
    },
  },
}

/** render：值含 image 时追加图片块（主模型原生直读）。 */
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
        ...value.image.name === undefined ? {} : { name: value.image.name },
      },
    },
  ]
}
