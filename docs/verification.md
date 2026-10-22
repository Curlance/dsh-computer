# Verification evidence

## Task 19 — Windows real-machine smoke (2026-10-22)

### Environment

- Windows 11 家庭版 中文版 10.0.26200 (build 26200)
- Node.js v24.16.0
- cua-driver 0.36.0, `C:\Users\b1778\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`
- HEAD at run time for the fix runs below: `feature/a-b` at the
  `docs: CI, architecture, safety, auto-update and skill` commit, plus the
  then-uncommitted fixes to `scripts/smoke.mjs`, `scripts/smoke-action.mjs` and
  this file. Those fixes were committed as
  `fix: smoke failure propagation and readback proof`.
- The original Task 19 runs were made with the then-uncommitted smoke scripts on top of `bf108c3`; the scripts landed as `9a8e9de`. The earlier wording here called `bf108c3` the run HEAD, which was misleading because that commit did not contain the scripts.
- Both real runs printed a stderr notice that cua-driver 0.37.0 is available; the installed 0.36.0 was used.

### Commands

```powershell
node scripts/smoke.mjs
node scripts/smoke-action.mjs
$env:SMOKE_FORCE_FAIL = 'backend-start'
node scripts/smoke-action.mjs
node scripts/smoke.mjs
$env:CUA_DRIVER_BIN = 'C:\definitely-missing\cua-driver.exe'
node scripts/smoke.mjs
node scripts/smoke-action.mjs
```

Both real runs exited `0`. Both forced-failure runs and both missing-driver runs exited `1`.

### `scripts/smoke.mjs` — read-only desktop smoke (raw stdout)

```json
{
  "ok": true,
  "checks": [
    {
      "name": "driver",
      "ok": true,
      "ms": 2,
      "detail": "C:\\Users\\b1778\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe"
    },
    {
      "name": "backend-start",
      "ok": true,
      "ms": 455,
      "detail": "cua-driver 0.36.0 ready"
    },
    {
      "name": "list-windows",
      "ok": true,
      "ms": 198,
      "detail": "14 windows"
    },
    {
      "name": "observe-active",
      "ok": true,
      "ms": 276,
      "detail": "title=\"dsh-pet 桌宠（桌面模式）\"; tree=4; screenshot=101353B; truncated=false; budget=1500ms"
    }
  ]
}
```

`observe` 276 ms (budget 1500 ms); no `slow` warning.

### `scripts/smoke-action.mjs` — owned target, click/type/readback (raw stdout)

```json
{
  "ok": true,
  "checks": [
    {
      "name": "driver",
      "ok": true,
      "ms": 3,
      "detail": "C:\\Users\\b1778\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe"
    },
    {
      "name": "backend-start",
      "ok": true,
      "ms": 498,
      "detail": "cua-driver 0.36.0 ready"
    },
    {
      "name": "target-setup",
      "ok": true,
      "ms": 6,
      "detail": "hta=C:\\Users\\b1778\\AppData\\Local\\Temp\\dsh-smoke-Af2VEO\\target.hta"
    },
    {
      "name": "cursor-session",
      "ok": true,
      "ms": 38,
      "detail": "session=dsh-smoke-22448-1792669150107"
    },
    {
      "name": "launch-target",
      "ok": true,
      "ms": 2157,
      "detail": "pid=5296; window=11077872; title=\"DSH-SMOKE-TARGET-1792669150104\""
    },
    {
      "name": "observe",
      "ok": true,
      "ms": 246,
      "detail": "title=\"DSH-SMOKE-TARGET-1792669150104\"; tree=7; screenshot=39274B; truncated=false; budget=1500ms"
    },
    {
      "name": "click-editor",
      "ok": true,
      "ms": 381,
      "detail": "element s00000001:2; effect=unverifiable; budget=800ms"
    },
    {
      "name": "type-marker",
      "ok": true,
      "ms": 1187,
      "detail": "effect=unverifiable; marker=DSH-MARKER-1792669150104"
    },
    {
      "name": "readback",
      "ok": true,
      "ms": 84,
      "detail": "edit.value=\"DSH-MARKER-1792669150104\"; valueMatch=true; markerRows=1; budget=1500ms"
    },
    {
      "name": "cursor-position",
      "ok": true,
      "ms": 849,
      "detail": "{\"x\":728.68,\"y\":55.12}"
    },
    {
      "name": "kill-target",
      "ok": true,
      "ms": 43,
      "detail": "pid=5296"
    }
  ]
}
```

