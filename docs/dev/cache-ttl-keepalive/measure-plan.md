# `/cache-ttl measure` — measure a route's prompt-cache TTL and read renewal (todo #16, plan r4)

Status: plan **r4**, 2026-10-18. Not implemented. r1 was rejected by `r_YYG3KQPH`, r2 by `r_VBVDCK1E`; r3's
re-review `r_5AD6SW48` left three majors, fixed in r4 (§4.3; "Revision log (r4)"). The "User rulings" block at the end
is authoritative and kept verbatim (rulings 13–14 are new). r2 minors #5–7 stay implementation/launch gates. Lane **L2**; dev starts after re-review; verifier ≠ dev model.

Inputs: `pipeline-ping.ts` / `pipeline-ping-types.ts` (fe54feb), `keepalive-state.ts`, `src/service/cache-keepalive.ts`,
`protocol-probe-results.md`, pi 1.2 `dist/core/cache-warmer.js`, pi-ai 1.2
`dist/api/{anthropic-messages,openai-responses,openai-responses-shared,openai-completions}.js`.

## 0. Decisions

| Topic          | Decision                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| Protocols      | `anthropic-messages` (P1) + `openai-responses` / `openai-completions` (P2, separate package; ruling 1)          |
| Transport      | `sendPipelinePing` + one optional `measurement` input block; keepalive (block absent) unchanged                 |
| Payload        | pi builds it; a measurement-only validator checks the FINAL params incl. converted content; violation ⇒ 0 POSTs |
| TTL arms       | six independent prefixes, gaps 3/6/11/21/31/61 min, one probe each; control on the 61-min prefix                |
| Renewal arm    | at the first valid TTL miss: ONE renewal read on the largest-gap hit prefix (§5.5); never feeds `lowerMs`       |
| Stop rule      | first valid TTL miss stops all TTL probes; the boundary renewal read is the only post-miss request, declared    |
| Request cap    | HARD cap 17 sent requests (6 + 2 replacements + 2 control + 6 TTL + 1 renewal), from one frozen plan            |
| Cost           | typical + CONDITIONAL worst case (conditions stated), plus a runtime bound guard (§4.3; ruling 11)              |
| Route identity | run-wide route key fixed by the first valid write; every later request must match it                            |
| Concurrency    | process-level `Symbol.for` claim incl. a revocable `preparing` state across confirm; owner/runId fences         |
| Persistence    | async, bounded, single writer, never awaited; whole-file last-writer-wins across processes (ruling 12)          |
| Child sessions | not available (`wireCacheTtl` is post-guard); no new settings                                                   |
| Consumers (P5) | separate later doc; contract in §11                                                                             |

## 1. Command surface

```text
/cache-ttl measure [<provider>/<id>] [--long] [--estimate] [--yes]
/cache-ttl measure status
/cache-ttl measure cancel
```

- `src/cache-ttl/measure-args.ts` (pure, shared with the web policy): `parseMeasureArgs(rawArgs)` works on the raw
  args (the current handler lowercases everything — `cache-ttl.ts` branches on `measure` first). Only the verb and
  flags are case-normalised; `<provider>/<id>` keeps its case. Unknown/duplicate flag, a second model, or flags after
  `status`/`cancel` ⇒ usage error, nothing sent. Flag order is free.
- Model: none ⇒ `ctx.model`; else `ctx.modelRegistry.find(provider, id)` + `hasConfiguredAuth`. The provider name is
  never stored.
- `--estimate` never sends: prints the frozen plan, the hard request cap and both cost figures (§4.3).
- Start: estimate printed; without `--yes`, `ctx.ui.confirm` (60 s timeout); declined/unavailable ⇒ nothing sent,
  `re-run with --yes to start`. The confirm text also says: "/reload, /new, /resume, fork or exit cancel the run;
  all progress since the last successful save may be lost — in the extreme, the whole run".
- Admission refusals (0 POSTs): `ctx.hasUI === false`; claim not free (§7.1); unsupported api; pi's built-in
  `github-copilot`; no `registry.streamSimple`; `model.contextWindow < P_bound + 2048` (§4.3); validator refusal (§3.3, on the
  first write, before its base fetch).
- `/cache-ttl status` line: `ttl-measure running 3/6 · next 21m in 4m · saved 2m ago`, `ttl-measure io-pending 2m`,
  or `learned ttl short ≥6m · renew true(empirical) · 2026-10-18`. `measure status` shows the run table, both cost
  figures, the run-wide route label and the last successful save time.
- Web hub (`command-policy.ts` `cache-ttl` row, via `parseMeasureArgs`): `measure status` / `measure … --estimate` ⇒
  `allow`; any start and `cancel` ⇒ `confirm`; parse error ⇒ `confirm`. A web start needs the hub confirm AND
  `--yes` (web-captured `ctx.ui.confirm` answers "cancelled"). No new web UI.

## 2. Protocol scope

Ruling 1. Per-protocol code: strict raw-usage reader (§5.2), payload validator (§3.3), endpoint suffix. pi-ai delivers
raw frames via `onProviderStreamEvent` for all three and honours `onPayload`/`fetch`. Not in v1: azure/codex Responses,
bedrock/google/mistral, pi's built-in `github-copilot`.

## 3. Synthetic prefix, payload, validation

### 3.1 Prefix (`src/cache-ttl/measure-prefix.ts`, pi-free)

- `runId = m-<base36 now>-<8 hex>`; `nonce = sha256(runId:slot:attempt)` (24 hex) — a replacement write always has a
  new nonce. `sessionId = ttl-measure-<runId>-<slot>-<attempt>`, identical on every send of that prefix.
- Context: `systemPrompt = "Nonce <nonce>. You are a terse log triage assistant. Answer with a single short word."`;
  one user message = `Nonce <nonce>. Log excerpt follows.\n` + nonce-seeded log filler (copied from
  `scripts/exp/keepalive-protocol-probe.mjs:72-84`) + `\n\nTask: ignore the log and reply with exactly the word OK.`
- `PREFIX_CHARS = 37_500`; token **estimates** `T_lo = chars/4`, `T_mid = chars/2.5`, `T_hi = chars/2.3` (≈ 9.4k /
  15k / 16.3k). These are estimates, not bounds (§4.3). The record keeps provider-measured `P`, `B`, `S`.
