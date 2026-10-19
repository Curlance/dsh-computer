# DSH computer-use 诊断报告（为什么“不能用/不好用” + 可用插件所需机制）

- 诊断对象：`B:\APP 2.0\deepseek herness`（DeepSeek Harness Desktop 0.2.1-rc.2）+ 用户目录 `C:\Users\b1778\.dsh`
- 诊断时间：2026-10-19 16:53–17:1x（Asia/Shanghai）
- 本机工作目录：`B:\Data Center\Agent Program\Herness`
- 证据文件：本报告只引用只读观察、`dsh` CLI 只读命令，以及 `computer-use-rebuild/dsh-scratch/` 下的临时实验产物；未修改 `~/.dsh` 用户配置/插件，未安装全局包。

---

## 0. 结论（TL;DR）

**“现有 computer-use 不能用”不是 cua-driver 缺失，也不是没装插件源码，而是三层叠加：**

1. **直接原因（本会话确实没有工具）**：截至 2026-10-19 16:46，桌面 profile 里 **既没有 computer-use 插件包，也没有 Computer Use 预设**。
   - `profiles/desktop/package.json` 在 **16:24:15** 被改写，把 `dsh-computer-use`、`@dsh-external/dsh-normify` 从 `dsh.profile.bundles` 和 `dependencies` 中移除（与备份 diff 完全对应）；
   - `profiles/desktop/node_modules` 在 **16:25:35** 被 pnpm 剪枝（`node_modules/@deepseek-ai` 为空目录，`dsh-computer-use` 链接不存在）；
   - `profiles/desktop/cordis.patch.yml` 在 **16:46:48** 被改写为 1701 字节的设置层，其中**没有**原来的 `insert: preset-computer-use`（与 16:24 之前备份的 9395 字节版本 diff 可见整块 preset 消失）；
   - 本会话（16:43 创建）session 元数据是 `"agentPreset":"standard"`；标准预设不含任何 `screen_observe` / `computer_*` / `app_*` 工具行 → 工具列表自然为空。

2. **根本原因（为什么会被移除）**：**DSH 0.2.1-rc.2 的版本兼容门禁把旧插件拒之门外**。
   - 桌面端在 **2026-10-17 17:20** 更新到 `@deepseek-ai/dsh-desktop 0.2.1-rc.2`（Electron 44.7.0，内置 runtime `0.2.1-rc.2`、`@deepseek-ai/dsh-tools 0.2.1-rc.2`）。
   - 旧插件 `dsh-computer-use@0.3.2` 声明 `peerDependencies: {"@deepseek-ai/dsh-tools": ">=0.1.2-rc.1 <0.2.0"}`；app-boot 预检把它判为不兼容 → **bundle 被跳过、预设行被禁用**：
     - `C:\Users\b1778\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-2026-10-18T11-48-25-003Z-host.log`：
       > `dsh: skipping profile bundle "dsh-computer-use": Error: Plugin dsh-computer-use@0.3.2 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-tools":">=0.1.2-rc.1 <0.2.0"} ... Exact-version exemption: not active.`
       > `dsh: disabling profile plugin row "tool-computer-use": ...`
     - `profiles/desktop/.plugin-manager/logs/operation-5fmXPm/pnpm.log` 同样记录该警告，并写明 “it stays installed but profile startup denies it until you grant an exemption”。
   - `profiles/desktop/compatibility.json` **不存在**（没有豁免），因此没有恢复路径，只能满足版本声明或显式授权豁免。
   - 桌面更新通道是 **nightly**（`app.asar` 的 `package.json`：`dshDesktopUpdateChannel: "nightly"`），所以一次自动更新就把旧插件变成“不兼容”。

3. **“即使装回来也不好用”的结构性原因**：
   - 旧插件**只**通过一个自定义 agent 预设（`preset-computer-use` → 子行 `tool-computer-use` → `name: dsh-computer-use`）挂载工具；**没有其它注册路径**（插件自己的 `dsh.bundle.patch` 是 `[]`）。预设丢失/未被选中 = 工具消失。用户必须“新建聊天 → 选择 Computer Use 预设”；这是 `~/.dsh/skills/computer-use/SKILL.md` 明写的，但当前 UI 里该预设已不存在。
   - Windows 真实 GUI 从未被官方验收：插件仓库 `WINDOWS_TEST.md` 标注 **BLOCKED**、`VERIFICATION.md` 的 Windows 一栏是 **⛔ 本机无 Windows 10/11 测试环境**；安全护栏里的角色名/密码框检测是 **macOS AX 词表**（`AXButton`/`AXSecureTextField`…），Windows 的 cua-driver 走 UIA，词表对不上。
   - 本机 cua-driver 是 **0.20.0**（`C:\Users\b1778\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`，daemon 在跑），而插件代码注释/验证记录以 **0.21+/0.23.2** 为基准（`lib/human.js`：“坐标语义（cua-driver 0.21+）”；`VERIFICATION.md`：cua-driver 0.23.2）。好消息：0.20.0 的 `describe` 已支持 `element_token`、窗口本地截图像素、`screenshot_png_b64`，主链路大概率仍可用，但属于未验收组合。
   - 历史还出现过另一代 `dsh-computer-use-codex-style`（Python sidecar）：`crash-2026-10-14...host.log` 显示 `ModuleNotFoundError: No module named 'websocket'`，并因在 inactive context 里取 `tools` 服务直接 **fatal load failure**（`cannot get required service "tools" in inactive context`）。这类错误会让桌面端 host 直接退出，是“以前也不能用”的另一段历史。

**一句话**：旧插件被 DSH 的版本门禁禁用 → 用户在 16:24 把“不兼容插件”清理掉以保住桌面端启动 → 16:46 设置层重写后 Computer Use 预设也没了 → 新会话（standard 预设）自然没有任何 `screen_observe` / `computer_click` / `app_list` 工具。**cua-driver 本身是好的**（见 §5），缺的是“能在 0.2.1-rc.2 上通过门禁、并把工具行挂进某个预设”的插件包。

---

## 1. DSH 版本、安装布局与启动方式（证据）

### 1.1 版本

| 项 | 值 | 证据 |
|---|---|---|
| Desktop 应用 | `@deepseek-ai/dsh-desktop 0.2.1-rc.2` | `app.asar/package.json`（用 `dsh-scratch/read-asar.js` 读出） |
| 内置 runtime | `@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.2` | `app.asar/dsh/package.json` |
| 内置 `@deepseek-ai/dsh-tools` | `0.2.1-rc.2` | `app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/package.json` |
| Electron | `44.7.0` | `resources/version`；crash log 的 `electron: 44.7.0` |
| Node runtime | `24.21.0` | `resources/runtime/primary-runtime/runtime.json`、`resources/runtime/versions.json` |
| pnpm | `11.28.5` | 同上 |
| Python | `3.12.14`（office 依赖） | `runtime.json` |
| CLI | `dsh 0.2.1-rc.2` | `resources/runtime/cli/bin/dsh.cmd --version` → `0.2.1-rc.2` |
| 更新通道 | `nightly` | `app.asar/package.json` 的 `dshDesktopUpdateChannel` |
| 安装时间 | 2026-10-17 17:20:50 | `app.asar` / `DeepSeek Harness.exe` mtime |

