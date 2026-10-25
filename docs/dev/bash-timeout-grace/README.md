# bash 自动后台 · 开发者要点

> 何时读：改动 `src/bash/**`、`bashJobs.*` 设置键、`bash_job` 工具之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`./`（本目录其它文档）、`../bash-auto-background/`、`../bash-jobs-session-isolation/`

## src/bash/

`src/bash/` — bash auto-background: the same-name `bash` override, `BashJobManager` (spawn →
log tee → settle → notify → recover after restart), persisted job store. POSIX only; when the
setting is off, pi's built-in bash stays untouched. Job-level timeout grace (`bashJobs.timeoutGraceS`,
`maxExtensions`, `maxTimeoutFactor`; pure arithmetic in `src/bash/deadline.ts`) lets a background job
with an explicit `timeout` enter one grace-window notice instead of dying outright, extendable via
`bash_job(action:"extend")`. Child (subagent) sessions additionally get `src/bash/child.ts`
(`wireChildBashJobs`, lazily built per session, not on `session_start`): an `agent_before_settle`
settle-hold keeps a run with non-terminal jobs alive across bounded reminder rounds
(`bashJobs.childSettleHold`, `childSettleHoldMaxRounds` — `0` auto-derives the cap from the run's own
deadline/extension budget plus outstanding job grace, §3.5's `R_wait`/`G0`). Design:
`docs/dev/bash-timeout-grace/plan.md`.
