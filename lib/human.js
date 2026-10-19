/**
 * human.js —— 真人操作模块：独立 AI 光标（agent cursor overlay）+ 像素级点击。
 *
 * 坐标语义：
 *   - 模型看到的截图是窗口截图（可能被引擎缩放到 ≤1456px 宽）；
 *   - click / drag / move_cursor 的 x,y 是"窗口本地截图像素"（与模型看到的 PNG 同空间）；
 *   - AX 元素 frame 是屏幕物理像素，需要按窗口 bounds 与截图尺寸换算成截图像素。
 *
 * 所有动作前会确保 agent cursor 会话已启用并常显（idle_hide_ms=0），
 * 让用户看到独立 AI 光标滑向目标，而不是真实鼠标。
 */
import { cuaCall, CUA_SESSION, withSession } from './cua.js'
import { getSnapshot } from './snapshot.js'

/** 滑行段数（越多越平滑，真人手部轨迹感）。 */
const GLIDE_SEGMENTS = 5
/** 每段间隔 ms。 */
const GLIDE_STEP_MS = 60
/** 弧线高度（px，模拟人手弧线轨迹）。 */
const ARC_HEIGHT = 40

/**
 * 确保本会话的 AI 光标已创建、启用、常显。
 * 首次成功后缓存；失败会清空缓存以便下次重试。
 */
let cursorReady = null
export function ensureCursor(cfg = {}) {
  if (cursorReady) return cursorReady
  cursorReady = (async () => {
    await cuaCall('start_session', {
      session: CUA_SESSION,
      cursor_theme: { theme_id: cfg.cursorTheme || 'cua.default' },
    })
    await cuaCall('set_agent_cursor_enabled', { session: CUA_SESSION, enabled: true })
    await cuaCall('set_agent_cursor_motion', {
      session: CUA_SESSION,
      idle_hide_ms: 0,
      glide_duration_ms: 600,
      dwell_after_click_ms: 120,
    }).catch(() => undefined)
  })().catch(() => { cursorReady = null })
  return cursorReady
}

/**
 * 光标滑行：从当前位置平滑移动到目标（分段 + 弧线）。
 * 最佳努力：滑行失败不阻断点击；session 结束时 cuaCall 会自动 revive。
 * @param {number} tx - 目标 x（窗口本地截图像素）
 * @param {number} ty - 目标 y
 * @param {object} opts - { target, cursorId } 引擎目标
 */
export async function glideCursor(tx, ty, opts = {}) {
  const tryMove = (payload) => cuaCall('move_cursor', payload).catch(() => undefined)
  await ensureCursor()
  // 当前光标位置（拿不到就从目标点直线过去）
  let cur = null
  try {
    cur = await cuaCall('get_cursor_position', { session: CUA_SESSION })
  } catch { /* 无光标信息 → 直线 */ }
  const startX = cur?.x != null ? cur.x : tx
  const startY = cur?.y != null ? cur.y : ty

  for (let i = 1; i <= GLIDE_SEGMENTS; i++) {
    const t = i / GLIDE_SEGMENTS
    const x = startX + (tx - startX) * t
    // 弧线：中间点抬高（模拟人手画弧）
    const y = startY + (ty - startY) * t - Math.sin(t * Math.PI) * ARC_HEIGHT
    await tryMove(withSession({ x, y, ...opts }))
    await new Promise((r) => setTimeout(r, GLIDE_STEP_MS))
  }
  await tryMove(withSession({ x: tx, y: ty, ...opts }))
}

/**
 * 屏幕物理像素 → 窗口本地截图像素。
 * 元素 frame 来自 UIA（屏幕坐标），截图可能被引擎按 max_image_dimension 缩放。
 */
export function windowLocalOf(x, y, snap) {
  const b = snap?.windowBounds
  const sw = snap?.screenshotWidth
  const sh = snap?.screenshotHeight
  if (!b || !sw || !sh || !b.width || !b.height) return { x, y }
  return {
    x: (x - b.x) * sw / b.width,
    y: (y - b.y) * sh / b.height,
  }
}

/** 把 AI 光标移到窗口内某点（最佳努力，用于键盘类动作前的位置提示）。 */
export async function seedCursor(pid, windowId, x, y) {
  if (x == null || y == null) return
  await ensureCursor()
  await cuaCall('move_cursor', withSession({
    x, y, target: { kind: 'window', pid, window_id: windowId },
  })).catch(() => undefined)
}

/** 快照里某个 element 编号的中心点（窗口本地截图像素）。 */
export function elementLocalPoint(index, snap) {
  const entry = snap?.entries?.get(Number(index))
  if (!entry || entry.x == null || entry.y == null) return null
  return windowLocalOf(entry.x, entry.y, snap)
}

/** 快照窗口中心（窗口本地截图像素），用于没有 element 的键盘动作。 */
export function windowCenter(snap) {
  const sw = snap?.screenshotWidth
  const sh = snap?.screenshotHeight
  if (!sw || !sh) return null
  return { x: sw / 2, y: sh / 2 }
}

/**
 * 真人点击：AI 光标滑行到目标 + 点击。
 * element 模式（带 token）走引擎 AX 路径（element_token，精确定位）；
 * 坐标模式走像素路径（x/y = 窗口本地截图像素，模型直接可见的坐标）。
 * @param {object} opts - { pid, windowId, x, y, token, count, button }
 */
export async function humanClick(opts) {
  const { pid, windowId, x, y, token, count = 1, button = 'left' } = opts

  // 1. AI 光标滑行到目标（看得见过程）
  if (x != null && y != null) {
    await glideCursor(x, y, { target: { kind: 'window', pid, window_id: windowId } })
  }

  // 2. 点击：token 优先（AX 路径），否则像素路径（窗口本地截图像素）
  const payload = { session: CUA_SESSION, pid }
  if (token) {
    payload.element_token = token
    // token 路径同样透传计数/按钮，否则双击/右键会静默退化成单次左键
    payload.count = count
    payload.button = button
  } else {
    if (x == null || y == null) throw new Error('humanClick: 缺少点击坐标（x/y）。')
    payload.window_id = windowId
    payload.x = x
    payload.y = y
    payload.count = count
    payload.button = button
  }
  const value = await cuaCall('click', payload)
  return value
}

/** 快照辅助：解析编号 → token + 窗口本地坐标。 */
export function resolveClickTarget(index, ttlMs) {
  const snap = getSnapshot()
  if (!snap) throw new Error('没有可用的观察快照：请先调用 screen_observe。')
  const entry = snap.entries?.get(index)
  if (!entry) throw new Error(`编号 [${index}] 不在当前快照中。`)
  const local = windowLocalOf(entry.x, entry.y, snap)
  return {
    pid: snap.pid,
    windowId: snap.windowId,
    token: entry.token || null,
    x: local.x,
    y: local.y,
  }
}

/** 快照辅助：元素屏幕坐标。 */
export function screenPointOf(entry, _snap) {
  if (!entry || entry.x == null || entry.y == null) return null
  return { sx: entry.x, sy: entry.y }
}
