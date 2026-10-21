# DSH 独立 Computer 插件设计（A+B 阶段）

- 状态：待评审（评审通过后进入计划/实现）
- 日期：2026-10-21
- 范围：插件内核（A）+ 桌面 computer 工具（B）；浏览器控制（C）留给第二期，本文件只留接口与边界
- 目标运行环境：DeepSeek Harness Desktop 0.2.1-rc.2，Windows，Cua Driver ≥ 0.36.0

## 1. 意图与背景

现有 `dsh-computer-use@0.4.1` 是上游 MIT 插件的兼容性重建：修好了 DSH 0.2.1 版本门禁、cua-driver 升级和 AI 光标，但代码结构、工具面和安全设计仍是“跟着原项目打补丁”，达不到用户要求。

用户决策（已确认）：

1. **完全独立**：自研代码与架构，不再沿用原 GitHub 项目的结构和水平；Cua Driver 只作为 Windows 执行后端。
2. **不再有独立模式**：删除 `Computer Use` 预设。插件作为常驻插件安装，工具在所有会话可用，由模型按需调用。
3. **DSH 更新时自动跟进**：DSH 升级后插件自动匹配/更新，不需要人手动重装。
4. **对标 ChatGPT**：底层机制照 ChatGPT 的 computer-use 做；产品能力（观察-动作循环、审批、接管、审计、AI 光标）对标 ChatGPT 水平。
5. **两个都做**：桌面 Agent 的 computer 工具（B）+ 浏览器扩展式控制（C）。A+B 先交付，C 第二期。

## 2. 目标 / 非目标 / 反目标

### 目标

- 单包、常驻、所有会话可见；模型在合适时机自行调用，无需用户切模式。
- 自研模块化代码，单元/集成测试可覆盖，后续可持续优化。
- 桌面 computer 工具对标 ChatGPT Agent：
  - 统一 `computer` 工具（observe / act / session 三类动作），而不是散落的 12 个小工具；
  - 截图 + 无障碍树双通道观察，元素 id 与像素坐标都可动作；
  - 每次动作返回 effect + 回读/差异，禁止把“无法验证”当成功；
  - 独立 AI 光标可见，不劫持真实鼠标；
  - 风险动作审批、用户接管、完整审计。
- 安装/更新零手工：安装器 + 外部 updater；DSH 升级后自动选型、安装、可回滚。
- 兼容 DSH 0.2.1-rc.2（后续版本通过兼容层 + 自动更新跟进）。

### 非目标（A+B）

- 不重写 OS 驱动/输入栈；继续依赖 Cua Driver。
- 不做云端 VM/sandbox 桌面；本机真实桌面。
- 首期不做 macOS/Linux。
- 不做浏览器控制（C 期另写设计）。
- 不做 UI 面板（先用工具 + 审计文件；可选 UI 后置）。

### 反目标

- 自动更新导致 DSH 无法启动或丢数据。
- 无审批执行支付/登录/删除/系统设置等高风险动作。
- 把“预设”重新做成唯一入口。
- 工具描述臃肿到每会话都浪费大量 token。

## 3. 约束与既有事实

- DSH 插件通过 profile 的 Cordis 配置加载；HOME 层 patch 位于 `$DSH_HOME/cordis.patch.yml`，可用 `- insert:` 向**根插件列表**追加行（实测可以挂 preset，也可直接挂插件行）。
- HOME 层优先级高于 bundle/profile；修改后 HMR 或重启生效。
- profile 由 Desktop 应用独占管理，`dsh` CLI 不能改 desktop profile 配置；因此安装/更新由独立脚本直接写文件和 patch，不依赖 `plugin_manager`。
- 插件包必须能被 `~/.dsh/profiles/desktop/node_modules` 解析（junction/链接）。
- DSH 加载插件时会检查包声明的 `engines.dsh` / DSH peer 范围；不兼容会被拒绝加载，因此自动更新必须有“在 DSH 之外”的 bootstrap。
- Cua Driver 0.36 提供持久 daemon + `mcp` stdio 模式、AI 光标、tree_format/elements、截图上下文与审批语义；我们的适配层只使用公开工具协议。

## 4. 架构

### 4.1 包与模块

