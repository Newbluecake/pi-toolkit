# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`pi-toolkit` (formerly `pi-subagent`) — a toolbox extension for [pi](https://github.com/earendil-works/pi)
(the `@earendil-works/pi-coding-agent` CLI) whose flagship is an anti-hang subagent system: a drop-in
replacement for the core of `@tintinweb/pi-subagents`: it provides the `Agent` / `get_subagent_result` / `steer_subagent` /
`abort_subagent` tools, the `SubagentWorkflow` orchestration tool, the `/agent` command, a live
fleet widget (agent tree), a notification delivery subsystem, and a cron scheduler. Beyond that
core it optionally (settings-gated) overrides pi's built-in `bash` with auto-backgrounding plus
a `bash_job` manager tool, provides `compact_context` / `set_compact_threshold` for manual and
threshold-triggered context compaction, and implements the message fabric (`message_agent`,
fire-and-forget inter-agent messaging routed along the agent tree).

The whole point of the project is **zero-hang guarantees**: every run has layered deadlines
(watchdog sub-phase budgets + total budget), an escalating reaper for orphans, and persistent,
acknowledgeable delivery of results. Preserve these invariants when editing.

Renamed `pi-subagent` → `pi-toolkit` (2026-09): runtime identifiers keep the old name on purpose —
the settings file `~/.pi/agent/pi-subagent.json`, `Symbol.for("pi-subagent:*")` host guards,
`subagent:*` customTypes/event channels, widget/status keys and the `[pi-subagent]` log prefix all
carry existing session data and cross-module contracts. Do NOT "finish the rename" inside `src/`.

It also absorbs seven formerly-standalone plugins (see `docs/dev/plugin-merge/merge-plan.md`), all
settings-gated and all wired from the single `pi.extensions` entry (`src/index.ts`): a HUD footer
(`src/hud/`, `hud.enabled`, main-session TUI only), the `web_search` tool (`src/web-search/`,
`webSearch.enabled`), Claude Code-style task tools (`src/todo/`, `todo.enabled`), the interactive
`ask_user` tool (`src/ask-user/`, `askUser.enabled`), Feishu notification cards
(`src/feishu-notify/`, `feishuNotify.enabled`), session-navigation enhancements
(`src/session-nav/`, `sessionNav.enabled`), and cwd-keyed project memory (`src/memory/`,
`memory.enabled`). web_search / todo / memory register **before**
the HOST_KEY guard so child sessions keep them; hud / feishu-notify / session-nav / ask_user are
post-guard (main-session only — a subagent runs in print mode, so ask_user could only ever return
its headless error there and is therefore not registered in child sessions at all).

## Commands

```sh
npm install          # dev setup (Node >= 22, enforced by engines + CI)
npm run build        # tsc -p tsconfig.build.json → dist/
npm test             # vitest run — 1800+ tests; must stay green
npm run typecheck    # tsc --noEmit (strict; see tsconfig flags)
npm run format       # prettier --write .
npm run format:check # CI gate
```

CI (`.github/workflows/ci.yml`) runs format:check → typecheck → test → build on Node 22.
Run all four locally before pushing. `fs.globSync` is used, so Node < 22 is unsupported.

## Repository layout

- `index.ts` — package-root entry **for pi** (the sole `pi.extensions` manifest target). pi loads
  extensions through jiti (runtime TypeScript), so git installs need no build step. Thin
  re-export of `./src/index.js` (jiti maps the `.js` suffix to the `.ts` file). Keep it thin.
- `index.js` — companion entry for plain Node consumers, re-exporting `./dist/index.js`
  (package.json `main`/`exports`). Not used by pi.
- `src/index.ts` — **assembly only** (invariant I7): register tools/commands/hooks once per
  `activate()`, own the HOST_KEY host-claim guard, rebuild the session stack on every
  `session_start`. No logic lives here.
- `src/stack.ts` — the per-session stack builder (`buildSessionStack`): constructs
  stores/services/watchdog/reaper/scheduler/widget from `ExtensionContext`. The previous
  session's pieces are disposed at the top of the next build (no stack dispose hook).
- `src/core/` — pure domain: state machine, deadline budgets, ids, types, and the worktree-origin
  registry (`worktree-origin.ts`: worktree path → original cwd, `Symbol.for` global, FIFO-capped;
  written by `src/extensions/worktree.ts`, read by `src/memory/`). No pi imports.
- `src/runtime/` — runner, session driver, watchdog, reaper, slot pool (concurrency), dynamic
  tool scoping.
