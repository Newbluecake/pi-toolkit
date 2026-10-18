## P1

Implemented measurement transport plus the Anthropic strict reader/validator and shared route identity. Frozen M0 files were not edited. No commit, stash, checkout, reset, live provider request, or changes to P3-owned modules were made.

### Files

- `src/cache-ttl/pipeline-ping.ts`
- `src/cache-ttl/measure-usage.ts` (new)
- `src/cache-ttl/measure-payload.ts` (new)
- `src/cache-ttl/measure-route.ts` (new)
- `tests/cache-ttl/pipeline-ping-measure.test.ts` (new, 38 cases)
- `tests/cache-ttl/measure-usage.test.ts` (new, 25 cases)
- `tests/cache-ttl/measure-payload.test.ts` (new, 38 cases)
- `tests/cache-ttl/measure-route.test.ts` (new, 8 cases)
- `tests/cache-ttl/pipeline-ping.test.ts` (APPEND ONLY: 6 full deep-equality legacy outcome cases; original cases untouched)
- This report (appended section only).

### Interfaces for P2/P4

```ts
readMeasureUsage(
  profile: MeasureApi,
  rawUsage: unknown,
  requestedRetention: RequestedRetention = "short",
): UsageReading;

validateMeasurePayload(
  profile: MeasureApi,
  params: Record<string, unknown>,
  expect: PayloadExpectation,
): PayloadVerdict;

measureRouteKey(input: {
  api: MeasureApi;
  url: string;
  wireModel: string;
  effectiveTier: EffectiveTier;
}): PipelineMeasureRouteKey;

measureEndpointSuffix(api: MeasureApi): string;
```

P4 must adapt the validator verdict to the transport's `string | undefined` callback, remembering the successful `effectiveTier` before the route closure is evaluated. Bind the actual URL as `(url) => measureRouteKey({ api, url, wireModel, effectiveTier })`. Supply `expectWireModel` on every request and the run-wide `expectRouteKey` on every send after the first valid write, including replacement writes. In build mode `body` is ignored but the frozen transport input still requires it; the validator-accepted `measured.builtBody` is the replay body. Read strict usage from `outcome.measured?.rawUsage`, NEVER from the legacy `outcome.usage` projection.

As agreed with the main session, private `readOpenAiUsage` / `validateOpenAiPayload` stubs explicitly return typed `{ kind: "unsupported", profile }`. Public dispatch maps them to invalid `no-terminal-frame` / `extra-input` with `detail: "unsupported profile"`; comments mark the P2 replacement seams. P2 must also replace the explicit OpenAI terminal-event placeholder in `pipeline-ping.ts`; shared API/suffix/redirect/route admission is already present.

### Coverage / behaviour

- Measurement-only API/profile equality, per-profile endpoint suffix, manual redirect on both URL and re-wrapped Request inputs; 3xx resolves immediately as HTTP, cancels even stalled redirect bodies, never follows or records Location values.
- First build callback validates then deep-clones, returns undefined, refuses with zero POSTs and a rejection code; second payload/fetch blocked. Guard, deadline, abort, timing, raw usage byte cap, 64 KiB scan cap and physical `settled` bookkeeping remain bounded and tested. Production timers remain unref'd.
- Raw reader keeps missing fields missing, rejects strings/null/negative/fractional/non-finite/unsafe counters, constructs Anthropic P from uncached + C + W, checks W1h ≤ W, and separates valid cache evidence from unknown billing. Anthropic output is always unobserved because cancellation happens at message_start; even an initial output_tokens value is not treated as a final output reading. C ≤ P and C + W ≤ P follow from the non-negative Anthropic components and are property-checked; P2 supplies independent-P invalid cross-field cases for OpenAI.
- Validator protects exact converted synthetic text, exact optional OAuth identity, only stock managed-effort adaptive thinking + empty effort system message, all output caps, tools, service tier, server tools and cache-control/long tier. Unknown sampling keys remain tolerated. Real pi-ai 1.2 builder fixtures cover all OAuth/non-OAuth × managed/non-managed × short/long combinations with max_tokens exactly 1, intercepted before POST.
- Route identity is SHA-256 over API/normalised origin/base path/full sorted query/wire model/effective tier. Labels omit credentials, elide query values/token-like segments and show at most two base-path segments.
- Absent measurement keeps exact legacy usage/HTTP/network/malformed/lost/refusal outcome objects and fetch options; no measured annex is added.

