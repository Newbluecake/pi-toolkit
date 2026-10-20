# W3 — durable parked inbox, reservation ownership and disposition

Date: 2026-10-20. Branch: `dev`. Implements plan v3 W3 / §3.5–§3.6 / §3.8 / §R2 3–6, 10–11.
No commit or stash. No W4 successor routing/redirect, W5 revive, W6 subscriber/result delivery, or Feishu changes.

## Design → implementation

| Requirement                                                               | Implementation / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finished finding/directive with `wake:false` parks in one admission write | `src/fabric/router.ts:193` stamps `parked:{at,reason:"wake_false"}` in the initial `put`, enforces the per-target cap and returns durability hints. `router.ts:264` handles a running→finished race or a later wake downgrade without resuming. Progress never parks.                                                                                                                                                                                                                                                                                               |
| Park is not a delivery attempt; TTL still dead-letters                    | `src/fabric/mailbox.ts:74` skips reserved/quarantined before TTL; `:82` skips parked only AFTER TTL. `:246` schedules parked records only at TTL. No reserved record is expired by the message TTL.                                                                                                                                                                                                                                                                                                                                                                 |
| Replace W1's interim finished `@label wake:false` refusal                 | `src/fabric/mention.ts` routes the finished deliver-only case into the router with its existing trusted mention authorization; omitted wake still uses legacy direct resume.                                                                                                                                                                                                                                                                                                                                                                                        |
| Claim-aware, persist-first reservation                                    | `src/fabric/wake.ts:98` calls S0's `reserveStrict`, using the trigger's exact claim token; successful triggers become `pending+reserved`, with no persisted claim token. It selects the same session-file chain, oldest parked records first, trigger plus at most eight total, excludes expired/conflicting/quarantined/reserved messages and frames the block with a host nonce.                                                                                                                                                                                  |
| Partial failure and quarantine                                            | `wake.ts:115` rolls back prior successes using strict annotation. A failed rollback sets memory-only `quarantined:true`; after a successful trigger rollback its original mailbox claim is restored before returning (failure to restore also quarantines); strict sweep consumes it with `reservation_quarantined` audit. Disk retains its reservation, so another stack consumes the missing-run ambiguity rather than replaying it. Ordinary human resumes continue without an inbox block after reservation failure; a trigger failure returns `persistFailed`. |
| Every resume admission, including ordinary Agent and legacy mention       | `src/service/spawn-service.ts:1083` strips caller-supplied `trackInput`, binds reservations before any label/tree/slot mutation or `start`, appends the block and sets the trusted flag only on success. No `wakeOrigin` is fabricated for ordinary resumes. Trigger failure releases both resume-owner keys and returns `inbox_persist_failed`.                                                                                                                                                                                                                    |
| Runner throws without a snapshot                                          | `spawn-service.ts:549` tracks whether any snapshot was published; `:572` invokes `onRunGone` only if none was. A later throw preserves the observed dispatch/acceptance evidence in the fallback terminal (`:590`) instead of inventing marker-free non-delivery proof. Off path unchanged.                                                                                                                                                                                                                                                                         |
| Ownership transfer does not strand `inFlight`                             | `src/fabric/mailbox.ts:177` checks ownership, then clears only the matching target/key slot when the claim has passed to a reservation or been terminated. Dispatch captures the original target, even if the record disappears. Both owned/unowned paths identity-check cleanup.                                                                                                                                                                                                                                                                                   |
| Live disposition                                                          | `wake.ts:157` commits immediately on `inputAcceptedAt` (zero is a valid timestamp); real terminal without dispatch, or `rejected_pre_accept`, releases. Attempted timeout/cancel/external-without-acceptance consumes as `resume_unverified`. Acceptance wins over failure/rejection. Parked causal level propagates without adding a hop.                                                                                                                                                                                                                          |
| Crash/reload disposition                                                  | `wake.ts:245` distinguishes raw terminal entries from journal-only/synthesized `restartInterrupted` snapshots. It never treats missing markers in a journal as proof of non-delivery, even if the seeded query view says terminal. No child transcript/file-content reads.                                                                                                                                                                                                                                                                                          |
| Live-file defer and fresh recheck                                         | `wake.ts:270` holds missing-terminal reservations when their session is still live; `:169`/`:275` recheck using one fresh `getBranch()` on `onReaped` or the unref'd 60s timer. No terminal after the recheck means audited consume, even if the file remains live. Dispose cancels timers.                                                                                                                                                                                                                                                                         |
| Bounded sweep before TTL                                                  | `wake.ts:174` handles at most 32 dispositions per invocation; mailbox calls it before candidate/TTL processing. Hard ceiling is registry `hardDeadlineAt + reapMs + 60s`, otherwise reservation time + 24h. `:188` supplies backlog, hard-bound and retry wake sources. Failed strict disposition retries after 1s without releasing/steering the record or spinning.                                                                                                                                                                                               |
| Persistence tiers and off-state                                           | `wake.ts:49` derives disk/session-memory/stack-memory from read-back + `getSessionFile()` capability, never filesystem existence. `src/stack.ts:534`, `:651`, `:675`, `:2191`, `:2297`, `:2360`, `:2476` assemble only under wakeOn and reconcile after query construction, before first pump. stack-memory park uses legacy target_gone plus `parkUnavailable:"stack_memory"`; session-memory gets `inboxDurability:"session-memory"`.                                                                                                                             |
| Audit/stats                                                               | Successful ambiguous/quarantine/expiry consumption logs `fabric inbox <reason>` with key/run only, never body, and increments `unverified`; historical consumed reasons are included on rebuild. No new lifecycle states or transition edges.                                                                                                                                                                                                                                                                                                                       |