`app.asar` 是 Electron 主包（182,794,869 字节）；它**不是普通目录**，但可以用 8 字节 pickle 头 + JSON header 解析。本报告用自己写的只读解析脚本 `computer-use-rebuild/dsh-scratch/read-asar.js`（无第三方依赖）读取内部文件，命令示例：

```bash
node computer-use-rebuild/dsh-scratch/read-asar.js \
  "B:/APP 2.0/deepseek herness/resources/app.asar" \
  dsh/package.json dsh/node_modules/@deepseek-ai/dsh-tools/README.md
```

### 1.2 布局

| 路径 | 内容 |
|---|---|
| `resources/app.asar` | Electron 主进程 + 整个 dsh runtime 的 JS：`app.asar/dsh/node_modules/...` |
| `resources/app.asar.unpacked/dsh/node_modules` | 原生/大文件依赖的 unpack 副本（`node-pty`、`koffi`、`@img`、`@swc`、`sherpa-onnx`、`@vscode` 等 84 个文件） |
| `resources/runtime/primary-runtime` | Node 24.21.0、pnpm 11.28.5、Python 3.12.14 及 office 依赖 |
| `resources/runtime/cli` | `dsh.cmd`（CLI wrapper）、`command-manager.js` |
| `resources/runtime/office-skills` | office 技能包 |

`dsh.cmd` 的真实内容是：

```bat
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

### 1.3 当前进程与 127.0.0.1:10834

- 端口监听者：**PID 8392**（`DeepSeek Harness.exe`），`netstat -ano | grep 10834` → `TCP 127.0.0.1:10834 0.0.0.0:0 LISTENING 8392`。
- PID 8392 的命令行（`Get-CimInstance Win32_Process`）：

```text
"B:\APP 2.0\deepseek herness\DeepSeek Harness.exe" --expose-internals
  "B:\APP 2.0\deepseek herness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js"
  "B:\APP 2.0\deepseek herness\resources\app.asar\dsh"                       # appRoot
  "C:\Users\b1778\.dsh\profiles\desktop"                                     # profile 目录
  "B:\APP 2.0\deepseek herness\resources\runtime\primary-runtime"           # runtime
  "...\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"              # pnpm
  "...\runtime\bin"                                                         # bin
```

- 父进程链：`DeepSeek Harness.exe`(30568，16:42:12 启动) ← 启动器；其下再 spawn host(8392, 16:42:13)、GPU(28304)、Network(12308)、renderer(31324) 等。
- 结论：**10834 是 dsh-desktop-host（dsh 服务）在本机回环端口上的 Web/API 网关**；由 Electron 主进程 `lib/main.js` 拉起 host 子进程，host 用 `dsh-desktop-host/lib/index.js` + profile 目录 + runtime 目录启动 dsh composition。

> 注意：`dsh --profile desktop --dump-config` 会失败 —— `error: profile "desktop" is managed exclusively by the Electron application`。desktop 是 Electron 保留 profile，CLI 不暴露（app-boot README 也写明 “Application-owned npm projects, such as Electron's reserved Desktop profile, use loadProfileDirectory”）。因此**不能用 CLI dump 观察桌面 profile 的合成结果**，只能看文件、会话元数据或宿主日志。

---

## 2. 时间线（由文件 mtime / 日志 / 会话元数据还原）

| 时间（本地 +08） | 事件 | 证据 |
|---|---|---|
| 2026-10-14 16:40–16:43 | 旧代 `dsh-computer-use-codex-style`（Python sidecar）写入 `config.toml` 的 `[computer-use]` 和 `~/.dsh/computer-use/config.json` | `config.toml` mtime 16:40:39；`computer-use/config.json` mtime 16:43:19；备份目录 `backups/replace-computer-use-20261014-165027/plugins-dsh-computer-use-codex-style/computer_use/notify_config.py` 第 72 行 `toml.write_text("[computer-use]\nnotify = true\n")` |
| 2026-10-14 16:50 | 该代插件崩溃：缺 `websocket` 模块 + `cannot get required service "tools" in inactive context`（host 退出） | `crash-2026-10-14T08-51-09-039Z-host.log` |
| 2026-10-14 16:50:27 | 用 `dsh-computer-use-virtual-cursor` 替换 codex-style 版本 | `backups/replace-computer-use-20261014-165027/`、`plugins/dsh-computer-use-virtual-cursor/install-backup-path.txt` |
| 2026-10-14（同日） | 该插件在本机跑 `verify-runtime-windows.mjs`：**15/15 通过**（真实 cua-driver + ClickToDo 窗口） | `plugins/dsh-computer-use-virtual-cursor/verify.out` |
| 2026-10-17 17:20:50 | 桌面端更新到 0.2.1-rc.2（Electron 44.7.0 / Node 24.21） | `app.asar`、`DeepSeek Harness.exe` mtime |
| 2026-10-17 19:48、2026-10-18 19:48 | 启动时警告 `skipping profile bundle "dsh-computer-use"` / `disabling profile plugin row "tool-computer-use"`；host 退出（`exited with 1073807364`） | `crash-2026-10-17T11-48-40-303Z-main.log`、`crash-2026-10-18T11-48-25-003Z-host.log` |
| 2026-10-19 16:24:15 | `profiles/desktop/package.json` 改写：移除 `dsh-computer-use` 与 `@dsh-external/dsh-normify` 的 bundle 声明与依赖 | 当前 `package.json`（453 B）与 `package.json.bak-remove-plugins-20261019-162407`（691 B）diff |
| 2026-10-19 16:24–16:25 | pnpm 剪枝 profile node_modules | `node_modules` mtime 16:25:35；`node_modules/@deepseek-ai` 为空；`node_modules/.pnpm` 仅 `lock.yaml` |
| 2026-10-19 16:42 | 桌面端重启（当前进程 30568 / host 8392） | 进程 StartTime、日志 |
| 2026-10-19 16:43 | 用户主会话创建，`agentPreset: "standard"` | `sessions/.../session-3ee052f3-.../session.v4.jsonl.zstd` 解压首行 |
| 2026-10-19 16:46:48 | `profiles/desktop/cordis.patch.yml` 改写为 1701 B 设置层（`reasoningEffort: high → max`），**无 Computer Use preset insert** | 当前 patch 与 16:24 备份 diff |
| 2026-10-19 16:53 | 本会话开始；工具列表无 `screen_observe`/`computer_click`/`app_list` | 本会话运行时事实 + 上述文件状态 |

> 说明：16:24 的移除操作留有 `*-remove-plugins-*` 命名的备份，且被移除的两个包正是当时仅有的两个“不兼容”插件（另一个 `@dsh-external/dsh-normify` 也同时被移除），可以合理判断是**为恢复桌面端启动而做的清理**；16:46 的 patch 改写则是设置写入（reasoningEffort 变化可证），它保留了“已移除插件”的状态。

---

## 3. 会话/预设/插件加载链路

### 3.1 组成结构（0.2.1-rc.2）

- profile 目录：`C:\Users\b1778\.dsh\profiles\desktop`
  - `package.json`：`dsh.profile.bundles` + `dependencies`（bundle 包声明）
  - `cordis.patch.yml`：profile 层 patch（用户/设置写入目标）
  - `node_modules`：bundle 包与插件包的解析根
  - `cordis.yml`：当前 profile 的合成入口（含 base pile 的 rows；由 bundle 层组合而来）
- patch 层顺序（app-boot README）：**bundle 层 → profile 层（`cordis.patch.yml`）→ HOME 层（`$DSH_HOME/cordis.patch.yml`）→ `--patch` 覆盖层**；HOME 层优先级高于 profile 层。
- 版本预检（app-boot README 原文要点）：
  - “Before a profile imports a plugin, DSH checks its declared DSH requirement against the single runtime version returned by `getDshRuntimeVersion()`.”；
  - “When the manifest declares `engines.dsh`, that range alone decides and `peerDependencies` are ignored.”；
  - “Otherwise every `peerDependencies` range on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` must match”；
  - “A denied ordinary row becomes a detached `disabled: true` row; ... A bundle ... is skipped ... and listed in `skippedBundles`”；
  - “Exact-version exemptions live in the profile's own `compatibility.json` ... maps exact `package-name@version` keys to lists of exact DSH runtime versions; neither a plugin upgrade nor a DSH upgrade inherits permission.”
  - 豁免 CLI：`dsh plugin --profile <profile> version-exemptions` / `allow-version <package@version> --dsh-version <runtime> --accept-risk` / `revoke-version ...`（plugin-manager README）。
