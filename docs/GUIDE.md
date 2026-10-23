# 安装、配置与维护指南

[← 返回项目首页](../README.md)

以下命令均在仓库根目录运行。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 |
| Node.js | 24 或更高版本（`>=24.0.0`） |
| DSH Desktop | `>=0.2.1-rc.2 <0.3.0`（`engines.dsh`，不满足会拒绝加载） |
| Cua Driver | `>=0.36`（`cua-driver mcp`；Windows 安装包默认在 `%LOCALAPPDATA%`） |

## 安装

从仓库检出运行（不发布到 npm，也不需要构建）：

```powershell
git clone https://github.com/Curlance/dsh-computer.git
cd dsh-computer
node scripts/install.mjs --dry-run   # 先看计划，不写文件
node scripts/install.mjs             # 复制版本、写 profile 链接/skill、写托管插件行
```

安装器做五件事：

1. 检测并迁移旧的 `dsh-computer-use`（旧预设/旧根行删除，旧包移到
   `~/.dsh/plugins/_backup/`，可用 `node scripts/install.mjs --rollback` 恢复）；
2. 把包复制到 `~/.dsh/plugins/dsh-computer/<version>/`；
3. 把 `~/.dsh/profiles/desktop/node_modules/dsh-computer` 指向该版本（junction）；
4. 把 `skills/computer-use` 复制到 `~/.dsh/skills/computer-use`；已有同名目录先移到
   `~/.dsh/computer/backup/skills-<stamp>`；
5. 在 `~/.dsh/cordis.patch.yml` 写入一段带标记的根插件行。

参数：`--home <path>`（**用户主目录**，DSH 根为 `<path>/.dsh`）；不传 `--home` 时把
`$DSH_HOME` 直接当作 DSH 根（未设置时用 `~/.dsh`）。`--home` 与 `$DSH_HOME` 同时设置时
`$DSH_HOME` 会被忽略，不要混用。另有 `--profile <name>`（默认 `desktop`）、
`--patch <path>`（默认 `<dsh-home>/cordis.patch.yml`）、`--dry-run`、`--rollback`。
**安装后完全退出并重启 DSH**，新会话即可看到 `computer` 工具和 `computer-use` skill。

`package.json#files` 包含 `scripts/`、`docs/`、`skills/`，所以从 tarball 解包后也能运行安装器
并安装 skill；`tests/` 与 `.github/` 不在 tarball 里。

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
- 详细的参数、坐标语义、错误处理见 [`skills/computer-use/SKILL.md`](../skills/computer-use/SKILL.md)。

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
| `policy.allowedApps` / `blockedApps` | `[]` | 按窗口标题（不区分大小写）子串匹配；blocked 优先，非空 allowed 只放行列出的标题 |
| `policy.maxActionsPerMinute` | `60` | 每进程 60 s 滑动窗口；`observe`/`session`/`wait` 不计，重启清零 |
| `audit.path` | `~/.dsh/computer/audit.jsonl` | JSONL 审计；`~` 会展开 |
| `audit.includeScreenshots` | `false` | 仅为配置兼容；截图从不写审计 |
| `backend.timeoutMs` | `15000` | 单次 cua-driver MCP 调用超时 |
| `observation.maxElements` | `250` | UIA 树预算 |
| `observation.maxImageDimension` | `1456` | 截图最长边 |
| `observation.ttlMs` | `60000` | 观察 revision 有效期 |

改配置后重启 DSH（或等 HMR）生效。不要删除托管段的标记；重新运行安装器会保持段内配置幂等。

## 安全

- **审批**：高风险动作（`launch`/`kill`、坐标点击、前台输入、敏感词输入）默认请求用户审批；
  拒绝后不会执行。
