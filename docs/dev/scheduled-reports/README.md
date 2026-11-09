# schedule 定时任务 · 开发者要点

> 何时读：改动 `src/schedule/**`、`schedule.*` 设置键、`/schedule`、hub 侧 schedule 协调/飞书卡片之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`acceptance.md`

## 报告引用与文件名（#62）

- 结果消息的「全文」入口互斥：有 `runId` 只显示 `get_run_result <runId>`；否则有报告时显示 `<store.root.real>/<sessionDirName>/<run.reportFile>` 的绝对路径；两者均无则省略。工具名仅定义在 `src/core/tool-names.ts` 的 `RESULT_TOOL_NAME`（原名 `get_subagent_result`），报告截断提示复用它，且不为无 runId 的运行虚构可查询全文。
- digest、schedule 工具的 get/history、`/schedule show/log`（含 `--all`，使用实际归属会话的 store）也只展示报告绝对路径；展示不改账本。
- 新报告路径为 `reports/<taskId>-<YYYYMMDD-HHmm>[-n].md`，取 `run.scheduledAt`（auto occurrence / manual trigger），使用任务 tz，无 tz 时使用本地时区。`reportFileOf` 只生成基名；background / message writer 在 `writeReportLocked` 的同一 session writer 锁内通过 `allocateUnique` 分配 `-2`、`-3` 等后缀，同时避开磁盘条目与仍存账本引用。回调拿实际分配路径再一次性提交 terminal run 与 pendingReports。
- `run.reportFile` / `pendingReports.reportFile` 继续存相对路径；旧 64-hex 文件名仍可读取并参与原有 14 天 GC，**不迁移旧文件**。共享 filename/path 白名单只接受短名或旧哈希名；fd-anchored 读取与目录/owner/mode 检查不变。
- `reportIdOf(sessionId, runKey)`、receipts 键、outbox `sch:<reportId>`、24 h 推送窗口和 pendingReports ≤64 均不变；hub 仍只读账本。hub 将已验证的 reportFile 传给飞书投递器，超长报告附件的新短名 basename 传入 renderer，由同一 fileName 同时生成卡片 fileNote 和上传信息；旧 64-hex 报告回退原有 `reply-<sid6>.md`；重复扫描、hub 重启不重复推送。没有新增 wire 字段/cap/PROTO 或 off 表面。更新运行中的 agent/hub 需 `/reload`、`/webhub restart`，旧 hub 未认识新文件名，不能只更新 agent。
- 验证记录与完整改动清单：[report-paths-report.md](report-paths-report.md)。

## 当场确认 AI 创建/修改的任务（#61）— 已移除（schedule-auto-approve r2，2026-11-04）

> 方案：`docs/dev/schedule-auto-approve/plan.md`（r2）；验收：`docs/dev/schedule-auto-approve/acceptance.md`。历史设计仍在 `confirm-plan.md` 与 `confirm-*-report.md`（仅供考古）。

任务不再有「待批准」状态：`schedule` 工具 / `/schedule add|edit` 写入即生效（executable ⇔ `enabled`），没有 TUI 确认框、web 审阅弹窗、飞书审批卡片；`/schedule approve|reject|__put` 已删（未知子命令，web 对它们 policy deny）。

- **wire 保留（只为容忍解析，均带 deprecated 注释）**：`sched.confirm.v1` cap 常量、`sched_offers` / `sched_decide(_ack)` schema、`ScheduleApproval`。新 hub / 新 agent 都不再声明该 cap；agent 收到杂散 `sched_decide` 仍回恰好一个存根 ack；hub 丢弃旧 agent 的 `sched_offers`；UI 忽略线上的 `pendingApproval` / `executable` / `offer` / `task.approval`。
- **混跑矩阵（摘要）**：旧 hub × 新 agent ⇒ 无 offer 帧，旧 UI 可能仍显示「待确认」；新 hub × 旧 agent ⇒ 旧 agent 的 pending 任务在新 hub 显示为启用。`/reload` + `/webhub restart` 后消除（plan §4）。
- **D7 回滚**：回退到旧版本后，升级期间新建/修改的任务（无有效 approval）变为 pending，需 `/schedule approve`（fail-closed）。
- **D8 存量**：存量 pending 任务（用户令不迁移）升级即生效；首轮 sweep 把待批准期间的 occurrence 记为 missed，并在 digest 中出现一次。账本里的旧 `approval` 字段是化石：不进 `defHash`、不读、不写、不剥离。
- **门禁**：`tests/web-hub/protocol/schedule-confirm.test.ts`（schema 容忍）、`tests/schedule/agent/webhub-wiring.test.ts`（hello 不含 confirm cap）、`tests/integration/schedule-hub.test.ts`（旧 approval 账本被容忍）；plan §8.5 残留 grep 在 `src`/`tests` 须为零。