- 预设（agent preset）机制（agent-preset / agent-preset-registry README）：
  - preset 是普通 Cordis 行：`- id: preset-xxx; name: '@deepseek-ai/dsh-agent-preset'; config: {id, name, description, order, plugins: [...]}`；
  - “Plugin registrations inherit the preset scope, and the Agent scope's parent link controls visibility.”；
  - “A new preset ... is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row”；
  - 会话记录 preset id：`session.v4.jsonl` 第一行有 `agentPreset`，恢复时用它找当前定义。
- 结论：**工具行必须挂在某个 preset 的 `plugins` 里，并且该会话选用这个 preset**；只在一个全局位置注册工具、但不进 preset，标准预设会话看不到它（旧插件正是这样设计的：把整个 `preset-computer-use` insert 进 patch）。

### 3.2 为什么本会话没有工具（逐条证据）

1. 当前 profile **没有插件包**：
   - `profiles/desktop/package.json`（453 B，16:24）内容只有 `dsh-ops`、`dsh-plugin-wallpaper-engine`，`bundles` 也不含 `dsh-computer-use`。
   - `node_modules/@deepseek-ai` 为空目录；没有 `node_modules/dsh-computer-use`；`.pnpm` 只剩 `lock.yaml`。
2. 当前 profile patch **没有 preset insert**：
   - 当前 `cordis.patch.yml` 1701 B，`grep -i computer` 无命中；与 16:24 备份（9395 B）diff 显示整块 `# Cua Driver computer use: tools are scoped to this preset.` + `insert: preset-computer-use` 消失。
3. 会话 preset 是 `standard`：
   - `session-3ee052f3-.../session.v4.jsonl.zstd` 解压：`{"type":"session","version":4,...,"agentPreset":"standard"}`。
   - `profiles/desktop/cordis.yml` 里 `preset-standard` 的 `plugins` 不含 `tool-computer-use`（只有 persona/instructions/fs/skill/todo/web/...）。
4. 没有其它注册来源：
   - 插件自己的 `cordis.patch.yml` 内容是 `[]`（注释：“Tools are mounted once in the Computer Use agent preset for DSH 0.2.”），所以它作为 bundle 被加载时**不贡献任何行**。
   - `~/.dsh/cordis.patch.yml`（HOME 层）只有 `rea-mcp` 一个 insert，不含 computer-use。
5. cua-driver 不是原因：见 §5，安装存在、daemon 运行、`get_screen_size` 正常。

---

## 4. 根因：版本门禁（最关键的机制）

### 4.1 旧插件的声明

