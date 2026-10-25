# context-switch · 开发者要点

> 何时读：改动 `src/context-switch/**`、`switch_context` 工具、子会话 boundary 提交与 capability 状态机之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`context-switch-plan.md`、`../child-context-switch/`、`../compact-hint/README.md`

## src/context-switch/

`src/context-switch/` — model-authored context handoff: `handoff.ts` (validation + markdown
rendering + mechanical appendix), `store.ts` (TTL'd, consume-once pending slot), `hook.ts`
(`session_before_compact` returns `{ compaction }` so pi skips its summarizer and uses the model's
text verbatim; `firstKeptEntryId` is pi's cut point, or a sentinel that drops everything before it
for `keep_recent:false`), `session-facts.ts` (live runs / bash jobs / open todos / session file —
every port degrades silently). The mechanical appendix also carries an "in-service skills" reminder
(`skills.ts`): SKILL.md files touched or `/skill:xxx`-expanded within the dropped range (plus a bounded
optional `skills` param) are listed for re-reading — never injected — and the appendix stays
byte-identical when none are found. Tool surface: `src/context-switch/tool.ts`. Design:
`docs/dev/context-switch/context-switch-plan.md`. **Child-session switch_context** (child-context-switch
plan §2/§3, `src/context-switch/child.ts` + `capability.ts`): every child run is granted
`switch_context` (turn_end handler commits a boundary draft on top of `event.entries`), gated by a
process-wide runtime capability state machine — never pi's version — walking `unknown →
static-ok(L0 export probe) → observed(L1 turn_end shape) → ready(L2 zero-impact
`subagent:boundary-probe`commit probe: ok iff the probe's`sourceEntry`exists in the projection
with`messages.length === 0`, not "absent from entries") → verifying → verified(L3 first-use
self-check a/b/c)`; sticky per process, re-probed only on pi restart (any pre-`verified` L0-L3
failure disables immediately, a post-`verified` recheck disables only after 2 consecutive
uncommitted). All rejection reasons fold into `diag.contextSwitches.rejected[]` (FIFO cap 5),
readable from `get_subagent_result`.
