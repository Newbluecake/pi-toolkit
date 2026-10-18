## A1

- Implemented `src/cache-ttl/pipeline-ping.ts` against the frozen interface without modifying it. Replay uses only pi's registry pipeline, captured session/body, `maxRetries: 0`, guarded hooks and a once-only fetch. Header values are never inspected or recorded.
- One injected-clock deadline bounds auth, fetch and body reads. Body forwarding is capped at 64 KiB / 2 KiB for errors; cancellation is started but never awaited by the logical result. Physical fetch/read/cancel/pi-result completion gates the separate, non-rejecting `settled` promise, including late fetch responses.
- `ping-client.ts` changes are exports only (shared caps, raw Anthropic usage projector/event predicate, unchanged classifier). `PingHeaderSource` is unchanged.
- Main-session clarification applied: unsupported providers return `not-sent{capability}` defensively in A1 (A2 owns terminal admission skips); an unresolved base fetch keeps `settled` pending after the deadline, until released and cleaned up.
- Unit coverage: 46 cases covering raw usage/1h split, the full replay options table, strict fallback and duplicate-fetch guards, HTTP/network failures, stalled auth/fetch/read/error bodies, byte caps, unresolved cancellation, physical pi-result tracking, liveness/deadline checks, disposal, unsupported providers and malformed/capability paths.
- Verification: `timeout 300 npx vitest run tests/cache-ttl/pipeline-ping.test.ts` passed **46/46, three consecutive runs**; `timeout 280 npm run typecheck` passed; `timeout 280 npm run build` passed; owned-file Prettier check and `git diff --check` passed. Full-suite and real-pipeline A3 gates remain with the integrating session. No commit, stash, checkout or reset performed.

## A2

Package A2 (capture + service) of `capture-pairing-plan.md` r7. Typecheck is clean; the owned unit suites and the three integration suites pass.

### What changed

- **Payload-only capture (`cache-ttl.ts`, `child.ts`).**
  - `createRequestCapture`, `RequestCapture`, `CapturedRequestBase`, both `before_provider_headers` handlers and the payload-time `capture?.clear()` are deleted.
  - `captureRequest()` now returns a full `CapturedRequest`, and both wirings call `port.noteRequest(...)` immediately from `before_provider_request`.
  - A strict-tools P′ simply replaces P: a second `noteRequest` bumps the window epoch.
  - The child's `authTimeoutMs` / `CHILD_AUTH_TIMEOUT_MS` are gone, because the transport deadline D now bounds auth + fetch + read.
