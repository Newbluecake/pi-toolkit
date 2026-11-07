# Tool prompt slimming (#74, conservative tier)

Goal: shorten the model-visible tool text without changing behaviour. A-tier goldens under
`tests/fixtures/` are untouched, so everything that touches a frozen surface was skipped.

## Method

Size = `JSON.stringify({description, promptSnippet, promptGuidelines, parameters}).length` per tool. A temporary
test ran a real `activate()` on a fake pi with the `max` profile of `tests/governance/trace-profiles.ts`, dumped
every registered tool, and was deleted afterwards. That profile registers 25 tools (the audit counted 24).

## Before / after (characters)

| tool                    |    before |     after |     delta |
| ----------------------- | --------: | --------: | --------: |
| web_search              |      1785 |      1785 |         0 |
| TaskCreate              |      1204 |      1158 |       -46 |
| TaskList                |       597 |       510 |       -87 |
| TaskGet                 |       247 |       247 |         0 |
| TaskUpdate              |      1120 |      1028 |       -92 |
| TaskDelete              |       307 |       307 |         0 |
| memory                  |      1512 |      1512 |         0 |
| ask_user                |      6252 |      4496 |     -1756 |
| schedule                |      3695 |      3695 |         0 |
| list_sessions           |      1103 |      1062 |       -41 |
| message_session         |      2465 |      2465 |         0 |
| message_channel         |      1252 |      1252 |         0 |
| Agent                   |      6947 |      6749 |      -198 |
| get_run_result          |      2617 |      2348 |      -269 |
| list_subagents          |      1375 |      1196 |      -179 |
| steer_subagent          |      1625 |      1625 |         0 |
| set_model               |      2134 |      1967 |      -167 |
| abort_subagent          |       857 |       857 |         0 |
| extend_subagent_timeout |      1777 |      1777 |         0 |
| switch_context          |      3269 |      3269 |         0 |
| compact_context         |      1732 |      1732 |         0 |
| set_compact_threshold   |      1563 |      1563 |         0 |
| bash                    |      3203 |      3203 |         0 |
| bash_job                |      2999 |      2999 |         0 |
| SubagentWorkflow        |      7127 |      6364 |      -763 |
| **total (25 tools)**    | **58764** | **55166** | **-3598** |

Net effect: the prompt-cache prefix of every session MISSES once after this ships (tool declarations changed).

## What changed

- **ask_user** (-1756): header ≤12, "Other", skipped:true and dismissParked were stated 2–3 times each. Each now lives
  in one place: the parameter descriptions own the header and "Other" rules and the `dismissParked` mechanics; the
  tool description owns skipped:true and the "when to dismissParked" rule. `promptGuidelines` went from 9 entries to
  the 2 that carry unique content (the over-asking warning; gather context + batch). The "Don't" list keeps only the
  flattening item. The "(Recommended)" rule is now only in the description (it was also in the label parameter).
  `tests/ask-user/prompt-quality.test.ts` EXPECTED_* were updated, and its assertions now check each contract at its
  new home (options param: "never a bare string" and 'Other'; header param: `<=12 chars`; description: skipped /
  dismissParked; dismissParked param: "Cannot be combined with questions").
- **SubagentWorkflow.script** (-763): compressed isolationReplay semantics, the did-you-mean enumeration and the
  model rule. Kept: the 7-key opts whitelist, 512 KiB, Date.now/Math.random/eval disabled, the pipeline stage
  signature, worktree isolation outcomes.
- **Agent.meta** (top-level only; nested golden has no `meta`): descriptions shortened (-198).
- **get_run_result** (-269): the "wait blocks the user" explanation now lives only on the `wait` parameter;
  "(Formerly named get_subagent_result.)" kept (pinned by tests/boundary/result-tool-residue.test.ts).
  `tests/tools/model-facing-strings.test.ts` was adjusted in two places with the same intent: the wait-blocks-input
  consequence is asserted on the `wait` parameter (the description now points there), and the `meta` description string.
- **set_model.model** (-167): the prefix rule is referenced to the Available models section instead of repeated.
- **list_subagents** (-179): dropped the `recent` sentence that repeated the parameter and the "same accounting as…" aside.
- **Task\*** (-225 across 3 tools): the shared dependency-id description `Task IDs such as ["1","2"].` (emitted
  6 times) is now `Task IDs.`; `includeCompleted` no longer re-explains the footer already in the TaskList description.
- **list_sessions** (-41): alias suffix no longer repeats "prefer it when the user names a session" (message_session says it).

## Finding: the string-options "contradiction"

The ticket premise was that the "Don't: pass options as a string array" line contradicts the schema. The schema
does accept strings (`Type.Union([OptionSchema, Type.String()])`) but only so that `validate.ts` can return a
useful correction: at runtime a bare string option is **rejected** ("must be an array of {label, description}
objects, not strings"). So the "must be objects" wording was behaviourally true, not wrong. It is now stated once, in
the `options` parameter description ("each must be a {label, description} OBJECT, never a bare string"), and
removed from the description's Don't list.

## Skipped (pinned by A/B-tier goldens or frozen surfaces)

- bash, bash_job: `tests/fixtures/bash-tools-golden.json`.
- Agent shared `leadingFields`, DESCRIPTION_HEAD/TAIL, `timeout_s`, `isolation`: `agent-nested-surface-golden.json` (FROZEN).
- message_session reply-off variant and list_sessions base description: `fabric-xs-reply-off-golden.json`.
- message_session alias suffix (`aliases are unique on this hub`): pinned by `tests/integration/fabric-xs-alias-wiring.test.ts`
  and conformance C-X11; the saving (~50 chars) was not worth touching it, so only the list_sessions side was trimmed.
- `Agent.model` (shared field), web_search, memory, schedule, steer/abort/extend, switch/compact tools: out of scope.

## Verification

See the commit message / final run: typecheck, vitest (ask-user, tools, workflow, fabric, todo, integration),
`npm run test:conformance`, `format:check`, and `git diff --quiet HEAD~1 -- tests/fixtures/`.
