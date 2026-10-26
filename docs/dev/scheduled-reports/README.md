# schedule 定时任务 · 开发者要点

> 何时读：改动 `src/schedule/**`、`schedule.*` 设置键、`/schedule`、hub 侧 schedule 协调/飞书卡片之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`acceptance.md`

## 报告引用与文件名（#62）

- 结果消息的「全文」入口互斥：有 `runId` 只显示 `get_subagent_result <runId>`；否则有报告时显示 `<store.root.real>/<sessionDirName>/<run.reportFile>` 的绝对路径；两者均无则省略。工具名仅定义在 `agent/result-reference.ts` 的 `SCHEDULE_RESULT_TOOL`，报告截断提示复用它，且不为无 runId 的运行虚构可查询全文。
- digest、schedule 工具的 get/history、`/schedule show/log`（含 `--all`，使用实际归属会话的 store）也只展示报告绝对路径；展示不改账本。
- 新报告路径为 `reports/<taskId>-<YYYYMMDD-HHmm>[-n].md`，取 `run.scheduledAt`（auto occurrence / manual trigger），使用任务 tz，无 tz 时使用本地时区。`reportFileOf` 只生成基名；background / message writer 在 `writeReportLocked` 的同一 session writer 锁内通过 `allocateUnique` 分配 `-2`、`-3` 等后缀，同时避开磁盘条目与仍存账本引用。回调拿实际分配路径再一次性提交 terminal run 与 pendingReports。
- `run.reportFile` / `pendingReports.reportFile` 继续存相对路径；旧 64-hex 文件名仍可读取并参与原有 14 天 GC，**不迁移旧文件**。共享 filename/path 白名单只接受短名或旧哈希名；fd-anchored 读取与目录/owner/mode 检查不变。
- `reportIdOf(sessionId, runKey)`、receipts 键、outbox `sch:<reportId>`、24 h 推送窗口和 pendingReports ≤64 均不变；hub 仍只读账本。hub 将已验证的 reportFile 传给飞书投递器，超长报告附件的新短名 basename 传入 renderer，由同一 fileName 同时生成卡片 fileNote 和上传信息；旧 64-hex 报告回退原有 `reply-<sid6>.md`；重复扫描、hub 重启不重复推送。没有新增 wire 字段/cap/PROTO 或 off 表面。更新运行中的 agent/hub 需 `/reload`、`/webhub restart`，旧 hub 未认识新文件名，不能只更新 agent。
- 验证记录与完整改动清单：[report-paths-report.md](report-paths-report.md)。

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
**Approval = definition hash**: AI `create` never carries approval; `update` of an execution field voids the old approval; `resume`
never approves; a user `edit` re-approves only an already-approved task; `approve` shows the full definition, samples the hash BEFORE
the confirm and CASes under the lock (`E_REV` on drift); web only accepts `approve <id> <64hex>` (hash comes from the review dialog)
and the form's `__put <json> <hash>`; web `add/edit/repair/--all` writes are deny in the frozen `webCommandPolicy.schedule` table.
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
compaction (`goal` aside), or a generation change ⇒ the trigger is refused (`unknown(owner-closed)`, aborted, never resent).
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
