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

## P4

Implemented the main-session command assembly and final end-to-end package against P1 `92230b0`, P2 `b48cb47`, and P3 `91994be`. No commit, settings change, consumer activation, or live-provider measurement was performed. The plan author (`r_SWZCCGNF`) was consulted for design intent on persisted route status and tiered pricing, not for an implementation verdict.

### Files / assembly

- `src/cache-ttl/measure-command.ts` (new) — model/auth/capability/context admission, one frozen plan, estimate and 60s abortable confirmation, prepare-before-await claim ownership, real pipeline binding, actual-params validation, typed raw-usage reading, registry `calculateCost` adapter, progress/final text, cancellation and generation-fenced status.
- `src/cache-ttl/cache-ttl.ts` — raw `measure` branch before lowercasing, help/completions, measurement status line and late-read shutdown fence.
- `src/web-hub/agent/command-policy.ts` — `parseMeasureArgs` drives read-only status/estimate allow vs start/cancel/malformed confirm; existing explicit overrides still win.
- `tests/cache-ttl/measure-command.test.ts` (new, 34 cases) — admission/claim/dialog/lifecycle, OpenAI key and forbidden-budget binding, fake-build protected-param refusal, tiered cost accounting, raw branch/completions, post-guard child exclusion and real Node headless natural exit.
- `tests/conformance/measure-build.test.ts` (new, 13 cases) — real ModelRegistry + Anthropic SDK + local AnthropicStub: exact OAuth and byte-identical replay; managed adaptive effort with cap 1; actual Anthropic sampling behaviour; unsupported long; real 307 Location not followed; nonce replacement; route change; shutdown/physical draining/late UI fences; frozen P_bound boundaries and real relay-like injected baselines.
- `tests/integration/cache-ttl-measure.test.ts` (new, 9 cases) — real command/runner/store/registry/SDK with per-nonce FakeClock lifetimes: renewing and write-anchored policies, LRU k=3, detectable/undetectable backend splits, rate-limit pool exhaustion, request cap, actual renewal geometry/deadline margins, shifted slot-5 control anchor, persistence/status/hints and web policy rows.
- `tests/web-hub/agent/command-policy.test.ts` — append-only measurement cases (14).
- `AGENTS.md:185` — one cache-ttl paragraph sentence documenting the command's main-only scope, cap, claim and store.
- This report — appended P4 section.

No measurement command is registered in child sessions: `src/index.ts:236` returns on HOST_KEY before `wireCacheTtl` at line 313. The new command also refuses non-interactive/print (`hasUI !== true`) before model resolution, timers or disk access; a real Node child test proves natural exit. No new settings were added. Measurement requests use `ModelRegistry.streamSimple` directly, not the session request hooks, keepalive ledger/HUD or native CacheWarmer.

### Small P1–P3 / existing-fixture corrections

P1/P2 production modules and both frozen type files were not changed by P4. Two P3 integration fixes were necessary and confirmed as intended by the plan author:

