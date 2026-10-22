# 安全模型与使用边界

`dsh-computer` 让模型通过 Cua Driver 操作**真实 Windows 桌面**。它不是沙箱，也不提升权限：
插件、计划任务、`cua-driver` 都以当前用户身份运行，能做的操作就是这个用户能做的操作。
本文描述当前实现（`0.1.0`，HEAD `9a8e9de`）真正的安全行为，以及仍然存在的限制。

## 1. 决策顺序

每个动作按固定顺序过闸，任何一步拒绝都不会执行后端调用：

```
观察新鲜度（act 必须带当前 observation）
  → policy.authorize
      1. 硬阻断（不可配置绕过）
      2. 风险分级
      3. 审批（按模式）
  → control.assertAgentAllowed（用户是否正在用桌面）
  → 租约校验/续期（同一时间一个 agent）
  → 后端执行
  → 回读（click/doubleClick/rightClick/type）
  → 审计
```

批量的 `steps[]` 对**每一步**重复上面的授权与审计；默认 `stopOnError=true`，某步被拒绝即停止后续步骤。

## 2. 风险分级

`classifyRisk()` 按以下顺序判定，未知 op 一律按高风险（fail closed）：

| 等级 | 判定 |
| --- | --- |
| low | `observe`、`focus`、`wait`、`move`、`hover`；**元素**点击（`target.element`） |
| medium | `type`（非密码、非敏感词）、`key`、`scroll`、`drag`、`resize` |
| high | `launch`、`kill`、窗口切换类 op；**坐标**点击；`type` 命中密码框或敏感词；`delivery:"foreground"` 下的输入/按键/滚动/拖拽；前台坐标点击；任何未知 op |

敏感词：`密码|支付|转账|删除|发送|提交|password|pay|delete|send|submit`。
密码框：`role` 命中 `password|密码`，或可编辑 role（`edit|textbox|input|textarea|...`）的 `label` 命中密码词。
仅 label 出现 “Password” 不会误判，除非该元素本身是可编辑控件。

## 3. 审批模式

| `approvals.mode` | low | medium | high |
| --- | --- | --- | --- |
| `ask`（默认） | 自动允许 | 允许 | 审批 |
| `strict` | 自动允许 | 审批 | 审批 |
| `relaxed` | 自动允许 | 允许 | 审批 |

- **没有“高风险全自动”模式**：`relaxed` 目前与 `ask` 等价，high 仍然必须审批。
- 审批走 `ctx.approval.request({agent, toolName:"computer", reason, detail})`；
  `detail` 只包含 op、risk、target、delivery、文本长度、sessionId，不含输入明文。
- 只有返回值归一化为 `allowed-once` / `allowed` / `approved`（或 `{allowed:true}`）才算通过；
  拒绝、异常、未知结果、审批服务缺失一律按拒绝处理。
- 拒绝会写审计（`decision:"denied"`），工具结果 `effect:"refused"` 并带原因；不要把它当成功。

## 4. 硬阻断（不可配置绕过）

`isHardBlocked()` 在审批之前执行：

1. **密码框**：目标 role 是密码控件，或可编辑控件的 label 是密码词。
2. **UAC / 安全桌面**：target/action 的 role、label、title、app、process、path、markers 等字段命中
   `user account control|用户账户控制|安全桌面|secure desktop|consent.exe|uac`。
3. **未观察动作**：除 `observe`、`session`、`wait` 外的动作必须带 `observed: true`
   （由工具层用当前 observation 的 `pid` + `windowId` 设置）。

另外在执行规划阶段，`act.js` 会直接拒绝 role 为 `dialog|alert|popup|messagebox` 的元素动作，
以及任何密码 role 的元素；`kill` 只接受显式或观察到的正整数 `pid`。

## 5. 控制权门禁（避免和用户抢桌面）