### Verification (actual output)

`timeout 280 npm run typecheck` — exit 0:

```text
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

`timeout 280 npm run build` — exit 0:

```text
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
```

`timeout 600 npx vitest run tests/cache-ttl tests/conformance/keepalive-pipeline-facts.test.ts tests/conformance/keepalive-pipeline.test.ts tests/integration/keepalive-pipeline-service.test.ts tests/integration/cache-keepalive.test.ts` — exit 0, final run:

```text
 Test Files  28 passed (28)
      Tests  790 passed (790)
   Start at  22:56:34
   Duration  8.99s (transform 2.58s, setup 775ms, collect 7.16s, tests 17.61s, environment 5ms, prepare 1.53s)
```

Integration stderr includes expected sandbox-home quota warnings for missing zai/kimi credentials; no test failures. Initial local iterations exposed a fixture missing the SystemMessage timestamp, an unsupported Vitest matcher, and onPayload's unknown static type; all were fixed before the green gates above.

`timeout 60 npx prettier --check` with the nine owned TypeScript/test paths listed above — exit 0, `All matched files use Prettier code style!`. `timeout 20 git diff --check` — exit 0, no output. The report itself is append-only and is not whole-file formatted over another package's section.

### Remaining launch gates

P2 implementations and P4 command wiring/conformance/integration remain outside P1. No live endpoint was contacted: r4 G-c (user-approved managed-effort + exact OAuth acceptance on a real endpoint) remains a launch gate. Nothing here silently raises the output cap. P1 does not add consumers or change keepalive scheduling.

## P3

Package P3 (pure core: prefix, plan, actions, classify, renewal, runner, store, claim, args) of `measure-plan.md` r4.
No pi imports; `measure-types.ts` / `pipeline-ping-types.ts` untouched.

### Files

Source (`src/cache-ttl/`): `measure-args.ts`, `measure-prefix.ts`, `measure-plan.ts` (plan + estimate + cost accounting),
`measure-actions.ts` (THE §4.2 table + outcome classifier), `measure-classify.ts` (classification, control decision,
TTL result, consumer eligibility), `measure-renewal.ts` (§5.5), `measure-runner.ts`, `measure-claim.ts`,
`measure-store.ts`. Tests (`tests/cache-ttl/`): `measure-{args,prefix,plan,actions,classify,renewal,runner,store,claim}.test.ts`
(279 tests in the nine files).

### Design notes beyond the frozen types

- **Plan / cost** (`measure-plan.ts`): `tokenFigures()` derives `T_lo/T_mid/T_hi/P_bound` from the frozen formulas (tests assert
  them against the frozen constants). `estimateCost` = `6·W(T_mid)+7·R(T_mid)+13·O` and `17·(W(P_bound)+O)`; `W(n)` is probed
  as "n tokens as `cacheWrite`" (Anthropic long adds `cacheWrite1h: n`) and falls back to "n tokens as `input`" when the
  injected `MeasurePriceFn` returns `undefined`. `accountRequestCost` keeps every reported component in `knownUsd` and prices
  only unreported ones into `unknownUsd` (`output`, `write1h-split`, `write`, `all`). `formatPlanLines`/`formatConfirmText`
  carry the hard cap, both figures, C1–C3, the declared boundary read (ruling 14) and the quit-loss wording.
- **Table** (`measure-actions.ts`): cells for the two data-dependent failures hold a template reason (`payload:*`, `http-*`);
  `resolveMeasureAction(cls, kind, {rejection, httpStatus})` always replaces them. Runner-local refusals (`io-busy`, cap) are
  handled before the table.
- **Renewal** (`measure-renewal.ts`): `planRenewal` (pre-send, planned `headersAt = sentAt + 30 s`) and `finalizeRenewal`
  (post-send, actual timings) both go through `evaluateBasis`. `missAge` for `K` is measured from slot `b`'s WRITE, which is
  conservative for slot 5 (its probe anchor moved to the control). On the official origin the documented basis is tried first,
  then `paired-empirical`. `renewsOnRead: "false"` is never produced (a property test sweeps tiers/origins/outcomes).
- **Runner**: one coroutine, ≤ 1 send in flight; a due send whose predecessor's `settled` is still pending is
  `inconclusive(io-busy)` (writes wait ≤ 30 s for it, then the slot is `unavailable`). A `send` that never resolves is
  declared lost at `deadlineAt + 2 s` and — because its IO never settles — blocks every later send and leaves the claim
  `draining` (fail closed). First valid write fixes the run-wide route key + effective tier and gates on the own-prefix
  minimum; slot 5 must be anchored (else `failed(unavailable-slots)`). A probe's `due = anchor.headersAt + gap`, control at
  `write5.headersAt + 30 s / + 60 s`. `latest` is persisted only for runs that measured something (status complete /
  partial / no-cache / control-inconclusive / inconclusive, or ≥ 1 valid TTL sample), so a failed run never overwrites a
  learned record; `inProgress` is always cleared at the end.
- **Claim**: `claim.start(token, handle)` is called by `startMeasurement` itself (so a run that ends before the caller's own
  `start` cannot leave the claim stuck in `running`); a later `start` from P4 just returns `false`/is harmless.
  `MeasureClaimInternal.persistSlot` (extra, not in the frozen interface) holds the process-wide single-writer state of the
  store (state / lastSavedAt / zombieSince / writing / pending map), so coalescing and zombie fencing survive `/reload`.
- **Store**: pending updates are keyed `<route>\0<slot>` (newest wins); each write re-reads + merges the whole file (LWW),
  trims with `trimStoreToBudget` (inProgress of non-live runs → samples/renewal.read of non-live routes oldest-first → oldest
  non-live routes → last resort live detail) to ≤ 192 KiB / 64 routes; unreadable / > 256 KiB / unknown-version files are renamed
  to `….corrupt` (writer only; `readRoute` never touches the file). `lookupLearnedTtl` reads a stored `"false"` as `unknown`.
- **Test seam**: `MeasureRunnerDeps.hardDeadlineMs` (default 80 min) — the only way to exercise the hard deadline, since the
  natural timeline always ends before it.

### Coverage vs §9 P3

| §9 P3 item                                                                                                   | Where                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| plan/cap, ≤ 17 sent on every path (replacements, controls, renewal)                                          | `measure-runner.test.ts` "hard 17-request cap" (exact 17 path, pool-bounded failure paths, 150-seed random-transport property: per-kind caps, ≤ 1 in flight, only a renewal after the last miss); `measure-plan.test.ts` plan shape |
| outcome → action table row by row                                                                            | `measure-actions.test.ts` (13 classes × 4 kinds against an independently transcribed table + classifier) and runner "write/control/probe/renewal rows" executing each row                                                           |
| fresh nonce after accepted-then-lost                                                                         | runner "network / accepted-then-lost / malformed ⇒ … FRESH nonce" (validator expectation nonce differs, sessionId differs)                                                                                                          |
| classification (4096 baseline, own-prefix-small, mismatch), G-a boundaries                                   | `measure-classify.test.ts` (80 %/20 % thresholds, B subtraction, slack boundaries, `P_BOUND−1/=/+1`, ~19.2k fixture); runner bound-guard tests incl. a real ~19.2k and a 4.2k-baseline run                                          |
| control no-cache vs control-inconclusive                                                                     | `decideControl` tests + runner control rows                                                                                                                                                                                         |
| first-miss stop + single boundary renewal as the only post-miss request                                      | runner timeline tests + the random property                                                                                                                                                                                         |
| renewal eligibility with ACTUAL intervals (G-b), 3→6 ineligible on relays, eligible on the documented origin | `measure-renewal.test.ts` (closed form derived independently, grid over latency/pause, hand-computed 6→11 / 31→61 flip points, documented 3→6 short and 31→61 long) + runner 6→11 fast/slow                                         |
| renewal verdicts true(documented/paired) / unknown / never false                                             | renewal tests + runner renewal rows + property                                                                                                                                                                                      |
| cost accounting (typical + conditional worst, known/unknown)                                                 | `measure-plan.test.ts`, runner "cost accounting"                                                                                                                                                                                    |
| TTL result semantics (lower, "≥ 61 min", unknown, consistent, eligible)                                      | `measure-classify.test.ts`                                                                                                                                                                                                          |
| runner on injected clock, unref'd timers, 80 min hard deadline, lateness, cancel/done never await IO         | runner lifecycle tests (hard deadline via the seam, `suspend` lateness, guard lateness, io-busy, hung send, no real `setTimeout`)                                                                                                   |
| store: atomic 0600, single coalesced writer, zombie, 64 routes / 192 KiB / 256 KiB, corrupt backup, LWW      | `measure-store.test.ts` (30 tests, real fs in a temp dir + step-stuck fake fs)                                                                                                                                                      |
| claim states, prepare/revoke/start/drain, generation/owner fences, ioSettled not token-gated                 | `measure-claim.test.ts` + runner fence tests                                                                                                                                                                                        |
| args                                                                                                         | `measure-args.test.ts` (raw args, case rules, 6 flag permutations × positions, unknown/duplicate/extra)                                                                                                                             |

Mutation spot checks run once and reverted: raising the replacement pool to 5 fails 4 runner tests; removing the renewal
eligibility gate fails 3 runner tests.

### What the runner expects from P4 (transport / reader wiring)

`startMeasurement(deps)` needs, besides `{ plan, token, claim, send, clock, persist, onProgress, onDone }`:

1. `send: MeasureSendFn` bound to `sendPipelinePing` + registry + model. It must (a) call `request.guard()` right before the base
   fetch and return `not-sent{guard}` when false, (b) honour `request.signal` and `deadlineAt` (resolve by it), (c) for
   `request.build` call `build.validate(params)` on the FINAL params in the first `onPayload`, `measured.rejection` = the returned
   code and `not-sent{capability}` on a non-`undefined` result, `measured.builtBody` = clone on success, (d) call
   `request.routeKey(url)` and refuse with `not-sent{capability}` (`measured.routeMismatch`) when it differs from
   `expectRouteKey` or throws, (e) fill `measured.sentAt/headersAt/routeKey/routeLabel/rawUsage`. The runner treats a `send`
   promise that has not resolved by `deadlineAt + 2 s` as lost; `result.settled` must always resolve eventually — until it does
   no further request is sent and the claim stays `draining`.
2. `readUsage(outcome) → UsageReading` = P1's strict reader for `plan.api`'s profile (called only for `usage` outcomes; a throw
   is treated as invalid evidence).
3. `validatePayload(params, expectation) → PayloadVerdict` = `validateMeasurePayload(profile, params, expect)`; the runner builds
   the `PayloadExpectation` per prefix (it takes `oauth`, `managedEffort` and an optional `promptCacheKeyFor(sessionId)` from
   `deps.payload`; for Responses P4 must supply `promptCacheKeyFor`).
4. `routeKeyFor({ api, wireModel, effectiveTier, requestUrl })` = P1's `measure-route`; the runner supplies the effective tier from
   the first validated build.
5. `price: MeasurePriceFn | undefined` — pi-ai `calculateCost` semantics (tier selected by the total prompt; `undefined` when a rate
   needed for a non-zero token kind is missing; `cacheWrite1h` is the part of `cacheWrite` at the 1h rate).
6. `routeOrigin` — lower-case normalised origin of the model's base URL (no default port); only `https://api.anthropic.com`
   enables the documented renewal basis. `versions` optional.
