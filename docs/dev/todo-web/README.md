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
(`src/web-hub/agent/todo.ts`, 32-task cap / 240B description / 32KiB three-pass budget) rides
the optional `StatusInfo.todo` slot (append-only, no proto bump) to a collapsible `TodoPanel`
on the web detail header. Design: `docs/dev/todo-web/plan.md`.

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
（commit/merge/cherry-pick/rebase/revert）. 阶段B（自动空闲唤醒）未实现。Tests:
`tests/web-hub/agent/todo-nudge-visibility.test.ts`（真实 SDK 组件 + 双端投影）。

**todo-idle-recovery B1 / arrival 裁定（2026-11-08）**：已实现
`src/todo/idle-recovery.ts` 的纯候选/指纹/窗口-Stop 内核及
`idle-recovery-store.ts` 的全树 high-water 记账接口，**未接生产 hooks/设置/发送**，B2/B3 尚未实现。
用户新裁定覆盖旧 strong-consumption 前置：未来可信 Host TUI/Web 新用户聊天入站 callback
以 `HumanEpochPort` 提供 `user-arrival` proof，到达即开窗/清 Stop，不等模型消费、root-level persist
变化或 #61 整项；连续 root-level-0 新消息每条新窗口，重复到达复用 proof 不退款。
legacy `strong-consumption` 仅兼容；raw `admission`/`interactive`、`role:user`、机器/Task* 不续额。
模型不能传 epoch/owner/inputId 宣称 human；本包只定义 API，不构造实际可信 producer。
每窗口 2 次、全 sid 同组合一次、seen256 满闭、先 append attempt 再 send、unknown 不返不重试、
旧 owner/stale epoch/重复 proof 不清 Stop、reload/replay 不造 live window 均保留。
B2 专用 runner/owned deadline 等仍须真实 SDK 本地 conformance 证明；B3 共享入口待 #39
当前包独验并 commit 后再接，todo 不依赖 fabric/#61 内核。详见 `../todo-idle-recovery/plan.md`
顶部新裁定；旧历史 strong-window/Q2 口径由其覆盖。
