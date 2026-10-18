# Keepalive on non-Anthropic protocols — live probe results

Date: 2026-10-18 · script: `scripts/exp/keepalive-protocol-probe.mjs` · raw records: `/tmp/keepalive-probe/records.json`
(token counts / timings / usage key names only; no content, no credentials).
Question: would cache keepalive pings pay off on `openai-responses` / `openai-completions` routes
(today keepalive only runs on `anthropic-messages`: plan.md, `keepalive-state.ts` gate G3)?

**Total spend, main run: $2.27 known + ~$0.12 estimated for aborted pings (usage not reported) ≈ $2.39** of the $5 cap (cap enforced per run). Two earlier smoke runs on the same routes (2.5k-token prefixes, scaled-down timeline) cost ≈ $0.61 and ≈ $0.10 ⇒ **≈ $3.1 overall** (plus up to ≈ $0.4 if the unapplied gpt-6.x write premium below were real).

## Verdicts

| Route                                      | Cache works                                                                 | Survives WITHOUT ping (one sample per gap)                  | Pings extend it?                                                                                                                                                                                                                                          | Ping cost vs miss cost (15k-token prefix)                                                                                                                      | Verdict                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| copilot-response / gpt-6.1-sol (Responses) | yes (immediate exact + tail 100%)                                           | **< 6 min** (6m, 11m, 21m all miss)                         | yes — real@11m / @21m hit with both ping modes; but 1 of 5 full 4-min pings (the @8m one) itself missed ⇒ 4 min is marginal, use ≤3–4 min                                                                                                                 | hit ping $0.0015 vs miss $0.0296 ⇒ break-even ≈ 19 pings (≈ 75 min idle @4 min) **if every ping hits**; at the observed 4/5 hit rate ≈ 4 pings (≈ 16 min)      | **keepalive worth it** (best ratio: input $2 vs read $0.1)                                                                                                                                                                                                                                                                   |
| cr-response / gpt-6-sol (Responses)        | yes, **only with `prompt_cache_key`** (4/4 tail hits with key, 0/4 without) | **6 min hit, 11 min miss, 21 min miss** ⇒ TTL ∈ (6, 11] min | yes — real@11m and @21m hit (98–100%) in all three ping arms; but the FIRST 4-min full ping after the write missed (B arm: cached 4096 = injected baseline only, own 0%, $0.0307) while pings @8/12/16/20m hit ⇒ 4/5 hit rate, 4 min is marginal here too | hit ping $0.0034–0.0043 vs miss $0.030 ⇒ break-even ≈ 9 pings (≈ 35 min idle @4 min) **if every ping hits**; at the observed 4/5 hit rate ≈ 3 pings (≈ 12 min) | **keepalive worth it**, with caveats: relay mixes two backend classes (some answers carry a ~4.1k-token injected prefix: prompt 19k vs 14.8k and a 4096–4224 "baseline" cache even for fresh nonces); keep `prompt_cache_key` in the replay                                                                                  |
| zhipu-pool / gpt-6-sol (Responses)         | yes (first repeat sometimes needs 10–15 s to materialise)                   | **≥ 21 min** (6/11/21 min all hit 98%)                      | n/a — hit anyway                                                                                                                                                                                                                                          | hit ping $0.0034 vs miss $0.030                                                                                                                                | **pointless up to 21 min** (cache long-lived anyway). Longer TTL not probed (30/45/60 min would be a follow-up); `prompt_cache_retention` ⇒ HTTP 400 unsupported                                                                                                                                                             |
| cr-kimi / kimi-k3 (Completions)            | yes (exact + tail 100%, `cached_tokens` = prompt−1)                         | **6 min hit, 11 min hit, 21 min miss** ⇒ TTL ∈ (11, 21) min | yes — real@11m / @21m hit with both ping modes                                                                                                                                                                                                            | hit ping $0.0041 vs miss $0.041 ⇒ break-even ≈ 9 pings; with a ~10 min cadence (TTL > 11 min) ≈ 90 min idle                                                    | **keepalive worth it** (largest absolute saving per avoided miss, $0.037); per idle hour a 10-min cadence costs ≈ $0.025 — about the same as copilot-response at 4 min (≈ $0.023), cheaper than cr-response (≈ $0.065 @4 min) and glm (≈ $0.039 @6 min), provided the cadence follows the TTL (≈ 8–10 min) rather than 4 min |
| cr-glm / glm-5.3 (Completions)             | yes (exact + tail 100%)                                                     | **6 min hit, 11 min miss, 21 min miss** ⇒ TTL ∈ (6, 11] min | yes — real@11m / @21m hit with both ping modes                                                                                                                                                                                                            | hit ping $0.0039 vs miss $0.0208 ⇒ break-even only ≈ 4.3 pings (≈ 17 min idle @4 min, ≈ 26 @6 min)                                                             | **marginally worth it**: pays only for idle spells ≲ 20 min; needs a tight per-window ping cap                                                                                                                                                                                                                               |
| copilot-completion / kimi-k3 (Completions) | **not measured**                                                            | –                                                           | –                                                                                                                                                                                                                                                         | –                                                                                                                                                              | **unmeasured**: upstream answered HTTP 429 `Rate limited` for the whole run (the M0 write retried 10× with 8–60 s backoff, ≈ 8 min, and never succeeded; recorded in `records.json`)                                                                                                                                         |

