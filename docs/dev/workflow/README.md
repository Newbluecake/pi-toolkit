# SubagentWorkflow · 开发者要点

> 何时读：改动 `src/workflow/**`、`workflow.*` 设置键、`SubagentWorkflow` 工具、workflow 的 agent()/journal/replay/worktree 之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`../workflow-background/`、`../workflow-agent-queue/`、`../workflow-experts/`（已随 #40 移除）、`../workflow-worktree/`

## src/workflow/

`src/workflow/` — `SubagentWorkflow` engine: orchestrator, journal/replay, runaway detection, and the per-stack
background registry (`background.ts`: start → bounded run/stop/settle with degraded fallback so every workflow
reaches a terminal entry, `stop`/`wait`/`resolve`, bounded terminal retention, `shutdown`/`drain`/`seal` on
session_shutdown and `abandon` on a defensive rebuild). Completion notices are pi-facing
(`src/adapters/workflow-notice.ts`: `sendMessage` + `triggerTurn` while live; persisted `subagent:workflow-notice`
entry during shutdown, re-delivered once by the next stack on that session file). `agent()` calls beyond `maxParallel`
FIFO-queue instead of failing (host acks first, then queues; non-time-exhausted dispatch failures reject the script's
`agent()`; out-of-time while queued ⇒ withheld `null`; a worker-wide `unhandledRejection` is reported as `stage_error`
`source:"unhandled"`, never `worker_died`); `agent()`'s `opts.model`/`opts.thinking` are real per-call overrides
(Agent-tool `model`/`thinking` semantics — strict `provider/id` vs fuzzy-hint split via `parseStrictModelRef`, unknown
model ⇒ dispatch-failure reject with suggestions; both fields join the journal taskKey so a model swap never replays
the old result); workflows share the subagent timeout grace + extension machinery
(`deadline.ts`: pure deadline controller, `killAt()` bounds host calls/BW2/gate; `extend_subagent_timeout` accepts `wf_…`
ids — full/prefix/script name — and refuses a workflow's children, which are pinned to the workflow `hardAt`;
an
explicit `timeout_s` follows the same grace/extension rules as the default budget — `hardAt = start +
max(ceil(f·workflowTotalMs), workflowTotalMs + maxExtensions·extendStepMs)` with the base `maxTotalFactor` preserved
(`extendStepMs` reused from `settings.budget`, same 「每次延长最多 1h」 ruling; per-grant cap applies to `extend()` too)
— while the workflow's children stay
fixed-deadline). `agent(prompt, opts?)` opts are strictly validated (`agent-opts.ts`: only
`label`/`agentType`/`phase`/`fullResult`/`model`/`thinking`/`isolation` — any other key, a non-plain-object
`opts`, or an accessor/Proxy/function-valued known key rejects with the full allowed-key
list and a mistaken-key hint (`opts.experts` gets a dedicated "removed (#40), use message_agent" rejection); the worker (`worker-source.ts`) takes its own structural snapshot first and never
`postMessage`s an unclonable value — host.ts re-snapshots independently and either side's defect wins).
`agent(prompt, { isolation: "worktree" })` (workflow-worktree plan, packages P1/P2) now
really isolates that one call in its own git worktree (built from the current HEAD by the same H2/H3 extension
the top-level `Agent` tool uses) instead of only marking the journal entry: `ChildSpawner.worktreeAvailable()`
(stack.ts wires it to `worktree.enabled`, no fallback) gates admission (`isolation_unavailable` reject, never
journaled, never taints); an accepted isolation call taints the rest of the run's replay chain (the only chain-taint trigger),
and is itself never journaled/replayed (`replay.ts`'s `isolation` input, checked before
`configHashAvailable`/lookup). The host waits up to `min(remainingWorkflowMs(), worktreeSettleMaxMs)` for H3's
disposition before settling (`worktree:{state}` on the settle envelope and in `fullResult`'s extra `worktree`
key — the only new key, and only for an isolated call); a give-up settles `pending` (frozen, the worker never
hears about it again) while an unbounded "late" listener keeps waiting in the background and folds a real
disposition into `WorkflowChildSummary.worktreeFinal` (never mutating the frozen `worktree` field) — visible on
a `children` read taken after it arrives. A workflow stop/timeout force-settles a still-bound isolated call as
`aborted` + `worktree:pending` while H3 keeps committing in the background (D7 — same "no orphan" contract as a
top-level `Agent`). `SubagentWorkflow`'s outcome text/notification carry a self-bounded `worktrees:` block
(64 lines / 8 KiB, `git branch --list 'pi-agent-*'` pointer beyond that) spliced in _outside_ the head/tail-
truncated body, so branches survive truncation. The workflow never merges branches itself — that is the
dispatching session's job, same as for a top-level isolated `Agent` run. **replay-verify (P2, todo #13,
`workflow.isolationReplay`, default `"verify"`)** narrows the P1 "never journaled/replayed" rule above: a
`committed` (with sha) or `clean` isolated call's outcome is now journaled, and on a later run with the same
journal it replays IF AND ONLY IF its `pi-agent-<runId>` branch, checked once at load time via a single
bounded `git for-each-ref` (`src/workflow/isolation-verify.ts`, pinned cwd, `AbortSignal` + `withDeadline`
triple-bounded, zero git calls when there is nothing to verify), still points EXACTLY at the recorded commit
(`clean` entries are never checked — same non-checking semantics journal replay already has for every
ordinary call). In `chain` scope an accepted isolated call no longer taints the rest of the run; instead its
live-run identity (`isoId`) folds into the chain digest (`host.ts`'s F1/F2), so a verified hit reproduces the
exact fold the upstream live run applied and the whole downstream chain can hit too — `content` scope and
`isolationReplay:"off"` keep the old unconditional taint. A terminal, diagnostic-only recheck (running
concurrently with the journal flush, never gating it) annotates a replayed child's summary with
`replayStale:"gone"|"moved"` if its branch was moved/deleted between the load-time snapshot and settle —
it never revises the settle the script already received. Design: `docs/dev/workflow-worktree/replay-verify-plan.md`.
**todo #21**: `buildJournalConfig`'s pre-boot `store.load()` is bounded by `WorkflowRunBudget.journalLoadMs`
(default 5s); a timed-out load degrades that run to fully live and skips writing the journal (`WorkflowOutcome.replay.loadError`), never fails the run.
Design:
`docs/dev/workflow-background/plan.md`, `docs/dev/workflow-agent-queue/plan.md`, `docs/dev/workflow-experts/plan.md` (removed with #40; historical),
`docs/dev/workflow-worktree/plan.md`.
