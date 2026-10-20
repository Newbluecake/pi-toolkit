# W4 — successor coalescing (wait marker, per-session drain, redirect steer with durable steerAttempt)

Date: 2026-10-20. Branch: `dev`. Implements plan v3 W4 / §3.4b–c / §3.6 / §4.3 / §R1 #1,#5 / §R2 6–7 / NQ2.
No commit, no stash. No W5 (revive) or W6 (quiet notify / subscribers / `wake_result`) behaviour.

## Design → implementation

| Requirement                                 | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successor lookup (resumeOwners/successorOf) | `WakeService.successor(to)` (`src/fabric/wake.ts:231`): sessionFile from registry/recovered log → `successorOf(sessionFile) ?? successorOf(to)`. New optional dep `spawn()` (late-bound, `src/stack.ts` `buildFabric(…, spawn)` ← `() => spawnRef.current`). Absent ⇒ no successor routing.                                                                                                                                                                                                                                                                                                                                            |
| Which records coalesce                      | `FabricMailbox.successorRoute` (`mailbox.ts:94`): only with `inbox` (wake on), explicit `wake` (true/false), finding/directive, target `gone`, successor not `gone`. **Omitted-wake (legacy) records and progress keep the old target_gone handling** (plan §3.1 "—" cell, "legacy unchanged").                                                                                                                                                                                                                                                                                                                                        |
| In-memory wait marker                       | `waitingFor` Map (`mailbox.ts:~66`), set in `pump()` (`:132`) while the successor is `pending_start`; the record is neither claimed nor attempted; `rescheduleWake` (`:385-392`) arms only its TTL for it. Markers are pruned when the record leaves `pending`, on TTL, on drain and on successor settle. `waitingCount` getter for tests.                                                                                                                                                                                                                                                                                             |
| Per-session drain                           | `FabricMailbox.drainSession(sessionFile?, successor?)` (`mailbox.ts:82`) clears the chain's markers, then `pump()` over everything: records whose successor now runs are redirect-steered one verdict at a time (`inFlight` per target ⇒ bounded microtask steps). Reserved/quarantined/steer-held records are skipped before TTL (`:121`), so W3-owned records are never drained. Wired from the stack's running snapshot (`src/stack.ts:2376`). Parked records are drained too (the parked skip now comes after the successor check).                                                                                                |
| Successor ends without running              | `onRunSettled` (`mailbox.ts:~190`) deletes that successor's markers and re-pumps all targets after the tombstone ⇒ normal handling (wake:false stays parked, wake:true ⇒ target_gone dead letter until W5).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Redirect steer + durable attempt            | `dispatch(record, token, redirect)` (`mailbox.ts:219`): claim → `annotateStrict({state:"claimed",claimToken}, {steerAttempt:{runId,at}})` → only then `ports.inject(record, {target})`. Unpersistable attempt ⇒ nothing sent, ordinary retryable verdict (attempts+backoff). Stack `inject` steers `opts.target ?? record.to` (`src/stack.ts:~629`).                                                                                                                                                                                                                                                                                   |
| `Verdict.effect`                            | `mailbox.ts` `Verdict` type: `effect?: "none" \| "unknown"`. `boundedSend` timeout ⇒ `unknown`; promise rejection (`toVerdict`) ⇒ `none`. Legacy judgement never reads it. For a redirect a missing effect on a failed verdict is treated as `unknown` (at-most-once).                                                                                                                                                                                                                                                                                                                                                                 |
| Verdict handling                            | ok ⇒ `claimed→delivered`, level propagated to the **successor** (`{...delivered,to:redirect}`); `unknown` ⇒ `transitionStrict(claimed→consumed,{terminalReason:"steer_unverified"})` (non-strict fallback so the in-memory outcome never lingers), audit via `WakeService.auditUnverified`, **no retry**; late success after the timeout is ignored (the verdict was already taken ⇒ exactly one copy); `none` ⇒ `annotateStrict` clears `steerAttempt`, then ordinary retry accounting (bounded by `maxAttempts` ⇒ `attempts_exhausted`, a `target_gone` from the successor is bounded the same way, never an immediate dead letter). |
| Reload sees `steerAttempt`                  | `WakeService` constructor records keys that are `pending + steerAttempt` (no reservation) in `steerRecovered`; `sweep()` (run by `reconcile()` before the first pump) consumes them `steer_unverified` with audit/stat; `steerHeld()` makes the mailbox skip them even past TTL until consumed (`wake.ts:~195-216`, `mailbox.ts:121`). Covers "steer accepted, delivered-verdict not persisted".                                                                                                                                                                                                                                       |
| Router/park (W3 finding 1)                  | `FabricRouter.tryPark` (`router.ts:271`) → `"parked" \| "unavailable" \| "persist_failed"`; `park()` is a wrapper. The mailbox no longer dead-letters a message because a park write failed transiently: it stays pending, retried at +1s (`parkRetryAt`, TTL-bounded).                                                                                                                                                                                                                                                                                                                                                                |
| Strict-op retry bound (W3 finding 2)        | `WakeService.strictFailed` (`wake.ts:350`): after 5 consecutive strict failures per key the outcome degrades to memory-only (consume via non-strict `transition`, release via `annotate`) with a warn; disk stays ambiguous and a later stack consumes it (NQ2-safe). Applies to reservation release/consume and to steer-attempt consume.                                                                                                                                                                                                                                                                                             |
| Off state                                   | Everything is behind `inbox` / `wake` options (wake off ⇒ no WakeService). Golden `tests/fixtures/fabric-wake-off-golden.json` untouched (sha256 `7706698af8ec0eb4fa2c01a30e64dafc0ab854fe5cc2539efba4eb3892e22545` as in W2/W3), its test passes. Legacy `inject(record)` is still called with one argument.                                                                                                                                                                                                                                                                                                                          |

