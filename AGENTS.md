# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`pi-toolkit` (formerly `pi-subagent`) — a toolbox extension for [pi](https://github.com/earendil-works/pi)
(the `@earendil-works/pi-coding-agent` CLI) whose flagship is an anti-hang subagent system: a drop-in
replacement for the core of `@tintinweb/pi-subagents`: it provides the `Agent` / `get_subagent_result` / `steer_subagent` /
`abort_subagent` tools (the main-session `Agent` is background-only — every call returns a run_id and completion is
notified; only the nested `Agent` injected into a child keeps the blocking default, see
`docs/dev/agent-background-only/plan.md`), the `SubagentWorkflow` orchestration tool (also background-only: returns a
`wf_…` id, notifies on terminal state, managed through `get_subagent_result` / `abort_subagent` — see
`docs/dev/workflow-background/plan.md`), the `/agent` command, a live
fleet widget (agent tree), a notification delivery subsystem, and a cron scheduler. Beyond that
core it optionally (settings-gated) overrides pi's built-in `bash` with auto-backgrounding plus
a `bash_job` manager tool, provides `switch_context` / `compact_context` / `set_compact_threshold`
for model-authored context handoff, manual and threshold-triggered compaction, and implements the
message fabric (`message_agent`, fire-and-forget inter-agent messaging routed along the agent tree).

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
- `skills/` — agent skills shipped with the package (`pi.skills` in package.json; also in npm
  `files`): `dev-flow` (dev workflow lanes, model routing, parallel dispatch) and `agent-handoff`
  (structured handoffs and consult usage, backed by `docs/dev/fabric-v2` experiments). They are the
  source of truth — do not keep a second copy under `~/.agents/skills/` (pi keeps the first skill of a
  name and warns on collisions). Tool mechanics belong in tool/parameter descriptions; skills carry
  strategy, evidence and costs.
- `src/index.ts` — **assembly only** (invariant I7): register tools/commands/hooks once per
  `activate()`, own the HOST_KEY host-claim guard, rebuild the session stack on every
  `session_start`. No logic lives here.
- `src/stack.ts` — the per-session stack builder (`buildSessionStack`): constructs
  stores/services/watchdog/reaper/scheduler/widget from `ExtensionContext`. The previous
  session's pieces are disposed at the top of the next build (no stack dispose hook).
- `src/core/` — pure domain: state machine, deadline budgets, ids, types, and the worktree-origin
  registry (`worktree-origin.ts`: worktree path → original cwd, `Symbol.for` global, FIFO-capped;
  written by `src/extensions/worktree.ts`, read by `src/memory/`). No pi imports. Deadline span
  guards: `deadline.ts`'s `MAX_DEADLINE_SPAN_MS` (365d) + `clampSpanMs()` clamp every computed span
  (non-finite/≤0 ⇒ undefined) so no NaN/Infinity deadline can ever reach a timer; `clock.ts`'s
  `createSegmentedClock` re-arms delays beyond Node's 2³¹−1 ms `setTimeout` limit in segments
  (no 1ms busy-loop), and `systemClock` is built on it (unref semantics preserved).
