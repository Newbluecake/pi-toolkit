# G — final gate of fabric wake phase 1

Date: 2026-10-21. Branch: `dev` (S0 b08067b6 · F0 9977e400 · W1 84d5c5c1 · W2 a4996cde · W3 2af6fea7 · W4 f58dd34f · W5 fc1c9e1c · W6 f6cc67a0).
Plan: `docs/dev/fabric-cross-session/plan.md` v3 §7/§8/§9 (G row). No commit, no stash.

## 1. W6 leftover closed (verifier r_VS8D92DR major)

| Item                       | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agent status` wake line  | `WakeStatusView` + `formatWakeStatusLine` (`src/fabric/wake.ts`), `Stack.wake.status()` (`src/stack.ts`, built from `WakeService.stats()` + `CausalLevel` + settings + durability), `StatusCommandDeps.wake` (`src/commands/status.ts`), wired in `src/index.ts`. Line: `wake on · lvl≤2 · root L1 · resumes 2/6h · parked 3 · reserved 0 · unverified 1 · quarantined 0 · durability disk · results 4 (skipped 1) · dead target_gone=2,wake_refused=1` (`dead` omitted when none). English tokens only. **Wake off ⇒ the port returns `undefined` ⇒ no line at all** (output byte-identical; a literal `wake off` line would have changed fabric-on/wake-off output). |
| `WakeService.stats()`      | new `deadLetters: Record<reason, count>` (original records, from `deadLetter.reason`), plus new `inboxCount(runId)` = messages committed (`revivedAs`) or still reserved into that run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `get_subagent_result` text | `formatWakeProvenance` (`src/tools/result-text.ts`) + `createResultTool({ wake: { inboxCount } })`: terminal get/wait (`formatOutcome` suffix, first line of the suffix) and the still-running text. `Woken by <label (run_id: …)\|run r_x\|root\|system> (level n)[ · +N inbox messages]` (N excludes the trigger itself); a human `Agent({resume})` that carried parked messages shows `Resumed with +N inbox messages`. Plain runs / wake-off hosts: no line (byte-identical). A throwing port never breaks the read.                                                                                                                                               |
| Off golden                 | `tests/fixtures/fabric-wake-off-golden.json` untouched (sha256 `7706698af8ec0eb4fa2c01a30e64dafc0ab854fe5cc2539efba4eb3892e22545`, same as W2–W4); its test is unchanged and green. No assertion was extended.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 2. Minor fixes

| Item                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6: evicted/unknown successor entry lingering until dispose | `WakeService.watchEntry`: every new subscriber entry gets ONE unref'd 10-min watch timer. Terminal ⇒ settle; live non-terminal ⇒ re-watch (its own deadlines bound that; a revived run is fixed ≤3600 s); neither live nor in the replayed log ⇒ drop + audit line `subscribers dropped (successor_unknown)` (no body). A replayed non-terminal journal is NOT re-watched (dead stack). Settle/drop/dispose clear the watch. |
| W6: empty-shell entry before the cap check                  | `subscribe()` checks the cap against the existing entry BEFORE creating one.                                                                                                                                                                                                                                                                                                                                                 |
| W3: `park()` persist-failure fallback / strict retry count  | Already closed in W4 (not redone): `FabricRouter.tryPark` → `parked\|unavailable\|persist_failed` with the mailbox's TTL-bounded +1 s retry, and `WakeService.strictFailed` (5 consecutive failures ⇒ memory-only degrade + warn). Verified present and covered by `tests/fabric/successor.test.ts` "W3 findings".                                                                                                           |
| Existing test adjusted                                      | `tests/fabric/successor.test.ts` "drains a long backlog…" asserted `pendingTimers === 0` after the drain; it now asserts exactly `1` — the single subscriber watch the live successor's coalesced waker holds (not one per record). This is the only pre-existing assertion that changed.                                                                                                                                    |

## 3. G-row gates (real output)

Node v22.22.1. Logs: `/tmp/g-full.log`, `/tmp/g-conf.log`, `/tmp/g-conf-fabric.log`, `/tmp/g-targeted.log`.

- **Format / typecheck / build** — all exit 0:
  - `npm run format:check`: `All matched files use Prettier code style!`
  - `npm run typecheck`: `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json` (no output)
  - `npm run build`: `tsc -p tsconfig.build.json` (no output)
  - supplementary strict `tsc` over the new/changed test files (`/tmp/g-tests-tsconfig.json`; the project typecheck does not include `tests/`): clean except the pre-existing `tests/conformance/agent-session-harness.ts(61,9) TS2322` (untouched file).
- **State-machine matrix / seeded property in lockstep** — `tests/core/core.test.ts` builds its matrix and generators from `INPUT_KINDS` (17 kinds, asserted `toHaveLength(17)`), which includes `wake_level` (W1), `input_accepted` and `prompt_rejected` (W2); `tests/core/input-acceptance.test.ts` (32) pins the three diag-only inputs. Both inside the targeted run below (`tests/core` passed).
- **Targeted G run** (`npx vitest run tests/core tests/integration/fabric-wake{,-level,-revive,-quiet,-subscribers,-off-golden}.test.ts tests/integration/fabric-wiring.test.ts tests/fabric tests/delivery tests/service tests/runtime tests/tools tests/commands --maxWorkers=3`): first run `1 failed | 164 passed` (the `successor.test.ts` timer assertion above, a real behaviour change of this package); after the fix the file passes 17/17 and the full run below covers everything.
- **fabric-wake integration suite** (all green inside the full run): `fabric-wake` (park → `Agent({resume})`, W4 redirect, real in-memory session rebuild, wake-off), `fabric-wake-level`, `fabric-wake-revive` (end-to-end revive, join, legacy/user-stop/external refused, session_closing park → human resume; now also asserts `stack.wake.status()` / `inboxCount` and `stack.wake === undefined` when off), `fabric-wake-quiet` (silent + `ask_user` TUI and RPC not interrupted, mixed digest, reconcile), `fabric-wake-subscribers` (two senders coalesced, each exactly one `wake_result`), `fabric-wake-off-golden`, `fabric-wiring`. Crash windows ①–⑤ (`tests/fabric/wake.test.ts`), exact-expiry (F0 / `reserveStrict`) are in `tests/fabric` and `tests/delivery`.
- **Conformance** — `npm run test:conformance`:

  ```
   Test Files  22 passed (22)
        Tests  238 passed | 17 skipped (255)
     Duration  107.91s
  ```

  Fabric-specific (`/tmp/g-conf-fabric.log`, verbose): C-P1 ✓, C-P2 ✓, C-P3 ✓ (idle, streaming, streaming control), **C-P4 ✓** (new: real pi `AgentSession` tool registration — wake off equals the S0 off golden's `messageAgentSchema`, wake on equals `message-agent-wake-schema-golden.json`), **C-P5 ✓** (new: real `SessionManager.inMemory` with no session file + real stack: `status().durability === "session-memory"`, the real `message_agent` tool's `wake:false` finding to a finished run returns `inboxDurability:"session-memory"`, the parked record is still `pending`/`parked` and counted by `status().parked` after a stack rebuild on the same SessionManager); consult-preserve C1–C7 + E1 production chain (C1/C11/C12/C14/…) all ✓ (`Test Files 2 passed · Tests 21 passed | 1 skipped` — the skip is the pre-existing C8, awaiting ruling Q5).

- **Off-state golden byte-identical** — sha256 above; `tests/integration/fabric-wake-off-golden.test.ts` green; `git status tests/fixtures` shows no change.
- **Full `npm test`** (exit 0, no flake exemptions or isolated reruns needed):

  ```
   Test Files  1239 passed (1239)
        Tests  23808 passed | 22 skipped (23830)
     Duration  264.81s
  ```

- **Zero-hang audit** — every new timer in `src/fabric/` goes through `deps.clock.setTimer` (`systemClock` ⇒ `createSegmentedClock`, which `unref()`s every segment, `src/core/clock.ts:113`): wake.ts `watch` (10 min, cleared on settle/drop/dispose, re-armed only for a LIVE run), `cleanup` (10 min, cleared on dispose), `deferred` reconcile recheck (60 s, cleared on dispose/`onReaped`); mailbox steer-race timer (existing pattern, cleared in finally) and the single `wake` timer. No `setInterval`/`setTimeout`/`while(true)` was added in `src/fabric`; loops are over bounded collections (sweep ≤ 32, park cap 8, subscribers ≤ 8, inbox block ≤ 8). No new synchronous file I/O in admission (only W5's single `existsSync`).

## 4. AGENTS.md

`src/fabric/` paragraph extended (setting names/defaults, `wake` flag, causal level/hop gate, park + TTL, successor coalescing, revive + exclusions, at-most-once rule, quiet completions, `wake_result`/subscribers, status/result visibility, the accepted `/reload` 60 s fallback, golden/conformance gates, phase-2 pointer). No other section touched.

## 5. New / changed tests

- new `tests/fabric/wake-observability.test.ts` (8): status-line format (order, dead-letter listing, English-only), `stats().deadLetters` from the real mailbox path, `inboxCount` reserved→committed, evicted-successor drop (timer count returns to base + audit line), live successor re-watched then settled, dispose clears the watch.
- new `tests/commands/status-wake.test.ts` (2): line absent when the port is absent/`undefined` (output identical), exactly one extra line when on, read live.
- new `tests/tools/result-wake.test.ts` (6): provenance formatter + tool (get, wait, running, throwing port, plain-run byte-identity, human resume).
- `tests/integration/fabric-wake-revive.test.ts` (+3 assertions), `tests/conformance/fabric-wake.test.ts` (+C-P4 ×2, +C-P5), `tests/fabric/successor.test.ts` (1 assertion, see §2).

## 6. Residual risks (accepted / known)

1. **`/reload` ⇒ 60 s fallback** (W3 deviation 4): the originating runner's `onReaped` closure belongs to the disposed stack, so a reservation whose run was still closing is judged by the new stack's 60 s fresh-branch recheck. Bounded; the cost is up to 60 s of "reserved" state, never a lost or duplicated message.
2. **At-most-once drops messages in ambiguity** (NQ2, R4): attempted-but-unaccepted resumes, crashes with no terminal entry, steer timeouts. Audited (`resume_unverified`, `steer_unverified`, `reservation_expired`, `reservation_quarantined`), counted in `stats().unverified`, never body text.
3. **Status line shows nothing when wake is off** (deliberate, byte-identical rule). If a visible `wake off` is wanted for fabric-on installs it needs a golden-aware decision.
4. **`inboxCount` is derived from the outbox** (`revivedAs` / live reservation): it covers messages committed by this or an earlier stack on the same session; a record whose reservation was released or consumed ambiguously (`resume_unverified`) is not counted. A parked-then-carried `wake:true` message is counted but its sender is not subscribed (W6 deviation 2, plan §3.4d only names trigger and coalesced senders).
5. **Dead-letter counts** are read from outbox records, so they reset only with the session (not per stack) and include dead letters unrelated to wake (`ttl_expired`, `target_gone`, `attempts_exhausted`) — intended ("dead letters by reason").
6. **Pre-existing, not touched**: `tests/conformance/agent-session-harness.ts(61,9)` type error under a strict test-only tsc (the project typecheck excludes `tests/`); `fabric.mailbox` `router.admit` still reports `parkUnavailable:"stack_memory"` for a `wake:false` send to a finished run on stack-memory durability even when a successor exists (W4 deviation 4, cosmetic).
7. Peer bumps: C-P1/C-P2 depend on pi's `message_end{role:user}` / no-`turn_start`-on-rejected-prompt contract (plan R10); a change degrades to audited consume (safe direction) but must be caught by `npm run test:conformance` before the bump.

## 7. Phase-2 handoff notes

- Phase-2 scope (plan §12): `crossSession` settings + `CanMessage:"session"`, RootWakeController (+ managed autonomous root run with `rootRunMaxS`), mutation fence (compaction/branch summary/web resume/topic-switch/goal), hub `xs.*` protocol. §12 is an archive of v2 and must be re-reviewed against what phase 1 actually shipped.
- Reuse, don't re-invent: `CausalLevel` (`levelOf/raise/hopAllowed`; root persisted in `subagent:wake-level`, human-input reset in `wake-input.ts`), `WakeService.auditUnverified`, `engine.{reserveStrict,annotateStrict,transitionStrict}`, `FabricRouter.admitSystemResult` (route `wake_result` pinned by `authorize`), `DeliveryPayload.quiet` + `sendFormatted` split, `Verdict.effect` (`none|unknown`) for NQ3's "effect unknown ⇒ model decides".
- Phase-1 `wake:true` to root is deliberately legacy-equivalent (steer + `triggerTurn:true`); phase 2 makes it a managed run — that is a behaviour change to announce.
- `WakeStatusView` / `/agent status` and the `get_subagent_result` provenance line are the observability surface; add cross-session counters there (and under cap-gated web fields) rather than a new surface.
- If a shared reap signal is introduced (to remove the `/reload` 60 s fallback), it must be process-level (`Symbol.for`), unref'd and bounded, like the existing worktree-origin/transfer maps.

## 8. Exact changed paths (G only)

Source:

- `/home/bluecake/ai/pi-toolkit/src/fabric/wake.ts`
- `/home/bluecake/ai/pi-toolkit/src/stack.ts`
- `/home/bluecake/ai/pi-toolkit/src/index.ts`
- `/home/bluecake/ai/pi-toolkit/src/commands/status.ts`
- `/home/bluecake/ai/pi-toolkit/src/tools/result-text.ts`
- `/home/bluecake/ai/pi-toolkit/src/tools/result-tool.ts`

Tests / docs:

- `/home/bluecake/ai/pi-toolkit/tests/fabric/wake-observability.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/commands/status-wake.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/tools/result-wake.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/fabric/successor.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/fabric-wake-revive.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/conformance/fabric-wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/AGENTS.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/fabric-cross-session/G-report.md`
