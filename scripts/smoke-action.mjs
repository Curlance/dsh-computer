#!/usr/bin/env node
/**
 * smoke-action.mjs —— 真机端到端冒烟：启动记事本 → AX 观察 → 输入 → 再观察验证。
 *
 * 仅用于本地验证插件逻辑与 cua-driver 链路；会短暂操作桌面（用户已授权）。
 * 用法: node scripts/smoke-action.mjs [--keep]
 */
import { screenObserve } from '../lib/observe.js'
import { click, typeText, launchApp } from '../lib/actions.js'
import { cuaCall } from '../lib/cua.js'

const keep = process.argv.includes('--keep')
const cfg = { ttlMs: 120000, maxElements: 200, allowedApps: [], cursorTheme: '', nativeImage: 'auto', visionProvider: 'deepseek-official', visionModel: 'deepseek-v4-flash-vision-exp' }
const ctx = { get: () => undefined, logger: console }
const exec = { agent: { options: { provider: 'smoke', model: 'smoke' } } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const findWin = async () => {
  const wins = await cuaCall('list_windows', { on_screen_only: true })
  return (wins.windows || []).find((w) => /记事本|Notepad/i.test(w.title || ''))
}
const observe = (pid) => screenObserve(ctx, { window: String(pid), mode: 'ax' }, cfg, exec)

const launched = await launchApp({ aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' })
console.log(`[launch] ok=${launched.ok} pid=${launched.pid}`)
await sleep(2500)

let win = await findWin()
if (!win) { console.log('!! 未找到记事本窗口'); process.exit(1) }
console.log(`[window] pid=${win.pid} window_id=${win.window_id} title=${win.title}`)

let obs = await observe(win.pid)
// 1) 关闭可能存在的模态错误对话框（例如不可用的恢复标签页）
for (let i = 0; i < 2; i++) {
  const btn = (obs.elements || []).find((e) => /button/i.test(e.role) && /^(确定|OK|关闭)$/i.test(e.label || ''))
  if (!btn) break
  const r = await click({ element: btn.index }, cfg)
  console.log(`[dialog] click #${btn.index} ${btn.label} -> ok=${r.ok}`)
  await sleep(500)
  obs = await observe(win.pid)
}
console.log(`[observe] ok=${obs.ok} elements=${obs.elementCount}`)
console.log(obs.result.split('\n').slice(0, 12).join('\n'))
if (!obs.ok) process.exit(1)

const pick = (obs.elements || []).find((e) => /document|edit/i.test(e.role || ''))
  || (obs.elements || []).find((e) => /text/i.test(e.role || ''))
if (!pick) { console.log('!! 没有可输入元素'); process.exit(1) }
console.log(`[target] #${pick.index} role=${pick.role} label=${JSON.stringify(pick.label)}`)

const text = `hello dsh ${new Date().toISOString().slice(11, 19)}`
const typed = await typeText({ text, element: pick.index }, cfg, {})
console.log(`[type] ok=${typed.ok} ${typed.result.slice(0, 220)}`)

await sleep(800)
const state = await cuaCall('get_window_state', { pid: win.pid, window_id: win.window_id, max_elements: 200 })
const doc = (state.elements || []).find((e) => /document|edit/i.test(e.role || ''))
const verified = JSON.stringify(doc || {}).includes(text) || String(state.tree_markdown || '').includes(text)
console.log(`[verify] text_in_ax=${verified} doc=${JSON.stringify(doc && { role: doc.role, value: String(doc.value || '').slice(0, 60) })}`)

if (!keep) console.log('[cleanup] 保持窗口不动（避免影响用户已打开的 Notepad 会话）')
process.exit(verified ? 0 : 2)