Reading the table: price ratios are `(input − cacheRead) / cacheRead` per route (models.json prices). A miss is billed at the
INPUT price and a ping at ≈ the cache-read price of the prefix; an avoided miss saves `(input − cacheRead) × prefix`.
**Cost-model limits**: the probe's `normUsage` dropped `input_tokens_details.cache_write_tokens` (values were not captured), and
the gpt-6.x `cacheWrite` price of 2.5 (vs input 2) was not applied. If the relay really billed write tokens at 2.5, every
miss/write above is understated by up to 25% — conservative for the verdicts (keepalive would look slightly better) but it
understates the spend by ≈ $0.4 on the Responses routes. The script now keeps `cache_write_tokens` (and prices it at
`cacheWrite` when > 0) for future runs; the existing tables are unchanged.
**Break-even** = pings per avoided miss ⇒ idle window a ping loop still pays for. With every ping a hit it is
`(input − cacheRead) / cacheRead` pings; with a ping hit rate `p` a missed ping costs a full miss, so
`(m − h) / (p·h + (1−p)·m)` (h = cacheRead, m = input, prefix-token units): copilot-response 1.9/(0.08+0.4) ≈ 4.0 pings,
cr-response 1.8/(0.16+0.4) ≈ 3.2 pings at p = 0.8 (the observed 4/5 on both; **n = 5, one miss each — indicative only**). The
all-hit figures are upper bounds. Keepalive pays when the real idle gap exceeds the TTL **and** is shorter than
`break-even pings × interval`; the existing per-window ping cap logic is the right shape for this.

## What this means for a non-Anthropic keepalive (design inputs)

1. **Aborted pings DO populate/refresh the cache but never report usage.** `abort-at-first-event` (what `ping-client` does) leaves
   `response.created` (Responses) / the first delta chunk (Completions) with no usage on every route; TTFE was 1–7 s (prefill
   happens before the first event: an aborted write was a hit for a repeat on copilot-response, glm and kimi; zhipu hit only
   on the second repeat (10–15 s of materialisation lag); cr-response's abort-write check is **not measured** — its repeat returned
   only the injected 4096-token baseline and the retry condition (`cached === 0`) never fired on a route with such a baseline). So `proven-hit` classification is impossible for aborted pings on these protocols. The A-arms
   (first-event pings only) still gave real hits at 11 and 21 min on every route where the cache expires at all.
2. **Full-completion pings with minimal output are cheap and provable**: `max_output_tokens:16` (Responses floor) /
   `max_tokens:1` ⇒ 0–5 output tokens, usage reported at the end (`cached_tokens` ≈ prefix), cost ≈ cache-read price of the
   prefix ($0.0015–0.0043 per 15k-token ping). If a non-Anthropic keepalive is built, the full tiny ping is the one that can be
   verified; the aborted one is unprovable.
3. **Usage field names** (raw key paths): Responses (all three routes) `input_tokens`, `input_tokens_details.cached_tokens`,
   `input_tokens_details.cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens`, `total_tokens`
   (+ `attribution.items.<id>.*` on cr-response/zhipu). Completions: cr-kimi `prompt_tokens`, `prompt_tokens_details.cached_tokens`,
   `completion_tokens(_details.reasoning_tokens)`, `output_tokens_details.reasoning_tokens`; cr-glm the same plus
   `prompt_tokens_details.{text,audio,image}_tokens`, `usage_semantic`, `usage_source`, `input_tokens(_details)`,
   `output_tokens` and `claude_cache_creation_{5_m,1_h}_tokens` (relay-translated; no top-level `prompt_cache_hit_tokens`/`cached_tokens`
   was seen on these routes). pi's `parseChunkUsage` already reads `prompt_tokens_details.cached_tokens`.
4. **`prompt_cache_key` matters on Responses relays.** pi sends it (sessionId) and a verbatim ping replay keeps it: cr-response
   hit 4/4 with the key and 0/4 without (only the 4.2k injected prefix cached); copilot-response 4/4 vs 3/4; zhipu 4/4 vs 4/4.
5. **Long retention**: `prompt_cache_retention:"24h"` is rejected (HTTP 400) by zhipu-pool and silently accepted-but-ineffective on
   copilot-response and cr-response (the 21-min re-request still missed). Not tested on Completions (pi only sends it when
   `compat.supportsLongCacheRetention`, which is false for copilot kimi-k3 and unset elsewhere). So no cheap long-retention
   alternative to pings was found.
6. **Quirks**: copilot-response rejects `reasoning.effort:"none"` (needs `"low"`; irrelevant to a verbatim replay). Newly written
   prefixes on zhipu/glm/cr-kimi sometimes need 5–15 s before a repeat hits (M0 retries), so an immediate re-request after a
   write is not a reliable "cache is live" probe.

## Method

- **Requests**: raw `fetch` to `<baseUrl>/responses` or `/chat/completions` (endpoint + key from pi's `ModelRuntime.getAuth`;
  never printed/written), streaming, payload shaped like pi's providers (`store:false`, `stream_options.include_usage`,
  `prompt_cache_key=<per-prefix key>` on Responses, `max_tokens`/`max_output_tokens` small, developer/system role like pi).
- **Prefix**: nonce-first system message + deterministic log-shaped filler (word-salad is refused by some models), one fresh
  nonce per independent timeline. **Prefix ≈ 15k tokens, not 20k**: a smoke run at 2.5k tokens already cost $0.6 (mostly
  forced misses; a second smoke run cost ≈ $0.10), so the target was cut to 15k to keep the worst case under the $5 cap. cr-response prompts show 14.8k or 19k
  depending on backend (injected prefix).
- **Timelines** are measured from the completion of each prefix's write request and run fully in parallel per route
  (24.0 min wall, 23.99 min to the last record). M1 = write → idle 6/11/21 min → _appended-tail_ request (assistant "OK" + new user turn = what a real next
  turn looks like). M2 = write → ping every 4 min (replay of the write payload with minimal output; **A** = abort at the first
  stream event as `ping-client` does, **B** = let it finish) → real appended-tail request at 11 min (A only) and 21 min (A, B).
  M0 = write, exact replay, appended-tail, abort-write-then-repeat, key vs no-key 4-request series (Responses only), retention
  re-request (Responses only). A "hit" = (cached − what the write itself already showed) ≥ 80% of the remaining prompt.
- **Cost** = `(prompt − cached)·input + cached·cacheRead + output·output` per route price; aborted pings report no usage and are
  estimated at the cache-read price (optimistic; flagged `~` in the tables).
- **Caveats**: one sample per gap per route (brackets are single-observation, not distributions); `replay@21m` rows after a miss
  are NOT diagnostic (the missed request itself re-writes the prefix blocks); idle waits used ref'd timers on purpose (a
  standalone Node script — an unref'd wait would exit silently), with a hard-deadline kill; copilot-completion unmeasured.
