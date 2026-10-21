# dsh-computer（A+B）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付独立自研的 DSH 常驻插件 `dsh-computer`：无预设、工具全局可用、统一 `computer` 工具（observe/act/session）、可见 AI 光标、审批/接管/审计，以及 DSH 升级自动跟进的安装器。

**Architecture:** 单 ESM 包，host 入口注册一个 `computer` 工具；内核由 backend（Cua Driver MCP 持久连接）、观察/动作引擎、会话租约、策略/审批、审计组成；安装器写 HOME patch 根插件行（无预设），外部计划任务负责跨 DSH 版本自动更新。

**Tech Stack:** Node.js 24 ESM（纯 JS + JSDoc 类型，零构建）、`node --test`、`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`（host peer）、Cua Driver ≥0.36 MCP。

**Spec:** `computer-use-rebuild/docs/superpowers/specs/2026-10-21-dsh-computer-independent-design.md`

## Global Constraints

- DSH 运行时：0.2.1-rc.2；`engines.dsh`: `>=0.2.1-rc.2 <0.3.0`。
- Cua Driver ≥0.36.0，默认 daemon 管道 `\\.\pipe\cua-driver`。
- 不引入 UI 面板、不引入原生模块、不新增运行时依赖（devDeps 仅测试/工具）。
- 密码框、UAC、安全桌面：硬阻断，不可配置。
- 审计默认 `~/.dsh/computer/audit.jsonl`；输入不记明文（只记长度/摘要）。
- 安装只写：`~/.dsh/plugins/dsh-computer/**`、`~/.dsh/profiles/desktop/node_modules/dsh-computer`、`~/.dsh/cordis.patch.yml` 的标记段、`~/.dsh/computer/**`、计划任务 `dsh-computer-updater`。
- 所有模块可脱离 DSH host 单测；host 导入只出现在 `index.js`。
- 每个任务结束必须 `node --test tests/*.test.mjs` 全绿后提交。
- 新仓库：`Curlance/dsh-computer`（独立历史），目录 `B:\Data Center\Agent Program\Herness\dsh-computer`。

## Review Focus

1. DSH 版本字符串（`0.2.1-rc.2`、build 元数据、未来 `0.2.2`）比较错误 → 错误安装/拒载。
2. 过期 observation / revision 不匹配时仍执行动作 → 点错目标。
3. 截图缩放/多显示器/DPI 坐标换算错误 → AI 光标与点击错位。
4. 审批拒绝、异常、超时被当成成功 → 越权副作用。
5. 后端断连/超时/半包时返回成功或挂死 → 假成功、工具卡住。
6. 多会话/子 agent 并发抢桌面 → 动作交错。
7. 配置缺省/部分字段/非法值 → 启动崩溃。
8. 安装器重复运行、旧版迁移、校验失败 → patch 损坏或双工具注册。

---

### Task 1: 仓库骨架与零依赖包

**Files:**
- Create: `package.json`, `index.js`, `lib/config.js`, `tests/config.test.mjs`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: `export function apply(ctx, config)`（本轮空实现）；`export const Config`（schemastery schema，仅 `index.js` 引入 host 包）；`normalizeConfig(partial) -> ConfigValues` in `lib/config.js`（纯 JS，无 host 依赖）；`validateConfig(partial) -> {ok, errors}`。

- [ ] **Step 1: 写失败测试** `tests/config.test.mjs`：`normalizeConfig({})` 返回 `{cursor:{enabled:true,theme:'cua.default',idleHideMs:0,glideMs:600}, approvals:{mode:'ask'}, policy:{allowedApps:[],blockedApps:[],maxActionsPerMinute:60}, audit:{path:'<home>/.dsh/computer/audit.jsonl',includeScreenshots:false}, backend:{timeoutMs:15000}, observation:{maxElements:250,maxImageDimension:1456,ttlMs:60000}}`；`normalizeConfig({approvals:{mode:'bogus'}})` 抛 `Invalid approvals.mode`。
- [ ] **Step 2: 运行失败**：`node --test tests/config.test.mjs` → FAIL（模块不存在）。
- [ ] **Step 3: 实现** `package.json`（type module, exports `./index.js`, peerDeps `@deepseek-ai/dsh-tools`/`@deepseek-ai/schemastery`, devDeps `@deepseek-ai/schemastery` 供本地测试，engines.dsh）与 `lib/config.js`（纯 JS 默认值+深合并+home 路径展开+枚举校验）。`index.js` 仅导出 `apply(){}` 与用 schemastery 构造的 `Config`。
- [ ] **Step 4: 通过**：同命令 → PASS。
- [ ] **Step 5: 提交**：`git add -A && git commit -m "chore: scaffold dsh-computer package"`。