| File:line                                             | Change / reason                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cache-ttl/measure-plan.ts:85`                    | Price output as the difference of quotes at the same total prompt tier, not an output-only quote at prompt=0; stabilise floating subtraction noise without meaningful list-price loss.                  |
| `src/cache-ttl/measure-plan.ts:129`                   | Typical output uses T_mid's tier; conditional-worst/lost-usage output uses P_bound's tier.                                                                                                              |
| `src/cache-ttl/measure-plan.ts:293`                   | Unknown output for a reported request uses that request's actual prompt breakdown/tier.                                                                                                                 |
| `src/cache-ttl/measure-plan.ts:306`                   | Unknown OpenAI write premium retains the cached baseline in both quotes, so a large cached prefix cannot incorrectly select the lower tier.                                                             |
| `src/cache-ttl/measure-store.ts:235,393`              | Add `readRoutes()` only to the concrete store, reusing its existing capped/deadline-bounded, non-quarantining read path; do not guess an authenticated key from model.baseUrl or widen the frozen port. |
| `tests/cache-ttl/measure-plan.test.ts:195`            | Correct the old assertion explicitly assuming output stayed at the base tier; §4.3 requires output and prompt at the same request tier.                                                                 |
| `tests/cache-ttl/cache-ttl.test.ts:269`               | Add the newly required `measure` completion to the existing exact expected list.                                                                                                                        |
| `tests/conformance/fixtures/anthropic-stub.ts:37,208` | Add an optional headers field to the existing error directive, preserving defaults, so the 307 conformance case has an actual Location target and can prove it was not followed.                        |

No P3 runner/claim/actions/classification/renewal/prefix/args behaviour was changed. Per-nonce lifetime/LRU policies use the stub's existing scripted reply callback, not a widening of its default cache behaviour.

### Explicit plan-text deviation: Anthropic sampling

The main session ruled that validators must inspect **only ACTUAL final params**. In installed pi-ai 1.2, `dist/api/anthropic-messages.js:437–440` takes `built.params` into onPayload; unlike the OpenAI builders, it never Object.assigns samplingParams into those params (`buildParams` at line 890). Therefore configured Anthropic sampling max_tokens/tools/budget thinking are silently ignored by this installed provider and do not reach the wire. The §9 P4 "sampling overrides ⇒ zero POSTs" Anthropic case is a byte-level fact test instead: such configuration still sends cap 1, no tools and no budget thinking, with the wire exactly equal to the validated built payload after the SDK's beta-header extraction. Separate fake-build command unit cases prove that ACTUAL params carrying a large cap/tools/enabled budget thinking are refused with zero base fetches. No sampling overlay was added, and harmless ignored model settings are not refused. OpenAI actual sampling-override conformance remains covered by P2.

### Lifecycle / route / reporting details

- A preparing claim exists before any auth/dialog await. Confirmation is raced against the injected unref'd clock and an AbortSignal; every subsequent action checks the original epoch/session/token. All session_shutdown reasons revoke preparing or cancel running work immediately, never awaiting IO or persistence.
- `MeasureSendFn` forwards build vs replay, fixed caps/retention, liveness guard, signal, route closure, expectWireModel and every run-wide expectRouteKey. Validator expectations add configured forbiddenKeys; Completions rejects a present key differing from the clamped prefix sessionId. An effective tier cannot silently change between builds in one run.
- Renewal's official-origin basis comes from the actual wrapped-fetch request URL, not a guessed model/auth base URL. Persisted status lists redacted labelled routes and explicitly says they are not verified as the current authenticated route.
- Progress/status report estimates and save state but no running spend; only the final notice and result file carry known/unreported cost. Results show per-gap verdicts, observed-load labels, expiry-or-eviction wording, detectable backend mismatches and the undetectable-split residual, never a false renewal claim. Copyable promptCache hints do not configure pi and warn when read renewal is unproven.

### Verification

`timeout 280 npm run typecheck` — exit 0 (`tsc` source + contract + `vue-tsc`).

`timeout 280 npm run build` — exit 0 (`tsc -p tsconfig.build.json`).

`timeout 600 npx vitest run tests/cache-ttl tests/conformance tests/integration/cache-ttl-measure.test.ts tests/integration/cache-keepalive.test.ts tests/integration/keepalive-pipeline-service.test.ts tests/web-hub/agent` — exit 0:

```text
 Test Files  127 passed (127)
      Tests  2603 passed | 17 skipped (2620)
   Start at  00:23:31
   Duration  105.31s (transform 7.86s, setup 2.13s, collect 45.24s, tests 290.45s, environment 22ms, prepare 6.89s)