- Reproduce: `node scripts/exp/keepalive-protocol-probe.mjs --routes <a/b,c/d> [--delays 0,90] [--tokens 15000] [--cap-usd 5]`
  and `--report /tmp/keepalive-probe/records.json` for the tables below.

## Per-route request tables (generated)

`cached` is the provider-reported cached-token count; `share` = cached/prompt (own% = excluding what the write already showed).
t is seconds since script start.

Total known spend: $2.2708 (+ estimated aborted-ping spend $0.1227); cap $5.0000.

### copilot-response/gpt-6.1-sol (openai-responses, <ip>:8022)

Prices $/M: input 2, cacheRead 0.1, cacheWrite 2.5, output 10. Usage key paths seen: input_tokens, input_tokens_details.cache_write_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens, total_tokens.

| t(s)   | arm                     | req             | mode        | HTTP | prompt tok | cached | share | out tok | TTFE ms | cost     | note                                                              |
| ------ | ----------------------- | --------------- | ----------- | ---- | ---------- | ------ | ----- | ------- | ------- | -------- | ----------------------------------------------------------------- |
| 0.0    | M0                      | write           | full        | 200  | 14799      | 0      | 0%    | 5       | 2689    | $0.0296  |                                                                   |
| 6.3    | M0                      | R0'(exact)      | full        | 200  | 14799      | 14796  | 100%  | 5       | 2526    | $0.0015  |                                                                   |
| 11.5   | M0                      | R0''(tail)      | full        | 200  | 14825      | 14796  | 100%  | 5       | 1943    | $0.0016  |                                                                   |
| 13.5   | M1-idle6m               | write           | full        | 200  | 14796      | 0      | 0%    | 5       | 2778    | $0.0296  |                                                                   |
| 16.0   | M1-idle11m              | write           | full        | 200  | 14832      | 0      | 0%    | 5       | 2180    | $0.0297  |                                                                   |
| 18.5   | M1-idle21m              | write           | full        | 200  | 14829      | 0      | 0%    | 5       | 2815    | $0.0297  |                                                                   |
| 21.0   | M2-A-real11             | write           | full        | 200  | 14800      | 0      | 0%    | 5       | 1804    | $0.0296  |                                                                   |
| 23.5   | M2-A-real21             | write           | full        | 200  | 14811      | 0      | 0%    | 5       | 2168    | $0.0297  |                                                                   |
| 26.0   | M2-B-real21             | write           | full        | 200  | 14821      | 0      | 0%    | 5       | 2117    | $0.0297  |                                                                   |
| 28.5   | M0-first-event          | abort-write     | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2520    | ~$0.0015 | aborted; usage not reported                                       |
| 31.0   | M0-stab-key=true        | write           | full        | 200  | 14832      | 0      | 0%    | 5       | 2554    | $0.0297  |                                                                   |
| 33.5   | M1-retention24h-idle21m | write           | full        | 200  | 14816      | 0      | 0%    | 5       | 2163    | $0.0297  |                                                                   |
| 34.0   | M0-first-event          | repeat#1(exact) | full        | 200  | 14816      | 14813  | 100%  | 5       | 2012    | $0.0015  |                                                                   |
| 50.1   | M0-stab-key=true        | repeat#1(tail)  | full        | 200  | 14858      | 14829  | 100%  | 5       | 2171    | $0.0016  |                                                                   |
| 67.4   | M0-stab-key=true        | repeat#2(tail)  | full        | 200  | 14858      | 14829  | 100%  | 5       | 2336    | $0.0016  |                                                                   |
| 84.7   | M0-stab-key=true        | repeat#3(tail)  | full        | 200  | 14858      | 14829  | 100%  | 5       | 2177    | $0.0016  |                                                                   |
| 102.0  | M0-stab-key=true        | repeat#4(tail)  | full        | 200  | 14858      | 14829  | 100%  | 5       | 2160    | $0.0016  |                                                                   |
| 105.0  | M0-stab-key=false       | write           | full        | 200  | 14820      | 0      | 0%    | 5       | 3650    | $0.0297  |                                                                   |
| 124.0  | M0-stab-key=false       | repeat#1(tail)  | full        | 200  | 14846      | 14817  | 100%  | 5       | 2305    | $0.0016  |                                                                   |
| 142.3  | M0-stab-key=false       | repeat#2(tail)  | full        | 200  | 14846      | 0      | 0%    | 5       | 2451    | $0.0297  |                                                                   |
| 160.1  | M0-stab-key=false       | repeat#3(tail)  | full        | 200  | 14846      | 14817  | 100%  | 5       | 3701    | $0.0016  |                                                                   |
| 179.2  | M0-stab-key=false       | repeat#4(tail)  | full        | 200  | 14846      | 14817  | 100%  | 5       | 3182    | $0.0016  |                                                                   |
| 262.8  | M2-A-real11             | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2852    | ~$0.0015 | aborted; usage not reported                                       |
| 265.8  | M2-A-real21             | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2481    | ~$0.0015 | aborted; usage not reported                                       |
| 268.2  | M2-B-real21             | ping@4m         | full        | 200  | 14821      | 14818  | 100%  | 5       | 2197    | $0.0015  |                                                                   |
| 376.3  | M1-idle6m               | real@6m         | full        | 200  | 14822      | 0      | 0%    | 5       | 2972    | $0.0297  |                                                                   |
| 502.8  | M2-A-real11             | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2635    | ~$0.0015 | aborted; usage not reported                                       |
| 505.8  | M2-A-real21             | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2784    | ~$0.0015 | aborted; usage not reported                                       |
| 508.2  | M2-B-real21             | ping@8m         | full        | 200  | 14821      | 0      | 0%    | 5       | 4462    | $0.0297  |                                                                   |
| 679.3  | M1-idle11m              | real@11m        | full        | 200  | 14858      | 0      | 0%    | 5       | 3836    | $0.0298  |                                                                   |
| 682.8  | M2-A-real11             | real@11m        | full        | 200  | 14826      | 14797  | 100%  | 5       | 2275    | $0.0016  |                                                                   |
| 745.8  | M2-A-real21             | ping@12m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2945    | ~$0.0015 | aborted; usage not reported                                       |
| 748.2  | M2-B-real21             | ping@12m        | full        | 200  | 14821      | 14818  | 100%  | 5       | 2573    | $0.0015  |                                                                   |
| 985.8  | M2-A-real21             | ping@16m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2804    | ~$0.0015 | aborted; usage not reported                                       |
| 988.2  | M2-B-real21             | ping@16m        | full        | 200  | 14821      | 14818  | 100%  | 5       | 2427    | $0.0015  |                                                                   |
| 1228.2 | M2-B-real21             | ping@20m        | full        | 200  | 14821      | 14818  | 100%  | 5       | 2552    | $0.0015  |                                                                   |
| 1225.8 | M2-A-real21             | ping@20m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 7280    | ~$0.0015 | aborted; usage not reported                                       |
| 1281.3 | M1-idle21m              | real@21m        | full        | 200  | 14855      | 0      | 0%    | 5       | 2590    | $0.0298  |                                                                   |
| 1285.8 | M2-A-real21             | real@21m        | full        | 200  | 14837      | 14808  | 100%  | 5       | 2393    | $0.0016  |                                                                   |
| 1288.2 | M2-B-real21             | real@21m        | full        | 200  | 14847      | 14818  | 100%  | 5       | 2920    | $0.0016  |                                                                   |
| 1288.9 | M1-idle21m              | replay@21m      | full        | 200  | 14829      | 0      | 0%    | 5       | 2374    | $0.0297  | exact replay after a miss: expired vs prefix-extension-never-hits |
| 1295.7 | M1-retention24h-idle21m | real@21m        | full        | 200  | 14842      | 0      | 0%    | 5       | 2734    | $0.0297  |                                                                   |
| 1302.7 | M1-retention24h-idle21m | replay@21m      | full        | 200  | 14816      | 0      | 0%    | 5       | 2360    | $0.0297  | exact replay after a miss: expired vs prefix-extension-never-hits |