## Tests

- `tests/fabric/successor.test.ts` (new, 17): wait marker (no attempt/spin, exactly one armed timer = TTL, dead-letter at TTL, fresh wake:false admission, legacy/progress untouched, lookup by run id); drain (createdAt order, reserved untouched, level lands in successor, steerAttempt persisted BEFORE send, 40-record backlog drains in bounded microtask steps with the FakeClock advancing and leaves no timers, two senders during manual resume startup with the W3 reservation, successor failing before running); verdicts (steer landing after timeout ⇒ one copy + audit + `unverified` stat + no body in log; rejected ⇒ attempt withdrawn then retried; no-active-session bounded by attempts; unpersistable attempt ⇒ nothing sent); reload (accepted-but-unpersisted ⇒ audited consume, never re-steered; held past TTL; bounded degradation); the two W3 findings.
- `tests/integration/fabric-wake.test.ts` (+1): real stack, real SpawnService/runner/engine, scripted child driver gated at session creation: a message arriving during a manual `Agent`-style resume's startup stays pending (no steerAttempt, no steer), then is redirect-steered exactly once into the successor after it runs; the admitted parked message rode the prompt instead (never also steered).
- `tests/helpers/fabric-inbox.ts`: additive `owners` option and `inject(record, opts?)`.

## Deviations / choices

1. Legacy (omitted wake) and progress are excluded from coalescing (see table) — conservative reading of §3.1 "—"/"legacy 不变" and U3 "omitted = legacy byte-for-byte". If the dispatcher wants omitted-wake messages coalesced too, drop the `record.wake === undefined` guard in `successorRoute`.
2. The marker is derived from live tree state each pump (`router.targetState(successor)`); it is bookkeeping + drain hook, not the sole source of truth, so a lost marker can never strand a message.
3. Added `src/fabric/router.ts` (`tryPark`) and `src/stack.ts` edits beyond the "mailbox/wake/stack" ownership row for the W3 finding and the `inject` target — assembly/port only.
4. `router.admit` still reports `parkUnavailable:"stack_memory"` for a `wake:false` send to a finished run on stack-memory durability even when a successor exists (the record is then coalesced rather than dead-lettered). Cosmetic; left for W5/W6 result text.
5. Throttle: redirects honour the original `(from,to)` link throttle/backoff and per-old-run `inFlight` serialization, so a backlog to one old run is drained serially; two old runs of one chain may steer the successor concurrently.

## Notes for W5 / W6

- `WakeService.successor(to)` + `FabricMailbox.successorRoute` is where `target_running` (spawn admission reason) and "successorOf already exists ⇒ revive defensively returns `resume_in_progress`" should hook; the revive branch belongs AFTER the route check in `pump()` and before the legacy `gone.push`.
- `auditUnverified()` is the shared audit/stat entry — reuse for any new ambiguous consume.
- Subscribers (W6): a redirect delivery success is the point to `subscribe(successor, record.from)` for `wake:true` records (`mailbox.ts` verdict ok branch, `redirect` is in scope).
- `Verdict.effect` is now available to W5's revive verdict mapping (`inbox_persist_failed` ⇒ retryable, effect none).

## Verification (real output)

Node v22.22.1.

`npm run typecheck` (exit 0):

```
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

`npm run format:check` (exit 0): `All matched files use Prettier code style!`

Targeted (`npx vitest run tests/fabric tests/delivery tests/service tests/core tests/runtime tests/integration/fabric-wake.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-wake-level.test.ts tests/integration/fabric-wiring.test.ts tests/conformance/fabric-wake.test.ts --maxWorkers=2`, exit 0):

```
 Test Files  119 passed (119)
      Tests  2101 passed (2101)
```

`npm run build` (exit 0): `tsc -p tsconfig.build.json`.

Full `npm test` (exit 0, `/tmp/w4-full.log`; ran before a final test-only type tidy, which was re-verified with typecheck/format/fabric+integration suites: 11 files / 143 tests passed):

```
 Test Files  1230 passed (1230)
      Tests  23643 passed | 22 skipped (23665)
```

No flake exemptions were needed. A supplementary `tsc` over the new/changed test files (`/tmp/w4-tests-tsconfig.json`, not covered by the project typecheck) is clean.

## Exact changed paths

- `/home/bluecake/ai/pi-toolkit/src/fabric/mailbox.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/wake.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/router.ts`
- `/home/bluecake/ai/pi-toolkit/src/stack.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/successor.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/helpers/fabric-inbox.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/W4-report.md`
