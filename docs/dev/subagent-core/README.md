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
in `get_subagent_result`'s text (`formatChildExtensionMissing`); the runner also `console.warn`s
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
