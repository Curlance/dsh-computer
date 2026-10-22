# 自动更新与发布

`dsh-computer` 的更新器独立于 DSH 运行：DSH 升级后旧版本可能因 `engines.dsh` 不满足而无法加载，
所以不能只靠插件自己更新。当前实现由仓库脚本 + Windows 计划任务 + GitHub Releases 组成。

> 结论先说：**发布/校验/原子切换/回滚的代码已实现并有单测；但“计划任务自动跑起来”这一步还没接通**。
> 计划任务注册的命令不带 `--manifest` / `--apply`，当前会以用法错误退出；自动更新需要手动执行
> `scripts/update.mjs`。详见第 6 节。

## 1. 信任根

- 更新源固定为本仓库的 GitHub Releases（README 以 `Curlance/dsh-computer` 为准）；
  发布工作流用 `${{ github.repository }}` 生成下载 URL，所以 fork 也能产出指向自己的 `compat.json`。
- 完整性：每个版本在 `compat.json` 里带 tarball 的 sha256；下载后先校验，再写任何插件目录。
- **不做签名**（评审决定）：sha256 只防损坏/传输错误，不防仓库账号被篡改。
  信任边界 = 本仓库 + GitHub 账号。
- 协议：代码接受 `http(s)`；请只使用 HTTPS。没有镜像、没有增量更新、没有静默大版本跳跃
  （跨 DSH 大版本必须在 `compat.json` 里显式声明范围）。

## 2. 发布产物

打 tag `v*` 触发 `.github/workflows/release.yml`：

1. `windows-latest` + Node 24，先跑 `npm test`；
2. 校验 tag 与 `package.json.version` 一致（`v0.1.0` ↔ `0.1.0`），不一致直接失败；
3. `npm pack` → `dsh-computer-<version>.tgz`；
4. 计算小写 sha256；
5. 生成 `compat.json`：

```json
{
  "versions": [
    {
      "version": "0.1.0",
      "dsh": ">=0.2.1-rc.2 <0.3.0",
      "tarball": "https://github.com/<owner>/<repo>/releases/download/v0.1.0/dsh-computer-0.1.0.tgz",
      "sha256": "<64 hex>"
    }
  ]
}
```

6. 上传 tgz + `compat.json` 为 Actions artifact，并用 `gh release create` 创建 GitHub Release。

注意：**每个 tag 只生成自己的一个条目**。`selectVersion()` 读的是单个 manifest；
如果要同时支持多个 DSH 版本，需要维护一个累积的 `compat.json`（把所有仍受支持的版本条目放进去），
而不是只指向最新 Release 的单条目文件。当前工作流不合并历史条目。

`package.json.files` 只包含 `index.js`、`lib/`、`README.md`，所以 tarball 是可运行的最小包；
安装/自检/计划任务脚本只在仓库检出里，不随更新下发。

## 3. 版本选择

`lib/update/compat.js#selectVersion(manifest, currentDsh)`：

- 当前 DSH 版本未知 → `null`（调用方必须显式处理，不猜）；
- 逐条跳过非法条目：version 非 semver、`dsh` 范围为空、tarball 不是 `http(s)`、sha256 非 64 hex、
  `dsh` 范围不匹配当前 DSH；
- 在合法条目里按 semver 取**最高**版本；
- 没有候选 → `null`。

`package.json` 的 `engines.dsh` 与 `lib/compat.js#DSH_REQUIREMENT` 保持一致
（`>=0.2.1-rc.2 <0.3.0`）。DSH 版本探测（`lib/compat.js#detectDshVersion`，`doctor` 复用同一实现）：
`DSH_VERSION` → `DSH_APP_PACKAGE_JSON` → `<dsh-home>/version` →
解包桌面的 `resources/app/package.json` / 安装根 `package.json`（只采信 DSH 包名）→
`dsh --version`（win32 经 `cmd.exe` shim）→ `null`。

## 4. 手动更新流程

```powershell
# 1) 查看当前版本、DSH 版本与可用版本（不写文件）
node scripts/update.mjs --manifest "https://github.com/Curlance/dsh-computer/releases/latest/download/compat.json" --check

# 2) 完全退出 DSH 后应用（会校验 sha256、解包、原子切换、备份 patch）
node scripts/update.mjs --manifest ".../compat.json" --apply

# 3) 需要时回滚到上一个版本 + 切换前的 cordis.patch.yml
node scripts/update.mjs --rollback

# 机器可读输出
node scripts/update.mjs --manifest ... --check --json
```

- `--manifest` 也接受本地文件路径，便于离线/自建镜像。
- `--apply` 前会检查“DSH 是否在运行”（见第 5 节）与“上一次切换是否未确认”；
  任一成立就拒绝切换并给出可操作错误。