Route spend: known $0.5613, est. aborted $0.0118.

### cr-response/gpt-6-sol (openai-responses, console.cloudrouter.online)

Prices $/M: input 2, cacheRead 0.2, cacheWrite 2.5, output 10. Usage key paths seen: input_tokens, input_tokens_details.cache_write_tokens, input_tokens_details.cached_tokens, output_tokens, output_tokens_details.reasoning_tokens, total_tokens, attribution.items.<id>.input_tokens, attribution.items.<id>.cached_tokens, attribution.items.<id>.cache_write_tokens, attribution.items.<id>.output_tokens, attribution.items.<id>.content, attribution.request_fields.instructions.input_tokens, attribution.request_fields.instructions.cached_tokens, attribution.request_fields.instructions.cache_write_tokens, attribution.request_fields.instructions.output_tokens, attribution.request_fields.tools.cache_write_tokens, attribution.request_fields.tools.cached_tokens, attribution.request_fields.tools.input_tokens, attribution.request_fields.tools.output_tokens.

| t(s)   | arm                     | req             | mode        | HTTP | prompt tok | cached | share         | out tok | TTFE ms | cost     | note                                                              |
| ------ | ----------------------- | --------------- | ----------- | ---- | ---------- | ------ | ------------- | ------- | ------- | -------- | ----------------------------------------------------------------- |
| 0.0    | M0                      | write           | full        | 200  | 14795      | 0      | 0%            | 25      | 2596    | $0.0298  |                                                                   |
| 5.3    | M0                      | R0'(exact)      | full        | 200  | 14795      | 14792  | 100%          | 24      | 1414    | $0.0032  |                                                                   |
| 9.6    | M0                      | R0''(tail)      | full        | 200  | 14821      | 14792  | 100%          | 5       | 1376    | $0.0031  |                                                                   |
| 13.5   | M1-idle11m              | write           | full        | 200  | 14799      | 0      | 0%            | 32      | 2284    | $0.0299  |                                                                   |
| 11.0   | M1-idle6m               | write           | full        | 200  | 19190      | 4224   | 22%           | 5       | 3740    | $0.0308  |                                                                   |
| 21.0   | M2-A-real21             | write           | full        | 200  | 14834      | 0      | 0%            | 38      | 2510    | $0.0300  |                                                                   |
| 18.5   | M2-A-real11             | write           | full        | 200  | 15129      | 0      | 0%            | 32      | 5686    | $0.0306  |                                                                   |
| 16.0   | M1-idle21m              | write           | full        | 200  | 19028      | 4096   | 22%           | 24      | 8309    | $0.0309  |                                                                   |
| 23.5   | M2-B-real21             | write           | full        | 200  | 19002      | 4096   | 22%           | 25      | 3652    | $0.0309  |                                                                   |
| 26.0   | M0-first-event          | abort-write     | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 2441    | ~$0.0030 | aborted; usage not reported                                       |
| 28.5   | M0-stab-key=true        | write           | full        | 200  | 19032      | 4096   | 22%           | 25      | 2745    | $0.0309  |                                                                   |
| 31.4   | M0-first-event          | repeat#1(exact) | full        | 200  | 19025      | 4096   | 22%           | 5       | 1631    | $0.0307  |                                                                   |
| 48.0   | M0-stab-key=true        | repeat#1(tail)  | full        | 200  | 19058      | 18816  | 99% (own 98%) | 18      | 2786    | $0.0044  |                                                                   |
| 31.0   | M1-retention24h-idle21m | write           | full        | 200  | 19196      | 4224   | 22%           | 28      | 1917    | $0.0311  |                                                                   |
| 66.9   | M0-stab-key=true        | repeat#2(tail)  | full        | 200  | 19058      | 18816  | 99% (own 98%) | 21      | 3470    | $0.0045  |                                                                   |
| 86.2   | M0-stab-key=true        | repeat#3(tail)  | full        | 200  | 19058      | 18816  | 99% (own 98%) | 17      | 1709    | $0.0044  |                                                                   |
| 105.0  | M0-stab-key=true        | repeat#4(tail)  | full        | 200  | 19058      | 18816  | 99% (own 98%) | 18      | 4907    | $0.0044  |                                                                   |
| 110.7  | M0-stab-key=false       | write           | full        | 200  | 19196      | 4224   | 22%           | 20      | 1930    | $0.0310  |                                                                   |
| 172.7  | M0-stab-key=false       | repeat#1(tail)  | full        | 200  | 19222      | 4224   | 22% (own 0%)  | 5       | 2577    | $0.0309  |                                                                   |
| 250.8  | M0-stab-key=false       | repeat#2(tail)  | full        | 200  | 19222      | 4224   | 22% (own 0%)  | 5       | 2820    | $0.0309  |                                                                   |
| 263.7  | M2-A-real21             | ping@4m         | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 1852    | ~$0.0030 | aborted; usage not reported                                       |
| 265.3  | M2-A-real11             | ping@4m         | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 1998    | ~$0.0030 | aborted; usage not reported                                       |
| 267.9  | M2-B-real21             | ping@4m         | full        | 200  | 19002      | 4096   | 22% (own 0%)  | 5       | 2466    | $0.0307  |                                                                   |
| 269.0  | M0-stab-key=false       | repeat#3(tail)  | full        | 200  | 19222      | 4224   | 22% (own 0%)  | 5       | 3199    | $0.0309  |                                                                   |
| 287.7  | M0-stab-key=false       | repeat#4(tail)  | full        | 200  | 19222      | 4224   | 22% (own 0%)  | 5       | 2976    | $0.0309  |                                                                   |
| 376.5  | M1-idle6m               | real@6m         | full        | 200  | 19216      | 19072  | 99% (own 99%) | 5       | 2110    | $0.0042  |                                                                   |
| 503.7  | M2-A-real21             | ping@8m         | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 1848    | ~$0.0030 | aborted; usage not reported                                       |
| 505.3  | M2-A-real11             | ping@8m         | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 3099    | ~$0.0030 | aborted; usage not reported                                       |
| 507.9  | M2-B-real21             | ping@8m         | full        | 200  | 19002      | 18816  | 99% (own 99%) | 20      | 3294    | $0.0043  |                                                                   |
| 676.0  | M1-idle11m              | real@11m        | full        | 200  | 14825      | 0      | 0%            | 5       | 3276    | $0.0297  |                                                                   |
| 685.3  | M2-A-real11             | real@11m        | full        | 200  | 15155      | 14976  | 99%           | 28      | 3578    | $0.0036  |                                                                   |
| 743.8  | M2-A-real21             | ping@12m        | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 2040    | ~$0.0030 | aborted; usage not reported                                       |
| 747.9  | M2-B-real21             | ping@12m        | full        | 200  | 19002      | 18816  | 99% (own 99%) | 17      | 1926    | $0.0043  |                                                                   |
| 983.8  | M2-A-real21             | ping@16m        | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 1628    | ~$0.0030 | aborted; usage not reported                                       |
| 987.9  | M2-B-real21             | ping@16m        | full        | 200  | 19002      | 18816  | 99% (own 99%) | 22      | 1353    | $0.0044  |                                                                   |
| 1223.7 | M2-A-real21             | ping@20m        | first-event | 200  | n/a        | n/a    | n/a           | n/a     | 2518    | ~$0.0030 | aborted; usage not reported                                       |
| 1227.9 | M2-B-real21             | ping@20m        | full        | 200  | 19002      | 18816  | 99% (own 99%) | 17      | 2687    | $0.0043  |                                                                   |
| 1283.7 | M2-A-real21             | real@21m        | full        | 200  | 14860      | 14831  | 100%          | 5       | 1503    | $0.0031  |                                                                   |
| 1287.9 | M2-B-real21             | real@21m        | full        | 200  | 19028      | 18816  | 99% (own 99%) | 18      | 1740    | $0.0044  |                                                                   |
| 1287.8 | M1-idle21m              | real@21m        | full        | 200  | 19054      | 4096   | 21% (own 0%)  | 17      | 2393    | $0.0309  |                                                                   |
| 1296.1 | M1-idle21m              | replay@21m      | full        | 200  | 19028      | 18816  | 99% (own 99%) | 23      | 2175    | $0.0044  | exact replay after a miss: expired vs prefix-extension-never-hits |
| 1313.7 | M1-retention24h-idle21m | real@21m        | full        | 200  | 19222      | 4224   | 22% (own 0%)  | 18      | 2560    | $0.0310  |                                                                   |
| 1340.6 | M1-retention24h-idle21m | replay@21m      | full        | 200  | 19196      | 4224   | 22% (own 0%)  | 17      | 3136    | $0.0310  | exact replay after a miss: expired vs prefix-extension-never-hits |

