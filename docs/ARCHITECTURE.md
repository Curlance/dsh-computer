# 架构（A+B：插件内核 + 桌面 computer 工具）

本文描述当前 `0.1.0` 代码实际做了什么，而不是目标设计。目标与取舍见
[`superpowers/specs/2026-10-21-dsh-computer-independent-design.md`](superpowers/specs/2026-10-21-dsh-computer-independent-design.md)，
逐步实现记录见 [`superpowers/plans/2026-10-21-dsh-computer-a-b.md`](superpowers/plans/2026-10-21-dsh-computer-a-b.md)。

- 形态：单个 npm 包 `dsh-computer`，纯 ESM JavaScript + JSDoc，零构建、零运行时依赖。
- 运行环境：Windows 10/11，Node.js 24，DSH Desktop `>=0.2.1-rc.2 <0.3.0`，Cua Driver `>=0.36`。
- 加载方式：`~/.dsh/cordis.patch.yml` 里一段由安装器维护的根插件行；没有 Computer Use 预设，也没有模式切换。

## 1. 模块地图

| 模块 | 职责 | 关键导出 |
| --- | --- | --- |
| `index.js` | DSH 插件入口：声明 config 与依赖，注册工具 | `name`、`inject`、`Config`、`apply(ctx, config)` |
| `lib/host.js` | 宿主边界：装配依赖、懒启动后端、串行执行、审批适配、输出投影/渲染 | `register()`、`createPlugin()`、`createDefaultBackend()`、`resolveDriverCommand()`、`OUTPUT` |
| `lib/tool.js` | 唯一 `computer` 工具：schema、`observe`/`act`/`session` 分发、租约与逐 step 授权 | `dispatch()`、`buildComputerTool()`、`toDshParameters()` |
| `lib/observe.js` | 观察引擎：窗口选择、树/截图、revision + TTL 缓存、`waitFor` 轮询、坐标换算 | `createObserver()`、`toLocalPoint()`、`resolveTarget()`、`waitFor()` |
| `lib/act.js` | 动作规划与执行：参数校验、动作摘要、effect 分类、执行后回读 | `execute()`、`executeBatch()`、`classifyEffect()`、`MissingTarget` |
| `lib/policy.js` | 风险分级、不可绕过的硬阻断、审批请求 | `classifyRisk()`、`isHardBlocked()`、`createPolicy()` |
| `lib/control.js` | 用户活动门禁：空闲检测、自身动作 700 ms 抵消启发式 | `createControlGate()`、`createWindowsIdleProvider()` |
| `lib/session.js` | 内存租约：单会话、TTL、续期、接管/恢复 | `createSessionManager()`、`SessionError` |
| `lib/audit.js` | JSONL 审计；输入只记长度 + sha256 前缀 | `createAudit()`、`redactText()` |
| `lib/render.js` | 观察的文本树与图片块；attachment 持久化 | `renderTree()`、`persistImage()`、`renderWithImage()`、`IMAGE_FIELD` |
| `lib/config.js` | 配置默认值、校验、归一化（`~` 展开） | `DEFAULT_CONFIG`、`APPROVAL_MODES`、`normalizeConfig()`、`validateConfig()` |
| `lib/cursor.js` | AI 光标：会话/主题配置、glide 轨迹、状态摘要 | `ensureCursor()`、`glideTo()`、`cursorSummary()` |
| `lib/compat.js` | DSH 版本与能力探测、兼容断言 | `DSH_REQUIREMENT`、`detectDshVersion()`、`detectCapabilities()`、`assertCompatible()` |
| `lib/backend/cua.js` | Cua Driver 工具适配器；仅传输层错误可重试 | `createCuaBackend()`、`normalizeToolResult()`、`ToolCallError` |
| `lib/backend/mcp.js` | `cua-driver mcp` stdio JSON-RPC：framing、超时、进程生命周期 | `createProcessTransport()`、`createMcpClient()` |
| `lib/install/patch.js` | `cordis.patch.yml` 的托管段增删与幂等 | `ensurePluginRow()`、`removePluginRow()`、标记正则 |
| `lib/install/migrate.js` | 从旧 `dsh-computer-use` 迁移/回滚 | `planMigration()`、`applyMigration()`、`rollbackMigration()` |
| `lib/install/version.js` | semver 解析与范围判断（`>= <`、`^`、`~` 子集） | `parseVersion()`、`compareVersions()`、`satisfiesRange()` |
| `lib/update/compat.js` | 从 `compat.json` 选最高兼容版本（纯函数） | `selectVersion()` |
| `lib/update/install.js` | 更新器的文件系统核心：校验、解包、原子切换、心跳、回滚 | `installVersion()`、`switchCurrent()`、`recordHeartbeat()`、`needsRollback()`、`rollback()`、`IntegrityError` |
| `lib/update/notify.js` | 尽力而为的 Windows toast | `notify()` |
| `scripts/install.mjs` | 安装：复制版本目录、profile junction、写托管插件行、迁移旧版 | CLI |
| `scripts/uninstall.mjs` | 卸载：删插件行、链接、版本目录；保留用户数据 | CLI |
| `scripts/doctor.mjs` | 自检：DSH 版本/兼容、驱动、patch、安装链接（复用 `lib/compat.js#detectDshVersion`） | `doctor()`、`detectDshVersion`（re-export） |
| `scripts/update.mjs` | 更新器 CLI：`--check` / `--apply` / `--rollback` | `runUpdate()` |
| `scripts/register-task.mjs` / `unregister-task.mjs` | 计划任务 `dsh-computer-updater`（登录 + 每 6 小时） | `renderTaskCommand()`、`registerTask()` |
| `scripts/smoke.mjs` / `smoke-action.mjs` | 真机冒烟（非单测） | CLI |