单 npm 包 `dsh-computer`。**实现语言（已定）**：纯 ESM JavaScript + JSDoc 类型，零构建（DSH host 直接加载 JS，自动更新不需要构建步骤）；TypeScript 作为后续可选增强，不进 A+B。源码模块：

```
src/
  host/
    index.ts            # 插件入口：注册统一工具、读配置、初始化后端与策略
    tools/computer.ts   # 统一 computer 工具（observe/act/session）
    tools/status.ts     # 轻量状态/诊断工具（可选）
    observe.ts          # 观察引擎：截图、AX 树、diff、渲染
    act.ts              # 动作引擎：元素/像素动作、回读、验证
    session.ts          # 会话/租约/TTL/接管状态
    policy.ts           # 风险分级、审批、限流、敏感内容拦截
    audit.ts            # JSONL 审计
    backend/
      cua.ts            # Cua Driver 适配器（持久 stdio MCP、重连、超时）
      types.ts          # 后端无关的观察/动作模型
  shared/
    schema.ts           # 工具 JSON Schema 与类型
    render.ts           # 文本/图片渲染（image block）
    compat.ts           # DSH 版本与能力探测
  scripts/
    install.mjs         # 安装到 profile + 写 HOME patch（无预设）
    uninstall.mjs
    doctor.mjs          # 环境/权限/版本/后端自检
    update.mjs          # bootstrap updater 的核心（见 4.5）
  compat/
    compat.json         # DSH 版本 → 插件版本矩阵（随仓库发布）
```

原则：后端可替换（CuaAdapter 之外留 `Backend` 接口，C 期浏览器后端另实现）；工具层不感知驱动细节；策略/审计独立于后端。

### 4.2 加载方式（无预设）

安装器做两件事：

1. 把构建好的包放到 `~/.dsh/plugins/dsh-computer/<version>/`，并让 `~/.dsh/profiles/desktop/node_modules/dsh-computer` 指向当前版本（junction/链接）。
2. 在 `$DSH_HOME/cordis.patch.yml` 维护一段带标记的根插件行：

```yaml
# >>> dsh-computer (managed by dsh-computer installer)
- insert:
    - id: dsh-computer
      name: dsh-computer
      config:
        cursor: { enabled: true, theme: cua.default }
        approvals: { mode: ask }
        audit: { path: ~/.dsh/computer/audit.jsonl }
# <<< dsh-computer
```

- 不写 profile `package.json` / `cordis.yml` / 预设；不改 `preset-computer-use`（旧预设由安装器迁移时删除）。
- 根插件层注册的工具对所有 agent 会话生效，模型按 tool description 自行判断何时调用。
- `computer-use` skill 保留，作为“何时/如何用桌面”的提示；skill 不是模式，不参与加载。
- **迁移旧版**：安装器检测 `preset-computer-use` 块、旧根行（若有）与 `dsh-computer-use` 包。删除旧预设块与旧根行，旧包目录保留为 `~/.dsh/plugins/_backup/dsh-computer-use-<version>` 供回滚；新包工具统一叫 `computer`，与旧工具的 `computer_*` 不重名。卸载新插件后可恢复旧版（用备份目录 + 备份 patch）。
- 卸载 = 删根插件行 + 删链接 + 删版本目录；不碰用户数据。

### 4.3 桌面工具协议（对标 ChatGPT）

只暴露一个主工具 `computer`，用 `action` 区分。观察返回 image block（视觉模型可看）+ 文本树（文本模型可读），动作返回 effect/回读。

#### action: `observe`

```jsonc
{
  "action": "observe",
  "target": { "kind": "active" } | { "kind": "window", "pid": 123, "windowId": 456 } | { "kind": "screen", "index": 0 },
  "mode": "screenshot" | "tree" | "both" | "diff",
  "query": "登录",          // 可选：AX 树过滤
  "maxElements": 250,
  "includeScreenshot": true // 视觉模型；文本模型可关
}
```

返回：截图（图片块，标注尺寸/缩放）、窗口 bounds、截图坐标空间说明、AX 行（`[N] role "label" @(x,y)`）、`revision`、可选 diff（新增/变化/删除行 + 失效 id）。

#### action: `act`