7. `persist` = a `MeasureStore` from `createMeasureStore()` (default slot = the claim's process-wide `persistSlot`; pass the same
   `getMeasureClaim()` claim to the runner). `onProgress`/`onDone` are called synchronously, owner-fenced and try/catch-wrapped; do
   not await anything inside them that the run depends on.
8. Lifecycle: `claim.prepare(owner, now)` BEFORE the estimate/confirm await, `claim.owns(token)` after it, then
   `startMeasurement` (it calls `claim.start` itself). `session_shutdown`: `claim.revoke(token)` while `preparing`,
   `handle.cancel("session-…")` while running. `/cache-ttl status` while `draining` should show `claim.drainingSince` /
   `physicalPending`.
9. Admission (not in P3): `contextWindowAdmits(model.contextWindow, plan.tokens.pBound)`, `formatPlanLines`/`formatConfirmText`
   for `--estimate`/confirm, `describeTtl(record.ttl)` and `formatCost(record.cost)` for the final notice.

### Self-verification

- `timeout 280 npm run typecheck` — exit 0 (tsc ×2 + vue-tsc).
- `timeout 600 npx vitest run tests/cache-ttl/measure-*.test.ts` — 12 files, 350 tests passed (P3's nine files: 279; the rest are P1's).
- `timeout 600 npx vitest run tests/cache-ttl/` — 33 files, 1030 tests passed.
- `npx prettier --check` on the 18 owned files — clean.