### Task 2: HOME patch 安装器（无预设）

**Files:**
- Create: `lib/install/patch.js`, `scripts/install.mjs`, `scripts/uninstall.mjs`, `tests/patch.test.mjs`

**Interfaces:**
- Produces: `ensurePluginRow(patchText, {id, name, config}) -> string`；`removePluginRow(patchText, id) -> string`；`ensureLegacyMigration(patchText) -> {text, removedPreset:boolean, removedRows:string[]}`；`Marker = '# >>> dsh-computer (managed)' | '# <<< dsh-computer'`。

- [ ] **Step 1: 失败测试**：空文本插入标记段与 `- insert:` 行；重复调用幂等（文本不变）；删除后不留空行；旧 `# >>> dsh-computer-use` 段被整段移除且返回 `removedPreset:true`；损坏的 YAML 片段抛出可读错误（用内置 parser 或保护性缩进检查）。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现** `lib/install/patch.js`（纯函数、LF、幂等）+ `scripts/install.mjs`/`uninstall.mjs`（复制包到版本目录、创建 junction、写 patch、备份旧 patch 到 `~/.dsh/computer/backup/`；支持 `--dry-run`）。
- [ ] **Step 4: 通过** → PASS。
- [ ] **Step 5: 提交**。

### Task 3: 旧版迁移与回滚点

**Files:**
- Create: `lib/install/migrate.js`, `tests/migrate.test.mjs`
- Modify: `scripts/install.mjs`

**Interfaces:**
- Produces: `planMigration({patchText, pluginsDir, profileNodeModules}) -> {actions:[{kind:'remove-preset'|'move-package'|'write-backup', detail}], backupPath}`；`applyMigration(plan)` 幂等。

- [ ] **Step 1: 失败测试**：存在 `preset-computer-use` 块 + `~/.dsh/plugins/dsh-computer-use-0.4.1` 时，plan 含移除预设、把旧包移动到 `~/.dsh/plugins/_backup/`、备份 patch；再次 plan 为空；回滚函数能恢复旧 patch 与旧包。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现** + 接入 install.mjs。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 4: 兼容性探测

**Files:**
- Create: `lib/compat.js`, `lib/install/version.js`, `tests/compat.test.mjs`

**Interfaces:**
- Produces: `parseVersion(s) -> {major,minor,patch,prerelease}`；`satisfiesRange(range, version) -> boolean`（支持 `>=x.y.z <a.b.c` 与 `^`/`~` 子集）；`detectDshVersion({env, readFile, exec}) -> string|null`；`detectCapabilities(ctx) -> {approval:boolean, attachments:boolean, tools:boolean}`；`assertCompatible(version)` 不满足抛 `IncompatibleDshError`。

- [ ] **Step 1: 失败测试**：`0.2.1-rc.2` 满足 `>=0.2.1-rc.2 <0.3.0`；`0.2.1` 满足；`0.3.0` 不满足；`0.2.1-rc.1` 不满足；`0.2.10` 比较正确（非字符串比较）；缺文件返回 null。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 5: 审计日志

**Files:**
- Create: `lib/audit.js`, `tests/audit.test.mjs`

**Interfaces:**
- Produces: `createAudit({path, now, includeScreenshots}) -> {record(event): Promise<void>, flush(): Promise<void>, path}`；event `{ts, sessionId, agentId, action, target, risk, decision, effect, durationMs, observationRevision, inputSummary?}`；`redactText(text) -> {length, sha256Prefix}`。

- [ ] **Step 1: 失败测试**：记录追加 JSONL 一行且可 `JSON.parse`；输入文本不出现在文件里，只有长度+摘要；目录不存在时自动创建；并发 record 保序。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（`node:fs/promises` appendFile + 写队列）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 6: 会话与租约

**Files:**
- Create: `lib/session.js`, `tests/session.test.mjs`

**Interfaces:**
- Produces: `createSessionManager({now, ttlMs=120000}) -> {begin(agentId): {sessionId, agentId}, renew(sessionId), end(sessionId), takeover(sessionId,note), resume(sessionId), status(), assertActive(sessionId)}`；错误码 `busy`、`expired`、`unknown_session`、`takeover`。

