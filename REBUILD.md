# 重建说明（DSH 0.2.1-rc.2）

本目录是 `dsh-computer-use` 的 **0.4.1 重建版**：保留 0.3.2 的工具面与安全护栏（MIT，原作者 988hj7tczd-oss），把它接回 **DeepSeek Harness Desktop 0.2.1-rc.2**，并把**独立 AI 光标**修好。

> 0.4.1 要求 **cua-driver ≥ 0.36.0**（0.20 的 agent cursor 不上报位置、动作时不显示，这是本机“只看到自己鼠标”的根因之一）。升级：`cua-driver update --apply`（0.20.0 会保留在 `~/.cua-driver/packages/releases/` 可回滚）。

## 为什么需要重建

2026-10-17 桌面端升级到 `0.2.1-rc.2` 后，旧包被版本门禁拒绝：

```
skipping profile bundle "dsh-computer-use":
Plugin dsh-computer-use@0.3.2 is incompatible with dsh 0.2.1-rc.2:
requirements {"@deepseek-ai/dsh-tools":">=0.1.2-rc.1 <0.2.0"}
```

随后 profile 里的 bundle / 预设被清理，会话里不再出现 `screen_observe` 等工具。cua-driver 本身正常（0.20.0，daemon 运行中）。

## 相对 0.3.2 的改动

- `engines.dsh` / peer 声明改为 `>=0.2.1-rc.2 <0.3.0`（host：`dsh-tools 0.2.1-rc.2`、`schemastery 3.18.5`）。
- 新增 `preset.patch.yml`：`Computer Use` 预设（0.2.1 standard 工具集 + `dsh-computer-use` 工具行 + computer-use persona 规则）。
- 默认观察目标改为**活动应用**的窗口（避免开始菜单/输入法覆盖层抢占）；观察文本补充截图尺寸。
- 坐标类动作（`click x/y`、`drag`）只接受**图片观察快照**（native/vision）；AX 快照下拒绝并提示，防止按 AX 屏幕坐标误点。
- `app_launch` 支持 Windows `aumid` / `path`（UWP 应用必须用 AUMID，例如 `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App`）。
- 密码框识别兼容 Windows UIA role（含 `password` 即视为敏感）。
- 图片 renderer 拆到 `lib/render.js`，测试不再依赖宿主包。

## 0.4.1：独立 AI 光标修复

- 适配 **cua-driver 0.36.0**：`get_window_state` 显式 `tree_format:'elements'`；使用返回的 `window_bounds`。
- `ensureCursor()`：`start_session(cursor_theme=cua.default)` + `set_agent_cursor_enabled(true)` + `set_agent_cursor_motion(idle_hide_ms:0, glide_duration_ms:600)`；点击/输入/按键/滚动前都会先把 AI 光标滑到目标。
- **坐标换算修复**：AX 元素 frame 是屏幕物理像素，先按 `window_bounds` 与截图尺寸（`max_image_dimension` 推算）换算成窗口本地截图像素，再驱动 `move_cursor` / 像素点击。此前直接传屏幕坐标，缩放窗口下 AI 光标会被放错甚至不可见。
- 预设默认 `cursorTheme: cua.default`；滑行失败不再静默吞掉（`cuaCall` 会 revive 会话）。
- 测试增至 44 项（新增坐标换算、快照空间拒绝等）。

## 安装（不改 profile 配置文件）

本机已安装到的稳定副本：`C:\Users\b1778\.dsh\plugins\dsh-computer-use-0.4.1`（profile `node_modules` 链接指向它）。
从工作区重新安装：

```bash
cd computer-use-rebuild/plugin
./install.sh --dry-run   # 预演
./install.sh             # 链接插件到 profile node_modules + 追加 HOME 层 preset
```

> 注意：install.sh 链接的是**运行它的目录**。长期使用建议先把插件目录复制到 `~/.dsh/plugins/dsh-computer-use-0.4.1`，再从该副本运行 install.sh。

- 只写两处：
  1. `~/.dsh/profiles/desktop/node_modules/dsh-computer-use`（junction/链接）
  2. `~/.dsh/cordis.patch.yml` 中带 `>>> dsh-computer-use` / `<<< dsh-computer-use` 标记的一段
- 不修改 `profiles/desktop/package.json`、`profiles/desktop/cordis.patch.yml`。

安装后 **重启 DeepSeek Harness 桌面端**，新建会话选择 **Computer Use** 预设。

## 验证

静态/单元：

```bash
node --check index.js
node --test tests/*.test.mjs     # 44 项
```

真机（不经过 DSH，直接调插件 lib + cua-driver）：

```bash
node scripts/smoke.mjs           # 只读：观察活动窗口 + app_list
node scripts/smoke-action.mjs    # 动作：启动记事本 → AX 观察 → 输入 → ValuePattern 回读验证
```

2026-10-19 本机实测：

- `screen_observe`：DeepSeek Harness 窗口 26 个 UIA 元素，快照 `s0000000a`。
- `smoke-action`：Notepad `type_text` 返回 `effect: confirmed / accessibility / value_readback`，AX value = `hello dsh 09:12:46`。

## 卸载

```bash
./uninstall.sh
```

移除链接与 HOME patch 中带标记的一段；重启后 Computer Use 预设消失。

## 已知限制

- 无图片能力的模型只能走 AX 文本模式；`computer_drag` 与坐标点击需要 `mode="native"` 观察（视觉模型）。
- Chromium/Electron 应用的后台投递可能返回 `background_unavailable`；插件会按审批流程提示前台重试（可能切换焦点）。
- `screen_zoom` / native 模式依赖 DSH attachments 服务与图片输入模型；文本模型下自动降级。
