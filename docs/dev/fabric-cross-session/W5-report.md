# W5 — revive finished subagents on `wake:true`

Date: 2026-10-20. Branch: `dev`. Implements plan v3 §3.4/§3.7/§4.4/§4.5/§4.6, W5 row, §R1 #8/#9/#10, §R2, NQ2.
No commit, no stash. Quiet completion / subscribers / `wake_result` (W6) are NOT implemented; hook points are marked.

## Design → implementation

| Requirement                                              | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single revive entry (no `reviveDirect`)                  | `WakeService.revive(record, claimToken)` (`src/fabric/wake.ts`, `async revive`). Mailbox reaches it only through `FabricPorts.revive` (`src/fabric/mailbox.ts`, pump branch `record.wake === true`, `dispatchRevive`). The port exists only with wake on (`src/stack.ts` ports literal `...(level ? { revive } : {})`), so wake off keeps the legacy `target_gone` dead letter.                                                                                                                                                                                                                                                       |
| Synchronous ownership                                    | Everything before `spawn.spawn()` is sync and `spawn()`'s admission is sync, so the W3 reservation (`onResumeAdmitted`, trigger = the mailbox claim) is decided before the promise is handed back. Success ⇒ record is `pending+reserved`, the verdict handler sees "not owned" and only clears `inFlight` (defensive: still-claimed after `ok` ⇒ bounded retry).                                                                                                                                                                                                                                                                     |
| Wakeability from dispatch-time `diag.wakeExclusion`      | `WakeService.preflight` (`wake.ts`). Order: missing verdict ⇒ `legacy_unknown` (fail closed; park stays allowed); recorded exclusion (`consult_fork`/`readonly_domain`/`caller_owned`/`external_agent`); `no_session`; `worktree_gone` (kept + path exists, ONE `existsSync`, throw ⇒ gone); `unknown_type` (type missing/unrecorded/unregistered); `user_aborted` (`stopCause === "user_stop"`, Q6). Source = snapshot diag, else tombstone.                                                                                                                                                                                         |
| Exclusion written at admission                           | `spawn-service.ts` (after the wakeLevel block): only with `deps.inbox`, priority consult_fork > readonly_domain > caller_owned (`suppressDelivery`/`expectAck`/`callerOwned`) > external_agent > none; flows through `RunDisplayMeta` → `runtime-adapter.ts` displayMeta → reducer `enqueued` (`state-machine.ts`, write-once). Without `inbox` a forged value is stripped ⇒ wake-off diag bytes unchanged.                                                                                                                                                                                                                           |
| Q4 droid/external, workflow/goal/tidy                    | external via `admittedExternal`; goal verifier + tidy + nested blocking go through `spawnAndWait*` (`expectAck`) ⇒ `caller_owned`; workflow children have no such marker, so `createWorkflowChildSpawner` now sets the admission-only `callerOwned:true`.                                                                                                                                                                                                                                                                                                                                                                             |
| Evicted snapshot                                         | `Tombstone` (`tombstone.ts`) additionally keeps `agentType`, `userStopped`, `worktree{state,path}` — copied only together with `wakeExclusion` (wake-off tombstones identical). Stack now builds the `TombstoneStore` and shares it with SpawnService and WakeService. `wakeLevel` (prevFinal) was already read from it by `resolveResumeTarget` (W1).                                                                                                                                                                                                                                                                                |
| Hop gate (W1 levels)                                     | `WakeService.gate`: `level.hopAllowed(record.level)` ⇒ `level_limit`. The revived run's level is `max(origin+1, prevFinal)` by W1's spawn-service L4 (unchanged; tombstone fallback works).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Rate limits, wake:true = expensive                       | `WakeService.gate`: per-sender run quota (`perRunQuota`, shares one budget with the router's root wake count), `resumesPerHour`, `resumesPerTargetPerHour` (by session file). Counts are derived from the revived runs' persisted `diag.wakeOrigin` + `createdAt` (live registry ∪ replayed log), so a reload cannot reset them. `stats().resumesLastHour` is now real.                                                                                                                                                                                                                                                               |
| Pinned model + thinking before quota                     | `revive` passes `modelOverride: diag.model`, `thinkingOverride: diag.thinkingLevel` (validated against `THINKING_LEVELS`; absent ⇒ not pinned, nothing invented). spawn-service already derives `admittedModel = modelOverride ?? config.model` before `quotaGate`; pinned by `tests/service/spawn-wake-exclusion.test.ts`.                                                                                                                                                                                                                                                                                                           |
| Budget `resumeBudgetS*1000`                              | `WakeService.resumeTotalMs`: re-validates to 60..3600 (non-finite ⇒ 600), `clampSpanMs`, `timeoutPolicy:"fixed"` ⇒ `deadlineAt === enqueuedAt + 600_000` and `hardDeadlineAt === deadlineAt` (asserted on a real stack).                                                                                                                                                                                                                                                                                                                                                                                                              |
| Root-direct, no queueing                                 | no `parentRunId`; `poolFullPolicy:"reject"`, `loadPolicy:"reject"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Admission reason mapping                                 | `mapAdmissionReason` (`wake.ts`) + `reviveVerdict` (`mailbox.ts`): pool_full/load/quota/session_closing/resume_locked ⇒ **park** (`router.tryPark` ⇒ `parked.reason`, wake intent kept, sender receipt); inbox_persist_failed ⇒ retryable (attempts+backoff ⇒ `attempts_exhausted`); target_running ⇒ bounded retry; stack_closed ⇒ hold (pending, no charge, no spin); unknown_type/external_unavailable/config/uncoded ⇒ `wake_refused` dead letter with `deadLetter.detail`. A park that cannot be recorded (cap / stack-memory) never queues: temporary causes fall back to the bounded retry, hop/rate causes to `wake_refused`. |
| Sender told                                              | Admission-time (sync-knowable): `not_wakeable{reason}` (nothing queued, no seq spent) or `wake:false, wakeDowngraded:level_limit\|rate_limited` + parked (`router.ts`, `reviveGate`). Async park: `router.noteParked` sends a system `result` receipt to the sender (bounded by the sender's dead-letter quota; deliver-only `wake:false` when the sender is root).                                                                                                                                                                                                                                                                   |
| Coalescing                                               | Unchanged W3/W4: the mailbox checks `successorRoute` BEFORE the revive branch, so a second message to a reviving/revived chain waits then redirect-steers once (integration test). `revive` also defensively returns `park:resume_in_progress`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `@label wake:true` to finished run (replaces W1 interim) | `src/fabric/mention.ts`: explicit `wake:true` (with causal levels wired) admits through the router (revive path); omitted wake keeps legacy direct resume; `wake:false` unchanged (W3). Router's mention-gone guard now allows any explicit wake.                                                                                                                                                                                                                                                                                                                                                                                     |

## Deviations / choices (flag for the verifier)

1. **New `SpawnRequest.callerOwned`** (NOT_THREADED, admission-only) and `SpawnRequest.wakeExclusion` (NOT_THREADED; reaches diag via display meta like `dispatchMeta`). `wakeOrigin` stays NOT_THREADED (S0's test pins it): the adapter folds a claimToken-stripped copy into `RunDisplayMeta.wakeOrigin`. Plan §4.5 lists only four admission causes; workflow children needed a program marker to satisfy the task's "workflow-owned excluded".
2. **Per-sender quota is derived, not counted**: persisted `wakeOrigin.by` replaces a router counter (a hydrated counter cannot tell steers from revives). The router's own `wakeSent` still counts root wakes; the gate adds both.
3. **`rootWakes: 0` at revive time** (admission already counted them); the revive-time re-check covers hop/hour/target/own-revive counts (race-after-admission test).
4. **`target_running` is a bounded retry**, not an immediate successor reroute: the next pump's `successorRoute` takes over once a successor exists; an inconsistent registry cannot spin because attempts are charged.
5. **`user_aborted` = `stopCause === "user_stop"` only** (parent_abort/timeout/shutdown stay wakeable). Tombstone-only runs get this through the new `userStopped`.
6. A run whose diag has **no recorded model** is revived with the agent type default (cannot pin what was never recorded).
7. Park receipts are a W5 addition (task: "sender told parked"); they ride the existing system-record machinery and the dead-letter quota.
8. `ReviveVerdict`/`FabricPorts.revive(record, claimToken)` take the claim token (the plan's one-arg signature cannot bind the trigger).

## Notes for W6

- Subscriber hook: `WakeService.revive`, right after `"runId" in result` (`// W6 hook`), is where the trigger's sender is subscribed to the successor (admission already ran, the run cannot have finished). The trigger is also visible earlier in `onResumeAdmitted` (`a.trigger.sender`) if synchronous registration is preferred.
- Redirect-success hook (merged senders) remains in `mailbox.ts` `verdict()` ok branch (`redirect` in scope), as W4 noted.
- Quiet completion: revived runs are root-direct and carry `diag.wakeOrigin`; `DeliveryPayload.quiet` should key off that. Today the owner gets the normal `subagent:notification` (test: `delivers the result to the owner`).
- `router.noteParked` receipts are plain `result` records; W6's `wake_result` route should keep using a distinct `route.kind`.

## Tests

- `tests/fabric/revive.test.ts` (66): mapping table row-by-row + completeness; exclusion matrix incl. legacy fail-closed, worktree states, throwing probe, Q6, tombstone fallback; request shape (model/thinking pin, fixed budget, policies, wakeOrigin, root-direct, body not in prompt); budget validation table; every verdict (park×5 with receipt and no re-revive, refuse×3 with detail, retry×2 bounded, hold, throw); stack-memory and park-cap fallbacks; omitted wake unchanged; revive-time exclusion race; successor wins; admission gate (`not_wakeable`, level, per-run, hour window, per-target, race re-check, running target unaffected).
- `tests/service/spawn-wake-exclusion.test.ts` (12): exclusion matrix at real admission, forged value stripped with wake off, claimToken stripped, quota gate sees the pinned model, blocked pin leaves no run/owner.
- `tests/integration/fabric-wake-revive.test.ts` (7): REAL stack end-to-end (revive → pinned resume spec → `deadlineAt === enqueuedAt + 600_000` → trigger consumed `resume_injected` → owner notification); second message joins (one resume, one steer); legacy/user-stop/external refused; `session_closing` parks then a human resume carries it; wake-off golden-style check (no new diag keys, record dead-lettered as before).
- `tests/service/tombstone.test.ts`, `tests/fabric/mention.test.ts` extended; the old W1 interim mention test updated. Existing off-state golden `fabric-wake-off-golden` unchanged and green (fixture untouched).

## Verification (real output)

Node v22.22.1. Logs: `/tmp/w5-build.log`, `/tmp/w5-full.log`.

`npm run typecheck` (exit 0):

```
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

`npm run format:check` (exit 0): `All matched files use Prettier code style!`

Targeted: `npx vitest run tests/fabric tests/delivery tests/service tests/core tests/runtime tests/workflow tests/integration/fabric-wake.test.ts tests/integration/fabric-wake-revive.test.ts tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-wake-level.test.ts tests/integration/fabric-wiring.test.ts tests/conformance/fabric-wake.test.ts --maxWorkers=3` (exit 0):

```
 Test Files  156 passed (156)
      Tests  2836 passed (2836)
```

`npm run build` (exit 0): `tsc -p tsconfig.build.json`.

Full `npm test` (exit 0, no flake exemptions needed):

```
 Test Files  1233 passed (1233)
      Tests  23733 passed | 22 skipped (23755)
```

`git diff --check` clean. A supplementary strict `tsc` over the new test files (project typecheck does not include `tests/`) is clean.

## Exact changed paths

Source:

- `/home/bluecake/ai/pi-toolkit/src/core/message.ts`
- `/home/bluecake/ai/pi-toolkit/src/core/types.ts`
- `/home/bluecake/ai/pi-toolkit/src/core/state-machine.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/wake.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/mailbox.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/router.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/mention.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/spawn-service.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/runtime-adapter.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/request-threading.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/tombstone.ts`
- `/home/bluecake/ai/pi-toolkit/src/workflow/spawner-adapter.ts`
- `/home/bluecake/ai/pi-toolkit/src/stack.ts`

Tests / docs:

- `/home/bluecake/ai/pi-toolkit/tests/fabric/revive.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/helpers/fabric-revive.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/service/spawn-wake-exclusion.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-wake-revive.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/fabric/mention.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/service/tombstone.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/W5-report.md`
