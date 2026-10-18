# Keepalive beyond `anthropic-messages`: OpenAI Responses / Chat Completions (plan r3)

Status: plan **r3**, 2026-10-18. Not implemented. **Depends on `capture-pairing-plan.md` (Part A)**, which fixes the
existing capture mis-pairing and provides the per-call token this plan uses for real-traffic evidence.

- r2 was rejected by `r_Y7GVA7DZ` (3 blockers + 12); the mapping is in §R2. r1 history is in §R1.
- The user-ruling blocks at the end are authoritative and kept verbatim.
- Lane **L3**: dev work starts only after this plan passes re-review; verifier ≠ dev model.

## 0. Candid assessment and the proposed minimal v1

Two rejections came for the same reason. Pinging an OpenAI-style route _correctly_ needs:

- **proof that the replay is the real request**: Part A, plus wire conformance;
- **proof that usage is real**: pi-ai fills missing fields with 0;
- **proof that a TTL sample compares the same prefix**;
- **money accounting**, which is unbounded without a miss breaker.

Each is small, but together they are a large, evidence-heavy feature. The value is real but modest. One avoided miss
on a 20k-token prefix saves about $0.04 (gpt-6.x via Copilot) or $0.054 (kimi); at 200k it is ten times that.
It pays only during long armed idle gaps (long tool runs) on routes whose cache expires within minutes.

