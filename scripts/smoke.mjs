#!/usr/bin/env node
/**
 * smoke.mjs —— 插件逻辑 + cua-driver 真机冒烟（不经过 DSH）。
 *
 * 只读模式：观察最前窗口（AX 树）+ 列出运行中的应用。
 * 用法: node scripts/smoke.mjs [--readonly]
 */
import { screenObserve } from '../lib/observe.js'
import { listApps } from '../lib/actions.js'
import { resolveBin } from '../lib/cua.js'

const cfg = {
  ttlMs: 60000,
  maxElements: 40,
  allowedApps: [],
  cursorTheme: '',
  nativeImage: 'auto',
  visionProvider: 'deepseek-official',
  visionModel: 'deepseek-v4-flash-vision-exp',
}
// 只读冒烟不依赖 attachments/llm：ax 模式在有元素时不使用它们。
const ctx = { get: () => undefined, logger: console }
const exec = { agent: { options: { provider: 'smoke', model: 'smoke' } } }

const bin = resolveBin()
console.log(`[1/3] cua-driver: ${bin}`)

const observed = await screenObserve(ctx, { mode: 'ax' }, cfg, exec)
console.log(`[2/3] screen_observe ok=${observed.ok} mode=${observed.mode} elements=${observed.elementCount ?? '?'}`)
console.log(String(observed.result || '').split('\n').slice(0, 12).join('\n'))

const apps = await listApps()
console.log(`[3/3] app_list ok=${apps.ok}`)
console.log(String(apps.result || '').split('\n').slice(0, 6).join('\n'))
