# P6B boundary tests — implementation report

Base: `dev@85cf78bb`. Specification: `plan-lowrisk.md` r2.1 §4.2, §4.4, §5 and Appendix A.

## Delivered files

- `/tmp/pi-subagent-worktrees/r_6V1HWJ8A/tests/boundary/pi-free.test.ts`: B1 TypeScript AST scanner, the 13 required syntax self-tests plus 10 additional AST cases, and four repository boundary checks. Core, prompt-sections and git include type edges; memory follows only value edges, rejects pi types on its four roots, and rejects unresolvable imports throughout the visited closure. File discovery uses globs with nonempty-root assertions, without frozen file counts.
- `/tmp/pi-subagent-worktrees/r_6V1HWJ8A/tests/web-hub/boundary.test.ts`: B2 settings type-only admission and two predicate cases; B3 agent glob union the uniquely existing capture candidate, resolved-path admission, coverage assertions and five predicate cases.
- `/tmp/pi-subagent-worktrees/r_6V1HWJ8A/docs/dev/source-governance/P6B-report.md`: this report, the explicitly authorized sole file-domain exception.

The existing web-hub regex scanner and all three closure tables remain byte-identical, including the settings row in `SYSLOAD_FILE_CLOSURE`. Its known `import { type X }` overclassification remains the stricter behavior described in plan R9. No source, fixture or other test change is delivered. No dependencies were added.

## Mutation verification

Each mutation ran in isolation through `npx --no-install vitest run <suite> -t <title>`. The suites were `tests/boundary/pi-free.test.ts` (B1) and `tests/web-hub/boundary.test.ts` (B2/B3); titles selected the indicated repository assertion. Each negative check failed in the expected boundary assertion, rather than in module loading or compilation. Source bytes were backed up before each change and restored in `finally`.

| Plan item          | Temporary change / selected assertion                                                                                     | Actual result                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1                  | Add `import type {} from "@earendil-works/pi-coding-agent"` to `src/core/format.ts`; `core/ imports`                      | Exit 1: `src/core/format.ts → @earendil-works/pi-coding-agent`; 1 failed, 26 skipped          |
| 2a                 | Add ``await import(`node:fs`)`` to `src/core/format.ts`; `core/ imports`                                                  | Exit 0: 1 passed, 26 skipped                                                                  |
| 2b                 | Add ``import(`${x}`)`` to `src/core/format.ts`; `core/ imports`                                                           | Exit 1: `src/core/format.ts → unresolvable: ${x}` (template expression); 1 failed, 26 skipped |
| 3                  | Change the `LoadSettings` import in `src/web-hub/hub/load.ts` from `import type` to `import`; `protocol/hub imports stay` | Exit 1: `src/web-hub/hub/load.ts → "../../config/settings.js"`; 1 failed, 19 skipped          |
| 4                  | Add `import "../core/clock.js"` to `src/git/diff.ts`; `git/ imports`                                                      | Exit 1: `src/git/diff.ts → ../core/clock.js`; 1 failed, 26 skipped                            |
| 5, old layout      | Add `import "../hub/registry.js"` to `src/web-hub/agent/command-capture.ts`; `agent-side files`                           | Exit 1: old capture path → registry, `typeOnly=false`; 1 failed, 19 skipped                   |
| B3 migration check | Temporarily move the capture file to `src/commands/capture.ts`, without retaining the old candidate; `agent-side files`   | Exit 0: 1 passed, 19 skipped                                                                  |
| 5, new layout      | In that temporary new layout add `import "../web-hub/hub/registry.js"`; `agent-side files`                                | Exit 1: new capture path → registry, `typeOnly=false`; 1 failed, 19 skipped                   |

The new-layout check verifies B3's discovery and admission under both candidate locations; it does not claim to implement or validate the unrelated P6M import rewrites. The file was moved back after the check. `git diff --exit-code -- src` returned 0 after all mutations. No mutation remains in the deliverable.

## Verification tails

`npx vitest run tests/boundary tests/web-hub/boundary.test.ts`:

```text
Test Files  2 passed (2)
     Tests  47 passed (47)
```

`npm run typecheck 2>&1 | tail -3` (executed with `pipefail`; exit 0):

```text
> pi-toolkit@0.8.1 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

`npm run build` (exit 0):

```text
> pi-toolkit@0.8.1 build
> tsc -p tsconfig.build.json
```

`npx prettier --check tests/boundary/pi-free.test.ts tests/web-hub/boundary.test.ts docs/dev/source-governance/P6B-report.md`:

```text
Checking formatting...
All matched files use Prettier code style!
```

`git diff 85cf78bb -- tests/fixtures | wc -l`:

```text
0
```

`git log --oneline 85cf78bb..HEAD` and the post-commit clean-status check are included in the final delivery, since the commit containing this report does not exist until after the report is written.

## Environment and remaining work

The worktree initially lacked `node_modules`. The first plain npx test attempt tried to acquire vitest and failed with npm `ENOTEMPTY`, before any tests ran. No `npm install` was run. Subsequent checks used the user's authorized temporary link to `/home/bluecake/ai/pi-toolkit/node_modules`, removed before delivery. No shared dependency contents were edited.

This is developer self-verification. Independent verification by a different model remains the root session's next workflow step. Full-repository tests and real-loader gates belong to the root integration/P6M checks in §5/§4.4; this test-only package ran its specified targeted tests, typecheck and build.