```

The required full `timeout 900 npm test` is recorded below after completion. Log files are `/tmp/p4-measure-target.log` and `/tmp/p4-measure-full.log` (test output only, no live credentials).

### Real-machine acceptance / remaining gate G-c

No real endpoint was contacted. After explicit user budget approval:

1. In an interactive **main** session, select a real managed-effort Anthropic route (`supportsMidConvoEffort:true`) and an OAuth-authenticated Anthropic route (one route may cover both). Run `/cache-ttl measure Provider/Model --estimate` first; review both estimates, conditional C1/C2/C3 assumptions, the hard 17-request cap and the 80-minute deadline.
2. Only after approving that run's spend, run `/cache-ttl measure Provider/Model --yes` (or omit --yes and accept the 60s local dialog). Keep max_tokens exactly 1: do not raise it if the real managed-effort provider rejects adaptive thinking with that cap. OAuth acceptance must use the real login/token path; the validator requires the exact stock leading identity, not arbitrary extra text. A rejecting endpoint is an honest failed acceptance, not permission to relax the validator.
3. Check `/cache-ttl measure status`, the labelled route/effective tier, write/control results, per-gap hit/miss table, save state and final known/unreported cost. Misses must say expiry-or-eviction, no TTL ceiling; renewal is true with its basis/assumptions or unknown, never a v1 false. Leave the session alive for the experiment; /reload, /new, /resume, fork or exit must cancel it. Do not expose auth headers/tokens in acceptance notes.
4. Repeat the estimate/approval/run on one real openai-responses route. Compare only as an empirical sanity check against `protocol-probe-results.md` (cr-response previously hit at 6 min and missed by 11 min; renewal may honestly be unknown(pair-ineligible)). A long-retention run is a separate opt-in spend: estimate with --long first, confirm effective tier/Anthropic landed1h and never silently downgrade/promote the requested tier.
   Notes: a full run needs the main session to stay open for up to ~80 minutes (the hard deadline); the user can keep
   working in it. Results are stored in `<agentDir>/cache-ttl-measurements.json` (default
   `~/.pi/agent/cache-ttl-measurements.json`, mode 0600, one latest record per route); deleting that file clears every
   learned result.

5. Do not automatically apply the copyable models.json hint or alter keepalive cadence. P5 consumers remain separate; an unknown renewal result is not evidence that a native 90%-TTL warmer can renew the entry.

### P4 final full-suite output

`timeout 900 npm test` — **exit 0**, after the final typecheck/build/owned-file formatting gates:

```text
 Test Files  1149 passed (1149)
      Tests  21943 passed | 22 skipped (21965)
   Start at  00:27:28
   Duration  243.47s (transform 26.52s, setup 14.81s, collect 250.83s, tests 1400.37s, environment 25.60s, prepare 60.92s)
