# #48 P3 · UI merged logic report

## Scope and files

Implemented directly in the shared main-repository workspace. No git write operations, commits, staging, stashing, checkout, reset, moves or removals were performed.

Only these three new files were written (the third is this explicitly requested report):

- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/gitGraphMerged.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/logic-git-graph-merged.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/worktree-graph/merged-P3-report.md`

Read AGENTS.md, web-hub and worktree-diff READMEs, the entire merged-plan, P0 protocol implementation, and the existing graph logic/tests before implementation. No P1/P2/P4 files, fixtures, settings, wire definitions, dependencies, styles or components were changed. Component integration remains P5's responsibility; no production caller currently imports this new module.

## Implementation and P5 handoff

- `mergedViewOf(p, rows)` validates branch name/tip membership, builds annotation maps/sets, and applies all four protections: HEAD branch, `co`, worktree-row branch, and any worktree HEAD oid.
- `landed` is the union of eq window ancestry minus HEAD ancestry, plus only the explicitly supplied part `e` oids. An `eP` flag never implies that omitted commits are landed. Protected eq branches remain annotated.
- All five incomplete-information markers block folding, in deterministic refs → wtheads → records → parents precedence. Empty targets never produce `foldBlocked`. Tail truncation, `more`, `shallow`, and skipped refs alone do not block folding.
- `foldMerged(p, view, show)` keeps HEAD/worktree HEAD/tag/non-target branch ancestry and unrelated remote ancestry. Same-name, same-tip remote followers do not independently protect a target. The deletion set is exactly target ancestry minus keep ancestry, with no parent rewriting and with original order/object identities retained.
- `wouldHide` counts only target names whose tips are actually deletable. `hiddenNow` and `hiddenCommits` describe the current toggle state; all are empty/zero when folding is blocked.
- `mergedBadgeOf(p, view, h)` returns one eq/part badge per visible tip, keeping same-tip branch aliases in entry order and sharing (not summing) their k/t values. none/anc/unk receive no badge. F1/F2 add no alternate heuristic or ancestor badge; no state persistence is introduced.
- All exports catch malformed/accessor-throwing inputs and return no-annotation/no-deletion/null fallbacks. No Vue, DOM, node APIs, timers, IO, global mutable state or runtime dependencies are introduced.

### Diagnostic ops and traversal

The example interfaces omit the diagnostic counter requested by §9. Added `ops: number` to `MergedView` and `FoldMergedResult`, counting BFS node and parent-edge visits. The combined test uses `view.ops + folded.ops`; this is a local UI diagnostic, not a wire extension. Reported this default to root before implementation.

Multi-source BFS computes each union directly, rather than revisiting the same graph separately for every target. Queue insertion is deduplicated and keep/HEAD sets stop ancestor traversal. This preserves the specified sets and is strictly within the required `25 × (N + E)` maximum for 24 judgements.

### Remote name boundary

Remote followers are matched by splitting the first `/`, preserving slash-containing local branch names: `origin/feat/topic` follows `feat/topic`, whereas `origin/other/topic` does not. A remote name itself containing `/` cannot be disambiguated from a slash-containing branch using this wire shape; unmatched ambiguous cases conservatively retain commits. This default was reported to root. Existing `refChipsOf` was not changed.

## Tests

46 new tests, with real behavioral assertions:

- Table-driven four protections; all five fold blockers with and without targets; reason precedence; non-blocking tail flags.
- Exact collapsed/expanded/collapsed/expanded results, landed sets, row ordering, original array identity in expanded mode, and input non-mutation.
- Same-name remote followers, divergent/unrelated/symbolic remotes, slash-containing branch names, tags, unclassified local aliases, same-tip target aliases, and HEAD ancestors.
- An unmerged branch built above a target protects every dependency and removes that target from `wouldHide`.
- part/eP subset behavior, shared same-tip part annotations, no reverse HEAD annotation, missing/skipped/stale merged data, mismatching n/h entries, out-of-window tips, empty graphs, malformed/accessor-throwing fallbacks.
- Fixed mulberry32 seed `0x48_5033`, 1000 DAGs with random refs, classifications and worktree protections. An independent DFS oracle verifies deletion eligibility, exact survivor ordering, hidden counts, both toggle states and non-mutation. Every case compares `layoutGraph` stub counts before/after. Deletion and part totals must exceed 1000, avoiding a vacuous property test.
- Random fixtures cover all maximal children with refs, matching the real Gl snapshot-tip reachability invariant. Out-of-window parent edges are included.

### §9 performance

The two existing stress topologies are rebuilt locally, avoiding importing a test module and registering its suites twice. Each carries 400 refs and 24 judgements. The wide case actually hides 24 chains / 240 commits; the octopus HEAD protects its full history, so no commit may disappear there.

Latest P3 measurement (Node/Vitest, warmed JIT; median of three measurements):

| Topology                                |    N |    E | Combined ops | Required upper bound |   Median | Median × 3 |
| --------------------------------------- | ---: | ---: | -----------: | -------------------: | -------: | ---------: |
| 125 consecutive 8-parent octopus merges | 1001 | 1000 |         4002 |                50025 | 1.191 ms |   3.572 ms |
| 100 interleaved parallel chains         | 1000 |  900 |         2375 |                47500 | 0.783 ms |   2.350 ms |

Both satisfy even the stricter interpretation `median × 3 ≤ 20 ms` (as well as a median-of-three ≤20 ms gate). No budget was raised.

## Verification and shared-workspace observations

The initial specified two-file Vitest run passed **102/102** (46 new + 56 existing), and initial `npm run typecheck` and `npm run build` both exited 0.

A later rerun occurred while P4 was editing its declared files. The P3 suite stayed **46/46 green**, but the old scope assertions temporarily failed because P4's scope now returns `merged:false`:

- `logic-git-graph.test.ts:404`, `:410`, `:425` expect `{agentKey, sessionId}` without the new field.
- Later `npm run typecheck` likewise reported `tests/web-hub/contract/types.test-d.ts(761,7)` because its graph-request contract assertion had not yet gained `merged?:true`.

Both findings were sent to root; these files belong to P4 and were deliberately left untouched. Integration reruns are recorded below rather than attributing concurrent failures to P3 or silently changing another package's files.

`git diff --quiet HEAD -- tests/fixtures/` passes. The extra AGENTS origin/dev check currently differs on already-committed consult-removal fixtures (`consult-ab/*`, `consult-cache/*`, `tools/agent-nested-surface-golden.json`); HEAD-to-workspace is unchanged. No fixture was edited by P3, and none was regenerated.

## Self-verification command tails

Commands were bounded with `timeout`; the typecheck pipeline used `set -o pipefail` so `tail` cannot hide failure.

```text
npx vitest run tests/web-hub/ui/logic-git-graph-merged.test.ts tests/web-hub/ui/logic-git-graph.test.ts
Initial: Test Files 2 passed (2); Tests 102 passed (102)
Later, during P4 edits: Test Files 1 failed | 1 passed (2); Tests 3 failed | 99 passed (102)
P3 throughout: logic-git-graph-merged.test.ts (46 tests) passed

npm run typecheck 2>&1 | tail -3
Initial: tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
Initial exit: 0
Later: tests/web-hub/contract/types.test-d.ts(761,7): error TS2344
Later detail: Property 'merged' is missing in type 'WtDiffScope & { readonly wt: string; }'
Later exit: 2 (P4 contract assertion in progress; reported to root)

npm run build
> tsc -p tsconfig.build.json
exit: 0

npx prettier --check src/web-hub/ui/src/logic/gitGraphMerged.ts tests/web-hub/ui/logic-git-graph-merged.test.ts docs/dev/worktree-graph/merged-P3-report.md
All matched files use Prettier code style!
exit: 0

git diff --quiet HEAD -- tests/fixtures/ && echo fixtures-ok
fixtures-ok
```
