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
npm run build:web    # web-hub UI (vite) → dist/web-hub-ui/ — toolchain needs Node ≥22.12 (mermaid's engines; CI has a 22.12.0 job)
npm run check:web    # UI bundle gates (CSP/size/provenance/licences) · npm run probe:mermaid = real-browser mermaid gate (Chromium+Firefox, not in CI)
npm test             # vitest run — 17,000+ tests; must stay green
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
  (no 1ms busy-loop), and `systemClock` is built on it (unref semantics preserved). Per-grant
  extension cap (user ruling 「每次延长最多 1h」): `budget.extendStepMs` (`budget.extendStepS`,
  default 3600s, `0` = legacy) bounds each extend_subagent_timeout grant
  (`extensionGrantCapMs`, one logic consumed by both reducer and runner) and widens the extendable
  run's hard ceiling to `max(ceil(T·maxTotalFactor), T + maxExtensions·extendStepMs)`
  (`hardDeadlineAtFor`; factor-1/fixed and maxExtensions=0 runs keep the legacy span unchanged);
  workflows reuse the same value via `run-budget.ts` (no own settings leaf).
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
- `src/cache-ttl/` — prompt-cache TTL modes `auto`/`on`/`off`, status-bar indicator,
  persisted settings override, and `/cache-ttl`; main-session-only `/cache-ttl measure` measures TTL/read renewal over Anthropic or OpenAI with a 17-request hard cap, revocable process claim and bounded async result store (`docs/dev/cache-ttl-keepalive/measure-plan.md`). Auto follows pi/env; on explicitly forces 1h;
  off strips the TTL override. No automatic 1h upgrades remain (user decision 2026-10-11).
  Copilot (`github-copilot`) is token-billed and is no longer provider-denied (2026-10-18 user ruling);
  only Anthropic-messages API requests remain eligible, subject to every normal safety/budget gate.
  Keepalive captures only the provider payload of each real request (pi's `onPayload`; a strict-tools
  fallback's second payload replaces the first) and replays it through pi's own provider pipeline
  (`src/cache-ttl/pipeline-ping.ts` → `ModelRegistry.streamSimple` with a wrapped fetch, one 20 s deadline over
  auth+fetch+read, at most one POST, cancel fired never awaited), so auth and headers are resolved by pi exactly
  as for a real request (plan `docs/dev/cache-ttl-keepalive/capture-pairing-plan.md` r7). The capability probe
  lives in `src/adapters/pi-compat.ts` and fails closed (`transport-unsupported`, non-persisted
  `activationDisabled`, forgotten on `/reload`); pi's built-in `github-copilot` provider is
  `provider-unsupported` for technical reasons (custom copilot-* providers are not); extension-added request
  headers are not detected (user ruling 6, noted in `/cache-ttl status`); a ping whose transport has not
  physically settled holds `io-busy` (no retry/next ping), and each child ping-ledger lease settles exactly once.
  Pings run under bounded ping budgets,
  fingerprint/session/epoch guards, and unref'd timers (service in `src/service/cache-keepalive.ts`).
  A single ping retries until the cache window runs out (2s→5s→10s→20s→30s then constant 30s, bounded by
  `aliveUntil − TTL_SAFETY_MARGIN_MS`; 3 attempts when `aliveUntil` is unknown; retryable = network + HTTP
  408/429/500/502/503/504/529; r2 2026-10-14). Never-processed transients (network / retryable HTTP) no longer
  pause the session — the next window retries afresh (legacy `disabled{transient:true}` snapshots are lifted on
  read-back); only possibly-billed transients (accepted-then-lost / malformed) still use the streak/total
  limits, cleared by a successful real response. `/reload` restores the branch's breaker state. `no-usage` (200 without cache usage) is line-level too
  (`session.noUsageStates`, same line key and per-line streak/total thresholds, never `session.disabled`; user
  ruling 2026-10-20): it lifts with NO cooldown on a same-line real success whose response reported cache usage
  (read>0 or write>0 — a success without usage leaves it tripped), another line keeps pinging, a model switch
  resumes, switching back stays tripped until such a success; HUD `ping off:no-usage`; a legacy persisted
  `disabled{no-usage}` migrates to a wildcard no-usage breaker.
  `proven-write` (the ping found the cache gone and paid a full write; user ruling 2026-10-20, supersedes the old
  session-permanent disable) is line-level as well (`session.provenWriteStates`, same line key, own map so reasons
  never share counters): it trips on the FIRST occurrence (no thresholds), never sets `session.disabled`, and lifts
  with NO cooldown on ANY successful real request on that line (no cache-usage requirement — a real request re-
  establishes the cache; unlike no-usage), another line keeps pinging, a model switch resumes, switching back stays
  tripped until such a success; HUD `ping off:proven-write`; a legacy persisted `disabled{proven-write}` migrates to a
  wildcard proven-write breaker; child keepalive lifts it the same way (only this breaker recovers in a child). The
  web panel marks line-scoped last pings (`lastPing.line`, proven-write/no-usage) 「线路级」, never 「永久」.
  Non-transient HTTP rejections (4xx, zero-billing) are line-level (`session.lineStates`, key =
  provider+baseUrl+model): a same-line successful real request resets them (backoff 30m×2^(n-2) on repeat,
  cap 24h; legacy session-level http disables migrate to a wildcard breaker), and `/cache-ttl keepalive reset`
  manually clears every breaker (design: `docs/dev/cache-ttl-keepalive/breaker-recovery-plan.md`).
  Design: `docs/dev/cache-ttl-keepalive/plan.md`. **Child-session keepalive** (child-context-switch
  plan §2.4, `src/cache-ttl/child.ts` + `child-registry.ts`): capture-only (never rewrites the
  outgoing payload); per-window cap uses the CAPTURED payload model's registry-mapped cache
  prices (whole tier from that real response's full input usage; missing tier usage ⇒ fallback 11),
  clamped to 0–96 (`clamped` above 96); this budgets the cache PREFIX only, not uncached input/output,
  and fallback 11 has no profitability proof. The removed `cacheTtl.keepaliveMaxPings` key (even 0)
  is ignored, with a status-only deprecation note (never session_start notify); turn off with
  `cacheTtl.keepalive:false` then `/reload` (master wiring is non-live). Other child limits stay
  24/run · 4 concurrent · $1.5/run · $10/24h process-rolling
  (`ping-ledger.ts`), no price info ⇒ no ping (`usd-unpriced`); ping cost folds into the child run's
  own `usage.costUsd` (fleet/HUD visible); disposed on `agent_settled` and defensively via the
  registry's `onReaped`. **`warmth.ts`** (topic-switch plan P2): a pi-free, never-throwing
  `CacheWarmthPort` (`wireCacheTtl`'s return value, `CacheTtlWiring.warmth`) that judges whether
  the NEXT Anthropic request would read a warm prompt cache from a proven recent ledger or
  keepalive touch (`provenCacheReadAt()`). `mode`/`lastSent`/1h-write traces only raise the bar
  for PROVING cold (Anthropic's 1h max TTL) and pick `nextWriteTtl`; anything unprovable is
  `unknown` (topic-switch's gate 3a treats that as "don't ask", same I6 fail-open direction).
  **Late-usage lines (2026-10-20, plan.md 「late-usage lines」)**: relays that report cache stats only in the stream's final
  `message_delta.usage` (measured: kimi-coding/k3, `api.kimi.com`; `message_start` shows 0/0 even on a hit) are either seeded by
  baseUrl host (`LATE_USAGE_SEED_HOSTS` in `late-usage.ts`) or learned (a 0/0 ping followed by a real `cacheRead>0` sets a
  persisted `lateUsageAt` on the route in provider-evidence). Their ping replays the capture byte-for-byte except `max_tokens`
  clamped to 4 (never 1 — kimi special-cases it and skips the cache; thinking is never touched — it keys the cache), reads
  until the first `message_delta` with usage under the same single 20 s deadline (scan cap 256 KiB for this mode only), bills its
  ≤4 output tokens, and `/cache-ttl status` shows `late-usage: seeded|learned`; non-late lines stay byte-identical.
  **Provider evidence layer (2026-10-12, plan v3 — ten-line probe measurements)**: `provider-evidence.ts`
  (pi-free, `~/.pi/agent/cache-provider-evidence.json`, 0600/atomic/1MiB cap/30d rolling TTL/200-route
  FIFO/fail-silent) records per provider+model whether 1h writes ever LANDED (relay collapse is real:
  cr-anthropic/kimi-coding write zero 1h entries), probe verdicts, and the no-cache-value streak.
  warmth's 1h ceiling requires landing EVIDENCE (intent like mode=on no longer raises the window);
  keepalive gate #7 splits on it (no evidence ⇒ 1h captures get a ttl-stripped 5m ping; evidence ⇒
  legacy skip; store absent ⇒ byte-identical legacy); 3 consecutive keepalive-active-but-zero-read
  sessions trip a self-healing `no-cache-value` ping breaker; `/cache-ttl probe` runs a 3-request
  live checkup that feeds the same store.
- `src/child/` — child-session assembly entry point (`wire.ts`'s `wireChildSession`, called from
  `src/index.ts` pre-guard when `isChildSession`, alongside `wireMemory`/`wireChildBashJobs`): composes
  `wireChildContextSwitch` + `wireChildKeepalive`, wiring their one cross-cutting signal (a committed
  boundary switch invalidates the keepalive prefix like a compaction does). Reads only the existing
  `isChildSession` boolean — does not touch `HOST_KEY`.
- `src/fabric/` — inter-agent message fabric: router (admission, per-kind quotas, dead letters),
  mailbox, tree routing, per-link throttle. `message_agent` is scoped to subagents via
  `src/runtime/tool-scope.ts`; routing relations come from the agent type's `can_message`
  frontmatter (default: parent only).
  **Wake phase 1 (in-tree only; `docs/dev/fabric-cross-session/plan.md` v3, packages S0/F0/W1–W6/G, reports
  `W2..W6-report.md`, `G-report.md`)**: `fabric.wake.{enabled,maxLevel,perRunQuota,resumeBudgetS,resumesPerHour,
resumesPerTargetPerHour,parkCapPerTarget}` (`enabled` default true but only effective while `fabric.enabled` — default
  off — is on; read once at stack build, non-live). With wake on, `message_agent` gains an optional `wake` boolean
  (schema frozen per activation; wake off ⇒ the pre-wake schema instance, pinned by `tests/fixtures/fabric-wake-off-golden.json`
  — never regenerate it — and C-P4): omitted = legacy byte-for-byte, `false` = deliver-only (to a finished run: **park**,
  pending until TTL or until a resume carries it; needs inbox durability `disk`/`session-memory`, `stack-memory` ⇒ legacy
  `target_gone` + `parkUnavailable`), `true` = wake (expensive; progress ⇒ `invalid_wake`). Wake to root is exactly the legacy
  steer+`triggerTurn` call (no new unmanaged root run path in phase 1). **Causal level** (`wake-level.ts`): `diag.wakeLevel`
  (reducer input `wake_level`, monotonic, persisted with the terminal entry; root level in `subagent:wake-level`); only
  proven human input resets root (`wake-input.ts`'s `input` hook; runs never reset); an effective wake hop needs
  `level+1 ≤ maxLevel` else it silently downgrades to deliver-only (`level_limit`). **Successor coalescing**
  (`SpawnService.resumeOwners`/`successorOf`, mailbox `waitingFor`/`drainSession`): a message for a finished run whose
  session chain already has a successor waits for it (pending_start) or is redirect-steered into it (durable
  `steerAttempt`; a steer timeout/restart ⇒ audited consume, never a retry). **Revive** (`WakeService.revive`, the single
  exit): root-direct resume with the pinned model/thinking, fixed `resumeBudgetS` budget, `poolFullPolicy/loadPolicy:"reject"`
  (pool/load/quota/closing/lock ⇒ park, config-class ⇒ `wake_refused` dead letter); exclusions recorded at admission
  (`wakeExclusion`: consult fork, readonly domain, caller-owned incl. workflow children, external/droid) + worktree gone /
  unknown type / user-stopped (Q6) / legacy entry without a verdict (fail closed). Reservation ownership is claim-aware
  (`engine.reserveStrict`, persist-first; a failed rollback ⇒ quarantine); **at-most-once rule** (NQ2): the linearization
  point is `diag.inputAcceptedAt` (driver `input_accepted`, `trackInput` runs only) — only a REAL terminal entry proves
  non-delivery (release), every ambiguous case is an audited consume (`resume_unverified`/`steer_unverified`/
  `reservation_expired`/`reservation_quarantined`, never message text). **Quiet completions**: a revived run's
  `DeliveryPayload.quiet` makes `stack.ts`'s `sendFormatted` use `sendMessage({triggerTurn:false})` directly (no hub token,
  no `ask_user` interrupt, hub ignores quiet `message_start`; mixed digests split, quiet first). **`wake_result`**: the
  trigger sender (registered synchronously inside admission) and coalesced `wake:true` senders get ONE system summary
  when the successor ends (cap 8 per successor ⇒ `subscriptionUnavailable` receipt; a finished waker is skipped with an
  audit line, never woken; root is covered by the owner notice; entries are watched by one unref'd 10-min timer and an
  evicted/unknown successor's entry is dropped). Visibility: `/agent status` adds one `wake on · lvl≤N · root L· ·
resumes a/b h · parked · reserved · unverified · quarantined · durability · results · dead <reason>=n` line (absent when
  wake is off), `get_subagent_result` adds `Woken by <ref> (level n) · +N inbox messages` / `Resumed with +N inbox messages`.
  Accepted limitation: after a real `/reload` the old stack's `onReaped` closure is dead, so a reservation whose run
  was still closing is re-judged by the NEW stack's 60 s fresh-`getBranch()` fallback (bounded, never unbounded
  waiting). Cross-session wake (C1, RootWakeController, mutation fence) is phase 2 — plan §12 is an archive that must be
  re-reviewed first. Gates: `tests/integration/fabric-wake*.test.ts`, conformance C-P1…C-P5
  (`tests/conformance/fabric-wake.test.ts`; run before any pi peer bump together with consult-preserve), state-machine
  matrix/property in `tests/core/`.
  **Cross-session phase 2** (`docs/dev/fabric-cross-session/phase2-plan.md`, §13/§14 + r3 rulings):
  main sessions only, settings frozen at activate; `fabric.enabled` + `fabric.crossSession.enabled` +
  `webHub.enabled` + `webHub.control !== false` gate tools `list_sessions` / `message_session`, `/fabric`,
  `xs.v1`, member slots and `StatusInfo.xs` (off ⇒ byte-identical; no reserved-name change). Two human
  opt-ins: settings enabled, then local `/fabric join|leave` or `fabric.crossSession.autoJoin` (default
  false); agents cannot change membership, receive policy, blocks or fences. Mutation subcommands
  (join/leave/receive/block/unblock/fence reset) are web-executable (2026-10-22 ruling, supersedes
  phase2 §5.3/#9/XI13): governed by `webCommandPolicy.fabric` (default allow; settable to
  confirm/deny — overrides the whole name) at the command-op policy layer, with unknown
  subcommands denied; the Feishu source is still hard-refused (hub F6 admission forwards Feishu
  only as prompt/dialog ops — the prompt-op `/fabric <mutation>` text guard answers with the
  dedicated 「飞书入口」 refusal — and the `/fabric` handler hard-refuses Feishu-marked captured
  invocations via `isFeishuInvocation`, derived from the hub-internal `ip:"feishu"` origin
  marker); web prompt text carrying `/fabric <mutation>` is likewise refused (defense-in-depth
  so prompt text can never bypass the policy gate). status/blocks stay read-only. Joined
  receive defaults to `wake` (`fabric.crossSession.receive`, `allowFrom`); fork/copy never inherits
  membership, even with autoJoin. `message_session` omits wake = deliver-only; `wake:true` alone may
  start a turn through `RootWakeController` (no steer), gated by `fabric.wake.enabled`, causal level,
  capability, goal and quotas. Unknown host capability downgrades to deliver-only until real runtime
  shape evidence; root deadline `fabric.wake.rootRunMaxS` (default 900s) starts at dispatch, including
  pre-start compaction. Token authorization and dedup survive /reload; marked unauthorized/expired
  triggers abort before their first provider request (B1); human handover only after proven own-run
  start. Mutation fences (compaction/tree/switch/web_exec/topic_switch) reject ALL ingress; goal
  only downgrades wake. A 30s stuck warning never opens a fence; input/run-start is NOT completion
  evidence (r3 M1); local `/fabric fence reset` is the manual escape. M2 effects: before-send
  cancellation/origin change = `none`; after-send no verdict = `unknown`, received remote evidence
  stays intact. Busy recipient = `unknown/queued` (may be queued, never blindly resend). Defaults
  under `fabric.crossSession.limits`: out 10/min + 60/h, out wakes 6/h, in 30/h + wakes 12/h,
  pair interval 30s + wakes 2/h, in-flight 4/session, hub 60/min, inbox 12; hub owns outbound quota.
  `/agent status` reads the live xs stack (outbound usage unavailable ⇒ `out n/a/60h`, never fake 0);
  AgentCard's cap-gated `xs wake|deliver|off` badge is display-only, never authorization.
  `details` (token/xid/source) never enters provider payload; enabled tools/system stay stable.
  Peer-upgrade gates: `tests/conformance/fabric-xs.test.ts` C-X1/X1b/X2/X3/X4/X5/X6/X7 with real pi
  and a local Anthropic stub, alongside fabric-wake C-P1–C-P5 and consult-preserve C1–C7; C-X7 records
  duplicate-tool arbitration without relying on a winner. Both off goldens must remain unchanged.
  **Request-reply (reply-plan r2, `docs/dev/fabric-cross-session/reply-plan.md`; packages RX0–RX6/RXW/M/MW, reports
  `*-report.md`)**: `message_session` gains `expectReply:{timeoutS}` (A asks) and `replyTo:<requestId>` (B answers,
  `to` = full sessionId); both ride the `xs.reply.v1` cap (only added when BOTH ends advertise it — no PROTO bump; hub
  `REPLY_UNSUPPORTED` early-rejects without reserving) and require `fabric.crossSession.reply.enabled`
  (default true; schema/off paths pinned by `tests/fixtures/fabric-xs-reply-off-golden.json` — with xs on ∧ reply off every
  surface is byte-identical). `receive` accepts `"replies"` (only a valid, solicited reply is accepted; unsolicited
  traffic is refused by hub and receiver) via the pure `effectiveReceive(pref, replyEnabled)`: reply unavailable ⇒ **off,
  never wake** (fail closed); membership persists `{receive:"off", receivePref:"replies"}` so an older plugin reads off.
  **Credential = the issuing process's in-memory ledger only** (`src/fabric/xs/reply-ledger.ts`,
  `Symbol.for("pi-subagent:xs-reply-ledger")`, 64 slots, never evicts a live entry, sweep is process-wide/lazy): disk
  (`subagent:xs-reply` entries) exists solely to emit a post-restart "invalidated" notice — `/tree` rollback, tombstone
  eviction and pi restart can only REFUSE a reply (unknown id ⇒ rejected), never resurrect one. Consumption is
  reserve → commit/release around the host dispatch: reserve flips the ticket to `consuming` BEFORE any re-entrant
  call; only a provably-ineffective dispatch releases, everything else commits a tombstone ⇒ per requestId at most one
  possibly-effective dispatch (`tests/fabric/xs-reply-receiver.property.test.ts` drives the real receiver + ledger).
  Replies use an independent `replyInbox` (quota: receivable+consuming tickets + inbox occupancy ≤ `maxPending`), skip
  recv rate/inbox caps, and a solicited wake returns the root to `requesterLevel` (no +1, R3). Timeout/late handling:
  `timed_out` stays receivable until `lateUntil` (late reply = deliver-only); the timeout/invalidation/away-summary
  notices go through **NoticeGate** (`reply-notice.ts`: disposed/session/joined/receive/fence admission, owed kept and
  retried on event-driven flush points + 30 s fallback, dropped at `lateUntil` and counted; a delivered notice is never
  re-owed). **@session mention** (`src/mention/session.ts`, `fabric/xs/directory.ts`): `@session:<ref|name>` explicit form and
  a bare `@name` (R6 priority: subagent/real file path win; path-shaped never; a bare-name cache miss triggers one throttled
  directory refresh); not joined / xs off ⇒ passes through untouched; a human-origin reply wakes per receive mode and
  cross-session messages are user-visible (RX7 — do not hard-code the old R4 "display only"). Settings
  `fabric.crossSession.reply.{enabled,defaultTimeoutS,maxTimeoutS,maxPending,maxPendingPerTarget,lateGraceS}` (frozen at
  stack build; `timeoutS` above the max is clamped). Visibility: `/agent status` adds
  `xs replies p<pending>/<max> i<inbox> to<timedOut> late<n> rej<n> owed<n> drop<n> · ledger n/64` (absent when reply is
  off), `/fabric status`/`/fabric replies` show the same counters/rows and `(pref replies)` when the effective receive differs.
  Gates: `tests/integration/fabric-xs-reply*.test.ts` (real hub child × real stacks, §12.2 #1–#9) +
  `fabric-xs-mention.test.ts`, conformance **C-X8** (`tests/conformance/fabric-xs.test.ts`, real pi: solicited run binds
  its token, reply/token details never reach the provider payload, quiet replies don't start runs, replies mode refuses
  unsolicited — run with C-X1…C-X7 before any pi peer bump). All THREE off goldens
  (`fabric-xs-off`, `fabric-wake-off`, `fabric-xs-reply-off`) must never be regenerated.
  **Channels + broadcast + unread inbox (channel-plan r3, `docs/dev/fabric-cross-session/channel-plan.md`; packages
  CH0–CH6/CHU/CHU-b/IB1/IBP/IBU/IBW/CHW, reports `*-report.md`, real-device checklist `channel-acceptance.md`)**: a channel is a
  communication SCOPE, not a credential (names are not secrets; pair with allowFrom/block). Membership is human-only
  (`/fabric join [#a #b]` incremental, ≤4 names, lowercase ASCII, `#default` = legacy; local TUI/RPC/web per
  `webCommandPolicy.fabric`, Feishu hard-refused; agents have no join path). Discovery and addressing
  (`list_sessions`, `message_session`, `@session`, `/fabric block` resolution) cover only sessions sharing ≥1 channel (union);
  hub enforces it at list/resolve/send/broadcast with the **unique-holder (AMBIGUOUS) check BEFORE visibility filtering**, and the
  receiver re-checks at stage 3 against the hub-stamped `via`/`bc` (the linearization point of a local leave). Pure
  `effectiveChannels`/`linkChannels` (`src/fabric/xs/channel.ts`, `membership.ts`): gates read `link(hubCap)`/`linkJoined(hubCap)`, so
  on an OLD hub (no `xs.channel.v1`) a named-channel-only session fails closed (`/webhub restart`). Wire is additive (cap
  `xs.channel.v1` on both surfaces, optional fields `channels`/`via`/`bc`, NO PROTO bump); **default-only ⇒ frames, membership
  entry and status projection byte-identical** (compat proof `tests/integration/fabric-xs-channel-compat.test.ts`, three-way anchored on
  the golden; the three off goldens + `tests/fixtures/legacy-xs-v071/` never regenerated). Settings (non-live, frozen at
  activate/stack build): `fabric.crossSession.channels.{enabled (default true),autoJoin (default ["default"], boolean
`crossSession.autoJoin` stays the master switch),broadcast.{outPerHour,minIntervalS,wakeOutPerHour (hard ≤2),maxRecipients
(hub-global, ≤32),wakeMaxRecipients (hard ≤4)}}`. `channels.enabled=false` ≡ old agent: no cap, no `message_channel`, legacy
  `list_sessions` instance, and saved named channels are **suspended** (kept in the entry, never collapsed into default; `/fabric status`
  shows `suspended #a (channels.enabled=false)`). Broadcast = `message_channel{channel,text,wake?}` (main session only,
  registered post-guard iff xs ∧ channels): hub-side fan-out (`src/web-hub/hub/xs/broadcast.ts`), whole-batch admission by head count
  (`limits.admitBroadcast`: recipients ≤`maxRecipients`, hourly 6, min interval 60s, N charged against send quotas), `#default`
  cannot broadcast, no expectReply, sender never loops back, deliver-only by default. `wake:true` needs sender level 0 ∧
  hopAllowed ∧ N≤4 ∧ broadcast-wake ≤2/h ∧ outbound-wake quota; the first failing condition downgrades the whole broadcast to
  deliver-only (`wakeDowngraded`), each receiver still applies its own receive mode/maxLevel/fence/quotas; broadcast wake
  reservations and send counts are **NEVER refunded** (also P2P `unknown` no longer refunds) — a woken run is level ≥1 and cannot
  broadcast-wake again. At most one dispatch per (broadcast, recipient); `unknown`/partial ⇒ never blindly resend. Receivers see the
  first-line header `channel="#x" kind="broadcast"` + a host note (`formatXsMessage`; no `bc` ⇒ byte-identical); `details.bc`/`via`/token/xid
  never enter the provider payload (**C-X9**). **Unread inbox** (`src/fabric/xs/unread.ts`, `Symbol.for("pi-subagent:xs-unread")`, ≤32 session
  buckets FIFO): an event counter, NOT a correctness invariant — the two host write exits in `stack.ts` (receiver/Controller host + NoticeGate quiet
  write) call `tap.written(id)` after a successful `sendMessage` (broadcasts, replies, notices count; tree `message_agent` does not); `turn_start`
  stamps a monotone seq and `turn_end` (fallback `agent_end`) clears entries written before that turn started — better to clear early than never
  (128-id FIFO + two-bucket overflow keeps liveness; display `99+`). Survives `/reload`, resets on pi restart, forks start at 0. Surfaces: TUI status
  key `pi-subagent:xs-inbox` (`inbox N`), `StatusInfo.xsInbox{unread}` (open field, no cap; UI gates on `xs.v1`), `/fabric status` `inbox unread N`.
  Visibility: `/fabric status|channels` (channels line, `hub-cap on|off|n/a`, broadcast limits, `usage n/a` — the hub has no usage port) and
  `/agent status` adds ONE line `xs channels #default #team (2/4)[ · suspended …][ · inbox N]`, emitted only when it carries news (named
  channel, suspended names or unread>0) so default-only/off output stays byte-identical. Gates: `tests/fabric/xs-{channel,channel-ch3,
sender-channel,directory-channel,unread}*.test.ts`, `tests/web-hub/hub/xs-{channel-hub,broadcast,broadcast.property,router-v071-diff}.test.ts`,
  `tests/integration/fabric-xs-channel*.test.ts` (real hub child × 2–5 real stacks, serial boot — agents share HOME and UUIDv7 refs collide
  within ~16 ms) + `fabric-xs-inbox.test.ts`, conformance **C-X9** (broadcast metadata hygiene + header format, real pi) and **C-X10** (pi ordering
  facts for unread) in `tests/conformance/fabric-xs.test.ts` — run with C-X1…C-X8 before any pi peer bump. Accepted residuals: channel names
  are not secrets; unread can clear early (context_edit/compaction/provider error/`/tree`/abort, IR1–IR4) or undercount (restart/fork, IR5/IR6);
  bare-name completion uniqueness rests on a ≤10 min cache (hub resolves explicit refs authoritatively); `level===0` relies on an honest
  sender (same-uid trust; receivers still enforce maxLevel); broadcast wake budgets are consumed conservatively.
  **Session aliases (alias-plan r4, `docs/dev/fabric-cross-session/alias-plan.md`; packages AL0a/AL0b/AL1/AL2/AL3/AL4/AL5a/AL5b/ALU/ALW/AL6,
  reports `AL*-report.md`, real-device checklist `alias-acceptance.md`)**: a human-assigned, hub-unique short name per session (≤16 grapheme
  clusters/≤48 bytes; ASCII alnum/`_`/`-`, CJK, kana, hangul; `src/web-hub/protocol/xs-alias.ts` `normalizeAlias` folds full-width/`@`, rejects
  invisible/Jamo-filler/id-like/reserved words, skeleton blocks look-alikes — CJK↔CJK pairs like `カ/力` are accepted residue). Settings
  `fabric.crossSession.alias.{enabled (default true),offlineLeaseH (168),coolMin (10),takeMinOfflineMin (10, floor 10)}`, non-live (activate/
  stack build + hub start). Cap `xs.alias.v1` on both surfaces = `xsOn ∧ alias.enabled` (agent) / hub `crossSession.alias` key present ∧ store
  `ready` (hub); **key absent ⇒ off ⇒ hub byte-identical** (agent writes the key only when alias.enabled, so whoever spawns the hub decides for the
  run — residual R11). Only humans set/clear/take: `/fabric alias [<名>|--clear|<名> --take[=<token>]]` (local TUI/RPC/web per
  `webCommandPolicy.fabric`; Feishu hard-refused at handler line 1 + prompt-text guard; no tool, no agent path; child sessions have no `/fabric`).
  Take = preview (token bound to requester/alias/holder/rev/offlineSince, 5 min, ≤32 in hub memory, **every outcome consumes it**, preview counts
  toward `listPerMin`) → confirm (TUI `ctx.ui.confirm`; web/RPC echo ends with the fixed `XS_ALIAS_TAKE_CONFIRM_RE` line that `useTrackedCommand`
  parses from THAT command's captured output only) → execute with token; only a holder offline ≥10 min can be taken, an online/<10 min holder is
  refused. **Hub single writer** (`hub/xs/aliases.ts`, `<stateDir>/xs-aliases.json`, 0600, ≤256 records/64 KiB): intents on disk, presence in
  memory (restart restarts the 7-day lease, R8), shared step G (a grant demotes the grantee's other aliases to 10-min cooling — cooling is
  reclaimable only by its owner), tombstones feed the one-shot `lost{taken|expired}` notice on reattach, rename-stall ⇒ `wedged` (writes busy,
  reads keep the old table, >60 s ⇒ `disabled`), load three-state `ready|degraded` — **degraded never touches/moves the file**, declares no cap,
  and guards alias-shaped names (UNAVAILABLE, never falls back to a same-named session; R10) until a human fixes/moves the file +
  `/webhub restart`; the hub logs it AND writes `hub.json.alias{degraded,reason,path}` (key absent when healthy) which `/webhub status` renders as
  `alias store degraded (…) · <path>` (`agent/alias-status.ts`). **Addressing**: for an `aliasUsable` requester (`aliasAdvertised ∧ aliasCapable`)
  the alias layer is consulted FIRST and a hit is final — an unreachable alias (offline, not joined, other channel, self, cooling) answers
  NO_TARGET and never falls through to names; a full sessionId / ref is exact-only (no prefix, no name) and `send` pins the full sessionId
  (kills the same-ref/UUIDv7 and name-equals-sid spoofs); reserved addresses such as `root` ⇒ NO_TARGET (R12); without the cap every frame,
  resolution and ordering is byte-identical to the channel build (pinned by the v0.7.1 router diff). Model-visible surface: tool descriptions gain
  an alias sentence, rows/candidates/target carry `alias`, incoming headers carry an INDEPENDENT ` alias="…"` field after `from=` (hub-verified;
  `from` is self-reported). **Tool instances freeze on the LOCAL `alias.enabled`** (never the hub cap — a late/changed cap must not rewrite
  descriptions and break the prompt-cache prefix); cost: alias-on session on an old/degraded hub keeps the alias-flavoured description while
  addressing falls back to legacy (R13). `/fabric status` adds `alias @x held · lease 7d · cool 10m | alias - (lost: taken) | alias n/a
(hub-cap off|alias.enabled=false)`. `@alias`/`@session:` mention (`mention/session.ts`, directory cache holds aliases; miss ⇒ one throttled refresh).
  Gates: `tests/web-hub/protocol/xs-alias.test.ts`, `tests/web-hub/hub/{xs-alias*,hub-xs-alias,xs-router-v071-diff}.test.ts` (+AL1 property),
  `tests/fabric/xs-alias*.test.ts`, `tests/integration/fabric-xs-alias-wiring.test.ts` (real activate × fake hub socket) and
  `tests/integration/fabric-xs-alias.test.ts` (real hub child × 3 real stacks; hub clock injected via `StartHubDeps.now` through the fixture's
  `skew` op — no production hook; covers set/send/@/channel scope/take chain/corrupt-file restart/web `webCommandPolicy.fabric=confirm`/mixed fleet),
  conformance **C-X11** (alias tool schema stable, alias only as independent header field, details/token out of the payload; run with C-X1…C-X10
  before any pi peer bump). The three off goldens and `tests/fixtures/legacy-xs-v071/` are never regenerated. Accepted residuals: R1–R13 in plan §11
  (hand-deleted file ⇒ fresh table, display name equal to an unreachable alias, >20 aliases truncate list, cooling only mitigates stale-list mis-sends,
  `lost` notice once per process, preview discloses holder cwd/offline time).
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
  `docs/dev/consult/plan.md`. **A/B instrumentation** (`docs/dev/consult/ab-instrumentation-plan.md`): runs carry
  `diag.experts` (`refs` + `granted`), `diag.consults` (per-run consult outcome/cost/latency fold from the
  consult tool_end), `diag.dispatchMeta` (the Agent tool's analytics-only `meta`, inherited on resume) and
  `diag.schemaPreset` (`schema:"verdict/v1"`); all write-once, absent on runs that never set them, and
  analyzed offline by `scripts/exp/consult-ab-analyze.mjs` (protocol: `skills/dev-flow/references/consult-ab.md`).
  **C2 preserve (`docs/dev/consult/expert-keepalive-plan.md` v3.1, supersedes plan.md's §5.4 option B)**: a
  finished-expert consult no longer swaps in a readonly tool table — it scans the expert session for its last
  recorded tool loadout (`expert-index.ts`/`fork-store.ts` snapshot) and resumes with that exact loadout +
  the expert's model/thinking, so the provider request prefix (tools/system/messages) can stay byte-identical
  and hit the expert's prompt cache; the read-only R2 instructions ride only as a user message (`prompt.ts`).
  Read-only is enforced by `preserve-guard.ts`, not by the tool table: `createConsultGuard(snapshot)` (single
  param, no widening seam) blocks every non-allowed call in `beforeToolCall` under forced sequential execution,
  `installNestedCallBlock` blocks every nested `ctx.executeTool` regardless of name, and the 2nd consecutive
  all-blocked batch terminates the run as `blocked_cap`; adapter-owned tools the expert declared
  (`set_model`/`message_agent`/`Agent`/`consult`/`StructuredOutput`) become implementation-free shadows with the
  snapshot's exact declaration (`shadow-tools.ts`). Fail closed, zero requests sent: the driver's `preflight` (`preserve-identity.ts`)
  refuses with `[consult-preserve:<code>:<detail>]`, mapped by the tool to `identity_mismatch` (no recorded
  loadout / unreadable snapshot / non-reproducible definitions) or `guard_unavailable` (hooks missing) with a
  fixed refusal text; system prompt / model / thinking / cwd / forced prompt drift is record-only
  (`identity.predicted`, M2) — it costs a cache miss, never a refusal. Every consult records a
  `ConsultCacheProbe` in `diag.consults[].cache` (per-request cache read/write, wire prefix comparison via
  `prefix-probe.ts`'s process registry + `compareRecordedPrefix` — the hashed mirror of `comparePayloadPrefix`,
  breakpoint rule RELATIVE: each side only on its own last user/tool_result with matching ttl; settle gap, hit
  ratio, blocked-call counters), analyzed by `scripts/exp/consult-cache-analyze.mjs` (`--retro` for pre-C2
  runs). **The `"main"` expert is the one documented exception** (user ruling Q1): it keeps the readonly-table
  form above. `tests/conformance/consult-preserve.test.ts` (real pi + local Anthropic stub, C1–C7; C8 skipped
  until Q5 is ruled) must pass before any pi peer bump — an unknown top-level provider field
  (`PROVIDER_PREFIX_FIELDS`) fails it on purpose. No new settings (`consult.enabled=false` still disables all).
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
  `claude-code-todo-state` session entry; registered pre-guard; widget is TUI-only. Completed tasks
  collapse out of the default views and auto-archive (on compaction and after `todo.archive.afterTurns`
  turns; `TaskList includeCompleted:true` lists everything) per `docs/dev/todo-archive/plan.md`. A read-only
  summary also reaches the web hub: `TodoWireResult.getTodoSnapshot()` → `projectTodo`
  (`src/web-hub/agent/todo.ts`, 32-task cap / 240B description / 32KiB three-pass budget) rides
  the optional `StatusInfo.todo` slot (append-only, no proto bump) to a collapsible `TodoPanel`
  on the web detail header. Design: `docs/dev/todo-web/plan.md`.
- `src/memory/` — merged armory-memory: cwd-keyed project memory under `~/.pi/agent/memory/<slug>/`, with default `layout:tiered` injection and `toolSurface:v2` official-field tool surface; explicit `legacy` settings remain the byte-compatible opt-out. The tiered renderer enforces whole-file/whole-section admission and a UTF-8 byte budget; topic index lines carry `description`/`read_when` metadata, while `/mem doctor` reports D01-D14 health and its summary is surfaced by `/mem` and `memory.view`. Slug directories are canonicalized once and may be user-trusted symlinks; file-level symlinks and non-regular files are rejected. All v2 writes, imports, tidy, and restore operations serialize under the directory lock; batch tidy calls the post-write invalidation once. Registers a `pi_project_memory` section into the shared prompt-section hub (`src/sysprompt/hub.ts`, pre-guard, created before `wireMemory` runs so fold order stays memory → agent types → models) instead of owning its own `before_agent_start` hook (sysprompt-stable M3); the hub decides snapshot vs. tail update, `src/memory/inject.ts`'s `memorySection` provider only renders the current live block (pin frontmatter, agent-source fence, tail sentinel, fingerprint-keyed render cache). The `memory` tool lists/writes/appends (child sessions read-only by default, writes carry `source: agent` provenance); `/mem` covers list/path/init/import/doctor/tidy/restore (`init` creates an agent-source `core.md` skeleton stamped `source: agent` — deleting that line locks it as user-authored — and refuses an existing, archived or pin-stand-in primary). Tidy and restore are journaled transactions (`src/memory/tidy/{txn,manifest,journal}.ts`, design `docs/dev/memory/tidy-batch-plan.md` v3.2): the run event records the full planned op list before any intent, every MOVE/CREATE/REPLACE is CAS- and owner-epoch-checked and its result carries a mandatory final observation, an interrupted run stays resumable and is recovered before new work, and manifests are strict v2 (v1 backups restore only with `--legacy`, also through the txn layer). Hard-link-less filesystems refuse txn tidy (fail closed). Directory locks follow M-T4: a lock whose holder cannot be proven dead (old-format, cross-host) is never broken by age — writers get an actionable busy error and only the TUI-only `/mem tidy --break-lock` (epoch bump BEFORE lockBreak) clears it. `/mem tidy --batch` (P3a, `batch-command.ts`) archives stale entries into `archive/` (+ `ARCHIVE.md`, index pruning) and rewrites the rest in model batches sized by the dispatch-time `SpawnRequest.inputBudget` measurement (re-splitting on `input-budget` failures), holding one run lease for the whole command, bounded by `memory.tidy.batch.*` (bounded cost cap, max model runs, activity clock excluding dialog time); `--dry-run`/`--status` are read-only and web-allowed, `--triage` (P3b) is not implemented. `paths|frontmatter|store|render` are pi-free; `index.ts` (`wireMemory`) is the only pi-facing assembly and holds all mutable state in its closure; registered pre-guard. Design: `docs/dev/memory/memory-plan.md`.
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
  registered-but-inert) (dormant on pi ≥1.2: pi's own forced-prompt projection runs last and supersedes
  it; kept for the 1.0/1.1 peer floor); `systemPrompt.adoptForeignForcedPrompt` (default false) gates whether a later
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
  cleaning (skill envelopes). **web-resume plan §2.1/§2.3 (D1 彻底隐藏)**: subagent sessions are
  dropped entirely from every resume list — partial progress included — no flag, no toggle, no
  hidden-count line; the `[sub:type]` retitle path is deleted. A session is sub ⇔ its head carries
  the line-2 `subagent:child` self-marker (v0.4.0+, checked per displayed row) **or** its path is in
  the provenance index — the union of every `subagent:run.diag.sessionFile` mark ever scanned in
  the whole session dir (not just the 48 h window), advanced by a budgeted incremental backfill
  (≤2 s/≤64 MiB per call, round-robin 8 MiB chunks, append-only ⇒ stale cache is a valid lower
  bound) under cache v2 `<agent>/cache/session-nav/provenance-v2/<sha256(dir)>.json` (one file per
  session dir, 0600 atomic, 16 MiB cap; the v1 `subagent-marks.json` is simply ignored). Capacity:
  20 000 tracked files / 2 048 marks per entry / 512 KiB per entry over ⇒ `capacity`, self-marked
  children still hidden. Disclosed residuals: a pre-v0.4.0 child whose parent file was deleted is
  undetectable; on a huge dir the first few opens may still show a pre-v0.4.0 child until the
  backfill completes once. List pipeline: temp-dir symlink + real pi `SessionManager.list` with a
  wrapped progress that maps temp→real paths before dropping sub rows (pi 1.2 partials carry
  temp-dir paths). Post-guard, TUI-only. Design: `docs/dev/web-resume/plan.md`.
- `src/web-hub/` — browser UI over a per-machine hub daemon (`webHub.enabled`, default off ⇒ zero wiring,
  zero network, zero disk; post-guard, child sessions inert). `protocol/` (frame/key/path contracts shared by
  both sides, incl. `ui-manifest.ts`'s `UiBuildInfo`/`parseUiBuildInfo`/`isAllowedUiPath` — the build-time
  manifest schema both the Vite plugin and the hub-side verifier trust), `hub/` (singleton daemon: composition
  root `hub.ts`, process entry `main.ts` run through pi's bundled jiti-cli, HTTP/SSE/auth/static; never imports
  pi), `agent/` (pi-side client `wireWebHub`: process-level connection on a `Symbol.for` global, reused across
  /new·/resume·/fork, handed over on /reload), `ui/` (the Vue 3 SFC frontend source, built by `npm run
build:web` into `dist/web-hub-ui/` — not checked in; `ui/src/logic/` holds the pure, DOM-free logic ported
  from the pre-Vue frontend, imported through the `@logic` alias). The hub's own long-lived processes set
  ONLY their kernel comm (`hub/comm.ts` — hub `pi-webhub`, auth/session DB child `pi-webhub-auth`, spawn
  reaper `pi-webhub-reap`; never `process.title`): `/proc/<pid>/cmdline` is deliberately untouched — the
  agent-side hub identity check and reaper-by-cmdline test location depend on it. Wired at the end of `src/index.ts` after
  `wireDeferredReload`. P1 is read-only; **P2 (control-plane, #32, `docs/dev/web-hub/control-plan.md`)** layers a write
  path on top — a single `cmd`/`cmd_result`/`cmd_late` channel (`op: prompt|abort|steer_subagent|abort_subagent|
command|switch_session`, idempotent by cmdId, a process-level command ledger in `src/web-hub/agent/index.ts`
  outlives any single hub restart), an ask_user dual-channel bridge (`src/ask-user/remote.ts`'s port +
  `src/web-hub/agent/dialogs.ts`, TUI and web race for the same dialog, loser gets a 409/`dialog_closed`), web-
  origin slash commands with pi-toolkit's own commands captured and echoed back to the browser
  (`wrapCommandApi`, `captured:true` + the output text; a third-party extension's raw-registered command is
  never captured, `captured:false`, terminal-only), version-supersede/`/webhub stop`/`start`/`token rotate`
  admin flows, and a `hub-state-banner` covering pending/blocked/restarting/stopping. **Web resume
  (`resume.v1`, web-resume plan §2.4/§2.5/§2.7)**: `status.features` carries `resume.v1` iff control +
  `webCommands` are on, the session is persisted and `webCommandPolicy.resume` isn't `confirm`/`deny`
  (old agents never emit it ⇒ old UIs stay byte-identical); the advertised bare `resume` stays deny,
  `resume __list <json>`/`__pick <json>` are the allowed internal forms (`resume-recent` always deny).
  `__list` is the ONE thenable builtin (read-only race ≤6 s, `resume:scanning` retryable, ledger strips
  `data.sessions`) and never calls pi's `SessionManager.list` — a bounded head/tail reader (§2.2 core,
  O_NOFOLLOW/O_NONBLOCK open discipline) builds a generation (≤5 000 files / ≤5 s / ≤64 MiB / ≤2 000
  rows / page ≤100 / ≤32 KiB, gen-bound cursor with `reset:true`, cwd-matched, duplicate header ids
  omitted) retaining no message text. `__pick` is a fully SYNC decision: busy/pending ⇒ `resume:busy`
  (D4 browse-only), a one-per-process exec claim SHARED with `/new` (`exec:in-flight`), then a ticket
  bound to source session + target file identity, re-entered via `/webhub __exec resume <nonce>`; every
  authoritative check (source unchanged, idle, deadline, O_NOFOLLOW dev/ino, header id/cwd/child,
  provenance, not-current, D5-a: target written <30 s or changed since listed ⇒ `E_CONFIRM_REQUIRED
resume:active-elsewhere` unless `confirm`) re-runs synchronously at the execution point right before
  `ctx.switchSession`; a revoked/expired ticket can never switch, late failures are `retryable:false`,
  exactly one `cmd_late` per armed ticket, and `switchInFlight` refuses web prompts across the window.
  UI: header 「恢复」 button next to 「清空」 (D7) + dock/input interception, dialog lazy-loaded.
  Disclosed residual windows: W1 — between the execution-point checks and pi's `SessionManager.open`
  lie the async `session_before_switch` handlers; a swap there is only detected afterwards
  (`resume:mismatch`, effect unknown), a swap swapped back is undetectable. W2 — pi never locks
  session files; an idle session open in a terminal not connected to web is undetectable (D5-a's
  size/mtime are activity signals, not occupancy proof). Managed rpc sessions use the same path.
  Design: `docs/dev/web-hub/{arch,plan,vue-plan,control-plan}.md`, `docs/dev/web-resume/plan.md`.
  **Feishu bot (feishu-bot plan v2 + §R2/rulings, F0–F10)**: `hub/feishu/*` under
  `src/web-hub/` owns the zero-dependency native-fetch/WebSocket pbbp2 long connection, durable
  receive-before-ACK, requests/bindings/dialogs/files/outbox and owner-only-by-default admission.
  Ask-user cards settled elsewhere are recalled once (durable attempt claim; failure ⇒ neutral Chinese
  PATCH); an answer from that Feishu card keeps 「已通过飞书作答」 (`by:"web"` + matching `cmdId`).
  Top-level `feishuBot.enabled` requires `webHub.enabled` + control; non-live (`/reload` then
  `/webhub restart`). `HubConfig.feishuBot` key absent ⇒ byte-identical legacy hub: no bot
  service/network/disk/idle count or `fsb.v1` (shared cap fold on both surfaces). One app ↔ one
  hub/active connection — V7 proved two connections SPLIT events. `bot.stop()` is FIRST in every
  cleanup path, with bounded stop/dispose before registry/uploads/spawn/HTTP teardown. Local-TUI-only
  `/webhub feishu setup|status|cancel|allow|deny|repair|reset` uses `fsb_req`/`fsb_res` on the trusted
  agent socket (no web/LAN admin); the hub ledger's private branded `fsb:<gen>:<openId>` namespace
  cannot be selected by ordinary origin fields. Reply proof requires token anchor → settle on one
  uninterrupted stream; restart/reconnect/gap ⇒ unattributed, never snapshot backfill or automatic
  redispatch. Gates: `tests/web-hub/{hub/feishu,hub/hub-feishu.test.ts}` + caps/idle/cleanup tests,
  `tests/integration/web-hub-feishu-bot.test.ts` (real child hub + fake Feishu/fake-pi), typecheck/build.
  Design/user/tenant gates: `docs/dev/feishu-bot/{plan,README,acceptance,probe-results,F10-report}.md`;
  V12 non-creator visibility and real client card/form behavior still need tenant acceptance.
  **Cross-session mirror (feishu-xs-mirror plan r3 + §R1–R3, `docs/dev/feishu-xs-mirror/`; packages P1/P2/P3, reports `P*-report.md`)**:
  `feishuBot.xsMirror` (default **true**, non-live: `/reload` then `/webhub restart`) pushes a read-only Feishu card to every
  bound **p2p** chat (never group/topic bindings, never offline ones) when a cross-session message lands in the bound session
  WITHOUT waking it — point-to-point, `message_channel` broadcast, reply (late ones marked), and `unknown{queued}` (marked
  「送达未确认」); `woke:true`, `none`, `accept_unverified`, deadline/late/duplicate acks never mirror. **A′ = no wire change**: no
  new frame, cap, PROTO bump or agent code — the hub observes its own xs relay (`hub/xs/mirror.ts`, `XsRouterDeps.onQuietDelivered`,
  fired on a microtask AFTER the sender's `xs_res`/audit/limits settled; observer errors are swallowed) and `hub.ts` passes the
  observer only when `feishuBot.xsMirror === true ∧ config.crossSession` (key absent otherwise ⇒ hub byte-identical; the three off
  goldens and `xs-router-v071-diff` stay frozen). Delivery is a bounded FIFO(16) with ONE worker (`hub/feishu/xs-mirror.ts`):
  per-card budgets (6/min·60/h per binding, 30 cards/min global, least-recently-served first), mirror outbox slots ≤16 queued /
  total <320, ≥256 KiB state headroom, work-lane headroom ⇒ security alerts/owner notices are never starved; overflow becomes a
  per-binding 「此前另有 N 条」 tail note (monotone `dropped` + `reported` watermark) and `xs-mirror-<reason>` counters in
  `info().counters.dropped`. Cards are schema-2.0, zero buttons/behaviors/nonces, untrusted-input banner, sender-claimed names
  marked 「对方自报，未核验」 (only hub-stamped alias is 「hub 核验」), body quoted + markdown-neutralized, 1500 code points,
  ≤8 KiB. Mirror notices carry `requestId:"xsm:<hash>"`; **turning the switch off + `/webhub restart` purges stranded queued
  `xsm:` notices at `start()` (counted `xs-mirror-purged`)**. Residuals R1–R9 (plan §6): old-agent-spawned hub ⇒ off; whitelisted
  links stay clickable; deny'd users' bindings still receive (as done-notices do); queued messages may never reach context and
  queued replies can't be marked late; best-effort (lost/late ack ⇒ permanent miss, no resend of the xs message); budget/outbox
  expiry drops with a tail note; no post-settle dedupe; alias only when receiver `aliasUsable`; `/reload` alone doesn't clear
  stranded notices. Gates: `tests/web-hub/hub/feishu/{xs-mirror,xs-mirror-isolation}.test.ts`, `tests/web-hub/hub/xs-mirror-tap.test.ts`,
  `tests/integration/web-hub-feishu-bot.test.ts` (「feishu-xs-mirror」 block, I1–I16, real hub child × fake Feishu × fake xs
  agents; every no-card case is compared with the same input under `xsMirror:false`). Real-device checklist:
  `docs/dev/feishu-xs-mirror/acceptance.md`.
  **UI serving
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
  **LAN security (lan-security plan r2)**: `hub/client-allow.ts` supplies ONE hub-owned client-IP allow guard
  (`webHub.lan.allowClients` IP/CIDR csv; empty = unrestricted, all-invalid = deny-all) to LAN HTTP and every proxy listener (explicit
  inert guard without LAN; a missing configured guard is never a fallback). `hub/lan-login.ts` owns the sole checked
  session completion (`complete()` — the only `createSessionChecked` caller), with epoch/factor-generation CAS and
  bounded cancellation/late-insert cleanup for password/TOTP/recovery/Feishu approval. Enrolled accounts require a
  second factor from a new IP (30 d history **per account**, capped at 256 IPs/user; unusable trusted-proxy XFF stays
  new); first enrollment clears only that account's trust. Kicking sessions (single / others) atomically clears that
  user's trust for the kicked sessions' created/last IPs, EXCEPT the revoker's current IP (shared-IP retention is audited);
  uncertain revokes attempt bounded best-effort trust cleanup, while self-logout keeps trust. Pending challenges are never
  sessions. `hub/lan-sessions.ts` lists/revokes ≤32 LAN sessions with one 10 s revoke deadline and the shared
  auth-revoke fan-out to proxy HTTP+WS, HTML caps and SSE; nullable `session_meta.method` migrates additively (legacy
  reads as password) and the settings card is cap+password gated, disabling all actions during a revoke.
  `/webhub user list|delete <username>` is trusted-local TUI-only too: list shows primary/2FA/live sessions, delete needs
  an explicit TUI confirmation, refuses primary/last-user, CASCADE-deletes account data and revokes that user's live
  cookie/SSE/proxy/HTML sessions. `/webhub passwd` confirms before creating an extra independent account.
  `/webhub 2fa` still targets only the primary (lowest-id) account and is trusted-local TUI-only (masked setup, bounded
  secret widgets, independent of web command policy; web prompt-op auth-admin text, including `/webhub user`, is refused too); admin repair preserves B's actual db-invalid detail. Feishu approval
  uses the live owner, sibling nonces/gen/tenant binding and a stable runtime delegate; security alerts share
  notify's budget and are settings-gated. `lan.2fa.v1` / `lan.sessions.v1` are advertised on both surfaces iff
  `config.lan` is configured (not the assembled store state — the 2fa cap is needed for repair while the store is
  off); fresh password index bytes carry only a public `data-lan-caps` bootstrap for the login UI (off/token bytes
  unchanged); G's approval polling survives method switches and is cancelled on abandonment. Gates: fake+SQLite
  contracts, real revoke consumers, real-socket Q15 enrollment, LAN-P5 real child hub × SQLite × fake Feishu callback
  integration, `tests/web-hub/http/lan-rollout.test.ts` (startHub-level activation). Design / evidence:
  `docs/dev/web-hub/{lan-security-plan,lan-security-P0-surfaces,lan-security-DEFG-integration-report}.md`.
  **Managed spawn (S1, `webHub.spawn.enabled`, default off; Linux-only, fail-closed platform probe)**: the hub
  itself forks `pi --mode rpc` children in user-chosen directories (`known ∪ roots` admission, loopback-only
  by default — `spawn.lan` off/known/roots) via `/api/headless*` + the `spawns` SSE event (Public projection;
  owner-only fields per-request; the first-prompt body never persists anywhere). Identity is
  `bootId+starttime+uid` ONLY (pi rewrites `process.title`, so cmdline never identifies a child); children
  inherit the USER's umask (main.ts captures its pre-0o077 mask and the supervisor swaps it around each fork).
  Orphan invariants L1–L5: intent on disk before fork, an independent reaper watchdog child TERM→KILLs
  tracked orphans ≤12s after ANY hub death, boot-time recovery re-verifies identity before signaling, and
  every signal is preceded by a sync identity re-verify. `spawn.v1` rides both cap surfaces only when
  `config.spawn` exists. `webHub.spawn.lanConfirm` (default true; 2026-10-13 U1 拍板) gates the LAN
  per-spawn `E_CONFIRM_REQUIRED` round-trip — `false` drops LAN to loopback's `unknown-dir` rule (the
  session-open fork confirm is a real decision and never skipped); the waiting state after a 202 lives
  on the sidebar SpawnRow (the picker closes on `awaiting`). SP13's
  `tests/integration/web-hub-headless.test.ts` (H1–H8 hard gates, real hub
  child processes + `fixtures/fake-rpc-pi.mjs`) and `tests/conformance/rpc-spawn.test.ts` (real pi) are the
  S1 merge gates — design: `docs/dev/web-hub-spawn/{arch,plan,acceptance}.md`.
  **Created dirs (created-dirs plan r2)**: a folder made through `POST /api/headless/mkdir` inside `spawn.roots` is recorded (`hub/spawn/created-dirs.ts`, `<stateDir>/spawn/created-dirs.json`) as known source ④ — fully `known:true` (skips the unknown-dir confirm; `lan:"known"`/Feishu `spawnScope:"known"` widen the same way; LAN `confirm:"always"` unchanged), admission re-checks TTL/identity/fresh roots and the fresh-start pin adds `{canonical:true}`; plaintext-LAN scope cap stays (accepted cookie-sniff residual, arch §6.1); LAN-only `E_DIR{not-allowed}.detail` (`plaintext-lan|lan-known|outside-roots`, loopback byte-identical). Design: `docs/dev/web-hub-spawn/created-dirs-plan.md`; golden deltas: `created-dirs-golden-delta.md`.
  **Restore across hub restarts (`webHub.spawn.restore`, default true, only under `spawn.enabled`)**: a
  graceful restart / crash re-forks every recoverable managed session on the new hub as kill-old-then-fork
  (`--session <file>` or `--session-id <id>`, never `--model`), same spawnId, new agentKey carrying
  `restore.prevAgentKey`; L6 — never fork while the old identity's death is not `confirmed`; intent persisted
  before every fork; `/webhub stop` leaves a one-shot `<stateDir>/spawn/restore.veto` (restart clears it);
  `restore:false` is byte-identical to pre-restore behavior. HR1–HR7 / CR1–CR3 gates — design:
  `docs/dev/web-hub-spawn-restore/plan.md`.
  **Relaunch an offline managed session (`POST /api/headless/relaunch`, cap `spawn.relaunch.v1` —
  advertised only when `spawn.restore === true` AND the platform probe passed)**: clicking a
  stale/offline AgentList card bound to a TERMINAL managed record re-forks its session through
  the SAME restore job (`supervisor.relaunch()` rewrites the record to `starting{reaping}` with
  `restore.prevAgentKey` = the old card, then `runRestoreJob`: L6 death re-check → D7 session
  preflight → `forkInto` with `--session <file>` / `--session-id <id>`, never `--model`).
  Refusals: unknown spawnId or restore-off ⇒ 404; death not `confirmed` ⇒ 409
  `E_AGENT_ONLINE{exit-unconfirmed}` (B-alive); no/invalid sessionId or a pending delete ⇒ 409
  `E_BAD_REQUEST{no-session|removing}`; the persisted session file gone/tampered ⇒ 410
  `E_SPAWN_GONE{session-missing|session-invalid}`; a record without a `sessionFile` gets ONE
  bounded locate-by-id in pi's default session dir (`restore-plan.ts`'s `locateSessionFile`)
  before the `--session-id` fallback. Idempotent: a non-terminal record ⇒ 202 `dup:true`, never
  a second fork. A relaunch re-anchors the lifetime (`lifetimeAnchorAt`, runtime-only — restore
  D14's createdAt anchor stays untouched for boot restores). UI: `logic/spawn.js`'s
  `relaunchableFor` gates the affordance on the cap; the whole stale card becomes the action
  (capture-phase intercept, the × / rename buttons pass through), success navigates to the old
  key's detail where the existing `successorOf` follow lands on the new live card.
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
  **Cache keepalive panel (cache-ttl-keepalive webhub plan)**: `agent/cache-keepalive.ts` projects the keepalive report to the
  optional `StatusInfo.cacheKeepalive` slot (append-only, 1Hz fingerprint-gated publish, wire never carries `armed`, 8 KiB
  budget) for a read-only, lazy-loaded `CacheKeepalivePanel` on the web detail header. Design:
  `docs/dev/cache-ttl-keepalive/webhub-plan.md`.
  **Content preview (web-hub-preview plan v3 + dir-plan v3.1, setting `webHub.preview` — `"on" | "loopback" | "off"`, default
  `"on"` per the 2026-10-05 user ruling U1: sole LAN user behind password auth, risk explicitly accepted; change
  is non-live — `/reload` then `/webhub restart`)**: an absolute path in a settled message (assistant text, user
  bubble, or a ToolCard's Input section, all rendered through `ui/src/components/preview/PathText.vue` — never
  `markdown.js`; streaming replies stay plain text until they settle) opens a read-only dialog via the single
  endpoint `GET /api/preview` (`X-PWH: 1`; raw bytes + `X-PWH-Preview-*` metadata headers; no new SSE/frames).
  **Admission (dir-plan U4, 2026-10-08): uploads + ANY absolute path** — an authenticated user (LAN included) may
  read any file the hub uid can read that the denylist does not name, and browse directories; that boundary is
  deliberately accepted (U1/U4), and the denylist (`hub/preview/admit.ts`, `PREVIEW_DENYLIST_VERSION`) is a
  best-effort credential BLACKLIST, not a whitelist — changing a rule means bumping the version, refreshing
  `tests/fixtures/preview-denylist-corpus.json` in the same PR, and running `node scripts/dev/preview-denylist-audit.mjs`
  before release. Defence stack on every fs-class request (all steps bounded, zombie-IO tracker ⇒ 503 busy):
  literal denylist + virtual roots (zero-fs) → realpath → denylist/virtual-root re-check on the resolved path
  (home/agentDir checked in literal AND canonical forms — the startup `resolvePreviewDenyContext`, degraded
  members backstopped by home-independent twin rules) → stat → `O_NOFOLLOW` open → fstat dev/ino →
  `/proc/self/fd` re-check. **Upload attachments** (`hub/uploads.ts`'s `openForPreview`: structural re-check of
  the generated `<uploadId>.<ext>` / legacy `<id>/<safeName>` layouts, sha256 re-verification) are shared with
  the **session's viewers** (U3 — revises upload-plan §5.1's "uploader-only" read rule; writes/abort/dedup/pinning
  stay principal-bound, recorded as an appended note in that plan). **Directories**: `&dir=1` opt-in answers a
  JSON listing (`X-PWH-Preview-Kind: dir`) — dirs-first sort, dotfiles dimmed but listed, denylist hits vanish
  from both entries and counts, triple caps (scan 10 000 → entries 1 000 → body 512 KiB); the dialog drills down
  (in-dialog back/up history, cap 64) and each child click re-runs the full admission chain. Caps `preview.abs.v1`
  (abs-path recognition) and `preview.dir.v1` (dir listing + recognition; NOT declared on platforms without
  `/proc/self/fd` — fail-closed, directories stay 415 there). Markdown files (`.md`/`.markdown`) render by
  default with a source-code toggle (reset per open, path-keyed; parser stays `v-html`-free with a 20 000-node
  budget degrading to source). File caps: text 256 KiB (UTF-8
  boundary), images 16 MiB loopback / 4 MiB LAN / 40 MP (unparseable dims ⇒ reject; touch clients budget 20 MP);
  preview reads never pin or extend upload TTLs; the audit line's `cls` is `upload|cwd|abs` (literal prefix,
  stats only — never a path or entry name). `mode:"loopback"` keeps the endpoint LAN-absent (404, byte-
  identical to `off` on LAN) while loopback keeps previewing. Design + real-device acceptance:
  `docs/dev/web-hub-preview/{plan,dir-plan,acceptance}.md`.
  **Preview multi-windows** (preview-windows plan r2, W1–W4 merged): on ≥768px that dialog becomes MODELESS floating
  preview windows (z-layer 25 — over chat/composer, under drawers/popups/ask-float): conversation clicks APPEND
  windows (cap 6, staggered cascade), known dirs navigate in place, unknown types speculatively open + fold back,
  drag/8-way resize with keyboard equivalents on the title bar, 「⋯」 window menu (close-all/reset/list),
  `Ctrl+`` / `Ctrl+Shift+`` conversation⇄window MRU ring, same-path dedup focuses + moves focus, cap-limit
  `role=status` notice, session switch/relock closes all; <768px keeps a fullscreen stack (top-only trap, others
  `inert`); HTML previews share a tab-local cap-FIFO ledger for the deterministic 「可能已被挤掉」 notice with a
  standing 「重新加载」. Design + real-device checklist: `docs/dev/web-hub-preview-windows/{plan,acceptance}.md`.
  **Chunked text preview** (cap `preview.chunk.v1`, opt-in `chunk=1` / `offset=N` / `ident=i1.…` query; every chunk re-walks the full admission chain; UI ceiling 8 MiB desktop / 4 MiB touch, hub hard cap 16 MiB): design `docs/dev/web-hub-preview/chunked-plan.md`.
  **HTML preview (rendered)** (cap `preview.html.v1`, plan `docs/dev/web-hub-html-preview/plan.md` v2 + §R1/§R2): `POST /api/preview/html-cap` mints one path-shaped capability per render; scripts run SANDBOXED in an opaque origin (`/pv/<cap>/<rel>` served with `CSP: sandbox ${PV_SANDBOX}` = `allow-scripts allow-forms allow-popups` — never `allow-same-origin`/top-nav/modals/downloads — framed by the dialog iframe or the script-free `/pvw/<cap>` wrapper tab, both carrying the identical sandbox attribute). The cap admits the entry's own directory + subdirectories only (F2; denylist on every subresource), external network allowed (F3); capability TTL idle 15 min / absolute 60 min, per-principal 8 / global 64 caps, per-cap 200-req bucket + 10 000 lifetime, bounded FIFO queue (6/16 active, 64/256 queued, 10 s wait) and a 2-slot physical-IO semaphore (never-settling ops zombie their slot only — T-I1 pins preview/uploads/LAN-scrypt liveness). Admission is fd-anchored on a held `O_DIRECTORY|O_NOFOLLOW` dir fd, resolved through `/proc/self/fd/<dirFd>/…` with post-open fd-readlink containment; D2 refuses `/`, `$HOME`, agent-dir and uploads-root entries ⇒ source view only; `cls:"upload"` ⇒ 403. Invariants I1–I4: `/pv*` never reads cookies/auth (the capability is the only credential), opaque-origin `/api/*` carries no usable credential (HttpOnly + SameSite=Strict ⇒ 401), no `/api/*` response ever carries ACAO (unreadable), every state-changing `/api` route demands X-PWH/JSON + rejects `Origin: null`. Revocation: logout (both listeners, by sidTag/userId), passwd commit, token rotate (per listener), hub dispose — seq-recheck before insert, `isLive` before head, in-flight aborts. `redactLogUrl` keeps caps/rel out of fallback logs. Accepted residual: a page script can exfiltrate non-denylisted files in its own directory and set its own Referrer — F2+F3 by design; raw `/pv` top-level self-navigation harms only the sandboxed page. Real-browser gate: `docs/dev/web-hub-html-preview/acceptance.md` (selfcheck page in `selfcheck/`).
  **Worktree diff (worktree-diff plan v3.1, D0–D6)**: per-file diff viewing for the session repo's
  worktrees, riding the SAME `webHub.preview` gate (mode `on`/`loopback`; no separate setting) plus
  a `/proc/self/fd` probe (Linux-only, fail-closed — no `wtdiff.v1` cap and no routes without it).
  Two GET endpoints (`/api/worktree-diff/files`, `/api/worktree-diff/file`, both `X-PWH: 1`): the
  hub runs git itself — pinned through THREE fds (worktree, gitdir, commondir; `-C
/proc/self/fd/3 --git-dir=/proc/self/fd/4 --work-tree=/proc/self/fd/3` + `GIT_COMMON_DIR=`,
  membership-checked against a bounded `worktree list --porcelain`), with `envPolicy:"minimal"`
  (PATH pinned to `/usr/bin:/bin`) and plumbing **`diff-index`** — never porcelain `diff`, which
  2.53 measured to WRITE the index and fire `post-index-change` even under `--no-optional-locks`.
  External-driver neutralization is three-layered (L1 `--attr-source=<empty tree>` kills committed/
  working-tree `.gitattributes` sources; L2 unconditionally blanks every `filter.*`/`diff.*` driver
  name found in config ∪ `$GIT_COMMON_DIR/info/attributes`, macros included; L3 post-hoc re-scan ⇒
  503 `attr-changed` + discard) plus `--no-textconv --no-ext-diff`, `hooksPath=/dev/null`,
  `--ignore-submodules=all`. Anti-arbitrary-history: `base` must equal THIS request's C0 HEAD
  resolution (409 `base`), `(path, orig)` must be a requestable entry of the ≤5 s TTL single-flight
  changeset (409 `entry`, zero oracle) — the residual exposure is exactly appendix A1 (a): LAN is
  as wide as loopback, pinned to the current HEAD, changesets computed server-side per request,
  denylist hits hidden everywhere (list, total, file asks — D14). **Driver-scan regex maintenance
  rule**: `WTDIFF_DRIVER_NAME_RE` + the Cc `config --get-regexp` pattern enumerate the executable
  config surface — when a NEW git version adds an executing config key family (R11), extend both
  (and `driverNamesFromAttributes`' superset regex) in the same PR and re-run the H1 suite
  (`tests/integration/{git-wtdiff,web-hub-worktree-diff}.test.ts`); new ASSET classes (things the
  endpoint exposes) follow A1: LAN same-width, current-HEAD-pinned, server-computed, denylist-
  blocked. Design: `docs/dev/worktree-diff/plan.md` (§9.3 revision log); real-device checklist:
  `docs/dev/worktree-diff/acceptance.md`; endpoint integration: `tests/integration/web-hub-worktree-diff.test.ts`.
  **Worktree graph**: `GET /api/worktree-graph` (`X-PWH: 1`), cap `wtgraph.v1`, shares wtdiff's
  `webHub.preview` on/loopback gate + `/proc/self/fd` probe (Linux-only, fail-closed). The hub's
  single runner serves both route frontends through membership + three-fd pins + minimal env;
  frozen `src/git/graph.ts` `wtGraphArgs` (byte-pinned tests) runs Gr `for-each-ref` then Gl
  `log --date-order` over validated explicit snapshot tips, with `--no-lazy-fetch`, no replace
  objects, pager, hooks, signatures, mailmap or notes. The exec/read surface matrix in plan
  §2.3 covers transport/ssh/helpers, gpg, mailmap, replace/notes, drivers/attributes/worktree
  reads, hooks/fsmonitor/pager, object/ref/index writes and the accepted trace2 residual;
  graph never reads file contents or collects dedicated email fields (free text may contain
  secrets; sole-user LAN exposure is accepted). **R11-style upgrade gate**: new git versions
  adding executing config/argv behaviour, or any Gr/Gl argv change, require re-checking argv
  and `git help config`, updating the matrix with paired unhardened/hardened tests, and running
  `tests/integration/{git-graph,web-hub-worktree-graph}.test.ts` in the same PR; do NOT widen
  `WTDIFF_DRIVER_NAME_RE` or the Cc driver regex for graph. Budget ledger §2.4: admission 8s +
  git 14s (four 2s steps + Gl 6s) + close 1s = 23s; transfer 10s fits the 35s client deadline;
  response ≤512 KiB. The WorktreePanel's default-collapsed, lazy-loaded graph shows ≤200
  commits, merge rows dimmed, full-oid worktree HEAD rings and ≤4 lanes at mobile width.
  Design: `docs/dev/worktree-graph/plan.md`; device checklist:
  `docs/dev/worktree-graph/acceptance.md`.
  **Local-service proxy (web-hub-proxy plan v2 + §R1/§R2, `webHub.proxy.{enabled,portRange,maxProxies}`, default off;
  non-live — `/reload` then `/webhub restart`)**: lets the browser open a service listening on the hub machine (e.g.
  `127.0.0.1:23434`) through a per-target hub listener in `portRange` (default `7900-7949`, max 8 instances, LAN bind iff
  `webHub.lan` is on). `HubConfig.proxy` exists only when enabled ∧ `control !== false`; key absence IS off (no service, routes,
  caps, `/api` cross-site gate, multi-candidate cookies or disk — hub byte-identical). `hub/main.ts` re-validates via
  `hub/proxy/config.ts` and drops the key on a malformed value or a range overlapping `webHub.port`/`webHub.lan.port`.
  `hub.ts` builds `createProxyService` AFTER `fe.listen()` with the ACTUAL bound ports and a LIVE `lanHostSnapshot`, awaits
  `dispose()` on close and on every later startup failure, subscribes `service.revoke` to the auth-revocation bus
  (`hub/auth-revoke.ts`; logout/password change/token rotate kill proxy sessions), counts proxied sockets toward idle and
  mirrors `portsStore` into `hub.json.proxy`. Routes (`hub/proxy/routes.ts`: `POST /api/proxy/open`, `GET /api/proxy`,
  `POST /api/proxy/stop`) capture `seq0` before identity resolution, refuse the trusted reverse proxy (409 `reverse-proxy`)
  and re-resolve identity on a retryable `closing` (stale ⇒ 401). Caps `proxy.v1` / `proxy.lan.v1` (iff `config.lan`) are
  static. Engine invariants (`hub/proxy/{listener,forward,ws,service}.ts`): permanent fail-closed port↔target binding
  (`ports-map`), pinned resolved IP (never re-resolved, redirects never followed — `Location` rewrite only), one-time code ⇒
  `SameSite=Lax` gate cookie (idle 2 h, hard min(12 h, parent login)), strict Host/Origin checks, unsafe methods and WS
  require Origin = the proxy origin BEFORE any upstream dial, hub cookies / `pwh_*` Set-Cookie / Clear-Site-Data never cross,
  bounded queues/backpressure (an upload is cancelled only on a real client close — a slow upstream never kills a live
  upload; residual: a hidden FIN behind full buffers waits for the 120 s idle timeout), audit lines carry no
  path/query/cookie/code. Design: `docs/dev/web-hub-proxy/plan.md`; package reports `{XA,X0,X1a,X1b,X1c,X2,X3}-report.md`;
  real-browser gate `docs/dev/web-hub-proxy/acceptance.md`.
  **In-page link preview (link-preview plan r2, `docs/dev/web-hub-proxy/link-preview-plan.md`)**: cap `proxy.frame.v1` is
  declared iff `config.proxy`; only with it does a click on a recognized link open a lazy-loaded in-page dialog iframing the proxy
  origin (older hubs keep the new-tab flow). The hub UI CSP gains `frame-src 'self' http://*:<p>` limited to the configured
  `portRange` (proxy off ⇒ CSP byte-identical); hub XFO/`frame-ancestors 'none'` stay. Proxy-generated pages (enter 303 and every
  error page answered after Host validation) are frameable by the hub origin(s) only via a per-request `ProxyReplyPolicy`; an
  invalid Host (421), the `closing` 503 and WS rejects keep the strict headers, and **upstream framing headers
  (`X-Frame-Options`/`frame-ancestors`) pass through untouched (user ruling D2)** — a no-embed app shows refused in the dialog,
  with 「新标签打开」 always offered. Enter reuses the browser's live same-identity gate session (no new session / `Set-Cookie`,
  caps unchanged, nothing evicted), so repeated opens never hit `429 sessions`. Browser gate: `acceptance.md` §18, fixtures
  `scripts/dev/proxy-frame-fixtures.mjs`.
  **Avatar (web-hub-avatar plan v2.1, `webHub.avatar`, default on)**: the hub stores one validated PNG at
  `hub/avatar/{fs,store,validate,routes}.ts`, assembles it through `hub.ts`, and dispatches the three
  `/api/avatar*` endpoints on both authenticated listeners via `hub/http.ts`; `avatar.v1` is advertised only
  when the `HubConfig.avatar` key is present (the agent receives but does not add a cap). `control:false` or
  the setting off omits that key and leaves the hub byte-identical. Atomic replacement, strict PNG validation,
  bounded IO/concurrency, CSRF/auth/rate limits, full-digest ETags, generation-ordered SSE updates, and
  exactly-once audit records are invariants; gates are `tests/web-hub/http/{api-avatar,lan-avatar}.test.ts`,
  `tests/web-hub/hub/{caps-coexist,deadline-nesting}.test.ts`, and the real-device acceptance in the plan.
  **Privacy lock (web-hub-privacy plan v2.1, `webHub.privacy`, default on)**: per-sessionId view-time
  re-verification against shoulder-surfing — marks live in `<stateDir>/privacy.json`
  (`hub/privacy/{store,routes}.ts`, 0600 atomic writes, E_LIMIT over 4096, corrupt ⇒ `.bak` + degraded),
  `POST /api/privacy/{lock,verify}` (verify is LAN-only; unlock on LAN requires the inline password, on
  loopback it degrades honestly to click-to-confirm), the `privacy` SSE frame is direct-send only (never in
  the replay ring, ordered before `agents`), and hub-initiated forks inherit the mark BEFORE spawn. The UI
  locks only on the desktop band (≥768px; the mobile band ignores the frames entirely), relocks four ways
  (route change / idle timeout / manual / tab hidden), and an old hub without `privacy.v1` leaves the UI
  byte-identical. `/webhub status` renders the on/off + degraded + loopback-difference lines off
  `hub.json.privacy` (`agent/privacy-status.ts`). Design: `docs/dev/web-hub-privacy/plan.md`.
  **Channels in the web UI (channel-plan §7, CHU/CHU-b)**: all gated on hub caps ∋ `xs.channel.v1` (absent ⇒ UI byte-identical). AgentCard shows a
  channel chip only when the effective set ≠ `[default]` (`status.xs.channels`; missing ∧ joined ⇒ `[default]`); `AgentList.vue` shows a sidebar
  channel-filter chip row only when a named channel exists (selection is component memory, not persisted); the `@` panel (`control/sessionMention.ts`)
  lists only same-channel sessions (UI hint, hub is authoritative); broadcasts render in the transcript as `#team · 广播`
  (`logic/xsMessage.ts` parses ONLY the first line, `TxCustom.vue`); the detail header has a 「频道」 button opening `detail/ChannelsDialog.vue`
  (channels aggregated client-side from the sessions' pushed `status.xs.channels` — no new endpoint; ticking sends `/fabric join|leave #x` through the
  existing web command op under `webCommandPolicy.fabric`, no optimistic update, Feishu still refused, ≤4/reserved names disabled client-side); unread
  badge (`StatusInfo.xsInbox`) on AgentCard and `DetailHeader.vue`. Design: `docs/dev/fabric-cross-session/channel-plan.md` §7/§12.6.
  **Aliases in the web UI (alias-plan §7, ALU)**: gated on hub caps ∋ `xs.alias.v1` AND the session's `status.xs.alias` (absent ⇒ UI byte-identical,
  DetailDock untouched). `composables/useTrackedCommand.ts` is the only path that runs web alias commands: own cmdId per command, `E_CONFIRM_REQUIRED`
  ⇒ generic confirm (`CommandConfirm.vue`) then a NEW cmdId with `confirm:true`, async completion ⇒ watches that cmdId's `pendingCtl` entry then one
  `queryOnly` and unwraps `data.output`, 15 s timeout/dialog close/session switch drop late results (never undoes the command). `ChannelsDialog.vue`
  (titled 「频道与别名」) has an alias area: live `normalizeAlias` pre-validation, ≤3 suggestion chips (others' taken ones greyed from pushed
  `status.xs.alias`), save/clear/take (take: preview → token parsed from that one output → confirm dialog with countdown → execute), no optimistic
  update. AgentCard chip order `kind → state → xs badge → @alias → #channels → unread` (alias cut at 8 grapheme clusters, title = full);
  DetailHeader shows `@alias` opening the dialog; the `@` panel matches/shows alias but still inserts `session:<ref>`; `logic/xsMessage.ts` reads
  ` alias="…"` from the first line independently of field order. Design: `docs/dev/fabric-cross-session/alias-plan.md` §7.
  **Session switching (web-hub-session-switch plan, E1+D2)**: the browser UI keeps the last K sessions subscribed on
  the hub (main-subscription LRU keep-alive; browser pref `pwh_keepalive`, default 3, `1` = legacy single-slot, pure
  planner `ui/src/logic/sessionKeepAlive.ts`; `useHub`'s library default stays 1 — only App.vue lifts it to the product
  default), owns a main-subscription ledger with same-key op serialization and hello-time op voiding
  (`useHub.ts`, K=1 transport order pinned by `tests/fixtures/web-hub-ui/keepalive-legacy-golden.json`), guards in-flight
  snapshots with the optional `HistoryPayload.sessionId` (agent backfills `snapshot_reply.sessionId`; missing on either
  side passes through — compat window), and remembers per-agentKey transcript scroll position on switch. Design:
  `docs/dev/web-hub-session-switch/plan.md`.
  **Session history (`webHub.spawn.history`, default on; cap `spawn.history.v1` only when config.spawn exists AND the
  flag is true AND the platform probe passes; `hub/hub.ts` is the sole assembly point — session-history plan P-int)**:
  `GET /api/headless/history` lists every past session under the agent dir (continuable fd-anchored enumeration — a
  swapped/symlinked dir is never followed, HH14), and a POST with a `session` ref resumes it in place
  (`--session <abs>`, never `--model`) or forks it through a hub-made snapshot in `<stateDir>/spawn/fork-src/` (the
  source file is never touched; the new header's `parentSession` dangles at the deleted snapshot by design). In-place
  resume requires kind positively `main` AND a best-effort occupancy check (live card / managed record / full same-uid
  `/proc` scan + a synchronous re-stat for pid reuse); anything detected or unclear forces a fork with an explanatory
  `proofGap`. **The check is best-effort by user ruling (§14.1)** — residual windows W1–W7 are disclosed in the UI
  footer, incl. that pid reuse right after a pi exits (W5) and swap-and-restore during startup (W7) are undetectable,
  and that **restore re-forks deliberately skip the occupancy proof** (W6 product exception — RH4 pins it as a
  documented limitation). Paths are fd-anchored (three-level `O_NOFOLLOW` + dev/ino + nlink + realpath re-checks before
  spawn and again at goLive — a swapped file stops the child with `session-swapped` and its coordinates are never
  adopted); restore re-forks get the same capture/verify when history is on (v3.4 X1: every `--session` restore, no
  origin distinction). History's local IO is budgeted (≤2 concurrent fs ops via its IO gate + fd ledger, no background
  timers; the starvation suite pins that preview/uploads/scrypt stay live). The `historyProcFs` test seam is
  programmable ONLY through `HubDeps.spawnSeams` (`main.ts` never sets it; env/config cannot reach it — pinned by
  `tests/web-hub/hub/hub-history-assembly.test.ts`). Gates: HC1–HC7 conformance (real pi argv/header facts), HH1–HH14
  integration (real hub × fake pi + starvation), RH1–RH4 conformance (real pi + real hub restore). Off ⇒ the hub stays
  byte-identical (no cap, no service, routes 404, restore carries no path pin). Design:
  `docs/dev/web-hub-session-history/plan.md`. **`prompt-gate.ts`** (topic-switch plan P4, D2):
  `PromptGatePort`/`WebPromptRelease`, a late-bound port (`WebHubDeps.promptGate`, assigned by
  `src/index.ts`'s `promptGateRef.current = …` — the sole D2 flip point) that `commands.ts`'s
  `handlePrompt` consults synchronously, idle-only, before its native dispatch; claiming replies
  immediately (no dispatch) and hands ownership to `release.current()`/`release.elsewhere()`.
- **Slash-arg completion** (`docs/dev/web-hub-slash-args/plan.md`): the Composer's `/name␠`
  argument hints + dynamic completion. Cap `cmd.args.v1` gates everything (`CommandInfoWire.args`,
  the `complete_req`/`complete_reply` frame pair, `POST /api/command/complete`); PROTO is NOT
  bumped (r1 评审 #2 — new optional frames only, the fsb/lan/tfa 先例). `webHub.commandComplete`
  `"all"|"toolkit"|"off"` (default `all`, NON-live: `/reload` + `/webhub restart`; off ⇒ no
  service, no TUI wrapper, no cap, `HubConfig.cmdArgs` key absent ⇒ hub builds no route and the
  agent's slot-flush strips `args` for cap-less hubs). Sources: S-own (toolkit commands —
  `wrapCommandApi` records each raw `getArgumentCompletions`; new toolkit completers must be
  reviewed pure functions) and S-tui (`mode:"tui"` + `all` only — a transparent
  `addAutocompleteProvider` passthrough capturing pi's base provider for third-party/builtin
  commands; RPC/print never gets it). Deny commands never complete and deny ITEMS are dropped
  per-item (the execution path's own tables); budgets: agent 1.5s hard timeout + in-flight ≤2
  (a SYNCHRONOUS third-party hang blocks the process — accepted residual, r1 #4), hub 4s route
  deadline / in-flight ≤8 global ≤3 per principal / independent limiter, browser disconnect ⇒
  slot released + audit `aborted` (r1 #6). Enter applies a candidate ONLY after explicit ↑↓
  navigation (D2 拍板). `/webhub status` prints `cmd-args: <mode> · hub-cap on|off|n/a`
  (`agent/cmd-args-status.ts`). Conformance: `tests/conformance/slash-args.test.ts` (real pi
  rpc child + real InteractiveMode) before any pi peer bump.
- `src/topic-switch/` — new-request relevance judge → suggest a clean new session
  (`docs/dev/topic-switch/{requirements,arch,plan}.md`). Post-guard, main-session only, settings-
  gated (`topicSwitch.enabled`, default on). The judge model chain is a configurable LIST
  (`topicSwitch.model`: csv string or JSON array → live `topicSwitch.models`; configured in order
  → `title.model` → session model) with runtime failover inside the total `judgeTimeoutMs` budget
  (`judgeWithFailover`: per-attempt `min(remaining, max(1500, ceil(total/2)))`, external abort
  stops immediately, all-fail ⇒ the existing fail-open verdict; `/topic-switch status` shows the
  last answering model + per-model failure counts). Layered like the rest of the repo: pi-free decision
  core (`types/settings/filters/economics/gate/judge/state/records.ts`, P1) → `confirm.ts` (TUI
  ⟂ web dialog race, P3a) → pi-facing assembly (`wire/hold/release/recovery/command.ts`, P3b).
  Invariants I1–I6: the `input` handler only ever holds `interactive`/`rpc` sources (never its own
  `extension`-sourced re-injections — structurally impossible to double-hold); every held request
  gets exactly one decision (current session via the release queue, or the new session via PONR);
  a crash/`/reload` window auto-redelivers AT MOST once (`pending→delivering→resolved` CAS, never
  retried); unprovable inputs (cold/cost/judge) always fail open (`continue`). PONR = the instant
  `ctx.newSession` is called from the `/topic-switch __go <nonce>` command trampoline (never
  reachable through the `input` event, S3); before it everything rolls back to the current
  session, after it only `withSession`/the transfer's own CAS (`pending→delivering→resolved`,
  bypass `→cancelled|manual`) ever delivers — recoverable via `/topic-switch last [--send]`. Four
  translation-flip points (each defined exactly once): D1 non-Anthropic routes stay `unknown`
  (`cache-ttl/warmth.ts`'s `WARMTH_SUPPORTED_APIS`), D2 web prompts judged too
  (`promptGateRef.current = …` above), D3 judge-model fallback to the session model
  (`judge.ts`'s `JUDGE_SESSION_MODEL_FALLBACK`), D4 a confirm timeout counts as declining
  (`state.ts`'s `COOLDOWN_OUTCOMES`). The process-global transfer map
  (`Symbol.for("pi-subagent:topic-switch-transfer")`, cap 4/TTL 10min/FIFO, worktree-origin
  precedent) survives a `/reload` ONLY (it is in-process memory, wiped by a real crash/restart);
  crash recovery instead relies on the persisted `pending` session-entry record `persistPending`
  writes to disk alongside the transfer (`planRecovery`'s rule 4 in `records.ts`). A B1-class fix
  (mid-switch marker on the same global, excluded from recovery until the switch resolves) keeps a
  brand-new activation's `session_start` — which real pi always re-runs on session replacement, not
  just `/reload` — from racing a PONR hop still in flight.
- `src/git/` — pi-free bounded git executor (`run.ts`: hard deadline, process-group kill, stdout/stderr caps,
  unref'd timers) + `git worktree list --porcelain` parse/scan (`worktrees.ts`) + `~` path labels (`path-label.ts`).
- `src/config/` — agent-type registry (Markdown frontmatter), fuzzy model hints, settings file.
- `src/external-agent/` — external agent provider framework, currently one adapter: the virtual provider `droid/<model>`
  (Factory's `droid` CLI; design `docs/dev/external-agent/{plan,arch}.md`, user guide `docs/dev/external-agent/README.md`).
  Settings-gated: `externalAgents.droid.enabled` defaults false ⇒ no port/router/probe/disk write and a byte-identical
  stack/prompt (the always-on checks use only structural evidence: `diag.external`, the `<agentDir>/external-agent/` path).
  Ports are assembled in `src/stack.ts`; `RoutingSessionDriver` sends `droid/*` models to the droid adapter and everything
  else to the pi driver. Process model: `droid exec --input-format stream-jsonrpc` child (`process.ts`/`jsonrpc.ts`),
  wrapped by an `sh` owner-watchdog because D10 measured that closing stdin mid-turn does NOT make droid exit (idle EOF
  does); `DROID_EXITS_ON_STDIN_EOF=false`, auto-update disabled via child env (strong guarantee is the user's
  `~/.factory/update-policy.json`). Permissions: `autonomyLevel:"high"` with `autoRejectPermissionRequests:false` and a
  synchronous `proceed_once` auto-approve (R10: droid also reads the user's global skills/AGENTS.md/MCP). `toolDomain:"readonly"`
  is refused for droid (consult and tidy can never use it — droid cannot be sandboxed read-only). Resume pins the
  transcript's header-line cwd (missing ⇒ `config` error, never a fallback; external resume + isolation rejected).
  Billing: droid usage × the underlying model's pi price (`pricing.ts`; family/consensus matches are `approx`; no match ⇒
  `unpriced` "all"/"partial", never inferred from costUsd≈0). The model catalog is probed lazily (an empty session is
  written under `~/.factory/sessions/<probe-cwd slug>/`). Quota: droid's two Factory pools gate spawn (see `src/quota/`).
  Provider availability (2026-10-20): port-local auth evidence from runs/probes or quota HTTP 401/402/403 hides droid
  from the available-models section (stable hub tail update) and fast-rejects new/nested/workflow spawns AND resumes;
  `/agent status` exposes the most recent active reason. Failures are source-scoped (run/catalog/quota), each with
  a 30min read-time TTL: quota success clears quota only; catalog success clears catalog only (metadata init can
  succeed without usable login/model access); a successful droid turn clears all three. Any active failure blocks.
  `/reload` re-evaluates, no persistence/timers. Missing binary/collision/strict drift remain blocked.
  Protocol drift is guarded by a strict/warn check plus `tests/conformance/droid-protocol.test.ts` (real droid, opt-in
  `PI_TOOLKIT_DROID_CONFORMANCE=1`; run it manually before any pi/droid upgrade).
- `src/quota/` — quota-aware dispatch: provider adapters + TTL cache, laddered turn_end warnings, and a spawn fast-fail gate
  (design: `docs/dev/quota/`). A window whose `resetAt` has elapsed levels to 0 (`reason:"reset-elapsed"`, HUD `7d 100%·reset`) and bypasses
  the refresh TTL only while the snapshot predates the reset; `quota.repeatS` re-sends at L3 only. Ladder thresholds are per-window
  (repo defaults: 5h 50/75/90, week/7d 50/95/98 — `ladder.ts`'s `DEFAULT_THRESHOLDS_BY_WINDOW`; `l3EtaMs` stays global). `quota.windows.{5h,week}.{l1,l2,l3}Percent`
  override a single window; the legacy flat `quota.l1Percent/l2Percent/l3Percent` still work and, when set, override BOTH windows
  (back-compat) — window-level fields win over the flat override, which wins over the per-window default. Each window's l1<=l2<=l3
  is clamped independently.
  **droid pools** (`src/quota/adapters/droid.ts`, plan `docs/dev/external-agent/quota-plan.md`): Factory's standard/core pools are
  virtual providers `droid-standard`/`droid-core` with a `month` window (`mo`); `droid/<id>` spawns gate on the owning pool with the
  **core→standard fallback** (2026-10-16 user-confirmed live: core-pool models keep running, billed against standard quota, once core
  is exhausted — `verdictsForModel` returns `["droid-core","droid-standard"]` keys so a core model is blocked only when BOTH pools are
  at the block level; standard models never fall back; unknown pool ⇒ both must be exhausted), notices/listings say 「额度尽，回落
  Standard 计费」 (pool state `"fallback"`) instead of 告急/已拦 while standard has room, extra-usage blocks unless
  `quota.droidAllowExtraUsage`; 401/402/403 now also signal the external-provider availability gate (2026-10-20,
  supersedes quota-plan D3's warn-only rule; HUD unchanged); web rows need cap `quota.pools.v1`. Suspicious-reading
  detection survives restarts: `baseline.ts` persists each provider's last ACCEPTED reading into the same `quota-state.json`
  (`baselines` key; both stores read-modify-write so neither flush clobbers the other's group) and seeds `classifyDrop` after a
  restart — display/verdicts still need a fresh accepted snapshot; an all-zero reading against a non-elapsed >0 baseline is never
  confirmed as a reset by repetition (only reset evidence or a non-all-zero read accepts).
- `src/sysload/` — load-aware dispatch (`docs/dev/sysload/plan.md` v2.1). Pi-free core except `hook.ts`: `procfs`/`mounts`/`sampler`
  read CPU (incl. PSI), memory, IO pressure and per-mount disk from /proc + statfs under a process-wide IO ledger
  (`io-ledger.ts`, `Symbol.for("pi-subagent:sysload-io")` — the one documented process-global: ≤2 async ops, ≤1 per key, slots
  released only when the operation really settles, late results generation-fenced); `tracker.ts` runs the frozen
  sustain(60s)/recover(30s)/hysteresis state machine per metric (overall = max known level, all unknown ⇒ unknown;
  `levelSinceMono`/`gatingSinceMono` give the gate duration); `top.ts` scans /proc on demand (deadline, single ledger slot,
  pid+starttime reuse check, aggregated by comm, instantaneous CPU% across scans, `cpuPct`/`rssBytes` omitted ⇔ n/a — never
  NaN on the wire); `gate.ts` evaluates admission + renders the rejection text; `hook.ts` turn_end hints (`subagent:load`,
  `triggerTurn:false`). Settings `load.*` + `webHub.load` are non-live (session_start / hub start). Entry matrix (P2a,
  `src/stack.ts` + `spawn-service.ts`): top-level and nested `Agent` (incl. resume) are rejected while gated (before any
  run/label/worktree), workflow `agent()` waits FIFO via the injected `LoadAdmission` (`src/workflow/host.ts`), consult /
  `/goal` verifier / tidy / `/task` / @mention / RPC / cron are exempt; gate off, unknown, stale, print/json ⇒ fail open.
  Hub side (`src/web-hub/hub/load.ts`): one hub sampler, fingerprint-gated `load` SSE frames, cap `load.v1`,
  `GET /api/load/top` (X-PWH + same auth as other GETs, LAN same width, per-principal rate limit, 1.5 s deadline); UI
  `src/web-hub/ui/src/components/load/` (pill / card / drawer banner from `StatusInfo.loadGate`). `load.enabled=false` /
  `webHub.load=false` ⇒ zero wiring.
- `src/secure/` — encrypted session vaults over gocryptfs (design, rulings D1–D9/Q1–Q2 and the full residual list: `docs/dev/data-encryption/plan.md` r4; reports P0–P2 incl. security-review fixes). Two halves sharing a CONTRACT, never an import (parity fixture `tests/fixtures/secure-contract-parity.json`, never regenerate). **Launcher** `bin/pi-secure` (thin bash entry: locate helper via `readlink -f`, Linux check, `ulimit -c 0`, `umask 077`, `cd /`) + `bin/helper.mjs` (pure Node, zero deps; npm `bin` entry; installed by the `ln -s …/src/secure/bin/pi-secure ~/.local/bin/pi-secure` line `/secure status` prints): `init <name> [--path|--fix-settings]` / `unlock` / `lock [--lazy]` / `status [<name>]` / `run <name> [-C <subdir>] [pi args…]`. The vault password is typed by the user straight into gocryptfs on the TTY — the toolkit never reads, stores or passes it; `init` requires a real TTY and never passes `-q`, so the master key prints exactly once in the terminal (Q1). `run` re-parses args through pi's own `dist/cli/args.js` `parseArgs` (structural self-check, fail closed — C4 pins drift): `--session-dir` present (even `""`), `--no-extensions`/`-e`/`--export`, and unknown dangling `session-dir`/`session`/`fork` flags are rejected before any mount or password prompt; `--session <path>` must resolve under `<state>/sessions/` (re-checked physically after mount); `--fork`/`@file` copy INTO the vault; `--no-session` is allowed. Exit codes: 64 args rejected · 66 unknown vault · 69 prerequisites missing · 73 mount.lock timeout · 75 finalize budget exhausted / hard fallback (`process.exit(75)`) · 76 vault busy · 77 three password misses (1s/2s/4s backoff) · 78 config error (bad settings, sessionDir conflict, `enabled:false`). Both `run` (after pi exits) and `lock` end in the same bounded `finalize(10s)`: `/proc/*/cwd` occupancy scan, `flock`-guarded `fusermount3 -u` as ONE detached process group, SIGKILL without waiting at the deadline (D-state leftovers are residual R19), and an unref'd `budget+500ms` timer hard-exits 75. Vault registration (`pi-secure init`) and the plugin's `persistSettingOverride` share one settings-file lock (`settings-lock.ts`: whole read→merge→tmp→rename under `flock(2)` on `<settings dir>/.pi-subagent.json.lock`, atomic writes, symlink/non-regular/foreign-owner fail-closed; the only lockless exception is a system without flock).
  **Plugin guards**: `initSecureDomain()` is the FIRST statement of `activate()` (`src/index.ts`, before any settings read), freezing the verdict per process on `Symbol.for("pi-subagent:secure-domain")` — env `PI_SECURE_VAULT` ?? cwd match (whole vault dir, not just `mnt/`) + mount state ⇒ secure / locked / plain; `/reload` never re-judges, so a newly registered vault needs a pi restart (`/secure status` says so). secure ⇒ `TMPDIR=<state>/tmp`, `ARMORY_MEMORY_ROOT=<state>/memory`, `PI_SECURE_SESSION=1`, `PI_SECURE_VAULT` (so a nested `pi` joins the same domain). `loadSettings` (both entry points) clones-then-overrides `bashJobs.dir`/`workflow.journalDir` into `<state>` and turns D8 features off (`fabric.crossSession`, `externalAgents.droid`, `feishuNotify`; cron additionally: scheduler `start()` skipped outside plain + `register()` throws). `consultSessionDir()` (`fork-store.ts`) routes create/main-fork/remove/sweep/index through the one root `<state>/cache/consult-sessions` (not plan's `<state>/consult` — keeps consult's agentDir derivation inside the vault); child sessions land in `SessionManager.create(cwd, <state>/sessions/default)`; cross-domain resume and `session_before_switch` are cancelled. `wireSecureGuards` (pre-guard, registered before every other handler — first `handled`/`block`/`cancel` wins) enforces D2 (worktree isolation rejected; workflow `worktreeAvailable` false), D3 (secure write/edit confined to strictly below `mnt/work`/`mnt/state` — sentinel paths and `mnt/` root entries refused, symlink escape caught) and D4 (plain-domain read/write/edit/grep/find/ls + best-effort bash command-text scan stay out of every vault; `user_bash` is the user's own action, unchecked); a secure process re-checks the mount on EVERY `tool_call` and `input`, so a mid-session unmount flips the session to LOCKED (`secure:locked` status key) instead of letting the write zone degrade to plaintext. LOCKED ⇒ all input `handled`, all tools blocked, `user_bash` refused, notify with the fix (e.g. `pi-secure run acme -C sub`), no auto-shutdown (`/quit` works); `--no-session` sessions skip the session-file/dir checks but not the cwd/mount ones. `hubSafeEnv` (`env.ts`, zero imports, also boundary-whitelisted for the hub) strips `PI_SECURE_*` and restores/deletes `TMPDIR`/`ARMORY_MEMORY_ROOT` per `PI_SECURE_ORIG_ENV`, wired at `spawnHub` (`web-hub/agent/launcher.ts`) and the hub spawn supervisor's `forkInto` env loop — a hub spawned from a secure session cannot misfreeze normal web sessions. `/secure status` (read-only, post-guard, main session only; web command policy `secure status` = allow, anything else = deny) reports the verdict, lock reason, per-vault mount state, the D5 traffic-record check and the launcher install hint. A missing settings file, an absent `secure` section and `enabled:false` keep the command table, hooks, `process.env` and settings byte-identical (golden `tests/fixtures/secure-off-golden.json`, never regenerate); a present-but-unreadable/corrupt section deliberately surfaces `secure:invalid` + one warn (security-review #2). Gates: `tests/secure/**` (launcher-helper/cli/fuse, domain, guards, guard-points, settings-override, settings-lock, config-parity, off-golden), `tests/conformance/secure-gocryptfs.test.ts` (self-gating C1–C5, run before any pi peer or gocryptfs bump) and the probe `scripts/dev/secure-probe.sh`. Accepted residuals (plan §5 — hardening, NOT a no-plaintext guarantee): web-hub/LAN/Feishu plaintext copies incl. uploads, Feishu durable-request bodies, outbox content and spawn stderr logs (R12); swap/hibernate and apport core dumps, warn-only (R2/R3); same-uid `/proc/<pid>/mem` and terminal/tmux scrollback incl. the printed master key (R16); bash writing outside the vault best-effort only (R8); bypassing the launcher with raw `pi` (R6) and pi-native `/debug` `/export` `/share` `/copy` (R4); crashes.json (R1); pre-migration plaintext originals (R17).
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
max(ceil(f·workflowTotalMs), workflowTotalMs + maxExtensions·extendStepMs)` with the base `maxTotalFactor` preserved
  (`extendStepMs` reused from `settings.budget`, same 「每次延长最多 1h」 ruling; per-grant cap applies to `extend()` too)
  — while the workflow's children stay
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
  `>=1.0.0 <1.4.0`; bump deliberately and re-check `src/adapters/pi-compat.ts`. Before bumping, run
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

Releases are cut by `scripts/release/release.sh <version>` (copied from `~/ai/claude2api`'s
dev/main release flow; `main` there is `master` here), and only when the user explicitly asks for one:

- **Branch strategy (铁律)**: day-to-day development happens on `dev`. A **patch** release is cut
  directly on `dev` (release commit + tag on dev, no merge into `master` first). A **minor/major**
  release must first merge `dev` into `master` via PR, then the release commit + tag are made on
  `master`; releasing minor/major on `dev` is forbidden. Before releasing, pull the target branch and
  confirm the commits to release are on it; the tag must be on the release branch's ancestor chain.
  The script derives the bump kind from the requested version vs the latest tag and enforces this
  (up-to-date check, ancestor check and push all use the release branch). Consequence: `master` only
  advances on minor/major, so `pi install git:` users on the default branch get patches only at the
  next minor. After a minor/major, sync dev (`git switch dev && git merge --ff-only master`) — the
  script only prints this reminder.
- **Transition rule**: while neither a local `dev` nor `origin/dev` exists, a patch release from
  `master` is allowed with a WARN (create dev afterwards: `git switch -c dev && git push -u origin dev`);
  once dev exists the strict rules above apply.

- **Version bump rule**: default **patch** — fix/refactor/perf/chore/docs/test/ci are always patch;
  **minor** only after at least 50 `feat` commits accumulated since the latest existing `vX.Y.0` tag
  (patch tags don't reset the count); **major** only on `BREAKING CHANGE` (`!:` subject or footer).
  The script prints its suggestion and WARNs on a mismatch. When unsure, choose patch.
- **CHANGELOG is generated, never hand-edited**: feature/fix commits do not touch `CHANGELOG.md`;
  the release script builds the version section from the Conventional Commits since the last tag
  (anything already under `[Unreleased]` is merged in) and updates the compare links. Commit
  subjects/bodies therefore ARE the changelog — write them for users. Do not hand-edit released
  sections either; to change the output, change the script.
- **Flow**: on the release branch (`dev` for patch, `master` for minor/major), clean tree, up to date with `origin/<branch>` ⇒ sync `package.json` /
  `package-lock.json` ⇒ generate CHANGELOG ⇒ `format:check` → `typecheck` → `build` →
  `build:web` + `check:web` → `test` (any failure aborts before commit/tag) ⇒ commit
  `chore(release): bump version to vX.Y.Z` ⇒ annotated tag carrying the section (verified on the branch's ancestor chain) ⇒ push branch + tag ⇒
  `scripts/release/package.sh` (zips + sha256 + notes) ⇒ `gh release create`. Flags: `--dry-run`,
  `--changelog`, `--skip-tests` (emergency only), `--skip-push`, `--skip-publish`.