## Behavior tests

- `tests/fabric/wake.test.ts`: park limits, exact TTL, progress, durability receipts, terminal race/downgrade, finished mention, trigger claim normalization, same-chain selection/max eight/exact-expiry exclusion, partial rollback/quarantine and restart, stale verdict identity and no spin, all live/recovery disposition rows, strict failure retry, live-file defer, onReaped/fresh branch, 60s timeout, hard bounds and 32-record backlog. Five named crash windows are independently filterable (`①|②|③|④|⑤`).
- `tests/service/spawn-inbox.test.ts`: synchronous hook order/owner visibility before runtime, prompt/flag threading, no fabricated origin, lock/label/slot cleanup on trigger rejection, human resume fail-open, forged-flag removal, no hook on new dispatch, early/late runner throw and successor cleanup.
- `tests/integration/fabric-wake.test.ts`: real stack + Agent tool + runtime/reducer + outbox; only the child driver is scripted (no network). An ordinary `Agent({resume})` and a legacy mention both carry parked messages and commit immediately on live acceptance. A REAL `SessionManager.inMemory` survives a stack rebuild with its parked record. Wake-off resume injects no block or markers.
- Existing S0 strict-engine tests and W1/W2 reducer matrix/property/conformance suites stay green. W3 adds no states, edges, reducer inputs, or engine changes.

## Implementation choices / deviations