| stage | measured | budget |
| --- | ---: | ---: |
| observe | 246 ms | 1500 ms |
| element click | 381 ms | 800 ms |
| readback | 84 ms | 1500 ms |
| backend start | 498 ms | — |
| launch + window | 2157 ms | — |
| type marker | 1187 ms | — |
| agent-cursor state | 849 ms | — |
| kill target | 43 ms | — |

No `slow` warnings. The readback check requires the editor's own `Edit.value`
to include the marker (`valueMatch=true`); a matching marker anywhere in the
UIA tree is reported only as `markerRows` detail and cannot pass the check.
The target process was terminated by the pid returned from `launch_app`.

`lib/observe.js` constructs its truncation flag from `budgetMs`; both smoke
scripts now pass `budgetMs: 1500`, so `truncated=true(reason)` is surfaced in
the same units as the documented budget instead of the observer's 1200 ms
default.

### Incident disclosure — Notepad probe and user tabs

During the probe that established why Notepad cannot be used (below), the probe
opened a packaged Notepad process that held the user's restored session, and
then closed that process. The restored window contained the tabs
`*hello dsh 091246` (the leading `*` is Notepad's unsaved-changes marker) and
`试玩说明.txt`.

- No user data was intentionally modified: the probe did not type into, save,
  overwrite or delete anything.
- Opening and closing a restored Notepad session can still affect unsaved tab
  state, so the user should check Notepad and restore the `*hello dsh 091246`
  content if it was not saved.
- **The committed action smoke does NOT use Notepad.** `scripts/smoke-action.mjs`
  launches `mshta.exe` with a generated `.hta` and kills only the pid returned
  by that launch.

### Why the action target is a generated `.hta`, not Notepad

On this Windows build, packaged Notepad cannot provide an isolated instance or
window. Probe evidence with cua-driver 0.36:

- `launch_app { aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" }` returned
  an existing user window (`试玩说明.txt - Notepad`, pid 22776) whose tabs were
  `hello dsh 091246` and `试玩说明.txt`.
- A following `launch_app { name: "notepad.exe" }` restored the same user tabs
  (`*hello dsh 091246 - Notepad`, `试玩说明.txt - Notepad`), i.e. Notepad session
  restore runs on every launch.
- One launch pid was refused by `kill_app`:
  `standard mode may terminate only a process proven to have been launched by this Cua runtime`.

Closing or typing into that window would touch the user's Notepad session, so
`smoke-action.mjs` launches `mshta.exe` with a generated `.hta` containing one
`<textarea>`. That gives a native UIA `Edit` element with `set_value` in a
process launched by the script; the script reads the marker back from
`Edit.value` and kills only the pid returned by `launch_app`. The AI cursor uses
a unique session label (`dsh-smoke-<pid>-<timestamp>`), ended in cleanup.

### Failure propagation and exit codes

Every stage in both scripts runs through a wrapper that records the stage name
and error, then rethrows to a top-level recorder that adds a failed `fatal`
check. Any exception — including startup, temp-file setup, intermediate
observations and `execute` calls — therefore ends in `ok:false` and exit `1`;
it can no longer leave earlier successful checks and exit `0`.

Hermetic negative test (no desktop work; the stage throws before the MCP
transport is created):

```powershell
$env:SMOKE_FORCE_FAIL = 'backend-start'
node scripts/smoke-action.mjs
```

Raw stdout, exit `1`:

```json
{
  "ok": false,
  "checks": [
    {
      "name": "driver",
      "ok": true,
      "ms": 3,
      "detail": "C:\\Users\\b1778\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe"
    },
    {
      "name": "backend-start",
      "ok": false,
      "ms": 0,
      "detail": "forced failure at stage \"backend-start\" (negative test)"
    },
    {
      "name": "fatal",
      "ok": false,
      "ms": 0,
      "detail": "backend-start: forced failure at stage \"backend-start\" (negative test)"
    }
  ]
}
```

`node scripts/smoke.mjs` with the same variable exits `1` with the same shape:

```json
{
  "ok": false,
  "checks": [
    {
      "name": "driver",
      "ok": true,
      "ms": 2,
      "detail": "C:\\Users\\b1778\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe"
    },
    {
      "name": "backend-start",
      "ok": false,
      "ms": 0,
      "detail": "forced failure at stage \"backend-start\" (negative test)"
    },
    {
      "name": "fatal",
      "ok": false,
      "ms": 0,
      "detail": "backend-start: forced failure at stage \"backend-start\" (negative test)"
    }
  ]
}
```

`SMOKE_FORCE_FAIL` accepts a stage name documented in the script (for
`smoke-action.mjs`: `driver`, `backend-start`, `target-setup`, `cursor-session`,
`launch-target`, `observe`, `click-editor`, `type-marker`, `readback`,
`cursor-position`). An unknown name (including cleanup stages such as
`kill-target`) fails before any desktop work; it never silently runs the full
smoke or skips cleanup.

Missing-driver test (kept from the original report):

```powershell
$env:CUA_DRIVER_BIN = 'C:\definitely-missing\cua-driver.exe'
node scripts/smoke.mjs
node scripts/smoke-action.mjs
```

Both printed `ok:false` with a failed `driver` check and a failed `fatal` check,
detail
`cua-driver not found (C:\definitely-missing\cua-driver.exe); install Cua Driver or set CUA_DRIVER_BIN`,
and exited `1`. Raw stdout for the action script:

```json
{
  "ok": false,
  "checks": [
    {
      "name": "driver",
      "ok": false,
      "ms": 0,
      "detail": "cua-driver not found (C:\\definitely-missing\\cua-driver.exe); install Cua Driver or set CUA_DRIVER_BIN"
    },
    {
      "name": "fatal",
      "ok": false,
      "ms": 0,
      "detail": "driver: cua-driver executable not found"
    }
  ]
}
```

Cleanup failures for `end_session`, client close and temp-directory removal are
reported under `warnings` instead of being swallowed; a failed `kill_app` is a
failed `kill-target` check and therefore exits `1`.

### Cleanup observation

After the real runs: no `mshta.exe` process remained; the run's own
`dsh-smoke-<random>` temp directory was removed. A stale
`dsh-smoke-target.hta` (2026-10-22 19:19, from pre-fix probing) remained in
`%TEMP%`; the current scripts do not create or use that file.

### Verification of the fix

```powershell
node --check scripts/smoke.mjs
node --check scripts/smoke-action.mjs
node --test tests/*.test.mjs
```

`node --check` passed for both scripts. Test suite: **384 tests, 383 pass,
1 skipped, 0 fail**.

## Task 20 — local CI/docs validation (2026-10-22)

Scope: repository checks only. No GitHub push, no release, no real-machine DSH
reinstall in this task (the Task 19 smoke above covers the driver path, not the
standard-session / approval flow).

### Environment

- Repo working tree at `0.1.0`; run on the Windows 11 machine from Task 19.
- Node.js v24.16.0, npm 11.19.0.
- The Task 20 runs used `228f7e3` plus its then-uncommitted docs/workflow
  changes; those changes were committed as the `docs: CI, architecture, safety,
  auto-update and skill` commit.

### Test suite

```powershell
npm test
```

Result: **384 tests, 383 pass, 1 skipped, 0 fail** (`duration_ms` ≈ 5.1 s).
The skipped test is declared skipped in the suite; no test touches the real
desktop, `~/.dsh` or `cua-driver` (host/driver/clock are injected).

### Package contents

```powershell
npm pack --dry-run
```

Tarball `dsh-computer-0.1.0.tgz`: **23 files, 61.3 kB packed / 216.0 kB
unpacked**, containing only `README.md`, `index.js`, `lib/**` and
`package.json` (the `files` allowlist). `scripts/`, `docs/`, `skills/` and
`.github/` are intentionally not in the tarball, so installer/doctor/updater
and the skill require a repository checkout.

> Follow-up: `0d3d7f5` added `scripts/`, `docs/` and `skills/` to `files`;
> the current tarball includes installer/doctor/updater and the skill. See the
> Task 20 fix pass below.

### Workflow syntax

```powershell
python -c "import yaml; [yaml.safe_load(open(p, encoding='utf-8')) for p in ['.github/workflows/ci.yml', '.github/workflows/release.yml']]"
```

Both workflows parse as YAML. CI/release were **not** executed: there is no
remote configured in this checkout and this task does not push. Release
behavior (tag/version check, `compat.json`, artifact upload, `gh release
create`) is therefore unverified until the first tagged run.

### Docs cross-check

Read against the current modules (`lib/tool.js`, `lib/host.js`, `lib/act.js`,
`lib/observe.js`, `lib/policy.js`, `lib/control.js`, `lib/session.js`,
`lib/audit.js`, `lib/update/*`, `scripts/*`). Documented limitations that are
true in code today: defineTool DSL cannot express numeric bounds; the runtime
does not write a health heartbeat; the scheduled updater task does not pass
`--manifest`/`--apply`; app allow/block lists and the per-minute action limit
are validated but not enforced; only the primary display is supported.

> Follow-up: `b3687ef` wired the scheduled task's `--apply`/`--manifest`, and
> `0d3d7f5` enforced app gates/rate limits and wired cursor glide, so the last
> three claims above are stale. The fix pass below re-checked the docs against
> the code.

## Task 20 fix pass — review findings (2026-10-22)

Scope: docs/workflows/install-skill wiring only; `lib/`, `tests/` and
`package.json` were not edited. Base: `0d3d7f5` (policy app gates, cursor glide
wiring, package files) on top of `b3687ef` (updater rollback/scheduled apply).

### Changes verified

- `release.yml` derives the `compat.json` `dsh` value from
  `package.json#engines.dsh` with `node -p` and throws when it is empty; the
  same value is written to `compat.json` and the release notes.
- `scripts/install.mjs` copies `skills/computer-use` to
  `<dsh-home>/skills/computer-use`, backing up an existing copy under
  `<dsh-home>/computer/backup/skills-<stamp>`; `scripts/uninstall.mjs` removes
  the installed copy and restores the newest `skills-*` backup.
- README/AUTO-UPDATE/ARCHITECTURE/SAFETY/CHANGELOG/skill now match the code:
  manifest-entry `dsh` selection, immediate pending clear after the updater
  heartbeat, `--home` vs `DSH_HOME`, password fields as hard blocks, array
  `keys`, version-only safety pin, current `renderTaskCommand` signature,
  `--dry-run` scope, and the current package contents / enforced app gates,
  rate limit and glide wiring.

### Commands and results

```powershell
node --check scripts/install.mjs
node --check scripts/uninstall.mjs
python -c "import yaml; [yaml.safe_load(open(p, encoding='utf-8')) for p in ['.github/workflows/ci.yml', '.github/workflows/release.yml']]"
node --test tests/install-e2e.test.mjs
node --test tests/*.test.mjs
npm pack --dry-run --json
```

- both `node --check` runs passed; both workflows parse as YAML.
- install e2e: **18/18 pass**.
- full suite: **407 tests, 406 pass, 1 skipped, 0 fail** (~5.0 s).
- `npm pack --dry-run`: **38 files**; the tarball now includes `README.md`,
  `index.js`, `lib/**`, `scripts/**`, `docs/**` and `skills/computer-use/SKILL.md`
  (`tests/` and `.github/` are excluded).
- Scratch-home manual check: an existing custom skill was moved to
  `computer/backup/skills-<stamp>` on install; uninstall removed the installed
  copy and restored the custom `SKILL.md`.
- Relative-link check over README, CHANGELOG, `docs/**` and `skills/**`: no
  broken links. `git show --check`: no whitespace errors.

## Final-review Critical #3 — updater/installer plugin layout (2026-10-22)

### Changes

- `lib/update/install.js` installs into `plugins/dsh-computer/<version>` (the
  installer layout), creates the package parent, extracts into
  `plugins/dsh-computer/.tmp-*` and renames atomically. `switchCurrent` targets
  the nested version dir; `previous.json` paths are nested. Existing identical
  installs are reused, mismatched identities are still refused, and link targets
  in the legacy flat layout are recognized for rollback.
- `scripts/doctor.mjs` verifies the profile link against either layout: nested
  `plugins/dsh-computer/<version>` or legacy flat
  `plugins/dsh-computer-<version>`. A flat install reports ok with a migration
  note; a missing/stale link still fails with an `install.mjs` hint.
- `scripts/uninstall.mjs` removes the nested `plugins/dsh-computer/` tree and
  every legacy flat `plugins/dsh-computer-*` directory (including orphaned ones
  from old updater runs) while keeping unrelated plugin dirs.
- `scripts/update.mjs` documentation now states the nested destination.
- Tests cover nested installs, the overwrite refusal, nested `previous.json`
  paths, legacy-flat previous installs on switch/rollback, doctor after an
  updater-nested install with no downgrade, and uninstall of nested + flat dirs.

### Commands and results

```powershell
node --check lib/update/install.js
node --check scripts/update.mjs
node --check scripts/doctor.mjs
node --check scripts/uninstall.mjs
node --check tests/update.test.mjs
node --check tests/install-e2e.test.mjs
node --test tests/update.test.mjs
node --test tests/install-e2e.test.mjs
npm test
```

- all six `node --check` runs passed.
- update tests: **39/39 pass**.
- install e2e: **20/20 pass**.
- full suite: **411 tests, 410 pass, 1 skipped, 0 fail** (~4.7 s).
- Committed as `6c71d94 fix: unify updater plugin layout`.

## Final-review Critical #2 and Important #6/#7/#8 — act timeout, cancellation and safety gates (2026-10-22)

### Changes

- `lib/backend/mcp.js`: `McpError` now carries a machine-readable `code`
  (`mcp_error` by default); `TimeoutError` sets `code: 'timeout'`.
- `lib/backend/cua.js`: `ToolCallError` copies its cause's code (so the real
  driver timeout is `code: 'timeout'`) and keeps `cause`.