### Open points for P4/main

- `claim.start` is invoked by the runner; P4 should not rely on calling it itself.
- A first send happens synchronously inside `startMeasurement` (before it returns); cancelling immediately afterwards still counts
  that in-flight request (conservatively) in `requests.sent`.

## P2

Implemented OpenAI Responses and Completions measurement readers, final-payload validators and completion-time transport usage capture. Consult A/B arm: **control** (already drawn by the main session). No commit, live endpoint request, stash, checkout or reset. P3 modules/tests and the frozen interface files were not edited by P2; the main session added the optional `PayloadExpectation.forbiddenKeys` seam during implementation.

### Files

- `src/cache-ttl/measure-usage.ts` — replaced the private OpenAI unsupported reader stub.
- `src/cache-ttl/measure-payload.ts` — replaced the OpenAI validator stub; implemented forbidden-key admission and requested P1 tier correction.
- `src/cache-ttl/pipeline-ping.ts` — OpenAI terminal frame capture, waiting for the complete provider stream.
- `src/cache-ttl/measure-route.ts` — requested P1 label-redaction correction.
- `tests/cache-ttl/measure-openai.test.ts` — new, 60 unit cases.
- `tests/conformance/measure-openai-build.test.ts` — new, 39 real-builder/SDK conformance cases.
- This report — appended P2 section only; P1/P3 sections retained.