1. Added `src/fabric/router.ts` / `src/fabric/mention.ts` edits, although omitted from the W3 file-ownership row: park must be stamped by the initial admission write and W1 explicitly left a finished-mention placeholder for W3. These are required W3 entry points, not W4 redirect/revive behavior.
2. The inbox hook executes slightly earlier than the illustrated plan seam: after resume-lock acquisition and budget resolution, BEFORE label/tree/slot writes. This avoids inventing rollback logic for those unrelated indices when trigger reservation fails, while remaining synchronous and strictly before `start`.
3. Added a 1s strict-disposition persistence retry wake. This closes the case where acceptance/terminal was the final snapshot and storage recovers later; no busy-loop or unbounded wait is added. No provider retry is involved.
4. With real `/reload`, the originating runner's `onReaped` closure belongs to the disposed OLD stack. The NEW stack's 60s fresh-branch fallback still converges safely; direct/current-stack `onReaped` is wired and tested. No new process-global listener/registry was introduced. This bounded fallback was reported to the dispatcher for a decision about any future shared reap signal.
5. No **new** synchronous filesystem reads were added. Existing SpawnService/resolveResumeTarget ownership/file-existence checks are unchanged. W3 admission and recovery inspect only in-memory entries/registry/marks; neither scans child files.
6. S0's `Partial<FabricRecord>` signature cannot directly express explicit `undefined` with exactOptionalPropertyTypes. A single typed clear-reservation patch uses S0's documented undefined-clearing semantics; no shared type widening was needed.
7. The existing admission-reason static guard counts one new rejection (29→30); its assertions remain strict. The immutable off-state golden fixture was NOT regenerated or edited.
8. S0 author consult confirmed that synchronous trigger re-claim after successful strict rollback preserves the engine contract and is necessary for bounded attempts/backoff. Added real-mailbox tests for retry exhaustion and failed restoration quarantine. This is a refinement of rollback ownership, not W5 revive behavior.
9. The real-memory-session integration is partial C-P5 evidence (retention + capability); the full independent conformance C-P5/remaining C-P3…5 gates still belong to G/W6 as planned.

## Notes for W4 / W5

- `WakeService` now owns only inbox reservation/disposition. It deliberately has no revive/preflight/subscribe APIs yet. Extend it, do not add a parallel reservation owner.
- `FabricMailbox`'s `inbox` option supplies `sweep`, `nextSweepAt`, `dispose`. W4 must add waitingFor/successor/drain logic before the terminal park branch, and skip reserved/quarantined in drain. Existing parked records currently wait for admission, never redirect-steer.
- `router.park(record, reason)` is a downgrade/race helper, not a revive implementation. It refuses progress or stack-memory, caps parked records and preserves `wake:true` on downgraded records. W5 should use its claimed→pending downgrade path, respecting the cap/result disposition.
- `onResumeAdmitted` is synchronous; the trigger is reserved using `wakeOrigin.trigger.key/claimToken` before `start`. After success the mailbox no longer owns that claim. Do not retry/inject the trigger from its eventual verdict.
- Trigger rollback restores its ORIGINAL memory-only mailbox claim synchronously after the strict reservation clear. W5 should return its normal retryable `inbox_persist_failed` verdict: existing mailbox attempts/backoff then remain owned (tested through three retries to exhaustion). Failed restoration quarantines instead. Do not replace this with an unowned pending trigger or undo the NQ2-safe quarantine behavior.
- Ordinary resumes must remain free of fabricated `wakeOrigin`; `trackInput` is only trusted after actual reservations. W5/W6 must preserve this distinction.
- Recovery's raw-entry fold is separate from seeded query state on purpose. A `restartInterrupted` terminal NEVER proves physical non-delivery. Live accepted evidence commits; journal-only acceptance is still an audited ambiguity on recovery.
- Existing claim-aware strict ops and transition table are unchanged. W4's `steerAttempt` persistence/reconcile policy is not implemented in W3.
- Recovered missing-terminal reservations may use the target's sessionFile when no successor journal exists; this is important for crash window ① plus live old-stack shutdown.

## Verification — real output

Node: v22.22.1. Long logs captured under `/tmp/w3-*.log`; shell pipelines use `set -o pipefail`, long commands are bounded by `timeout`. Concurrent Feishu changes were left untouched.

Initial gates caught an exact-optional clearing type mismatch, then a `number | ""` timer expression, and the expected static admission-branch count update. All were fixed, then the checks below rerun. No golden was changed to conceal a failure.

### Typecheck

`npm run typecheck` — exit 0 (`/tmp/w3-typecheck.log`):

```text
> pi-toolkit@0.6.3 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

### Build

`npm run build` — exit 0 (`/tmp/w3-build.log`):

```text
> pi-toolkit@0.6.3 build
> tsc -p tsconfig.build.json
```

### Targeted suites (including runtime, delivery, new integration, off-state golden and real-pi C-P1/C-P2)

```sh
npx vitest run tests/fabric tests/delivery tests/service tests/core tests/runtime \
  tests/integration/fabric-wake.test.ts tests/integration/fabric-wake-off-golden.test.ts \
  tests/integration/fabric-wake-level.test.ts tests/integration/fabric-wiring.test.ts \
  tests/conformance/fabric-wake.test.ts --maxWorkers=2