- 当前已安装版本等于选中版本时，`--apply` 返回 `changed:false`，不重复下载。

### 安装核心的安全不变量（`lib/update/install.js`）

1. 只接受绝对路径；
2. sha256 不匹配抛 `IntegrityError`，不留下半成品插件目录；
3. 解包到 `plugins/.install-*` 临时目录，校验 `package.json` 的 `name === "dsh-computer"` 且
   `version` 匹配后才 `rename` 到 `plugins/dsh-computer-<version>`；
4. 目标版本目录已存在且身份匹配时直接复用；
5. 切换前写 `previous.json`（含 patch 备份路径）与 `pending.json`，再原子替换 profile junction；
   Windows 无法用 rename 覆盖已有 junction 时退化为 `unlink` + `rename`（有短暂空窗，
   靠 previous/pending 兜底）；
6. 回滚要求 previous 目录存在；如果切换前备份过 patch，备份文件也必须存在，缺失时明确报错，不静默跳过。

> 解包使用系统 `tar`，没有额外的路径穿越过滤。tarball 来自受信任 Release 且 sha256 已校验；
> 能改写 Release 的攻击者本来就在信任边界内。

## 5. 运行中检测（心跳启发式）

`update.mjs` 默认把满足以下条件的 `heartbeat.json` 视为“DSH 正在运行”：

- 文件位于 `<dsh-home>/computer/update/heartbeat.json`；
- 最近 10 分钟内写入；
- `source !== "updater"`。

心跳缺失 → 视为未运行；心跳不可读/JSON 错误 → 视为在运行（避免带病切换）；
`source === "updater"` → 视为更新器自己写的，不算运行。

**当前限制**：插件运行时还没有写 heartbeat 的代码。只有 `update.mjs --apply` 会写一条
`source:"updater"` 的心跳，并且紧接着 `clearPending()`。因此：

- `needsRollback()` 只能发现“切换过程中崩溃/中断”，无法发现“新版本加载失败”；
- 更新后没有一个由 DSH 运行时确认的健康信号，回滚是**手动**的（`--rollback`）；
- 计划任务也无法靠运行时心跳判断 DSH 是否在运行。

设计中的“插件 apply 成功后写心跳、下次计划任务据此回滚”尚未实现。

## 6. 计划任务

```powershell
node scripts/register-task.mjs --dry-run   # 只打印注册命令
node scripts/register-task.mjs             # 注册 dsh-computer-updater（登录时 + 每 6 小时）
node scripts/unregister-task.mjs           # 删除任务
```

任务以当前用户身份运行，命令形如：

```
"<node.exe>" "<repo>\scripts\update.mjs" --home "<home>"
```

**已知缺口**：`update.mjs` 要求 `--check` / `--apply` / `--rollback` 三选一，且 `--check`/`--apply`
必须带 `--manifest`；注册器当前只传 `--home`。所以任务会以用法错误退出，不会自动更新。
在脚本补齐参数之前，请手动执行第 4 节的命令，或自行注册一个带 `--manifest ... --apply` 的任务。
`lib/update/notify.js` 的 toast 也还没有被更新器调用，失败/回滚目前只体现在退出码与输出。

计划任务与 DSH 同用户权限，不提升权限；卸载/删除任务不会删除已安装的插件或用户数据。

## 7. 故障与回滚

| 场景 | 行为 |
| --- | --- |
| tarball 下载失败 / HTTP 非 2xx | 抛错，退出码 1，旧版本不动 |
| sha256 不匹配 | `IntegrityError`，退出码 1，不写插件目录 |
| 解包/身份校验失败 | 清理临时目录，旧版本不动 |
| 切换中途失败 | previous/pending 保留，`--rollback` 可恢复链接与 patch |
| 新版本加载失败 | 当前不会自动发现；先看 `doctor`/DSH 日志，再 `--rollback` |
| 无兼容版本 | `--check` 显示 none；`--apply` 拒绝并提示 DSH 版本 |
| 上一次切换未确认 | `--apply` 要求先 `--rollback` |

回滚后建议重跑 `node scripts/doctor.mjs`；它检查 DSH 版本/兼容、cua-driver、托管 patch 行、
版本目录与 profile 链接。

## 8. 发布检查清单（本地）

1. `npm test` 通过（当前 384 个测试，0 失败，见 [verification.md](verification.md)）；
2. `package.json.version` 与准备打的 tag 一致；
3. `node scripts/doctor.mjs` 在真机安装上通过；
4. 打 tag `v<version>` 并推送（**Task 20 不推送、不发布**；由维护者执行）；
5. 在 Actions 里确认：测试绿、tgz 与 `compat.json` 已上传、Release 附件齐全；
6. 下载 Release 的 tgz 复核 sha256，再让一台测试机跑 `--manifest ... --check` / `--apply`。