- `lib/act.js`: `classifyEffect` treats an error as unverifiable when
  `error.code === 'timeout'`, `error.cause.code === 'timeout'`, or the
  message/cause message matches `timeout`/`timed out`; the matching advice is
  `结果未知，先重新 observe 再决定是否重试` and the outcome is never refused.
- `lib/act.js`: an already-resolved element with a password-ish role/type, or an
  editable role labelled `Password`, is refused as `password-field` before any
  backend call.
- `lib/act.js`: a `confirmed` action whose readback returns
  `verification.observed === false` is downgraded to `unverifiable` with advice
  while keeping the verification detail.
- `lib/act.js` / `lib/tool.js`: `exec.signal` (or `args.signal`) reaches act
  execution and the observe `waitFor`; an aborted signal returns
  `refused (cancelled)` before the backend action or before the next waitFor
  poll. Signal-aware waitFor polls through a checked observer proxy, and the
  signal is also passed to `policy.authorize` for hosts that forward
  cancellation to approval.
- `lib/tool.js`: per-step authorization now runs
  `control.assertAgentAllowed()` before `policy.authorize()`, so a control
  denial raises no approval request and consumes no policy rate budget.
- Tests cover timeout classification at act/mcp/cua levels, cancellation before
  and during waitFor, resolved password fields, readback downgrade, and the
  control-before-policy order.