- Output caps `OUTPUT_CAP = { anthropic: 1, completions: 1, responses: 16 }` (Responses floor). The same constants
  feed `maxTokens`, the validator and the estimate.
- Options: `maxTokens = OUTPUT_CAP[api]`, `maxRetries: 0`, `cacheRetention` short|long, no `reasoning`, no
  `samplingParams` (model-level ones still apply — hence §3.3).

### 3.2 Breakpoints — placed by pi

Anthropic: `buildParams` puts `cache_control` on the system block(s) and the last user block. Responses: automatic
prefix caching keyed by `prompt_cache_key`. Completions: automatic; compat `cache_control` markers where pi adds them.

### 3.3 Build-mode validation (`src/cache-ttl/measure-payload.ts`, pi-free)

pi-ai applies `Object.assign(params, samplingParams)` after building (`openai-responses.js:287-289`,
`openai-completions.js:748-750`); model compat can add thinking, effort messages, roles and markers. The first
`onPayload` (build mode, §6) calls `validateMeasurePayload(profile, params, expect)` on the FINAL params; a non-empty
verdict ⇒ `onPayload` throws ⇒ no fetch ⇒ `not-sent{capability}` + `measured.rejection` ⇒ `failed(payload:<code>)`.

**Content after conversion.** Every text-bearing node of the request input is collected — Anthropic `system[]` +
`messages[].content` (string or text blocks); Responses `instructions`, `input[]` items with `input_text`/string
content; Completions `messages[].content` (string or `{type:"text"}` parts) — and must equal exactly
`{expectedSystem, expectedUser}` plus only these stock pi-ai 1.2 constructions:

| Construction (real builder)                                                                                                                                                                                                             | Accepted when                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth identity: one extra leading Anthropic system text block (≤ 200 chars)                                                                                                                                                             | auth is an OAuth token                                                                                                                                            |
| Managed effort: `thinking:{type:"adaptive",display:"summarized",block_binding:{prefix_mismatch_behavior:"drop_block"}}`, top-level `output_config:{effort:"high"}`, trailing `{role:"system",content:[],output_config:{effort:"high"}}` | `model.compat.supportsMidConvoEffort === true` (takes precedence over forceAdaptiveThinking)                                                                      |
| Force-adaptive: `thinking:{type:"adaptive",display:"summarized"}`, `output_config:{effort:<mapped-low>}`, no block_binding/budget or trailing effort message                                                                            | reasoning-capable model with `compat.forceAdaptiveThinking === true` and NOT managed effort; measurement uses stock `streamSimple({reasoning:"low",maxTokens:1})` |
| Responses system role `developer` or `system`, `input_text` parts                                                                                                                                                                       | always (role from `model.reasoning`/compat)                                                                                                                       |
| Completions role `developer` or `system`, text parts with compat `cache_control`                                                                                                                                                        | always                                                                                                                                                            |

Anything else — extra text, non-text parts (image/file/audio), extra messages, `instructions` from sampling params,
a Responses `prompt` template — ⇒ `extra-input`. Total input text ≤ expected + 256 chars.

**Protected fields** (unknown sampling keys such as `temperature`/`top_p` are tolerated; ruling 12):

- all: `model === expect.wireModel`; `stream === true`; no `tools`, `tool_choice`, `functions`; `n` absent or 1;
  serialized ≤ 256 KiB.
- output caps: EVERY cap field present must be a positive integer equal to `OUTPUT_CAP[api]`, at least one present;
  Anthropic `max_tokens`; Completions `max_tokens` and/or `max_completion_tokens` (both present and unequal or ≠ 1 ⇒
  `conflicting-output-caps`); Responses `max_output_tokens` (absent — `supportsMaxOutputTokens:false` or ChatGPT
  sign-in — ⇒ `no-output-cap`; a `max_tokens`/`max_completion_tokens` key on Responses ⇒ `conflicting-output-caps`).
- billing tier: `service_tier` absent, `auto` or `default` (Anthropic also `standard_only`); else `billing-tier`.
- anthropic: `thinking` absent, `{type:"disabled"}`, or exactly the applicable managed-effort / force-adaptive stock form above (never
  `type:"enabled"`/budget or `between_tools`; force-adaptive does not raise max_tokens); no `mcp_servers`, `container`; ephemeral `cache_control` on the last user block.
- responses: `store === false`; no `previous_response_id`, `conversation`, `background`, `prompt`;
  `prompt_cache_key === clamp(sessionId)`.
- completions: `stream_options.include_usage === true` (else `no-stream-usage`); no thinking-budget field,
  `audio`, `prediction`, `web_search_options`, audio `modalities`; `store !== true`.

### 3.4 Requested vs effective tier

| api         | short ⇒ effectiveTier | long ⇒ effectiveTier (else refuse `long-unsupported`)                                     |
| ----------- | --------------------- | ----------------------------------------------------------------------------------------- |
| anthropic   | `ephemeral`           | `ephemeral-1h` iff `cache_control.ttl === "1h"`                                           |
| responses   | `auto`                | `retention-24h` (`prompt_cache_retention`) or `explicit-30m` (`prompt_cache_options.ttl`) |
| completions | `auto`                | `retention-24h` iff `prompt_cache_retention:"24h"`                                        |

Anthropic long records `landed1h` (`true` / `false` = collapsed / `unknown` = split not reported).

## 4. Execution plan, outcomes, budget, cost

`src/cache-ttl/measure-plan.ts` (pi-free) builds ONE frozen `ExecutionPlan`; estimate, confirm text, runner counters
and tests all read it.

### 4.1 Request budget

`REQUEST_CAP = 17` = 6 writes + 2 replacement writes (shared pool) + ≤ 2 control reads + ≤ 6 TTL probes + ≤ 1
renewal read. A request is **sent** once the base fetch was invoked (`diag.baseFetchCalls === 1`); every sent request
consumes the cap whatever its outcome. `not-sent` consumes nothing. The cap is hard: a step that would exceed it is
skipped (`budget`), and the run ends `partial` if something was measured.

### 4.2 Outcome → action (`src/cache-ttl/measure-actions.ts`, the single table used by runner and tests)