- **`keepalive-state.ts`.**
  - `CapturedRequest.headers` is removed.
  - New tick skips:
    - `io-busy` is non-terminal and sits before `ping-in-flight` (#10.5).
    - `provider-unsupported` is terminal (#4.7): `github-copilot` and `api === "pi-virtual"`, via the new pure `isProviderUnsupported`. `copilot-*` custom provider ids still ping.
    - `activation-disabled` is terminal (#1.5), fed by the new `EvaluateTickInput.activationDisabled` / `ioBusy`.
  - `KeepaliveReport` gains `activationDisabled` and `ioBusy`.
  - `headerSource` is widened to `PingHeaderSource | PipelineHeaderSource`.
  - `authHeaderKeys` is documented as inert.
  - The status segment and report lines render an activation disable.
  - `renderKeepaliveReportLines` appends `KEEPALIVE_EXTENSION_HEADER_NOTE` whenever keepalive is enabled (ruling 6, observed-only wording, no one-ping bound claimed). It is the last line, so index-based status tests stay stable.
- **`cache-keepalive.ts`.**
  - `runPing` has no `getApiKeyAndHeaders` preflight, no `lockedAuthHeaderKeys` and no `buildPingRequest`.
  - It dispatches through `deps.sendPipelinePing` (production default: A1's `sendPipelinePing`).
  - Each attempt gets `deadlineAt = min(now + 20 s, aliveUntil − TTL_SAFETY_MARGIN_MS)` and a guard (`!disposed && windowEpoch === pingEpoch`).
  - Each retry is a new transport.
  - `PipelineOutcome` maps onto the existing `PingOutcome` via `classifyUsage` (now exported by A1), so the retry/breaker/charge code is unchanged.
  - `not-sent` is refunded: first attempt ⇒ `refundBudget`; in a retry it finalizes with the previous outcome. There is one `ping-attempt` audit entry per attempt, with `notSentReason`.
  - `ioPending` counts transports whose `settled` has not resolved. `evaluateTick` skips `io-busy`, and a retry refuses to start while it is busy (the unproven outcome finalizes instead).
  - The ledger lease settles in the outer `finally` on every path. A throwing sender maps to `not-sent{provider-error}` and releases busy.
  - `activationDisabled` is a service field outside `SessionTotals`. `audit()`, `persistSessionState` and `readBack` never see it, so `/reload` forgets it and keeps real breakers. It is set at construction by the capability probe, or at runtime by the diagnosis below.
  - The auth-key fingerprint lock is deleted, which ends the immediate `fingerprint-drift`.
- **`pi-compat.ts`:** `probeKeepaliveTransport({ registry, declared? })`.
  - It requires `typeof registry.streamSimple === "function"`; a throwing getter counts as missing.
  - `declared.fetchOption` / `declared.rawEventCallback` are optional. The fetch option and the raw-event callback are adapter-owned and not statically observable, so they are caught at runtime by the diagnosis.

### Judgement calls

1. **Static import of the default sender.**
   - `cache-keepalive.ts` imports `sendPipelinePing` from `./pipeline-ping.js` as the default when no sender is injected. Injection via `deps.sendPipelinePing` remains the seam; `src/stack.ts` and `src/index.ts` are untouched.
   - I first used a variable-specifier dynamic import so A2 would typecheck without A1. It never fired under vitest's microtask-only clocks, because module loading is real I/O. A1's file already exists, so I switched to a plain static import.
   - Until A1 is complete this is the only value-level dependency on it, besides `classifyUsage` from `ping-client.ts`, which A1 exported.
2. **Runtime diagnosis latches on `not-sent{capability}` too, but only with `explicitSuccess`.**
   - A1 reports "pi succeeded but never called our base fetch" as `not-sent{capability}` with `explicitSuccess: true`.
   - A literal "no not-sent" reading would make the plan's "no base-fetch call" branch unreachable.
   - Every other `not-sent` reason never latches, nor do `http`, `network`, `malformed`, `accepted-then-lost` without explicit success, a deadline hit, or a diag that carried `message_start`.
3. **`authTimeoutMs` is removed from `CacheKeepaliveDeps`.** The transport deadline D replaces it, for both main and child.

### Tests

- New helper `tests/cache-ttl/fake-pipeline.ts`.
  - `fakeSender` implements the frozen contract over a scripted `fetch`: the real `postAndScanUsage` does the scanning, with options for a held `settled` and fully scripted outcomes.
  - `createCacheKeepaliveService` is a drop-in wrapper that derives the sender from `fetchImpl` and adds the `streamSimple` facade.
  - `fakePiStreamSimple` is a faithful fake of `ModelRegistry.streamSimple` (`onPayload`, `transformHeaders`, `fetch`, `onProviderStreamEvent`, `result()`), used where the real stack builds the service (it drives A1's real transport).
- New suite `tests/cache-ttl/keepalive-pipeline.test.ts` (35 tests): the probe, the activation disable and `/reload`, diagnosis latch and non-latch cases, `io-busy` until `settled`, never-settling fails closed, retry blocked while busy, lease settle on every path, and strict-P′ replacement.
- Rewritten: `cache-ttl.test.ts` (P-only capture and the `/cache-ttl status` note) and `request-capture.test.ts` (`captureRequest`).
- Updated:
  - `keepalive-state.test.ts` (new skips, report, readback).
  - `keepalive-lifecycle.test.ts`: the old auth-lock and drift-after-auth tests become not-sent/refund tests, a tick-time drift test, an inert-`authHeaderKeys` test, and Copilot terminal-skip plus `copilot-*` still pinging.
  - `keepalive-child.test.ts`: an auth hang is now bounded by D.
  - The ping-retry, breaker and evidence suites, and the three integration suites (`cache-keepalive`, `child-keepalive`, `cache-ttl-removal`).
- One out-of-list edit: `tests/integration/child-context-switch.test.ts` listed `before_provider_headers` among the handlers the child wiring must register. I removed that single entry, since deleting the handler is part of the plan.

### Verification

- `timeout 280 npm run typecheck`: clean.
- `timeout 600 npx vitest run tests/cache-ttl tests/integration/cache-keepalive.test.ts tests/integration/child-keepalive.test.ts tests/integration/cache-ttl-removal.test.ts tests/integration/child-context-switch.test.ts tests/config`: 57 files / 1112 tests pass (includes A1's `pipeline-ping.test.ts`).
- Prettier on every changed file: clean.
- Broader keepalive/cache-ttl grep run (47 files): only `tests/integration/quota-wiring.test.ts` fails. It is unrelated (droid pool gate text in `src/quota`, another in-flight change).

### Residual / for the main session

- `tests/cache-ttl/keepalive-ping.test.ts` and `probe.test.ts` test `ping-client` / `probe` directly and are unchanged.
- The old raw ping path (`buildPingRequest` / `sendKeepalivePing`) is no longer used by the service. It remains only for `/cache-ttl probe` and its tests; I did not touch `ping-client.ts`.
- `src/cache-ttl/ping-ledger.ts`'s doc comment still mentions `authTimeoutMs` (not an owned file).
- `AGENTS.md`'s `src/cache-ttl/` section still describes the header-pairing capture. The doc update belongs to the main session.
- `tests/cache-ttl/*.ts` was prettier-formatted in bulk, which may have reformatted A1's untracked `pipeline-ping.test.ts` (formatting only).

### A2 fix: exactly-once lease settle

A3's real-driver gate (G8) showed `lease.settle` invoked twice for one lease after first-capture ping then abort. Cause: `dispose()`'s defensive backstop and `runPing`'s outer `finally` both settled it. The ledger is idempotent, so counts reached 0, but the plan requires exactly once.

- `src/service/cache-keepalive.ts`: new per-instance `settledLeases` (a `WeakSet<Lease>`) and `settleLeaseOnce()`. `runPing`'s `finally` and `dispose()` both go through it, and whichever runs first owns the lease. `dispose()` takes and clears `currentLease`, so it still settles a lease whose sender never resolves (no hang, no leak). `settle` faults are swallowed, so `dispose` can never throw.
- `io-busy` is unchanged: it follows `settled`, independent of the lease.
- Tests (`tests/cache-ttl/keepalive-pipeline.test.ts`, "exactly-once settle"): a spy ledger counts `settle` calls. Covered paths: dispose mid-flight (the aborted ping then unwinds through `finally`), dispose with a never-resolving sender, dispose after completion, dispose while physical IO is unsettled, and the normal paths (not-sent / proven-write / http). Each asserts exactly 1 call and `activeCount() === 0`. Removing the dedupe makes them fail.

## A3

Package A3 of `capture-pairing-plan.md` **r7** (2026-10-18), Node **v22.22.1**, real pi ModelRuntime / ModelRegistry / createAgentSession → Anthropic SDK → local HTTP stub. **25 active tests; no A3 skips.** No production files changed by this package; no commit/stash/checkout/reset performed.

### Files and harness review

- `tests/conformance/keepalive-pipeline.test.ts`: completed the previous untested partial (10 tests). Corrected SDK lifecycle assumptions (a bare createAgentSession does not fire session_start), resolved the driver's model override through its registry resolver, disabled main service status rendering in the headless conformance harness, and captured hook errors explicitly instead of accepting silently failed hooks.
- `tests/integration/keepalive-pipeline-service.test.ts`: new real-service suite (15 tests). A recording wrapper delegates every attempt to **production sendPipelinePing**; no fake sender or scripted pipeline outcomes. FakeClock drives the service/deadline, while real HTTP and the real provider/SDK still run. The long-tool test registers and actually enters an unresolved tool; tools explicitly include its name in the SDK allow-list.
- `tests/conformance/fixtures/anthropic-stub.ts`: **9 additive lines**, only the `drop-after-headers` directive. Sends HTTP 200 + partial SSE comment then destroys the connection, providing an actual accepted-then-lost server response. Existing directives and replies unchanged.
- HOME / USERPROFILE / PI_CODING_AGENT_DIR and Anthropic auth env are isolated. Synthetic credentials only. Stub sockets and child processes are closed; teardown attempts every cleanup even when another cleanup assertion fails. All waits have test/wall deadlines; readiness-only process holders are cleared before disposal.

### Per-gate results

| Gate                                    | Result   | Observed assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G2                                      | PASS     | First P immediately equals production capture. A real strict-tools 400 causes P′; capture is replaced, and both server POST bodies equal their corresponding captures.                                                                                                                                                                                                                                                                                                                                                                               |
| G3 api-key / OAuth / thinking / strict  | PASS (4) | Ping body **byte-equal** to the real SDK wire; URL/method and all headers equal except `x-stainless-timeout`. No extension hooks re-entered. Captured betas become `anthropic-beta`, never wire-body `betas`; thinking preserves real max_tokens > 1. Nonthinking real request max_tokens is intentionally normalized to 1 before capture so the comparison can cover the entire body instead of filtering fields.                                                                                                                                   |
| G4 strict-400 / 503 / fetch reject      | PASS (3) | Separate base-fetch spy and server POST log: each attempt calls base fetch exactly 1 time; strict-400 / 503 each reach the server exactly 1 time; rejected fetch reaches it 0 times (≤1). No implicit second POST. Replay uses a toolless stub context, so pi has no preferred-strict fallback candidates; the strict-400 replay calls onPayload once, not twice.                                                                                                                                                                                    |
| G7                                      | PASS     | A later real payload-rewriting hook changes wire metadata; captured P differs from Q, and the ping replays P rather than Q. This pins the accepted residual, not a guarantee that the residual is prevented.                                                                                                                                                                                                                                                                                                                                         |
| G8                                      | PASS     | PiSessionDriver child discovers the settings-listed local package and extension through its **own** resource loader; activation counter advances and childExtensionMissing=false. Its first outgoing request is captured and pings after 240s. Prior measured usage is seeded as a ledger fixture (not an earlier outgoing request), since an unknown prefix must correctly refuse pinging. Actual SDK fetch AbortSignal becomes aborted; one acquired ledger lease has **exactly 1 settle call**, activeCount=0 and reserved=0 after abort/dispose. |
| models.json headers / header-owned auth | PASS (2) | Eligible windows actually send and record a proven hit. Provider and model headers arrive on the ping. True header-only auth uses builtin Anthropic ANTHROPIC_AUTH_TOKEN resolution: Authorization is present and **x-api-key is absent**.                                                                                                                                                                                                                                                                                                           |
| Long tool call                          | PASS     | Tool execute entered, promise remains unresolved, and turn_end count stays unchanged; a real ping POST arrives after exactly 240s of service-clock time, before turn_end. message_end already cleared requestInFlight.                                                                                                                                                                                                                                                                                                                               |
| /reload                                 | PASS     | Actual AgentSession.reload reactivates wiring: structural activation-disabled disappears and a ping can send; a subsequently observed real proven-write breaker is persisted via appendEntry/readBack and survives the next reload.                                                                                                                                                                                                                                                                                                                  |
| Non-latching failures                   | PASS (5) | Auth command failure produces not-sent/auth, 0 base fetches, refund; epoch preemption aborts the pending real fetch; fetch reject / server 503 / real 200-then-drop never latch transport-unsupported. No hidden SDK retry before the service's 2s backoff.                                                                                                                                                                                                                                                                                          |
| Stalls / physical IO                    | PASS (4) | After-200 stall, newline-less 70,000-byte flood, held cancellation and never-settling base fetch produce a logical outcome by D≤20s; flood forwarding caps at exactly 65,536 bytes. Only 1 base-fetch invocation. Controlled physical cancel/fetch remains pending until explicitly released: ioBusy stays true, even a fresh eligible real capture ticks as io-busy, and no retry/overlap sends. Releasing physical IO clears ioBusy and settles the transport.                                                                                     |
| Natural exit main / child               | PASS (2) | Real node subprocesses, real clocks, no process.exit or fake timers. Both enter a ping whose underlying fetch ignores abort and never resolves, dispose main / child wiring, release the tool and exit code 0 with leases=0. Exit is <1s after the DISPOSED marker (stronger than D+1s), proving the SDK's otherwise ref'd 20s fetch timer is cleared. Only the initial real tool-request POST reaches the server.                                                                                                                                   |

### Bug found and routed (now fixed, regression ACTIVE)

G8 initially failed with one acquired lease but **two lease.settle invocations**. Repro: the G8 test opens its first-capture ping to a hanging stub, calls requestAbort(), awaits the child prompt, and disposes the handle. Both `CacheKeepaliveServiceImpl.dispose()`'s defensive lease backstop and `runPing()`'s finally settled the same lease (the ledger's idempotence hid the duplicate in activeCount/reserved). A3 reported this to the main session without editing src. A2's follow-up now routes both sites through `settleLeaseOnce` (`src/service/cache-keepalive.ts:951`, callers at 1297 and 1587). G8 retains an **ACTIVE** exactly-one spy assertion and passes repeatedly against that fix.

The first broad rerun also caught 4 unhandled rejections from A2's new unit-test spy ledger (`spent24h is not a function`): spreading a class instance lost its prototype methods. Main session corrected that fixture to delegate through a Proxy. The final broad rerun below is clean, with no unhandled errors.

### Verification — real command output

1. Final source, **three consecutive runs**:
   `timeout 110 npx vitest run tests/conformance/keepalive-pipeline.test.ts tests/integration/keepalive-pipeline-service.test.ts --reporter=verbose`

   ```text
   run 1: Test Files  2 passed (2)   Tests  25 passed (25)   Duration  8.75s
   run 2: Test Files  2 passed (2)   Tests  25 passed (25)   Duration  8.51s
   run 3: Test Files  2 passed (2)   Tests  25 passed (25)   Duration  8.41s
   ```

   Logs: `/tmp/a3-gates-final1.log`, `/tmp/a3-gates-final2.log`, `/tmp/a3-gates-final3.log`.

2. `timeout 280 npm run typecheck` — **exit 0** (`tsc` source + typecheck projects + `vue-tsc`). Log: `/tmp/a3-typecheck-final.log`.
3. `timeout 280 npm run build` — **exit 0** (`tsc -p tsconfig.build.json`). Log: `/tmp/a3-build-final.log`.
4. Required broad regression:
   `timeout 600 npx vitest run tests/cache-ttl tests/conformance tests/integration/cache-keepalive.test.ts tests/integration/child-keepalive.test.ts` — **exit 0**.

   ```text
   Test Files  41 passed (41)
        Tests  806 passed | 17 skipped (823)
     Duration  101.76s
   ```

   Existing suite skips only; neither new A3 file contains skips. Log: `/tmp/a3-regression-final.log`.

5. Owned-file Prettier check and `git diff --check` — run at final handoff (results below).

### Remaining scope notes

- No remaining failing A3 gate. G7 deliberately observes the r7 later-rewriter residual; no extension-header detection was added (ruling 6).
- An **additional, non-project** direct `tsc` invocation on the test files (tests are not included by the repository's npm typecheck scripts) exposed the stub's existing TS2339 at `tests/conformance/fixtures/anthropic-stub.ts:102`: inferred content-block union does not narrow `block.input` using its string-valued type tag. This predates A3 (the only stub diff is the 9-line additive directive), is outside the allowed stub-extension scope and was not changed. Log: `/tmp/a3-tests-typecheck.log`. Required project typecheck/build remain clean.

Final formatting check result: `All matched files use Prettier code style!` (exit 0), covering both A3 tests, the additive stub and this report; `git diff --check -- <the same four owned paths>` also exited 0. Formatting log: `/tmp/a3-prettier-final.log`.