```

The existing skipped conformance cases were not enabled or altered. No new P4 test is skipped. The full suite's expected failure-path stderr did not produce any failed test. Prettier on the thirteen changed code/test/AGENTS paths printed `All matched files use Prettier code style!`; the appended report is checked as well. `git diff --check` exits 0. The full command's outer gate log is `/home/bluecake/.pi/agent/bash-jobs/01a14f77-c871-77e8-9185-0fd4654dbc0f/b_636FZK55.log`.

### Fix: C2 output allowance (live finding)

User acceptance on cr-response/gpt-6.1-sol reported 32 output tokens (25 reasoning tokens) for a max_output_tokens=16 request. The wire cap is a request hint, not a reliable bound on relay-reported reasoning-inclusive output. This fix keeps `OUTPUT_CAP` **1 / 1 / 16**, validator cap checks and C1/P_bound unchanged, and adds frozen `OUTPUT_ALLOWANCE_TOKENS` **64 / 512 / 512** (Anthropic / Completions / Responses).

- `measure-classify.ts` / `measure-runner.ts`: C2 compares observed output to the per-profile allowance, not the wire cap. Output 32 and exactly 512 on Responses continue normally; 513 stops after one request. C1 still rejects P_bound+1 exactly as before.
- `measure-plan.ts`: conditional worst prices the output allowance at the same P_bound prompt tier; missing-output/lost-usage accounting also uses the allowance so unreported cost cannot be understated. Typical cost keeps the wire-cap assumption and is unchanged. Printed conditions distinguish `C2 output ≤ 512 token(s) (wire cap 16)`. The Sonnet-class short conditional worst changes from about $1.33 to $1.35; neither prompt budget nor request-count cap changes.
- `MeasureRunRecord.boundExceeded` additively records `{ condition, observed, limit }`. Final notice and measure status render compact English diagnostics such as `C2 output 513 > 512` or `C1 prompt 20914 > 20913`. First-write failures now retain the actual sent route and persist the diagnostic record, instead of losing the result before the ordinary write anchor was established. Older records without details still render safely. Other failure-persistence semantics are unchanged.
- Reasoning investigation: pi-ai 1.2 `openai-responses.js:177–188` supports SimpleStreamOptions `reasoning:"minimal"`, uses `clampThinkingLevel` and maps the requested effort into the stock `{ reasoning:{effort,summary:"auto"}, include:["reasoning.encrypted_content"] }` construction at lines 266–276. P4 uses that option for Responses reasoning-capable models, with the real model's supported level/mapping; an off-only model leaves it unset. The validator requires the exact mapped effort, summary and encrypted-content include when this path is requested; sampling cannot promote it to high effort or add a thinking budget. Build-only optional transport `reasoning` and validator-expectation `reasoningEffort` fields carry this request; replay remains byte-identical and never rebuilds/raises caps. Real registry tests cover minimal and clamping to low when minimal is disabled. Completions is deliberately unchanged: its vendor-specific minimal paths (`openai-completions.js:622–725`) can enable thinking/template flags and budget fields; there is no single clean stock construction across those compat profiles to apply in this focused fix. No promise is made that a relay honours minimal effort or its wire cap.

Changed source: `measure-types.ts`, `pipeline-ping-types.ts`, `pipeline-ping.ts`, `measure-classify.ts`, `measure-plan.ts`, `measure-runner.ts`, `measure-command.ts`, `measure-payload.ts`. Deliberately updated allowance/tier/cost expectations in `measure-classify.test.ts`, `measure-plan.test.ts`, `measure-command.test.ts`, `measure-runner.test.ts`; added actual-registry output32/512/513, minimal/clamp/replay and diagnostic-persistence assertions in `measure-openai-build.test.ts` and `measure-build.test.ts`. No unrelated assertions were relaxed. No live endpoint contacted and no commit created; the running Anthropic acceptance instance was not touched.

Verification:

- `timeout 280 npm run typecheck` — exit 0 (`tsc` source + contract + `vue-tsc`).
- `timeout 280 npm run build` — exit 0.
- `timeout 600 npx vitest run tests/cache-ttl tests/conformance/measure-build.test.ts tests/conformance/measure-openai-build.test.ts tests/integration/cache-ttl-measure.test.ts` — exit 0:

```text
 Test Files  38 passed (38)
      Tests  1210 passed (1210)
   Start at  09:37:34
   Duration  4.15s (transform 1.99s, setup 742ms, collect 9.18s, tests 6.78s, environment 7ms, prepare 2.12s)
