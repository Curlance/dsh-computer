# Changelog

All notable changes to `dsh-computer` are recorded here. The project is a
standalone DSH plugin for desktop computer use; versions follow semver.

## 0.1.0 — 2026-10-22

Initial release (A+B: plugin core + desktop `computer` tool). Windows only.

### Added

- **Single `computer` tool** for standard DSH sessions, with `observe` / `act` /
  `session` actions (no preset, no mode switch, no `computer_*` tool family).
- **Observation**: window / active-window / primary-screen targets, UIA element
  tree, optional screenshot, text-and-image rendering, revision + TTL cache,
  `waitFor` polling, truncation reporting and window-local coordinate space.
- **Actions**: `click`, `doubleClick`, `rightClick`, `move`, `type`, `key`,
  `scroll`, `drag`, `wait`, `launch`, `focus`, `resize`, `kill`; element-token
  or pixel targets; `auto`/`background`/`foreground` delivery; post-action
  readback; batched `steps[]` with per-step authorization and audit.
- **Truthful effects**: `confirmed` / `noop` / `unverifiable` / `refused`;
  ambiguous backend outcomes are never reported as success.
- **Safety**: risk classification (low/medium/high), approval modes
  `ask`/`strict`/`relaxed`, non-overridable blocks for password fields,
  UAC/secure desktop and unobserved actions, and a user-activity control gate
  backed by `GetLastInputInfo` with a self-action heuristic.
- **Session lease**: one agent at a time, 120 s TTL with renewal, explicit
  `takeover` / `resume`, `busy` instead of queueing.
- **Audit**: append-only JSONL with session/agent/action/risk/decision/effect
  and hashed input summaries; plaintext input and screenshots are not stored.
- **Visible AI cursor**: Cua Driver agent-cursor session and theme, best-effort
  configuration, glide helper and cursor status.
- **Cua Driver 0.36 backend** over persistent `cua-driver mcp` stdio, with
  timeout, transport-only retry and lazy start on first tool call.
- **Installer / uninstaller / doctor**: managed `cordis.patch.yml` root-plugin
  row, profile junction, migration from `dsh-computer-use`, install checks,
  `--dry-run` everywhere.
- **Auto-update foundation**: `compat.json` selection by DSH range, sha256
  verification before writes, atomic version switch, previous/pending markers,
  heartbeat-based running detection, manual rollback, scheduled-task
  registration helper.
- **CI and release workflows**: Windows + Node 24 test workflow; tag-triggered
  release that packs the tarball, generates `compat.json` and creates a GitHub
  Release (unsigned).
- **Docs and skill**: architecture, safety, auto-update, verification evidence,
  and the `computer-use` skill describing the unified tool.

### Known limitations

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/SAFETY.md](docs/SAFETY.md) and
[docs/AUTO-UPDATE.md](docs/AUTO-UPDATE.md). The main ones: the scheduled updater
task does not yet pass `--manifest`/`--apply`; the runtime does not write the
health heartbeat; no code signing; app allow/block lists and action rate limits
are configured but not enforced; no native global input hook; only the primary
display is supported; `scripts/`, `docs/` and `skills/` are not in the npm
tarball.