`~/.dsh/plugins/dsh-computer-use-virtual-cursor/package.json`：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-tools": ">=0.1.2-rc.1 <0.2.0",
  "@deepseek-ai/schemastery": ">=3.18.2 <4"
},
"engines": { "node": ">=22.18.0" },
"dsh": { "compatibility": { "node": ">=22.18.0", "dsh": ">=0.1.2-rc.1" } }
```

关键点：
- `dsh.compatibility.dsh` 只是**元数据**，app-boot 不读它；
- 没有 `engines.dsh`；
- 唯一会被强制检查的是 peer range `@deepseek-ai/dsh-tools: >=0.1.2-rc.1 <0.2.0`，而 runtime 是 `0.2.1-rc.2` → **不匹配**。

### 4.2 运行时表现（引用）

`crash-2026-10-18T11-48-25-003Z-host.log`：

```text
Error: dsh desktop host exited with 1073807364:
dsh: skipping profile bundle "@dsh-external/dsh-normify": Error: Plugin @dsh-external/dsh-normify@0.5.4 is incompatible with dsh 0.2.1-rc.2 ...
dsh: skipping profile bundle "dsh-computer-use": Error: Plugin dsh-computer-use@0.3.2 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-tools":">=0.1.2-rc.1 <0.2.0"} ... Exact-version exemption: not active.
dsh: disabling profile plugin row "tool-computer-use": Plugin dsh-computer-use@0.3.2 is incompatible with dsh 0.2.1-rc.2 ...
```

`profiles/desktop/.plugin-manager/logs/operation-5fmXPm/pnpm.log`：

```text
dsh: warning: Plugin dsh-computer-use@0.3.2 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-tools":">=0.1.2-rc.1 <0.2.0"}. ...
dsh: it stays installed but profile startup denies it until you grant an exemption for those exact versions.
```

`dsh plugin --profile desktop version-exemptions`（本次只读执行）→ `{}`（无豁免）。
`profiles/desktop/compatibility.json` → 不存在。

### 4.3 结论

- **0.2.1-rc.2 不是“不支持插件”，而是“旧插件声明的 peer range 不覆盖 0.2.x”**。要么改插件声明，要么显式授予精确版本豁免。
- 由于豁免不跟随升级继承（app-boot README），**重建版必须把 `engines.dsh` 写成覆盖 0.2.1-rc.2 的区间**，否则每次 DSH 升级都会重演。
- 桌面端是 nightly 通道，升级频率高；旧插件“macOS 验证 + 0.1/0.2.0 时代 peer range”的组合在 0.2.1 上必然失效。

---

## 5. cua-driver 状态（后端没问题）

| 项 | 值 |
|---|---|
| 路径 | `C:\Users\b1778\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`（`where.exe cua-driver`） |
| 版本 | `cua-driver 0.20.0`（`cua-driver --version`） |
| 实际解析 | `\\?\C:\Users\b1778\.cua-driver\packages\releases\0.20.0-x86_64-pc-windows-msvc\cua-driver.exe`（`cua-driver doctor`） |
| 环境变量 | `CUA_DRIVER_BIN` 未设置 |
| daemon | `cua-driver status` → `Cua Driver daemon is running`，socket `\\.\pipe\cua-driver`，pid 22228（进程列表可见） |
| 桌面会话 | `doctor`：`interactive session: session 1 has an attached interactive desktop`、`UI Automation: CoCreateInstance succeeded`、`EnumWindows visible: 13 windows` |
| 屏幕 | `cua-driver call get_screen_size '{}'` → `{"width":2880,"height":1800,"scale_factor":2.0}` |
| 工具面 | `cua-driver list-tools` 列出 50+ 工具：`click/double_click/right_click/type_text/press_key/hotkey/scroll/drag/get_window_state/zoom/move_cursor/start_session/list_windows/list_apps/launch_app/bring_to_front/...` |

插件如何找到驱动（`lib/cua.js resolveBin`，优先级）：
1. `CUA_DRIVER_BIN`；
2. PATH 扫描 `cua-driver.exe`；
3. `~/.cua-driver/packages/current/cua-driver.exe`；
4. `~/AppData/Local/cua-driver/cua-driver.exe`、`~/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe`（本机正好命中第 4 条）；
5. 兜底 `cua-driver`（ENOENT 时返回带自救指引的结构化错误）。

DSH host 的 PATH 里能找到它：同一 host 派生的 shell 中 `where.exe cua-driver` 成功，说明 DSH 进程环境继承到了该 PATH；因此**驱动缺失不是本次问题的原因**。

版本差异（潜在风险，非当前阻塞）：
- 插件 `lib/human.js` 注释写“坐标语义（cua-driver 0.21+）”，`VERIFICATION.md` 用 0.23.2 验证；
- 但本机 0.20.0 的 `describe click` 已明确支持 `x,y = window-local screenshot pixels`、`element_token`、`from_zoom`；`get_window_state` 也返回 `screenshot_png_b64`/`snapshot_id`/`element_token`。**主链路字段是兼容的**，但“0.20.0 + 0.3.2”属于未验收组合，重建时应固定并验证驱动版本范围（建议声明 `cua-driver >=0.20 <1` 并在启动时 `cua-driver --version` 记录）。

---

## 6. 旧插件源码审阅（依赖条件 + 已知失败点）

目录：`C:\Users\b1778\.dsh\plugins\dsh-computer-use-virtual-cursor`（git 仓库，HEAD `3cf9bd8`，工作区有本地改动：`lib/cua.js`、`cordis.patch.yml`，未提交）。

### 6.1 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 12 个工具定义；`inject = ['tools', 'approval']`；`Config = z.object({ttlMs,maxElements,allowedApps,cursorTheme,nativeImage,visionProvider,visionModel})`；`apply(ctx, config)` 里 `ctx.tools.register(defineTool(...))` |
| `lib/cua.js` | spawn `cua-driver call <tool> '<json>'`（非 shell 固定 argv）；`resolveBin()`；会话自愈（session ended → `start_session` 后重试） |
| `lib/observe.js` | `list_windows` → 选窗 → `get_window_state`（AX/UIA 树 + 截图）→ 快照；ax/vision/native 三模式；截图经 `attachments.saveImage` 持久化 |
| `lib/actions.js` | click/double/right/type/key/scroll/drag；后台投递失败 → `approval.request` 后前台重试；引擎 `refused/suspected_noop` 透传 |
| `lib/human.js` | 虚拟光标滑行（`move_cursor` 分段弧线）+ `element_token` 点击；坐标=窗口本地截图像素 |
| `lib/guard.js` | 无快照拒绝、TTL、`allowedApps` 白名单、危险词审批、macOS 密码框角色拒绝 |
| `lib/snapshot.js` | 单会话单窗口快照（全局变量 `snapshot`） |
| `lib/vision.js` | `ctx.llm.resolveModelInfo` 判断 image 能力；`ctx.llm.stream` 让 DeepSeek 视觉模型描述截图；无 key 时降级 GLM |
| `install.sh` / `uninstall.sh` | 把插件 link 到 `$DSH_HOME/profiles/web/node_modules`，并向 `$DSH_HOME/cordis.patch.yml` 追加 insert（注意：**web profile**，不是 desktop） |

### 6.2 外部依赖条件

1. 宿主 `@deepseek-ai/dsh-tools`（defineTool）与 `@deepseek-ai/schemastery`——**由 DSH runtime 解析，插件目录本身没有 node_modules**。直接 `node index.js` 会失败，证据：
   `IMPORT FAIL: ERR_MODULE_NOT_FOUND Cannot find package '@deepseek-ai/schemastery' imported from ...index.js`。所以**任何本地验证都必须在 DSH 宿主/CLI 组合内做**，不能裸 node 跑。
2. `cua-driver` 可执行（已满足）。
3. `attachments` 服务（native/vision 截图持久化）：0.2.1 的 `LocalAttachmentStore.saveImage(input)` 存在（`attachment-local/lib/index.js` 1032 行），`input.data` 需要 `Uint8Array`；插件传 `Buffer`（`Uint8Array` 子类）→ **兼容**。
4. `llm` 服务（vision 模式）：0.2.1 `resolveModelInfo(provider, model, signal)` 存在（`dsh-llm/lib/index.js` 2112 行）→ 兼容。
5. 当前主模型是否支持图片：profile patch 里 `agent-default-model = deepseek-account/deepseek-flash`（文本模型）→ `mode="native"` 会被拒绝并提示切换视觉模型（旧 `verify.out` 也验证过这条拒绝路径）。**默认场景应只用 ax/UIA 或截图落盘路径。**
6. Windows 真实 GUI 未验收（`WINDOWS_TEST.md` BLOCKED；`VERIFICATION.md` Windows ⛔）。
7. 插件安全护栏是 **macOS 词表**：`ROLE_SHORT` 全是 `AX*`，`PASSWORD_ROLES = {AXSecureTextField, AXPasswordField}`；`isActionable` 的可交互角色列表也是 `AX*`。Windows 的 cua-driver 走 UIA（二进制里可见 `InvokePattern/ValuePattern/TextPattern/ControlType`，没有 `AXButton` 这类角色字符串），所以：
   - 元素仍会因 `label/value` 兜底被编号，但中文角色名映射失效；
   - **密码框保护在 Windows 上大概率不生效**（需要按 UIA 的 `PasswordBox`/`IsPassword` 重新实现）；
   - 危险词检测只覆盖 `element` 模式，坐标模式本来就靠 TTL（README 已承认）。
8. 单会话单窗口快照是**模块级全局变量**：多个会话/并发任务会互相覆盖（SKILL.md 也警告“不要同时在多个 Computer Use 聊天中操作桌面”）。

### 6.3 已知失败点清单

| 类别 | 失败点 | 证据 |
|---|---|---|
| 加载门禁 | peer range `<0.2.0` 与 runtime 0.2.1-rc.2 不匹配 → bundle skip / row disabled | crash log、plugin-manager log |
| 注册路径 | 只靠 profile patch 的 preset insert，没有 bundle patch / HOME patch 兜底 | 插件 `cordis.patch.yml` = `[]`；16:24 备份 diff |
| 预设选择 | 会话必须是 Computer Use preset；standard 会话没有工具 | session `agentPreset:"standard"`；SKILL.md 说明 |
| 安装脚本 | `install.sh` 默认 link 到 **web** profile + HOME patch；桌面端实际用的是 desktop profile + profile patch | `install.sh` 第 20 行、README “方式二” |
| 驱动版本 | 0.20.0 vs 代码注释 0.21+/验证 0.23.2 | `lib/human.js`、`VERIFICATION.md`；本机 `--version` |
| 平台验收 | Windows GUI 未验收 | `WINDOWS_TEST.md`、`VERIFICATION.md` |
| 安全护栏 | AX 角色/密码框对 Windows UIA 无效 | `lib/guard.js`、`lib/observe.js` |
| 视觉模式 | 默认模型无 image 能力；vision 需视觉模型/GLM key | `agent-default-model` 配置、`verify.out` |
| 并发 | 全局单快照 | `lib/snapshot.js` |
| API 演进 | 0.2.1 的 `dsh-tools`/`approval`/`attachments`/`llm` 仍保留旧插件用到的接口（见 §7），但属于“未声明支持”的隐式兼容 | 见 §7 |

---

## 7. DSH 0.2.1-rc.2 插件 API（权威依据 + 旧插件兼容性核对）

> 权威来源：`app.asar` 内包的 README/类型（只读抽取），路径均在
> `B:\APP 2.0\deepseek herness\resources\app.asar\dsh\node_modules\@deepseek-ai\...`
> 可用 `computer-use-rebuild/dsh-scratch/read-asar.js` 复现。

### 7.1 注册工具（@deepseek-ai/dsh-tools 0.2.1）

README（`dsh-tools/README.md`）给的最小例子与旧插件用法**同构**：

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'
ctx.tools.register(defineTool({
  name: 'read_file',
  description: '...',
  parameters: { path: { type: 'string', required: true, description: 'Absolute file path' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) { ... },
}))
```