Route spend: known $0.6745, est. aborted $0.0238.

### zhipu-pool/gpt-6-sol (openai-responses, d2.fengqi-api.nekoai.one)

Prices $/M: input 2, cacheRead 0.2, cacheWrite 2.5, output 10. Usage key paths seen: input_tokens, input_tokens_details.cached_tokens, input_tokens_details.cache_write_tokens, output_tokens, output_tokens_details.reasoning_tokens, total_tokens, attribution.items.<id>.input_tokens, attribution.items.<id>.cached_tokens, attribution.items.<id>.cache_write_tokens, attribution.items.<id>.output_tokens, attribution.items.<id>.content.

| t(s)   | arm                     | req             | mode        | HTTP | prompt tok | cached | share | out tok | TTFE ms | cost     | note                                                                 |
| ------ | ----------------------- | --------------- | ----------- | ---- | ---------- | ------ | ----- | ------- | ------- | -------- | -------------------------------------------------------------------- |
| 0.0    | M0                      | write           | full        | 200  | 14801      | 0      | 0%    | 5       | 2226    | $0.0297  |                                                                      |
| 5.3    | M0                      | R0'(exact)      | full        | 200  | 14801      | 0      | 0%    | 5       | 1683    | $0.0297  |                                                                      |
| 17.6   | M0                      | R0'(exact)#2    | full        | 200  | 14801      | 14592  | 99%   | 5       | 1481    | $0.0034  |                                                                      |
| 22.4   | M0                      | R0''(tail)      | full        | 200  | 14827      | 14592  | 98%   | 5       | 1181    | $0.0034  |                                                                      |
| 26.8   | M1-idle6m               | write           | full        | 200  | 14818      | 0      | 0%    | 5       | 1507    | $0.0297  |                                                                      |
| 29.3   | M1-idle11m              | write           | full        | 200  | 14808      | 0      | 0%    | 5       | 1474    | $0.0297  |                                                                      |
| 31.8   | M1-idle21m              | write           | full        | 200  | 14830      | 0      | 0%    | 5       | 1415    | $0.0297  |                                                                      |
| 34.3   | M2-A-real11             | write           | full        | 200  | 14827      | 0      | 0%    | 5       | 1045    | $0.0297  |                                                                      |
| 36.8   | M2-A-real21             | write           | full        | 200  | 14838      | 0      | 0%    | 5       | 1033    | $0.0297  |                                                                      |
| 39.3   | M2-B-real21             | write           | full        | 200  | 14797      | 0      | 0%    | 5       | 1075    | $0.0296  |                                                                      |
| 41.8   | M0-first-event          | abort-write     | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1021    | ~$0.0030 | aborted; usage not reported                                          |
| 46.8   | M1-retention24h-idle21m | write           | full        | 400  | n/a        | n/a    | n/a   | n/a     | -       | n/a      | HTTP 400: {"detail":"Unsupported parameter: prompt_cache_retention"} |
| 45.9   | M0-first-event          | repeat#1(exact) | full        | 200  | 14800      | 0      | 0%    | 5       | 1903    | $0.0296  |                                                                      |
| 44.3   | M0-stab-key=true        | write           | full        | 200  | 14840      | 0      | 0%    | 5       | 3438    | $0.0297  |                                                                      |
| 58.3   | M0-first-event          | repeat#2(exact) | full        | 200  | 14800      | 14592  | 99%   | 5       | 1490    | $0.0034  |                                                                      |
| 64.2   | M0-stab-key=true        | repeat#1(tail)  | full        | 200  | 14866      | 14720  | 99%   | 5       | 1071    | $0.0033  |                                                                      |
| 80.8   | M0-stab-key=true        | repeat#2(tail)  | full        | 200  | 14866      | 14720  | 99%   | 5       | 1701    | $0.0033  |                                                                      |
| 98.3   | M0-stab-key=true        | repeat#3(tail)  | full        | 200  | 14866      | 14720  | 99%   | 5       | 1567    | $0.0033  |                                                                      |
| 115.4  | M0-stab-key=true        | repeat#4(tail)  | full        | 200  | 14866      | 14720  | 99%   | 5       | 1527    | $0.0033  |                                                                      |
| 117.5  | M0-stab-key=false       | write           | full        | 200  | 14806      | 0      | 0%    | 5       | 1971    | $0.0297  |                                                                      |
| 135.1  | M0-stab-key=false       | repeat#1(tail)  | full        | 200  | 14832      | 14592  | 98%   | 5       | 1703    | $0.0034  |                                                                      |
| 152.5  | M0-stab-key=false       | repeat#2(tail)  | full        | 200  | 14832      | 14592  | 98%   | 5       | 1611    | $0.0034  |                                                                      |
| 169.7  | M0-stab-key=false       | repeat#3(tail)  | full        | 200  | 14832      | 14592  | 98%   | 5       | 1572    | $0.0034  |                                                                      |
| 187.0  | M0-stab-key=false       | repeat#4(tail)  | full        | 200  | 14832      | 14592  | 98%   | 5       | 1737    | $0.0034  |                                                                      |
| 275.9  | M2-A-real11             | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1584    | ~$0.0030 | aborted; usage not reported                                          |
| 278.8  | M2-A-real21             | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1522    | ~$0.0030 | aborted; usage not reported                                          |
| 280.9  | M2-B-real21             | ping@4m         | full        | 200  | 14797      | 14592  | 99%   | 5       | 1563    | $0.0034  |                                                                      |
| 388.8  | M1-idle6m               | real@6m         | full        | 200  | 14844      | 14592  | 98%   | 5       | 2110    | $0.0035  |                                                                      |
| 515.9  | M2-A-real11             | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2266    | ~$0.0030 | aborted; usage not reported                                          |
| 518.8  | M2-A-real21             | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1301    | ~$0.0030 | aborted; usage not reported                                          |
| 520.9  | M2-B-real21             | ping@8m         | full        | 200  | 14797      | 14592  | 99%   | 5       | 1709    | $0.0034  |                                                                      |
| 691.4  | M1-idle11m              | real@11m        | full        | 200  | 14834      | 14592  | 98%   | 5       | 2036    | $0.0035  |                                                                      |
| 695.9  | M2-A-real11             | real@11m        | full        | 200  | 14853      | 14592  | 98%   | 5       | 1511    | $0.0035  |                                                                      |
| 758.8  | M2-A-real21             | ping@12m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1560    | ~$0.0030 | aborted; usage not reported                                          |
| 760.9  | M2-B-real21             | ping@12m        | full        | 200  | 14797      | 14592  | 99%   | 5       | 1507    | $0.0034  |                                                                      |
| 998.8  | M2-A-real21             | ping@16m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2435    | ~$0.0030 | aborted; usage not reported                                          |
| 1000.9 | M2-B-real21             | ping@16m        | full        | 200  | 14797      | 14592  | 99%   | 5       | 2179    | $0.0034  |                                                                      |
| 1238.8 | M2-A-real21             | ping@20m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1937    | ~$0.0030 | aborted; usage not reported                                          |
| 1240.9 | M2-B-real21             | ping@20m        | full        | 200  | 14797      | 14592  | 99%   | 5       | 1602    | $0.0034  |                                                                      |
| 1293.8 | M1-idle21m              | real@21m        | full        | 200  | 14856      | 14592  | 98%   | 5       | 1626    | $0.0035  |                                                                      |
| 1298.8 | M2-A-real21             | real@21m        | full        | 200  | 14864      | 14720  | 99%   | 5       | 1744    | $0.0033  |                                                                      |
| 1300.9 | M2-B-real21             | real@21m        | full        | 200  | 14823      | 14592  | 98%   | 5       | 2849    | $0.0034  |                                                                      |

