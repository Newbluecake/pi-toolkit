# Dynamic keepalive window cap — implementation report

Date: 2026-10-18. Plan: [`dynamic-cap-plan.md`](dynamic-cap-plan.md), with §10 用户裁定 and final §R2 authoritative. No commits, stash, checkout, or reset performed. Concurrent CI-fix work was preserved.

## 1. Changes by plan section

### §2.1 Pure cap computation and status text

- Added `FALLBACK_WINDOW_CAP=11`, `WINDOW_CAP_CEILING=96`, `WindowCap`, `pickRateTier`, and `computeWindowCap` in `keepalive-state.ts`.
- W/R come from one complete price tier, selected by the greatest threshold **strictly below** the real request's total input. Missing tier fields do not borrow base rates. No 8192-token heuristic remains.
- Checks finite positive prices and a finite ratio before clamping. The 4-ULP integer convention applies the strict non-profitable-equality rule. Final priced cap is `max(0, raw)`; raw above 96 yields `clamped`, cap 96, and `rawCap`.
- Added `realRequestInputTokens`, validating the window-opening assistant response's `input + cacheRead + cacheWrite`; missing, negative, non-finite, malformed, or error/abort usage stays unknown.
- Added optional config source/raw/reason fields; retained `maxPings` and gate #14 unchanged. Existing dollar cost estimators are unchanged.
- Reports include priced/clamped/fallback suffixes. Non-safe raw integers are not printed. A capture-less window without a stop reason renders cumulative `ping Σ…` and `window: ended (Σ… pings)` rather than comparing old counts against the next model's cap.

### §2.2 Captured-model pricing and service wiring

- `resolveCapModel` calls `registry.find(captured.provider, captured.modelId)`, requiring matching API and base URL. Missing/throwing registry lookup, unknown wire ID, or mismatched route falls back with `wire-model-unmapped`; no alias guessing and no `ctx.model.cost` substitution for cap pricing.
- Price data is snapshotted and memoized per capture, including cloned tiers. A registry refresh, even an in-place edit before the real response arrives, cannot reprice that window. New captures resolve afresh. No-capture status resolves the current context model through the same path, with total input zero for the prospective base tier.
- Extended the existing `noteRequestSettled` metadata with optional full input tokens. Only the current in-flight capture's route-matched response can supply it; duplicate settle events cannot overwrite it. Main and child `message_end`/`turn_end` forwarders supply the response usage, never a latest-ledger scan of previous requests.
- Tiered capture without that response usage is fallback 11, `tier-uncertain`; non-tiered prices need no usage.
- Budget-exhausted terminal audits carry `cap`, `capSource`, optional `capRaw`, and optional `capReason`. Cap pricing still precedes `evaluateTick`; child unpriced/$/ledger admission still runs only after `evaluateTick` returns ping.
- No `capOverride`, new settings, timer, network route, or registry/ledger behavior changes were introduced. Child 24/run, concurrency 4, $1.5/run, and $10/24h budgets remain unchanged.

### §2.3–§2.4 Removed setting and status-only migration

- Removed the live `keepaliveMaxPings` field, default, parser behavior, and setting spec.
- Parser records only optional read-only `legacyKeepaliveMaxPings`: the finite raw number, or `"invalid"` when the old key is present but invalid. No old key means no metadata field. All values, including 0, are ignored for enablement and cap; parsing/loading emits no legacy-cap warning and never rewrites user settings.
- `/cache-ttl status` appends the exact §R2-5 deprecation sentence, then `legacy value: N` or `(invalid)`. It also works with an unavailable/disabled service. No session-start notification was added.

### §2.5 Web projection, protocol, and UI

- Kept protocol version unchanged. Appended optional `window.maxSource?: string` and `window.ended?: boolean` to the open wire schema.
- Projection copies dynamic max/source and flags ended windows. The expanded panel shows English `ended` instead of stale `20/11`; missing/false `ended` retains the old ratio presentation. Source titles explain priced, clamped, or fallback caps without changing inline text.
- No hub daemon changes or new endpoint/SSE frame. Existing 8 KiB projection budgeting, fingerprint gating, and no-`armed` contract remain intact.

### §2.6 Documentation

- Updated the guide and AGENTS.md cache-TTL paragraph: dynamic prefix budget, 0–96 cap, fallback 11 without profitability proof, full-response tier selection, removed-key behavior, non-live master wiring, and unchanged child budgets.
- Added supersede notes to the original plan's §0.3, §6.2, and settings table, and to the web/child plans. Historical design text was not rewritten. CHANGELOG was not touched.

