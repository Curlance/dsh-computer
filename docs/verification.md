# Verification evidence

## Task 19 — Windows real-machine smoke (2026-10-22)

### Environment

- Windows 11 家庭版 中文版 10.0.26200 (build 26200)
- Node.js v24.16.0
- cua-driver 0.36.0, `C:\Users\b1778\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`
- Repo HEAD during the recorded runs: `bf108c3` (`fix: dsh-tools DSL schemas and host execution serialization`)

### Commands

```powershell
node scripts/smoke.mjs
node scripts/smoke-action.mjs
```

Both exited `0`.

### `scripts/smoke.mjs` — read-only desktop smoke

```json
{
  "ok": true,
  "checks": [
    { "name": "driver", "ok": true, "ms": 4, "detail": "C:\\Users\\b1778\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe" },
    { "name": "backend-start", "ok": true, "ms": 527, "detail": "cua-driver 0.36.0 ready" },
    { "name": "list-windows", "ok": true, "ms": 353, "detail": "12 windows" },
    { "name": "observe-active", "ok": true, "ms": 419, "detail": "title=\"dsh-pet 桌宠（桌面模式）\"; tree=4; screenshot=102708B; budget=1500ms" }
  ]
}
```

`observe` 419 ms (budget 1500 ms); no `slow` warning.

### `scripts/smoke-action.mjs` — owned target, click/type/readback

```json
{
  "ok": true,
  "checks": [
    { "name": "driver", "ok": true, "ms": 4, "detail": "C:\\Users\\b1778\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe" },
    { "name": "backend-start", "ok": true, "ms": 574, "detail": "cua-driver 0.36.0 ready" },
    { "name": "cursor-session", "ok": true, "ms": 45, "detail": "session=dsh-smoke-21064-1792668202469" },
    { "name": "launch-target", "ok": true, "ms": 2243, "detail": "pid=21436; window=2295272; title=\"DSH-SMOKE-TARGET-1792668202516\"" },
    { "name": "observe", "ok": true, "ms": 291, "detail": "title=\"DSH-SMOKE-TARGET-1792668202516\"; tree=7; screenshot=39586B; budget=1500ms" },
    { "name": "click-editor", "ok": true, "ms": 386, "detail": "element s00000001:2; effect=unverifiable; budget=800ms" },
    { "name": "type-marker", "ok": true, "ms": 1302, "detail": "effect=unverifiable; marker=DSH-MARKER-1792668202516" },
    { "name": "readback", "ok": true, "ms": 88, "detail": "marker rows=1; value=\"DSH-MARKER-1792668202516\"; budget=1500ms" },
    { "name": "cursor-position", "ok": true, "ms": 936, "detail": "{\"x\":728.68,\"y\":55.18}" },
    { "name": "kill-target", "ok": true, "ms": 43, "detail": "pid=21436" }
  ]
}
```

| stage | measured | budget |
| --- | ---: | ---: |
| observe | 291 ms | 1500 ms |
| element click | 386 ms | 800 ms |
| readback | 88 ms | 1500 ms |
| backend start | 574 ms | — |
| launch + window | 2243 ms | — |
| type marker | 1302 ms | — |
| agent-cursor state | 936 ms | — |
| kill target | 43 ms | — |

No `slow` warnings. The marker was read back from the UIA `Edit.value` and the
target process was terminated by the pid returned from `launch_app`.

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

### Failure path and exit codes

```powershell
$env:CUA_DRIVER_BIN = 'C:\definitely-missing\cua-driver.exe'
node scripts/smoke.mjs
node scripts/smoke-action.mjs
```

Both printed `{"ok": false, ...}` with detail
`cua-driver not found (C:\definitely-missing\cua-driver.exe); install Cua Driver or set CUA_DRIVER_BIN`
and exited `1`.

### Cleanup observation

After both runs: no `mshta.exe` / `notepad.exe` process remained, and no
`dsh-smoke-*` temp directory remained.