```jsonc
{
  "action": "act",
  "op": "click" | "doubleClick" | "rightClick" | "move" | "type" | "key" | "scroll" | "drag" | "wait" | "launch" | "focus",
  "target": { "element": 12 } | { "x": 640, "y": 360 },
  "text": "hello", "keys": "ctrl+c", "direction": "down", "amount": 3,
  "from": {"x":..,"y":..}, "to": {"x":..,"y":..},
  "delivery": "auto" | "background" | "foreground",
  "observeAfter": true
}
```

- 元素动作优先 AX（后台/可靠）；像素动作走前台输入（需要审批策略允许）。
- 坐标 = 最近一次 observe 的截图空间（窗口本地）；窗口缩放/多显示器由 observe 返回的 scale 说明。
- `observeAfter` 默认 true（或仅接受显式 false）：动作后自动做一次轻量观察/回读，返回 effect + 变化摘要；避免模型盲动作。
- effect 取值：`confirmed` / `unverifiable` / `refused` / `noop`；`unverifiable` 必须带“下一步建议”，不允许当成功。

#### action: `session`

```jsonc
{ "action": "session", "op": "status" | "begin" | "end" | "takeover" | "resume", "note": "..." }
```

- `takeover`：用户接管（或检测到疑似用户交互）→ 暂停自动动作，返回当前观察，提示用户完成后 `resume`。
- **租约与并发**：全局单 daemon，同一时间只允许一个会话执行动作。每个会话需 `begin` 拿租约（默认 TTL 120s，动作续期）；其他会话调用 `act` 返回 `busy`，不排队、不阻塞等待。审计记录 session id / agent id；审批归属发起会话。
- **可见范围**：根插件行对标准会话、子 agent、后台 agent 都可见；子 agent 同样受租约约束。若 DSH 提供按 agent 限制工具的 API，首期默认只对主会话开放、子 agent 需显式开启（避免并发抢桌面），实现时以真实 API 为准。

#### 工具描述策略

- 主工具描述只写：能力、坐标语义、安全边界、观察优先、动作后验证；详细用法放 `computer-use` skill。
- 文本模型不返回图片（includeScreenshot=false 默认按模型输入能力自动决定）；视觉模型返回图片 + 简短树。

### 4.4 安全与审批（ChatGPT 式）

- **默认 ask**：读类观察/后台元素点击自动允许；像素点击、前台输入、输入文本、启动/切换应用、滚动等按风险分级。
- **风险分级**（可配置）：
  - 低：observe、元素 click、focus、wait。
  - 中：type（非密码）、key、scroll、drag、后台键入。
  - 高：前台输入（前台重试）、launch/kill、窗口切换、坐标点击落在未知控件、含敏感词（密码/支付/删除/发送/提交/转账）的输入。
- **硬阻断（不可配置绕过）**：密码框输入、UAC/安全桌面、未观察快照的盲动作、过期 revision 动作。操作系统安全桌面/提权确认一律不触碰。
- **可配置项**：敏感应用名单（默认含系统设置/任务管理器/终端等，可白名单放行，放行动作写审计）、审批模式（默认 ask；可调严格/宽松，但不提供“高风险全自动”预设）。
- **审批**：走 `ctx.approval`；审批请求带 action 摘要 + 目标窗口/元素 + 观察 digest；拒绝返回 `refused` 并附原因。
- **接管（A+B 已定，不引入原生输入监听）**：显式 `session.takeover`；启发式检测（前台窗口变化、目标窗口失焦、动作前 revision 不一致、真实指针位置变化）→ 标记“疑似用户交互”，暂停自动动作并提示。**如实说明：这不是 100% 自动让路**；真正自动监听全局输入需要原生模块/权限，留到 C 期前作为可选增强。
- **审计**：JSONL 记录 session/agent/action/observation digest/effect/approval/耗时/配置放宽；默认 `~/.dsh/computer/audit.jsonl`；不记录输入明文（只记长度/摘要），截图默认不落盘。
- **限流**：每分钟动作数、连续失败熔断；后端不可用时工具返回可操作错误而不是崩溃。

### 4.5 自动更新（DSH 升级跟进）

问题：DSH 升级后，旧插件可能因版本范围不满足而**无法加载**，靠插件自身更新是鸡生蛋。因此更新器必须独立于 DSH 运行。

