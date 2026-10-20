# W2 — input acceptance markers

Date: 2026-10-20. Branch: `dev`. Implements plan v3 §3.5 / §4.7 / §8 W2 / §R2 item 2.
No commit, stash, park/reservation implementation, or W3+ wiring.

## Design → implementation

| Requirement                                                      | Implementation / evidence                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ephemeral opt-in copied from the resolved request                | `src/core/types.ts:1638` (`RunState.trackInput?: true`); `src/core/state-machine.ts:280`; `src/runtime/runner.ts:751`. The off path adds no state key. The flag is not journaled.                                                                                                                                                                                                                                                                |
| Attempt started before handing off the prompt                    | `src/core/state-machine.ts:858` writes `promptDispatchedAt` once on `phase_entered{prompt_dispatch}`. Existing synchronous runner dispatch is at `src/runtime/runner.ts:1099`, before the call at `:1110`. Runtime tests assert the marker from INSIDE `handle.prompt()`.                                                                                                                                                                        |
| Acceptance is a separate linearization point                     | `src/runtime/session-driver.ts:988` emits additional `input_accepted` for pi `message_end{role:user}`; existing `message_end`, usage and context sampling remain intact. `src/runtime/runner.ts:940` routes it to a dedicated reducer input only when tracking is enabled.                                                                                                                                                                       |
| Conditional, write-once evidence; no effects or liveness refresh | `src/core/state-machine.ts:755`: `inputAcceptedAt` writes once; rejection writes only without acceptance or `lastTurnStartAt` (zero is not absence). Both new inputs ignore terminal states and the off path. Stale-generation handling remains upstream.                                                                                                                                                                                        |
| Synchronous / asynchronous prompt rejection                      | `src/runtime/runner.ts:1106` converts a synchronous tracked-driver throw to a rejected Promise without changing the off path's call shape; `:1128` emits `prompt_rejected` only for a guard error, before existing settle logic. Timeout/cancellation never generate this proof.                                                                                                                                                                 |
| Matrix and property tests move in lockstep                       | `src/core/state-machine.ts:243` adds all three S0 input kinds, including W1's `wake_level`, to `INPUT_KINDS`. `tests/core/core.test.ts:1409` asserts 12 × 17 = 204 cells. Both its comprehensive random generator (`:2016`) and existing 200-seed generator (`:2332`) cover the new kinds. `tests/core/input-acceptance.test.ts:96` adds 200 mixed tracked/untracked sequences with first-write, terminal-freeze and rejection-guard assertions. |
| Crash evidence survives serialization                            | `tests/core/input-acceptance.test.ts:140`: reducer-produced before-dispatch / attempted / accepted / rejected states → JSON journal → interrupted terminal rebuild → seeded store. Each field's presence AND absence is checked independently. A real temporary session file satisfies the normal seed admission check. Existing S0 journal/terminal/tombstone tests remain green.                                                               |
| Driver role mapping and runtime behavior                         | `tests/runtime/session-driver.test.ts:695`; `tests/runtime/runner-input-acceptance.test.ts`: Promise rejection, synchronous throw, long create + delayed acceptance, accepted then provider failure / rejection, turn-start-only failure, timeout, cancel, startup timeout, off path and external ambiguity.                                                                                                                                     |
| Real-pi peer-upgrade contracts                                   | `tests/conformance/fabric-wake.test.ts:51` (C-P1: a persisted session is resumed through `PiSessionDriver.resume`; only its NEW user prompt produces acceptance); `:108` (C-P2: invalid/missing selected model rejects before any turn/user event or provider call). Both drive the real runner, pi session, event mapper and terminal persistence.                                                                                              |

## Gating, consult and external runs

- The trusted runner flag is `trackInput`; W3 must set it only under `wakeOn = fabric.enabled && fabric.wake.enabled` and only for bound reservations. W2 does not invent a new settings read, set the flag at admission, or manufacture `wakeOrigin` for ordinary resumes.
- A default consult run has no tracking flag and therefore no W2 diagnostic writes. A deliberately tracked pi consult uses the same new-prompt user-event evidence as any pi session; prior fork history is not accepted as new input. No consult tool table, guard, identity or request prefix was changed.
- External/droid adapters do not have pi's acceptance/rejection event contract. W2 still records an attempted dispatch when explicitly tracked, but **does not synthesize `inputAcceptedAt` from `turn_start`, a successful prompt result, or a generic `message_end`**. It also skips `prompt_rejected` for `req.external` so a foreign rejection cannot become false proof of non-delivery. Missing evidence after an attempt remains ambiguous under NQ2 (at-most-once), including external runs that complete successfully without an explicit acceptance event. No external adapter changes were made.
- Acceptance evidence emits no new persist/journal effect. Terminal snapshots carry it; an existing shutdown flush may capture it. A journal-only crash remains ambiguous, even if its last recorded fields omit acceptance.
- The unchanged off-state golden passed. Its fixture remains unmodified; SHA-256: `7706698af8ec0eb4fa2c01a30e64dafc0ab854fe5cc2539efba4eb3892e22545`.

## Small implementation choices / deviations