- 空闲阈值 3000 ms：`lastInputAgeMs >= 3000` → `ready`；否则 `user`，返回 `waitSeconds`。
- 自身动作抵消：最近一次 agent 动作后 700 ms 内，Windows 把 `SendInput` 计入用户输入，
  这段时间按 `ready` 处理。真实用户在这 700 ms 内的输入会被误判为 agent 自己的动作。
- `unknown`（PowerShell/`GetLastInputInfo` 失败、非 Windows）：默认 **放行**，并在 `session.status`
  里显示 `control:"unknown"`。代码支持 `onUnknown:"block"`，但尚未暴露为插件配置项。
- 用户显式 `session.takeover` 会挂起租约：之后 `renew`/`assertActive` 返回 `takeover` 错误，
  直到 `session.resume`。

## 6. 租约与并发

- 内存单租约，默认 TTL 120 s；`act` 自动 `begin`，每个动作 `renew`。
- 租约属于 `agentId`；另一个 agent 申请/使用会得到 `busy`，不排队、不阻塞等待。
- 同一进程内 `host.js` 还把所有工具执行串行化，避免两个动作同时落到一个桌面。
- 租约不跨进程：DSH 重启后清空；不要同时开多个 DSH 实例操作同一桌面。

## 7. 审计

- 默认路径：`~/.dsh/computer/audit.jsonl`（可配置 `audit.path`，安装器写入
  `~/.dsh/computer/audit.jsonl`）。
- 每条记录：`ts`、`sessionId`、`agentId`、`action`、`target`、`risk`、`decision`、`effect`、
  `durationMs`、`observationRevision`，输入文本额外记 `inputSummary:{length, sha256Prefix}`。
- 追加写按调用顺序串行；写失败会让该次调用返回错误，但**动作可能已经执行**——审计失败不是回滚。
- 截图从不写入审计（`includeScreenshots` 仅为配置兼容保留）。

## 8. 已知限制与残余风险

- **不是安全沙箱**：模型可以看屏幕、读控件文本、向应用输入。屏幕内容可能包含密码、令牌、私人信息；
  审批提示是最后一道人工检查，不要对不可信提示词/网页放行高风险动作。
- **启发式而非原生监听**：控制门禁靠 `GetLastInputInfo` + 700 ms 抵消，无法 100% 自动让路；
  真正的全局输入监听需要原生模块，A+B 不包含。
- **硬阻断是启发式**：UIA 不可见/本地化异常的密码框、自定义安全界面可能漏判；
  不要依赖它替代 Windows 自身的 UAC/登录边界。
- **配置项未生效**：`policy.allowedApps`、`policy.blockedApps`、`policy.maxActionsPerMinute`
  目前只做校验/默认值，policy 不消费它们——**没有应用白/黑名单，也没有动作限流**。
- **子 agent 无独立限制**：根插件行对所有会话可见；租约只保证串行，不区分主/子 agent 的权限。
- **截图会进入模型上下文**：`includeScreenshot` 默认随 `mode`（`tree` 时为 false），
  但视觉模型调用会得到图片附件；敏感桌面请用 `mode:"tree"`。
- **更新信任边界**：自动更新只做 sha256 完整性校验，不签名；信任根是本仓库的 GitHub Releases
  与账号。详见 [AUTO-UPDATE.md](AUTO-UPDATE.md)。
- **审计写入在动作之后**：审计失败不会撤销已发生的点击/输入。

## 9. 操作建议

1. 高风险操作（发送、支付、删除、提交、启动/结束进程、系统设置）让用户在审批里逐次确认；
   被拒绝后不要换参数重试同一动作。
2. 先 `observe` 再 `act`；目标窗口/元素变了就重新观察，不复用旧 element id。
3. 用户开始操作桌面时停手：`session.status` 显示 `control:"user"` 就等待，或让用户
   `session.takeover`；完成后 `session.resume`。
4. 不在多个会话/多个 DSH 实例里同时操作桌面。
5. 排查问题时先跑 `node scripts/doctor.mjs`，再看审计与 `session.status`。