- [ ] **Step 1: 失败测试**：第一个 begin 成功；第二个 begin 抛 `busy`；TTL 过期后 `assertActive` 抛 `expired` 且可重新 begin；takeover 后 `assertActive` 抛 `takeover`，resume 恢复；end 后租约释放。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（注入 now，纯内存）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 7: 风险分级与审批护栏

**Files:**
- Create: `lib/policy.js`, `tests/policy.test.mjs`

**Interfaces:**
- Produces: `classifyRisk({op, target, text}) -> 'low'|'medium'|'high'`；`isHardBlocked({target}) -> {blocked:boolean, reason?}`（password role / UAC / secure desktop）；`createPolicy({config, approval}) -> {authorize({action, session, target}) -> Promise<{allowed, reason, risk}>}`。

- [ ] **Step 1: 失败测试**：observe/element click=low；type/key/scroll/drag=medium；foreground pixel click/launch/kill/含 `密码|支付|转账|删除|发送|提交` 的 type=high；密码框 target → `blocked:true`；`approvals.mode='ask'` 时 high 调用 approval 且拒绝返回 `allowed:false`；low 不调用 approval；approval 抛异常视为拒绝。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（approval 依赖注入，不 import host）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 8: MCP stdio 客户端

**Files:**
- Create: `lib/backend/mcp.js`, `tests/mcp.test.mjs`

**Interfaces:**
- Produces: `createMcpClient({transport, timeoutMs}) -> {start(): Promise<{serverInfo}>, call(name, args): Promise<any>, close(): Promise<void>}`；`createLineTransport({stdin, stdout}) -> {send(obj), onMessage(cb), close()}`；`createProcessTransport({command, args, env}) -> 同上`；JSON-RPC 2.0，id 自增，超时拒绝，close 后 pending 拒绝。

- [ ] **Step 1: 失败测试**（fake transport）：initialize 握手发 `initialize` + `notifications/initialized`；`tools/call` 返回 content；响应对应 id；超时抛 `TimeoutError`；错误 `result.isError` 抛出含文本错误；关闭后 pending 拒绝。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 9: Cua Driver 后端适配

**Files:**
- Create: `lib/backend/cua.js`, `tests/cua-backend.test.mjs`

**Interfaces:**
- Produces: `createCuaBackend({client}) -> {listWindows(opts), getWindowState({pid,windowId,includeScreenshot,treeFormat}), click(args), typeText(args), pressKey(args), hotkey(args), scroll(args), drag(args), moveCursor(args), getCursorPosition(), launchApp(args), listApps(), setAgentCursorEnabled(enabled), setAgentCursorMotion(motion), startSession({label,theme}), getAgentCursorState()}`；`normalizeToolResult(raw) -> {text, image?, structured}`；`ToolCallError`。

- [ ] **Step 1: 失败测试**（fake client）：getWindowState 传 `tree_format:'elements'`；image content 解 base64；`isError` 转 `ToolCallError`；click 参数透传；window 不存在错误映射；重连一次后成功。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 10: 观察引擎（树/截图/坐标空间）

**Files:**
- Create: `lib/observe.js`, `tests/observe.test.mjs`

**Interfaces:**
- Produces: `createObserver({backend, maxElements, maxImageDimension, ttlMs}) -> {observe(target, {mode,query,includeScreenshot}) -> Promise<Observation>, get(revision)}`；`Observation = {revision, pid, windowId, title, bounds, space:{width,height,scaleX,scaleY}, screenshotPng?, tree: Array<{id,role,label,frame,actions,value?}>}`；`toLocalPoint(frame, observation) -> {x,y}`；`resolveTarget(observation, target) -> {element|point}`。

- [ ] **Step 1: 失败测试**（fixture：window bounds 2880×1800，截图 1456×910）：元素 frame `{x:282,y:644,w:72,h:38}` → local `(142.57,325.58)`；元素 id 保留；`mode:'tree'` 无截图；`mode:'both'` 有截图；过期 revision 拒绝；query 过滤保留祖先。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（纯函数换算 + TTL 缓存）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 11: 渲染（文本树 + 图片块）

**Files:**
- Create: `lib/render.js`, `tests/render.test.mjs`

**Interfaces:**
- Produces: `renderTree(observation, {maxElements}) -> string`（`[id] role "label" @(x,y) actions` 行）；`IMAGE_FIELD`（DSH 工具结果 image schema，同旧插件：`{image:{attachmentId,mediaType,bytes,width,height,name?}}`）；`persistImage(attachments, observation, {name}) -> Promise<imageField|null>`（调用注入的 `attachments.saveImage({data, mediaType, name})`，失败抛可读错误）；`renderWithImage(_args, value) -> ContentBlock[]`。