- `src/runtime/` — runner, session driver, watchdog, reaper, slot pool (concurrency), dynamic
  tool scoping. **Child-extension-missing diagnostic (todo #27)**: `session-driver.ts` rediscovers
  extensions for every spawned child session purely from settings.json (the same `SettingsManager`/
  `DefaultResourceLoader` discovery pi's own CLI uses) — never from whatever `-e <path>` /
  `--no-extensions` flags the PARENT pi process itself was started with. If this package is loaded
  into the parent that way (outside settings.json's `packages`/`extensions` list), every child
  session it spawns never activates it at all, and bash-job settle-hold / switch_context / memory
  injection / cache-ttl keepalive all silently do nothing for that run — use `pi install` instead so
  settings.json actually lists the package. `src/child/activation-signal.ts`'s process-wide,
  `Symbol.for`-keyed activation counter (incremented unconditionally from `src/index.ts`'s
  `isChildSession` branch) lets the driver detect this synchronously, in-process, without parsing
  settings.json itself: a non-consult `create()`/`resume()` call whose counter never advances during
  its own create-await window emits a `child_extension_missing` DriverEvent, folded into
  `RunDiagnostics.childExtensionMissing` (best-effort, diag-only, never affects the run) and surfaced
  in `get_subagent_result`'s text (`formatChildExtensionMissing`); the runner also `console.warn`s
  once per process (deduped). Consult forks are exempt (their read-only tool domain makes the
  affected features moot) — detection, not inheritance, is the whole feature (no attempt to make a
  child session inherit the parent's `-e` extension list).
- `src/service/` — spawn/query services, run registry, target resolution (exact → prefix → label), and the global background-status provider shared with feishu-notify.
  Spawn admission rejects a `provider/id` unknown to the **host** model registry (typos; suggestions via `suggestModelRefs`).
  It cannot catch a host registry gone stale after `models.json` changed on disk: child sessions rebuild `ModelRuntime`
  from disk, so that case fails at session start as `failed` with `explainPromptRejection`'s cause (never `cancelled`).
  Pool-full admission (L1, `agent.queueWhenFull` default false): a non-slotless top-level/nested Agent-tool dispatch is
  rejected immediately (no run/label/worktree ever created) once `SpawnService`'s own admission-time reservation
  (`slotfulLabel`, never `SlotPool.stats.inUse` — that only updates deep inside the runtime adapter, after H2/worktree
  creation) reaches `concurrencyLimit`; every successful `spawn()` call also returns `slots` (limit/inUse/free, same
  slotless-exclusion rule as the real pool) for the Agent tool to surface. Workflow children/consult/resume/`/task`
  never set `poolFullPolicy` and keep the legacy queue-and-`queueWaitMs`-timeout behavior. Tidy proposals use
  `SpawnRequest.toolDomain: "readonly"`, which is consumed at admission/runtime and forces only the builtin
  read-only tools plus the runtime-owned `StructuredOutput`; the field is deliberately not threaded into child
  request prompts or ordinary runs.
  `SpawnRequest.timeoutPolicy` (agent-explicit-timeout-extend plan): optional `"fixed" | "extendable"`,
  default `fixed` — only the Agent tool (top-level and nested, when passing `timeout_s`) writes `"extendable"`;
  spawn admission resolves it once (`req.timeoutPolicy` ?? resume-inherited ?? shape-derived from
  `budgetOverride.totalMs`), applies it via `applyBudgetPolicy({ fixedDeadline })`, and the resolved value lands
  in `diag.timeoutPolicy`, persisted through terminal entries, the non-terminal journal, tombstones and
  terminal rebuilds, and inherited by resumes (R-inherit). Program-derived runs (workflow children, consult,
  `/goal` verifier, tidy, RPC) stay fixed-deadline. **Known accepted trade-off**: a nested extendable run's
  grace window notifies nobody (CC2 suppression) and child sessions have no `extend_subagent_timeout` —
  it silently lives up to `min(G,(f−1)·T)` past its deadline while the parent turn keeps waiting; the main
  session can still extend it by run id.
- `src/ask-user/` — merged interactive `ask_user` tool and TUI/RPC question components; emits `ask-user:activity` while an active TUI component receives input. `normalize.ts` repairs presentation-layer input instead of failing the call: explicit headers are always trimmed/width-capped (a blank one is dropped so the RPC answer key falls back to the question text), and missing headers are derived + de-duplicated in multi-question calls **only** (a single question never gets one invented, so its answer key stays the question text). Headers the model duplicated verbatim are still rejected — they collide as RPC answer keys. `remote.ts`'s `AskUserRemotePort` (P2, #32) is a late-bound, optional web-hub port: when `webHub.remoteAskUser` is on and a browser is connected, `wireAskUser` races the TUI component against the remote answer for the same dialog (whichever settles first wins; the loser gets cancelled/closed) — `remote()` returning `undefined` (web-hub off or disconnected) reproduces pre-P2 behavior byte-for-byte.
- `src/feishu-notify/` — merged Feishu notification cards (passive triggers only: `@notify` keyword, `/watch` and `/feishu-test`); completion-class cards are background-idle gated — suppressed (never deferred) while subagents/background bash are still running, since a stopped main session with busy background is not task end.
- `src/bash/` — bash auto-background: the same-name `bash` override, `BashJobManager` (spawn →
  log tee → settle → notify → recover after restart), persisted job store. POSIX only; when the
  setting is off, pi's built-in bash stays untouched. Job-level timeout grace (`bashJobs.timeoutGraceS`,
  `maxExtensions`, `maxTimeoutFactor`; pure arithmetic in `src/bash/deadline.ts`) lets a background job
  with an explicit `timeout` enter one grace-window notice instead of dying outright, extendable via
  `bash_job(action:"extend")`. Child (subagent) sessions additionally get `src/bash/child.ts`
  (`wireChildBashJobs`, lazily built per session, not on `session_start`): an `agent_before_settle`
  settle-hold keeps a run with non-terminal jobs alive across bounded reminder rounds
  (`bashJobs.childSettleHold`, `childSettleHoldMaxRounds` — `0` auto-derives the cap from the run's own
  deadline/extension budget plus outstanding job grace, §3.5's `R_wait`/`G0`). Design:
  `docs/dev/bash-timeout-grace/plan.md`.
- `src/compact-hint/` — turn_end hook that watches context usage and nudges the model toward a
  context handoff (`switch_context`, or `compact_context` when `compact.switchTool` is off) at a
  configurable threshold, plus stepped usage-tick reports so the model can perceive context usage at
  all. The tick grid is
  non-linear (default step 10 far away, densifying to step/2 and step/5 near the force ceiling —
  reminders get more frequent as the threshold approaches) and the force line is window-scaled
  (`forceScaling`, default on: the configured percent is a 1M-window anchor, rising 5 points per
  decade of shrinkage — 1M→88, 200k→91≈pi's own reserve line, 37k→95 — before the reserve cap
  clamps it below pi's automatic line). In `switch_context` mode the force layer is 先礼后兵: it first
  _demands_ a self-authored handoff (`compact.forceDemandTurns`, default 1) and only falls back to
  the generic forced compaction when the model ignores it — the safety net is never removed. On top
  of that, a price-aware dynamic hint line (`dynamic/` subdirectory: pure-function layer + telemetry
  - the pi-facing wire; plan: `docs/dev/compact-hint/dynamic-threshold-plan.md`) is on by default
    (`compact.dynamicThreshold.mode=on`) and, whenever it is usable, fires INSTEAD OF the static
    line — 2026-09-27 decision: the static line is demoted to a fallback, used only while the
    dynamic line is unavailable (`mode` off/shadow or a `usable:false` degrade), so its own quality
    ceiling `maxQualityPercent` is no longer dead code under a lower static default; an explicitly
    disabled static line (`staticHintActive` false) still suppresses hint entirely — the dynamic
    layer never resurrects a hint the user turned off. `off` restores byte-identical pre-feature
    behavior, pinned by the golden fixture `tests/fixtures/compact-hint-golden.json` (never
    regenerate it). Its switch
    telemetry (`~/.pi/agent/telemetry/compact-switch.jsonl`, 0600, append-only, 2 MiB rotation)
    records aggregate numbers only — never any paths.
- `src/context-switch/` — model-authored context handoff: `handoff.ts` (validation + markdown
  rendering + mechanical appendix), `store.ts` (TTL'd, consume-once pending slot), `hook.ts`
  (`session_before_compact` returns `{ compaction }` so pi skips its summarizer and uses the model's
  text verbatim; `firstKeptEntryId` is pi's cut point, or a sentinel that drops everything before it
  for `keep_recent:false`), `session-facts.ts` (live runs / bash jobs / open todos / session file —
  every port degrades silently). The mechanical appendix also carries an "in-service skills" reminder
  (`skills.ts`): SKILL.md files touched or `/skill:xxx`-expanded within the dropped range (plus a bounded
  optional `skills` param) are listed for re-reading — never injected — and the appendix stays
  byte-identical when none are found. Tool surface: `src/tools/switch-context-tool.ts`. Design:
  `docs/dev/context-switch/context-switch-plan.md`. **Child-session switch_context** (child-context-switch
  plan §2/§3, `src/context-switch/child.ts` + `capability.ts`): every non-consult child run is granted
  `switch_context` (turn_end handler commits a boundary draft on top of `event.entries`), gated by a
  process-wide runtime capability state machine — never pi's version — walking `unknown →
static-ok(L0 export probe) → observed(L1 turn_end shape) → ready(L2 zero-impact
`subagent:boundary-probe`commit probe: ok iff the probe's`sourceEntry`exists in the projection
with`messages.length === 0`, not "absent from entries") → verifying → verified(L3 first-use
self-check a/b/c)`; sticky per process, re-probed only on pi restart (any pre-`verified` L0-L3
  failure disables immediately, a post-`verified` recheck disables only after 2 consecutive
  uncommitted). All rejection reasons fold into `diag.contextSwitches.rejected[]` (FIFO cap 5),
  readable from `get_subagent_result`.
- `src/cache-ttl/` — prompt-cache TTL mode (auto/on/off) wiring: status-bar indicator plus
  persisted settings override. Adaptive 1h upgrades are bounded by two write budgets — a USD
  marginal-cost gate (`adaptiveWriteBudgetUsd`, default $1, `0` = gate off) as the primary and
  the legacy token budget (`adaptiveWriteBudgetTokens`, 200k, `0` = no upgrades at all) as the
  fallback for routes that report no cost split; either one trips `write-budget` for the rest of
  the session. The M2 probe floor scales with the measured prefix — `min(64k, max(4k, 0.5×P))` —
  so a near-full prefix rewrite is caught at small prefixes while P ≥ 128k keeps the old fixed
  64k floor. **Entry fee** (plan §16.3, field-measured): a `ttl:"1h"` request does not read a
  5m-written prefix, so the FIRST upgrade of a prefix rewrites all of it as 1h. That one-time
  cost has its own budget (`adaptiveFeeBudgetTokens` 600k / `adaptiveFeeBudgetUsd` $3, accrued at
  0.95× `cost.cacheWrite`; `0` tokens = feature off) and the warm probes (`warm-miss` /
  `warm-write-too-expensive`) only judge COVERED 1h→1h settlements — judging the transition
  false-tripped every session on its first upgrade. **保活与自适应不是正交的**（现场事故
  2026-09-23，plan §17）：`decideAdaptiveTtl` 的 warm/cold 判据必须把 keepalive 的
  `provenCacheReadAt()`（最近一次 proven-hit 的读起点）算进来，否则一段被 ping 证明活着的
  前缀会被判 cold 并整块升 1h——而 1h 请求读不到 5m 条目（同会话 13/13 实测），那是一次
  全价重写。`1h-ineffective` 探针同理只认「读占上一次前缀的比例」，不认 `cacheRead > 0`。
  同理，已覆盖前缀的续 1h 也要重写升级后累积的 5m 尾巴（`tokensSinceLast1hWrite`）：warm
  预测/`delta-too-large` 按「尾巴 + Δ」判，尾巴部分美元边际按 0.95 计（plan §18）。
  **保活与自适应按空档择一**（plan §19，验证 `verification-2026-09-25.md`）：保活能桥接的空档
  （`keepaliveGapHorizonMs`，默认 49min）内 adaptive 不开新前缀（`keepalive-covers`），被确认的 1h
  覆盖期间保活不 ping（tick 门 `adaptive-1h`）；前缀漂移（缩短 / warm 窗口内整前缀失效）只清 cover、
  不判 `1h-ineffective`；入场费只认强信号时域。**§20（2026-09-26）**：F1 的「见过超出保活时域的空档」只认
  武装空档（`armedGaps`，保活证明过读中的那些——人为午休不算）；已覆盖续期读崩塌 ⇒ 学到路由 1h 寿命上界
  `learned1hLifeMs`，cover 封顶为其 0.8 倍；被 ping 撑住的空档不做 1h 判决。经济学仿真（含 5 策略 × 12 负载的
  策略矩阵）：`tests/cache-ttl/adaptive-economics.test.ts`。
  Design: `docs/dev/cache-ttl-adaptive/plan.md`. **Child-session keepalive** (child-context-switch
  plan §2.4, `src/cache-ttl/child.ts` + `child-registry.ts`): capture-only (never rewrites the
  outgoing payload); limits 11/window · 24/run · 4 concurrent · $1.5/run · $10/24h process-rolling
  (`ping-ledger.ts`), no price info ⇒ no ping (`usd-unpriced`); ping cost folds into the child run's
  own `usage.costUsd` (fleet/HUD visible); disposed on `agent_settled` and defensively via the
  registry's `onReaped`.
- `src/child/` — child-session assembly entry point (`wire.ts`'s `wireChildSession`, called from
  `src/index.ts` pre-guard when `isChildSession`, alongside `wireMemory`/`wireChildBashJobs`): composes
  `wireChildContextSwitch` + `wireChildKeepalive`, wiring their one cross-cutting signal (a committed
  boundary switch invalidates the keepalive prefix like a compaction does). Reads only the existing
  `isChildSession` boolean — does not touch `HOST_KEY`.
- `src/fabric/` — inter-agent message fabric: router (admission, per-kind quotas, dead letters),
  mailbox, tree routing, per-link throttle. `message_agent` is scoped to subagents via
  `src/runtime/tool-scope.ts`; routing relations come from the agent type's `can_message`
  frontmatter (default: parent only).
- `src/consult/` — in-turn expert consultation (`consult` tool). A subagent dispatched with an
  `experts` whitelist (`Agent({ experts })`, resolved to verified runIds at dispatch) gets the
  `consult` tool and can synchronously ask an already-finished expert run: the expert's persisted
  session is streaming-forked (`fork-store.ts`), a short readonly run (`CONSULT_READONLY_TOOLS`,
  enforced at both pi `sessionSpec.tools` and tool-scope; no injections, cannot spawn) answers,
  and the fork file is deleted when the runner reaps it (`RunnerDeps.onReaped`). Guards: first
  request cost / context preflight, turn-boundary turn and cost caps (`watcher.ts`, cap aborts map
  to `user_stop`). The main session never registers the tool itself, but a reserved expert id
  `"main"` (`Agent({ experts: ["main"] })`, priority over any same-named label/run) lets a
  dispatched child consult the HOST main session the same way — live facts (session file / model /
  context usage) come from `main-facts.ts` read fresh off the `ExtensionContext` on every call
  (never a dispatch-time snapshot), and the fork gets an extra post-copy consistency check +
  one retry (`forkMainSessionSnapshot`) because that file, unlike a finished expert's, can be
  concurrently appended to or rewritten. `consult.enabled=false` leaves the wiring inert (both
  forms). Wired in `src/stack.ts` through a late-bound ref. Design + test anchors:
  `docs/dev/consult/plan.md`.
- `src/hud/` — merged pi-hud: full footer takeover (git/worktrees, token & cost stats incl.
  live subagent cost, LLM timing/speed, own `toolkit v<ver>@<commit>[*] <commit time>` at the end of the cwd/git line with the model right-aligned on it — read once per activate by `plugin-info.ts`, git fields only when the package root is itself the git toplevel) + status key `pi-hud` + `/pi-hud-refresh` + settings-gated
  periodic `git fetch` (`hud.autoFetchMinutes`, default 5, 0 = off — the ↑/↓ counts compare against
  the local remote-tracking ref, so without fetch they never see remote commits pushed elsewhere). State lives
  in a per-session `HudSession` (single `live` flag, all timers unref'd, all `pi.events`
  subscriptions unsubscribed on session_shutdown — the bus survives /reload).
- `src/web-search/` — merged web_search tool: Codex/SerpAPI/Bocha/Tavily failover with retry
  policy; credentials from env or `~/.config/pi/web-search.env`; registered pre-guard.
- `src/todo/` — merged pi-claude-todo: TaskCreate/List/Get/Update/Delete + aboveEditor widget
  (key `claude-code-todo`, coexists with the fleet widget) + `/tasklist`. Persists via the
  `claude-code-todo-state` session entry; registered pre-guard; widget is TUI-only. A read-only
  summary also reaches the web hub: `TodoWireResult.getTodoSnapshot()` → `projectTodo`
  (`src/web-hub/agent/todo.ts`, 32-task cap / 240B description / 32KiB three-pass budget) rides
  the optional `StatusInfo.todo` slot (append-only, no proto bump) to a collapsible `TodoPanel`
  on the web detail header. Design: `docs/dev/todo-web/plan.md`.
- `src/memory/` — merged armory-memory: cwd-keyed project memory under `~/.pi/agent/memory/<slug>/`, with default `layout:tiered` injection and `toolSurface:v2` official-field tool surface; explicit `legacy` settings remain the byte-compatible opt-out. The tiered renderer enforces whole-file/whole-section admission and a UTF-8 byte budget; topic index lines carry `description`/`read_when` metadata, while `/mem doctor` reports D01-D14 health and its summary is surfaced by `/mem` and `memory.view`. Slug directories are canonicalized once and may be user-trusted symlinks; file-level symlinks and non-regular files are rejected. All v2 writes, imports, tidy, and restore operations serialize under the directory lock; batch tidy calls the post-write invalidation once. Registers a `pi_project_memory` section into the shared prompt-section hub (`src/sysprompt/hub.ts`, pre-guard, created before `wireMemory` runs so fold order stays memory → agent types → models) instead of owning its own `before_agent_start` hook (sysprompt-stable M3); the hub decides snapshot vs. tail update, `src/memory/inject.ts`'s `memorySection` provider only renders the current live block (pin frontmatter, agent-source fence, tail sentinel, fingerprint-keyed render cache). The `memory` tool lists/writes/appends (child sessions read-only by default, writes carry `source: agent` provenance); `/mem` covers list/path/import/doctor/tidy/restore. `paths|frontmatter|store|render` are pi-free; `index.ts` (`wireMemory`) is the only pi-facing assembly and holds all mutable state in its closure; registered pre-guard. Design: `docs/dev/memory/memory-plan.md`.
- `src/sysprompt/` + `src/prompt-sections/` — system-prompt stabilization: the three dynamic sections
  (project memory, agent types, available models) that used to get re-appended to `before_agent_start`'s
  `{ systemPrompt }` every turn — invalidating the whole cached prefix on every write — now fold a
  **frozen snapshot** instead, with real changes surfacing as a bounded tail `message` (≤3 chunks / ≤32KB
  per section since the last refresh, then a pointer). `src/prompt-sections/` is the pi-free half (no pi
  imports): `stable-section.ts` (the per-section state machine: snapshot/announced/stale, `SKIP` sentinel
  for a failed provider, `POINTED` for the post-limit pointer state), `fold.ts` (byte-identical to the old
  three-hook append chain), `update-message.ts` (renders the tail message), `store.ts` (serialize/sanitize/
  read-back for the persisted snapshot). `src/sysprompt/` is the pi-facing half: `hub.ts`
  (`createPromptSectionHub` — one `before_agent_start` handler per activate that every section registers
  into via `hub.register(name, registration)`; also owns `context_with_system`/`session_start`/
  `session_compact`/`model_select`/`session_tree`/`turn_start`/`agent_settled`), `core-sections.ts` (the
  agent-types / available-models `SectionRegistration` factories — `resolvePromptModels`'s scoped → stack
  port → registry priority itself lives in `src/config/available-models.ts`, kept there as its long-term
  home per plan §4.6), `wake-replay.ts` (mirrors pi's own forced-prompt projection shape onto notification
  wake runs), `compat.ts` (the only place touching the 0.87 `context_with_system` event / `forceSystemPrompt`
  / pi-ai's `getCurrentSystemMessage`). Three states, not two: `systemPrompt.mode` is `stable` (frozen
  snapshot + tail updates, default) / `live` (refresh every turn through the hub, no freezing) / `legacy`
  (raw append, byte-identical to pre-hub behavior, never persists). `systemPrompt.wakeReplay` (default
  true) independently gates the notification-wake-run replay (`false` = not registered at all, not
  registered-but-inert); `systemPrompt.adoptForeignForcedPrompt` (default false) gates whether a later
  extension's forced-prompt text gets adopted into the replay instead of just WARNed about. A snapshot's
  state persists via a `subagent:prompt-sections` session entry (`pi.appendEntry`, read back through
  `getBranch()` — never `getEntries()`, which can resurrect a stale fork's snapshot) so it survives
  `/reload` and cross-process resume; the hub itself holds no module-scope state (all closure-local, per
  `activate()`). Registered pre-guard — child sessions share the identical hook set, it is simply inert
  with zero sections registered until `src/index.ts`'s post-guard call adds agent-types/models (memory
  registers pre-guard too, so child sessions with memory enabled get that section). Design + the full
  decision log (three review rounds): `docs/dev/sysprompt-stable/plan.md`; manual acceptance steps (traffic.db
  system-prompt byte-stability checks): `docs/dev/sysprompt-stable/acceptance.md`.
- `src/session-nav/` — merged session-nav: `/resume-recent` (48h window, `--all` for full history),
  `/clear`, bare `exit` interception, a pre-submit rewriting editor, and resume-list title
  cleaning (skill envelopes + `[sub:type]` subagent marks driven by our own `subagent:run`
  entries, disk-cached under `<agent>/cache/session-nav/`). Post-guard, TUI-only.
- `src/web-hub/` — browser UI over a per-machine hub daemon (`webHub.enabled`, default off ⇒ zero wiring,
  zero network, zero disk; post-guard, child sessions inert). `protocol/` (frame/key/path contracts shared by
  both sides, incl. `ui-manifest.ts`'s `UiBuildInfo`/`parseUiBuildInfo`/`isAllowedUiPath` — the build-time
  manifest schema both the Vite plugin and the hub-side verifier trust), `hub/` (singleton daemon: composition
  root `hub.ts`, process entry `main.ts` run through pi's bundled jiti-cli, HTTP/SSE/auth/static; never imports
  pi), `agent/` (pi-side client `wireWebHub`: process-level connection on a `Symbol.for` global, reused across
  /new·/resume·/fork, handed over on /reload), `ui/` (the Vue 3 SFC frontend source, built by `npm run
build:web` into `dist/web-hub-ui/` — not checked in; `ui/src/logic/` holds the pure, DOM-free logic ported
  from the pre-Vue frontend, imported through the `@logic` alias). Wired at the end of `src/index.ts` after
  `wireDeferredReload`. P1 is read-only; **P2 (control-plane, #32, `docs/dev/web-hub/control-plan.md`)** layers a write
  path on top — a single `cmd`/`cmd_result`/`cmd_late` channel (`op: prompt|abort|steer_subagent|abort_subagent|
command|switch_session`, idempotent by cmdId, a process-level command ledger in `src/web-hub/agent/index.ts`
  outlives any single hub restart), an ask_user dual-channel bridge (`src/ask-user/remote.ts`'s port +
  `src/web-hub/agent/dialogs.ts`, TUI and web race for the same dialog, loser gets a 409/`dialog_closed`), web-
  origin slash commands with pi-toolkit's own commands captured and echoed back to the browser
  (`wrapCommandApi`, `captured:true` + the output text; a third-party extension's raw-registered command is
  never captured, `captured:false`, terminal-only), version-supersede/`/webhub stop`/`start`/`token rotate`
  admin flows, and a `hub-state-banner` covering pending/blocked/restarting/stopping. Design:
  `docs/dev/web-hub/{arch,plan,vue-plan,control-plan}.md`. **UI serving
  (todo #26 vue-plan.md v2.1 §2.1, P5b)**: `hub/static.ts`'s `createUiServer` resolves a verified root —
  package-bundled `dist/web-hub-ui/` first, else the external, version-pinned
  `~/.pi/agent/web-hub-ui/<hubVersion>/` (`hub/ui-root.ts`'s `resolveUiRoot`/`verifyUiRoot`: symlink/owner/mode/
  manifest-hash checks, TOCTOU-safe — bytes are read and hashed once at resolve time, served purely from
  memory afterward) — and serves an HTTP-200 "not built yet" placeholder (`hub/unbuilt.ts`) when neither
  candidate verifies, with install instructions gated by auth mode (token/loopback sees absolute paths and
  rejection reasons; password/LAN sees neither). `agent/ui-status.ts` renders the same status for
  `/webhub status`/`open`, reading `hub.json`'s `ui` field (`hub-json.ts`'s `patchUi`, mirroring `patchLan`).
  The legacy zero-build `src/web-hub/web/` frontend (`no-innerhtml`-enforced, hand-written JS) was deleted in
  this same switch — its pure logic lives on under `ui/src/logic/`. LAN access (S1,
  `webHub.lan.enabled`, default off): username/password auth over plain HTTP on `0.0.0.0:<webHub.lan.port>`,
  host allow-list + optional trusted-reverse-proxy origin (`webHub.lan.{trustProxyFrom,externalOrigins}`) for
  HTTPS termination, SQLite-backed sessions in a SIGKILL-able child process, and `/webhub passwd|unlock|restart`
  — design: `docs/dev/web-hub/lan-plan.md`.
  **Managed spawn (S1, `webHub.spawn.enabled`, default off; Linux-only, fail-closed platform probe)**: the hub
  itself forks `pi --mode rpc` children in user-chosen directories (`known ∪ roots` admission, loopback-only
  by default — `spawn.lan` off/known/roots) via `/api/headless*` + the `spawns` SSE event (Public projection;
  owner-only fields per-request; the first-prompt body never persists anywhere). Identity is
  `bootId+starttime+uid` ONLY (pi rewrites `process.title`, so cmdline never identifies a child); children
  inherit the USER's umask (main.ts captures its pre-0o077 mask and the supervisor swaps it around each fork).
  Orphan invariants L1–L5: intent on disk before fork, an independent reaper watchdog child TERM→KILLs
  tracked orphans ≤12s after ANY hub death, boot-time recovery re-verifies identity before signaling, and
  every signal is preceded by a sync identity re-verify. `spawn.v1` rides both cap surfaces only when
  `config.spawn` exists. SP13's `tests/integration/web-hub-headless.test.ts` (H1–H8 hard gates, real hub
  child processes + `fixtures/fake-rpc-pi.mjs`) and `tests/conformance/rpc-spawn.test.ts` (real pi) are the
  S1 merge gates — design: `docs/dev/web-hub-spawn/{arch,plan,acceptance}.md`.
  **Restore across hub restarts (`webHub.spawn.restore`, default true, only under `spawn.enabled`)**: a
  graceful restart / crash re-forks every recoverable managed session on the new hub as kill-old-then-fork
  (`--session <file>` or `--session-id <id>`, never `--model`), same spawnId, new agentKey carrying
  `restore.prevAgentKey`; L6 — never fork while the old identity's death is not `confirmed`; intent persisted
  before every fork; `/webhub stop` leaves a one-shot `<stateDir>/spawn/restore.veto` (restart clears it);
  `restore:false` is byte-identical to pre-restore behavior. HR1–HR7 / CR1–CR3 gates — design:
  `docs/dev/web-hub-spawn-restore/plan.md`.
  **Delete session (`POST /api/agents/remove`, web-hub-delete-session plan v2)**: an AgentCard / SpawnRow two-step
  delete removes the card (and, for a managed session, stops the process first); the session jsonl is never deleted.
  Three invariants: **B-alive** — a record/card is dropped only after a read-only identity probe confirms death (or
  `noProcess` evidence); alive/unknown ⇒ 409 `E_AGENT_ONLINE{exit-unconfirmed}` and the card comes back, an online TUI
  is refused (`online`), an offline TUI/external rpc card is dropped with no signal at all; **B-fork** — replaying the
  same create `id` within the dedup TTL after a delete ⇒ 409 `E_BAD_REQUEST{spawn-gone}`, never a fresh fork;
  **B-stream** — `agent_removed` is published only after dropAgent + clearing that agent's SSE subscriptions.
  `removeIntent` persists synchronously so a hub crash mid-delete converges on the next boot. LAN with `spawn.lan:"off"`
  cannot delete a live managed card (403 `lan-off`). Design: `docs/dev/web-hub-delete-session/plan.md`.
  **Worktree panel (worktree-web plan v1.1)**: `agent/worktree-sampler.ts` samples the session cwd's repo through
  `src/git/` (local commands only — never fetch; hard per-scan deadline, single-flight, zombie guard across
  stop/start, all timers unref'd, inert in print mode) and rides the optional `StatusInfo.worktrees` slot
  (append-only, open-but-bounded schema, `agent/worktrees.ts` byte-budgeted projection, fingerprint-gated
  publish) to a read-only `WorktreePanel` on the web detail header (absolute paths shown, 1 worktree included).
  Design: `docs/dev/worktree-web/plan.md`.
  **Bash-jobs panel (bash-jobs-panel plan v3/v4)**: `agent/bash-jobs-sampler.ts` samples the main session's
  background bash jobs (`BashJobManager`, source-generation pinned, single-flight with per-job deadlines, all
  timers unref'd) and `agent/bash-jobs.ts` projects to the optional `StatusInfo.bashJobs` slot (D1 row
  selection, D6 24 KiB budget with a five-step reduction ladder, fingerprint-gated publish, hot path zero I/O)
  to a read-only `BashJobsPanel` on the web detail header. Command + log tail are kept per the U1 sole-LAN-user
  ruling — `agent/redact.ts`'s secret scrubbing is HYGIENE ONLY, never a security boundary. Design:
  `docs/dev/web-hub/bash-jobs-panel-plan.md`.
  **Content preview (web-hub-preview plan v3, setting `webHub.preview` — `"on" | "loopback" | "off"`, default
  `"on"` per the 2026-10-05 user ruling U1: sole LAN user behind password auth, risk explicitly accepted; change
  is non-live — `/reload` then `/webhub restart`)**: an absolute path in a settled message (assistant text, user
  bubble, or a ToolCard's Input section, all rendered through `ui/src/components/preview/PathText.vue` — never
  `markdown.js`; streaming replies stay plain text until they settle) opens a read-only dialog via the single
  endpoint `GET /api/preview` (`X-PWH: 1`; raw bytes + `X-PWH-Preview-*` metadata headers; no new SSE/frames).
  Two admission classes: **upload attachments** (`hub/uploads.ts`'s `openForPreview`: structural re-check of the
  generated `<uploadId>.<ext>` / legacy `<id>/<safeName>` layouts, sha256 re-verification) are shared with the
  **session's viewers** (U3 — revises upload-plan §5.1's "uploader-only" read rule; writes/abort/dedup/pinning
  stay principal-bound, recorded as an appended note in that plan), and **cwd files** (`hub/preview/admit.ts`:
  the session.cwd subtree — home as cwd allowed per U2, guarded by the virtual-root + literal denylist — plus
  realpath×2, dev/ino re-check, `O_NOFOLLOW` open, `/proc/self/fd` re-verification). Caps: text 256 KiB (UTF-8
  boundary), images 16 MiB loopback / 4 MiB LAN / 40 MP (unparseable dims ⇒ reject; touch clients budget 20 MP);
  preview reads never pin or extend upload TTLs. `mode:"loopback"` keeps the endpoint LAN-absent (404, byte-
  identical to `off` on LAN) while loopback keeps previewing. Design + real-device acceptance:
  `docs/dev/web-hub-preview/{plan,acceptance}.md`.
  **Session switching (web-hub-session-switch plan, E1+D2)**: the browser UI keeps the last K sessions subscribed on
  the hub (main-subscription LRU keep-alive; browser pref `pwh_keepalive`, default 3, `1` = legacy single-slot, pure
  planner `ui/src/logic/sessionKeepAlive.ts`; `useHub`'s library default stays 1 — only App.vue lifts it to the product
  default), owns a main-subscription ledger with same-key op serialization and hello-time op voiding
  (`useHub.ts`, K=1 transport order pinned by `tests/fixtures/web-hub-ui/keepalive-legacy-golden.json`), guards in-flight
  snapshots with the optional `HistoryPayload.sessionId` (agent backfills `snapshot_reply.sessionId`; missing on either
  side passes through — compat window), and remembers per-agentKey transcript scroll position on switch. Design:
  `docs/dev/web-hub-session-switch/plan.md`.
- `src/git/` — pi-free bounded git executor (`run.ts`: hard deadline, process-group kill, stdout/stderr caps,
  unref'd timers) + `git worktree list --porcelain` parse/scan (`worktrees.ts`) + `~` path labels (`path-label.ts`).
- `src/config/` — agent-type registry (Markdown frontmatter), fuzzy model hints, settings file.
- `src/quota/` — quota-aware dispatch: provider adapters + TTL cache, laddered turn_end warnings, and a spawn fast-fail gate
  (design: `docs/dev/quota/`). A window whose `resetAt` has elapsed levels to 0 (`reason:"reset-elapsed"`, HUD `7d 100%·reset`) and bypasses
  the refresh TTL only while the snapshot predates the reset; `quota.repeatS` re-sends at L3 only. Ladder thresholds are per-window
  (repo defaults: 5h 50/75/90, week/7d 50/95/98 — `ladder.ts`'s `DEFAULT_THRESHOLDS_BY_WINDOW`; `l3EtaMs` stays global). `quota.windows.{5h,week}.{l1,l2,l3}Percent`
  override a single window; the legacy flat `quota.l1Percent/l2Percent/l3Percent` still work and, when set, override BOTH windows
  (back-compat) — window-level fields win over the flat override, which wins over the per-window default. Each window's l1<=l2<=l3
  is clamped independently.
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
- `src/workflow/` — `SubagentWorkflow` engine: orchestrator, journal/replay, runaway detection, and the per-stack
  background registry (`background.ts`: start → bounded run/stop/settle with degraded fallback so every workflow
  reaches a terminal entry, `stop`/`wait`/`resolve`, bounded terminal retention, `shutdown`/`drain`/`seal` on
  session_shutdown and `abandon` on a defensive rebuild). Completion notices are pi-facing
  (`src/adapters/workflow-notice.ts`: `sendMessage` + `triggerTurn` while live; persisted `subagent:workflow-notice`
  entry during shutdown, re-delivered once by the next stack on that session file). `agent()` calls beyond `maxParallel`
  FIFO-queue instead of failing (host acks first, then queues; non-time-exhausted dispatch failures reject the script's
  `agent()`; out-of-time while queued ⇒ withheld `null`; a worker-wide `unhandledRejection` is reported as `stage_error`
  `source:"unhandled"`, never `worker_died`); `agent()`'s `opts.model`/`opts.thinking` are real per-call overrides
  (Agent-tool `model`/`thinking` semantics — strict `provider/id` vs fuzzy-hint split via `parseStrictModelRef`, unknown
  model ⇒ dispatch-failure reject with suggestions; both fields join the journal taskKey so a model swap never replays
  the old result); workflows share the subagent timeout grace + extension machinery
  (`deadline.ts`: pure deadline controller, `killAt()` bounds host calls/BW2/gate; `extend_subagent_timeout` accepts `wf_…`
  ids — full/prefix/script name — and refuses a workflow's children, which are pinned to the workflow `hardAt`;
  an
  explicit `timeout_s` follows the same grace/extension rules as the default budget — `hardAt = start +
ceil(f·workflowTotalMs)` with the base `maxTotalFactor` preserved — while the workflow's children stay
  fixed-deadline). `agent(prompt, opts?)` opts are strictly validated (`agent-opts.ts`: only
  `label`/`agentType`/`phase`/`fullResult`/`model`/`thinking`/`isolation`/`experts` — any other key, a non-plain-object
  `opts`, an accessor/Proxy/function-valued known key, or a malformed `experts` array reject with the full allowed-key
  list and a mistaken-key hint; the worker (`worker-source.ts`) takes its own structural snapshot first and never
  `postMessage`s an unclonable value — host.ts re-snapshots independently and either side's defect wins) and
  `agent({ experts })` lets a workflow child consult in-turn (`expert-scope.ts`: resolution order is `"main"` → this
  workflow's own same-labeled call (by declared or effective label, rejecting on any unsettled/ambiguous/non-completed
  candidate) → the consult wiring's `resolveExperts(refs, { completedOnly: true })`, D8 — stricter than the top-level
  Agent tool, which stays completedOnly-agnostic); any call that declares `experts`, and every call submitted after one
  whose experts resolved successfully, never reads or writes the journal (`replay.ts`'s `"experts"`/`"chain_tainted"`
  skip reasons, checked before `config_hash_unavailable`/lookup) — `TaskSemantics`/`taskKeyOf` are unchanged (experts
  never join the key). `agent(prompt, { isolation: "worktree" })` (workflow-worktree plan, packages P1/P2) now
  really isolates that one call in its own git worktree (built from the current HEAD by the same H2/H3 extension
  the top-level `Agent` tool uses) instead of only marking the journal entry: `ChildSpawner.worktreeAvailable()`
  (stack.ts wires it to `worktree.enabled`, no fallback) gates admission (`isolation_unavailable` reject, never
  journaled, never taints); an accepted isolation call taints the rest of the run's replay chain exactly like
  `experts` does, and is itself never journaled/replayed (`replay.ts`'s `isolation` input, checked before
  `configHashAvailable`/lookup). The host waits up to `min(remainingWorkflowMs(), worktreeSettleMaxMs)` for H3's
  disposition before settling (`worktree:{state}` on the settle envelope and in `fullResult`'s extra `worktree`
  key — the only new key, and only for an isolated call); a give-up settles `pending` (frozen, the worker never
  hears about it again) while an unbounded "late" listener keeps waiting in the background and folds a real
  disposition into `WorkflowChildSummary.worktreeFinal` (never mutating the frozen `worktree` field) — visible on
  a `children` read taken after it arrives. A workflow stop/timeout force-settles a still-bound isolated call as
  `aborted` + `worktree:pending` while H3 keeps committing in the background (D7 — same "no orphan" contract as a
  top-level `Agent`). `SubagentWorkflow`'s outcome text/notification carry a self-bounded `worktrees:` block
  (64 lines / 8 KiB, `git branch --list 'pi-agent-*'` pointer beyond that) spliced in _outside_ the head/tail-
  truncated body, so branches survive truncation. The workflow never merges branches itself — that is the
  dispatching session's job, same as for a top-level isolated `Agent` run. **replay-verify (P2, todo #13,
  `workflow.isolationReplay`, default `"verify"`)** narrows the P1 "never journaled/replayed" rule above: a
  `committed` (with sha) or `clean` isolated call's outcome is now journaled, and on a later run with the same
  journal it replays IF AND ONLY IF its `pi-agent-<runId>` branch, checked once at load time via a single
  bounded `git for-each-ref` (`src/workflow/isolation-verify.ts`, pinned cwd, `AbortSignal` + `withDeadline`
  triple-bounded, zero git calls when there is nothing to verify), still points EXACTLY at the recorded commit
  (`clean` entries are never checked — same non-checking semantics journal replay already has for every
  ordinary call). In `chain` scope an accepted isolated call no longer taints the rest of the run; instead its
  live-run identity (`isoId`) folds into the chain digest (`host.ts`'s F1/F2), so a verified hit reproduces the
  exact fold the upstream live run applied and the whole downstream chain can hit too — `content` scope and
  `isolationReplay:"off"` keep the old unconditional taint. A terminal, diagnostic-only recheck (running
  concurrently with the journal flush, never gating it) annotates a replayed child's summary with
  `replayStale:"gone"|"moved"` if its branch was moved/deleted between the load-time snapshot and settle —
  it never revises the settle the script already received. Design: `docs/dev/workflow-worktree/replay-verify-plan.md`.
  **todo #21**: `buildJournalConfig`'s pre-boot `store.load()` is bounded by `WorkflowRunBudget.journalLoadMs`
  (default 5s); a timed-out load degrades that run to fully live and skips writing the journal (`WorkflowOutcome.replay.loadError`), never fails the run.
  Design:
  `docs/dev/workflow-background/plan.md`, `docs/dev/workflow-agent-queue/plan.md`, `docs/dev/workflow-experts/plan.md`,
  `docs/dev/workflow-worktree/plan.md`.
- `src/adapters/` — pi-facing shims (compat probing, outbox store, run log).
- `src/tools/`, `src/commands/`, `src/ui/`, `src/mention/`, `src/rpc/`, `src/extensions/` —
  tool surfaces, `/agent` command (status/settings/costs), fleet widget + TUI settings editor,
  `@label` mentions, RPC, extension points (worktree isolation). RPC spawn success replies weakly carry `{ runId, label? }`; keep the schema result opaque.
- `tests/` — mirrors `src/` plus `integration/` and `fixtures/`.
- `docs/dev/` — per-feature design docs (agent-background-only (supersedes auto-background), workflow-background,
  workflow-agent-queue (agent() 排队 + workflow 宽限/延长), delivery v2, bash-auto-background,
  subagent-push/fabric, compact-hint, timeout-notify (宽限+延长), consult, sysprompt-stable (system prompt
  冻结快照 + 唤醒回放), ...); read the matching one before changing that subsystem.
- `scripts/release/package.sh` — stage 9 of the git-release flow (zip + sha256 + notes).

## Conventions

- **TypeScript strict**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride` are on. ESM (`module: NodeNext`) — relative imports need the `.js`
  suffix (`import { x } from "./foo.js"`).
- **Prettier** formats everything; a versioned pre-commit hook does it automatically —
  enable once with `git config core.hooksPath .githooks`.
- **UI text language split**: compact inline markers — HUD status lines, tick lines,
  badge/suffix fragments — use English tokens only (`5h 62%`, `·stale 12m`, `⤓demoted`);
  never mix Chinese words into them. Chinese is reserved for prose blocks aimed at the
  user/model (multi-line advice/warning copy).
- **Conventional Commits** (`feat|fix|docs|refactor|perf|test|chore|ci(scope): ...`); the
  CHANGELOG is generated from them.
- Tool parameters use `@sinclair/typebox` schemas. It is host-provided (pi aliases it to its bundled
  `typebox` at load time), so it lives in `peerDependencies` with a `"*"` range (+ `devDependencies`
  for local tests) — never in `dependencies`: pi ≥1.0 warns, since an installed copy can bypass the
  loader's module mapping and duplicate runtime modules. There are no runtime `dependencies`.
- Peer dependencies on `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` are pinned to
  `>=1.0.0 <1.1.0`; bump deliberately and re-check `src/adapters/pi-compat.ts`. Before bumping, run
  `npm run test:conformance` (real `AgentSession` boundary-draft contract + runtime capability
  self-check, `tests/conformance/`) — it never gates pi-compat's structural probes (I14), it just
  tells you ahead of users whether `src/context-switch/capability.ts` still reaches `verified`.

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
