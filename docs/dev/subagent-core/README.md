# 子 agent 核心（core / runtime / service） · 开发者要点

> 何时读：改动 `src/core/**`、`src/runtime/**`、`src/service/**`、`budget.*`/`agent.*`/`load.*` 设置键、run 状态机、deadline、reaper、spawn 准入之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`../agent-background-only/`、`../timeout-notify/`、`../agent-explicit-timeout-extend/`、`../reaper-orphans/`、`../subagent-run-persistence/`

## src/core/

`src/core/` — pure domain: state machine, deadline budgets, ids, types, and the worktree-origin
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
  **Still open:** G5/G6 only (missing from the unreachable path B — deliberately not fixed).