```

Prettier check on all fourteen changed code/test files and this report passes; `git diff --check` exits 0. Test log: `/tmp/measure-c2-target.log`. The requested real cr-response rerun still needs the main session's approval; these regressions use real local registry/builders with fake SSE only.

### Fix: live round 2

Known fail-safe outcome (verifier follow-up): `clampThinkingLevel(model, "low")` can return `off` when the model's supported-level map disables thinking. The command deliberately leaves the build reasoning option unset in that case; pi may emit its default no-reasoning/`none` request. A copilot-style endpoint can reject that with HTTP400: the run sends exactly one request, stops honestly, and shows/persists the redacted provider excerpt. This is accepted behaviour, not a reason to force an unsupported effort or retry/raise a cap.

- **Responses effort:** request `reasoning:"low"` instead of `minimal` for reasoning-capable Responses models. The option still passes through pi's `clampThinkingLevel` and the model's thinkingLevelMap; the actual-params validator expects that exact mapped stock construction. Real registry tests cover a no-map relay fixture rejecting anything except low, a low→medium model mapping, unchanged wire max_output_tokens=16, and byte-identical replay. Completions/Anthropic effort and wire caps are unchanged. The earlier C2 allowance (64/512/512) remains unchanged.
- **HTTP400 diagnosis:** the existing bounded error-body path extracts only JSON `error.message`, `message` or string `detail`, never other fields or response headers. Before the 160-character cap, it scrubs request auth-header literals (kept local only), credential/key assignments, bearer/basic values, token-shaped strings, URLs and terminal controls. The optional measurement annex carries only the resulting excerpt; the runner persists `{httpError:{status:400,message}}` against the actual sent route even for a first-write failure. Final notice and measure status display `http-400: <excerpt>`; the compact footer remains English tokens, without provider prose. Missing/malformed or over-cap JSON cannot introduce raw fallback bodies. A real registry/SDK fake-400 regression verifies the final notice, saved record and fresh-activation status, ≤160 characters and absence of test keys/URL credentials/headers.
- **Footer root cause/fix:** `started.done` could set `io-pending` while the claim was draining, but no event refreshed the status after `ioSettled` freed it. A runner callback now fires synchronously AFTER the physical ledger settles; the command clears the footer only when the original session/activation epoch and claim generation still match and the claim is free. Already-settled completion also explicitly clears the footer. There is no polling, interval or added timer, and late old-session callbacks cannot clear a newer run.
- **Save-time root cause/fix:** `store.lastSavedAt` belonged to the process-wide writer, not the current run. The concrete store now attributes successful write acknowledgments to runId via `lastSavedAtFor(runId)`; it records no timestamp merely for a persist intent, and keeps at most 128 run times (two records per retained-route cap), shared across reload stores. Runner progress and run-specific final/status text use that timestamp. A new run starts `not saved yet`, never the prior run's `saved 10m ago`. Old minimal test ports retain a conservative fallback which hides their pre-run timestamp. The global writer timestamp is retained for explicitly process-level historical status.

Changed files: `measure-command.ts`, `measure-types.ts`, `pipeline-ping-types.ts`, `pipeline-ping.ts`, `measure-runner.ts`, `measure-store.ts`, `measure-claim.ts`, their focused command/store/conformance/integration tests and this appended report. Tests exercise completed-but-physically-pending final IO, footer clearing with zero pending timers, a new run after a ten-minute gap, concrete-store success/failure save attribution and reload sharing. No commit, live endpoint request, keepalive scheduling change, or changes to the running independent acceptance instance.

Final verification:

- `timeout 280 npm run typecheck` — exit 0.
- `timeout 280 npm run build` — exit 0.
- `timeout 600 npx vitest run tests/cache-ttl tests/conformance/measure-build.test.ts tests/conformance/measure-openai-build.test.ts tests/integration/cache-ttl-measure.test.ts` — exit 0:

```text
 Test Files  38 passed (38)
      Tests  1215 passed (1215)
   Start at  10:06:14
   Duration  4.08s (transform 2.03s, setup 706ms, collect 9.14s, tests 6.45s, environment 7ms, prepare 2.15s)
```

Prettier check on the eleven changed code/test files and this report passes; `git diff --check` exits 0. Log: `/tmp/measure-round2-target.log`. Real copilot-response acceptance should be re-run by the main session after approval; no provider call was made here.

Verifier follow-up (`verify-round-2-live-fixes`, `r_C3BJE82J`): the round-2 section above is present and now explicitly includes the accepted off-clamp outcome. Added the two missing lifecycle tests in `tests/cache-ttl/measure-command.test.ts`: a captured old-generation physical-settlement callback performs no status write during a newer run or after that newer generation frees its claim; shutdown mid-IO retains `io-pending` until physical settlement, then clears the marker without a completion notice or polling timer. The latter exposed one small production gap in `src/cache-ttl/measure-command.ts`: shutdown previously cleared the footer immediately. It now retains a pending marker tied to shutdown epoch/session/generation, which only the corresponding settlement may clear; a same-activation session replacement rebinds that marker to the new context while still draining. Other round-2 changes/files are listed above. No new effort behaviour, no commit, and no live provider call.

Follow-up verification:

- `timeout 280 npm run typecheck` — exit 0.
- `timeout 280 npm run build` — exit 0.
- `timeout 120 npx vitest run tests/cache-ttl/measure-command.test.ts tests/cache-ttl/measure-runner.test.ts tests/cache-ttl/measure-store.test.ts tests/conformance/measure-openai-build.test.ts tests/conformance/measure-build.test.ts tests/integration/cache-ttl-measure.test.ts` — exit 0:

```text
 Test Files  6 passed (6)
      Tests  227 passed (227)
   Start at  10:11:10
   Duration  2.80s (transform 816ms, setup 227ms, collect 4.06s, tests 5.02s, environment 1ms, prepare 322ms)
```

Prettier check on all round-2 changed code/test files and this report passes; `git diff --check` exits 0. Follow-up output: `/tmp/measure-round2-followup.log`.
