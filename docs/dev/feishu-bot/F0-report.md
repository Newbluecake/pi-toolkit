# F0 report — Feishu bot protocol / settings frozen surface

Package **F0** of `plan.md` v2 (+ §R2, probe results V1–V6, V8–V11; V7/V12 unknown). Declarations + pure helpers only:
no hub/agent wiring, no cap advertisement (FA owns that). `feishuBot.enabled` defaults to false ⇒ hub and agent are
byte-identical (full suite: 1070 files / 19 414 tests green).

## Files

| File                                          | Change                                                                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/protocol/feishu.ts`              | NEW — all frozen constants, helpers, `fsb_*` schemas/types, `HubConfig.feishuBot` type + normalizer                                           |
| `src/web-hub/protocol/messages.ts`            | APPEND-ONLY — import of the two schemas, `FsbReqFrame` in `AgentFrame`, `FsbResFrame` in `HubFrame`, two table entries (`fsb_req`, `fsb_res`) |
| `src/web-hub/protocol/version.ts`             | APPEND-ONLY — `FSB_HUB_CAP = "fsb.v1"` (inert; no PROTO bump — new frames only ever sent under the cap)                                       |
| `src/config/settings.ts`                      | `FeishuBotSettings`, `DEFAULT_FEISHU_BOT_SETTINGS`, `AgentSettings.feishuBot`, `parseFeishuBotBlock`, `loadFeishuBotWarnings`                 |
| `tests/web-hub/protocol/feishu.test.ts`       | NEW (53 tests) — pins every constant, allowlists, code maps, V10, header, normalizer, settings⇄protocol parity                                |
| `tests/web-hub/protocol/messages-fsb.test.ts` | NEW (45 tests) — `fsb_req`/`fsb_res` accept/reject matrices, direction                                                                        |
| `tests/config/feishu-bot-settings.test.ts`    | NEW (15 tests) — defaults, tolerance, clamps, warnings, file loading, no time-unit migration                                                  |

`protocol/feishu.ts` imports only `@sinclair/typebox` (no `node:*`, no pi). `settings.ts` cannot value-import it
(`tests/web-hub/boundary.test.ts` freezes its closure — unchanged), so the defaults/ranges are literal mirrors pinned equal
by the parity tests, exactly like `webHub.proxy`.

## Frozen constants (all in `protocol/feishu.ts`; each pinned by a test)

| Area                     | Values                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frames / cap             | `fsb_req` (agent→hub), `fsb_res` (hub→agent), cap `fsb.v1`                                                                                                                                                                                                                                                 |
| Ops (8)                  | `info`, `setup_begin{replace?,confirm?}`, `setup_status`, `setup_cancel`, `allow{openId}`, `deny{openId}`, `repair{confirm:true}`, `reset{confirm:true}`                                                                                                                                                   |
| Error codes              | `E_FSB_UNCONFIGURED/SETUP_ACTIVE/CONFIRM_REQUIRED/CAP/BAD_REQUEST/STATE`; wire accepts any `^E_FSB_[A-Z0-9_]{1,32}$`                                                                                                                                                                                       |
| open_id                  | `^ou_[A-Za-z0-9_-]{1,64}$`                                                                                                                                                                                                                                                                                 |
| Status                   | off, unconfigured, setup, connecting, open, degraded, auth_failed, conn_limit, stopped; degraded reasons per §1; caps cards/reactions/files/cardCallback ∈ ok/denied/unknown                                                                                                                               |
| Destinations             | API `https://open.feishu.cn` / `open.larksuite.com`; registration `https://accounts.feishu.cn` / `accounts.larksuite.com`; WS: `wss:`, no userinfo, port ∈ {default,443}, host a PROPER subdomain of `.feishu.cn`/`.larksuite.com`, no trailing dot                                                        |
| Bootstrap codes          | `0` ok · `1`, `1000040343` retry · `1000040350` conn_limit · `514, 403, 10003, 10014, 1000040345` auth_failed · any other non-zero ⇒ auth_failed                                                                                                                                                           |
| Other code tables        | token invalid `99991663/99991664` · send uncertain `230020` · capability denied `99991672/230027`                                                                                                                                                                                                          |
| Frame limits             | frame 1 MiB, ≤64 headers, key/value ≤4 KiB                                                                                                                                                                                                                                                                 |
| Chunks                   | TTL 10 s, ≤16 msgs, ≤4 MiB/msg, ≤8 MiB total, `sum` ≤64                                                                                                                                                                                                                                                    |
| Timers                   | ping 10–300 s (def 120), reconnect interval 1–600 s, nonce 0–60 s; liveness 30 s; handshake 10 s; bootstrap 8 s; backpressure 1 MiB; backoff cap 60 s, stable reset 60 s; auth_failed retry 10 min, conn_limit 5 min; ≤2 sockets, close→terminate 5 s                                                      |
| ACK / shutdown           | group commit 100 ms, commit deadline 1.5 s (< 3 s platform budget), payload `{"code":200}`; shutdown steps 1 s / 2 s / 2 s / 1 s                                                                                                                                                                           |
| HTTP                     | 8 s per call, JSON ≤1 MiB, token margin 300 s; bootstrap body ≤64 KiB                                                                                                                                                                                                                                      |
| §5.8 + §R2-f caps        | state 4 MiB · allow 32 · dedup 16 384 / 72 h · non-terminal requests 256 · terminal 24 h / 2 000 meta · bindings 256 · dialog cards 64 / 24 h · nonces 512 / 24 h · approvals 16 / 24 h · outbox parts 512 · staging 100 MiB · list generations 4/chat/10 min · debounce chats 64 · ask drafts 32 / 30 min |
| Admission buckets        | sender cmd 10/3 s · global 60/min · callback 20/min (the shared `agent:` 30/1 s bucket is the hub's, not redefined)                                                                                                                                                                                        |
| Misc                     | `received` body ≤16 KiB (R2-c) · credentials ≤4 KiB · nonce 16 B ⇒ 22 chars · reaction max age 120 s · reply card ≤20 000 B, ≤4 parts · outbound auto ≤3 / buttons ≤5 / candidates ≤8 · notify 1 500 chars, 60 s / 5 min gaps, ≤20/min, evidence fresh ≤10 s                                               |
| Settings (`feishuBot.*`) | enabled false · allowGroups true · groupRootTopics false · notify `bound` · spawnScope `known` · debounceMs 1500 (0–10 000) · staleMessageS 300 (30–3 600) · files.outbound `auto` · files.inbound true · files.maxInboundMiB 30 (1–100)                                                                   |

Request-token header (§R2-a): `[飞书 · <sender> · <chat> · #<tok12>]`, first line of the dispatched text. `formatRequestHeader`
sanitizes both display fields (control/format chars, `· [ ] #`, newlines stripped; ≤32 code points; never empty) so a
Feishu sender can never forge a header-shaped token; `parseRequestHeader` / `splitRequestText` are the exact inverse.
cmdId shape: `fs` + 30 base64url chars (inside the hub's `CMD_ID_RE`). The HMAC/sha256 itself is NOT computed here
(module stays `node:*`-free) — F6 does it.

## Decisions made by F0 (not literally in the plan)

- `fsb_req` ops / error codes / status wire shape: from the plan author's F0 consult (op `info` backs `/webhub feishu status`;
  `confirm` carried explicitly; coexistence warning agent-side only; `info.data` = status, degraded[], brand, gen, uptimeMs,
  reconnects, lastClose, counters{in,dup,dropped{}}, outbox{ok,failed,lastCode}, bindings{total,offline,ambiguous},
  caps{4}, keepalive, masked owner/allow).
- `fsb_res.data` is a closed union of three strict shapes: `FsbInfoData | FsbSetupView{phase,qrUrl?,expiresAt?} | FsbAllowData{changed,count}`.
  Setup phases: `pending|done|expired|denied|cancelled|failed`. `device_code`/secret/token have no field ⇒ undecodable on the wire (tested).
- `HubConfig.feishuBot` (`FeishuBotHubConfig`) has NO `enabled` (key presence = on); `normalizeFeishuBotHubConfig` is strict —
  any malformed/out-of-range leaf ⇒ `undefined` (caller drops the whole key); unknown keys ignored, never copied.
- Settings: top-level `feishuBot` (not under `webHub`); `staleMessageS` (seconds) and `debounceMs` (ms) kept under the plan's
  names and NOT registered in `TIME_SETTING_MS_PATHS` (no `*Ms`⇄`*S` conversion, file never rewritten — tested).
  Parser: wrong type/unknown enum ⇒ default + `<leaf>-invalid`; numbers rounded + clamped into range (+ `-clamped`).
- `create_time` (V10): 13 digits ⇒ ms, 16 ⇒ µs÷1000; every other shape (incl. 10-digit seconds) ⇒ `undefined`, never guessed.
- Header field cap 32 code points (`FEISHU_HEADER_FIELD_MAX`) — F0's call.

## Not done / reported (outside the file domain)

- **Settings editor:** `src/config/setting-specs.ts` (`SETTING_SPECS`) holds the `webHub.*` editor entries but is outside F0's
  domain, so NO `feishuBot.*` entries were added (the block works from the settings file; nothing breaks without specs —
  the whole suite incl. `tests/ui` is green). Suggested entries for whoever owns it (all non-live; description must say
  "change: /reload then /webhub restart"): `bool` `feishuBot.enabled|allowGroups|groupRootTopics|files.inbound`,
  `choice` `feishuBot.notify` (bound/off), `feishuBot.spawnScope` (known/roots), `feishuBot.files.outbound` (auto/buttons/off),
  `count` `feishuBot.debounceMs` (0–10 000), `feishuBot.staleMessageS` (30–3 600), `feishuBot.files.maxInboundMiB` (1–100;
  `count()` has no max ⇒ spread + override like `webHub.spawn.maxProcesses`). Note `staleMessageS` ends in `S` but is NOT a
  `time:true` spec (no ms conversion).
- AGENTS.md / README settings table: F10's job.

## Hand-offs

- **F1** (`frame.ts`/`chunks.ts`): take limits from `FEISHU_FRAME_LIMITS` / `FEISHU_CHUNK_LIMITS` (note probe: frame headers
  also carry `x_frontier_recieved_time`, `x_frontier_arriverate`, `instance_id`, `trace_id`; `payload_encoding` is empty-string
  in practice; ACK payload = `FEISHU_ACK.payload`). `isAllowedWsUrl` / `clampClientConfig` are ready for F3.
- **F2** (`http/token/api`): `FEISHU_API_BASES`, `isAllowedApiBase`, `FEISHU_HTTP`, `FEISHU_BOOTSTRAP`, `classifyBootstrapCode`,
  `isAuthFailedCode` (token endpoint V11 `10014`), `FEISHU_TOKEN_INVALID_CODES`, `FEISHU_SEND_UNCERTAIN_CODES`,
  `FEISHU_CAPABILITY_DENIED_CODES`. `Typing` emoji confirmed (V9). Card PATCH works with or without `update_multi` (V5) but keep
  `update_multi:true` for multi-viewer cards.
- **F4** (registration/credentials/state): `FEISHU_CAPS` is the single cap table; `FEISHU_CREDENTIALS_MAX_BYTES`;
  `FEISHU_SETUP` (poll/expiry/`slow_down`+5 s/qrUrl ≤2 048); `isAllowedRegistrationBase`; `FsbSetupView` is the ONLY setup
  view allowed on the wire; `FEISHU_NONCE_RE`/`FEISHU_IDENTITY` for nonce shape. `FeishuBotStatus`/`FeishuDegradedReason`
  /`capabilityDeniedReason` for the status machine; `feishuKeepaliveActive(status)` is the `bot:1` rule for `hub/idle.ts` (FA).
- **F6** (admission/requests): `normalizeCreateTimeMs` + `isStaleCreateTime` (unknown ⇒ `undefined` — recommend fail closed:
  do not execute, short notice); header helpers (`formatRequestHeader`, `splitRequestText` for the anchor check) and
  `FEISHU_CMD_ID_RE`; `FEISHU_RATE_LIMITS`; `FEISHU_RECEIVED_BODY_MAX_BYTES`. Callback `create_time` is µs — normalize through the same helper.
- **F9** (`/webhub feishu`): send `fsb_req` only when `hello_ack.caps ∋ FSB_HUB_CAP`; decode `fsb_res` via `decodeHubFrame`;
  `repair`/`reset` and `setup_begin --replace` must send `confirm:true` after the TUI confirm (hub answers
  `E_FSB_CONFIRM_REQUIRED` otherwise); `openId` must match `FEISHU_OPEN_ID_RE`; setup polling cadence `FEISHU_SETUP.agentPollMs`;
  the feishu-notify coexistence warning is agent-side (not in `FsbInfoData`); `loadFeishuBotWarnings()` supplies settings warnings.
- **FA**: `buildHubConfig` writes `FeishuBotHubConfig` (settings minus `enabled`) iff `feishuBot.enabled ∧ webHub.enabled ∧
webHub.control !== false`; `hub/main.ts` calls `normalizeFeishuBotHubConfig` and drops the key on `undefined`; fold `FSB_HUB_CAP`
  into BOTH cap surfaces iff `config.feishuBot` (pin in caps-coexist; a test in `feishu.test.ts` currently asserts the cap is NOT yet
  referenced by `hub.ts`/`agent-server.ts` — flip/remove it when FA lands). `fsb_req` routing in `agent-server.ts` mirrors `lan_req`.

## Self-verification

- `timeout 280 npm run typecheck` — clean (tsc ×2 + vue-tsc).
- `timeout 600 npx vitest run tests/web-hub/protocol tests/config tests/web-hub/boundary.test.ts` — 69 files, 1 795 passed / 3 skipped.
- Full `npx vitest run` — 1 070 files, 19 414 passed / 22 skipped (no failures).
- `npx prettier --check src/web-hub/protocol src/config tests/web-hub/protocol tests/config` — clean.
- Residual note: `.prettierignore` shows a diff in the worktree that is NOT from F0 (another agent's); untouched.