关键事实：
- “Registering a tool is enough to make it visible — the registry feeds its schemas into the system-prompt assembly automatically.”（但这只对**同一 scope**可见；见 §7.3 preset 作用域）
- `inject` 是 Cordis 插件依赖声明；旧插件 `inject = ['tools','approval']` 在 0.2.1 仍成立（`ctx.tools`、`ctx.approval` 服务存在）。
- `exec.agent` 仍在：`dsh-tools/lib/index.js` 多处 `agent: exec.agent`、`...exec.agent ? { agent: exec.agent } : {}`。
- schema DSL：字段级 `required: true`、`additionalProperties: false`、`integer`、`oneOf`；**不支持** `type: [x, 'null']` 联合（旧插件已踩坑并改用 `oneOf`，见 `VERIFICATION.md` “开发中发现并修复的真实 Bug”第 1 条）。
- 输出图片：0.2.1 的 LLM/内容块支持 tool-role 图片（`dsh-llm/README.md` 提到 “including tool-role result images”），旧插件的 `render` 返回 `{type:'image', attachment:{...}}` 属于可尝试但需实测的路径。

### 7.2 审批（@deepseek-ai/dsh-user-approval 0.2.1）

- 服务：`ctx.approval.request(req)`；旧插件调用 `ctx.approval.request({ agent, toolName, reason })`；
- 0.2.1 实现（`dsh-user-approval/lib/index.js` 129–137 行）：
  ```js
  async request(req) { const session = req.agent.session; ...
    toolName: req.toolName,
    ...req.callId !== void 0 ? { callId: req.callId } : {},
    ...req.reason !== void 0 ? { reason: req.reason } : {}
  }
  ```
  → **字段名一致**（`toolName`），旧插件兼容。
- 约束：必须在打开的 turn 内调用（`approval.request() outside an open turn` 会抛错）；工具执行期间满足。
- policy：desktop profile 默认 `danger-full-access` + approval `never`（profile patch 的 `permission` 行），意味着 `ctx.approval.request` 在 `never` 下会被确定性拒绝。旧插件的“前台重试审批”在 danger-full-access 会话里会走不通（返回 `unavailable`/拒绝），需要重建时考虑用策略或改用非审批路径。

### 7.3 预设与工具可见性（@deepseek-ai/dsh-agent-preset / -registry）

- preset 是普通行：`config: {id, name, description, order, plugins: [...]}`（`dsh-agent-preset/README.md`）。
- `dsh-agent-preset-registry/README.md`：
  > “Each declaration eagerly creates a registry-owned scope and an in-memory Loader tree. ... Plugin registrations inherit the preset scope, and the Agent scope’s parent link controls visibility.”
  > “A new preset or an override of a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset` row ... installed into the profile with `plugin_manager`.”
- 结论：**工具插件行必须出现在会话所选 preset 的 `plugins` 列表中**。旧插件正是 `preset-computer-use.plugins[]` 里放 `tool-computer-use`（`name: dsh-computer-use`）；预设丢了，工具就没了。

### 7.4 插件包形态 / bundle

- 包 `package.json` 的 `dsh.bundle.patch` 指向一个 patch 文件（字符串或数组），该 patch 会作为 bundle 层参与组合（`dsh-app-boot/README.md`；`dsh-base/package.json` 是例子）。
- 因此**重建版可以把 “insert preset-computer-use” 直接写进自己的 bundle patch**：安装 = 声明 bundle，不需要再改 profile patch。
- 插件名可以是绝对路径 / file URL / 包名（`dsh-app-boot/README.md`：“Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers.”），所以本地 link 安装可行。

### 7.5 版本门禁与豁免（最关键的“机制”）

`dsh-app-boot/README.md` + `dsh-plugin-manager/README.md`：

1. 预检只看：`engines.dsh`（存在则**只**看它，peer 忽略）或 `peerDependencies` 中所有 `@deepseek-ai/dsh*` 的 range（对照**单个 runtime 版本** `0.2.1-rc.2`）；
2. bundle 不满足 → `skippedBundles`（不导入模块）；preset/普通 row 不满足 → 变成 `disabled: true` 的 detached row；两者都会打印带包名/版本/requirements 的警告；
3. 豁免文件：`profiles/<profile>/compatibility.json`，键是精确 `name@version`，值是该插件被允许的精确 DSH runtime 版本列表；**不随插件升级/DSH 升级继承**；
4. 授权方式：`plugin_manager` 的 `set_version_exemption`（需要 `acceptRisk: true` 且用户明确同意）或 CLI：
   `dsh plugin --profile <profile> allow-version <pkg@ver> --dsh-version <runtime> --accept-risk`；
   本次只读执行 `dsh plugin --profile desktop version-exemptions` 返回 `{}`，说明当前无豁免。
5. 结论（重建原则）：
   - 改插件：加 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`（推荐；一次到位，不依赖用户点豁免）或把 peer 改成 `@deepseek-ai/dsh-tools: ">=0.2.1-rc.2 <0.3.0"`；
   - 不改插件：仅作为临时验证手段授予精确版本豁免（需要用户批准写 `compatibility.json`）。