### Coverage

- Responses usage comes from `response.completed` / `response.incomplete` → `response.usage`; Completions usage comes from a chunk's non-null `usage`. Both protocols wait for `stream.result()` before returning the logical usage outcome: created/delta events, a finish_reason and even the raw usage callback alone do not abort an unfinished stream. The existing 64 KiB scanner, one-POST guard, injected deadline, abort and physical `settled` ledger stay intact. Oversized raw usage is omitted at the shared 4 KiB cap; a stalled stream still resolves by its deadline.
- Strict readers preserve independent prompt P, cached C, optional W and optional output; never zero-fill missing fields; retain the first present Completions cache-read alias (including 0); reject invalid counters and C > P / C + W > P; separate valid cache evidence from unknown output/write billing. A cr-response-shaped P=19028/C=4096 baseline remains readable. Relay attribution data is not mistaken for top-level usage.
- Final-payload validators accept exact system/developer + user content and Responses input_text / Completions compat cache_control parts. They enforce exact positive-integer caps, tools, service tier, store/server-state restrictions, Responses cache key, Completions streaming usage and server-billed/thinking-budget fields, and effective auto/24h/explicit-30m tiers. Unknown sampling keys remain tolerated. Per §3.3, two Completions cap fields both equal to 1 are valid; any conflicting/non-1 dual cap is refused.
- Real `ModelRuntime.create` → `ModelRegistry.streamSimple` → pi-ai → OpenAI SDK conformance uses only fetchImpl SSE fakes, not provider mocks. It covers reasoning/non-reasoning roles, stock caps, byte-identical replay, Unicode cache-key clamp, supportsMaxOutputTokens:false and ChatGPT-sign-in cap omission, sampling instructions/tools/priority/store/dual caps, prior server state, 24h and explicit 30m retention, cache_control parts, supportsUsageInStreaming:false, missing cached_tokens, complete/incomplete Responses usage, EOF/deadline behaviour and scan/raw-usage caps. No external service is contacted.

### P1 verifier findings handled

- Path labels now admit only a bounded allowlist of short common route words; opaque segments of 16+ characters (pure letters included) and shorter non-common segments become `…`. Full route identity still hashes the unredacted path/query.
- An Anthropic short request carrying 1h cache markers is refused as `no-cache-control`, not reported as ephemeral-1h. OpenAI short requests similarly cannot silently promote to a long tier.
- The serialization catch retains `too-large`: no existing frozen PayloadRejectionCode accurately names an unserialisable payload. A code comment states this explicitly; no new refusal code was added.