| Outcome                                                        | write                                      | control                         | TTL probe                     | renewal                  |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------- | ----------------------------- | ------------------------ |
| not-sent guard/deadline/aborted/provider-error                 | replacement (no spend)                     | retry slot if left              | inconclusive(not-sent)        | unknown(not-sent)        |
| not-sent auth                                                  | failed(auth)                               | failed(auth)                    | failed(auth)                  | failed(auth)             |
| not-sent capability: `rejection` / route mismatch              | failed(payload:…)/failed(route)            | failed(route)                   | failed(route)                 | failed(route)            |
| http 3xx (never followed)                                      | failed(redirect)                           | failed(redirect)                | failed(redirect)              | failed(redirect)         |
| http 401/403                                                   | failed(auth-http)                          | failed(auth-http)               | failed(auth-http)             | failed(auth-http)        |
| http 429                                                       | wait 5 s, replacement                      | retry slot, flag `rate-limited` | inconclusive(rate-limited)    | unknown(rate-limited)    |
| http other 4xx                                                 | failed(http-<s>)                           | failed(http-<s>)                | failed(http-<s>)              | unknown(http)            |
| http 5xx                                                       | replacement                                | retry slot                      | inconclusive(http-5xx)        | unknown(http)            |
| network / accepted-then-lost / malformed / deadline after send | possibly billed; nonce burned; replacement | possibly billed; retry slot     | possibly billed; inconclusive | possibly billed; unknown |
| usage, `cacheEvidence` invalid                                 | possibly billed; nonce burned; replacement | retry slot                      | inconclusive(no-usage)        | unknown(no-usage)        |
| usage valid                                                    | anchor (§5.1)                              | classify (§5.1)                 | classify (§5.3)               | evaluate (§5.5)          |

"Replacement" takes from the pool (fresh nonce + sessionId); pool empty ⇒ slot `unavailable`. "Retry slot" = the
single second control attempt. A `failed(…)` row ends the run.

### 4.3 Cost: hard count vs conditional bound

- The **hard** guarantee is the request count (≤ 17). Money is only boundable under conditions, stated in the
  estimate, the confirm and the record, all built on ONE per-request prompt bound:
  `P_bound = T_hi + INJECTION_ALLOWANCE`, `INJECTION_ALLOWANCE = 4608` tokens (cr-response's observed injected
  baseline 4096–4224 + 384 slack; `protocol-probe-results.md` routes peak at 19.2k total prompt, inside
  `P_bound ≈ 20.9k`). `P_bound` is used by the estimate, the runtime guard and context admission — nowhere else is a
  different bound computed.
  - (C1) each request's total prompt `P ≤ P_bound`; (C2) output ≤ `OUTPUT_CAP[api]`; (C3) pi's registry list prices,
    no relay surcharge.
- Typical = `6·W(T_mid) + 7·R(T_mid) + 13·O` (all hits, one control, no boundary). Conditional worst case =
  `17 · (W(P_bound) + O)`. `W(n)` = price of `n` prompt tokens all billed as a write (`cacheWrite` > 0 else `input`;
  long Anthropic at 2× input), `R(n)` = cached-read price, `O = OUTPUT_CAP · output price`. Every price comes from
  pi-ai `calculateCost` (injected by the command) with the tier selected by that same `n`, so the worst case is
  priced at the tier `P_bound` falls into. Example Sonnet-class ($3 / write $3.75 / read $0.30): typical ≈ $0.37,
  conditional worst ≈ $1.33. Confirm shows both (ruling 11). Unpriced ⇒ `cost: UNKNOWN`; the request cap still
  applies.
- **Runtime bound guard**: after every sent request, observed `P > P_bound` (C1 broken) or observed output > cap (C2
  broken) ⇒ the run stops before the next send: `failed(bound-exceeded)`, and the report says the stated bound did not
  hold. Only the request that revealed it can exceed its per-request share.
- **Cost accounting** (per request, then summed; never "actual cost"):
  - `knownUsd` — every component the provider reported, priced via `calculateCost` at that request's own tier:
    uncached input `P − C − W`, cached read `C`, write `W` (1h part when the split is reported), output when
    reported. Anthropic requests therefore contribute their full input/read/write cost even though output is never
    observed after the stream stops at `message_start`.
  - `unknownUsd = [lo, hi]` — the unreported components only: output not observed ⇒ `[0, cap · output price]`;
    Anthropic long without the 1h split ⇒ `[W at short-write, W at 2× input] − (part already in knownUsd)`; OpenAI
    without `cache_write_tokens` ⇒ the uncached input is in `knownUsd` at the input price, `hi` adds the write premium
    (`cacheWrite − input`, when positive); a sent request with no usage at all ⇒ `[0, W(P_bound) + O]` (conditional).
  - Reports: "known ≈ $x; unreported components $lo–$hi (N items)".

## 5. Timeline, reader, classification, results, renewal

### 5.1 Timeline (injected `Clock`, timers unref'd)

1. Writes, sequential, slots 0..5. The **first valid write fixes the run-wide route key** (§6); it is also the gate:
   `S` below minimum ⇒ `inconclusive(prefix-too-small)`, no "no cache" verdict.
2. Control on slot 5 at `+30 s`, once more at `+60 s` on anything but a valid hit. Valid hit ⇒ proceed (slot 5's
   anchor moves to the control). Two valid misses ⇒ `no-cache` (ruling 8). Otherwise ⇒ `control-inconclusive`.
3. TTL probe slot `i` at `anchor_i + gap_i`, once.
4. First valid TTL miss at slot `b` ⇒ larger slots `skipped(implied-miss)` (ruling 2) ⇒ the boundary renewal read
   (§5.5) if eligible ⇒ end. Inconclusive probes never stop the run.
5. ≤ 1 request in flight; a due send whose predecessor's `settled` is pending ⇒ `inconclusive(io-busy)`. Per-send
   deadline `min(now + 30 s, hardAt)`. `hardAt = start + 80 min` (61 min + writes ≤ 8 × 35 s + control 1.5 min +
   lateness tolerance 6.1 min + renewal 0.5 min + queueing slack).

Send-time accounting: the transport records `measured.sentAt` right before the base fetch and `measured.headersAt` at
response headers. The measurement `guard` (run by the transport right before the base fetch) rejects a send later
than `due + max(30 s, 10%·gap)` ⇒ `not-sent{guard}` ⇒ inconclusive(late), zero cost. Intervals between two touches
`x` then `y`: `[y.sentAt − x.headersAt, y.headersAt − x.sentAt]`.