- [ ] **Step 1: 失败测试**：树行格式与顺序；超 maxElements 截断并注明总数；空树提示；`persistImage` 用 fake attachments 返回 attachmentId/bytes/width/height；无截图返回 null；`renderWithImage` 文本块+图片块形状。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 12: 动作引擎与 effect 分类

**Files:**
- Create: `lib/act.js`, `tests/act.test.mjs`

**Interfaces:**
- Produces: `execute(backend, {observation, op, target, text, keys, direction, amount, from, to, delivery, observeAfter}) -> Promise<{effect:'confirmed'|'unverifiable'|'refused'|'noop', detail, verification?}>`；`classifyEffect(rawToolResult)`；`buildActionSummary(op, target)`。

- [ ] **Step 1: 失败测试**（fake backend）：click element → 调 click 且 effect confirmed（有 readback）；click 无元素无坐标 → 抛 `MissingTarget`；dialog/password 元素 → `refused`；后台 `background_unavailable` → `unverifiable` 且带建议；type 成功 → effect confirmed；scroll 方向非法 → 抛错。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（不落盘、不依赖 host）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 13: AI 光标模块

**Files:**
- Create: `lib/cursor.js`, `tests/cursor.test.mjs`

**Interfaces:**
- Produces: `ensureCursor(backend, {theme, glideMs, idleHideMs}) -> Promise<void>`（幂等，仅一次）；`glideTo(backend, point, observation) -> Promise<void>`（分 5 段 + 最终定位，失败不抛）；`cursorSummary(backend)`。

- [ ] **Step 1: 失败测试**（fake backend）：ensure 调用 start_session/enabled/motion 各一次且缓存；glide 调 move_cursor 6 次（5 段+终点）且坐标落在目标；move 失败不抛；坐标越界 clamp 到截图空间。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 14: 统一工具定义与分发

**Files:**
- Create: `lib/tool.js`, `tests/tool.test.mjs`

**Interfaces:**
- Produces: `buildComputerTool(deps) -> defineTool 参数对象`（name `computer`，description，parameters JSON Schema）；`dispatch(deps, args, exec) -> Promise<{ok, result, image?}>`；args schema：`action: 'observe'|'act'|'session'`，其余见 spec §4.3；`deps = {backend, observer, policy, sessions, audit, persistImage}`。

- [ ] **Step 1: 失败测试**：schema 覆盖三类 action；dispatch observe → 返回文本+图片（视觉能力时）；act → policy→session→act→audit 顺序；session begin busy；未知 action 报错；stale revision 报错；audit 记录每次结果。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（deps 全注入）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 15: Host 入口接线

**Files:**
- Modify: `index.js`, `lib/config.js`
- Create: `lib/host.js`, `tests/host.test.mjs`

**Interfaces:**
- Consumes: Task 1-14 全部。
- Produces: `createPlugin({defineTool, ctx, config}) -> {dispose(): Promise<void>}` in `lib/host.js`（不 import host 包，`defineTool` 由入口注入；从 `ctx.attachments` 取图片服务）；`apply(ctx, config)` 在 `index.js` 里调用 `createPlugin({defineTool, ...})` 并注册 `computer` 工具；启动时 `ensureCursor`（失败降级）；`ctx.on('dispose')` 关闭 backend；`Config` 暴露给 DSH。

- [ ] **Step 1: 失败测试**（fake ctx + fake defineTool）：createPlugin 注册 1 个工具；backend 启动失败时工具调用返回可操作错误而不是崩溃；dispose 关闭 client；Config 默认值。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 16: 安装器端到端（scratch DSH profile）

**Files:**
- Create: `tests/install-e2e.test.mjs`, `scripts/doctor.mjs`

**Interfaces:**
- Produces: `doctor({home, profileDir, backend}) -> {ok, checks:[{name,ok,detail}]}`；测试用临时 HOME 与假 node_modules，验证 install → patch 含根行 → uninstall 恢复。

- [ ] **Step 1: 失败测试**：临时目录执行 install；`cordis.patch.yml` 含 `dsh-computer` 根行且无 `preset-computer-use`；node_modules 链接指向版本目录；重复 install 幂等；uninstall 删除三者并恢复备份；`doctor` 检查 dsh 版本/驱动/补丁/链接。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（`node:fs`，不碰真实 `~/.dsh`；测试传 home）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 17: 自动更新器（下载/校验/切换/回滚）