Route spend: known $0.4011, est. aborted $0.0237.

### cr-kimi/kimi-k3 (openai-completions, console.cloudrouter.online)

Prices $/M: input 3, cacheRead 0.3, cacheWrite 0, output 15. Usage key paths seen: prompt_tokens, total_tokens, completion_tokens, prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens, output_tokens_details.reasoning_tokens.

| t(s)   | arm            | req             | mode        | HTTP | prompt tok | cached | share | out tok | TTFE ms | cost     | note                                                              |
| ------ | -------------- | --------------- | ----------- | ---- | ---------- | ------ | ----- | ------- | ------- | -------- | ----------------------------------------------------------------- |
| 0.0    | M0             | write           | full        | 200  | 13452      | 0      | 0%    | 48      | 7532    | $0.0411  |                                                                   |
| 10.3   | M0             | R0'(exact)      | full        | 200  | 13452      | 13451  | 100%  | 48      | 3292    | $0.0048  |                                                                   |
| 17.2   | M0             | R0''(tail)      | full        | 200  | 13502      | 13451  | 100%  | 15      | 2635    | $0.0044  |                                                                   |
| 22.7   | M1-idle11m     | write           | full        | 200  | 13498      | 0      | 0%    | 48      | 3811    | $0.0412  |                                                                   |
| 30.2   | M2-A-real21    | write           | full        | 200  | 13476      | 0      | 0%    | 48      | 6530    | $0.0411  |                                                                   |
| 20.2   | M1-idle6m      | write           | full        | 200  | 13496      | 0      | 0%    | 41      | 3965    | $0.0411  |                                                                   |
| 25.2   | M1-idle21m     | write           | full        | 200  | 13462      | 0      | 0%    | 48      | 7769    | $0.0411  |                                                                   |
| 27.7   | M2-A-real11    | write           | full        | 200  | 13470      | 0      | 0%    | 48      | 7023    | $0.0411  |                                                                   |
| 32.7   | M2-B-real21    | write           | full        | 200  | 13497      | 0      | 0%    | 48      | 4335    | $0.0412  |                                                                   |
| 35.2   | M0-first-event | abort-write     | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 3883    | ~$0.0040 | aborted; usage not reported                                       |
| 175.1  | M0-first-event | repeat#1(exact) | full        | 200  | 13461      | 13460  | 100%  | 48      | 4410    | $0.0048  |                                                                   |
| 307.6  | M2-A-real21    | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 4389    | ~$0.0040 | aborted; usage not reported                                       |
| 409.9  | M2-A-real11    | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 5091    | ~$0.0040 | aborted; usage not reported                                       |
| 411.8  | M2-B-real21    | ping@4m         | full        | 200  | 13497      | 13496  | 100%  | 1       | 4622    | $0.0041  |                                                                   |
| 518.5  | M1-idle6m      | real@6m         | full        | 200  | 13546      | 13495  | 100%  | 48      | 3252    | $0.0049  |                                                                   |
| 547.6  | M2-A-real21    | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 3784    | ~$0.0040 | aborted; usage not reported                                       |
| 650.0  | M2-A-real11    | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 7026    | ~$0.0040 | aborted; usage not reported                                       |
| 651.8  | M2-B-real21    | ping@8m         | full        | 200  | 13497      | 13496  | 100%  | 1       | 5993    | $0.0041  |                                                                   |
| 687.6  | M1-idle11m     | real@11m        | full        | 200  | 13548      | 13497  | 100%  | 40      | 5135    | $0.0048  |                                                                   |
| 787.6  | M2-A-real21    | ping@12m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 6124    | ~$0.0040 | aborted; usage not reported                                       |
| 830.0  | M2-A-real11    | real@11m        | full        | 200  | 13520      | 13469  | 100%  | 48      | 14590   | $0.0049  |                                                                   |
| 891.8  | M2-B-real21    | ping@12m        | full        | 200  | 13497      | 13496  | 100%  | 1       | 3957    | $0.0041  |                                                                   |
| 1027.6 | M2-A-real21    | ping@16m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 4454    | ~$0.0040 | aborted; usage not reported                                       |
| 1131.9 | M2-B-real21    | ping@16m        | full        | 200  | 13497      | 13496  | 100%  | 1       | 5839    | $0.0041  |                                                                   |
| 1267.6 | M2-A-real21    | ping@20m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 3188    | ~$0.0040 | aborted; usage not reported                                       |
| 1327.6 | M2-A-real21    | real@21m        | full        | 200  | 13526      | 13475  | 100%  | 15      | 7489    | $0.0044  |                                                                   |
| 1371.8 | M2-B-real21    | ping@20m        | full        | 200  | 13497      | 13496  | 100%  | 1       | 8287    | $0.0041  |                                                                   |
| 1427.5 | M1-idle21m     | real@21m        | full        | 200  | 13512      | 0      | 0%    | 48      | 3691    | $0.0413  |                                                                   |
| 1431.8 | M2-B-real21    | real@21m        | full        | 200  | 13547      | 13496  | 100%  | 48      | 6868    | $0.0049  |                                                                   |
| 1436.2 | M1-idle21m     | replay@21m      | full        | 200  | 13462      | 12288  | 91%   | 48      | 2081    | $0.0079  | exact replay after a miss: expired vs prefix-extension-never-hits |