## 2. Authoritative-ruling checklist

| Ruling                                                        | Result                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1 / R2-5: ignore every old value, including 0; status only   | Implemented; numerical/zero/invalid/absent tests, repeated parse/load, no startup notify, real stack and child registration               |
| D2: sentinel 96 is fixed and labeled clamped                  | Implemented; 96 priced vs 97+ raw clamped, huge finite ratios, report and terminal-audit tests                                            |
| D3 / R2-2: retain cap 0 and normalize negative raw            | Implemented; q around 1 and 2, zero-network service test, cap always integer in [0,96]                                                    |
| D4: no capOverride; use price fixtures                        | Implemented; small cap uses W=3R, large fixtures use W=52R; Fable 48/window tests 24/run binding                                          |
| R2-1: same real response's full usage, not prefix lower bound | Implemented; >8192 uncached input and multi-tier crossings, uncertain usage fallback, response route/dedup guards, main/child integration |
| R2-3: optional web ended + expanded ended row                 | Implemented; 20 old pings/new max 11 projection and component assertions                                                                  |
| R2-4: property branch scope                                   | Implemented; maximality only for priced, clamped budget/source/raw separately, fallback value/reason examples                             |

## 3. Test coverage

Primary behavior-bearing suites (final requested run):

```text
✓ tests/cache-ttl/keepalive-cap.test.ts (63 tests)
✓ tests/cache-ttl/keepalive-state.test.ts (117 tests)
✓ tests/cache-ttl/keepalive-lifecycle.test.ts (42 tests)
✓ tests/cache-ttl/keepalive-child.test.ts (33 tests)
✓ tests/cache-ttl/cache-ttl.test.ts (25 tests)
✓ tests/config/cache-ttl-settings.test.ts (24 tests)
✓ tests/integration/cache-keepalive.test.ts (6 tests)
✓ tests/integration/cache-ttl-removal.test.ts (3 tests)
✓ tests/integration/child-keepalive.test.ts (11 tests)
✓ tests/web-hub/agent/cache-keepalive-projection.test.ts (28 tests)
✓ tests/web-hub/ui/cache-keepalive-panel.test.ts (25 tests)
```

The pure suite includes all plan price examples, integer neighborhoods, overflow/subnormal/NaN/Infinity/string/negative prices, strict tier boundaries, missing tier fields, missing usage × tiered/non-tiered models, and 2,000 seeded property cases. Service tests cover wire B vs ctx A, missing/throwing/mismatched mapping, memoization, in-place registry edits, model drift, cap-zero no network, clamped/fallback terminal audit metadata, and every §6 admission-matrix class. Existing capture/header, retry, breaker, ledger, settings, protocol, and UI suites also ran.

## 4. Verification commands and real output

Executed from `/home/bluecake/ai/pi-toolkit`.

### Requested typecheck — exit 0

```sh
timeout 280 npm run typecheck
```

```text
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
exit=0
```

### Requested test scope — exit 0

```sh
timeout 900 npx vitest run tests/cache-ttl tests/config tests/integration/child-keepalive.test.ts tests/integration/cache-keepalive.test.ts tests/integration/cache-ttl-removal.test.ts tests/web-hub/agent tests/web-hub/protocol tests/web-hub/ui
```

```text
 Test Files  346 passed (346)
      Tests  8041 passed | 3 skipped (8044)
   Start at  16:28:59
   Duration  46.77s (transform 27.05s, setup 8.77s, collect 113.50s, tests 114.33s, environment 34.05s, prepare 24.23s)
exit=0
```

### Requested web build and dist checks — exit 0

```sh
timeout 300 npm run build:web && timeout 200 npm run check:web
```

```text
✓ 694 modules transformed.
../../../dist/web-hub-ui/assets/CacheKeepalivePanel-DHABszKz.js    7.38 kB
✓ built in 7.79s
> pi-toolkit@0.6.0 check:web
> tsx scripts/web-hub/check-ui-dist.ts
✓ check:web — dist/web-hub-ui/ OK (18 files, first-screen JS 281674B gz/524288B, lazy JS 44465B gz/131072B, CSS 30197B gz/65536B)
exit=0
```

Vite also emitted its non-fatal >500 kB chunk advisory. `check:web`'s actual budget gates passed.

### Build, formatting, and diff — exit 0