**Files:**
- Create: `lib/update/compat.js`, `lib/update/install.js`, `scripts/update.mjs`, `tests/update.test.mjs`

**Interfaces:**
- Produces: `selectVersion(manifest, currentDsh) -> {version, tarball, sha256}|null`；`installVersion({cacheDir, pluginsDir, tarballUrl, sha256, fetchImpl}) -> {version, path}`；`switchCurrent({pluginsDir, profileNodeModules, version})`；`recordHeartbeat({stateDir, version, dshVersion})`；`needsRollback({stateDir, now}) -> boolean`；`rollback({pluginsDir, profileNodeModules, patchBackupPath})`。

- [ ] **Step 1: 失败测试**（本地 fetchImpl + fixture tarball）：manifest 选最高兼容版本；sha256 不匹配抛 `IntegrityError` 且不留半成品；原子切换后链接指向新版本；pending 无心跳 → rollback 恢复 previous；DSH 运行中不切换（`dshRunning` 注入）。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**（`node:zlib` tar 解析或调用 `tar`；优先 npm tar? 无依赖 → 用 `node:child_process` 调系统 `tar`，测试注入 fake）。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 18: 计划任务与通知

**Files:**
- Create: `scripts/register-task.mjs`, `scripts/unregister-task.mjs`, `lib/update/notify.js`, `tests/notify.test.mjs`

**Interfaces:**
- Produces: `renderTaskCommand({home, scriptPath, intervalHours}) -> {name, command, schedule}`；`notify({title,message,level, exec})`（PowerShell toast，失败只记日志）；测试只断言命令字符串与降级。

- [ ] **Step 1: 失败测试**：schedule 命令包含脚本绝对路径、每 6 小时、登录触发；notify 失败不抛；teardown 删除任务命令。
- [ ] **Step 2: 运行失败** → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 通过**。
- [ ] **Step 5: 提交**。

### Task 19: Windows 冒烟与真机验证脚本

**Files:**
- Create: `scripts/smoke.mjs`, `scripts/smoke-action.mjs`

**Interfaces:**
- Produces: smoke 输出 `{ok, checks}`；action smoke：启动记事本 AUMID → observe → click 文档元素 → type 文本 → 回读校验。

- [ ] **Step 1: 写脚本**（真机，非单测）：smoke 记录 observe/act/回读耗时（目标：observe<1500ms、元素点击<800ms、回读<1500ms），超阈值标 `slow` 但不 FAIL 除非错误。
- [ ] **Step 2: 运行**：`node scripts/smoke.mjs` 期望 observe 成功；`node scripts/smoke-action.mjs` 期望回读文本一致、AI 光标 position 非空。
- [ ] **Step 3: 修复到通过并记录证据到 `docs/verification.md`**。
- [ ] **Step 4: 提交**。

### Task 20: CI、文档与发布流水线

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/ARCHITECTURE.md`, `docs/SAFETY.md`, `docs/AUTO-UPDATE.md`, `docs/verification.md`, `CHANGELOG.md`, `skills/computer-use/SKILL.md`
- Modify: `README.md`, `scripts/install.mjs`（可选：安装/更新 skill 文件）

**Interfaces:**
- Produces: CI（windows-latest，node 24，`node --test`）；release workflow 产出 `dsh-computer-<v>.tgz`、`compat.json`（含 sha256）、可选签名；skills/computer-use 描述统一 `computer` 工具与安全边界。

- [ ] **Step 1: 写 workflow 与文档骨架**。
- [ ] **Step 2: 本地校验**：`node --test tests/*.test.mjs`；`npm pack --dry-run` 检查 files。
- [ ] **Step 3: 提交**；推送到 `Curlance/dsh-computer` 并验证 CI 绿。
- [ ] **Step 4: 真机 DSH 验证**：安装 → 重启 → 标准会话（无预设）让模型自主调用 `computer` 看屏幕/开记事本/输入；再验证一次高风险动作被审批拒绝后未执行；记录到 verification。

---

## 执行注意

- 单测不得触碰真实 `~/.dsh`、真实桌面、真实 cua-driver；Task 16/19/20 才用临时目录/真机。
- 每个 Task 的测试文件放 `tests/<name>.test.mjs`，运行 `node --test tests/<name>.test.mjs`。
- 提交消息：`feat:` / `test:` / `fix:` / `docs:` 前缀，单一职责。
- 若发现 spec 与实现冲突：停下，更新 spec 并请用户确认，不擅自改需求。
