# F2 report — Feishu HTTP / token / API layer

Package **F2** of `plan.md` (§2.1 bootstrap, §2.2 destination allowlist, §3 HTTP/token/API, §4.4 credentials usage, §14 F2 row).
Pi-free, `node:*`-free, no module-scope mutable state, no env reads, every timer through an injected (unref'd by default) clock.
Nothing is wired into the hub (FA's job); `feishuBot.enabled` default off ⇒ hub byte-identical.

## Files

| File                                                |                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/web-hub/hub/feishu/http.ts`                    | NEW — bounded fetch client, failure model, redaction                                                 |
| `src/web-hub/hub/feishu/token.ts`                   | NEW — tenant_access_token manager                                                                    |
| `src/web-hub/hub/feishu/api.ts`                     | NEW — typed thin wrappers (bootstrap, send, reply, patchCard, reactions, uploads, download, botInfo) |
| `tests/fixtures/feishu/fake-http.ts`                | NEW — fake fetch seam (`createFakeFeishu`), `createFakeClock`, `settle`                              |
| `tests/web-hub/hub/feishu/{http,token,api}.test.ts` | NEW — 79 + 26 + 84 tests                                                                             |

Frozen constants come from `protocol/feishu.ts` (`FEISHU_HTTP/BOOTSTRAP/FILE_LIMITS/REPLY_LIMITS`, `isAllowedApiBase`, `isAllowedWsUrl`,
`classifyBootstrapCode`, `isAuthFailedCode`, `FEISHU_TOKEN_INVALID_CODES`, `FEISHU_SEND_UNCERTAIN_CODES`, `FEISHU_CAPABILITY_DENIED_CODES`,
`clampClientConfig`, `FEISHU_OPEN_ID_RE`); a test greps the three sources for literal copies of any frozen code/origin/path and fails on one.

## API surface

```ts
const http  = createFeishuHttp({ apiBase, fetch?, clock?, secrets?: () => string[], onEvent? });
const token = createTokenManager({ http, credentials: () => ({appId, appSecret, gen}) | undefined, clock?, marginMs?, authFailedCooldownMs? });
const api   = createFeishuApi({ http, token });
```

Every call returns `{ok:true,data} | FeishuFailure` and **never throws**. `apiBase` must be one of the two frozen origins (`FEISHU_API_BASES[brand]`)
— anything else yields a `destination` failure on every call without a fetch.

| `api.*`                                                                           | Endpoint                                                                     | Result                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap({appId,appSecret,signal?})`                                            | `POST /callback/ws/endpoint`, `locale: zh`, ≤64 KiB, 8 s, no bearer          | `{url, serviceId, deviceId, config}` (config clamped by `clampClientConfig`) or `BootstrapFailure{class: retry\|auth_failed\|conn_limit\|refused\|aborted, reason, code?, msg?}` |
| `send({receiveIdType, receiveId, msgType, content, uuid})`                        | `POST /im/v1/messages?receive_id_type=`                                      | `{messageId, chatId?, threadId?, rootId?, parentId?}`                                                                                                                            |
| `reply({messageId, msgType, content, uuid, replyInThread?})`                      | `POST /im/v1/messages/:id/reply`                                             | same (`threadId` returned on `reply_in_thread:true`, V8)                                                                                                                         |
| `patchCard({messageId, card})`                                                    | `PATCH /im/v1/messages/:id` `{content}`                                      | `void`                                                                                                                                                                           |
| `addReaction({messageId, emojiType})` / `deleteReaction({messageId, reactionId})` | `POST …/reactions` `{reaction_type:{emoji_type}}` / `DELETE …/reactions/:id` | `{reactionId}` / `void`                                                                                                                                                          |
| `uploadImage({bytes: Uint8Array\|Blob, fileName?})`                               | `POST /im/v1/images` multipart `image_type=message`                          | `{imageKey}`                                                                                                                                                                     |
| `uploadFile({bytes, fileName, fileType?="stream"})`                               | `POST /im/v1/files` multipart                                                | `{fileKey}`                                                                                                                                                                      |
| `downloadResource({messageId, fileKey, type, maxBytes, sink})`                    | `GET /im/v1/messages/:id/resources/:key?type=` streamed                      | `{bytes, contentType?}`                                                                                                                                                          |
| `botInfo()`                                                                       | `GET /bot/v3/info` (top-level `bot.open_id`)                                 | `{openId, appName?}`                                                                                                                                                             |

`content` is the already-serialized JSON string (F7 owns rendering). `uuid` is REQUIRED (`^[A-Za-z0-9_-]{1,50}$`) — one logical send ⇒ one uuid.
Local limits (effect none, no network): `interactive` content / `patchCard` card ≤ `FEISHU_REPLY_LIMITS.maxCardBytes` (UTF-8 bytes); image ≤ 10 MiB
(`outboundAutoImageMaxBytes`), file ≤ 30 MiB (`outboundUploadMaxBytes`), empty uploads refused; ids are validated (no `/ \ ? # % ` whitespace/controls, ≤256) _and_ encoded.
Deadlines: 8 s default (`FEISHU_HTTP.defaultTimeoutMs`); uploads and downloads 30 s (`FEISHU_UPLOAD_TIMEOUT_MS` = `FEISHU_FILE_LIMITS.inboundTimeoutMs`, F2 decision); per-call `timeoutMs`/`signal` override.
Token-invalid (`99991663/99991664`): that exact token is invalidated and the call repeated **once**; capability-denied codes set `capabilityDenied:true`.

`token.get()` → `{ok, data:{token, gen, usableUntil}} | FeishuFailure{kind:"auth", auth: unconfigured|refused|auth_failed|transient|stale|aborted}`.
Cache until `expire−300 s` (lifetime ≤ margin ⇒ half-life; missing `expire` ⇒ served once, not cached); single-flight; `invalidate(token)` only drops that exact token;
`peek()` (for redaction sets only); `dispose()`. **Generation:** cache, auth-failure cooldown and in-flight refresh are keyed by `credentials().gen`; a refresh finishing after the gen moved on is discarded
(waiters get `auth:"stale"`, retryable) and never cached; `undefined` credentials ⇒ `unconfigured` + cache cleared. `auth_failed` is negative-cached 30 s (`authFailedCooldownMs`) so a burst can't spam the platform with a wrong secret; a gen change clears it.

## Error map

`FeishuFailure { kind, reason, retryable, effect, status?, code?, msg?, scopes?, auth?, capabilityDenied? }` — `reason` is locally generated only.

| Situation                            | kind / reason                          | effect                                                                            | retryable                                               |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| base/path/URL outside allowlist      | `destination` / `destination:*`        | none                                                                              | no                                                      |
| local validation                     | `bad-request` / `bad-request:<field>`  | none                                                                              | no                                                      |
| token stage failed                   | `auth` / (cause reason) + `auth`       | none                                                                              | transient/stale only                                    |
| fetch error, redirect, DNS/reset     | `unreachable`                          | unknown                                                                           | yes                                                     |
| deadline                             | `timeout`                              | unknown                                                                           | yes                                                     |
| caller signal / sink threw           | `aborted` / `aborted` \| `sink-failed` | unknown                                                                           | no                                                      |
| non-zero `code` (any HTTP status)    | `api` / `api-code-N`                   | none; **unknown if status ≥500 or code ∈ `FEISHU_SEND_UNCERTAIN_CODES` (230020)** | busy codes (`1`, `1000040343`), 230020, 408/425/429/5xx |
| code-less non-2xx                    | `http` / `http-N`                      | none (5xx unknown)                                                                | 408/425/429/5xx                                         |
| 2xx, bad/non-JSON/no code/missing id | `protocol` / `protocol:*`              | **unknown**                                                                       | no                                                      |
| body over cap                        | `too-large`                            | unknown                                                                           | no                                                      |

Bootstrap classes (`classifyBootstrapCode`): `1`/`1000040343` → retry; `1000040350` → conn_limit; `514/403/10003/10014/1000040345`/any other non-zero → auth_failed (msg surfaced);
transport/timeout/5xx/**code-less HTTP 4xx (incl. 401/403)** → retry (never falsely reports bad credentials); returned WS URL failing `isAllowedWsUrl` → `refused`/`ws-url-not-allowed`;
missing/invalid `service_id`/`device_id` → retry (`protocol:endpoint-missing-ids`).

**Send rule for F7:** `effect:"unknown"` ⇒ retry only with the SAME `uuid` (fake models platform dedup: same uuid ⇒ same message id); `effect:"none"` ⇒ provably not delivered.

## Redaction proof

- Messages never leave `http.ts` unsanitized: control/format chars stripped _before_ redaction (a secret split by a control char cannot survive), input capped at 4 KiB, literal secrets (app secret, live token via `deps.secrets()`/`req.token`/`req.secrets`), `Bearer …`, Feishu token shapes (`t-/u-/a-/c-…`), credential `key:value` pairs, and **every URL** (WS URL/ticket) are replaced; output ≤200 chars.
- URLs, request/response bodies and headers are never put into a failure or `onEvent`; `onEvent` carries only `{op, ok, outcome, status?, code?, ms}` with a static id-free `op`.
- Tests: `redactSecrets`/`sanitizeApiMessage` table; per-surface hostile server message (secret + Bearer + token + WS ticket + ids + URL) across **all ten** calls, serialized with the event log and asserted free of secret/token/ticket/ids/`https://`/`wss://`. Mutation check: disabling `redactSecrets` in `sanitizeApiMessage` fails 6 tests; dropping `redirect:"error"` fails the redirect test.

## Decisions / deviations (F2's calls)

- **No reuse of `src/web-search/resilience.ts`** (plan §3 mentioned it): `tests/web-hub/boundary.test.ts` forbids hub importing outside `{protocol,hub}`. Redaction/retry classification are re-implemented in `http.ts`; retry _policy_ (backoff, attempts) is left to F3/F7.
- Failure kinds follow the probe's `FailureKind` strings (`unreachable|timeout|http-N|api-code-N`) rather than the plan's `network`.
- `botInfo` was **not exercised by the probe** (no live fact); the response shape (top-level `bot`, `data.bot` tolerated) follows Feishu's documented API — verify at FB1 real-tenant acceptance.
- Download JSON-typed 2xx body ≤8 KiB shaped `{code≠0, msg:string, ≤4 keys}` is treated as Feishu's error envelope (a user's file of exactly that shape would be refused — accepted).
- A streamed download that overflows with unknown length has already sunk bytes (documented; the caller's staging file must be discarded on any failure).
- Per the DAG note the fixture covers only the F2 surface; F4's registration endpoints plug in via `fake.on()/script()` (no registration handlers are baked in).

## Hand-offs

- **F3 (connector):** `api.bootstrap()` per dial → switch on `class`; `ok.data.url` is single-use + secret — never log; `config` already clamped. `auth_failed`→10 min retry, `conn_limit`→5 min, `retry`→§2.4 backoff (`reconnectBackoffCeilingMs`), `refused`→`degraded(ws-unavailable)`-class refusal. Use `fake.on("POST","/callback/ws/endpoint",…)` for scripted bootstraps.
- **F4 (credentials/registration):** build `http` per brand (`FEISHU_API_BASES[brand]`) and `token` with `credentials: () => installation && {appId, appSecret, gen}` — bump `gen` on setup/replace/reset; `token.dispose()` on stack stop. `api.botInfo()` yields `botOpenId`. Registration (`accounts.*`) is NOT in F2 (`isAllowedRegistrationBase` is the guard there).
- **F7 (outbox):** pass `uuid = sendId`; retry on `effect:"unknown"` with the same uuid, max `FEISHU_REPLY_LIMITS.maxRetries`; treat `capabilityDenied` as the §4 `capability-denied:<x>` signal; use `failure.auth` to distinguish `auth_failed` (stop sending, status `auth_failed`) from `transient`. `patchCard` refuses >20 000 B cards.
- **F8 (files/dialogs):** `downloadResource` sink → staging file (discard on any failure); cap = `min(files.maxInboundMiB, UPLOAD_FILE_MAX_BYTES)`; uploads accept `Blob` (e.g. `fs.openAsBlob`) so large files need not be buffered.
- **FA:** the secret provider for `createFeishuHttp` should be `() => [credentials.appSecret, token.peek()]` (the `token` handle can be created after `http`; read lazily). Hub log lines: use `onEvent` only.

## Self-verification

- `npx prettier --check` on all F2 files — clean.
- `timeout 300 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts` — 6 files, 445 tests green (F2: 189; the rest are F1's frame/chunks suites + boundary).
- `timeout 280 npm run typecheck` — **fails only in another agent's in-flight file** `src/web-hub/agent/feishu-admin.ts` (F9: missing `FSB_HUB_CAP` export from `protocol/feishu.js`, `FsbResData` casts, lines 27/412/413). `tsc` output filtered of that file is empty — no diagnostics in any F2 file.
- Side effect to disclose: I ran `prettier --write src/web-hub/hub/feishu/*.ts` once, which also reformatted F1's `frame.ts`/`chunks.ts` in place (formatting only; F1's suites pass).
