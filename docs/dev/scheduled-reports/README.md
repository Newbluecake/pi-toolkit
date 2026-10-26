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

## 当场确认 AI 创建/修改的任务（#61）

> 方案与评审：`confirm-plan.md`（r2 + §10 拍板）；包报告 `confirm-{C0,C1,H2,W2,C2,F2,I2}-report.md`。随 `schedule.enabled` 开关，**不新增设置键**；schedule 关 ⇒ 无 offer 模块、无新事件钩子、无 `sched.confirm.v1` cap、`schedule-off-golden` 不变。

**流程**：`schedule` 工具 create/update 之后任务仍是待批准 ⇒ `confirm.offer()`（只在内存，≤8 个、TTL 2 h、同 taskId 同 hash 不重复问；不同 hash ⇒ 旧 offer `superseded`，新 offer 继承旧 origin，所以 create→update→reject 仍是「删除」）。工具结果文本换成 `CONFIRM_NOTE`（工具描述串不改，缓存前缀不变），`details.confirm: "offered"|"unavailable"`。三个渠道同时呈现同一个 offer：

- **TUI**：`ui.select(批准 / 拒绝 / 稍后)`，只在开框前判断（`isIdle` ∧ 无外部 ui-prompt ∧ 无进行中回合 ∧ 最近 2 s 无 input），**不带 timeout / abort**，打开后不接管收尾。
- **web**：hub 把 `sched_offers` 投影成任务的 `offer`（仅在线且唯一视图、hash 一致、未过期）；`DetailHeader` 自动打开 `SchedulePanel` 并定位，`ScheduleReview` 多一个「拒绝」按钮（`/schedule reject <id> <hash>`）。
- **飞书**：owner 的 p2p 绑定收到审批卡片（`F2`，owner 证明 fail-closed，见 `docs/dev/feishu-bot/README.md`），按钮经 `port.decide → sched_decide → confirm.decide`，每帧恰好一个 `sched_decide_ack`。

**三渠道竞速**：唯一裁判是账本 CAS——`approveTask` 在锁内先查 `isApproved`（`already-approved`，三渠道 / `--all` 的唯一落实点）再比 hash；同一 offer 的 `decide` 复用同一个 in-flight promise（一条 notice、一个 `closed.by`）。赢家之外的渠道由 agent 权威全量 `sched_offers{open,closed}`（每次变化 + 每次 hello_ack，空列表也发）收回：TUI 框只 `notify`、不 abort；web offer 消失（review 里显示「已在其他端批准 / 任务已删除」）；飞书卡 `closed.by==="feishu"` ⇒ 保留并 PATCH「已通过飞书批准」，其余 ⇒ 先落盘认领再 DELETE，失败只做一次中性 PATCH。账本被他进程（`--all`）改动由 15 s 轮询兜底。web 命令批准不经 `decide`，由 `revalidate` 发现账本已批准后关成 `approved/elsewhere`。

**拒绝语义**：拒绝 = 撤销 AI 这次未确认的改动。create 链 ⇒ `removeTask`（同事务，并 `dropQueuedRuns` / revoke）；update 链 ⇒ 恢复改动前的 `form/when/prompt/feishu/bg`（原批准按 hash 自动重新生效；**不回滚 `name`**，它不在 `defHash` 里）。飞书批准记 `approval.via:"web"`（`via` 联合类型被 reader 严格校验）。「稍后」/Esc/关框 ⇒ 保持待确认，不再自动重开。

**重载 / 离线**：offer 不持久，`/reload` 后不补弹、拒绝也不能回滚（回滚基线只在内存）。飞书卡在 offer 既不在 open 也不在 closed 时对照 hub 账本证据（`ledgerTask`：scan 起点晚于 anchor 创建且账本无该任务 ⇒「任务已删除」；同 hash 已批准 ⇒「已批准」；其余保留卡片）。agent 离线时 web 不出 offer、飞书点击回「会话离线，未处理」，不会 decide；旧 hub × 新 agent（无 confirm cap）⇒ TUI-only 零新帧，新 hub × 旧 agent ⇒ 不发卡。