```

Exit 0 (`/tmp/w3-targeted-final.log`):

```text
 Test Files  118 passed (118)
      Tests  2083 passed (2083)
   Start at  20:54:02
   Duration  39.21s (transform 3.05s, setup 1.46s, collect 22.18s, tests 34.32s, environment 20ms, prepare 6.31s)
```

### Five crash windows

`npx vitest run tests/fabric/wake.test.ts -t '①|②|③|④|⑤' --maxWorkers=2` — exit 0 (`/tmp/w3-crash-windows.log`). Skips are due only to the explicit name filter:

```text
 ✓ tests/fabric/wake.test.ts (40 tests | 35 skipped) 12ms
 Test Files  1 passed (1)
      Tests  5 passed | 35 skipped (40)
   Start at  20:55:25
   Duration  677ms (transform 400ms, setup 52ms, collect 373ms, tests 12ms, environment 0ms, prepare 51ms)
```

### Off-state golden + matrix / seeded properties

`npx vitest run tests/integration/fabric-wake-off-golden.test.ts tests/core/core.test.ts tests/core/input-acceptance.test.ts --maxWorkers=2` — exit 0 (`/tmp/w3-golden-matrix.log`):

```text
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 22ms
 ✓ tests/core/core.test.ts (713 tests) 9038ms
 ✓ tests/core/input-acceptance.test.ts (32 tests) 589ms
 Test Files  3 passed (3)
      Tests  747 passed (747)
   Start at  20:43:57
   Duration  10.49s (transform 837ms, setup 116ms, collect 1.44s, tests 9.65s, environment 1ms, prepare 163ms)
```

Immutable golden SHA-256: `7706698af8ec0eb4fa2c01a30e64dafc0ab854fe5cc2539efba4eb3892e22545`.

### Formatting

`npm run format:check` — exit 0 (`/tmp/w3-format.log`):

```text
> pi-toolkit@0.6.3 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!
```

### Full suite

Final command: **`npm test` — exit 0**, after the final trigger-rollback refinement and concurrent Feishu commit `e01d992e` (`/tmp/w3-full-test-final.log`):

```text
 Test Files  1229 passed (1229)
      Tests  23624 passed | 22 skipped (23646)
   Start at  20:59:08
   Duration  261.79s (transform 28.84s, setup 15.72s, collect 275.74s, tests 1515.09s, environment 28.21s, prepare 66.58s)
```

The first `npm test -- --maxWorkers=2` finished with 1228 files passed / 1 failed (23621 tests passed, 22 skipped). Its sole failure was `tests/web-hub/hub/feishu/link.test.ts`, read between the concurrent author's test and source edits. The dispatcher confirmed that race was resolved by `e01d992e`; an independent isolated rerun passed 20/20 (`/tmp/w3-feishu-isolated.log`). No Feishu file was edited by W3. The clean final full run above needs no flake exemptions or isolated-pass substitution.

`git diff --check` passed. A supplementary TypeScript check of all four new test/helper modules also passed (`./node_modules/.bin/tsc -p /tmp/w3-tests-tsconfig.json`); this is in addition to the project's typecheck, whose include pattern does not cover these test files.

Outstanding scope note: the old-stack `onReaped` closure limitation in deviation 4 still uses the specified bounded 60s fallback after a real reload. W4/W5/W6 work is intentionally not implemented. Independent verifier acceptance remains with the dispatching session.

## Exact changed paths (W3 only)

- `/home/bluecake/ai/pi-toolkit/src/fabric/wake.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/router.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/mailbox.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/mention.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/spawn-service.ts`
- `/home/bluecake/ai/pi-toolkit/src/stack.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/mention.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/helpers/fabric-inbox.ts`
- `/home/bluecake/ai/pi-toolkit/tests/service/spawn-inbox.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/service/admission-reason.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/W3-report.md`