- `install.mjs` 除安装插件外，注册一个 Windows 计划任务 `dsh-computer-updater`（登录时 + 每 6 小时，可关闭）：
  1. 读 DSH 运行时版本（app.asar 内 `package.json` 或 Desktop 的版本文件；读不到就用 `dsh --version`/侧文件）。
  2. 从本仓库 Releases 拉 `compat.json`（缓存 + sha256 校验；离线时用本地缓存）。
  3. 选 `engines.dsh` 满足当前版本的**最高**插件版本；已安装则不动作。
  4. 下载 tarball，校验 sha256，原子解压到 `~/.dsh/plugins/dsh-computer/<version>`，切换链接，写 `state.json`（current/previous/pending）。
  5. 更新只在 **DSH 未运行时**执行切换（检测进程）；DSH 运行中只做“已下载，待重启”标记，不强制杀进程。
- **信任根（默认，待用户确认是否升级为签名）**：更新源固定为本项目 GitHub 仓库的 Releases（HTTPS + 重定向限制），`compat.json` 内每个版本带 tarball sha256；哈希防损坏，不防仓库被篡改。如用户要求更高安全，再加 minisign/GPG 公钥内置 + CI 签名；否则文档明确“计划任务与 DSH 同用户权限，信任边界=本仓库与 GitHub 账号”。
- **回滚/健康检查**：
  - 切换前备份 `cordis.patch.yml` 与 previous 版本目录，写 `pending`。
  - 插件成功 `apply` 后写心跳文件 `~/.dsh/computer/state/heartbeat.json`（时间 + 版本 + DSH 版本）。
  - 计划任务下次运行时：若 `pending` 存在且心跳缺失/版本不匹配，自动切回 previous 并记录；连续 2 次失败停止自动更新并提示 `doctor`。
  - 用户可见渠道（不做 UI）：工具返回的错误/状态、`doctor` 输出、审计日志、以及可选的 Windows 通知（toast，失败/回滚时）。
- **包内兼容层**：`compat.ts` 启动时探测 DSH 能力（工具注册 API、approval API、attachments），缺能力时降级/禁用对应工具并给出明确错误；`engines.dsh` 保持宽范围（如 `>=0.2.1-rc.2 <0.3.0`），升级后由 updater 换成窄范围新版本。
- **失败姿态（已定）**：优先“加载成功 + 明确降级”，而不是拒载；只有 `engines.dsh` 明确不满足时才拒绝加载（由 updater 负责选到合适版本）。
- 更新源：本仓库 GitHub Releases（主通道）；可选镜像字段（国内加速）后续加。
- 不做静默大版本跳跃：跨 DSH 大版本仅在 compat.json 明确声明时更新。

### 4.6 后端适配（Cua Driver）

- 使用 cua-driver **持久 stdio MCP**：已验证 0.36 支持 `cua-driver mcp`（裸跑自己拥有 runtime；`--socket` 连接现有 daemon；Windows 上 stdin EOF 时关闭自己的 runtime）。插件用 `mcp --socket <现有 daemon 管道>` 复用 daemon，避免每次动作 spawn 进程；单连接串行队列，超时/重连/会话恢复。
- 使用工具：get_desktop_state / get_window_state（tree_format=elements）/ click / type_text / press_key / hotkey / scroll / drag / move_cursor / launch_app / list_windows / list_apps / set_agent_cursor_* / get_agent_cursor_state。
- AI 光标：start_session 带 `cua.default` 主题、enabled、idle_hide_ms=0、glide 600ms；动作前把光标滑到目标（屏幕坐标 → 窗口本地像素换算）。
- 截图/坐标换算：AX frame 是屏幕物理像素，统一换算到截图空间（window bounds + max_image_dimension）。
- 驱动缺失/版本过旧：`doctor` 明确提示安装/升级命令，工具调用返回可操作错误。

### 4.7 性能目标

- observe（截图+树）< 1.5s；元素点击 < 800ms；像素动作 < 1.2s；动作后回读 < 1.5s（本机 2880×1800）。
- 观察缓存/差分：同一窗口连续 observe 用 diff 减少 token 与截图体积。
- 图片按模型能力返回；文本模型不付图片 token。

## 5. 里程碑与验收（A+B）