**门禁**：`tests/schedule/{core/claim,agent/confirm,agent/coordinator}.test.ts`、`tests/web-hub/hub/{schedule-confirm-hub,feishu/schedule-confirm}.test.ts`、`tests/web-hub/ui/schedule-*.test.ts`；端到端 `tests/integration/schedule-confirm.test.ts`（真 hub 子进程 × 真 agent stack（真 `schedule` 工具 / `/schedule` 命令 / confirm / 协调器）× fake 飞书 × fake pi：三渠道各赢一次、拒绝 create/update、同时点击、离线、reload 证据、schedule 关）与 `tests/integration/web-hub-feishu-bot.test.ts`「#61 I2」块（飞书卡发送/回调/owner fail-closed）。`governance/activate-trace.json` 在 schedule 开启画像下因 surface 的 `input/before_agent_start/ui_prompt_start/ui_prompt_end` 转发钩子已声明性刷新一次（C1）。

**残留风险**：

- **R1 pi 共用对话框槽（最大）**：pi 的扩展对话框共用编辑器槽，后开的覆盖前一个且前一个的 promise 永不 resolve；嵌套对话框（depth≥1）不发 `ui_prompt_*`，pi 的 abort/timeout 收尾又会 `hideExtensionSelector()` 关掉**当前**框——所以「我的框是否仍在显示」不可证。本实现只做开框前纪律、不自 abort；被顶掉的框接受 promise 泄漏（`uiPromptDepth` 不复位、dispatch 栅栏多算），用 `/schedule repair` / `/fabric fence reset` 清；开着的框无人值守会让调度消息派发一直等待（后台 subagent 不受影响），最迟由 offer TTL 界定。根治需要 pi 给对话框加 id 或排队（建议上游 issue）。
- R2 回滚基线只在内存；R3 他进程 `--all` 改账本最长 15 s 才收回（`already-approved` 兜底）；R4 飞书 recall 认领与 DELETE 之间崩溃会留下原卡片（按钮 nonce 已 purge，点了无效）；R5 `via:"web"` 让 `/schedule show` 看不出批准来自飞书；R6 web 多标签页都会自动弹出；R7 卡面超 20 KB 只截断 prompt（hash 绑全文，web 可审全文）；R8 同会话第 5–8 个 offer 不发卡（计数 `sched-confirm-card-cap`，卡槽空出后补发）；R10 双击在 decide 落定前后的极端窗口可能多一次幂等 PATCH；R12 owner 证明依赖 24 h 内的请求记录（无则收不到卡，发一条消息即可恢复）。
- 升级后需 `/reload` 再 `/webhub restart`；只升级 agent 时退化为 TUI-only，属设计内行为。

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
**Gates**: off golden (above); `tests/integration/schedule-{wiring,hub,confirm,fault-matrix,off-golden,surface-wiring}.test.ts` (real activate ×
fake pi / real hub child × fake Feishu / 9 SIGKILL points); conformance `tests/conformance/schedule.test.ts` C-S1…C-S8 (real pi + local
Anthropic stub, C-S6 needs tsx else skip) — **run before any pi peer bump**, together with fabric C-P/C-X. Legacy (#40): `bg.consultMain` stays a persisted field (it feeds `defHash`); the executor ignores it.
**Accepted residuals** (I1-report §6): `--all` revocation cannot reach another process's in-memory queue (the send-time CAS with the
task-snapshot compare is the backstop); same-uid hostile model can edit the ledger file (same-uid trust); vault predicate is agent-side
only (hub has no vault roots — H1 #3); Feishu global budgets live in F1's process memory; a ui dialog end/late-start interleave on the same `(kind,title)` that exceeds `UI_END_SETTLE_MS` (2 s buffer after the last end) can let one dispatch through while a dialog is still open (exits: `/schedule repair`, `/fabric fence reset`); hub per-task accumulators are capped (64 observed/`pendingUnknown` runKeys per task; per H1 residual #4 the excess is left to the session-reopen digest);
a compaction event delayed beyond the 5 s attribution window by a slow handler ahead of ours degrades to the 60 s budget, and a foreign compaction that starts inside the window of a still-pending trigger is mis-attributed (only the budget pause — authorization is re-checked at `before_agent_start`/`context`) (fail closed); the wiring was written before its integration tests (mutation-verified afterwards, see report).