Route spend: known $0.3954, est. aborted $0.0323.

### cr-glm/glm-5.3 (openai-completions, console.cloudrouter.online)

Prices $/M: input 1.4, cacheRead 0.26, cacheWrite 0, output 4.4. Usage key paths seen: prompt_tokens, completion_tokens, total_tokens, usage_semantic, usage_source, prompt_tokens_details.cached_tokens, prompt_tokens_details.text_tokens, prompt_tokens_details.audio_tokens, prompt_tokens_details.image_tokens, completion_tokens_details.text_tokens, completion_tokens_details.audio_tokens, completion_tokens_details.image_tokens, completion_tokens_details.reasoning_tokens, input_tokens, output_tokens, input_tokens_details, claude_cache_creation_5_m_tokens, claude_cache_creation_1_h_tokens.

| t(s)   | arm            | req             | mode        | HTTP | prompt tok | cached | share | out tok | TTFE ms | cost     | note                                                              |
| ------ | -------------- | --------------- | ----------- | ---- | ---------- | ------ | ----- | ------- | ------- | -------- | ----------------------------------------------------------------- |
| 0.0    | M0             | write           | full        | 200  | 14871      | 0      | 0%    | 0       | 2378    | $0.0208  |                                                                   |
| 5.0    | M0             | R0'(exact)      | full        | 200  | 14871      | 14848  | 100%  | 0       | 2936    | $0.0039  |                                                                   |
| 10.6   | M0             | R0''(tail)      | full        | 200  | 14891      | 14848  | 100%  | 0       | 1761    | $0.0039  |                                                                   |
| 12.5   | M1-idle6m      | write           | full        | 200  | 14879      | 0      | 0%    | 0       | 2107    | $0.0208  |                                                                   |
| 15.0   | M1-idle11m     | write           | full        | 200  | 14857      | 0      | 0%    | 0       | 1792    | $0.0208  |                                                                   |
| 17.5   | M1-idle21m     | write           | full        | 200  | 14893      | 0      | 0%    | 0       | 1415    | $0.0209  |                                                                   |
| 22.5   | M2-A-real21    | write           | full        | 200  | 14881      | 0      | 0%    | 0       | 1507    | $0.0208  |                                                                   |
| 20.0   | M2-A-real11    | write           | full        | 200  | 14871      | 0      | 0%    | 0       | 4988    | $0.0208  |                                                                   |
| 25.0   | M2-B-real21    | write           | full        | 200  | 14929      | 0      | 0%    | 0       | 1569    | $0.0209  |                                                                   |
| 27.5   | M0-first-event | abort-write     | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1753    | ~$0.0039 | aborted; usage not reported                                       |
| 32.2   | M0-first-event | repeat#1(exact) | full        | 200  | 14880      | 14848  | 100%  | 0       | 1324    | $0.0039  |                                                                   |
| 264.1  | M2-A-real21    | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1409    | ~$0.0039 | aborted; usage not reported                                       |
| 265.1  | M2-A-real11    | ping@4m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1585    | ~$0.0039 | aborted; usage not reported                                       |
| 266.6  | M2-B-real21    | ping@4m         | full        | 200  | 14929      | 14912  | 100%  | 0       | 1665    | $0.0039  |                                                                   |
| 374.8  | M1-idle6m      | real@6m         | full        | 200  | 14899      | 14848  | 100%  | 0       | 1856    | $0.0039  |                                                                   |
| 504.1  | M2-A-real21    | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2222    | ~$0.0039 | aborted; usage not reported                                       |
| 505.1  | M2-A-real11    | ping@8m         | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1215    | ~$0.0039 | aborted; usage not reported                                       |
| 506.6  | M2-B-real21    | ping@8m         | full        | 200  | 14929      | 14912  | 100%  | 0       | 997     | $0.0039  |                                                                   |
| 676.9  | M1-idle11m     | real@11m        | full        | 200  | 14877      | 0      | 0%    | 0       | 1648    | $0.0208  |                                                                   |
| 685.1  | M2-A-real11    | real@11m        | full        | 200  | 14891      | 14848  | 100%  | 0       | 2690    | $0.0039  |                                                                   |
| 744.1  | M2-A-real21    | ping@12m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1160    | ~$0.0039 | aborted; usage not reported                                       |
| 746.6  | M2-B-real21    | ping@12m        | full        | 200  | 14929      | 14912  | 100%  | 0       | 981     | $0.0039  |                                                                   |
| 984.1  | M2-A-real21    | ping@16m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 1670    | ~$0.0039 | aborted; usage not reported                                       |
| 986.6  | M2-B-real21    | ping@16m        | full        | 200  | 14929      | 14912  | 100%  | 0       | 1283    | $0.0039  |                                                                   |
| 1224.1 | M2-A-real21    | ping@20m        | first-event | 200  | n/a        | n/a    | n/a   | n/a     | 2154    | ~$0.0039 | aborted; usage not reported                                       |
| 1226.6 | M2-B-real21    | ping@20m        | full        | 200  | 14929      | 14912  | 100%  | 0       | 940     | $0.0039  |                                                                   |
| 1279.1 | M1-idle21m     | real@21m        | full        | 200  | 14913      | 0      | 0%    | 0       | 1792    | $0.0209  |                                                                   |
| 1285.0 | M1-idle21m     | replay@21m      | full        | 200  | 14893      | 14848  | 100%  | 0       | 1570    | $0.0039  | exact replay after a miss: expired vs prefix-extension-never-hits |
| 1284.1 | M2-A-real21    | real@21m        | full        | 200  | 14901      | 14848  | 100%  | 0       | 3206    | $0.0039  |                                                                   |
| 1286.6 | M2-B-real21    | real@21m        | full        | 200  | 14949      | 14912  | 100%  | 0       | 2155    | $0.0039  |                                                                   |

Route spend: known $0.2384, est. aborted $0.0309.

### copilot-completion/kimi-k3 (openai-completions, <ip>:8022)

Prices $/M: input 3, cacheRead 0.3, cacheWrite 0, output 15. Usage key paths seen: none.

| t(s) | arm | req   | mode | HTTP | prompt tok | cached | share | out tok | TTFE ms | cost | note                                                                                       |
| ---- | --- | ----- | ---- | ---- | ---------- | ------ | ----- | ------- | ------- | ---- | ------------------------------------------------------------------------------------------ |
| 90.0 | M0  | write | full | 429  | n/a        | n/a    | n/a   | n/a     | -       | n/a  | HTTP 429: {"error":{"message":"Rate limited. Please retry later.","type":"rate_limit_error |

Route spend: known $0.0000, est. aborted $0.0000.