### 7.6 旧插件与 0.2.1 的兼容性判定（静态）

| API | 0.2.1 是否存在 | 旧插件用法 | 判定 |
|---|---|---|---|
| `defineTool` + `ctx.tools.register` | 是（`dsh-tools/lib/types/index.js` 导出 defineTool） | 一致 | ✅ 兼容 |
| `inject: ['tools','approval']` | 是 | 一致 | ✅ |
| `exec.agent` | 是（`dsh-tools/lib/index.js`） | 用于取 route / approval | ✅ |
| `ctx.approval.request({agent, toolName, reason})` | 是，字段名 `toolName` | 一致 | ✅（但 `never` policy 下会被拒） |
| `ctx.get('attachments').saveImage({data, mediaType, name})` | 是（`LocalAttachmentStore.saveImage`） | 传 `Buffer` | ✅（Buffer 是 Uint8Array） |
| `ctx.llm.resolveModelInfo(provider, model)` | 是（`dsh-llm/lib/index.js` 2112 行） | 一致 | ✅ |
| `ctx.llm.stream({...})` | 是（`dsh-llm`） | 视觉描述 | ⚠️ 需实测参数形状 |
| 工具结果图片块 | 支持 tool-role image | `{type:'image', attachment}` | ⚠️ 需实测 |
| `engines.dsh` | 无 | 只有 `dsh.compatibility`（不生效） | ❌ **门禁失败的直接原因** |
| Windows UIA 角色/密码 | — | 用 macOS AX 词表 | ❌ 平台语义不匹配 |
| 驱动版本 | 本机 0.20.0 | 代码针对 0.21+/0.23 | ⚠️ 未验收组合 |

**因此：旧插件代码在 0.2.1 上“技术上大概率能跑”（所有 import/API 都在），但被版本声明挡在门外；而即使在 macOS 时代的验证里，Windows 分支也从未真机验收。**

---

## 8. 可替换 desktop computer-use 插件的最小架构方案（不写实现）

### 8.1 目标 / 成功标准

- 在 DSH 0.2.1-rc.2 桌面端，新建会话选择 “Computer Use” 预设后，工具列表出现 `screen_observe` / `computer_click` / `computer_type` / `computer_key` / `computer_scroll` / `app_list` / `app_launch`；
- 完成闭环：`app_list → app_launch(记事本) → screen_observe(ax) → computer_click(element) → computer_type → screen_observe(验证)`；
- 通过版本门禁、不依赖用户手动改 profile 设置层、DSH 升级后不立刻失效；
- 失败可诊断：驱动缺失、窗口不存在、快照过期、拒绝原因都有结构化错误。

### 8.2 推荐包形态（最小）

```text
dsh-computer-use/
  package.json          # name/version/type=module
                        # engines: { node: ">=22.18.0", dsh: ">=0.2.1-rc.2 <0.3.0" }
                        # peerDependencies: @deepseek-ai/dsh-tools ">=0.2.1-rc.2 <0.3.0",
                        #                   @deepseek-ai/schemastery ">=3.18.5 <4"
                        # dsh.bundle.patch: "./cordis.patch.yml"
  cordis.patch.yml      # 关键：insert preset-computer-use（含 tool-computer-use 行）
  index.js              # inject ['tools','approval']; 12 个 defineTool（或先 7 个）
  lib/cua.js            # spawn cua-driver（固定 argv），ENOENT 指引，版本探测
  lib/observe.js        # list_windows/get_window_state/zoom/screenshot
  lib/actions.js        # click/type/key/scroll/drag
  lib/guard.js          # 快照 TTL、白名单、危险词、密码框（Windows UIA 词表）
  lib/snapshot.js       # 快照（建议按 session 隔离，不用模块全局）
  README/VERIFICATION   # 证据面
```

**`cordis.patch.yml`（bundle patch）内容形状**（本次已在 scratch DSH_HOME 验证可组合，见 §9.2）：

```yaml
- insert:
    - id: preset-computer-use
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: computer-use
        name: Computer Use
        description: Desktop control via cua-driver
        order: 4
        plugins:
          # ... 复用标准预设的工具箱（persona/fs/skill/todo/web/subagent...），
          #     但去掉 bash（Windows 用 pwsh）并按需裁剪
          - id: tool-computer-use
            name: dsh-computer-use
            config:
              ttlMs: 30000
              maxElements: 500
              allowedApps: []
```

安装 = 把包作为 **bundle** 加入 profile（`dsh.profile.bundles` + `dependencies`，本地用 `link:`），让 bundle patch 自动带出 preset；或（不改 profile）把同一个 insert 放进 **HOME 层** `~/.dsh/cordis.patch.yml`，并把包 link 到 `profiles/desktop/node_modules`。

### 8.3 工具集（v1 建议 7 个，先跑通再扩）

| 工具 | 用途 | 后端调用 |
|---|---|---|
| `screen_observe` | 列出窗口 + UIA 树（编号+坐标），可选截图 | `list_windows` + `get_window_state` |
| `computer_click` | element 编号或窗口本地像素点击 | `click`（`element_token` 优先） |
| `computer_type` | 文本输入（元素或当前焦点） | `type_text`（`element_token`/`element_index`） |
| `computer_key` | 单键/组合键 | `press_key` / `hotkey` |
| `computer_scroll` | 滚动 | `scroll` |
| `app_list` | 运行中应用 | `list_apps` |
| `app_launch` | 启动应用 | `launch_app`（可 `bring_to_front`） |

后续再加 `screen_zoom`（截图直读）、`computer_drag`、`computer_wait`。**v1 不依赖 `attachments`/`llm`**：截图用 cua-driver 的 `screenshot_out_file` 落盘并返回路径，避免原生图片块与视觉模型的兼容性风险；文本模型优先读 UIA 树。

### 8.4 后端选择