**Zero-code alternative available today.** pi's native `CacheWarmer` (`pi-coding-agent dist/core/cache-warmer.js`)
already keeps OpenAI routes warm when the user declares `promptCache: { short: <seconds> }` on the model in their own
`models.json`. It refreshes at 90% of that TTL under pi's own expected-savings rule, and keepalive yields to it
(gate #4.5 `native-warmer`). It is static (user-declared TTL, no learning) and lives in user data, which the
no-provider-names ruling allows. See Q2.

**Minimal correct v1** (this plan specifies v1; deferred items are named, not designed):

| In v1                                                                    | Deferred (v2+)                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Main session only (`tui`/`rpc`)                                          | Child sessions: needs the ledger, reservations, late settlement, print-mode IO |
| One attempt per ping, no retries                                         | Retry policy for openai                                                        |
| Responses + Completions, strict replay profile (§2.2)                    | Server tools, `store:true`, `github-copilot` built-in, non-default tiers       |
| Learner from natural samples with own-prefix proof (§3)                  | —                                                                              |
| p̂ + all-or-nothing price cap, per route (§5); no miss breaker            | —                                                                              |
| Refresh-proof **diagnostics only** (§4)                                  | —                                                                              |
| `/cache-ttl status` route line                                           | Web panel field                                                                |
| pi-ai transport behind a capability probe; verified versions only (§2.1) | Hand-written transport                                                         |

## 1. Requirements (see the ruling blocks)

1. Anthropic behaviour is byte-identical beyond Part A's fix.
2. No provider-name keys: route = protocol + effective endpoint + wire model + retention mode, with the route's own
   evidence.
3. Passive cold start: no pings before the route's own first natural idle miss.
4. **No miss breaker, and no admission gate other than economics.** Pings stop only when the live cap reaches 0.
5. Default mode `auto` for both protocols.
6. Full tiny verbatim replay whose outcome is provable from **raw** usage.
7. Zero-hang, with separate return deadline, settlement and IO-occupancy accounting (§6).

## 2. Ping transport and replay

### 2.1 Transport through pi-ai's provider code, behind a probe (findings #4, #5)

- **Entry point**: `@earendil-works/pi-ai/compat`, i.e. `openAIResponsesApi()` / `openAICompletionsApi()` →
  `{ stream }`. It is exported in package `exports` (`"./compat"`) and aliased by the extension loader
  (`pi-coding-agent dist/core/extensions/loader.js:59,67`). The package root (`dist/index.js`) does **not** export the
  factories, so tests and runtime both import the `/compat` subpath.
- **Runtime capability probe** (`src/cache-ttl/openai-transport.ts`), lazy at the first openai ping and never at
  activation: `await import(".../compat")` inside `try`. It checks that each factory is a function returning an object
  with a `stream` function. On failure the OpenAI path is disabled for the process (`transport-unavailable`, status
  line), and Anthropic and activation are unaffected.
- **Supported versions**: WP0b runs the wire conformance (§10) on the installed pi 1.2. The OpenAI path is enabled
  only when `pi-ai` `package.json` version ∈ the verified set. Today that is `1.2.x`; 1.0 / 1.1 stay disabled until
  verified (Q3). The peer range of the package is unchanged.
- **Call**: `stream(requestModel, { systemPrompt: "", messages: [] }, options)` with:
  - `requestModel` = the **capture-time snapshot** of `ctx.model` (api, baseUrl, headers, compat, cost), with
    `baseUrl = auth.baseUrl ?? snapshot.baseUrl`, the same substitution `applyAuth` makes;
  - `options` = `{ apiKey: auth.apiKey, env: auth.env, headers: captured headers + tombstones (Part A),
sessionId: capture.sessionId, cacheRetention, maxRetries: 0, timeoutMs: remaining, signal, fetch: boundedFetch,
onPayload: () => cappedPayload, onProviderStreamEvent: rawUsageProbe }`.
    `auth` comes from `ctx.modelRegistry.getApiKeyAndHeaders(model)`, which returns `apiKey`, `headers`, `baseUrl` and
    `env` (`model-registry.js:34-50`).
- **Reproduce the metadata, or refuse.**
  - `cacheRetention` is derived from the captured payload where it is observable. Responses: no `prompt_cache_key` ⇒
    `"none"`; `prompt_cache_retention:"24h"` ⇒ `"long"`; otherwise `"short"`. It is passed explicitly, including
    `"none"`.
  - For Completions, retention is not observable from the payload. Pass `undefined`, so it resolves exactly as the real
    call did: pi's agent passes no `cacheRetention`, and the env comes from `auth.env`.
  - The captured headers must contain every `auth.headers` entry with an equal value (applyAuth merged them).
    Otherwise refuse `auth-drift`.
  - The current `ctx.model` must equal the snapshot in api, baseUrl, headers digest and compat digest. Otherwise
    G7 invalidates (`fingerprint-drift:model-meta`).
  - **Gate:** the pinged route is enabled only after WP0b shows wire equality (body and headers) for that protocol on
    the verified pi version.
- **Excluded:** the `github-copilot` built-in provider. Its dynamic headers come from the transcript inside
  `createClient`, so a stub context cannot reproduce them.

### 2.2 Replayable profile (`src/cache-ttl/openai-replay.ts`, pi-free; findings #5, #12)

A ping is sent only if the captured payload passes every check; otherwise a terminal skip with the reason in
parentheses.

- **Both protocols**: `stream === true`; the cap field is **already present** (`max_output_tokens` /
  `max_completion_tokens` / `max_tokens`) (`no-output-cap`); `n` absent or 1; `service_tier` absent / `auto` /
  `default` (`unpriced-tier`); `tools[].type === "function"` only, plus `custom` on Responses (`server-tools`).
- **Responses**: **`store === false` explicitly** (`store-unknown` otherwise); no `previous_response_id`,
  `conversation`, `background` (`server-state`).
- **Completions**:
  - `stream_options.include_usage === true` (`no-stream-usage`);
  - none of `web_search_options`, `audio`, `prediction`, or `modalities` containing `audio` (`server-billed`).
- **Mutation**: only the existing cap field changes, to 16 (Responses floor) or 1. Everything else is verbatim:
  `reasoning`, `include`, encrypted items, `prompt_cache_key`, `prompt_cache_retention`.

### 2.3 Raw usage contract for pings (`rawUsageProbe`)

- Read the terminal raw frame (Responses `response.usage`; Completions the chunk carrying `usage`). `P` (prompt) and
  `O` (output) are required. `C` (cached) is `input_tokens_details.cached_tokens`, or for Completions the first present
  of `prompt_tokens_details.cached_tokens | prompt_cache_hit_tokens | cached_tokens`. Also read
  `cache_write_tokens` if present.
- All present values must be finite non-negative integers with `C ≤ P`. Otherwise the outcome is `no-usage`.
- Classes, with `slack(P) = max(512, ⌈0.02P⌉)` and `P_ref` = the captured request's raw settled prompt (§3.1):
  - `backend-mismatch`: `|P − P_ref| > slack`;
  - `hit`: `P − C ≤ slack`;
  - `miss`: `C < 0.5P`;
  - `partial`: anything else.
    Every class except `hit` counts as **non-hit** in p̂.

## 3. Route evidence from real traffic (`src/cache-ttl/ttl-evidence.ts`, pi-free; findings #6, #7, #14, #15)

### 3.1 Evidence channel for real requests (finding #6)

pi-ai normalises a missing cached count to 0, and hooks carry no endpoint. A real-request sample is therefore built
only from **token-scoped observations** under Part A's per-call token (`pairing.current()`). The token propagates to
every continuation of the call:

- `before_provider_request` → payload, P time `t_P`. With the strict fallback, the last P wins.
- `after_provider_response` (2xx) → `t_R` = response-header time, an upper bound for the successful attempt's start
  (pi-ai's internal retries resend without hooks).
- `provider_stream_event` (`sdk.js:236-246`, raw `data`) → raw usage from the terminal frame, under the §2.3 contract.
- **Effective endpoint**: `auth.baseUrl ?? ctx.model.baseUrl`. `getApiKeyAndHeaders` is resolved once per session per
  model with a bounded 10 s race and cached; unresolved ⇒ no sample.
- Missing token, missing raw usage, a non-2xx status, or an unresolved endpoint ⇒ **no sample**, and the request does
  not count as a confirmed touch.

### 3.2 Sample rules

- **Confirmed touch**: a real request with a 2xx response and raw usage, or a ping with raw usage. Its touch interval
  is `[t_P, t_R]` (pings: send time to response time). Anything unconfirmed breaks the chain.
- **Prefix preservation (finding #14, bounded first)**: before any serialization, a structural budget walk over the
  payload: ≤ 4096 items, ≤ 200 000 nodes, ≤ 8 MiB of string bytes, aborting early. Only then compute:
  - a header digest: all top-level keys except the item array and the cap fields;
  - one cyrb53 hash per item.
    Keep **two generations** (previous and current). A sample requires equal header digests and an item-hash prefix
    match. Over budget ⇒ no sample.
- **Natural sample** = the previous confirmed touch was a real request. `gap_lo = t_P(k) − t_R(k−1)` and
  `gap_hi = t_R(k) − t_P(k−1)`; it requires `gap_lo ≥ 60 s`.
- **Own-prefix size proof (finding #7)**:
  - Per route, `baselineMax` = the maximum `C` observed on a **fresh-lineage** request (no predecessor with a matching
    prefix).
  - **Hit** iff `C_k ≥ P_{k−1} − slack`, **and** `P_{k−1} − baselineMax ≥ 0.5·P_{k−1}`, **and**
    `P_{k−1} ≥ keepaliveMinPrefixTokens`. This makes a 4096-token baseline on a 4500-token prompt impossible to count
    as a hit.
  - **Miss** iff `C_k < 0.5·P_{k−1}`. Anything else ⇒ no sample.
  - Hit ⇒ record `gap_lo`, used for L (never overstated). Miss ⇒ record `gap_hi`, used for U (never understated).
- **Ping sample**: class plus `intervalS`. It never touches L / U.
- Hashing cost: one budget walk and one hash pass per request; acceptance target p99 ≤ 15 ms at a 2 MiB payload,
  measured by a benchmark test (reported, not gating CI).

### 3.3 Frozen types (shared by WP1–WP4)

```ts
export interface NaturalSample {
  gapS: number;
  hit: boolean;
  at: Millis;
} // gap_lo for hits, gap_hi for misses
export type PingClass = "hit" | "miss" | "partial" | "backend-mismatch" | "no-usage";
export interface PingSample {
  intervalS: number;
  cls: PingClass;
  at: Millis;
}
export interface TtlRouteRecord {
  v: 1;
  label: string; // api · host[:port] · model (display only)
  natural: NaturalSample[]; // ring ≤ 32, 30 d
  pings: PingSample[]; // ring ≤ 32, 7 d
  baselineMax?: number;
  zeroReadSessions: number;
  noCacheValueSince?: Millis; // O3, route-scoped (§7)
  proofs: { ok: number; failed: number; lastOkAt?: Millis }; // diagnostics only (§4)
  updatedAt: Millis;
}
export type RouteState = "learning" | "too-short" | "active";
export interface RouteCadence {
  state: RouteState;
  lowerS?: number;
  upperS?: number;
  intervalBaseS?: number;
  intervalS?: number;
  assumedTtlS?: number;
  pNonHit: number;
  pingN: number;
}
export function deriveRouteCadence(rec: TtlRouteRecord | undefined, now: Millis): RouteCadence; // pure
```

### 3.4 Route key and persistence (finding #15 safe directions)

- `routeDigest = sha256(api ∥ scheme+host lower-cased ∥ port ∥ path ∥ query ∥ wireModel ∥ retentionMode)`, truncated
  to 32 hex; userinfo and fragment are dropped. Records live in `provider-evidence.json` `ttlRoutes`: ≤ 200 routes,
  FIFO, 1 MiB file cap shared with existing data.
- **Evidence loss is always handled in the safe direction**:
  - FIFO eviction, ring trimming that drops the U-defining miss, a corrupt or unreadable file ⇒ `learning` ⇒ no pings;
  - two-process last-writer-wins can drop samples, giving fewer samples (safe) **or** reset the ping ring. A reset ring
    returns p̂ to its prior; that is bounded by `cap(prior)` per window and reconverges per §5.4. Disclosed, not
    prevented;
  - restart: the evidence is persisted, so nothing is lost.

## 4. States and cadence (finding #1)

- **U** = the minimum natural miss gap not refuted by a later natural hit with gap ≥ it. **L** = the maximum natural
  hit gap below U.
- `L_eff = L ?? min(180 s, ⌊U/2⌋)`. `I_base = clamp(⌊0.75·L_eff⌋, 90 s, U − 60 s)`.
- Ruling 2's cadence shrink is stateless: `I = max(90 s, ⌊I_base·min(1, 1.1 − p̂)⌋)`.
  `T_alive = max(I + 60 s, min(L_eff, U − 15 s))`.
- States:
  - `learning`: no U;
  - `too-short`: `U − 60 s < 90 s`;
  - `active`: otherwise.
- **No proof gate and no `unprovable` state.** r2's `cap ≥ proofPings` admission and the 7-day disable conflicted with
  ruling 2, so they are removed. Refresh proof (an all-hit ping chain from a real touch, strictly crossing U) is
  recorded in `proofs` as **diagnostics only** (status line). A relay that does not refresh shows up as non-hits after
  U, which raise p̂ and lower the cap (§5).
- **About the second-round Q1 ruling** ("证明失败 7 天后再试"): it applied to the proof gate, which no longer exists, so
  it has no object in r3. The 7-day lifetime of ping samples remains, as the aging of p̂ evidence.
- The window profile is set at the real request's confirmed settle, so the first idle miss enables pings in the same
  window.

## 5. Economics (findings #2, #9, #13)

### 5.1 Pricing identity

- Prices come from the **capture's wire model**: `resolveCapModel(provider, payload.model)` with api / baseUrl
  matching. They never come from `requestModel.cost`, which is what pi-ai's `usage.cost` uses; that figure is recorded
  only as a cross-check.
- Required prices: finite non-negative `input`, `cacheRead`, `output`, else `usd-unpriced` (terminal). There is no
  fallback 11.
- `input ≤ cacheRead` ⇒ cap 0 (`no-savings`).
- `W = input`, raised to `cacheWrite` if this route ever reported `cache_write_tokens > 0` and `cacheWrite > input`.
- Non-default `service_tier` is refused (§2.2), so the multiplier is 1.

### 5.2 Model (per prefix token, P = `P_ref`)

- `h = R + (slack(P)·input + capOut·output)/P` (hit bound); `m = W + capOut·output/P` (a miss is a full rewrite).
- `E(p) = (1−p)h + pm`; `S = W − R`.
- **Cap** = the largest `n ≤ 96` with `n·E(p) < (1−p)^n·S`; 0 if none.
- With `p = 0` and zero overheads this is exactly the Anthropic formula. Anthropic keeps calling
  `computeWindowCap(cost, input)` unchanged.

### 5.3 Worked table (P = 20 000 = default `keepaliveMinPrefixTokens`; probe prices)

| Probe-like evidence | L / U (s)  | I_base (s) | cap p̂=0.1 | cap p̂=0.2 | cap at p̂ min (1/42) | p*    | non-hits to cap 0: empty / full ring |
| ------------------- | ---------- | ---------- | --------- | --------- | ------------------- | ----- | ------------------------------------ |
| copilot-response    | 240 / 360  | 180        | 3         | 2         | 7                   | 0.464 | 7 / 19                               |
| cr-response         | 360 / 660  | 270        | 3         | 1         | 5                   | 0.434 | 6 / 18                               |
| cr-kimi             | 660 / 1260 | 495        | 3         | **1**     | 5                   | 0.436 | 6 / 18                               |
| cr-glm (marginal)   | 360 / 660  | 270        | 2         | 1         | 3                   | 0.376 | 5 / 15                               |
| zhipu-pool          | no miss    | —          | —         | —         | —                   | —     | `learning`: never pinged             |

The table is generated by a test from a price fixture (`tests/fixtures/keepalive-openai-prices.json`), so it cannot
drift. r2's kimi p̂=0.2 entry (2) was wrong; it is 1.

### 5.4 Honest bounds (replacing r2's false unconditional bound)

- **Per window**: `pings ≤ cap(p̂_min)`, where `p̂_min = 1/(32+10)` is the smallest estimate the 32-entry ring and the
  Beta(1,9) prior allow. That is 7 / 5 / 5 / 3 for the rows above, and never more than the 96 sentinel. The live cap
  can **rise** within a window as hits arrive, up to this bound.
- **Convergence**: on a route whose pings stop hitting, the cap reaches 0 after k consecutive non-hits, with
  `k = ⌈p*·(n_hits_in_band + 10) − 1⌉` bounded by the full-ring value (19 for copilot-like). This holds only while
  prices and `I_base` are unchanged and the samples stay in the band `[0.5, 1.25]·I_base`.
- **What can reopen pinging**: an `I_base` change (new natural evidence) moves the band; evidence loss resets the
  ring. Each reopens at most `cap(prior)` pings per window and then reconverges.
- **No per-session or per-day bound exists in v1, by ruling.** The cost per non-hit ping is
  ≤ `(P·W + O_bound·output)/1e6` (§6.2), e.g. about $0.04 at 20k and $0.4 at 200k for copilot-like prices.

## 6. Money and IO (findings #8, #9, #10; main session only in v1)

### 6.1 Single settlement owner

`runPing` has exactly one `settle(charge)` call, in its outer `finally`, and it runs exactly once.

- `charge` = our own `openaiPingCostUsd(raw usage, wire-model prices, tier)` when usage arrived; else the bound
  (§6.2) when the request may have been processed; else 0 when it never left.
- A late result (epoch mismatch) still settles `session.pingCostUsd` and its audit. It never mutates the window.
- After `dispose()`, a late settlement increments the process-level `lateAfterDispose` diagnostic only; there is no
  `appendEntry` on a stale ctx.
- Child-ledger leases are deferred with child sessions.

### 6.2 Verifiable cost bound

- `bound = (⌈1.25·P_ref⌉ + 8192)·max(input, cacheWrite?)/1e6 + O_bound·output/1e6`, with `O_bound = 4·capOut + 64`.
- This covers the probe observations: a backend mismatch of +4.4k prompt tokens, and 20 output tokens returned at cap 16.
- Raw usage exceeding the bound is recorded as `overshoot` (actual − bound, audited). Tests pin the probe cases inside
  the bound.

### 6.3 Return deadline vs physical IO

- **Return deadline**: 60 s from start, covering auth (10 s race), stream and classification. On expiry
  `controller.abort()` and return. Teardown is never awaited; the detached promise gets `.catch(noop)`.
- **IO occupancy**: the session's `ioPending` flag stays set until the detached transport promise **physically
  settles**. While it is set, no new openai ping starts (`io-busy`, non-terminal). Residual IO therefore never expands
  slots.
- The OpenAI SDK's `fetchWithTimeout` timer is not unref'd, but it lives only until headers arrive and is cleared on
  abort. v1 pings never run in print mode (G2), so `pi -p` natural exit is unaffected. A test asserts that `pi -p` with
  an openai model issues zero pings and exits naturally.

## 7. Gates and breakers (findings #11, #12, #16 from r1 kept)

- `evaluateTick` gets an optional `protocol` input; when it is absent the tick is byte-identical.
- Gate order for `openai-*`:
  1. mode (`off` ⇒ `not-anthropic`; `observe` ⇒ `observe-only`, non-terminal, zero network);
  2. `opted-out` | `unsupported-route` | `transport-unavailable` | `endpoint-mismatch`;
  3. replay refusals (§2.2), `auth-drift`;
  4. `learning` | `too-short`;
  5. `usd-unpriced` | `no-savings`;
  6. `io-busy`;
  7. #13 / #15 with the profile;
  8. #14 against the live cap.
- `runPing` re-reads the mode after auth.
- **No miss breaker.** `hit`, `miss`, `partial` and `backend-mismatch` only update samples, p̂ and the cap.
- **Route-scoped breakers (finding #11)**: `http` (non-transient), `no-usage`, `malformed` and `accepted-then-lost` on
  openai go to a **routeDigest**-keyed line record, using the existing cooldown math, never `session.disabled`.
  - O3 `no-cache-value` for openai uses `TtlRouteRecord.zeroReadSessions` / `noCacheValueSince`, counted from
    own-prefix hits only (natural hit or ping `hit`). `observeUsageIntoEvidence` skips openai apis.
  - Openai session counters (pings, reads, cost, M2) live in a separate per-routeDigest map. Anthropic's legacy
    `SessionTotals` and provider/model O3 are untouched.

## 8. Settings

`cacheTtl.keepaliveResponses` and `cacheTtl.keepaliveCompletions` take `auto | observe | off`, default `auto`
(ruling 1). `cacheTtl.keepaliveOptOut` is a user-written `provider/model` glob list. All three are read live every
tick. `auto` only pings once WP0b has verified the transport on this pi version; otherwise the gate is
`transport-unavailable`.

## 9. Status

`/cache-ttl status` adds a `route:` line, for example:
`route: openai-completions · host · kimi-k3 · active · ttl (11m,21m] · every 8m15s · p̂ 7% (n=5) · cap 3 · proofs 1/0`.
Other forms: `learning`, `transport-unavailable`, `io-busy`. The status bar is unchanged. Web is deferred.

## 10. Tests

- **WP0b wire gate** (`tests/conformance/keepalive-openai-wire.test.ts`): real `AgentSession` with Part A, local
  Responses and Completions SSE stubs. Per protocol, the ping built per §2.1 must equal the stub-recorded real request:
  same body except the cap field, same header map. Branches covered:
  - retention none/short/long; header-only auth; `model.headers` auth; tombstones; both affinity formats;
  - `auth-drift` refusal;
  - the capability probe (present, missing ⇒ disabled, activation intact);
  - the recorded pi version.
- `openai-replay.test.ts`: every refusal reason, verbatim fields.
- `openai-transport.test.ts`: strict raw usage (missing cached ⇒ `no-usage` even though pi-ai reports 0); classes for
  a 4096 baseline at 5k and 19k prompts, a 14.8k↔19k switch, and 20 output tokens at cap 16 staying inside the bound;
  deadline vs IO occupancy (a stalled body keeps `ioPending` set and blocks the next ping; a never-settling cancel);
  pre-aborted signal; observe / off ⇒ zero requests.
- `ttl-evidence.test.ts`:
  - from raw single samples: the own-prefix proof, including the false-hit case (baseline 4096, prompt 4500);
  - gap_lo / gap_hi bounds; hashing budgets and early abort; two generations;
  - refuted misses; trajectory learning → active in the same window;
  - evidence-loss directions (FIFO, trimming, ring reset).
- `keepalive-cap.test.ts`:
  - the §5.3 table generated from the price fixture;
  - live-cap growth with hits;
  - convergence with 0 and 32 old hits;
  - an `I_base` change reopening up to `cap(prior)`;
  - p* / k formulas;
  - property: `p = 0` gives the old formula;
  - Anthropic tests unchanged.
- Service (FakeClock): single settlement incl. late results and dispose; route-scoped breakers do not block a later
  Anthropic capture; O3 driven by own-prefix evidence only; mid-ping mode switch.
- Integration (`tests/integration/cache-keepalive-openai.test.ts`): local HTTP fakes covering a stateful TTL cache,
  baseline injection, a backend switch, a non-refreshing relay and a key-dependent cache.
- Gates: `format:check`, `typecheck`, `test`, `build`, `test:conformance`. Real-route acceptance goes in
  `acceptance.md` before release.

## 11. Work packages and gate order (finding #15: no cycles)

```
Part A: WP0a (call-chain evidence) → WP-A (pairing fix, own commit)   ← capture gate
Part B: WP0b (wire conformance; needs WP-A) → WP1 ∥ WP2 ∥ WP3 → WP4 → WP5 → enable `auto` (verified-version set)
```

| WP  | Owned files                                                                                                                                                                                                           | Depends |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0b  | `tests/conformance/keepalive-openai-wire.test.ts`, Responses/Completions stubs under `tests/conformance/fixtures/`                                                                                                    | WP-A    |
| 1   | `src/cache-ttl/ttl-evidence.ts`, `src/cache-ttl/provider-evidence.ts` (`ttlRoutes`), tests                                                                                                                            | 0b      |
| 2   | `src/cache-ttl/openai-replay.ts`, `src/cache-ttl/openai-transport.ts`, tests                                                                                                                                          | 0b      |
| 3   | `src/cache-ttl/keepalive-state.ts` (gates, `computeOpenAiWindowCap`, cost bound, report line), price fixture, tests                                                                                                   | 0b      |
| 4   | `src/service/cache-keepalive.ts`, `src/cache-ttl/cache-ttl.ts` (shape check, token observations, O3 routing), `src/cache-ttl/usage-ledger.ts`, `src/config/settings.ts`, `src/config/setting-specs.ts`, service tests | 1, 2, 3 |
| 5   | integration tests, docs (`AGENTS.md`, `docs/guide/context.md`, `acceptance.md`)                                                                                                                                       | 4       |

The shared types in §3.3, §2.3 and §7 are frozen before WP1–WP3 start.

## 12. Risks

1. **pi-ai surface and ALS are runtime properties.** WP0a / WP0b must pass before any pi peer bump; failure modes are
   fail-closed (disabled path, no capture).
2. **Spend before convergence is bounded per window, not per session.** That is the price of ruling 2, stated in §5.4.
3. **Learner coverage.** Natural samples need long, unpinged, own-prefix-verified gaps. Some routes may stay in
   `learning` for a long time. That is safe, at the cost of value.

## 13. Open questions (new decisions only)

- **Q1 Approve the minimal v1 scope in §0** (main session only, no retries, status only, children/web deferred)?
  **Recommend yes.**
- **Q2 Interim**: document pi's native `CacheWarmer` (`promptCache.short` in the user's own `models.json`) for
  measured routes until v1 ships? It is zero code and uses a static TTL. **Recommend yes**, as user guidance only.
- **Q3 Version range**: enable the OpenAI path only on pi-ai versions verified by WP0b (today 1.2.x), with 1.0 / 1.1
  disabled at runtime rather than verified? **Recommend yes.**

## §R2 评审修订（review `r_Y7GVA7DZ` → r3）

| #   | Finding                                                           | r3 change                                                                                                                                                                    |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKER: proof gate and 7-day `unprovable` conflict with ruling 2 | Removed; refresh proof is diagnostics only; the Q1 ruling note explains that its object is gone (§4)                                                                         |
| 2   | BLOCKER: unconditional spend bound was false                      | Replaced by honest bounds: per window ≤ `cap(p̂_min)` (≤ 96); convergence conditions; full-ring k (19); reopen cases; no per-session bound by ruling. Tests added (§5.4, §10) |
| 3   | BLOCKER: adjacency/order-lock is not a same-request proof         | Moved to Part A (`capture-pairing-plan.md`): per-call ALS token, fail-closed sticky degrade, last-P-wins, WP0a evidence gate                                                 |
| 4   | pi-ai factories only via the compat alias                         | `/compat` subpath, runtime capability probe, OpenAI-only degradation, verified-version set (Q3) (§2.1)                                                                       |
| 5   | Replay the real transport metadata                                | Capture-time model snapshot, `auth.env`, explicit or identically resolved `cacheRetention`, `auth-drift` / model-meta drift refusals, WP0b wire gate (§2.1)                  |
| 6   | Evidence channel for real traffic                                 | Token-scoped `after_provider_response` + `provider_stream_event` raw usage; effective endpoint via cached auth; gap_lo / gap_hi; otherwise no sample (§3.1)                  |
| 7   | Own-prefix size proof                                             | `baselineMax` from fresh lineages; hit requires `P − baselineMax ≥ 0.5P` and `P ≥ minPrefix` (§3.2)                                                                          |
| 8   | Reservation is not a bound                                        | Verifiable `bound` with backend-mismatch and output-overshoot margins; `overshoot` audited; children deferred (§6.2)                                                         |
| 9   | Pricing identity, tiers, dispose settlement                       | Wire-model prices, own cost function, tier refusal, single settlement owner, late-after-dispose diagnostic (§5.1, §6.1)                                                      |
| 10  | Deadline ≠ IO exit; SDK timers                                    | Return deadline separated from `ioPending` occupancy (`io-busy`); print mode excluded; natural-exit test (§6.3)                                                              |
| 11  | O3 and counters by routeDigest                                    | Route-scoped O3 fields and an openai counter map; Anthropic legacy path untouched (§7)                                                                                       |
| 12  | `store:false`; server-billed Completions fields                   | Explicit `store === false`; refuse `web_search_options` / `audio` / `prediction` (§2.2)                                                                                      |
| 13  | kimi table wrong                                                  | Fixed (cap 1 at p̂ 0.2); table generated from a price fixture; W = input kept (§5.3)                                                                                          |
| 14  | Budget before hashing; two generations; latency                   | Structural budget walk before serialization; two hash generations; p99 benchmark (§3.2)                                                                                      |
| 15  | De-cycle gates; safe direction on evidence loss                   | Gate chain WP0a → WP-A → WP0b → features → `auto`; evidence-loss directions listed (§3.4, §11)                                                                               |

## §R1 评审修订（review `r_XFKW36T2` → r2）

Historical (r2). Where it conflicts with §R2 or the current text (proof gate, `unprovable`, children, retries, adjacency
pairing), r3 wins.

| #   | Finding (short)                                                 | r2 change                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Capture pairing order is backwards                              | **Confirmed, and Anthropic is affected too** (§1, with evidence). Fixed by WP-A: order-agnostic adjacency pairing with order lock, shipped as a separate `fix`. WP0 is a real-SDK conformance gate (two requests, different payloads/headers, three protocols)                                                               |
| 2   | 80% threshold vs cost formula; output only charged on hits      | Hit = `P − C ≤ slack(P)`, and the cap's hit cost uses that same slack bound. Validity is separated from cost: charges are pi-ai's actual cost, output included in every branch. §4 recomputed at P = 20k (§2.4, §5.2)                                                                                                        |
| 3   | TTL samples don't prove the prefix was preserved                | Header digest plus per-item hashes; k must re-send k−1's entire cache-relevant prefix, otherwise no sample. Over-including keys only drops samples (§3.2). Refuted misses are dropped from U (§3.4)                                                                                                                          |
| 4   | Header reconstruction not equivalent                            | Hand reconstruction removed. Pings go through pi-ai's exported provider (`openAIResponsesApi` / `openAICompletionsApi`) with the real request's options headers (tombstones kept), so `createClient` builds identical headers. Conformance covers every branch (§2.2, §14)                                                   |
| 5   | Not every Responses request is replayable                       | Replayable profile (§2.1): the cap field must already be present (covers the `supportsMaxOutputTokens:false` and ChatGPT sign-in branches); refuse `previous_response_id` / `conversation` / `background` / `store:true` / server tools / non-default tier; reasoning and encrypted items replayed verbatim                  |
| 6   | Injected baseline breaks a fixed 80% rule                       | Own-prefix rule against `P_ref` (`backend-mismatch`), plus `hit` / `miss` / `partial` classes. Ambiguous ⇒ not TTL evidence and non-hit for p̂ (§2.4); tests for 5k / 19k / switch                                                                                                                                            |
| 7   | Unconfirmed touches; when new evidence is usable                | Confirmed-touch definition, unconfirmed events break the chain, and the window profile is set at the successful settle, so the first idle miss enables probing in the same window (§3.2, §3.4)                                                                                                                               |
| 8   | Learner degrades itself on ping hits                            | L/U come only from natural samples; ping samples never touch them (§3.2)                                                                                                                                                                                                                                                     |
| 9   | Refresh proof forgeable; `ceil(U/I)` boundary                   | Proof chain must be all `hit`, strictly crossing U, `proofPings = ⌊U/I⌋ + 1`, never above the cap; any non-hit resets the base (§3.4)                                                                                                                                                                                        |
| 10  | Route key merges routes and persists secrets                    | sha256 digest over scheme/host (lower-cased), path/query verbatim, model and retention mode; userinfo dropped; only digest and label persisted; effective endpoint, `endpoint-mismatch` refusal (§3.1)                                                                                                                       |
| 11  | Child $ budget misses common misses; late results settle at 0   | Max-cost reservation; settlement decoupled from the epoch-guarded reducer, so late results still charge (§2.6)                                                                                                                                                                                                               |
| 12  | Strict usage / price contract                                   | Present, finite, non-negative integers with C ≤ P, else `no-usage`. Write tokens and tier multiplier via pi-ai cost; non-default `service_tier` refused; missing price ⇒ `usd-unpriced`; `input ≤ cacheRead` ⇒ cap 0; never fallback 11 (§2.4, §5.1)                                                                         |
| 13  | 45 s abort is not a zero-hang proof                             | One total deadline over auth, fetch, read and cleanup; teardown never awaited; pre-aborted signal; lease settled in `finally`; tests for each stall (§2.5, §14)                                                                                                                                                              |
| 14  | O3 resets on baseline reads; breaker scope                      | O3 uses own-prefix evidence for openai and is not latched into `session.disabled`. Every openai failure breaker is line/route-scoped, so Anthropic later in the same session is unaffected. **Per the user ruling there is no miss breaker** (§7)                                                                            |
| 15  | Bucket data can't support p̂; h ≥ 2 unreachable                  | Buckets replaced by frozen ring types (§3.3). Single natural samples suffice by design (user ruling 3: one idle miss starts probing). p̂ explicitly labelled an estimate                                                                                                                                                      |
| 16  | `observe` not a hard gate; re-arm; web early-return hides state | `observe-only` is a non-terminal zero-network gate (re-arms automatically); the mode is re-read inside `runPing`; the route projection bypasses the early return; 8 KiB test kept (§6, §10)                                                                                                                                  |
| 17  | False-green tests                                               | Real-SDK conformance is the start gate; fixtures at P = 20k; tests for echo size, mixed backends, cross-model $, peer-range note, off/observe zero requests, mixed-protocol regression (§14)                                                                                                                                 |
| 18  | Over-engineering                                                | AIMD, the long-lived state and the refuted state are cut; cadence is a fixed discount, and the ruling's "节奏收缩" is a stateless function of p̂ (§3.4). The reviewer's suggested miss breaker is **not** adopted (user ruling); the economic net in §5.3 replaces it with explicit convergence K and worst-case spend bounds |

## 用户裁定（2026-10-18，覆盖上文冲突处）

1. 默认模式：`auto`（per-protocol 设置默认 auto）。
2. ping 落空**不熔断会话**（「不停，一直 ping」）：删除「连续 2 次 miss 停本会话」规则；miss 只更新该线路的 p̂（学习到的落空率）与节奏收缩。花费由按价格的每窗口上限约束——p̂ 升高时期望单次 ping 成本上升、cap 自然降到 0，即「ping 不划算时自动不 ping」由经济模型而非熔断承担。现有与 miss 无关的熔断（HTTP 拒绝、可能已计费的瞬态、no-cache-value 等）保持不变。
3. 冷启动：被动——新线路没有证据时等它自己出现一次闲置未命中再开始 ping。
4. 勉强划算的线路：只靠价格上限，不设最低 cap 门槛，不改用户设置。
5. 设计不得绑定 provider 名（provider 均为用户自定义）；pi 内置 `github-copilot` 的排除需评审确认技术理由。

### 用户裁定（2026-10-18 第二轮，回答 r2 开放问题）

- Q1：证明失败的线路 7 天后再试（`/cache-ttl keepalive reset` 可手动清除）。
- Q2：Anthropic 配对 bug 先单独修、单独 `fix` 提交（WP0 一致性测试确认 bug 后立即做，不等 OpenAI 功能）；是否发版另问用户。
