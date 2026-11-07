# 子 agent 核心（core / runtime / service） · 开发者要点

> 何时读：改动 `src/core/**`、`src/runtime/**`、`src/service/**`、`budget.*`/`agent.*`/`load.*` 设置键、run 状态机、deadline、reaper、spawn 准入之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`../agent-background-only/`、`../timeout-notify/`、`../agent-explicit-timeout-extend/`、`../reaper-orphans/`、`../subagent-run-persistence/`

## Agent-tool minimum total and shared grace defaults (#62)

- Product defaults: `DeadlineBudget.minTotalMs = 1_800_000` (`budget.minTotalS = 1800`) and
  `totalGraceMs = 600_000` (`budget.totalGraceS = 600`). `totalMs` stays 1800s; an existing personal
  `budget.totalS: 7200` is preserved, not rewritten or replaced by the floor. The floor accepts lower values
  and `0` (off), is live for **new admissions only**, and is derived through the normal seconds/ms boundary.
- Every **Agent tool** path (top-level, nested blocking/background, omitted timeout and resume) marks
  `SpawnRequest.agentToolDispatch: true` in `prepareSpawn`. This is an internal **host convention**, not a
  security capability. Admission merges default → host → type → request budgets, then applies
  `max(merged.totalMs, clampSpanMs(mergeBudget(host).minTotalMs))` only for marked requests, then the existing
  policy. Type/request floor overrides cannot lower the host floor. Invalid negative/nonfinite floors are
  discarded by `mergeBudget`; `0` disables the floor and huge finite spans are clamped. Generic `mergeBudget`
  does **not** floor total: unmarked programmatic producers (`/task`, RPC, fabric wake, workflow children,
  goal verifier, schedule) remain unchanged even with extendable policy or pool/load rejection flags.
- Explicit `timeout_s: 1` and `1799` are intentionally raised by the default floor, not just omitted values.
  A fixed-policy resume also gets the floor but **keeps fixed policy** (no grace/extension). Phase watchdogs,
  earlier absolute deadlines, abort and parent lifecycle remain authoritative: the floor is **not a promise
  to survive 30 minutes**. No clocks are refilled. The marker is `NOT_THREADED`, absent from runtime,
  diagnostics, journals and wire. No new tool argument or persisted DTO is introduced.
- Ceilings use the effective total **T after flooring**, default `max(2×T, T + 3h)`; configured factors/counts/
  step, `extend.enabled=false`, fixed policy and earlier absolute deadlines retain their original semantics.
  The shared grace default intentionally reaches workflow orchestration and schedule settlement fallback:
  `schedule/agent/bg.ts`'s unspecified `waitGraceMs` is now `600s + 10s abort + 5s reap = 615s`.
  This is a defensive result-wait allowance, **not grace or a longer deadline for the fixed schedule run**.
- Frozen nested surface residual: the legacy `default 90` clause remains in **two places**, the shared
  `leadingFields.timeout_s` description in `src/tools/agent-tool.ts` and its byte-for-byte nested snapshot in
  `tests/fixtures/tools/agent-nested-surface-golden.json`. It is deliberately **not synchronized** because
  that A-tier surface is frozen. Top-level Agent independently overrides only the timeout description
  (schema stays integer/minimum1/maximum604800); nested **runtime uses 600s**, proven by real nested tool →
  service → runtime grace entry in `tests/service/agent-min-total.test.ts`. Nested grace remains silent.
- Config contract evidence: the old settings corpus projects away `minTotalMs` and uses the old 90s
  **fallback** only for historical evaluations; frozen inputs/seeds/order/hashes stay unchanged and explicit
  overrides stay intact. It does not claim to test 600s. Dedicated config tests cover real defaults,
  lower/off/invalid floors, migration and live writes. The spec pin declares `budget.minTotalS` as additive;
  only the intentionally changed grace-description hash and aggregate are refreshed (B contract change).
  `tests/config/workflow-settings.test.ts` exercises the real schedule wait fallback without changing its implementation.
- Source/default changes need `/reload` in existing sessions to load this code; no reload or user settings
  write is performed by this change. Once loaded, live floor edits apply only to newly admitted runs.

## src/core/