**推荐：继续用 cua-driver（已安装、daemon 常驻、能力足够）。**
- 优点：后台 UIA/PostMessage（不抢焦点）、`element_token` 稳定定位、窗口本地像素、虚拟光标、`screenshot_out_file`；无需写原生 addon；升级独立。
- 风险：版本漂移（本机 0.20.0 vs 文档 0.21+）→ 用 `cua-driver --version` 记录并在 README 声明支持范围；固定调用参数、跑冒烟脚本。
- 备选（不推荐先做）：纯 Windows 截屏 + SendInput/UIAutomation（Node 侧需要 `koffi`/`ffi-napi` 或 PowerShell `Add-Type`）——代码量大、DPI/多屏/焦点/后台投递都要自己处理，且没有虚拟光标；只有在 cua-driver 明确不可用时才考虑。

### 8.5 安全与权限

- 快照 TTL（默认 30s）+ 无快照拒绝；
- `allowedApps` 白名单（可选）；
- 危险词审批：目标标签命中删除/支付/转账等 → `ctx.approval.request({agent, toolName, reason})`；注意 danger-full-access + approval policy never 时审批不可用，要 fail-closed；
- **Windows 密码框**：通过 UIA `IsPassword`/`ControlType=Edit` + `ValuePattern.IsReadOnly` 判断；用 UIA 角色词表（不是 AX）；
- 管理员窗口/UAC 不可操作：把 cua-driver 的结构化拒绝透传；
- 不把全屏截图/键盘输入暴露给不可信 agent；工具描述写清边界。

### 8.6 验证方式

1. **组合验证（无需重启桌面端，推荐先做）**：用独立 `DSH_HOME` + `--from-default-profile web` 建临时 profile，`--patch` 注入 preset insert，`--dump-config` 断言 `preset-computer-use`/`tool-computer-use` 出现（本报告已跑通，见 §9.2）。
2. **插件模块验证（无需重启）**：在 scratch DSH_HOME 的 profile `node_modules` 里 link 插件，`--dump-config-schema` 或 `dsh headless` 触发 import，验证 `defineTool` schema 合法、无 `ERR_MODULE_NOT_FOUND`；`--dump-config-schema` 会 import 每个模块，可暴露 API 不匹配。
3. **桌面端集成（必须重启桌面端）**：安装 bundle（plugin_manager/手动）→ 重启 DSH → 新建聊天选 Computer Use → 工具列表出现 → 跑闭环。
4. **实机冒烟**：`app_list → app_launch(notepad) → screen_observe → computer_click → computer_type → screen_observe`，并验证拒绝路径（无快照、过期、白名单、危险词、管理员窗口）。
5. **回归**：每次 DSH nightly 升级后跑 1+2+4，检查门禁与 API。

### 8.7 “最可能一次跑通”的路径

1. 复制/新建重建包（基于现有 `plugins/dsh-computer-use-virtual-cursor` 的 `index.js` + `lib/*`）；
2. 改 `package.json`：加 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`，peer 改 `>=0.2.1-rc.2 <0.3.0`；
3. 把 preset insert 从 profile patch 挪进包自己的 `cordis.patch.yml`；
4. 把工具注册行 `name: dsh-computer-use` 保留在 preset 里；
5. 用 scratch DSH_HOME 的 web profile 做组合/模块验证（不碰用户桌面端）；
6. 通过后，用 **plugin_manager** 或手工 link 安装到 `profiles/desktop`，重启桌面端；
7. 新建聊天选 “Computer Use”，跑闭环；失败按 §6.3 表逐项核对。

---

## 9. 本次已完成的只读/临时实验与结果

### 9.1 只读命令（全部成功）

| 命令 | 结果 |
|---|---|
| `dsh --version`（`resources/runtime/cli/bin/dsh.cmd`） | `0.2.1-rc.2` |
| `dsh plugin --profile desktop version-exemptions` | `{}`（无豁免） |
| `dsh --profile desktop --dump-config` | 失败：`error: profile "desktop" is managed exclusively by the Electron application`（保留为“CLI 不可观测 desktop”的证据） |
| `cua-driver status` / `doctor` / `list-tools` / `call get_screen_size` | daemon 正常；0.20.0；2880×1800@2.0 |
| `node read-asar.js app.asar <内部路径>` | 成功读取 `package.json`、README、lib 类型与实现片段 |
| `node -e "import(plugin/index.js)"` | `ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery` → 证明 peer 由宿主提供，不能裸跑 |

### 9.2 临时组合实验（scratch DSH_HOME，不改用户配置）

目的：证明“preset insert 作为 patch 层可以组合”这一重建机制。产物在 `computer-use-rebuild/dsh-scratch/`：

```bash
# 1) 建临时 DSH_HOME（scratch 内）
DSH_HOME="B:/Data Center/.../computer-use-rebuild/dsh-scratch/dsh-home" \
  dsh --profile cu-test --from-default-profile web --dump-config   # exit=0，1229 行
# 2) 写 probe patch（insert 一个 preset + 一个本地 toy 插件行）
# 3) 再 dump：
ELECTRON_RUN_AS_NODE=1 "B:/APP 2.0/deepseek herness/DeepSeek Harness.exe" \
  --expose-internals ".../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  --profile cu-test --patch ".../dsh-scratch/extra-probe.yml" --dump-config
```

结果（`dsh-scratch/cu-probe-dump.yml` 1231 行起）：

```yaml
- id: preset-cu-probe
  ...
    id: cu-probe
    ...
      - id: probe-tool
