# 验证记录（2026-10-19）

环境：Windows · DeepSeek Harness Desktop `0.2.1-rc.2` · cua-driver `0.20.0`（daemon 运行中，屏幕 2880×1800@2x）

## 1. 静态与单元测试

```
node --check index.js && node --check lib/*.js   → OK
node --test tests/*.test.mjs                     → 40 pass / 0 fail
```

覆盖：CUA 会话自愈、动作快照/过期拒绝、前台重试审批、按键路由、图片 renderer、resolveBin、
package manifest（peers `dsh-tools 0.2.1-rc.2` / `schemastery 3.18.5`、`engines.dsh >=0.2.1-rc.2 <0.3.0`）、
AX 快照下坐标动作拒绝。

## 2. DSH 0.2.1 模块/schema 验证（scratch profile，未动用户配置）

用独立 scratch `DSH_HOME` + `cu-test`（web 模板）+ 插件链接进该 profile `node_modules`：

- `--dump-config` 合成成功（exit 0），输出含 `- id: cu-import-probe / name: dsh-computer-use`。
- `--dump-config-schema` 成功 import 插件模块：`$defs.config100` 出现插件 Config schema（`ttlMs default 30000` 等），证明 `@deepseek-ai/dsh-tools 0.2.1-rc.2` + `schemastery 3.18.5` 在 0.2.1 上可导入。
- 官方 `preset.patch.yml` 单独合成成功（exit 0），输出含 `preset-computer-use`（plugins 21 行，含 `tool-computer-use`）。
- 基线（不带本插件）`--dump-config-schema` 也有同样的 4 条 `unrecognized Loader tree carrier` 警告 → 属于 web 模板既有 preset 行的 schema 投影限制，与本插件无关。

## 3. 真机端到端（插件 lib + cua-driver，不经过 DSH）

### 3.1 只读观察 `scripts/smoke.mjs`

```
窗口: DeepSeek Harness.exe · computer-use — DeepSeek Harness
pid=30568 window_id=198970 模式=ax
可见元素 24 个（树共 26/26，快照 s0000000a）
[0] Button "最小化" @(2651,40)
...
app_list: 10 个运行中应用
```

### 3.2 动作闭环 `scripts/smoke-action.mjs`

```
[launch]  Notepad aumid=Microsoft.WindowsNotepad_8wekyb3d8bbwe!App → pid=29876
[window]  pid=21144 window_id=11143204 title=无标题 - Notepad
[observe] ok=true elements=26
[target]  #0 role=Document "文本编辑器"
[type]    ok=true effect=confirmed route=accessibility evidence=value_readback
[verify]  text_in_ax=true doc={"role":"Document","value":"hello dsh 09:12:46"}
```

结论：截图观察、UIA 树、启动应用、点击（含对话框按钮）、ValuePattern 文本输入与回读验证全部可用。

## 4. 安装与实时组合

- `install.sh` 已执行：插件 junction/链接 → `profiles/desktop/node_modules/dsh-computer-use`；HOME patch 追加带标记的 `preset-computer-use`。
- 安装后运行中的 DSH 在 **17:13** 重新组合并写出 `profiles/desktop/cordis.yml`，其 1298 行起出现 `preset-computer-use`（id `computer-use`，含 `tool-computer-use → dsh-computer-use`）→ 运行中的 Host 已接受新配置（HMR）。
- YAML 结构校验：PyYAML 解析 HOME patch 成功；preset 21 个 plugin 行 id 无重复；宿主包引用全部存在于 `app.asar`（`@deepseek-ai/dsh-tool-subagent-control/list-agents` 为包内子路径导出）。

## 5. DSH 真机会话验证（已完成）

安装后无需重启：运行中的 DSH 在 17:13 由 HMR 重新组合（`profiles/desktop/cordis.yml` 出现 `preset-computer-use`）。
随后在新会话中选择 **Computer Use** 预设，模型成功调用插件工具：

- 会话标题：`App_list tool call request`，头部预设显示 **Computer Use**（AX 证据：`Text "Computer Use"`）。
- 用户提示：`Call the app_list tool right now...`
- 模型回复即 `app_list` 工具原始结果：
  `正在运行的应用（12 个）：- SnippingTool.exe [pid=8388] ... - DeepSeek Harness [pid=30568] ★活动 ...`
- 截图：`lead-scratch/dsh-result1.png`、`lead-scratch/dsh-e2e-app_list.png`。

结论：preset 在运行中的 Host 生效，`screen_observe / computer_click / app_list` 等工具已在 DSH 0.2.1-rc.2 会话中真实注册并执行。

## 6. AI 光标修复验证（0.4.1 / cua-driver 0.36.0，2026-10-19 21:00）

问题：用户反馈操作软件时没有独立 AI 光标，只有自己的鼠标。

根因：
1. cua-driver 0.20.0 过旧：`get_agent_cursor_state.position` 恒为 null、空闲/键盘动作不显示光标、滑行太快（上游 #4123/#4287/#5044 等修复都在 0.20 之后）。
2. 插件预设 `cursorTheme: ''`，且从不显式 `set_agent_cursor_enabled` / `set_agent_cursor_motion`；滑行失败被静默吞掉。
3. 插件把 AX 元素的**屏幕物理坐标**直接当窗口本地截图像素传给 `move_cursor`，缩放窗口（2880→1456）时光标被放错位置。

修复（0.4.1）：
- 升级 cua-driver 0.20.0 → **0.36.0**（官方 updater，0.20.0 保留可回滚）。
- 适配 0.36：`get_window_state` 显式 `tree_format:'elements'`；优先使用返回的 `window_bounds`。
- `ensureCursor()`：start_session 带 `cursor_theme: cua.default` + `set_agent_cursor_enabled(true)` + `set_agent_cursor_motion(idle_hide_ms:0, glide_duration_ms:600)`，点击/输入/按键/滚动前都会先滑到目标。
- 坐标换算：元素 frame（屏幕物理像素）→ 窗口本地截图像素（用 window_bounds + 截图尺寸/引擎 max_image_dimension 推算）。
- 预设 `cursorTheme: cua.default`；重复安装改为稳定副本 `~/.dsh/plugins/dsh-computer-use-0.4.1`。

验证：
- 0.36 下 `move_cursor` 后 `get_agent_cursor_state.position` 正确上报（如 `{x:142.6,y:325.6}`，对应屏幕 `(282,644)`），`visual_state.requested_action` 出现 `navigate`。
- 元素点击通过：`✅ Posted click on Chromium element [18] at screen (282,644)`。
- 插件 44 项单测全过；`smoke-action`（Notepad 输入 + UIA ValuePattern 回读）通过。
- **用户在屏幕上亲眼确认看到独立 AI 光标沿 S 形路线滑动**（2026-10-19 21:1x，使用 0.36.0）。
- 注：DSH 桌面端仍在运行旧进程（HMR 未重组预设），需重启桌面端后新会话才会加载 0.4.1 预设/代码；重启前可用独立脚本验证驱动层光标。

## 回滚

```bash
cd "B:\Data Center\Agent Program\Herness\computer-use-rebuild\plugin"
./uninstall.sh
```

或手工删除：
- `~/.dsh/profiles/desktop/node_modules/dsh-computer-use`
- `~/.dsh/cordis.patch.yml` 中 `# >>> dsh-computer-use` 至 `# <<< dsh-computer-use` 段
（安装前备份：`~/.dsh/cordis.patch.yml.bak-cu-20261019-171315`）
