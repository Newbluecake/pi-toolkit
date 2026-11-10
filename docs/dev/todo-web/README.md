# todo 任务工具 · 开发者要点

> 何时读：改动 `src/todo/**`、`todo.*` 设置键、todo 在 web hub 的投影之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`../todo-archive/`

## src/todo/

`src/todo/` — merged pi-claude-todo: TaskCreate/List/Get/Update/Delete + aboveEditor widget
(key `claude-code-todo`, coexists with the fleet widget) + `/tasklist`. Persists via TWO session
entry kinds (#92, todo-archive-split): the `claude-code-todo-state` live snapshot (narrowed to
unarchived tasks, `{v:1, nextId, tasks}`) plus incremental `claude-code-todo-archive` packages
(`{v:1, reset?, put?, drop?}`) for archived tasks — the read-back folds + merges both in
`replayState`/`replayTodo` (single choke point; cross-storage dependency edges are authoritative
on the archive side), with a 256-entry eviction cap enforced in sweep. Design:
`../todo-archive-split/plan.md`, decisions D10–D15 in `../todo-archive/plan.md` §9. Registered
pre-guard; widget is TUI-only. Completed tasks
collapse out of the default views and auto-archive (on compaction and after `todo.archive.afterTurns`
turns; `TaskList includeCompleted:true` lists everything) per `docs/dev/todo-archive/plan.md`. A read-only
summary also reaches the web hub: `TodoWireResult.getTodoSnapshot()` → `projectTodo`
(`src/web-hub/agent/todo.ts`, 32-task cap / 512B description / 32KiB three-pass budget) rides
the optional `StatusInfo.todo` slot (append-only, no proto bump) to a collapsible `TodoPanel`
on the web detail header. Design: `docs/dev/todo-web/plan.md`.

The 512-byte per-description limit is a UTF-8 code-point-safe source-text cap, not a
32-row retention guarantee: the final 32 KiB JSON budget still drops whole descriptions
from the tail when fields are large or JSON escaping expands control characters. For example,
32 short-subject rows with 512 ASCII bytes each fit (19,059 serialized bytes), whereas 32
rows of 512 U+0001 characters expand sixfold and only nine descriptions survive.

**TodoPanel → TasksPanel（schedule-auto-approve r2 W2, 2026-11-05）**: the web detail header's
todo surface is now the aggregated `TasksPanel.vue`（`components/detail/`）— same data path
(`StatusInfo.todo` → `@logic/state.js` status reducer → `AgentState.todo` → prop），todo 分区的
markup 与折叠尾行逻辑原样搬迁自已删除的 `TodoPanel.vue`（`styles/todo.css` 的行样式继续复用）；
新增定时任务分区：DetailHeader 用 `@logic/schedule.js` 的 `schedSummaryOf`（hub cap `sched.v1` +
`schedules` 槽位 + sessionId）作渲染门，`TasksPanel` 内部用 `taskRowsOf` 从原始投影派生行，
`ScheduleRows.vue` 纯展示（暂停/继续/删除走 CONTROL_VIEW 的 tracked-command + policy confirm，
`open-run`→`hub.selectRun` 跳 fleet，`open-schedule`→SchedulePanel）。面板渲染条件 =
「todo 非空 或 schedSummaryOf 有值」；两侧各自为空时只隐藏自己的分区。TUI 侧的 todo widget
不受影响。

**todo-nudge 可见性（Task59 阶段A, 2026-11-07）**: the main-session staleness nudge message
(`subagent:todo-nudge`) is now sent `display: true` — pi's TUI renders it via the stock
`CustomMessageComponent` (default box + markdown body; no extension renderer registered) and
the web-hub transcript's `itemEntry` admits it as a `custom` entry (`TxCustom.vue`, kind chip
`todo-nudge`), while `display:false` customs stay dropped there. Historical display:false
entries are NOT rewritten — only nudges fired from this version on are visible.
`triggerTurn:false` is preserved (agent-session's `sendCustomMessage` never starts a run on a
falsy triggerTurn), so visibility adds no new model turn and no E1 self-loop (`message_start`
fires regardless of display; E1 matches only the three completion customTypes). The copy now
asks for an actionable authorized-scope check first (continue tasks whose dependencies are
satisfied and not waiting on user/approval/external/timer; TaskUpdate after verified; do NOT
use the nudge to start queued/unauthorized tasks), with evidence labels calibrated to the
counting口径: E1 「N 条后台完成通知」（子 agent/workflow/bash job）, E2 「N 次 git 写操作」
（commit/merge/cherry-pick/rebase/revert）. 阶段B 内核已实现但未接生产，见下文。Tests:
`tests/web-hub/agent/todo-nudge-visibility.test.ts`（真实 SDK 组件 + 双端投影）。

**todo-idle-recovery 现状（2026-11-08）**：B1 候选/指纹、窗口预算和 Stop 内核及 store，
以及 B2 `idle-recovery-host.ts` / `idle-recovery-runner.ts` 均已在源码实现。候选须为未归档、
依赖已完成的 `in_progress`，metadata 仅可收窄而非授权；每窗口最多 2 次、全 session 同组合只试一次，
seen 达 256 闭锁；Stop 仅由新的合格真人到达解除；先记账再发送，unknown 不退款。runner 有 15 分钟
期限和 10 秒宽限；空闲门要求 SDK idle/无 pending，query、workflow、jobs、notifier、web、两种 schedule、
otherRoot 全 clear，缺失/未知闭锁。

**未接生产**：`wireTodo` 不注册 recovery Host；生产缺真实 `AgentSession.subscribe` 时 runner 为
`effective-off`，extension 的 `agent_settled` hook 本身不得排恢复。可信 arrival producer 和生产忙态口
也未接入。独立单元测试不是生产启用证明。

**尚未验证**：真实时钟下期限、跨 reload 账本语义（replay 只恢复账本，不恢复 live window）、与 #61
fabric 唤醒、schedule 的真实拓扑互斥；异步 hook / deferred 输入 / reload 组合的 conformance
已知不支持。历史设计及裁定见 `../todo-idle-recovery/plan.md`，其旧阶段计划不代表当前实现状态。

**Nudge backoff default**: `todo.nudge.cooldownTurns` defaults to 3 silent turns; consecutive
no-touch nudges use 3 / 6 / 12 / 12 silent turns (cap = 4 × base). The next turn after
the silent interval is eligible to fire, so persistent candidates fire 4 / 7 / 13 turns apart.

## Objective-loop removal (2026-11-09)

Idle recovery no longer lists or probes a goal owner. The remaining busy sources still fail closed on unknown. Generic unknown-source tests now use `otherRoot`; production recovery remains effective-off as above.

## Mutation persistence uncertainty (#84)

Todo mutations apply to in-memory state before persistence. Only an exception from `persist()` is
reported as `memoryApplied:true, persistence:"unknown"`; validation, formatting and UI errors are
not reclassified. An append may have landed before throwing: do not repeat the mutation or recreate
the task. `TaskGet` / `TaskList(includeCompleted:true)` inspect current memory only, not disk
persistence; a missing deleted task is not proof of a durable deletion. Successful individual
appends advance their own baseline; the failure path does not roll back or retry.
`tests/todo/tools.test.ts` exercises these distinctions. Source implementation is not evidence that
an already-running session has loaded it.