```sh
timeout 280 npm run build
timeout 90 npx prettier --check $(cat /tmp/dynamic-cap-owned-files.txt)
git diff --check
```

```text
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
Checking formatting...
All matched files use Prettier code style!
```

The temporary manifest contains only the absolute-path manifest below (repository-relative arguments), including this report for the final formatting check. No concurrent agent file is included.

### Additional full suite — final exit 0

```sh
timeout 900 npm test
```

```text
 Test Files  1113 passed (1113)
      Tests  20912 passed | 22 skipped (20934)
   Start at  16:30:04
   Duration  256.90s (transform 31.17s, setup 17.91s, collect 290.78s, tests 1417.37s, environment 32.91s, prepare 73.40s)
exit=0
```

Traceability: an earlier full run at 16:21:55 reported three out-of-scope failures: `tests/bash/manager.test.ts:858` (`notifiedAt` undefined), `tests/date/core.test.ts:77` (actual 3h vs expected 1h), and `tests/date/wire.test.ts:145` (21:00 vs 19:00). Those files were not changed by this implementation. An isolated rerun of those three files passed 128/128 tests, followed by the final all-green full run above. The workspace is shared with concurrent CI-fix work, so the full-suite result reflects the combined working tree, not this change in isolation.

## 5. Changed-file manifest (absolute paths)

### Runtime and protocol

- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/settings.ts`
- `/home/bluecake/ai/pi-toolkit/src/config/setting-specs.ts`
- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/cache-ttl.ts`
- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/child.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/cache-keepalive.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/messages.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/detail/CacheKeepalivePanel.vue`

### Tests

- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-cap.test.ts` (new)
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-state.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-lifecycle.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-child.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/cache-ttl.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-breaker.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-evidence.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-ping-retry.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/probe.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/config/cache-ttl-settings.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/cache-keepalive.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/cache-ttl-removal.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/integration/child-keepalive.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/cache-keepalive-projection.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/cache-keepalive-panel.test.ts`

### Documentation

- `/home/bluecake/ai/pi-toolkit/docs/guide/context.md`
- `/home/bluecake/ai/pi-toolkit/AGENTS.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/plan.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/webhub-plan.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/child-context-switch/plan.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/dynamic-cap-report.md` (new)

## 6. Deviations, boundaries, and remaining items

- No functional deviation from the final rulings. The earlier §2.2 instruction to leave child logic untouched except comments is superseded by R2-1: child response hooks now forward **usage metadata only** so tier selection can use the same real response. Child admission, capture-only behavior, disposal, retry, ledger, and dollar estimation logic were not changed.
- The §1.2 prefix/8192 heuristic, §2.4 startup notification, and §2.5 claim that no ended field is needed were deliberately not implemented: final §R2 replaces them.
- Known accepted semantics remain: fallback 11 is not a profitability proof; the cap excludes uncached input/output; an unmapped wire alias falls back rather than guessing; windows/captures are not restored across reload.
- All requested self-checks and the final full suite pass. Independent cross-model verifier acceptance was not run in this implementation session (no Agent dispatch tool exposed); this report and manifest are ready for the orchestrating session's verifier.
- Concurrent CI-test files/configuration were not edited. A broad early formatting manifest briefly included concurrently modified `tests/bash/process.test.ts`; Prettier explicitly reported `(unchanged)`, and it was excluded from this implementation's manifest and subsequent checks.
- No commit, push, release, CHANGELOG edit, or destructive git operation. No known implementation blocker remains.

## Follow-ups after r_FFWC8SBT

Date: 2026-10-18. The user reported independent verifier `verify-keepalive-dynamic-cap` (`r_FFWC8SBT`) as **conditional pass, zero blockers** and requested the following presentation/coverage corrections plus a new Copilot billing ruling. This section supersedes the initial report's no-capture base-tier pricing and blanket capture-less `ended` presentation. No commit was made.

### Findings and fixes

1. **Never-opened vs ended windows:** added the shared pure `isKeepaliveWindowEnded` predicate for report and web projection. `ended` requires no capture, no stop reason, and `windowEpoch > 0 || pings > 0`. A never-opened window keeps `window: 0/11 (idle)` and does not project `window.ended`. Invalidated windows with zero pings and prior-ping windows with a zero epoch both still count as ended. Existing miss/stopped presentation is unchanged.
2. **Actual fallback reasons:** status now prints `fallback: ${maxPingsReason}`, defaulting to `unpriced` only when absent. Missing cost data now emits `unpriced` rather than `no-cost`, so generated reasons use the requested vocabulary: `unpriced`, `no-read`, `no-write`, `write-le-read`, `non-finite`, `tier-uncertain`, `tier-incomplete`, and `wire-model-unmapped`. Tests assert every token, plus compatibility for a missing reason.
3. **Tiered model before response usage:** chose the clearer **`cap: 11/window (fallback: tier-uncertain)`** behavior, rather than hiding the source. No-capture lookup no longer invents total input zero. Tiered models stay uncertain before the first capture and after invalidation until the new window-opening response supplies its full usage; non-tiered models remain priced without usage. Explicit, genuinely known total input zero still selects the base tier in the pure function.
4. **Main-session forwarding coverage:** added direct `wireCacheTtl` hook tests for **both** `message_end` and `turn_end`. They assert exactly one service call with `input + cacheRead + cacheWrite = 55017`, a deliberately contradictory prior ledger ignored, output tokens excluded, and partial usage forwarded as unknown. Existing main-session full-tier integration coverage remains intact.
5. **New user ruling — token-billed Copilot:** removed the sole `github-copilot` deny entry by deleting the now-unnecessary `PING_DENY_PROVIDERS` constant and its membership check. Provider names no longer determine admission. `anthropic-messages`, cache breakpoints, fingerprint, liveness, budget, native-warmer, and breaker gates still apply. Updated the original plan with an explicit G4/constants supersede note and added the current Copilot rule to the guide and AGENTS.md. Regression tests assert Copilot Anthropic admission, non-Anthropic rejection, and an actual service ping with the registry-derived cap.

### Regression evidence

The five focused suites were run **before** the production fixes and reproduced the intended behavior failures (the new main-session forwarding tests already passed):

```text
 Test Files  4 failed | 1 passed (5)
      Tests  15 failed | 282 passed (297)