### 5.2 Strict raw reader (`src/cache-ttl/measure-usage.ts`, measurement only)

Not `rawUsageFrom` (zero-fills); keepalive helpers untouched. Each request yields two independent flags:
`cacheEvidence: valid | invalid(reason)` and `billing: complete | unknown(items)`.

| api         | frame                                        | P                                                  | C (required)                                                                                        | W / W1h / output                                                                           |
| ----------- | -------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| anthropic   | `message_start.message.usage`                | input + cache_read + cache_creation (all required) | `cache_read_input_tokens`                                                                           | `cache_creation_input_tokens` / `…ephemeral_1h_input_tokens` / not observed (stream stops) |
| responses   | `response.completed`/`.incomplete` → `usage` | `input_tokens`                                     | `input_tokens_details.cached_tokens`                                                                | `input_tokens_details.cache_write_tokens` / – / `output_tokens`                            |
| completions | chunk with non-null `usage`                  | `prompt_tokens`                                    | `prompt_tokens_details.cached_tokens` · `prompt_cache_hit_tokens` · `cached_tokens` (first present) | `prompt_tokens_details.cache_write_tokens` / – / `completion_tokens`                       |

Constraints (violation ⇒ `cacheEvidence` invalid AND `billing` unknown): all present values non-negative integers;
`C ≤ P`; `C + W ≤ P` (Responses/Completions, where P includes both); `W1h ≤ W`. Billing items when not observed
(each priced into `unknownUsd`, §4.3; reported components still go to `knownUsd`): `output` (Anthropic always; OpenAI
when missing), `write1h-split` (Anthropic long without the split), `write` (OpenAI without `cache_write_tokens`).

### 5.3 Classification (`src/cache-ttl/measure-classify.ts`)

Per slot against its own write: `P_w`, `B = C_w`, `S = P_w − B`, `slack(P) = max(512, ⌈0.02·P⌉)`. Minimum own prefix
`S ≥ 4096` and `S ≥ 0.5·P_w` (else `inconclusive(own-prefix-small)`). `|P − P_w| > slack(P_w)` ⇒
`inconclusive(backend-mismatch)`; `C − B ≥ 0.8·S` ⇒ `hit`; `C − B ≤ 0.2·S` ⇒ `miss`; else `inconclusive(partial)`.
A **valid sample** = `cacheEvidence` valid, classified hit/miss, not late, run route key matched.

### 5.4 TTL result

