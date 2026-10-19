# DSH Computer Use 复刻设计（评审稿）

日期：2026-10-19 · 作者：Lead（Team）· 状态：**已批准并实施（见 VERIFICATION.md）**

## 1. 问题与证据

- 用户目标：把 ChatGPT 的 computer-use 能力复刻到 DSH（Windows 全桌面操控）。
- 现状：会话里没有 `screen_observe/computer_click/app_list` 等工具。
- 直接原因（证据见 `dsh-diagnosis.md`）：
  - `profiles/desktop/package.json` 于 16:24 移除 `dsh-computer-use`；`cordis.patch.yml` 中原有的 `preset-computer-use` 被删。
  - 本会话 preset = `standard`，标准预设不含 computer-use 工具行。
- 根本原因：DSH 桌面端 2026-10-17 升级到 **0.2.1-rc.2**；旧插件 `dsh-computer-use@0.3.2` 的 peer 声明 `@deepseek-ai/dsh-tools >=0.1.2-rc.1 <0.2.0` 触发版本门禁 → bundle 被 skip、预设行被 disable。
- 后端能力正常：`cua-driver 0.20.0` 已安装，daemon 运行中，`doctor` 全 ok；屏幕 2880×1800@2x；UIA/截图/点击/输入/窗口/应用枚举均可用。

## 2. 目标 / 非目标

目标（v1）：
1. 一个可安装的 DSH bundle 插件，自带 **Computer Use** 预设；装好后会话里出现电脑操作工具。
2. 观察-动作循环对齐 ChatGPT：先看屏幕（截图），再点/输入/按键/滚动/拖拽，动作后立刻看到新的屏幕结果。
3. Windows 全桌面可用（任意应用），模型看不到图时自动降级为 UIA 控件树文本。
4. 可验证：静态 schema 验证 + 真机端到端冒烟；可回滚。

非目标：
- 云虚拟机、多显示器、macOS/Linux、远程桌面。
- 替代模型视觉能力；不保证所有 Chromium/Electron 后台输入都成功（失败时给出可重试的结构化错误）。
- 不做浏览器专用协议（先复用桌面能力）。

## 3. 方案

### 3.1 包与安装

- 新包 `dsh-computer-use@0.4.0`，位于 `computer-use-rebuild/plugin/`，MIT。
- `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`，peer `@deepseek-ai/dsh-tools` 同样对齐 0.2.1-rc.2；不新增第三方依赖（只用 node 内置 + cua-driver CLI）。
- `dsh.bundle.patch: cordis.patch.yml`：插入 `preset-computer-use`（0.2.1 standard 预设结构 + `tool-computer-use` 行），安装后新会话可直接选择 **Computer Use** 预设。
- 安装路径（二选一，均需用户批准）：
  - A（推荐）：放进 desktop profile（`package.json` 依赖 + `dsh.profile.bundles`，`pnpm install`），等价 plugin_manager 的 install_bundle；
  - B：不改 profile，改 `~/.dsh/cordis.patch.yml`（HOME 层，优先级更高）+ 把包 link 进 `profiles/desktop/node_modules`。
- 先备份 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`，提供一键回滚。

### 3.2 工具面（模型可见）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `screen_observe` | 看屏幕：全屏截图（PNG 图片块）+ 可见窗口清单；可选某窗口 UIA 元素树 | `window?` `mode?` `maxElements?` |
| `computer_click` | 点击 | `x,y`（桌面截图像素）或 `element`；`button` `count` |
| `computer_type` | 文本输入 | `text` `element?` |
| `computer_key` | 按键/组合键 | `key` `modifiers?` |
| `computer_scroll` | 滚动 | `direction` `amount?` `element?` |
| `computer_drag` | 拖拽 | `from_x,from_y,to_x,to_y` |
| `computer_wait` | 等待 | `ms` |
| `app_list` / `app_launch` | 应用枚举/启动 | `name/path` |
| `screen_zoom` | 局部放大看细节 | 区域坐标 |

约定：
- 坐标 = 最近一次 `screen_observe` 返回截图的像素坐标；插件内部换算到 cua-driver 屏幕坐标。
- 动作后自动再抓一帧并随结果返回（模型支持图片时），否则返回窗口/元素摘要。
- 动作前必须存在 ≤60s 的观察快照；过期拒绝并提示重新观察（防盲操作）。
- 失败返回结构化 `ok:false + 原因 + 建议`（如后台输入不可用 → 提示前台重试）。

### 3.3 模型能力适配

- 通过 `ctx.llm.resolveModelInfo(provider, model)` 判断当前模型是否声明 image 能力：
  - 支持：`screen_observe` 返回 PNG 图片块 + 简洁文本；动作后附图。
  - 不支持：返回 UIA 元素树（编号 + 角色 + 标签 + 坐标）+ 窗口清单，模型用 `element` 操作。
- 不引入外部视觉 API，不读用户凭据；密码框仅提示用户本人输入。

### 3.4 安全

- 快照 TTL 60s；无快照/过期拒绝动作。
- 默认后台投递（不抢焦点）；仅当驱动报 `background_unavailable` 时提示模型改用前台模式（由用户可见的光标动作，可能抢焦点）。
- 危险动作（删除/支付/发送）不禁止，但工具描述要求模型先向用户确认；这是模型侧约定，插件不做关键词拦截（避免误伤）。
- 不读取剪贴板、不记录屏幕内容到磁盘（截图只进会话附件，临时文件清理）。

## 4. 验证

1. **静态**：`node --check`；scratch profile 安装后 `--dump-config-schema` 能 import 模块并通过 schema 校验（需包已 link 进 profile 的 node_modules，见诊断 §9.3）。
2. **结构**：patch 插入的 preset 出现在配置树；工具行解析到插件包。
3. **端到端**（需用户配合）：
   - 新会话选 **Computer Use** 预设；
   - `screen_observe` 能看到桌面；
   - `app_launch` 打开记事本 → `screen_observe` 看到窗口；
   - 点击编辑区 → `computer_type("hello dsh")` → 再观察确认文本出现；
   - 报告实际耗时、失败重试情况。
4. **回滚**：恢复备份 → 重启 → 预设消失、原会话不受影响。

## 5. 交付物

- `computer-use-rebuild/plugin/`：插件源码 + bundle patch + README + 安装/卸载脚本。
- `computer-use-rebuild/chatgpt-analysis.md`：ChatGPT computer-use 逆向分析（另一队友）。
- `computer-use-rebuild/dsh-diagnosis.md`：本机诊断（已交付）。
- 安装与验证日志、回滚说明。

## 6. 风险

- DSH 0.2.1 预设结构/模块解析若与镜像确认不一致，需要 1-2 轮迭代。
- `deepseek-flash` 若不是视觉模型，首版体验以 UIA 文本为主，弱于 ChatGPT 的看图操作（可后续切视觉模型）。
- 安装需写 profile 并重启桌面端；重启会中断本会话（会话可恢复）。
- 后台输入在 Chromium/Electron 应用可能失败；首版以 Win32/UWP 应用验证为准。

## 7. 需要用户批准的动作

1. 写 `~/.dsh/profiles/desktop/package.json` / `cordis.patch.yml`（或 HOME 层 patch）与备份，把插件装进 desktop profile。
2. 重启 DeepSeek Harness 桌面端（如 HMR 能热加载则先不重启）。
3. 在新会话选择 Computer Use 预设做端到端冒烟（会短暂操作记事本，不碰敏感数据）。