### P4 wiring notes

The public helper signatures remain exactly those recorded under P1. Supply `PayloadExpectation.promptCacheKey = Array.from(prefix.sessionId).slice(0, 64).join("")` for Responses (Unicode code points, not UTF-16 units). Use `measured.rawUsage`, not the legacy `outcome.usage` field; for OpenAI a usage outcome intentionally has `usage: undefined` on the legacy projection.

Populate `PayloadExpectation.forbiddenKeys` from `model.compat.thinkingTokenBudgetField` when present. The validator refuses any listed own key at the payload's top level or directly inside `thinking` / `reasoning`, even when its value is undefined or 0, with code `thinking`; absent/empty lists leave unknown sampling-key tolerance intact. Conventional budget/token-name checks remain active independently. pi-ai's builder uses `Object.assign(params, { [thinkingTokenBudgetField]: budget })` at top level; its installed pi 1.2 models.json schema currently permits only `thinking_token_budget`, `thinking_budget`, and `thinking_budget_tokens`. Unit cases cover truly opaque names; real registry cases use permitted names and assert that the expectation is populated from the resolved model. The seam also covers future/programmatically provided opaque names without requiring an unknown-key deny-all policy.

### Verification (actual final output)

`timeout 280 npm run typecheck` — exit 0:

```text
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

`timeout 280 npm run build` — exit 0:

```text
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
```

`timeout 600 npx vitest run tests/cache-ttl tests/conformance/measure-openai-build.test.ts tests/conformance/keepalive-pipeline.test.ts tests/integration/keepalive-pipeline-service.test.ts` — exit 0:

```text
 Test Files  37 passed (37)
      Tests  1154 passed (1154)
   Start at  23:27:27
   Duration  9.64s (transform 1.93s, setup 933ms, collect 5.80s, tests 15.28s, environment 7ms, prepare 2.09s)
```

This also exercised P3's concurrently added suites without changing them. An intermediate opaque compat-name fixture was correctly rejected by the real registry schema; it was replaced with supported config names, while pure validator tests retain opaque-name coverage. The final run has no test failures or parse-error stderr.

Remaining: independent P2 verification, P4 command/runner binding and its end-to-end gates, plus the user-approved live endpoint launch acceptance. P2 does not change keepalive scheduling or add measurement consumers.

`timeout 60 npx prettier --check` on the six P2-owned TypeScript/test paths above and this report — exit 0, `All matched files use Prettier code style!`. The only pre-existing report-format repair was inserting a blank separator before the P3 heading; no P1/P3 section content was overwritten. `timeout 20 git diff --check` — exit 0, no output.

### P2 follow-up

- Fixed both verifier minors: measurement raw usage now projects only per-profile strict-reader counters (including cache-read aliases and Anthropic 1h split) before cloning and the 4 KiB cap; 10 KiB top-level/nested attribution blobs no longer discard valid samples. Invalid scalar counters remain invalid, never zero-filled. The 64 KiB response scan cap is unchanged.
- Completions accepts Moonshot-style `choices[0].usage` when top-level usage is missing/null, preserving top-level precedence. OpenAI null details containers now mean missing cache details (`missing-cached` without an alias), while a null cached counter remains `not-integer`.
- Added real-SDK regression cases for large attribution, both alias-bearing choice fallbacks and precedence, plus null-details reader cases and Anthropic projection. Updated the existing P1 byte-cap fixture from an unknown metadata key to a retained counter key so it still genuinely tests the cap. P4 cache-key/forbiddenKeys wiring, frozen types and P3 source/tests were untouched. No commit.
- Final verification: `timeout 280 npm run typecheck` and `timeout 280 npm run build` both exit 0. Required `timeout 600 npx vitest run tests/cache-ttl tests/conformance/measure-openai-build.test.ts tests/conformance/keepalive-pipeline.test.ts tests/integration/keepalive-pipeline-service.test.ts` exits 0: **37 files / 1162 tests passed**, start 23:52:37, duration 9.48s. Prettier check on all five changed TypeScript/test paths plus this report passes; `git diff --check` exits 0.
