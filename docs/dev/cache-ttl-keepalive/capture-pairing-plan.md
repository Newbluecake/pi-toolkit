# Keepalive capture: payload-only capture + replay through pi's own provider pipeline (Part A, `fix`)

Status: plan **r7**, 2026-10-18.

- History: r1 (ALS token) rejected by `r_5NXJ9E7M`; r4's direction 5c confirmed by `r_7WYKX3GG`; r5/r6 header guards
  rejected or descoped (`r_T75BBXN8`); user ruling 6 removes extension-header detection from v1.
- Lane **L2**. Ships as one `fix(cache-ttl)` commit after the WP0a gate. User rulings are at the end, verbatim.

## 1. The bug

pi 1.2 fires `before_provider_headers` (**H**, inside `ModelRuntime.prepareRequest`, `model-runtime.js:452-481`)
**before** `before_provider_request` (**P**, the provider's `onPayload`, `anthropic-messages.js:437-441`).
`createRequestCapture` (`src/cache-ttl/cache-ttl.ts`) and `src/cache-ttl/child.ts` assume P → H. On real traces today's matcher yields one capture `(P1,H2)` for two prompts, never captures the first request, captures nothing for `H,P,P′`, and every ping replays the previous request.

Separately, `runPing` locks `lockedAuthHeaderKeys` on the first non-empty auth, while captures always carry
`authHeaderKeys: ""` (`cache-ttl.ts:390`, `cache-keepalive.ts:602,963`). This is immediate `fingerprint-drift`: today
**no ping is ever sent** for header-owned auth or `models.json` provider/model headers (§3.4).

## 2. Evidence (throwaway spikes, real pi 1.2.0 / Node 22.22.1, local stub; since deleted)

Spikes used a real `createAgentSession` + `ModelRuntime.create`.

- **Rejected approaches:**
  - ALS (`enterWith` in H or `context`): never pairs, or goes stale.
  - Call wrapping, per-call closures, recomputed headers: no public seam to hook.
  - Ordered H matcher: needs compaction resets.
  - `CacheWarmer`-style rebuild: blind to `context` transforms.
- **Chosen (5c):** capture the last P and replay it via `ctx.modelRegistry.streamSimple` with an `onPayload`
  replacement.
  - The wire is identical to the real request (only `x-stainless-timeout` differs), and 0 hooks fire.
  - Verified on anthropic-messages (api-key, OAuth, thinking/`betas`→`anthropic-beta`, strict P′, forced prompt +
    `context` extension), openai-responses and openai-completions.
- **SDK timer:** the SDK's fetch timer is not unref'd (`client.mjs:666-675`). A never-settling fetch kept the process
  alive for `timeoutMs` (default 600 s).
- **pi's SSE parser:** no idle timer and no byte cap (a newline-less flood read 6.5 MB).
- **Long tool calls:** `executeToolCalls` is awaited before `turn_end` (`agent-loop.js:165,180`), so pings must work
  mid-turn.

## 3. Design

### 3.1 Capture: P only

- The main and child `before_provider_request` handlers keep today's shape check, TTL rewrite and clone. They call
  `port.noteRequest(captureRequest(...))` **immediately**; a strict-fallback P′ replaces P.
- Delete `stage` / `clear` / `consumeHeaders`, the `before_provider_headers` handlers in both wirings, and
  `CapturedRequest.headers`.
- `lastSent` is unchanged.

### 3.2 Replay options (`src/cache-ttl/pipeline-ping.ts`, new)

`ctx.modelRegistry.streamSimple(model, stubContext, options)`:

- `model` = current `ctx.model`, whose provider, api, id and baseUrl the fingerprint already proved.
- `stubContext` = `{ messages: [{ role: "user", content: "keepalive", timestamp }] }`. For non-Copilot providers,
  context only shapes params, and those are replaced.

| Field                                                                                                            | Treatment                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxRetries: 0`                                                                                                  | **Passed.** `retryProviderRequest` would re-POST without re-calling `onPayload`.                                                                                                                                                                                             |
| `sessionId`                                                                                                      | **Passed:** `capture.sessionId`, the agent's id. It drives `cacheSessionId` → session-affinity headers and OpenAI `prompt_cache_key`.                                                                                                                                        |
| `signal`                                                                                                         | **Passed:** an internal controller, linked to the service's abort.                                                                                                                                                                                                           |
| `timeoutMs`                                                                                                      | **Passed:** `D − now`, so the SDK timer is ≤ the deadline. Shows up in `x-stainless-timeout`, informational.                                                                                                                                                                 |
| `fetch`, `onPayload`, `onProviderStreamEvent`, `transformHeaders`                                                | **Passed:** local callbacks (§3.3). `transformHeaders` only re-runs `guard()` (epoch/dispose/deadline) and returns the headers unchanged; it inspects no header content.                                                                                                     |
| `apiKey`, `headers`, `env`, `cacheRetention`                                                                     | **Reproduced by omission.** The agent loop sets none (`agent.js:303-330`; no `getApiKey` in `sdk.js`). Auth, headers and env come from the same `prepareRequest` resolution. `PI_CACHE_RETENTION` is read identically. The pre-send `guard()` runs on that same path (§3.3). |
| `reasoning`, `thinkingBudgets`, `maxTokens`, `temperature`, `samplingParams`, `toolChoice`, `metadata`, `effort` | **Omitted:** they only shape params. The `betas` they derive already sit in the captured body; the SDK turns them into `anthropic-beta`. Thinking: `preparePingPayload` keeps the real `max_tokens` (budget < max), and pi never touches it after `onPayload`.               |
| `onResponse`, `telemetryContext`, `maxRetryDelayMs`, `transport`, `websocketConnectTimeoutMs`                    | **Omitted.** No wire effect on Anthropic: no consumer, or not read by `anthropic-messages.js`.                                                                                                                                                                               |
| `deferred`, the virtual-model path                                                                               | **Unsupported**, never set. `isVirtualModel` ⇒ skip `provider-unsupported`.                                                                                                                                                                                                  |

### 3.3 Bounded transport contract (restores `postAndScanUsage`'s guarantees)

**Deadline.** One unref'd hard deadline `D = min(now + 20 s, aliveUntil − TTL_SAFETY_MARGIN_MS)` covers auth (inside
`prepareRequest`), fetch and stream read. When it fires, the transport aborts and settles logically. pi's result is
raced against `D`, never awaited unboundedly.

**Guard.** `guard()` = same epoch ∧ not disposed ∧ `now < D`. It runs in `transformHeaders` (after pipeline auth), in
`onPayload`, and right before the base fetch, so a slow auth never sends a stale ping.

That is all `transformHeaders` checks; with the header guard removed it inspects no header content. Normal credential
refresh is pi's job. The epoch does **not** cover an identity switch or a dynamic-auth routing change (§4 R3).

**`onPayload`.** The first call returns the ping body (`preparePingPayload` + O2 strip). Any later call throws, which
blocks the second HTTP request of a strict fallback.

**Fetch wrapper.** It applies its own once-guard and `guard()`, asserts `POST`, `/v1/messages` and `body.model`, then
sets `sent`. It races the base fetch against abort/`D`, so it settles ≤ D and clears the SDK timer
(`timeoutMs = D − now`), and it removes its listeners in `finally`.

**Bounded body.** More than 64 KiB before `message_start` ⇒ `malformed`. Non-2xx bodies are capped at 2 KiB. Every
`read()` races abort/`D`, and `cancel()` is fired but never awaited.

**Usage.** `onProviderStreamEvent` records the raw Anthropic `message_start` usage (incl. the 1h split), then settles
and aborts. Anthropic only; OpenAI is Part B.

**Outcome.** Before `sent`, any failure ⇒ `not-sent{reason}` ⇒ refund. After `sent`:

- a reject, or `D` before headers ⇒ `network`;
- non-2xx ⇒ `http`;
- `message_start` ⇒ `usage`;
- 2xx without `message_start` ⇒ `accepted-then-lost`;
- the byte cap ⇒ `malformed`.

`classifyUsage` is unchanged.

**Physical IO.** `busy` until the base fetch, upstream cancel/close and pi's result have all settled. `evaluateTick`
adds `io-busy` (non-terminal) before `ping-in-flight`, and retries require `!busy`. If they never settle, the
transport stays `io-busy` (fail closed).

### 3.4 Service integration (`src/service/cache-keepalive.ts`)

**Capability.** `probeKeepaliveTransport` (`src/adapters/pi-compat.ts`) requires
`typeof ctx.modelRegistry?.streamSimple === "function"`; otherwise activation-disable `transport-unsupported`.

At runtime, diagnose only on an **explicit success**:

- `stopReason` ∈ {`stop`, `length`, `toolUse`};
- not aborted by us;
- no `not-sent`;
- and either no base-fetch call or no raw `message_start`.

Usage presence is never evidence. Auth failures, epoch cancels, `accepted-then-lost`, `malformed` and `http` never
latch.

**Copilot.** `github-copilot` and virtual models ⇒ terminal `provider-unsupported` (X-Initiator and vision headers
come from the transformed context). The user's `copilot-*` ids are custom: pi branches only on
`model.provider === "github-copilot"` (`anthropic-messages.js:415,785`, `openai-responses.js:193`,
`openai-completions.js:534`), so they are unaffected.

**Auth baseline.** Delete `lockedAuthHeaderKeys` and the `getApiKeyAndHeaders` preflight. Auth resolves once inside
`prepareRequest`; a failure ⇒ `not-sent`. `authHeaderKeys` becomes inert (`""` on both sides), which ends the §1
drift.

**Activation-only disable** (`transport-unsupported`). The service field `activationDisabled` sits outside
`SessionTotals`, so `audit()` and `readBackKeepaliveSessionState` (`keepalive-state.ts:457`) never see it.
`evaluateTick` treats it as terminal `activation-disabled`, and `/reload` forgets it.

**Retries.** Each retry is one new transport.

**Status note (ruling 6).** Whenever keepalive is enabled, `renderKeepaliveReportLines` adds: `note: headers added by
other extensions are not replayed — if they steer routing/cache, pings may write to another backend; keepalive stops
for this session once a current-epoch proven-write is observed`.

The note makes no claim that the unknown cost is bounded to one ping.

**Intentional wire changes (ruling 1).** Added: `anthropic-version`, `content-type: application/json`, pi
UA/`accept`/stainless, OAuth identity, `anthropic-beta` from `betas`, `?beta=true`. `betas` leaves the body.
`/cache-ttl probe` is untouched.

## 4. Residual risks

1. **Extension-added headers (ruling 6).**
   - v1 does not detect headers that other extensions add or delete in `before_provider_headers`, and pi attribution
     headers are not replayed.
   - If such a header affects routing or caching, a ping may land on another backend and cause a paid rewrite. The
     existing proven-write breaker stops keepalive for the session (permanently) once a current-epoch `proven-write`
     is observed.
   - Disclosed here and in `/cache-ttl status`.
2. **A later payload rewriter** (e.g. pi-traffic-record rules) makes the capture P_k ≠ the wire Q, so a ping may be
   a paid write.
   - For both 1 and 2: the breaker trips **only if** a current-epoch `proven-write` is observed. Lost usage, epoch
     preemption and possibly-billed transients can each cost a write without tripping it.
   - No hard per-session bound.
3. **Identity / dynamic-auth changes.**
   - Auth resolves inside pi's pipeline at ping time; normal credential refresh is pi's job.
   - If the credential identity switches, or a dynamic-auth provider routes differently between the real request and
     the ping, the ping may miss the cache and write. Neither the epoch nor `guard()` detects this.
   - The `proven-write` caveat from R2 applies.
4. pi's warmer (default `streaming`, built-in Anthropic only) emits real P, which becomes the capture. Pre-existing.
5. A stuck socket ⇒ `io-busy` until dispose.
6. `avoidedMissTokens` stays an estimate.
7. Public contracts used: `onPayload` replacement, `fetch`, `onProviderStreamEvent`, `transformHeaders`,
   `ModelRegistry.streamSimple`. They are pinned by WP0a; re-run it before any pi bump.

## 5. Tests

**WP0a gate.** `tests/conformance/keepalive-pipeline-facts.test.ts` uses a real `createAgentSession` +
`ModelRuntime.create` and a stub that logs every POST:

- **F1:** H fires before P; compaction issues H-only calls.
- **F2:** strict fallback is `H,P,P′`, with exactly 2 server POSTs.
- **F3:** `ModelRegistry.streamSimple` with a test-local `onPayload` replacement, `fetch`, `onProviderStreamEvent` and
  `transformHeaders` yields the real wire after the SDK (§2 exclusions), with 0 hooks fired. Covers api-key, OAuth
  and thinking (`anthropic-beta`, no `betas` in body).
- **F4:** a never-settling fetch keeps the process alive for `timeoutMs`.

The current code's `(P1,H2)` result is report-only evidence.

**Fix gates.** `tests/conformance/keepalive-pipeline.test.ts`:

- **G2:** capture == the actual P, for the first request and for P′ after a strict 400.
- **G3:** ping wire == real wire for api-key, OAuth, thinking (`max_tokens` kept) and strict.
- **G4:** exactly 1 base-fetch call per attempt; server POSTs are exactly 1 for strict-400 and for 503, and ≤1 for a
  fetch reject.
- **G7:** a later payload rewriter ⇒ capture ≠ wire.
- **G8:** child via `PiSessionDriver` with a settings-listed package: `childActivationAdvanced`, a captured first
  request, and abort/dispose ⇒ ping aborted and the ledger lease settled once.

**Integration.** `tests/integration/keepalive-pipeline-service.test.ts` runs a real `CacheKeepaliveService` on a fake
clock, over `new ModelRegistry(await ModelRuntime.create(...))`, wired via `wireCacheTtl`:

- an eligible window with `models.json` provider/model headers **sends a ping** carrying them (today: drift);
- **long tool call (required):** the tool promise stays unresolved; after 240 s a ping POST arrives **before**
  `turn_end`;
- `/reload` forgets `activationDisabled` but reads back a `proven-write` breaker;
- auth failure, epoch cancel and 200-then-drop never latch `transport-unsupported`;
- stalls (after a 200, newline-less flood, never-settling fetch or cancel) settle ≤ D, stay `io-busy` until physical
  settle, and make 1 call;
- a subprocess (main wiring, then child wiring) exits naturally ≤ D + 1 s after dispose.

**Unit.**

- New `pipeline-ping.test.ts`.
- Rewrite `cache-ttl.test.ts:75-121`, `keepalive-child.test.ts` and the ping/retry/breaker/lifecycle suites onto a
  fake `modelRegistry.streamSimple`.
- A status-note test.

**Gates:** `format:check`, `typecheck`, `test`, `build`, `test:conformance` (Node 22).

## 6. Packages (owned files)

**Frozen interface: `src/cache-ttl/pipeline-ping-types.ts`** (types only; owned by the main session; frozen). It
defines:

- `SendPipelinePing`, a function from `PipelinePingInput` to `Promise<PipelinePingResult>`. The promise never rejects
  and resolves by `D`.
- `PipelinePingResult = { outcome: PipelineOutcome; settled: Promise<void> }`. `settled` never rejects, and resolves
  only after the fetch, the body cancel and pi's result have all finished.
- `PipelineOutcome`: a `not-sent{reason}` variant, plus variants mirroring `UsageScanOutcome`. Every variant carries a
  typed `diag: PipelineDiag` (`baseFetchCalls`, `onPayloadCalls`, `sawMessageStart`, `explicitSuccess`,
  `piStopReason`, `httpStatus`, `bodyBytes`, `wireHeaderNames`, `deadlineHit`, `durationMs`).
- The clock basis: the service's injected `Clock`. `deadlineAt` uses that clock; the timer comes from
  `clock.setTimer`, never `Date.now`.
- `PipelineHeaderSource = "pipeline"`, kept out of `ping-client.ts`'s `PingHeaderSource`. A2 widens
  `KeepalivePingDiagnostics.headerSource` to `PingHeaderSource | PipelineHeaderSource`.

A1 implements `pipeline-ping.ts` against this file (`export const sendPipelinePing: SendPipelinePing`). A2 imports only
these types. Neither package edits it.

| WP  | Owned files                                                                                                                                                                                                                                                           | Depends                                                                                                                                                                                                                                                                              | Parallel               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| T   | `src/cache-ttl/pipeline-ping-types.ts` (done; main session, frozen)                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                    | precondition for A1/A2 |
| 0a  | `tests/conformance/keepalive-pipeline-facts.test.ts`, `tests/conformance/fixtures/anthropic-stub.ts` (400 script, stalls, POST log)                                                                                                                                   | —                                                                                                                                                                                                                                                                                    | ∥ A1, A2               |
| A1  | `src/cache-ttl/pipeline-ping.ts` (implements `pipeline-ping-types.ts`), `src/cache-ttl/ping-client.ts` (exports only; `PingHeaderSource` untouched), `tests/cache-ttl/pipeline-ping.test.ts`                                                                          | frozen types                                                                                                                                                                                                                                                                         | ∥ 0a, A2               |
| A2  | `src/cache-ttl/cache-ttl.ts` + `src/cache-ttl/child.ts` (P-only capture, drop H handlers/`createRequestCapture`), `keepalive-state.ts` (drop `CapturedRequest.headers`; skips `io-busy`/`provider-unsupported`/`activation-disabled`; `headerSource: PingHeaderSource | PipelineHeaderSource`; status note), `src/service/cache-keepalive.ts` (`runPing`→`sendPipelinePing`, lock + preflight removed, `activationDisabled`, `busy`), `src/adapters/pi-compat.ts` (`probeKeepaliveTransport`), rewritten unit suites (imports only `pipeline-ping-types.ts`) | frozen types (fake A1) | ∥ 0a, A1 |
| A3  | `tests/conformance/keepalive-pipeline.test.ts`, `tests/integration/keepalive-pipeline-service.test.ts`                                                                                                                                                                | A1 + A2 (+0a stub)                                                                                                                                                                                                                                                                   | after A1, A2           |

Order:

1. WP0a commits first, after its own verification: `test(cache-ttl): pin pi provider-hook facts for keepalive
replay`.
2. A1–A3 land together as **one** commit: `fix(cache-ttl): capture keepalive payload per request and replay via pi's
provider pipeline`.
3. Verifier ≠ dev model.
4. Push and release only after user confirmation.

`src/stack.ts` and `src/index.ts` do not change: services already hold `deps.ctx`. Checked with `git diff --stat`.

## §R 评审修订 r6→r7

Per user ruling 6:

- **Deleted:** the header-extras guard (ring, B/E baselines, canonical form, sticky flag, `headers-unsettled`,
  eviction) and its gates/tests (G5–G6c).
- **Kept:** `activationDisabled`, for `transport-unsupported` only.
- **Changed:**
  - §4 R1 now follows ruling 6, and a status note is added. Final check `r_0C0X5JNB` added §4 R3 (identity / dynamic auth), the `pipeline auth` wording, the observed-only status note, and the frozen `pipeline-ping-types.ts`.
  - Rulings 2, 4 and 5 are marked superseded.
  - §5 is folded into the §6 package table.
- **Unchanged:** earlier findings (r4→r5 #1–9; r5→r6 #3, #5–#7) stay addressed in §3.2–§3.4 and §5.

## 用户裁定（2026-10-18，回答 r4 决策项）

1. 接受改走 pi 自己的发送通道带来的头部变化（ping 带上 anthropic-version、JSON content-type、anthropic-beta 及 pi 标准客户端头，`betas` 不再留在请求体）。
2. 其它扩展添加了自定义请求头时：该会话关闭保活（`header-extras`），不做顺序配对重放。 **[superseded by ruling 6]**
3. Part B（other-protocols-plan.md）在 Part A 落地后改用同一发送通道，删去自建 OpenAI ping 与 r1 per-call token 依赖；何时重启 B 仍由用户决定。
4. （r5 Q1）空闲时无后续生命周期事件、无法证明已定型的请求头：保活暂停（`headers-unsettled`）直到下一轮。 **[superseded by ruling 6]**
5. （r6 Q1）接受收窄后的第 4 条读法：仅在 P 时刻的请求头比对尚未出结果时暂停（`headers-unsettled`），未经检查即被挤出环的一律不 ping；压缩 / 分支摘要 / `/bug` 这类只发请求头的空闲调用不再暂停保活。 **[superseded by ruling 6]**
6. （r6 评审后，2026-10-18）v1 **不做「其它扩展添加请求头」检测**：删除 header-extras 守卫（环、基线比较、sticky 标记、`headers-unsettled` 相关逻辑全部不做）。只交付配对 bug 修复 + 改走 pi 发送通道 + 有界读流 / 截止 / 物理 IO / 能力探测 / auth-key 指纹修复等已通过评审的部分。残余风险写入文档与 `/cache-ttl status` 说明：若装了会改请求头且该头影响路由/缓存的扩展，ping 可能落到别的后端导致一次付费重写，由现有 proven-write 熔断兜底（该会话永久停保活）。第 2、4、5 条裁定随之失效。