```

After the fixes:

```text
✓ tests/cache-ttl/keepalive-state.test.ts (130 tests)
✓ tests/cache-ttl/keepalive-lifecycle.test.ts (44 tests)
✓ tests/cache-ttl/keepalive-cap.test.ts (63 tests)
✓ tests/web-hub/agent/cache-keepalive-projection.test.ts (31 tests)
✓ tests/cache-ttl/cache-ttl.test.ts (29 tests)
 Test Files  5 passed (5)
      Tests  297 passed (297)
```

### Follow-up verification — real output

```sh
timeout 280 npm run typecheck
```

```text
> pi-toolkit@0.6.0 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
exit=0
```

```sh
timeout 900 npx vitest run tests/cache-ttl tests/config tests/integration/child-keepalive.test.ts tests/integration/cache-keepalive.test.ts tests/web-hub/agent tests/web-hub/ui
```

```text
 Test Files  309 passed (309)
      Tests  6716 passed (6716)
   Start at  16:47:29
   Duration  36.21s (transform 18.86s, setup 7.10s, collect 81.79s, tests 99.59s, environment 27.54s, prepare 17.43s)
exit=0
```

Additional build:

```sh
timeout 280 npm run build
```

```text
> pi-toolkit@0.6.0 build
> tsc -p tsconfig.build.json
exit=0
```

Formatting and diff checks:

```sh
timeout 90 npx prettier --check $(cat /tmp/dynamic-cap-followup-files.txt)
git diff --check
```

```text
Checking formatting...
All matched files use Prettier code style!
```

The temporary formatting manifest is an explicit allowlist of the 12 follow-up files below, not a whole-working-tree scan. No README, images, screenshot scripts, CI configuration, or concurrent test-fix file was edited. The original full-suite results above are historical; this follow-up ran the newly requested 309-file scope and focused regression suites, not another full `npm test`.

### Follow-up changed files (absolute paths)

- `/home/bluecake/ai/pi-toolkit/src/cache-ttl/keepalive-state.ts`
- `/home/bluecake/ai/pi-toolkit/src/service/cache-keepalive.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/cache-keepalive.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-state.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-cap.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/keepalive-lifecycle.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/cache-ttl/cache-ttl.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/cache-keepalive-projection.test.ts`
- `/home/bluecake/ai/pi-toolkit/docs/guide/context.md`
- `/home/bluecake/ai/pi-toolkit/AGENTS.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/plan.md`
- `/home/bluecake/ai/pi-toolkit/docs/dev/cache-ttl-keepalive/dynamic-cap-report.md`

No known follow-up blocker remains. No commit, push, release, or destructive git operation was performed.
