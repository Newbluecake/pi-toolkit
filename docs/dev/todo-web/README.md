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