- `lowerMs` = max `idle.lo` over valid TTL hits ("at least X"); none ⇒ `unknown` (control-only ⇒ `partial`, never
  eligible); "≥ 61 min" only with a valid 61-min hit. `missMs` = min `idle.hi` over valid TTL misses, shown as "miss
  observed at ≤ X (expiry or eviction under this run's load)" — never a TTL ceiling. `consistent` = hits < misses.
- Load label on every report/record: `observed under this run's load: 6 prefixes ≈ <ΣS> cached tokens on one key`.
- Eligible for consumers iff `complete`/`partial`, `consistent`, ≥ 1 valid TTL hit, `lowerMs ≥ 150 s`, same key and
  effective tier, ≤ 30 days old. Renewal reads never feed `lowerMs`.

### 5.5 Renewal measurement (ruling 10)

Question: does a read reset the entry's lifetime? Arms: the **untouched** arm is TTL slot `b` (first valid miss); the
**touched** arm is slot `a` = the slot holding `lowerMs` (largest valid TTL hit, read once at `r1` = its probe). At the
boundary, exactly one renewal read `R` re-sends slot `a`'s prefix, 10 s after the miss response. Writes are sequential
(`w_a` before `w_b`) and `R` follows the miss, so the touched arm is strictly older than the missed arm.

Intervals: `ageR = [R.sentAt − w_a.headersAt, R.headersAt − w_a.sentAt]`, `idleR` = interval from `r1` to `R`,
`missAge` = the slot-`b` miss interval. Eligibility is checked twice — before sending (planned `sentAt`, `headersAt`
bounded by the 30 s deadline) and after (actual timings; failing then ⇒ `unknown(pair-ineligible)`, request already
counted): `a`'s probe valid hit, `ageR.lo ≥ K + m_age` and `idleR.hi + 10 s < survival`, with

| Basis                | Ceiling `K`                                                  | `m_age` | `survival`        | When                                                       |
| -------------------- | ------------------------------------------------------------ | ------- | ----------------- | ---------------------------------------------------------- |
| `documented-ceiling` | 300 s (`ephemeral`) / 3600 s (`ephemeral-1h`), authoritative | 30 s    | `max(lowerMs, K)` | origin `https://api.anthropic.com` only (docs: hits renew) |
| `paired-empirical`   | `missAge.hi` — empirical, not authoritative                  | 10 s    | `lowerMs`         | any route; recorded with its assumptions                   |

Which boundaries can yield evidence on a relay (`paired-empirical`): 11→21 and 21→31 comfortably; 6→11 only when
writes and latencies are fast (≈ 20 s slack); 31→61 normally not (`b − a ≈ a`, plus slot 5's control shift); 3→6
never. With the documented ceiling (official endpoint) 3→6 (short) and 31→61 (long) qualify. Ineligible ⇒ no request.

Verdicts (`renewsOnRead`, per ruling 10's enum):

- `true` — `R` is a valid hit under an eligible pair. `basis` as above; `paired-empirical` additionally requires
  `|P_R − P_wa| ≤ slack`, no `rate-limited` flag in the run, all five involved requests (`w_a`, `r1`, `w_b`, the miss,
  `R`) valid samples, and stores
  `assumptions: ["same backend class", "same eviction pressure", "same cache policy across prefixes"]`.
- `false` — **never emitted in v1.** A miss of `R` is equally explained by eviction, an undetectable key/backend
  split or lost usage, and v1 has no independent evidence to rule those out ⇒ `unknown(renewal-miss)`. The value stays
  in the enum for a future design with such evidence.
- `unknown(reason)` — `no-expiry-observed` (no TTL miss), `pair-ineligible`, `renewal-miss`, `budget`, any
  inconclusive outcome (§4.2).

Record: `renewal` with `renewsOnRead`, `basis?`, `reason?`, `assumptions?`, `touchedGapMs`, `untouchedGapMs`,
`ceilingMs`, `ageRMs`, `idleRMs`, `missAgeMs` and `read` (`sentAt`, `headersAt`, `P`, `C`, `B`, `S`, `verdict`) — raw
timings kept. Consumption: §11.

## 6. Transport revision (M0 types, P1/P2 implementation)

Additive and inert unless `measurement` is present; keepalive tests are only appended to.

```text
export type PipelineWireProfile = "anthropic-messages" | "openai-responses" | "openai-completions";
interface PipelinePingInput {
  /* …existing fields unchanged… */
  measurement?: {
    profile: PipelineWireProfile;
    build?: { context: PipelinePingContext; maxTokens: number; cacheRetention: "short" | "long";
              validate: (params: Record<string, unknown>) => string | undefined };   // writes; `body` ignored
    expectRouteKey?: string;  // run-wide key; absent only for the first write
  };
}
// every PipelineOutcome variant may carry:
//   measured?: { rejection?: string; builtBody?: Record<string, unknown>; rawUsage?: unknown /* ≤4 KiB clone */;
//                routeKey?: string; routeLabel?: string; sentAt?: Millis; headersAt?: Millis }
```

When `measurement` is set: api gate `model.api === profile`; per-profile path suffix; base fetch with
`redirect: "manual"` (a `Request` input is re-wrapped), any 3xx is an `http` outcome, never followed (§4.2 row).
Route key (`measure-route.ts`): sha256 over api, lower-case origin (no default port/userinfo), path minus suffix
without trailing `/`, full sorted query, wire model, effective tier; label redacted (host + ≤ 2 path segments,
token-like segments and query values ⇒ `…`); raw URL never stored. **Every** request after the first valid write —
replacement writes, controls, probes, renewal — passes `expectRouteKey`; URL key or body `model` mismatch ⇒
`not-sent{capability}` ⇒ `failed(route)`. Terminal frame + raw usage per §5.2; OpenAI sends run to completion; 64 KiB
scan cap stays. Build mode: first `onPayload` ⇒ `validate`; ok ⇒ `builtBody = structuredClone(params)`, return
`undefined`; second `onPayload` blocked; at-most-one-POST, deadline, abort, guard and `settled` contracts unchanged.

## 7. Process claim, lifecycle, persistence

### 7.1 Claim (`src/cache-ttl/measure-claim.ts`, pi-free)

`globalThis[Symbol.for("pi-subagent:cache-ttl-measure")]` (pattern of `ping-ledger.ts`):
`{ generation, state: "free" | "preparing" | "running" | "draining", owner?, run?, physicalPending, persist }`, where
`owner = { activationId, sessionId, runId, generation }`.

- `prepare(owner)` — only from `free` (else `busy` / `busy(io-pending)`); registered BEFORE the estimate/confirm await.
  Returns a token; `revoke(token)` puts it back to `free`.
- After confirm (and after every await in the command and runner): `claim.owns(token)` must hold (same generation,
  same activation and session, not revoked) — else abort silently, no send/persist/progress/notify. `start(token)`
  moves `preparing → running`.
- `session_shutdown` (all reasons, ruling 3): a `preparing` claim owned by this activation is revoked (the pending
  confirm then sends nothing); a `running` run is cancelled ⇒ `draining` until `physicalPending === 0` ⇒ `free`.
  A `settled` that never resolves keeps `draining` until restart (status `io-pending since …`) — fail closed.
- Late results from an old activation's handle (after /reload) are fenced by `generation` and ignored.

### 7.2 Runner (`src/cache-ttl/measure-runner.ts`, pi-free)

`startMeasurement({ plan, token, claim, send, clock, persist, onProgress, onDone })` ⇒ `{ snapshot, cancel, done }`
(`done` never rejects; `cancel`/`done` never await persistence or IO). `send` = `sendPipelinePing` bound to registry +
model. Progress `ctx.ui.setStatus("cache-ttl-measure", …)` (English tokens), final `ctx.ui.notify`, both try/catch and
owner-fenced. Measurement requests bypass `before_provider_request`, keepalive, the ledger, HUD and pi's CacheWarmer.

### 7.3 Persistence (`src/cache-ttl/measure-store.ts`, pi-free)

Async (`fs.promises`), single writer via the claim's `persist` slot (one write in flight, newer snapshot replaces
`pending`); each step (read-merge, write tmp 0600, rename) raced against 2 s; a timed-out step ⇒ `zombie`, later
persists skipped and reported; late completions ignored. Incremental persists after each verdict; `lastSavedAt` shown
in status. Shutdown persists fire-and-forget: on exit all progress since the last successful save may be lost — in the
extreme the whole run. Cross-process: re-read + merge before write; whole-file last-writer-wins (ruling 12).

## 8. Store format and budget

`<agentDir>/cache-ttl-measurements.json` (`$PI_CODING_AGENT_DIR` else `~/.pi/agent`), dir 0700, file 0600, tmp +
rename, never throws.

```text
{ "version": 1, "routes": [ {
  "key": "sha256:9f…", "label": "openai-responses · relay.example · /v1 · gpt-6-sol",
  "api": "openai-responses", "wireModel": "gpt-6-sol", "requestedRetention": "short", "effectiveTier": "auto",
  "latest": {
    "runId": "m-mgx1a2-1f2e3d4c", "status": "complete", "startedAt": 1792300000000, "finishedAt": 1792303720000,
    "load": { "prefixes": 6, "ownTokens": 88700 },
    "ttl": { "lowerMs": 1261000, "missMs": 1862000, "consistent": true, "validHits": 4, "validMisses": 1, "eligible": true },
    "samples": [ { "gapMs": 180000, "idleMs": [179200, 182400], "verdict": "hit", "P": 14822, "C": 14796, "B": 0, "S": 14799,
                   "cacheEvidence": "valid", "billing": "complete" } ],
    "control": { "verdict": "hit", "attempts": 1 }, "landed1h": "unknown",
    "renewal": { "renewsOnRead": "true", "basis": "paired-empirical", "assumptions": ["same backend class", "…"],
                 "touchedGapMs": 1260000, "untouchedGapMs": 1860000, "ceilingMs": 1866000, "ageRMs": [1872000, 1879000],
                 "idleRMs": [598000, 604000], "missAgeMs": [1858000, 1866000], "read": { "verdict": "hit", "P": 14830, "C": 14796 } },
    "requests": { "cap": 17, "sent": 12, "possiblyBilled": 0 },
    "cost": { "knownUsd": 0.29, "unknownUsd": [0, 0.0002], "unknownItems": ["output×12"],
              "estimate": { "typicalUsd": 0.2, "conditionalWorstUsd": 0.71, "pBound": 20913, "conditions": ["C1", "C2", "C3"] } },
    "toolkitVersion": "0.6.1", "piVersion": "1.2.0" },
  "inProgress": null } ] }
```

- Per route only `latest` + `inProgress`. The copyable `promptCache` hint (§10) is computed on display.
- Budget `WRITE_BUDGET = 192 KiB`, `READ_CAP = 256 KiB`, `ROUTE_CAP = 64` (a full record ≈ 2.5 KiB ⇒ 64 routes with
  both records ≈ 320 KiB ⇒ trimming applies): trim (1) `inProgress` of non-live runs, (2) `samples` and
  `renewal.read` of non-current routes oldest-first, (3) oldest routes. Own output is always readable.
- Unreadable / > READ_CAP / unknown version ⇒ renamed to `….corrupt` (single backup, overwritten), treated as empty.
- Consumer API: `lookupLearnedTtl(key, now) ⇒ { lowerMs, renewsOnRead, renewalBasis?, sampledAt } | undefined`
  (eligible records only).

## 9. Tests (all gates also run `format:check`, `typecheck`, `test`)

- **P1** unit: strict reader (missing vs 0 vs invalid; `C ≤ P`, `C + W ≤ P`, `W1h ≤ W`; two flags); validator table
  per refusal code; stock-construction acceptance; output caps (0, negative, 1.5, string, dual caps ⇒ refuse);
  transport measurement mode (manual redirect, run-wide key on all request kinds, build validate + clone,
  `sentAt`/`headersAt`, late guard ⇒ 0 POSTs). Keepalive: append-only deep-equal cases without `measurement`;
  existing `keepalive-*`, `pipeline-ping`, `keepalive-pipeline*` suites unchanged and green.
- **P2** conformance (`tests/conformance/measure-openai-build.test.ts`, real pi-ai builders, `fetchImpl` SSE fakes):
  reasoning and non-reasoning models (developer vs system role, `input_text`); compat `cache_control` parts;
  `supportsMaxOutputTokens:false` / ChatGPT sign-in ⇒ `no-output-cap`; sampling `instructions` ⇒ `extra-input`;
  sampling `max_completion_tokens: 4096` next to `max_tokens: 1` ⇒ `conflicting-output-caps`; sampling
  `service_tier: "priority"` ⇒ `billing-tier`; sampling `store: true` ⇒ refuse; explicit-cache long ⇒ `explicit-30m`;
  `supportsUsageInStreaming:false` ⇒ `no-stream-usage`; missing `cached_tokens` ⇒ `no-usage`.
- **P3** unit (FakeClock): plan/cap (≤ 17 sent in every path incl. replacements, controls, renewal), the outcome →
  action table row by row, fresh nonce after `accepted-then-lost`, classification (4096 baseline, own-prefix-small,
  mismatch), control `no-cache` vs `control-inconclusive`, first-miss stop + single boundary renewal read as the only
  post-miss request, renewal eligibility (3→6 ineligible on relays, eligible with documented ceiling), renewal
  verdicts (`true` both bases, `unknown(renewal-miss)`, never `false`), bound guard (`P > P_bound` ⇒ stop; a 4.2k injected baseline stays measurable), cost accounting (Anthropic known input/read/write kept, output in the unknown range), result
  semantics, store budget with 64 realistic full routes, coalesced writer + zombie, claim states (prepare/revoke/
  start/drain, generation fences), args parsing.
- **P4** conformance (`tests/conformance/measure-build.test.ts`, real pi `ModelRegistry` + `AnthropicStub`): OAuth
  build (identity block accepted, replay byte-identical); managed-effort model (`supportsMidConvoEffort`) accepted;
  budget-thinking forced by sampling ⇒ refuse; sampling `max_tokens`/`tools` ⇒ 0 POSTs; `--long` without
  `supportsLongCacheRetention` ⇒ `long-unsupported`; stub 307 ⇒ not followed, 1 POST, `failed(redirect)`; write
  `drop-after-headers` ⇒ replacement nonce differs; a replay whose URL changes ⇒ `failed(route)`; shutdown during
  the confirm ⇒ 0 POSTs and claim free; stalled transport + shutdown + new activation ⇒ `busy(io-pending)` until
  released; late callbacks of the old handle ignored; injected 4k baseline (cr-response shape) ⇒ measured normally, injected 6k
  prefix ⇒ `failed(bound-exceeded)`.
- **P4** integration (`tests/integration/cache-ttl-measure.test.ts`): stub `reply` simulates per-nonce lifetimes on
  the FakeClock: renewing policy ⇒ `renewsOnRead true(paired-empirical)`; write-anchored policy ⇒
  `unknown(renewal-miss)`; LRU capacity fake (k = 3) ⇒ misses labelled expiry-or-eviction; **detectable** split (P
  differs) ⇒ `backend-mismatch`; **undetectable** split (same P, random shard) ⇒ wrong-looking misses, asserted as the
  disclosed residual (labels only, never `false`); 429 on writes ⇒ pool exhausted; ≤ 17 POSTs; status lines; web
  policy rows.

## 10. pi's native CacheWarmer (pi 1.2) — principle and compatibility

Started by `sdk.js` `streamFn` for each session request (`options.sessionId === sessionManager.getSessionId()`; a new
request replaces the run; setting `cacheWarming` off|streaming (default)|idle). TTL =
`model.promptCache[retention] × 1000` (retention from `options.cacheRetention` ?? `PI_CACHE_RETENTION`); missing tier ⇒ no warming; pi's catalog
declares it only for Anthropic (`{short:300,long:3600}`). Refresh at `min(0.9·TTL, TTL − 10 s)`, dropped if later than
half the remaining margin; caps 60 min streaming / 30 min idle. Warm iff `p·missCost − warmCost ≥ $0.05`
(`warmCost = read(prompt) + 1 output`, `missCost = (cacheWrite>0 ? write : input) − read`, `p` = 1 streaming / 0.15
idle; `cache_warming_decision` can override; Anthropic budget thinking excluded). It re-sends the same context with
`maxTokens: 1` and implicitly assumes reads renew (it refreshes from each warm). Keepalive yields to it
(`native-warmer`). Compatibility (pi never configured): tier names match; `measure status` shows the copyable hint
`models.json promptCache.<tier> ≈ floor(lowerMs/1000)` — and warns when `renewsOnRead` is not `true`, since a
90%-of-TTL refresher relies on renewal.

## 11. P5 contract (consumers — separate later doc `learned-ttl-plan.md`)

1. **No record ⇒ existing behaviour, unchanged.** Missing, stale (> 30 d), ineligible, inconsistent, or another
   key/model/tier ⇒ keepalive behaves exactly as today (configured interval ≤ 240 s, `ASSUMED_TTL_MS` 300 s,
   `onProvenHit` renewing to `pingStartedAt + 300 s`, same retry deadline and accounting).
2. **Learned profile, frozen per window.** When a record is used, the window's `I` and `L` are derived once at
   `onRealRequest` and stored in `WindowState`; `onRealRequest`, `onProvenHit`, the retry deadline
   (`aliveUntil − TTL_SAFETY_MARGIN_MS`) and that window's own `closeWindowAccounting` all use the window's frozen `L`
   (the closing accounting of window k never uses window k+1's `L`).
3. **Config path unchanged**: `keepaliveIntervalMs` stays clamped to 240 s; the learned values are route-derived.
4. **Priority**: `native-warmer` and every existing gate first; unproven/miss and proven-write breakers unchanged.
5. **Shorten / lengthen (ruling 5)** from `lowerMs` only: `L = lowerMs`, `I = floor(0.8·lowerMs) − TTL_SAFETY_MARGIN_MS`;
   an empirical cadence, not a guarantee.
6. **Renewal (ruling 10)** applies only to the learned profile: a proven-hit ping may extend the window's lifetime to
   `pingStartedAt + L` only when `renewsOnRead === "true"` for that key and tier; otherwise lifetime stays anchored at
   `windowStartAt + L` (≤ one useful ping per window). Which bases qualify: Q1.
7. **Never prove cold from measurements**: warmth may only lower warm trust (`min(NOMINAL_5M_MS, lowerMs)`) or answer
   `unknown`.

## 12. Packages, ownership, gates

| Pkg | Owner files (exclusive)                                                                                                                                                                                                                                                                                                                                     | Depends    | Gate                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------- |
| M0  | `src/cache-ttl/pipeline-ping-types.ts` (additive), `src/cache-ttl/measure-types.ts` (plan, actions, sample, renewal, record, claim, cost types) — main session                                                                                                                                                                                              | —          | typecheck              |
| P1  | `pipeline-ping.ts`, anthropic parts of `measure-usage.ts` / `measure-payload.ts`, `measure-route.ts` + their tests                                                                                                                                                                                                                                          | M0         | §9 P1                  |
| P2  | openai parts of `measure-usage.ts` / `measure-payload.ts` / `pipeline-ping.ts`, `tests/cache-ttl/measure-openai.test.ts`, `tests/conformance/measure-openai-build.test.ts`                                                                                                                                                                                  | P1         | §9 P2                  |
| P3  | `measure-{prefix,plan,actions,classify,renewal,runner,store,claim,args}.ts` + `tests/cache-ttl/measure-*.test.ts`                                                                                                                                                                                                                                           | M0 (∥ P1)  | §9 P3                  |
| P4  | `measure-command.ts`, `cache-ttl.ts` (raw-arg branch, completions, USAGE, status line), `src/web-hub/agent/command-policy.ts` (row), `tests/cache-ttl/measure-command.test.ts`, `tests/conformance/measure-build.test.ts`, `tests/integration/cache-ttl-measure.test.ts`, `tests/web-hub/agent/command-policy.test.ts` (append), `AGENTS.md` (one sentence) | P1, P2, P3 | §9 P4; `npm run build` |
| P5  | later, own doc (§11)                                                                                                                                                                                                                                                                                                                                        | P4         | own review             |

All `src/cache-ttl/measure-*.ts` are pi-free except `measure-command.ts`. Real-machine acceptance after P4
(user-approved, conditional worst ≈ $1 per run): one Anthropic relay, one `openai-responses` route; compare with
`protocol-probe-results.md` (cr-response: hit at 6 min, miss observed ≤ 11 min ⇒ renewal pair 6→11 only if timing allows, else `unknown(pair-ineligible)`).

## 13. Residual risks (disclosed)

One sample per gap under a 6-prefix load; misses may be eviction. An **undetectable** backend/key split (same prompt
size, different cache shard) can produce misses — and therefore a wrong `missMs` or an ineligible/`unknown` renewal —
that v1 cannot recognise; it can never produce `renewsOnRead: "false"`, and a `true` on a `paired-empirical` basis
rests on the stated assumptions. Relays can break the cost conditions (C1–C3); the guard stops the run after the first
request that shows it. A stuck transport blocks new runs until restart. Progress may be lost on exit (§7.3).

## Open questions (r3)

1. **Does `renewsOnRead: "true"` with basis `paired-empirical` allow P5 lengthening** (ruling 10 says lengthening
   needs `true`)? **Recommended: yes** — on relays an authoritative basis does not exist, so requiring it would mean
   ruling 5's lengthening never applies where it matters; keepalive's unproven/miss breakers still catch a wrong
   inference. Alternative: documented basis only.
2. **One declared post-miss request**: the boundary renewal read runs after the first TTL miss (it is the only way to
   compare an older touched prefix with a missed untouched one). Accept as the single exception to ruling 2?
   **Recommended: yes** (shown in the plan and confirm; at most one request).

## Revision log (r4)

| #   | Finding (r_5AD6SW48)                                 | Change                                                                                                       |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| a   | C1/guard used `T_hi + 512`, the bound priced `T_hi`  | ONE `P_bound` for estimate, guard and context admission, priced at the tier `P_bound` falls into (§4.3, §1)  |
| b   | guard would stop cr-response (~19k with 4k baseline) | `INJECTION_ALLOWANCE = 4608` in `P_bound` (≈ 20.9k); worst case restated (≈ $1.33 Sonnet-class) (§4.3)       |
| c   | only `costComplete` requests summed                  | Per-request `knownUsd` of every reported component + `unknownUsd` range for unreported ones (§4.3, §5.2, §8) |

## Revision log (r3)

| #   | Finding (r_VBVDCK1E)                        | Change                                                                                                                                                                                                                              |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | renewal not designed, no budget room        | §5.5 boundary-pair design, eligibility, bases, verdicts, record; cap 17; estimate/schema/M0/gates updated (§4, §8, §9, §12)                                                                                                         |
| 2   | protected set gaps; caps not exact          | `instructions`/`prompt` ⇒ extra-input; every output cap a positive integer equal to `OUTPUT_CAP` (Completions 1, matching the estimate); dual caps ⇒ refuse; `service_tier` billing gate; content validated after conversion (§3.3) |
| 3   | `T_hi` is not a worst case                  | Hard request cap separated from a conditional cost bound with conditions C1–C3 + runtime bound guard (§4.3)                                                                                                                         |
| 4   | managed effort / roles / compat conversions | Stock-construction table (OAuth, managed effort, developer/system, `input_text`, compat markers); real-builder conformance (§3.3, §9)                                                                                               |
| 5   | endpoint key replay-only                    | Run-wide route key from the first valid write; every later request kind checked (§5.1, §6)                                                                                                                                          |
| 6   | claim misses confirm-pending start          | `preparing` state before confirm, revocable on shutdown; owner/runId/generation fences after every await; tests (§7.1, §9)                                                                                                          |
| 7   | evidence vs cost conflated                  | `cacheEvidence` and `billing` flags; unknown-billing items; cross-field constraints (§5.2)                                                                                                                                          |
| 8   | P5 fallback scope                           | No-record path keeps existing behaviour incl. `onProvenHit` 300 s renewal; renewal rule only for the learned profile; per-window frozen `L` for its own accounting (§11)                                                            |
| 9   | 3xx on write contradictory                  | Single outcome → action table shared by runner and tests (§4.2)                                                                                                                                                                     |
| 10  | undetectable splits                         | Detectable vs undetectable split fakes; residual disclosed (§9, §13)                                                                                                                                                                |
| 11  | quit-loss wording                           | "all progress since the last successful save may be lost — in the extreme the whole run"; `lastSavedAt` shown (§1, §7.3)                                                                                                            |

## Revision log (r2)

r2 answered `r_YYG3KQPH` #1–20: frozen budget (#1, superseded by r3 §4.1); build-mode validator (#2); `Symbol.for`
claim (#3); strict reader (#4); fresh nonce after possibly-landed writes + minimum own prefix (#5); load label and
expiry-or-eviction misses (#6); lower-bound / unknown / ≥ 61 min semantics (#7); `sentAt`/`headersAt`, lateness guard,
`no-cache` vs `control-inconclusive` (#8); manual redirects, digest key, redacted label (#9); requested vs effective
tier (#10); observed vs possibly-billed cost (#11); token estimate range + context admission (#12); P5 moved to its
own doc with a contract (#13–14); async bounded persistence (#15); byte-budgeted store (#16); whole-file LWW (#17);
build-path conformance + P4 after P2 (#18); raw-arg parser shared with the web policy (#19); history and stored hint
dropped (#20).

## User rulings (2026-10-18)

1. v1 supports `anthropic-messages` + `openai-responses` + `openai-completions` (OpenAI readers stay in their own package P2).
2. Always stop at the first clear miss; no `--full` flag.
3. `/new`, `/resume` and fork cancel the run like `/reload`/exit (recommended answer, not separately asked).
4. Web-hub start requires `--yes` after the printed estimate (recommended answer).
5. **P5 may both shorten AND lengthen the keepalive interval** from the learned bounds (user chose this over shorten-only). Lengthening must use the measured LOWER bound with a safety margin, never the upper bound, and fall back to the pinned 240 s whenever the record is missing, stale, non-monotone, or for a different tier/endpoint/model.
6. Measurement spend only in the result file and the final notice (recommended answer).
7. `--long` (Anthropic 1h tier) is in v1.
8. A failed control read ends the run as "no cache" (recommended answer).
9. Fixed ~15k-token prefix and fixed gaps; no `--gaps`/`--tokens` flags in v1 (recommended answer).

### User rulings on r2 open questions (2026-10-18)

10. **v1 ALSO measures whether a cache read renews the TTL** (user chose this over "≤1 useful ping per window until proven"). Design it inside the same run and the same frozen request budget (re-derive the budget/estimate), e.g. a renewal probe on a prefix that was read-hit at t₁ and is read again at a time past the write-anchored bound but within t₁ + bound; record `renewsOnRead: true | false | unknown` with the same validity rules; the later keepalive doc may lengthen intervals beyond one useful ping per window only when `renewsOnRead === true` for that route/tier.
11. The confirm shows BOTH the typical cost and the worst-case bound.
12. Author's other r2 open questions take the recommended answers: partial result may be lost on quit (said in the confirm text); whole-file last-writer-wins across pi processes; Responses explicit 30-minute cache measured and labelled `explicit-30m`; the payload validator tolerates unknown sampling keys and enforces only protected fields.

### User rulings on r3 open questions (2026-10-18)

13. A `paired-empirical` `renewsOnRead: true` is sufficient for the later keepalive doc to lengthen the interval (not only the `documented` basis); keepalive's existing miss/write breakers remain the safety net.
14. The single boundary renewal read right after the first valid TTL miss is accepted as the one declared exception to ruling 2 (stated in the plan and the confirm text; at most 1 request).

## Implementation / launch gates from the r4 review (pass-with-changes)

- G-a: boundary tests use the frozen `P_bound−1 / P_bound / P_bound+1` directly, plus a real ~19.2k baseline fixture (don't assume "+6k injection ⇒ over the bound").
- G-b: renewal eligibility (§5.5) is verified with the actual send intervals, the uncertainty interval and the 30 s deadline — never by prose like "comfortably"; 6→11 and 11→21 have only ~1 min nominal slack and slot 5 shifts with the control anchor.
- G-c: a user-approved real-endpoint acceptance covers managed effort (forced adaptive thinking + `max_tokens:1`) and exact OAuth identity; never silently raise an output cap to pass it.
- G-d: before dispatch, P3's test ownership is narrowed to exact paths of its own modules (no wildcard overlapping P1/P2 tests).
- r2 minors #5–7 remain implementation gates.
