# todo 任务工具 · 开发者要点

> 何时读：改动 `src/todo/**`、`todo.*` 设置键、todo 在 web hub 的投影之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`plan.md`、`../todo-archive/`

## src/todo/

`src/todo/` — merged pi-claude-todo: TaskCreate/List/Get/Update/Delete + aboveEditor widget
(key `claude-code-todo`, coexists with the fleet widget) + `/tasklist`. Persists via the
`claude-code-todo-state` session entry; registered pre-guard; widget is TUI-only. Completed tasks
collapse out of the default views and auto-archive (on compaction and after `todo.archive.afterTurns`
turns; `TaskList includeCompleted:true` lists everything) per `docs/dev/todo-archive/plan.md`. A read-only
summary also reaches the web hub: `TodoWireResult.getTodoSnapshot()` → `projectTodo`
(`src/web-hub/agent/todo.ts`, 32-task cap / 240B description / 32KiB three-pass budget) rides
the optional `StatusInfo.todo` slot (append-only, no proto bump) to a collapsible `TodoPanel`
on the web detail header. Design: `docs/dev/todo-web/plan.md`.