```

→ **0.2.1-rc.2 的 patch 层可以 insert 自定义 agent preset 与本地插件行**，这就是重建包 `dsh.bundle.patch` 的可行机制。实验产物：`dsh-scratch/{read-asar.js, probe-toy.tool.mjs, extra-probe.yml, dsh-home/, cu-probe-dump.yml}`。

### 9.3 追加实验：在 0.2.1 组合内 import 旧插件（2026-10-19 17:2x）

目的：不重启桌面端，验证“旧插件模块能否被 0.2.1 宿主 import / schema 投影”。

1. **把旧插件作为 profile 顶层 row、用绝对 file URL 插入**：
   - patch：`- insert: [{ id: tool-computer-use, name: 'file:///C:/Users/b1778/.dsh/plugins/dsh-computer-use-virtual-cursor/index.js' }]`
   - 命令（scratch DSH_HOME `probe-home`、profile `cu-real`）：
     `ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals ".../dsh-desktop-host/lib/cli.js" --profile cu-real --patch extra-top.yml --dump-config-schema`
   - 结果：`dsh: error: [/190] Cannot find package '@deepseek-ai/schemastery' imported from C:\Users\b1778\.dsh\plugins\dsh-computer-use-virtual-cursor\index.js`
   - 含义：**patch 里的绝对路径/file URL 不会自动获得 DSH 宿主的 peer 解析**；插件的 `@deepseek-ai/*` peer 只有在其包被安装进 **profile 的依赖图 / node_modules**（即 runtime resolution 的映射范围）时才能解析。这也解释了旧 `install.sh` 为什么要先 `ln -s` 到 `$DSH_HOME/profiles/<profile>/node_modules`。
2. **把旧插件放进 preset 的 `plugins` 列表**（同样的 file URL）：`--dump-config-schema` 报
   `unrecognized Loader tree carrier; use cordis:group or cordis:include for native child collection`（schema 投影不展开 agent preset 的 `config.plugins` 子列表），因此 **`--dump-config-schema` 不能验证 preset 内的工具行**；preset 子树的验证只能靠真实 boot（headless/web）或桌面端。
3. 结论（对重建方案的影响）：
   - 本地开发验证顺序应为：**先把包 link/安装进 profile node_modules**（或用真正发布/打包的 bundle），再做 import/schema 验证；
   - 不要用“patch 里直接写绝对路径”来验证插件模块，它只适合验证组合结构（§9.2 的 toy 插件没有 peer 依赖，所以能组合成功）；
   - `dsh plugin --profile ... add link:<本地目录>` 这类安装会先读本地 `package.json` 做兼容预检，旧插件（peer `<0.2.0`）会在 pnpm 运行前被拒——这再次说明重建版必须先修 `engines.dsh`/peer 声明，或走精确版本豁免。
   - 产物：`dsh-scratch/{probe-home/, extra-real.yml, extra-top.yml, cu-real-schema.{out,err}, cu-top-schema.{out,err}}`（scratch 内，未触碰用户配置）。

---

## 10. 最小验证命令清单（标注是否需要用户批准）

> 约定：`[只读]` = 不改任何用户文件/不启动额外服务；`[需批准]` = 会写 `~/.dsh`、启动/重启桌面端、或安装包。

### A. 现状复核（只读，可直接跑）

1. `[只读]` 版本：`"B:\APP 2.0\deepseek herness\resources\runtime\cli\bin\dsh.cmd" --version` → 应为 `0.2.1-rc.2`。
2. `[只读]` 无豁免：`dsh.cmd plugin --profile desktop version-exemptions` → 应为 `{}`。
3. `[只读]` 当前 profile 无插件：`grep -n "dsh-computer-use" "C:\Users\b1778\.dsh\profiles\desktop\package.json" "C:\Users\b1778\.dsh\profiles\desktop\cordis.patch.yml"` → 无输出。
4. `[只读]` 驱动：`where cua-driver`；`cua-driver status`；`cua-driver call get_screen_size '{}'`。
5. `[只读]` 本会话无工具：看当前会话工具列表（无 `screen_observe`/`computer_click`/`app_list`）。
6. `[只读]` 历史门禁证据：`grep -n "skipping profile bundle \"dsh-computer-use\"" "C:\Users\b1778\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-2026-10-18T11-48-25-003Z-host.log"`。
7. `[只读]` 会话 preset：解压 `sessions/.../session.v4.jsonl.zstd` 首行，确认 `"agentPreset":"standard"`。

### B. 组合/模块验证（只读用户配置；只写 scratch）

8. `[只读/scratch]` 复跑 §9.2 的 `--from-default-profile web --dump-config` + `--patch extra-probe.yml`，断言 `preset-cu-probe` 出现。
9. `[只读/scratch]` 在 scratch profile 的 `node_modules` 里 link 重建插件，跑 `--dump-config-schema`（会 import 每个模块）验证 `defineTool` schema 与 peer 解析；这是“不重启桌面端”最接近真实的 API 验证。
10. `[只读/scratch]` 用 `cua-driver call get_window_state`（`include_screenshot=false`）对记事本/计算器取 UIA 树，记录 `role` 词表与 `element_token`/`frame` 字段（验证 Windows 角色假设；建议先关掉敏感窗口）。

### C. 需要用户批准（会改配置/装包/重启桌面端）

11. `[需批准]` 给旧插件授予精确版本豁免（临时验证旧插件还能不能跑）：
    `dsh.cmd plugin --profile desktop allow-version dsh-computer-use@0.3.2 --dsh-version 0.2.1-rc.2 --accept-risk`
    然后手工恢复 profile 的 bundle/依赖与 preset insert，重启桌面端；验证工具是否出现。**批准内容：写 `profiles/desktop/compatibility.json`、改 profile 配置。**
12. `[需批准]` 安装重建版 bundle（推荐）：
    - 手工：`profiles/desktop/package.json` 加 `"dsh-computer-use": "link:<重建目录>"` 和 `bundles` 追加；在 profile 目录跑 `pnpm install`（用 DSH runtime 的 node/pnpm），或走 UI `plugin_manager` 的 install；
    - 或把 insert 放到 `~/.dsh/cordis.patch.yml`（HOME 层）并 link 包进 `profiles/desktop/node_modules`；
    - 重启桌面端，新建聊天选 Computer Use，跑闭环。
    **批准内容：写 `~/.dsh/profiles/desktop/*`、`~/.dsh/cordis.patch.yml`、安装本地包、重启 DSH。**
13. `[需批准]` 实机 GUI 冒烟：操作记事本/计算器（会移动虚拟光标、可能抢焦点/输入文本）；只在用户同意且无未保存数据时执行。
14. `[需批准]`（可选）把 `~/.dsh/plugins/dsh-computer-use-virtual-cursor` 复制/改造成重建包；或在 scratch 完成后由 lead 决定落盘位置。**批准内容：写 `computer-use-rebuild/` 之外的插件目录。**

### D. 明确不做（本次）

- 不改 `~/.dsh/config.toml`、`profiles/desktop/*`、`plugins/*`；
- 不安装全局 npm 包；
- 不重启桌面端、不启动第二个桌面实例；
- 不操作真实桌面窗口（除只读的窗口元数据/截图落盘实验）。

---

## 11. 残余未知 / 待验证

1. **0.2.1 上旧插件“绕过门禁后”是否真能注册工具**：静态看所有 API 都在，但没有任何真实 boot 证据（需要 §10-C11 或 scratch `--dump-config-schema` 验证）。
2. **0.2.1 的 tool-role 图片块与 `attachments.saveImage` 的真实兼容性**：静态存在；`native` 模式还受当前模型（deepseek-flash，无 image）限制。
3. **Windows UIA 角色词表**：未在真实窗口上抽样（为避免读取用户桌面内容，未执行）；重建版应把密码框/危险词检测改为 UIA 语义。
4. **cua-driver 0.20.0 与插件期望的 0.21+ 行为差异**：主字段在，但滑行/`move_cursor` 形状、`zoom` 翻译等需实机验证。
5. **DSH nightly 升级后的再次失效风险**：重建版必须依赖 `engines.dsh` 区间 + `compatibility.json` 豁免双保险，且把版本检查写进 README。
6. **`dsh --dump-config` 无法观测 desktop profile**：验证桌面端组合只能看会话/工具列表/宿主日志；scratch web profile 的验证是近似而非等价。
