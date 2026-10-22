# dsh-computer

独立自研的 DSH 常驻插件：给所有标准会话一个统一的 `computer` 工具，用 Cua Driver 观察和操作
Windows 桌面。纯 ESM JavaScript + JSDoc，零构建、零运行时依赖。

- 没有 `Computer Use` 预设，也不需要切模式；工具常驻，模型按需调用。
- 观察（截图 + UIA 控件树）→ 动作 → 回读验证；`unverifiable` 不会被当成成功。
- 可见 AI 光标、风险审批、不可绕过的硬阻断、用户接管、JSONL 审计。
- 安装/卸载/自检/更新脚本；GitHub Releases + sha256 的自动更新基础。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Node.js | 24.x（`>=24.0.0`） |
| DSH Desktop | `>=0.2.1-rc.2 <0.3.0`（`engines.dsh`，不满足会拒绝加载） |
| Cua Driver | `>=0.36`（`cua-driver mcp`；Windows 安装包默认在 `%LOCALAPPDATA%`） |

## 安装

从仓库检出运行（不发布到 npm，也不需要构建）：

```powershell
git clone https://github.com/Curlance/dsh-computer.git
cd dsh-computer
node scripts/install.mjs --dry-run   # 先看计划，不写文件
node scripts/install.mjs             # 复制版本目录、写 profile 链接、写托管插件行
```

安装器做四件事：

1. 检测并迁移旧的 `dsh-computer-use`（旧预设/旧根行删除，旧包移到
   `~/.dsh/plugins/_backup/`，可用 `node scripts/install.mjs --rollback` 恢复）；
2. 把包复制到 `~/.dsh/plugins/dsh-computer/<version>/`；
3. 把 `~/.dsh/profiles/desktop/node_modules/dsh-computer` 指向该版本（junction）；
4. 在 `~/.dsh/cordis.patch.yml` 写入一段带标记的根插件行。

参数：`--home <path>`（DSH home 的父目录，默认 `$DSH_HOME` 或 `~`）、
`--profile <name>`（默认 `desktop`）、`--patch <path>`（默认 `<dsh-home>/cordis.patch.yml`）、
`--dry-run`、`--rollback`。**安装后完全退出并重启 DSH**，新会话即可看到 `computer` 工具。

## 自检（doctor）

```powershell
node scripts/doctor.mjs
node scripts/doctor.mjs --json
```

检查项：

- `dsh-version`：能探测到 DSH 运行时版本（`DSH_VERSION` → `DSH_APP_PACKAGE_JSON` →
  `<dsh-home>/version` → 解包桌面的 `resources/app/package.json`（仅信任 DSH 包名）→ `dsh --version`）；
- `dsh-compat`：版本落在 `>=0.2.1-rc.2 <0.3.0`；
- `cua-driver`：`CUA_DRIVER_BIN` / PATH / 官方安装位置能找到 `cua-driver.exe`；
- `cordis-patch`：托管插件行存在；
- `plugin-install`：版本目录存在且 profile 链接指向它。

任一失败退出码为 1。驱动缺失时按提示安装 Cua Driver 或设置 `CUA_DRIVER_BIN`。

## 使用：一个 `computer` 工具

标准会话（无预设）里模型可以直接调用。先观察：

```json
{ "action": "observe", "target": { "kind": "active" }, "mode": "both" }
```

返回 `revision`、`space=宽x高` 和控件行：

```
revision=7 window="记事本" space=1456x912
[s00000001:2] Document "文本编辑器" @(720,456) TextPattern
```

再用元素 id 或截图空间坐标动作：

```json
{
  "action": "act",
  "op": "type",
  "target": { "element": "s00000001:2" },
  "text": "hello"
}
```

```json
{ "action": "act", "op": "key", "keys": ["ctrl", "s"] }
```

```json
{ "action": "session", "op": "status" }
```

- `action`：`observe` / `act` / `session`。
- `act` 的 `op`：`click`、`doubleClick`、`rightClick`、`move`、`type`、`key`、`scroll`、`drag`、
  `wait`、`launch`、`focus`、`resize`、`kill`；可用 `steps[]` 批量顺序执行。
- 坐标是**最近一次观察的截图空间**里的窗口本地像素；元素动作优先，避免坐标点击。
- 动作需要当前观察（`revision` 或本进程最近一次观察，默认 60 s 过期）；先观察再动作。
- `effect` 为 `confirmed` / `noop` / `unverifiable` / `refused`；`unverifiable` 不是成功。
- 详细的参数、坐标语义、错误处理见 [`skills/computer-use/SKILL.md`](skills/computer-use/SKILL.md)。

## 配置

安装器写入的托管段在 `~/.dsh/cordis.patch.yml`，形如：