- **硬阻断（不可配置绕过）**：密码框（直接阻断，不走审批）、UAC/安全桌面、没有当前观察的盲动作。
- **应用门禁/限流**：`policy.allowedApps` / `blockedApps` 按窗口标题子串拦截；`maxActionsPerMinute` 限制动作频率。
- **控制门禁**：用户 3 秒内有键鼠输入时拒绝动作并返回 `waitSeconds`；自身输入有 700 ms 启发式抵消。
- **租约**：同一时间只有一个 agent 操作桌面（120 s TTL，自动续期）；其他会话得到 `busy`。
- **审计**：默认 `~/.dsh/computer/audit.jsonl`；输入只记长度 + sha256 前缀，不记明文/截图。
- **残余风险**：不是沙箱；硬阻断与空闲检测都是启发式；应用白/黑名单只匹配窗口标题子串，
  限流是进程内窗口（重启清零）；截图会进入模型上下文。完整说明见 [`docs/SAFETY.md`](SAFETY.md)。

## 自动更新

发布走 GitHub Releases（本仓库以 `Curlance/dsh-computer` 为准）：

- tag `v*` 触发发布工作流：测试 → `npm pack` → 生成 `compat.json`（含 tarball sha256）→
  上传 tgz + `compat.json` → 创建 Release；
- 更新器按 `compat.json` 里每个条目的 `dsh` 范围（发布时取自 `package.json#engines.dsh`）选最高兼容版本；
  sha256 校验通过后才写插件目录，原子切换 profile 链接，保留 previous 供 `--rollback`；
- `--apply` 先写 `pending.json`，在写完 `source:"updater"` 心跳后立即清除它；因为运行时还不写心跳，
  pending 只用于发现“切换中途中断”，不是加载成功确认；
- **不做签名**：sha256 只防损坏，信任边界是本仓库与 GitHub 账号。

```powershell
# 完全退出 DSH 后：
node scripts/update.mjs --manifest "https://github.com/Curlance/dsh-computer/releases/latest/download/compat.json" --check
node scripts/update.mjs --manifest "https://github.com/Curlance/dsh-computer/releases/latest/download/compat.json" --apply
node scripts/update.mjs --rollback
```

计划任务（`node scripts/register-task.mjs`，登录时 + 每 6 小时）会传
`--apply --home <home> --manifest <compat URL>`，所以自动更新的命令已接通；但 DSH 运行时仍不写健康心跳，
新版本加载失败不会被自动发现，更新后要人工检查并手动 `--rollback`。细节与故障处理见
[`docs/AUTO-UPDATE.md`](AUTO-UPDATE.md)。

## 卸载

```powershell
node scripts/uninstall.mjs --dry-run
node scripts/uninstall.mjs
```

删除托管插件行、profile 链接、当前版本目录和 `~/.dsh/skills/computer-use`；如果安装时备份过同名
skill，会恢复最近一个 `skills-*` 备份。保留 `~/.dsh/computer/**`（审计、备份等用户数据）。
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

- [架构与不变量](ARCHITECTURE.md) · [安全模型](SAFETY.md) ·
  [自动更新](AUTO-UPDATE.md) · [验证证据](verification.md) ·
  [变更记录](../CHANGELOG.md)
- [设计](superpowers/specs/2026-10-21-dsh-computer-independent-design.md) ·
  [实现计划](superpowers/plans/2026-10-21-dsh-computer-a-b.md)

## 已知限制

- 只支持 Windows 与主显示器；`target:{kind:"screen"}` 不支持多屏。
- `focused_element` 等待条件在 cua-driver 0.36 上通常不命中（驱动不报告焦点元素）。
- `policy.allowedApps` / `blockedApps` 只按窗口标题子串匹配；限流是进程内 60 s 窗口，重启清零。
- AI 光标 glide 覆盖 `click`/`move`/`drag`/元素 `scroll`；`type`/`key`/`wait`/`launch`/`focus`/`resize`/`kill` 不移动光标。
- 观察的 `budgetMs` 只能事后标记超时，不能取消进行中的 UIA 遍历。
- 无运行时健康心跳：更新后无法自动确认新版本加载成功，回滚需要手动执行；无签名。
- npm tarball 含运行时、`scripts/`、`docs/` 和 `skills/`；`tests/`、`.github/` 不在包内。