- **M0 骨架**：新仓库/新包；install/uninstall（无预设、根插件行、链接、doctor）；插件能注册一个 `computer` 工具并在**标准会话**里被模型调用。
- **M1 桌面核心**：observe（截图/树/diff）+ act（点击/双击/右键/输入/按键/滚动/drag/wait）+ effect/回读；AI 光标；审批（ask）+ 审计；单测 + Windows 冒烟。
- **M2 打磨**：多窗口/screen、launch/kill、接管/恢复、限流/熔断、错误信息、配置项、性能达标。
- **M3 自动更新**：bootstrap 计划任务、compat.json、版本选择、原子切换、回滚演练；DSH 版本变化模拟测试。
- **交付验收**：
  - 标准会话（无预设）里请求“看屏幕并打开记事本输入文字”，模型自主调用 `computer` 完成；
  - 无 `Computer Use` 预设/模式；
  - DSH 版本号被修改后可自动选到匹配版本（模拟）；
  - 危险动作触发审批，拒绝后不执行；
  - 用户接管后自动动作停止；
  - 审计文件可读，失败路径有回滚。

## 6. 评审决定（2026-10-21，用户确认）

- 自动更新信任模型：**sha256 + 固定本仓库 Releases**，不做签名（信任边界=本 GitHub 账号；哈希只防损坏）。不选“仅提醒”。
- 用户接管：**显式 + 启发式**，A+B 不引入原生全局输入监听；文档如实标注不能 100% 自动让路。
- 硬阻断：**密码框/UAC/安全桌面不可绕过**；其余敏感应用可白名单放行并审计。

## 7. 风险与未决

- **DSH Desktop 的 HOME patch 语义可能随版本变化**：bootstrap 需要能检测并提示；根插件行加载失败要可回滚。
- **自动更新与重启**：已定“DSH 未运行时才切换”；运行中只提示待重启；是否自动重启不做（不替用户杀进程）。
- **Cua Driver MCP 持久连接**：需验证 `cua-driver mcp --socket` 的会话/工具 schema 与 0.36 是否稳定；若不稳，退回 daemon JSON-RPC。
- **审批 API**：`ctx.approval` 的确切行为（多选项/超时/拒绝语义）需在 M0 用真机验证。
- **浏览器 C 期**：CDP 方案、现有登录态复用、origin 策略另写设计。
- **仓库形态**：新仓库名（建议 `dsh-computer`）与旧 `dsh-computer-use` 的关系（保留为 legacy/归档）待批准。
- **代码语言**：A+B 已定纯 ESM JS + JSDoc、零构建；TypeScript 只作为后续可选增强（不阻塞 A+B）。

## 7. 我做出的设计决定（供评审时检查）

- 统一 `computer` 工具 + action 枚举，而不是继续 12 个小工具。
- 观察默认返回文本树；图片按模型能力/参数返回；动作后默认回读。
- 安装走 HOME patch 根插件行，不碰 profile 配置和预设。
- 自动更新交给 DSH 之外的计划任务脚本，插件内只做能力探测与降级。
- 更新信任根默认 sha256 + 固定本仓库 Releases（可选升级为签名，见评审问题）。
- 更新只在 DSH 未运行时切换；插件加载后写心跳，缺失则回滚；通知走工具返回/日志/toast。
- 兼容失败优先“加载 + 明确降级”，只有 `engines.dsh` 不满足才拒载。
- A+B 不引入原生全局输入监听；接管 = 显式 + 启发式，并如实标注不能 100% 自动让路。
- 租约全局单会话，其他会话 `busy`；子 agent 首期默认不开放（视真实工具策略 API）。
- 密码/UAC/安全桌面为不可配置的硬阻断；敏感应用名单可配置并审计。
- 迁移旧 0.4.1：删旧预设/旧根行，保留旧包备份，可回滚；新工具名 `computer` 避免重名。
- 不做 UI 面板；`doctor` + 审计日志 + 工具返回作为可观测面。
- 新仓库建议 `dsh-computer`（独立历史），旧 `dsh-computer-use` 保留为 legacy。

## 8. 下一步

评审通过后：写实现计划（writing-plans）→ 建新仓库/骨架（M0）→ 按里程碑实现。