```yaml
# >>> dsh-computer (managed)
- insert:
    - id: dsh-computer
      name: dsh-computer
      config:
        cursor:
          enabled: true
          theme: cua.default
          idleHideMs: 0
          glideMs: 600
        approvals:
          mode: ask
        policy:
          allowedApps: []
          blockedApps: []
          maxActionsPerMinute: 60
        audit:
          path: ~/.dsh/computer/audit.jsonl
          includeScreenshots: false
        backend:
          timeoutMs: 15000
        observation:
          maxElements: 250
          maxImageDimension: 1456
          ttlMs: 60000
# <<< dsh-computer
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `cursor.enabled` | `true` | 显示独立 AI 光标；关掉则完全不启动光标会话 |
| `cursor.theme` / `idleHideMs` / `glideMs` | `cua.default` / `0` / `600` | Cua 主题与轨迹参数 |
| `approvals.mode` | `ask` | `ask`：高风险审批；`strict`：中/高风险审批；`relaxed` 当前等同 `ask` |
| `policy.allowedApps` / `blockedApps` | `[]` | **已校验但尚未被 policy 消费**（见限制） |
| `policy.maxActionsPerMinute` | `60` | **已校验但尚未限流** |
| `audit.path` | `~/.dsh/computer/audit.jsonl` | JSONL 审计；`~` 会展开 |
| `audit.includeScreenshots` | `false` | 仅为配置兼容；截图从不写审计 |
| `backend.timeoutMs` | `15000` | 单次 cua-driver MCP 调用超时 |
| `observation.maxElements` | `250` | UIA 树预算 |
| `observation.maxImageDimension` | `1456` | 截图最长边 |
| `observation.ttlMs` | `60000` | 观察 revision 有效期 |

改配置后重启 DSH（或等 HMR）生效。不要删除托管段的标记；重新运行安装器会保持段内配置幂等。

## 安全

- **审批**：高风险动作（`launch`/`kill`、坐标点击、前台输入、密码框/敏感词输入）默认请求用户审批；
  拒绝后不会执行。
- **硬阻断（不可配置绕过）**：密码框、UAC/安全桌面、没有当前观察的盲动作。
- **控制门禁**：用户 3 秒内有键鼠输入时拒绝动作并返回 `waitSeconds`；自身输入有 700 ms 启发式抵消。
- **租约**：同一时间只有一个 agent 操作桌面（120 s TTL，自动续期）；其他会话得到 `busy`。
- **审计**：默认 `~/.dsh/computer/audit.jsonl`；输入只记长度 + sha256 前缀，不记明文/截图。
- **残余风险**：不是沙箱；硬阻断与空闲检测都是启发式；应用白/黑名单和限流尚未生效；
  截图会进入模型上下文。完整说明见 [`docs/SAFETY.md`](docs/SAFETY.md)。

## 自动更新

发布走 GitHub Releases（本仓库以 `Curlance/dsh-computer` 为准）：

- tag `v*` 触发发布工作流：测试 → `npm pack` → 生成 `compat.json`（含 tarball sha256）→
  上传 tgz + `compat.json` → 创建 Release；
- 更新器按 `engines.dsh` 选最高兼容版本，sha256 校验通过后才写插件目录，原子切换 profile 链接，
  保留 previous 与 pending 标记（切换确认后清除 pending）以便 `--rollback`；
- **不做签名**：sha256 只防损坏，信任边界是本仓库与 GitHub 账号。

```powershell
# 完全退出 DSH 后：
node scripts/update.mjs --manifest "https://github.com/Curlance/dsh-computer/releases/latest/download/compat.json" --check
node scripts/update.mjs --manifest ".../compat.json" --apply
node scripts/update.mjs --rollback
```

**已知缺口**：计划任务（`node scripts/register-task.mjs`）目前只传 `--home`，没有
`--manifest`/`--apply`，所以任务会以用法错误退出，自动更新尚未真正接通；请先手动执行上面的命令。
插件运行时也还没有写健康心跳，更新后回滚是手动的。细节与故障处理见
[`docs/AUTO-UPDATE.md`](docs/AUTO-UPDATE.md)。

## 卸载

```powershell
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

删除托管插件行、profile 链接和当前版本目录；保留 `~/.dsh/computer/**`（审计、备份等用户数据）。
卸载后重启 DSH。要恢复被迁移的旧版：先卸载，再 `node scripts/install.mjs --rollback`。

## 开发与测试

```powershell
npm test                        # node --test tests/*.test.mjs
node --test tests/tool.test.mjs # 单个文件
node scripts/smoke.mjs          # 真机只读冒烟（需要桌面 + cua-driver）
node scripts/smoke-action.mjs   # 真机动作冒烟（会启动/清理一个 mshta 目标）
```

单测不需要 DSH、桌面或 cua-driver（宿主/驱动/时钟都是注入的）；冒烟脚本才会碰真实桌面。
CI 为 `.github/workflows/ci.yml`（windows-latest + Node 24 + `npm test`），不安装驱动。

## 文档

- [架构与不变量](docs/ARCHITECTURE.md) · [安全模型](docs/SAFETY.md) ·
  [自动更新](docs/AUTO-UPDATE.md) · [验证证据](docs/verification.md) ·
  [变更记录](CHANGELOG.md)
- [设计](docs/superpowers/specs/2026-10-21-dsh-computer-independent-design.md) ·
  [实现计划](docs/superpowers/plans/2026-10-21-dsh-computer-a-b.md)

## 已知限制

- 只支持 Windows 与主显示器；`target:{kind:"screen"}` 不支持多屏。
- `focused_element` 等待条件在 cua-driver 0.36 上通常不命中（驱动不报告焦点元素）。
- `policy.allowedApps` / `blockedApps` / `maxActionsPerMinute` 尚未生效；没有应用白/黑名单与限流。
- AI 光标在启动时配置，动作路径还没有逐动作 glide。
- 观察的 `budgetMs` 只能事后标记超时，不能取消进行中的 UIA 遍历。
- 计划任务自动更新未接通（缺 `--manifest`/`--apply`）；无运行时健康心跳；无签名。
- npm tarball 只含 `index.js`、`lib/`、`README.md`；`scripts/`、`docs/`、`skills/` 需要仓库检出。