## src/schedule/

`src/schedule/` — session-aware scheduled tasks (cron/once; `schedule.enabled`, default **false**; design + rulings:
`docs/dev/scheduled-reports/plan.md` r3, packages S0/S1/W1/F1/A0/A1/A2/A3/H1/I1, reports `*-report.md`, real-device checklist
`acceptance.md`). Replaces the old standalone cron scheduler. `core/` is pi-free (spec/cron/occurrence/claim/lock/writer/reader/
recovery/session-proof/paths); `agent/` is the pi-facing half (`wire.ts` activation, `mode.ts` run-mode matrix, `bg.ts` background
executor, `dispatch.ts` message scheduler, `executors.ts` per-session executor assembly, `ops.ts`/`surface.ts`/`view.ts` shared
tool+command+web surface, `status.ts`, `digest.ts`, `note.ts`, `report-file.ts`, `coordinator.ts`); hub side
`src/web-hub/hub/schedule/*` + `hub/feishu/schedule*`, UI `src/web-hub/ui/src/components/schedule/`. **Off ⇒ zero surface**: no tool,
no `/schedule` command, no `pi_schedules` prompt section, no status-bar item, no `HubConfig.schedule` key, no `sched.v1` cap, no
directories and the legacy `pi-subagent-schedules.json` is never written; the ONLY residue is `installScheduleOrphanGuard`'s three
hooks (`before_agent_start`/`context`/`agent_settled`, zero IO) that abort a leftover scheduled trigger after a `/reload` that
turned the feature off. Pinned by `tests/fixtures/schedule-off-golden.json` — never regenerate.
**Model**: timers live only in the owning interactive main session (TUI/RPC with a session file; print/json, `--no-session`,
independently opened child files and secure/locked domains never arm — `E_MODE/E_EPHEMERAL/E_CHILD/E_SECURE`); one 0600 atomic
`state.json` per session under `<agentDir>/schedules/<sid>/` is the single ledger (task defs, runs, `missedLog`, `pendingReports`
index ≤64); the hub is a **read-only** coordinator (it scans, never writes the ledger) and the only deliverer of Feishu cards, with
its own receipt ledger (`sched_receipts` clears the agent's `pendingReports`; hub restart reconciles missed/unknown runs without
double-push, 24 h report window). Two claim kinds (timer/sweep claim an occurrence inside the writer lock; manual `run` claims
without moving the watermark), sweep tolerance 60 s, missed occurrences are judged by the sweep and surfaced via `missedLog` +
digest exactly once.
**No approval (r2)**: executable ⇔ `enabled`; AI/user writes take effect immediately (`resume` just re-enables). `defHash` (sha256 of the
execution definition) still binds runs, occurrences and the `sched_run` CAS (`E_REV` on drift); web `add/edit/repair/--all` writes are deny in
the frozen `webCommandPolicy.schedule` table, and `approve`/`reject`/`__put` are deny as well. Legacy ledger `approval` fields are tolerated and ignored.
**Execution authorization (A2 `dispatch.ts`)**: `background` runs go through `bg.ts` (callerOwned spawn + `suppressDelivery`);
`message`/`handoff` runs are scheduled messages: queued while busy (idle + quiet window + capability gate + fence), written with a
per-send token, authorized ONLY at the trigger's own `before_agent_start` (token + epoch + context re-check; a forged/stale token or
an orphan after reload is aborted on sight, its first model call refused by the `context` re-check), start budget 60 s, run cap
3600 s (a human interjection ⇒ `continued`, uncapped), owner-closed/shutdown ⇒ `unknown(owner-closed)` before any late outcome.
**Own pre-start compaction (I1, C-S5; review r1 hardening)**: real pi fires `session_before_compact` inside `sendCustomMessage`
(and awaits every handler in turn, so with xs's handler ahead of ours A2 observes it a few microtasks AFTER the send returned).
A `session_before_compact` seen on the send's synchronous stack **or within `SCHED_SELF_COMPACTION_ATTRIB_MS` (5 s) of the send,
bound to the still-`dispatched` flight** (first compaction only, closed by a human's run starting) is this send's own: it is exempt
from `verifyDispatch` (compaction window ONLY — tree/switch/gen change are not), pauses the 60 s start budget and is hard-capped at
`SCHED_START_COMPACTION_MAX_MS` (600 s) from the send; a foreign compaction keeps the dispatcher fenced. **Authorization re-check**:
`before_agent_start` (and `context`, before the first model call) re-reads the fence — any open window other than our own running
compaction, or a generation change ⇒ the trigger is refused (`unknown(owner-closed)`, aborted, never resent).
**Revocation generation**: `pause`/`rm` record `revokedAt[taskId]` in the scheduler (`revokeTask`, process-local); a message run /
handoff whose source run was claimed at or before it is refused at enqueue and at the send CAS (so a handoff of a once-claimed task
reaching the queue AFTER a pause can never wake); a handoff's `onEnd` fires exactly once (`ended`), and the adapter writes one recap.
**UI prompts** pair by `(kind,title)` (pi's ui events carry no id) with an over-block-only rule: an `end` with nothing open is
ignored (no credit), a lost end blocks until the local exit, and dispatch waits `UI_END_SETTLE_MS` after the last end. **Unblock exits**: `/schedule repair` (web **deny**, local only) and
`/fabric fence reset` (governed by `webCommandPolicy.fabric`, default allow ⇒ web-executable like its other mutation subcommands)
both call `resetBlockers()` (fence windows + ui_prompt counts). `pause`/`rm` revoke queued runs: ledger half via S1
`finishRun(dropped, "task-changed")` (also `--all`), in-memory half `MessageScheduler.revokeTask` (own process only).
**Gates**: off golden (above); `tests/integration/schedule-{wiring,hub,fault-matrix,off-golden,surface-wiring}.test.ts` (real activate ×
fake pi / real hub child × fake Feishu / 9 SIGKILL points); conformance `tests/conformance/schedule.test.ts` C-S1…C-S8 (real pi + local
Anthropic stub, C-S6 needs tsx else skip) — **run before any pi peer bump**, together with fabric C-P/C-X. Legacy (#40): `bg.consultMain` stays a persisted field (it feeds `defHash`); the executor ignores it.
**Accepted residuals** (I1-report §6): `--all` revocation cannot reach another process's in-memory queue (the send-time CAS with the
task-snapshot compare is the backstop); same-uid hostile model can edit the ledger file (same-uid trust); vault predicate is agent-side
only (hub has no vault roots — H1 #3); Feishu global budgets live in F1's process memory; a ui dialog end/late-start interleave on the same `(kind,title)` that exceeds `UI_END_SETTLE_MS` (2 s buffer after the last end) can let one dispatch through while a dialog is still open (exits: `/schedule repair`, `/fabric fence reset`); hub per-task accumulators are capped (64 observed/`pendingUnknown` runKeys per task; per H1 residual #4 the excess is left to the session-reopen digest);
a compaction event delayed beyond the 5 s attribution window by a slow handler ahead of ours degrades to the 60 s budget, and a foreign compaction that starts inside the window of a still-pending trigger is mis-attributed (only the budget pause — authorization is re-checked at `before_agent_start`/`context`) (fail closed); the wiring was written before its integration tests (mutation-verified afterwards, see report).

## Objective-loop removal (2026-11-09)

The goal fence source and its open-window exemption are removed; the scheduler retains all SDK/UI/root-wake/compaction guards. Its off golden has the user-approved command/hook removal only; no schedule behavior is otherwise changed.

## Interval P1 (2026-11-09, #76): consumers and execution kernel only

Specification: [interval-and-catchup-design.md](interval-and-catchup-design.md), §6.2 P1. **No production interval producer yet**:
`schedule` tool / command flags, external `when` validation and legacy cron step diagnostics stay cron/once-only.
New ledgers are still v1; ordinary transactions preserve the version read and cannot upgrade v1. A test-only v2 fixture
(or a later P2 producer) is needed to exercise interval execution. Existing v2 mutations, receipts, terminal writes,
housekeeping and explicit repair of a structurally damaged, recognized v2 preserve v2. Unknown versions are degraded
and **cannot be repaired automatically or by `/schedule repair`** (manual inspection required). Known corrupt JSON/schema
repair keeps the existing quarantine semantics; unreadable JSON cannot establish a version.

### Pure contracts and arbitration

- Storage uses `StoredWhen = ScheduleWhen | {kind:"every", everyMs, anchorAt}` / `StoredTask`; **legacy wire
  `ScheduleTaskDef.when` is not widened**. `spec.ts` re-exports the pure vocabulary and `displayTz` from protocol.
  `cron.ts` owns `parseEvery` / `nextEvery` / `everyCount` plus formatter-free every branches of compile/next/count/between/isOccurrence.
  `every.ts` is a convenience re-export, not another implementation. The hub's reviewed import closure is unchanged.
- Decimal parser: trim outside only, lowercase s/m/h/d, ≤3 decimals, ≤32 input characters, exact BigInt ratio,
  whole seconds, inclusive 30s..365d; `90m` and `1.5h` normalize to the same 5,400,000ms. Grid = A+kD, k≥1;
  arithmetic checks safe integer / Date bounds, never zeroes a corrupt anchor. UTC only, no tz on stored every.
- `interval.ts`: `planEveryDue` plans the **whole** `(decidedThrough, now]` window arithmetically;
  `reconcileEvery` gates before read and under the lock, then `transactPlanned` verifies rev/time/skew and the
  definition/watermark before a single durable commit. Legacy `planSweep` and `autoClaim` explicitly yield every.
  Latest T within 24h inclusive + no nonterminal task run ⇒ missed += N−1, fired +=1, watermark=T, at most one
  `${taskId}@${T}` run (background dispatching / message queued). Busy (either form) ⇒ skipped +=N, no replacement;
  expired ⇒ missed +=N; both advance T and clear resumePending. N=0 clears only resumePending. Gate/lock failure
  moves nothing. Only a proven durable fire reaches the executor; uncertain commits get deduplicated unknown(no-outcome)
  readback, never dispatch/replay. Terminal failure/crash cannot reclaim the decided window.
- Missed accounting materializes **only the final ≤64 chunks**, each ≤10,000 points. Quotient/remainder arithmetic
  advances cumulative total and seq for omitted chunks; no occurrence or historical-chunk loop. Test observes chunk
  steps for N=1,000,000,123, not just the total.
- Pause decides the old enabled window as `paused` in the same task-change transaction, keeps A/D while disabled;
  false→true persists `resumePending` without voiding the paused gap. Repeated pause/resume is a semantic no-op.
  Name-only edits preserve hash/grid; execution changes settle the old grid without executing it and reanchor an
  interval to transaction `ctx.now`. Manual claims never touch the automatic grid/watermark.

### Owner clock, refresh priority and bounds

`openedAt` is the clock's fixed `deps.armedSince` (new owner epoch at startup/reopen/reload), **not** a refresh timestamp.
Every path does dead-holder recovery before interval reconciliation, then arms only a **future** grid point.

| Lock-time snapshot                               | Catch-up cause (only when a run is created) |
| ------------------------------------------------ | ------------------------------------------- |
| resumePending                                    | resume (highest priority)                   |
| otherwise first owed F < fixed openedAt          | reopen                                      |
| otherwise N>1 or now−T>60s                       | late                                        |
| otherwise (including F=openedAt and exactly 60s) | no catchUp                                  |

Online refresh/poke/changed, timer, poll and heartbeat do not reset openedAt; their arrival order does not classify a run.
The 30s poll checks enabled every backlog/resumePending even with unchanged stat/rev; pure cron/once keeps its stat fast path.
One serial work chain and ≤8 task slots per round (taskId + definition hash, epoch scoped by clock instance) merge all sources.
Each task has first + at most one 2s retry; one shared earliest-retry timer; 10s shared monotonic deadline, ≤16 logical
reconciles and ≤48 planning/lock attempts. Writer locks use min(existing lock budget, remaining round budget), with
checks before planning/replanning/locked apply; no Promise.race around writes. A rotating cursor carries unfinished tail
work to the next poll. Failure cannot rearm an old point at 0ms. Pure every timers ≤12 (fire/poll/heartbeat/retry + ≤8
uncertain readbacks); dispose clears all. Production uses the segmented/unref clock, with a 365d raw-backend test.
Synchronous fsync/IO remains non-preemptible; this is a bound on **starting** work, not physical IO cancellation.

### Consumers, wire and security

- Durable optional `run.catchUp = {cause,fromExclusive,through,dueCount,recoveredAt}` is the single source for
  background prompt/header/report, message wake/report and history: “这是补跑；合并 N 次到期，本次只执行一次” plus
  UTC window/original plan/recovery instants. Compact tokens use `catch-up ×N` only.
- `displayTz(every)=UTC`; status renders HH:mm:ss UTC / MM-DD HH:mm:ss UTC; view/message/report and hub/UI/Feishu
  have explicit every branches. Cron/once keep their existing minute text (report header's prior seconds included).
  New interval report paths use UTC and the unchanged minute filename grammar + locked collision suffix allocation.
- Append-only `intervalTasks?` carries every projections; old `tasks` includes only cron/once, runs are not duplicated.
  No intervals ⇒ no intervalTasks/catchUp keys. Both hello/cap surfaces append `sched.interval.v1` only when the
  existing schedule port/config exists. `SchedHubLink.intervalReady()` provides future P2 admission without opening
  creation now. UI merges both task arrays once; hub observation **and** armObserve ignore every, consuming committed
  missedLog only. No PROTO/schema rewrite, no every disguised as cron.
- **Registration hard gate**: `config/settings.ts::applySecureDomainOverrides` clones schedule and forces enabled=false
  for secure/locked in both settings entry paths, above file/session overrides. Actual activate integration covers
  secure/locked × absent/explicit true × absent/preexisting v1 store: no tool, command, prompt/status, hello cap,
  HubConfig.schedule, directory or ledger migration. Existing orphan guard remains the only off residue. Runtime
  locked checks remain, including before clock reads; no claim that SDK tools can be unregistered mid-process.
- Expansion audit: full `src` grep for `when.tz` and schedule cron/once binary branches was reviewed. Remaining direct
  accesses are narrowed legacy compiler/view branches or the deliberately legacy-only external parser; UI whenParts
  is a display union with an explicit every arm; dispatch's once-only enabled exemption intentionally stays once-only.
  No boundary allowlist relaxation, default flip, frozen fixture change, or production input change.

P2 owns the producer transaction's explicit v1→v2 upgrade, normalized-equivalence admission/anchor commit and strict
step diagnostics/cap admission. It must not alter P1's stored every shape, hash algorithm, window verdict, labels,
poll bounds or append-only projection; the current ordinary writer remains version-preserving (an explicit upgrade
path may be added without changing ordinary transaction semantics). Integration tests are tier2 by the manifest's
`tests/integration/` prefix. The new every/core-clock/consumer drivers use a real flock-backed writer through the test-only
v2 seeder and are explicitly tier2 in `tests/tiers.ts`; the pure raw timer backend test remains tier1.