`src/core/` — pure domain: state machine, deadline budgets, ids, types, and the worktree-origin
registry (`worktree-origin.ts`: worktree path → original cwd, `Symbol.for` global, FIFO-capped;
written by `src/extensions/worktree.ts`, read by `src/memory/`). No pi imports. 局部类型兼容注记（pi 1.5，2026-11-06）：
`types.ts` 的 `ExternalPriceTable.tiers` 为显式 `…[] | undefined`（pi 1.5 价目 DTO 可显式携带 `tiers: undefined`，
type-only 边界兼容；本地 pi 1.4 下 typecheck/门禁保持通过，runtime JS 未变，不代表 TESTED_PI_RANGE 已升；
详见 `docs/dev/pi-version-adaptation/plan.md`）。Deadline span
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

## src/runtime/

`src/runtime/` — runner, session driver, watchdog, reaper, slot pool (concurrency), dynamic
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
settings.json itself: a `create()`/`resume()` call whose counter never advances during
its own create-await window emits a `child_extension_missing` DriverEvent, folded into
`RunDiagnostics.childExtensionMissing` (best-effort, diag-only, never affects the run) and surfaced
in `get_run_result`'s text (`formatChildExtensionMissing`); the runner also `console.warn`s
once per process (deduped). Detection, not inheritance, is the whole feature (no attempt to make a
child session inherit the parent's `-e` extension list).

**Legacy consult data (#40)**: the consult subsystem was removed. Old run entries may still carry `diag.experts/consults/consultOf/consultCache/consultThread/consultIdentityPrediction` and `dispatchMeta.abArm`; these are ignored on read (never projected into new journals), and `displayAgentType` folds the `consult:main-snapshot` sentinel to `main`. Retained assets: `src/runtime/cap-watcher.ts` (the cap watcher tidy uses) and `src/runtime/legacy-consult-forks.ts` (sweeps the old `<state>/cache/consult-sessions` fork dir; never creates it). Compat test: `tests/integration/consult-legacy-entries.test.ts`.

**Structured-output repair turn** (`docs/dev/subagent-core/structured-output-repair-plan.md`): when a pi-path schema run's first
`handle.prompt()` settles **completed** with nothing captured, `RuntimeRunner.run()` sends ONE extra prompt
(`STRUCTURED_REPAIR_PROMPT`, `src/core/structured-repair.ts`) on the same `SessionHandle` — same runId, same generation,
no watchdog disarm — between the first prompt's settle and `sealBeforeTerminal`/`prompt_settled`. Eligibility is decided
SYNCHRONOUSLY by `planStructuredRepair` (order: cancelled/stopping/terminal → silent skip; already captured → silent skip;
phase ≠ `model_turn` → `skipped_phase`; tool not in `getActiveTools()` → `skipped_tool`; window → `skipped_grace`/
`skipped_budget`), so every skip path keeps pre-feature timing byte-identical. The adapter builds the runtime-only
`ResolvedSpawnRequest.structuredRepair` spec (never sent to pi, never a `SpawnRequest` field — Gate A/B/C untouched) only for
`!isExternal` schema runs; workflow children (`agent()` rejects `schema`, spawner-adapter never sets it), droid runs and
caller-capable runs are therefore structurally outside the feature.

Clock semantics (I1 — no free lifetime refill): the repair does NOT reset any sub-phase clock and dispatches no
`phase_entered`; repair events only refresh `lastEventAt`. The repair's bounds are the EARLIER of the per-run budget and
the WATCHDOG budget (`Watchdog.budget` — settings.budget, not the run budget): `phaseDueAt` in core folds both through
`dueAtFor`. The window needs `min(effective deadline, sub-phase due) − tailMs(5s) − now ≥ 15s`, else it is skipped
(`skipped_budget`); inside a grace window it is always skipped (`skipped_grace`). `windowDueAt = now + min(120s, available)`;
the local CLOSE point is `min(windowDueAt, effectiveDeadline − tailMs, phaseDue − tailMs)` and is re-derived on every
repair-phase event (a `tool_start`/`compaction_start` with a short budget pulls it in dynamically), always ≥ `tailMs` before
anything the watchdog or the prompt guard could fire. The close timer reuses the Clock port (unref'd, bounded; cleared in
`close()`/finally); the watchdog itself stays armed as the outer net.

Settlement priority (re-checked synchronously right before the final dispatch): cancel/timeout/input-budget > context-switch
self-check (`repairRan`-gated second `selfcheckErrorFor` pass) > completed → host schema policy. A repair prompt rejection,
repair-turn error, local close or turn-cap hit is IGNORED — the run settles on the first prompt's completed outcome and
`finalText`. The capture window (`captureOpen` in `runtime-adapter.ts`) is closed synchronously at (a) the local time close,
(b) the 3-`turn_end` cap, (c) the settle dispatch, and (d) CANCELLATION — a signal listener registered before the repair
prompt closes it the instant `abort()`/parent-abort/reaper runs, so a submission in the same synchronous stack is already
rejected; values accepted before the close are kept (a submit-then-close tick still succeeds). An aborted repair run stays
`aborted` even with a captured valid payload (user abort always wins). The tool set is NOT narrowed for the repair turn
(cache invalidation outweighs the constraint); enforcement is the prompt + the 3-turn cap + the dynamic time window.

Sub-session consumers under the "first settle → repair → run-terminal" sequence (plan §1g): child keepalive disposes itself
on the FIRST `agent_settled` and never recovers during/after the repair (R7 — accepted; the repair is an active turn under
120s); context-switch child still self-checks (a switch inside the repair turn fails the run — see above); sysprompt hub
folds the repair prompt as a new user request; traffic child drops per-prompt tickets; bash settle-hold is sealed after the
repair (sealBeforeTerminal); jev does one extra reinject/recall (R6); date may inject per its own rules. Caller caps still
count the repair turn: `createCapWatcher` sees its `turn_start` and a capped run aborts as usual (R3).

Observability: the failure suffix (`(after one repair turn)` / `skipped:*` variants, `structuredRepairSuffix`) only affects
the `captured === undefined` branch of `applyStructuredOutputPolicy`'s 5th optional param; `RunDiagnostics.structuredRepair`
(`"succeeded" | "failed"`) is written ONLY by the adapter's post-policy `store.put` (never journaled, never in StatusInfo or
`get_run_result` — R8) and only when a repair turn actually ran. Tests: `tests/core/structured-repair.test.ts` (pure
arithmetic), `tests/service/runtime-adapter-structured-repair.test.ts` (23 cases over a fake handle with a REAL late-bound
watchdog), `tests/workflow/structured-repair-not-applied.test.ts` + spawner/agent-opts assertions, and
`tests/integration/structured-repair-real-session.test.ts` (real AgentSession + real `wireChildSession`).

## src/service/

`src/service/` — spawn/query services, run registry, target resolution (exact → prefix → label), and the global background-status provider shared with feishu-notify.
Spawn admission rejects a `provider/id` unknown to the **host** model registry (typos; suggestions via `suggestModelRefs`).
It cannot catch a host registry gone stale after `models.json` changed on disk: child sessions rebuild `ModelRuntime`
from disk, so that case fails at session start as `failed` with `explainPromptRejection`'s cause (never `cancelled`).
Pool-full admission (L1, `agent.queueWhenFull` default false): a non-slotless top-level/nested Agent-tool dispatch is
rejected immediately (no run/label/worktree ever created) once `SpawnService`'s own admission-time reservation
(`slotfulLabel`, never `SlotPool.stats.inUse` — that only updates deep inside the runtime adapter, after H2/worktree
creation) reaches `concurrencyLimit`; every successful `spawn()` call also returns `slots` (limit/inUse/free, same
slotless-exclusion rule as the real pool) for the Agent tool to surface. Workflow children/resume/`/task`
never set `poolFullPolicy` and keep the legacy queue-and-`queueWaitMs`-timeout behavior. Tidy proposals use
`SpawnRequest.toolDomain: "readonly"`, which is consumed at admission/runtime and forces only the builtin
read-only tools plus the runtime-owned `StructuredOutput`; the field is deliberately not threaded into child
request prompts or ordinary runs.
`SpawnRequest.timeoutPolicy` (agent-explicit-timeout-extend plan): optional `"fixed" | "extendable"`,
default `fixed` — only the Agent tool (top-level and nested, when passing `timeout_s`) writes `"extendable"`;
spawn admission resolves it once (`req.timeoutPolicy` ?? resume-inherited ?? shape-derived from
`budgetOverride.totalMs`), applies it via `applyBudgetPolicy({ fixedDeadline })`, and the resolved value lands
in `diag.timeoutPolicy`, persisted through terminal entries, the non-terminal journal, tombstones and
terminal rebuilds, and inherited by resumes (R-inherit). Program-derived runs (workflow children,
`/goal` verifier, tidy, RPC) stay fixed-deadline. **Known accepted trade-off**: a nested extendable run's
grace window notifies nobody (CC2 suppression) and child sessions have no `extend_subagent_timeout` —
it silently lives up to `min(G,(f−1)·T)` past its deadline while the parent turn keeps waiting; the main
session can still extend it by run id.

**Resume schema inheritance (#68)**: an Agent-tool `resume` that passes no `schema` keeps the original run's schema
(StructuredOutput injection + host re-validation + `schemaPreset` verdict rendering). The tool sets
`SpawnRequest.inheritSchema: true`; spawn admission (`spawn-service.ts`) fills `schema`/`schemaPreset` from
`resolveResumeTarget`'s `schemaPreset` (preset id → frozen `SCHEMA_PRESETS`) or `schema` (inline). Source is the
terminal snapshot diag only (like `dispatchMeta`; tombstones do not carry it). Persistence is append-only:
`diag.schema` (inline, non-preset runs, ≤ `PERSISTED_SCHEMA_MAX_CHARS` = 16384 JSON chars, journal-whitelisted) next to
the existing `diag.schemaPreset`. No record (pre-#68 runs, oversize inline schema, schema-less runs) ⇒ no inheritance,
old behavior. Explicit `schema` overrides; top-level `schema: null` on a resume opts out (null without `resume` is still
the usual "schema must be a JSON Schema object" error). @mention / fabric wake / RPC resumes never set the flag ⇒
unchanged. Only the top-level `schema` description gained the sentence; the nested surface (frozen golden) is untouched.

## Stack teardown (`src/stack-teardown.ts`, #56 ⑦)

One place says which component of a session stack is torn down, on which entry and in which order. Read this before touching
any `dispose` / `session_shutdown` / `session_start` cleanup, a new stack member that owns a timer, or `/reload` behaviour.

**Entries** (what pi 1.3 really does is pinned by `tests/conformance/lifecycle-entries.test.ts`):

| Entry                                     | When                                                                      | Module                               | Teardown                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| startup                                   | first `session_start`                                                     | new                                  | nothing to tear down                                                            |
| same-cwd new / resume / fork              | `session_shutdown(reason)` on the old activation, then `activate()` again | **same** (pi's `extensionCache` hit) | path C on the old stack, then path A at the top of the next build               |
| `/reload`, cross-cwd resume               | `session_shutdown`, then a freshly imported module                        | **new**                              | path C only — `previousParts` starts empty                                      |
| quit                                      | `session_shutdown(quit)`                                                  | —                                    | path C, then bash kill (`shutdownPolicy=kill`) and the child bash registry seal |
| second `session_start` without a shutdown | not reachable in pi 1.3                                                   | —                                    | path B, then A                                                                  |

**API**: `Stack.dispose({ kind: "shutdown", reason }, env)` (async, awaited by pi), `Stack.dispose({ kind: "defensive", nextXsSessionId }, env)`
(sync), `Stack.dispose({ kind: "rebuild-handoff" })` (sync; what the next build in the same module runs over the previous
build's `TeardownParts`), `Stack.disposeXsSync()` (C1: the early-registered synchronous xs part of `session_shutdown`).
`StackTeardownEnv = { ctx, settings, activation }`; `activation` (`ActivationTeardown`, built in `index.ts`) holds the
activate-level pieces that run between stack steps: the xs ledger teardown (B), the schedule surface shutdown and the child
bash seal (C4).

**Step lists** (`REBUILD_STEPS` / `DEFENSIVE_STEPS` / `SHUTDOWN_STEPS`): array index is execution order. They are three lists on
purpose — the orders and member sets differ (e.g. C4 closes the schedule epoch before the run drain, A does not touch the
schedule at all). Rules that are easy to break:

- a step is idempotent in the component it calls — the same component is legitimately reached twice (C then A);
- sync steps stay synchronous and a step only returns a promise where the inline code awaited (no new microtask hops);
- `previousParts` is the ONLY module-level mutable of `stack.ts` (I4); a build publishes its own `parts` immediately and fills
  it at the places the components are created, so a build that throws half-way still hands its already-created pieces to the
  next build; it is replaced only after the handoff succeeded;
- C1 (xs ledger, `fabric/xs/activate.ts`), C2 (background-status + HOST_KEY release, `index.ts`) and C3 (`handoffStore.clear`,
  `compact-hint/register.ts`) stay separate `session_shutdown` handlers: their registration order relative to the other plugins'
  handlers is pinned by the activation-trace golden and the matrix test's handler counts;
- the gaps found in 7-1 were fixed one per commit in 7b (`docs/dev/source-governance/batch2-step7-report.md` §7b); the matrix test
  `tests/integration/stack-teardown-matrix.test.ts` pins each fix. Path C now also disposes: `external` (G7), the `/goal` hook
  timers (G9, activate-level), the usage broadcaster (G1, after drain/seal), the coalescer/ack-hold windows by **discard, not
  flush** (G2/G3 — the persisted `batched` outbox records are redelivered by the next stack's `reconcile`), the notifier retry
  timers (G10, after drain/seal so shutdown-time notices still reach the closing session) and the bash job manager (G4,
  timers only — the `parts.bashJobs` slot stays, path A still needs it as `prevBashJobs`); the child-switch `onDisabled`
  subscription is released at the head of the shutdown (G11). Components outside the `Stack` are reached through the build's
  `parts` (`StackStep.run(stack, env, entry, parts)`).
  G8: `session_shutdown` ends by `delete holder.current` (identity-checked, in `finally`), so a late holder-routed call fails with
  `no active session yet` instead of being answered by the torn-down stack; `createTidyPort` degrades instead of throwing.
  `load` (the sysload sampler, a 5 s unref'd timer) is on all three paths (B/C4 through the `Stack` member, A through
  `parts.load`, right after keepalive/quota — the same relative position as C, idempotently after it). Before #31 path A
  missed it, so a rebuild with no B/C before it (`Stack.dispose({kind:"rebuild-handoff"}`, or two builds in a row in the
  same module) left the PREVIOUS build's sampler ticking behind the new stack — and its leaked real timer randomly
  reddened the fake-timer tests of the matrix suite.
  **Still open:** G5/G6 only (missing from the unreachable path B — deliberately not fixed).

## Host human delegation in child sessions (#14 P2c)

`PiSessionDriver` accepts an optional activation-local `HumanRuntime` façade from
its stack constructor. Missing façade/proof, readonly provenance, explicit exclusion,
noTools/all, external and secure sessions follow the existing loader/tool path.
Authorized children append only the host SDK `message_session`, plus a public
DefaultResourceLoader inline observer (caller resources/runtime are retained).
Exact driver owner/context/toolCallId references derive from a real admitted edge
and precise parent invocation, never prompt/model metadata. Blocking nested Agent
execute uses activation-local AsyncLocalStorage of pure InvocationRef data so its
child can bind before the late blocking tool_result. The admission edge remains
mandatory. Root background result races wait once for <=1s with an unref timer,
only for a verified potential parent (64 waiters); absent proof fails closed.

The tool calls the main sender/reply port; children acquire no xs membership/caps.
Current child causal level is read after resolve and cannot lower root level.
SDK agent_end, compaction/branch boundaries, actual switch_context boundary entries,
PiSessionHandle abort/dispose and source epoch/lifetime invalidation revoke that
run's calls/context/owner while retaining already live descendants. Cleanup does
not rely on child session_shutdown. The global grant park contains bounded DATA
only; all SDK/resource/sender/waiter closures stay activation/handle-local.

Tests: `tests/runtime/human-runtime.test.ts`,
`tests/integration/fabric-xs-human-child-runtime.test.ts`. The latter exercises
real SDK sessions and production Agent tools (blocking and background nesting),
using controlled admitted-edge and transport ports, not a full network runner.

## Fast child admission and first-prompt barrier (task55 P3)

`SpawnServiceDeps.fastParent?: FastParentPort` is an activation-local optional dependency. Successful
synchronous admission captures `snapshot(req.parentRunId)` once, before inbox/label/slot mutation and async
work. An existing workflow `req.fastSeed` wins without another lookup; only `{v:1,mode}` is copied.
Snapshot exceptions return a config failure and release this admission's resume locks (no slot/label/edge
has been reserved yet). Missing port/undefined snapshot makes no Fast key, readback or record. External
droid admissions strip seeds; the runtime adapter explicitly copies request seed to `SessionSpec.fastSeed`
on the pi path only, not into promptNotes, tool arguments, runner-specific fields or external options.

`PiSessionDriver` accepts a fourth optional constructor argument `fastChildState?: FastChildStatePort`.
The trusted runtime `request.runId` becomes `FastOwner.parentRunId` (this child's id for a later nested
admission), with a fresh object incarnation per creation. After seed append, `bind(owner, readMode)` reads
the admitted mode until the receiver replies, then delegates to that child's branch callback, never root.
The parent-port implementation/registry and real branch fold are owned by the later Fast wire package.
No new Agent parameter, module registry, timer, worker option or network protocol is introduced here.

Secure/domain checks precede manager creation/open and Fast writes. The original manager is retained;
the original persisted child marker remains first, followed by `subagent:fast` `{v:1,mode}`. Terminal
Agent resume appends its new acceptance seed, including an inherit tombstone over an old child's on.
Append/init failure is fatal before any model prompt, not swallowed or “proved persisted” via getBranch.
Normal SDK buffered append success is accepted, **not fsync**. The independent SDK1.5 storage
characterization does not prove every production failure path; P3 additionally tests a real EISDIR seed
append failure, public init/append throws, missing receiver, abort and SDK-create failure with prompt count 0.

### V2 public SDK1.5 loader decision and literal handshake

`CreateAgentSessionOptions` has `resourceLoader`, **not eventBus**; its default-loader constructor receives
only cwd/agentDir/settingsManager. Following root's explicit signature/code review, **only with a seed**
P3 constructs the public canonical `DefaultResourceLoader({cwd,agentDir,settingsManager,eventBus,
...(systemPrompt ? {systemPromptOverride} : {})})` and reloads it once, preserving default resource discovery.
This is the approved conditional alternative for the otherwise inaccessible SDK-default bus, not permission
to replace arbitrary loaders. Without seed, no-prompt options still use SDK's default loader; the old custom
prompt path stays unchanged. `fastSeed` is destructured out before SDK options. With a seed only,
the driver also deletes the `signal` key from SDK options (not `signal: undefined`); it remains on the
original control spec for the driver's listener. No-seed SDK options retain their original signal key,
including the custom-prompt path. `withHumanBinding` composes
its existing supplemental observer on the same base resources without reloading the base. Fast is **not**
programmatically injected as an extension: production receiver must come from normal settings discovery.

The pi-free additions in `src/fast/ports.ts` are:

- `FAST_BIND_EVENT = "subagent:fast-bind"`, `FAST_RECORD_TYPE = "subagent:fast"`.
- `FastManagerView = { getBranch(): readonly unknown[] }`, a readonly wrapper of the original manager.
- `FastBindRequest = { readonly v:1; readonly owner:FastOwner; readonly manager:FastManagerView;
readonly reply:(response:FastBindReply)=>void }`.
- `FastBindReply = { readonly v:1; readonly wired:true; readonly readMode:()=>FastMode;
readonly dispose:()=>void }`.

Receiver subscribes synchronously during its extension factory/pre-guard wiring. Driver appends seed,
binds the seed callback, reloads resources, creates SDK session, then emits on that exact loader bus before
returning the handle (no reliance on session_start or session_shutdown). Reply must arrive in the handler's
synchronous prefix before its first await. No reply for on/off throws a classified non-retryable config
error with `reason="fast_receiver_missing"` on the thrown error and the same code in its message;
inherit retains the old extension-missing diagnostic and seed fallback. The original create budget/gate and
late-handle reaper remain authoritative; no polling, extra timers or lifetime refill are added.

Accepted reply/child-state cleanup is exact-owner, synchronous and once-only on abort/dispose/create failure;
bus listeners are cleared even when SDK never emits shutdown. A late old reply cannot replace current state
and disposes only its returned binding. Receiver must itself make same-manager binding idempotent, reject
another manager, and make its returned cleanup idempotent/owner-scoped; P3 provides the handshake, not a
second receiver/state implementation. Child wire order remains P4b's keepalive → Fast → lazy budget → traffic.

Tests: `tests/service/{spawn-fast,runtime-adapter-fast}.test.ts`,
`tests/runtime/session-driver-fast.test.ts`, `tests/conformance/fast-loader.test.ts`,
`tests/integration/fast-child.test.ts`. The latter two use the real isolated SDK1.5, own settings/local receiver
fixture, real public bus/loader and independent human observer, zero model prompts; the integration also
exercises the production driver and real append rollback after EISDIR. They do not certify live providers,
all faults, secure mounts, production Fast receiver wiring, or the unfinished whole feature.

**Internal cancellation seam (P3 mandatory delta, root-approved):** immediately before driver
create/resume the runner uses `const createReq = req.fastSeed === undefined ? req : { ...req,
signal: cancel.signal }`, then passes `createReq` to either call. All Fast seeds (including inherit)
therefore listen to the existing internal runner/watchdog cancellation, not just the caller's signal.
No-seed receives the original request object by identity. External parent linkage/detach, slot handling,
startup/total guards and late-handle reaper are unchanged. This does not add SDK create cancellation:
the driver listens in its own control layer, synchronously revokes the pending owner and clears its bus;
a late SDK result is disposed by the driver and rejected before FastBind/handle/prompt. If a handle
actually arrives late, the existing reaper still owns it (unchanged no-seed coverage).

`tests/runtime/runner-fast-cancel.test.ts` uses the real RuntimeRunner, production PiSessionDriver,
SingleSlotPool, EscalatingReaper and an explicitly started real EventWatchdog, holding only the SDK
create promise pending. Create/resume × on/off/inherit × runner abort/startup watchdog prove immediate
owner/bus revocation before SDK settles, external signal not aborted by internal cancel, exact-once
SDK disposal, no FastBind or prompt after cancellation, late bus-listener cleanup, same-parent new
incarnation survival, detached-parent behavior and no-seed request identity/late-handle reaping.
The watchdog cases explicitly arm it for startup: normal runner wiring arms it after bind. Separate
create/resume × on/off/inherit cases exercise normal `RuntimeRunner.run()` startup-budget exhaustion
without arming the watchdog. The startup guard resolves a timeout verdict (it does not cancel directly),
then runner dispatches startup_failed and its existing finally/reaper cancels with reason `reap`.
Without a beforeReap hook this revokes owner/bus before run resolves, with SDK still pending; the late
SDK result is disposed exactly once and cannot bind/prompt. An existing beforeReap hook runs before
reaper, bounded by the unchanged reapMs, so it may delay this guard-driven cancellation. The controlled
pending-hook test proves cancellation at the original reapMs bound without waiting for SDK settlement.
Since finally launches runReap fire-and-forget, run may return before that hook completes: only explicit
runner abort/already-armed watchdog cancellation is synchronous; not every path is zero-delay. This
delta preserves the existing hook ordering. Direct runner pending-create user abort
retains its pre-existing `abort_grace`/undefined-outcome behavior (startup_failed is absorbed there);
this seam does not change settlement policy or claim to fix that separate behavior. Production receiver
wiring and the remaining whole-feature integration still belong to P4b.

## Fast 集中装配与 Stack 资源（task55 P4b）

`buildSessionStack` 可选接收 activate-local `FastMainWiring`，在旧 parts handoff 后创建具体 session owner；
仅 enabled 时构造，不用 holder/global-current 查询。该 owner 的 parent、childState、workflow 分别接到
SpawnService、PiSessionDriver 第四参数、createWorkflowChildSpawner 的 `fastWorkflow` option（真实 host
通过 spawner 桥消费）。child 绑定前受理 seed、绑定后 branch 的语义仍由上面的 P3 合同负责；装配不
重新采样 queued seed。关闭 owner 后 capture 返回 undefined，不读下一 session。

Fast 的同步幂等 dispose 在三条 ordered lists 都紧接 backgroundCompletions，早于 drain/reap 等异步
工作：path A 通过 `parts.fast`，B/C 通过 `stack.fast`。只撤销本 owner/child reader，不新建 timer、不
增加 I1 预算或等待；disabled 无该成员/cleanup 效果，C→A 重复到达不会重开或伤害替代 owner。
`stack-teardown-matrix.test.ts` 保留原28 case并追加5个 owner/ABA/disabled case。child pre-guard 接线在
keepalive capture 之后、lazy budget registry 订阅及可能的同步重放之前，traffic 仍在最后；细节与真实
SDK/原生 warming/最终 body 证据见 `docs/dev/fast-command/README.md`。

## Memory-seed pipeline (task39 #39 P2, memory-scopes arch §6.3)

Independent of FastSeed/promptNotes (`SpawnRequest.memorySeed: MemorySeedCapture`, a P0 DTO).
`SpawnService` captures ONCE at the synchronous admission point — the fastSeed capture site,
after every admission gate, before inbox/labels/slots and any async work: a host-provided value
(workflow `agent()` admission) is kept including its explicit `empty` marker (which exists to
block dequeue re-reads); otherwise `deps.memoryParent?.snapshot(req.parentRunId)`. Every value
crossing that boundary goes through `frozenMemorySeedCapture` — the frozen P0
`validateSeedCapture` rebuild (the deep copy) + recursive `Object.freeze`. External agents and
resumes never carry a seed (stripped): an external runtime has no session-memory branch, and a
resumed terminal child restores its OWN session instead of re-inheriting the current parent.
Capture failure (throw OR invalid capture — including the LEGALLY REACHABLE exhaustion
sentinel `nextN=1_000_000`, which the frozen P0 product validator rejects by design) fails
CLOSED before any binding: resume locks released, spawn refused with a config error
(`memory seed capture failed: …`, reason `config`); never dropped, degraded to empty, retried
or privately re-widened. `admission-reason.test.ts`'s static count guard moved 26→27 with it.

`runtime-adapter.ts` sets `SessionSpec.memorySeed = seed` ONLY for
`!isExternal && memorySeed?.state === "captured"` (empty ⇒ nothing set: a child of an empty
parent starts with no entries); `request-threading.ts` keeps `memorySeed` in `NOT_THREADED`
(already classified). `PiSessionDriver.create()` appends the seed snap EXACTLY ONCE right
after `markChildSession` (marker stays first) and BEFORE any awaited reload/createAgentSession:
final snap DTO re-validated via `validateSessionEntry({mode:"write"})`, the
`SessionWriteGate` (`secureSessionWriteGate`, P1) checked synchronously at the append point
(no await between check and append; locked ⇒ zero branch/disk reads), then one
`appendCustomEntry(SESSION_MEMORY_ENTRY_TYPE, …)` on the ORIGINAL SDK SessionManager
(buffered append only — C0: observed failure is fatal, success never promises fsync, no torn
file is ever cleared). Any validation/gate/append failure REJECTS create before the first
model prompt — the child is never created memoryless. `resume()` never seeds. The gate is the
driver's optional 5th constructor param; absent ⇒ derived from the frozen secure-domain
verdict (`defaultSessionWriteGate`). Production assembly (real `memoryParent` port, injected
gate) is P4. Tests: `tests/service/memory-seed.test.ts` (admission contract, fail-closed,
freeze, resume/external strips, Fast coexistence), `tests/integration/memory-scopes-seed.test.ts`
(real SDK SessionManager/createAgentSession, fake model, tmp resources; order/gate/append
faults/resume-no-reseed).

## #39 P4c child memory bind 与取消链（2026-11-08）

Driver 的第 **5** 参数仍是 `SessionWriteGate`，第 **6** 可选参数是 activation-local
`MemoryChildBindingPort`。Fast seed **或** memory port 存在时才构造同一个 public event bus / canonical
loader；两者都缺席保留原无 seed 的 options/loader 路径。`subagent:memory-bind` 在 SDK create 完成后、
首 prompt 前同步发出，携带**原始实际 manager 对象**、每次创建独立 incarnation、literal
`created` / `resume` 和父同次解析的 frozen Hub slot。created 不作为 reopen，resume 不重播 seed。
receiver 在 child activate 的 pre-guard 阶段订阅，不依赖 child session_start/shutdown。

回复只在同步 accepting/live 窗口接收；晚到/重复/旧 incarnation 回复不能替换绑定。abort、SDK 失败、
late SDK success、handle abort/dispose 复用原清理路径；memory/Fast cleanup 用 finally 隔离，清 bus/listeners。
缺 receiver 默认仅静态 diagnostic（保留 #27 的 `-e` 兼容），strict 只用于内部测试，不伪称已绑定。

memory-only（即 `fastSeed === undefined`）也必须接 Runner 内部 `cancel.signal`。
Stack 从同一实际 memory port 派生 `memoryBindingEnabled`，只经 runtime-adapter 的两个可选 seam
透传到 Runner；无 Fast seed 且无标记仍传原 request 引用。不调整 watchdog、预算、beforeReap 顺序或
reaper 等待界。`peekRunBranch` 在实际 handle 读取后再次检查 generation/sessionId/active-handle identity
和 stopping/terminal，阻止重入期间旧 branch 发布。内存父捕获缺失/变化抛错，不降级 empty。

三条 ordered teardown lists 最前新增 exact `memoryScopes` group 同步幂等 dispose：先 abort popup，
撤销 turn/caps/command environment，再关闭 proof/approval/store/Hub/recovery authority；不清全局 poison。
旧 Stack/parts 只持有自己的 group；树边界在该 group 内轮换 owner，旧 group 的晚 cleanup 不伤新 group。
activate 的早期 shutdown fallback 覆盖兼容早退，Stack build 失败也关闭本次 group。

P4c 续包实际 SDK 反例：`SessionManager.newSession()` 可让同一个实际 manager 在同 handle 中换 sid，
而 Runner state 的已捕获 sid 尚未变化。`PiSessionHandle.getBranchEntries()` 因此同时保留构造时原 manager，
在 branch read 前后核验 SDK 的实际 manager/sid；变化抛错，由 peek/capture 拒绝，不能把新空 branch
当成旧 parent 的 empty seed。实际 Stack admission 测试已钉住这一负例；未改 SDK 或取消/预算语义。