依赖方向：`index.js` 是唯一 import 宿主包（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`）的地方；
`lib/*` 通过参数注入宿主服务（`ctx.tools.register`、`ctx.approval.request`、attachments），因此单测不需要 DSH。
`lib/tool.js` 只组合注入的 `observer/act/policy/control/sessions/audit`，不 import 宿主、不持久化。

## 2. 加载与装配

```
index.js apply(ctx, config)
  └─ normalizeConfig(config)                       # 默认值 + 校验，非法值抛错
  └─ register(ctx, cfg, { defineTool })
       ├─ observer  = createObserver({ backend: lazyBackend, ... })
       ├─ policy    = createPolicy({ config, approval: ctx.approval.request 适配器 })
       ├─ sessions  = createSessionManager({ ttlMs: 120000 })
       ├─ control   = createControlGate({ idleProvider: PowerShell GetLastInputInfo })
       ├─ audit     = createAudit({ path, includeScreenshots })
       └─ ctx.tools.register(defineTool({ name: 'computer', parameters, output, execute }))
```

- **懒启动**：注册阶段不碰驱动。第一次 `execute` 才 `createDefaultBackend()` → spawn `cua-driver mcp`
  → 可选 `ensureCursor()`。启动失败不污染插件，下一次调用重试；错误信息带 `CUA_DRIVER_BIN` 提示。
- **单桌面串行**：`host.js` 用一条 promise 链串行化所有 `execute`。同一时间只有一个动作在跑，
  同时让审批请求绑定到当前调用的 agent（`currentAgent` 槽位）。
- **结果投影**：工具返回只保留 `ok/result/image/code/denied/sessionId/agentId`；
  文本结果 +（有截图时）image block 由 `renderResult()` 渲染。

## 3. 数据流

### 3.1 `observe`

```
computer{action:"observe", target, mode, query, maxElements, includeScreenshot, waitFor}
  → tool.observe
  → observer.observe(target, options)
      ├─ target: {kind:"active"} → backend.listWindows() → 前台/z_index 最高且在屏的窗口
      │           {kind:"window",pid,windowId} → backend.getWindowState()
      │           {kind:"screen",index:0} → backend.getDesktopState()
      ├─ backend/cua.js → MCP stdio → cua-driver
      ├─ mapTree(structured.elements)                # id/role/label/frame/actions/value...
      ├─ buildSpace(windowBounds, screenshot)        # 截图空间 = 窗口本地像素
      └─ cache[revision] = observation（TTL 60s）
  → renderTree(observation) → 文本
  → persistImage(attachments, observation)（有 png 且宿主提供 attachments 时）
```

观察对象：`{revision, pid, windowId, title, bounds, space, tree, truncated, truncationReason?, screenshotPng?, waitFor?}`。
`waitFor` 在单次调用内按 `intervalMs` 轮询（默认 250 ms，上限 120 s），命中即返回；未命中标记
`matched=false`，工具结果按 `unverifiable` 审计。

### 3.2 `act`

```
computer{action:"act", op|steps, target, revision?, ...}
  → currentObservation()          # 显式 revision 或最近一次观察；revision TTL 仍未过期
  → ensureSession(agentId)        # 无租约则 begin；别人的租约返回 busy；renew 续期
  → 对每个 step:
      gate.authorize(step)
        ├─ policy.authorize: 硬阻断 → 风险分级 →（需要时）approval.request
        └─ control.assertAgentAllowed: 用户空闲 ≥ 3s → ready；否则拒绝并给 waitSeconds
      → act.execute(backend, step + observation)
          ├─ prepare(op): 校验 target/keys/frame/...，元素坐标换算到截图空间
          ├─ backend.click/typeText/pressKey/hotkey/scroll/drag/moveCursor/
          │           launchApp/bringToFront/setWindowFrame/killApp
          ├─ classifyEffect(raw): confirmed / noop / unverifiable / refused
          └─ READBACK_OPS（click/doubleClick/rightClick/type）且 observeAfter≠false:
                backend.getWindowState() → 与观察树逐 element 比较，返回 {observed, changed, updated}
      → audit.record(...)          # 每 step 一条；失败也记
      → noteAgentAction()          # 仅当 effect != refused
  → 汇总：effect 取最严重者；默认 stopOnError=true；batch 返回 per-step results
```

坐标语义：动作坐标是**最近一次观察的截图空间**中的窗口本地像素；元素动作由元素 `frame` 中心换算，
文本树里的 `@(x,y)` 已经是换算后的坐标。`delivery` 为 `auto/background/foreground`，前台会提升风险等级。

### 3.3 `session`

`tool.sessionAction` 直接操作内存租约与门禁状态，不触碰驱动：

- `status` → 租约快照 + `{control, lastInputAgeMs, waitSeconds}`；
- `begin` / `end` / `takeover(note)` / `resume`；
- `act` 会自动 `begin`，逐个动作 `renew`（TTL 120 s）。租约只存在于进程内，DSH 重启即清空。

## 4. 不变量（改动时必须保持）

1. **只有一个工具**：注册名固定 `computer`，动作由 `action` 枚举区分；不新增散落的 `computer_*` 工具。
2. **动作必须有当前观察**：`act` 需要显式 `revision` 或本进程内最近一次观察；过期/未知 revision 直接报错，
   不做盲动作。`policy` 还会对没有 `observed: true` 的动作返回 `hard-blocked: unobserved-action`。
3. **每个 step 独立授权**：批量动作逐 step 过 policy + control，逐 step 审计；某步被拒不会“顺带”执行后面的步。
4. **effect 不说谎**：只有后端明确成功（或显式 `confirmed`）才是 `confirmed`；
   超时/`background_unavailable`/`unknown` 等一律 `unverifiable`，并带重试建议；拒绝是 `refused`。
5. **硬阻断不可配置绕过**：密码框、UAC/安全桌面、未观察动作在 `classifyRisk` 之前就被拒绝。
6. **审批失败即拒绝**：审批适配器缺失、抛错、返回未知结果都按拒绝处理（fail closed）。
7. **单桌面、单租约、单执行**：`host.js` 串行执行；`session.js` 同一时间只允许一个 agent 持有租约；
   其他 agent 得到 `busy`，不排队。
8. **路径安全**：更新器只接受绝对路径；sha256 校验通过后才写插件目录；目标目录必须声明
   `dsh-computer@<version>` 才能发布/切换；切换前写 previous/pending。
9. **审计不存明文输入、不存截图**：`redactText()` 只留长度与前 16 位 sha256；
   `audit.includeScreenshots` 仅为配置兼容保留，图片字节从不落审计。
10. **后端懒启动且可重试**：插件加载/观察失败不杀 DSH；`dispose` 关闭 MCP 进程。

## 5. 已知限制（与实现一致）

- **defineTool DSL 契约**：`dsh-tools` 的 author DSL 只在值节点上接受 `description/title/default/examples`
  与内联 `required`，无法表达 `minimum/minLength/minItems` 等数值/长度约束。`lib/tool.js` 保留完整
  JSON Schema 作为参考，再经 `toDshParameters()` 投影成 DSL；宿主 schema 不会强制这些范围，
  真正的范围校验发生在 `act.js`/`observe.js`/`config.js` 的运行时检查里。
- **运行中检测是心跳启发式**：`update.mjs` 把“10 分钟内由非 updater 写入的 heartbeat”当作 DSH 在运行。
  当前插件运行时**尚未写 heartbeat**（只有 updater 在 `--apply` 时写 `source:"updater"` 的那条），
  所以 `needsRollback()` 无法确认新版本真的被加载；更新后需要人工检查，不要把它当自动健康检查。
- **cursor**：`ensureCursor()` 在启动时配置会话/主题；`glideTo()` 已实现并有单测，但动作路径尚未调用它，
  所以光标是“可见且已配置”，不是每个动作都滑向目标。
- **控制门禁**：空闲检测依赖 PowerShell + `GetLastInputInfo`（每次调用最多 3 s 超时、1 s 缓存）；
  自身输入用“最近 agent 动作后 700 ms 内不算用户”的启发式抵消，真实用户在这 700 ms 内的输入会被误判。
  `onUnknown:'block'` 在 `createControlGate()` 中可用，但插件配置尚未暴露该字段，默认 `allow`。
- **单显示器**：`target:{kind:"screen"}` 只支持主屏（`index` 缺省或 `0`）；多屏坐标换算未实现。
- **`focused_element`**：cua-driver 0.36 在 Windows 上不报告焦点元素，该等待条件只在行上带显式焦点元数据时命中。
- **观察预算不能取消**：`budgetMs` 只在驱动返回后标记 `truncated`/`budget`，无法中断进行中的 UIA 遍历。
- **回读是启发式**：`verifyAfter()` 比较回读树与观察树的 role/label/value/focused/frame/actions，
  只返回“是否有变化 + 变化数”，不是语义成功判定。
- **配置里暂未生效的项**：`policy.allowedApps` / `policy.blockedApps` / `policy.maxActionsPerMinute`
  已在校验与默认值中，但 policy 尚未消费它们；不要把它们当已生效的限流/白名单。
- **单进程租约**：租约是内存态；DSH 重启或多实例同时运行时，跨进程没有互斥（依赖单实例使用）。
- **发布包内容**：`package.json.files` 只有 `index.js`、`lib/`、`README.md`；`scripts/`、`docs/`、
  `skills/` 不进 npm tarball。安装/自检/更新需要仓库检出，更新器下发的 tarball 只提供运行时。