- `src/service/` — spawn/query services, run registry, target resolution (exact → prefix → label), and the global background-status provider shared with feishu-notify.
- `src/ask-user/` — merged interactive `ask_user` tool and TUI/RPC question components; emits `ask-user:activity` while an active TUI component receives input. `normalize.ts` repairs presentation-layer input instead of failing the call: explicit headers are always trimmed/width-capped (a blank one is dropped so the RPC answer key falls back to the question text), and missing headers are derived + de-duplicated in multi-question calls **only** (a single question never gets one invented, so its answer key stays the question text). Headers the model duplicated verbatim are still rejected — they collide as RPC answer keys.
- `src/feishu-notify/` — merged Feishu notification cards (passive triggers only: `@notify` keyword, `/watch` and `/feishu-test`); completion-class cards are background-idle gated — suppressed (never deferred) while subagents/background bash are still running, since a stopped main session with busy background is not task end.
- `src/bash/` — bash auto-background: the same-name `bash` override, `BashJobManager` (spawn →
  log tee → settle → notify → recover after restart), persisted job store. POSIX only; when the
  setting is off, pi's built-in bash stays untouched.
- `src/compact-hint/` — turn_end hook that watches context usage and nudges the model toward
  `compact_context` at a configurable threshold (with a forced-compaction warning level), plus
  stepped usage-tick reports so the model can perceive context usage at all. The tick grid is
  non-linear (default step 10 far away, densifying to step/2 and step/5 near the force ceiling —
  reminders get more frequent as the threshold approaches) and the force line is window-scaled
  (`forceScaling`, default on: the configured percent is a 1M-window anchor, rising 5 points per
  decade of shrinkage — 1M→88, 200k→91≈pi's own reserve line, 37k→95 — before the reserve cap
  clamps it below pi's automatic line).
- `src/cache-ttl/` — prompt-cache TTL mode (auto/on/off) wiring: status-bar indicator plus
  persisted settings override. Adaptive 1h upgrades are bounded by two write budgets — a USD
  marginal-cost gate (`adaptiveWriteBudgetUsd`, default $1, `0` = gate off) as the primary and
  the legacy token budget (`adaptiveWriteBudgetTokens`, 200k, `0` = no upgrades at all) as the
  fallback for routes that report no cost split; either one trips `write-budget` for the rest of
  the session. The M2 probe floor scales with the measured prefix — `min(64k, max(4k, 0.5×P))` —
  so a near-full prefix rewrite is caught at small prefixes while P ≥ 128k keeps the old fixed
  64k floor. Design: `docs/dev/cache-ttl-adaptive/plan.md`.
- `src/fabric/` — inter-agent message fabric: router (admission, per-kind quotas, dead letters),
  mailbox, tree routing, per-link throttle. `message_agent` is scoped to subagents via
  `src/runtime/tool-scope.ts`; routing relations come from the agent type's `can_message`
  frontmatter (default: parent only).
- `src/hud/` — merged pi-hud: full footer takeover (git/worktrees, token & cost stats incl.
  live subagent cost, LLM timing/speed) + status key `pi-hud` + `/pi-hud-refresh` + settings-gated
  periodic `git fetch` (`hud.autoFetchMinutes`, default 5, 0 = off — the ↑/↓ counts compare against
  the local remote-tracking ref, so without fetch they never see remote commits pushed elsewhere). State lives
  in a per-session `HudSession` (single `live` flag, all timers unref'd, all `pi.events`
  subscriptions unsubscribed on session_shutdown — the bus survives /reload).
- `src/web-search/` — merged web_search tool: Codex/SerpAPI/Bocha/Tavily failover with retry
  policy; credentials from env or `~/.config/pi/web-search.env`; registered pre-guard.
- `src/todo/` — merged pi-claude-todo: TaskCreate/List/Get/Update/Delete + aboveEditor widget
  (key `claude-code-todo`, coexists with the fleet widget) + `/tasks`. Persists via the
  `claude-code-todo-state` session entry; registered pre-guard; widget is TUI-only.
- `src/memory/` — merged armory-memory: cwd-keyed project memory under `~/.pi/agent/memory/<slug>/`.
  `before_agent_start` injects a budgeted `## Memory` block (pin frontmatter, agent-source fence,
  tail sentinel, fingerprint-keyed render cache); the `memory` tool lists/writes/appends (child
  sessions read-only by default, writes carry `source: agent` provenance); `/mem` covers
  list/path/import from Claude Code. `paths|frontmatter|store|render` are pi-free; `index.ts`
  (`wireMemory`) is the only pi-facing assembly and holds all mutable state in its closure;
  registered pre-guard. Design: `docs/dev/memory/memory-plan.md`.
- `src/session-nav/` — merged session-nav: `/resume-recent` (48h window, `--all` for full history),
  `/clear`, bare `exit` interception, a pre-submit rewriting editor, and resume-list title
  cleaning (skill envelopes + `[sub:type]` subagent marks driven by our own `subagent:run`
  entries, disk-cached under `<agent>/cache/session-nav/`). Post-guard, TUI-only.
- `src/config/` — agent-type registry (Markdown frontmatter), fuzzy model hints, settings file.
- `src/schedule/` — cron parser, scheduler, persisted schedule store.
- `src/reload/` — deferred `/reload` (settings-gated by `reload.defer`): an editor wrapper rewrites exact
  `/reload` submissions to `/agent reload`, which parks the reload while subagents/workflows are active and
  fires it (via a followUp `/agent reload fire` message) once the fleet settles; `now` forces, `cancel`
  cancels.
- `src/goal/` — `/goal` objective-driven loop: pure state machine (four phases), text builders,
  appendEntry session store, `agent_settled` loop hook (until-cmd via `pi.exec`, verifier via
  `spawnAndWait` + schema, delivery/eval watchdogs), `/goal` command. See
  `docs/dev/goal/goal-plan.md` (v4 评审修订为最终施工口径).
- `src/delivery/` — notification outbox: staged → finalize → batched → delivered → consumed,
  with caller-ack suppression and a coalescer for hold-window merges.
- `src/workflow/` — `SubagentWorkflow` engine: orchestrator, journal/replay, runaway detection.
- `src/adapters/` — pi-facing shims (compat probing, outbox store, run log).
- `src/tools/`, `src/commands/`, `src/ui/`, `src/mention/`, `src/rpc/`, `src/extensions/` —
  tool surfaces, `/agent` command (status/settings/costs), fleet widget + TUI settings editor,
  `@label` mentions, RPC, extension points (worktree isolation). RPC spawn success replies weakly carry `{ runId, label? }`; keep the schema result opaque.
- `tests/` — mirrors `src/` plus `integration/` and `fixtures/`.
- `docs/dev/` — per-feature design docs (auto-background, delivery v2, bash-auto-background,
  subagent-push/fabric, compact-hint, timeout-notify (宽限+延长), ...); read the matching one before changing that subsystem.
- `scripts/release/package.sh` — stage 9 of the git-release flow (zip + sha256 + notes).

## Conventions

- **TypeScript strict**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride` are on. ESM (`module: NodeNext`) — relative imports need the `.js`
  suffix (`import { x } from "./foo.js"`).
- **Prettier** formats everything; a versioned pre-commit hook does it automatically —
  enable once with `git config core.hooksPath .githooks`.
- **Conventional Commits** (`feat|fix|docs|refactor|perf|test|chore|ci(scope): ...`); the
  CHANGELOG is generated from them.
- Tool parameters use `@sinclair/typebox` schemas (the only runtime dependency).
- Peer dependencies on `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` are pinned to
  `>=0.84.0 <0.86.0`; bump deliberately and re-check `src/adapters/pi-compat.ts`.

## pi-extension specifics (easy to get wrong)

- pi loads this package straight from TypeScript source (`index.ts` → `src/`) via jiti —
  that is what makes `pi install git:...` work despite `dist/` being gitignored (pi's git
  install runs no build). `dist/` is still built in CI and published to npm for the Node
  `main`/`exports` entry, but pi never reads it. The pi peers are `peerDependenciesMeta`
  optional (pi aliases them to its own bundled modules at load time) and duplicated in
  `devDependencies` for local typecheck/tests.
- The extension re-activates on pi's `/reload` in the same process without busting Node's
  module cache. Never keep mutable state at module scope; rebuild per `activate()` (see the
  `HOST_KEY` globalThis guard and its identity-checked release in `src/index.ts`).
- Child subagent sessions re-import this extension; they must stay inert (host-claim guard).
- Ref'd timers wedge `pi -p` (print mode) — `unref()` any interval/timeout you add.

## Testing expectations

Vitest. Suites include a state-machine transition matrix and seeded property invariants —
when you change the run state machine (`src/core/state-machine.ts`) or delivery lifecycle,
update the matrix/property tests in lockstep. Integration tests live in `tests/integration/`.

## Releasing

Versions follow semver; releases are cut from `master` with annotated tags whose message is
the version's CHANGELOG section, then `scripts/release/package.sh <version>` produces the
zip assets and `gh release create` publishes them. Do not hand-edit released CHANGELOG
sections.