### Commands and results

```powershell
node --check lib/act.js
node --check lib/tool.js
node --check lib/backend/mcp.js
node --check lib/backend/cua.js
node --test tests/act.test.mjs tests/tool.test.mjs tests/mcp.test.mjs tests/cua-backend.test.mjs
node --test tests/*.test.mjs
```

- all four `node --check` runs passed.
- focused suites: **133 tests, 132 pass, 1 skipped, 0 fail**.
- full suite: **420 tests, 419 pass, 1 skipped, 0 fail** (~4.2 s).
- Committed as `8dd1959 fix: act timeout cancellation and safety gates`.



## Real DSH install — 2026-10-22 20:31 (Asia/Shanghai)

Installed into the live desktop profile with `node scripts/install.mjs --home C:\Users\b1778 --profile desktop`:

- `plugins/dsh-computer/0.1.0` copied; `profiles/desktop/node_modules/dsh-computer` linked to it.
- Legacy `dsh-computer-use-0.4.0/0.4.1` moved to `plugins/_backup/`; patch backed up before edit.
- Managed root row written to `~/.dsh/cordis.patch.yml` (`# >>> dsh-computer (managed)` block).
- `skills/computer-use` replaced (previous skill backed up under `~/.dsh/computer/backup/skills-*`).
- `node scripts/doctor.mjs --home C:\Users\b1778 --profile desktop`: all 5 checks ok (DSH 0.2.1-rc.2 detected from the running app's file version; driver found; patch row present; link resolves).
- The running DSH desktop session hot-reloaded the plugin: the harness published the compiled `computer` tool schema (action observe/act/session, DSL parameters) without a restart.
- Headless standard-session check was attempted (`dsh headless "..."`); it cannot run here because the headless profile has no `DEEPSEEK_API_KEY` configured and no per-profile plugin link. The desktop session itself is the verified host-load path; approval-UI behaviour still needs a manual interactive check.

Known limitation: `doctor` version detection uses `DSH_VERSION`, `DSH_APP_PACKAGE_JSON`, `<dshHome>/version`, DSH manifests, `dsh --version`, then the running `DeepSeek Harness.exe` FileVersion; a stopped app with no PATH shim and no version file still reports unknown.

### Reinstall after final fixes — 2026-10-22 20:42

- Re-ran `node scripts/install.mjs --home C:\Users\b1778 --profile desktop`: package copied over `plugins/dsh-computer/0.1.0`, link and patch unchanged, skill refreshed.
- `doctor`: 5/5 checks ok (DSH 0.2.1-rc.2, compat, driver, managed patch row, link).
- Installed copy contains the final backend-reset/close fixes; full suite 422 tests / 421 pass / 1 conditional skip / 0 fail.
- Live desktop session already hot-reloaded the compiled `computer` tool schema; interactive approval and full model-driven task remain a manual acceptance step.