1. The file ownership row assigns `types.ts` to S0, but §4.7 explicitly requires `state.trackInput`; S0 had declared only the request/diag/event contracts. W2 adds the necessary **two-line ephemeral RunState field**, with no other shared contract change.
2. Additional driver emission is in `PiSessionDriver.bind` immediately after `mapEvent`, rather than changing the single-event `mapEvent` return signature. This preserves every existing caller and the legacy `message_end` mapping while emitting both events as required by §4.7.
3. Foreign prompt rejections are deliberately not certified as `rejected_pre_accept` (see external behavior above). This is the NQ2-safe refinement requested for adapters without pi's event contract.
4. C-P1/C-P2 use the repository's existing real-AgentSession/scripted-provider harness rather than an external model or network. C-P2 tests pi's documented **missing selected model** preflight, not every possible unknown registry ID/provider error. No opt-in is needed because no live provider is contacted.
5. C-P1 emits the existing `child_extension_missing` diagnostic: the conformance harness intentionally does not activate pi-toolkit inside its child resource loader. This does not affect the pi event contract or test assertions. No diagnostic was suppressed.

## Verification (real command output)

Node: `v22.22.1`. All required gates passed on this working tree. Long logs were captured with `tee` and piped through `tail`; `set -o pipefail` preserved failures. The initial focused run exposed test-fixture issues (missing seed session file, startup timeout status, nonexistent `Agent.setModel` API); those were corrected to use a real temporary file, `timed_out`, and public `Agent.state.model`, then rerun successfully. No production workaround was added for them.

### Typecheck

Command: `npm run typecheck` (exit 0).

```text
> pi-toolkit@0.6.3 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

### Formatting

Command: `npm run format:check` (exit 0).

```text
> pi-toolkit@0.6.3 format:check
> prettier --check .

Checking formatting...
All matched files use Prettier code style!
```

### Targeted suites, new tests and off-state golden

Command: `npx vitest run tests/core tests/runtime tests/service tests/fabric tests/conformance/fabric-wake.test.ts tests/integration/fabric-wake-off-golden.test.ts` (exit 0).

```text
 ✓ tests/integration/fabric-wake-off-golden.test.ts (2 tests) 23ms
 Test Files  105 passed (105)
      Tests  1912 passed (1912)
   Start at  19:55:30
   Duration  23.17s (transform 2.90s, setup 2.35s, collect 22.29s, tests 33.87s, environment 18ms, prepare 5.89s)
```

### C-P1 / C-P2 subset via project script

Command: `npm run test:conformance -- -t 'C-P[12]:'` (exit 0). The 247 skipped tests here are excluded by the name filter, not disabled or failed tests.

```text
 ✓ tests/conformance/fabric-wake.test.ts (2 tests) 153ms
 Test Files  1 passed | 21 skipped (22)
      Tests  2 passed | 247 skipped (249)
   Start at  19:55:11
   Duration  5.84s (transform 7.48s, setup 719ms, collect 26.37s, tests 153ms, environment 4ms, prepare 1.18s)
```

### Build

Command: `npm run build` (exit 0).

```text
> pi-toolkit@0.6.3 build
> tsc -p tsconfig.build.json
```

### Full suite

Command: `npm test` (exit 0). No isolated load-flake rerun was necessary.

```text
 Test Files  1223 passed (1223)
      Tests  23530 passed | 22 skipped (23552)
   Start at  19:57:30
   Duration  259.74s (transform 27.37s, setup 15.84s, collect 270.91s, tests 1516.63s, environment 27.07s, prepare 65.86s)
```

`git diff --check` passed. Full logs for this run: `/tmp/w2-typecheck.log`, `/tmp/w2-format-final.log`, `/tmp/w2-build.log`, `/tmp/w2-targeted.log`, `/tmp/w2-conformance.log`, `/tmp/w2-full-test.log`.

## Notes for W3

- No producer sets `trackInput` automatically yet. W3 owns reservation admission and the request flag. Keep ordinary resumes free of fabricated `wakeOrigin`.
- Live `onStateChange` sees `inputAcceptedAt` synchronously before the runner handles the legacy `message_end`; W3 can consume a reservation immediately on that snapshot. Repeated evidence cannot overwrite the first timestamp.
- Use the §3.5 evidence priority: acceptance first; otherwise **physically terminal** and no dispatch marker / `rejected_pre_accept` can release. An attempted dispatch alone is not proof of acceptance OR of non-delivery.
- No terminal record (journal-only or nothing) remains ambiguous; do not use `restartInterrupted` as proof of physical completion, and do not read session files to try to strengthen missing evidence. Preserve the live-session defer / bounded recheck required by W3.
- Timeout/cancel without acceptance deliberately carries `promptDispatchedAt` but neither `inputAcceptedAt` nor `promptOutcome`.
- External/droid missing acceptance must not release for retry after an attempted dispatch. Consult/external wake exclusions and all admission ownership remain W3/W5 responsibilities.
- There are no new timers, schema fields, mailbox states, transitions, reservation operations, or stack hooks in W2.

## Changed files (absolute paths)

- `/home/bluecake/ai/pi-toolkit/src/core/types.ts`
- `/home/bluecake/ai/pi-toolkit/src/core/state-machine.ts`
- `/home/bluecake/ai/pi-toolkit/src/runtime/runner.ts`
- `/home/bluecake/ai/pi-toolkit/src/runtime/session-driver.ts`
- `/home/bluecake/ai/pi-toolkit/tests/core/core.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/core/input-acceptance.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/runtime/runner-input-acceptance.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/runtime/session-driver.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/conformance/fabric-wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/W2-report.md`

Outstanding W2 issues: none. Independent verifier review remains with the dispatching session.
