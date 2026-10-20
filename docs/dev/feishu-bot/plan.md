# Feishu bot — implementation plan v2

Status: plan v2 (2026-10-17), revised after review R1 (gpt-6.1-sol, REVISE, 21 items; all adopted — see §R1).
Inputs: `multica-research.md`, `explore.md`, AGENTS.md web-hub invariants, upstream `larksuite/node-sdk`
**pinned at `b188be60134d409b61259546bcf69c731d2b0b7c` (v1.76.0, 2026-10-16)**, files `ws-client/{index,enum,data-cache}.ts`,
`ws-client/proto-buf/pbbp2.js` — the byte-level reference for §2 (multica's Go client is secondary). Items tagged **V#**
are tenant facts gated by the F-probe package (§13); nothing depending on a V# is implemented before its probe result.

## 0. Fixed decisions

User (final):

- **D1** remote control + topic binding: p2p keeps a CURRENT-session pointer over every pi session the hub sees
  (`/list`, `/use <n>`, `/new <dir>`, `/cur`); every reply is session-labelled; in groups one topic binds one session; @-bot only.
- **D2** one final reply per run + "Typing" reaction while running; no streaming cards.
- **D3** v1: ask_user card buttons (third race channel), files both directions, proactive done/failed notices (waiting = answerable ask cards only, ruling 2026-10-19). **No `/stop`.**
- **D4** QR device-flow registration (`PersonalAgent`) → app_id/secret + owner open_id (default sole allow-listed user);
  hand-written long-connection client, **no runtime dependency**.
- **Q1** keepHubAlive while the bot is configured = **yes**.
- **Q2** strangers: **silently dropped** + owner approval card (rate-limited, owner-only).
- **Q3** outbound files: recognise paths in the reply + `/file <path>`; **no agent tool**.
- **Q4** `src/feishu-notify` coexists, **untouched in v1**.

Main-session ruling **R-16 (show to the user)** — bounds on Q3: AUTO-send happens only in **p2p**, only **images**, only for
paths inside the **bound session's cwd subtree** (canonicalized, fd-anchored preview admission + denylist), only from a reply
**causally attributed** to the current Feishu request (§5.6). Everything else (non-images, outside cwd, group topics,
recovered/unattributed replies) becomes a **button** that only the owner or the requesting allow-listed sender can press,
re-checked at press time. `/file <path>` stays explicit.

Cut from v1 (R1 #21): `/watch`, rich pickers (session/dir chooser cards, list "use" buttons), `notify:"all"`, history-resume
of exited TUI sessions, card-response-in-ACK.

## 1. Placement & lifecycle

All bot logic lives **hub-side**, pi-free: `src/web-hub/hub/feishu/`. Rationale: only the hub sees every session
(`hub/registry.ts`), owns the cmd router, dialogs bus, managed spawn, uploads; one hub per machine ⇒ one WS ⇒ no lease.
Agent side: `/webhub feishu …` (`src/commands/webhub.ts`), QR rendering, `fsb_req`/`fsb_res` frames.

**Gate (non-live, `spawn`/`proxy` pattern):** `buildHubConfig` (`src/web-hub/agent/index.ts:1091`) writes `HubConfig.feishuBot`
iff `feishuBot.enabled ∧ webHub.enabled ∧ webHub.control !== false`; key absence = off (no service, timers, network, disk, cap);
`hub/main.ts` normalizes and drops the whole key when malformed. Credentials are runtime state (setup/reset hot-start/stop the
connector inside the gate). Per-session reach degrades, never errors: no `cmd.v1` ⇒ `read-only`; no `dialog.v1` ⇒ no ask cards;
`webHub.spawn.enabled` off ⇒ `/new` refuses.

**Bot status machine (one value, shown by status/web):** `off | unconfigured | setup | connecting | open | degraded(reason) |
auth_failed | conn_limit | stopped`. `degraded` reasons: `state-corrupt`, `credentials-unsafe`, `persist-failed`, `ws-unavailable`
(no global `WebSocket`, Node <22.4), `undecodable-events`, `capability-denied:<x>`.

**Keepalive (Q1, R1 #18):** while credentials are loaded (any status except `off`/`unconfigured`), `hub/idle.ts` `counts()` adds
`bot:1` — the hub never idle-exits, including with zero agents. It changes only idle-exit: `/webhub stop` (stop marker) still stops
the hub and the bot; supersede still replaces the hub (new hub reconnects); `reset` removes credentials ⇒ keepalive ends at once;
a bot startup failure (`degraded`/`auth_failed`) still keeps the hub alive so status stays reachable. Known limitation: after a
machine reboot the bot is offline until some pi relaunches the hub (no systemd unit in v1).

**Single shutdown policy (R1 #1):** on ANY hub stop (shutdown, supersede, `/webhub stop|restart`, reset) the FIRST cleanup step is
`bot.stop()`: (1) stop reading the socket — no frame received from here on is ACKed; (2) the group-commit in flight finishes
(≤1 s) and only frames whose `received` record is durable get ACKed; (3) no new dispatch starts; in-flight dispatches get ≤2 s,
whatever has no result stays `dispatching`; (4) outbox drains ≤2 s, unsent parts stay `queued` on disk; (5) state flush ≤1 s.
Next boot resumes per §5.7. **Multi-machine:** Feishu fans long-conn events to one random connection; one app per machine
(bot named `pi@<hostname>`); `conn_limit` (§2.5) is surfaced as "another process may be using this app".

## 2. Long-connection protocol (mirrors node-sdk @ b188be6)

### 2.1 Endpoint bootstrap

`POST {apiBase}/callback/ws/endpoint`, JSON `{"AppID","AppSecret"}`, headers `Content-Type: application/json; charset=utf-8`,
`locale: zh`; timeout 8 s, body ≤64 KiB. Response `{code,msg,data:{URL,ClientConfig:{PingInterval,ReconnectCount,
ReconnectInterval,ReconnectNonce}}}` (seconds). `service_id`/`device_id` parsed from the URL query (missing ⇒ failure).
Codes (enum.ts): `0` ok; `1` system_busy and `1000040343` internal ⇒ retryable backoff; `514` auth_failed and `403` forbidden ⇒
`auth_failed` (retry every 10 min, message surfaced); `1000040350` exceed_conn_limit ⇒ `conn_limit` (retry 5 min); any other
non-zero ⇒ `auth_failed` with code (V11 confirms). Fresh bootstrap per dial (URL is single-use).

### 2.2 Destination allowlist (R1 #7)

`apiBase ∈ {https://open.feishu.cn, https://open.larksuite.com}` (from credential `brand`); registration only
`https://accounts.feishu.cn|accounts.larksuite.com`; the WS URL must be `wss:` with host under `.feishu.cn`/`.larksuite.com`
(exact suffix list frozen from the F-probe P2 observation). Anything else ⇒ refuse + `degraded`.

### 2.3 Frame codec (`hub/feishu/frame.ts`) — pbbp2 `Frame`

Fields: 1 SeqID uint64, 2 LogID uint64, 3 service int32, 4 method int32 (0 control, 1 data), 5 headers repeated
`{1 key, 2 value}`, 6 payload_encoding, 7 payload_type, 8 payload bytes, 9 LogIDNew. uint64 kept as `bigint` and echoed verbatim.
Encode order matches `pbbp2.js` `Frame.encode` (always 1–4, headers, 6, 7, 8 iff set, 9). Decoding skips unknown fields of wire
types 0/1/2/5. **Fixtures:** `tests/fixtures/feishu/pbbp2-vectors.json` — hex vectors (ping, pong w/ config, event, chunked event,
ACK) generated ONCE by `scripts/dev/feishu-vectors.ts` run in a scratch checkout of the pinned commit (with its protobufjs);
the JSON records the commit hash and script; tests assert byte equality both ways.

**Frozen malformed-frame behaviour (R1 #3):**

| Condition                                                                                         | Action                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| non-binary WS message, protobuf decode error, frame >1 MiB, >64 headers, key/value >4 KiB         | drop, counter, **no ACK** (nothing to address)                                                                                        |
| control frame, unknown `type`                                                                     | ignore, counter                                                                                                                       |
| data frame `type≠event` (incl. legacy `card`)                                                     | ACK 200 (SDK only handles `event`), counter `ignored-type`                                                                            |
| chunk meta invalid (`sum` not int 1..64, `seq∉[0,sum)`, `sum` disagrees with first chunk)         | drop chunk, **no ACK**, counter (SDK behaviour)                                                                                       |
| assembled payload: unknown non-empty `payload_encoding`, invalid UTF-8/JSON, envelope schema miss | durable `undecodable` record → ACK 200 → `degraded(undecodable-events)` + rate-limited owner notice (≤1/h) — **never silent success** |

**Aggregate limits:** chunk cache (`chunks.ts`, mirrors `data-cache.ts`): TTL 10 s, ≤16 messages, ≤4 MiB per message,
≤8 MiB total; overflow ⇒ refuse new chunk sets (no ACK) rather than evict partial ones.

### 2.4 Session behaviour (`hub/feishu/connector.ts`)

- **Generations:** every socket gets `gen`; every timer/handler/ACK captures it; anything from a stale gen is a no-op. A frame's
  ACK is sent only on the socket it arrived on; if that socket is gone, no ACK (redelivery + dedup cover it).
- **Ping/liveness:** control `ping` every `PingInterval`; after each ping, no inbound frame within 30 s ⇒ close+reconnect (SDK
  `armLiveness`). Server `ping` is ignored (SDK). `pong` with payload = JSON ClientConfig ⇒ clamp + apply from the next ping;
  malformed ⇒ ignore + counter.
- **Finite timer bounds:** PingInterval clamped [10 s, 300 s] (default 120), ReconnectInterval [1 s, 600 s], ReconnectNonce
  [0, 60 s]; ReconnectCount ignored (always retry). Handshake 10 s; bootstrap 8 s; write backpressure: `bufferedAmount >1 MiB` ⇒
  reconnect. Backoff `min(60 s, 2^n s)` full jitter (first attempt waits `rand(0,nonce)`), reset after 60 s stable. All timers unref'd.
- **ACK frame:** the inbound frame echoed (SeqID, LogID, service, method, headers, 6/7/9) + header `biz_rt=<ms ≥0>`; payload
  `{"code":200}` (SDK shape). We never NACK in v1 (redelivery-loop risk); "not ACKing" is the only reject.
- **ACK path & 3 s budget:** decode → assemble → envelope parse → dedup check → append `received` to the group commit → ACK once
  that commit is durable. Group commit every ≤100 ms, fsync'd; commit not durable within 1.5 s ⇒ no ACK, `degraded(persist-failed)`,
  connector paused until a write succeeds. No network I/O before ACK.

## 3. HTTP, token, API

`hub/feishu/http.ts`: per-attempt `AbortController`, unref'd timers, body caps (JSON 1 MiB), never throws — typed
`{ok:true,data} | {ok:false,kind:"network"|"timeout"|"http"|"api"|"too-large",status?,code?,msg?}`; reuses
`src/web-search/resilience.ts` (`isRetryableError`, `backoffDelay`, `redactSecrets`); redacts secret/token/Authorization; destination
must pass §2.2. `token.ts`: `POST /open-apis/auth/v3/tenant_access_token/internal`, cache until `expire−300 s`, single-flight,
memory-only, invalidate + retry once on 99991663/99991664. `api.ts` (8 s default each): `send` (`receive_id_type=chat_id|open_id`),
`reply` (`reply_in_thread`, `uuid`), `patchCard`, `addReaction`/`delReaction` (`Typing`, V9), `downloadResource`
(`?type=image|file`, streamed, capped), `uploadImage` (`image_type=message`), `uploadFile`, `botInfo`. Multipart via Node 22
`FormData`/`Blob`. Send classification (multica): 230020/5xx/timeout = uncertain ⇒ retry ONLY with the same `uuid`; chat-level
fallback never (§6.2).

## 4. Events, identity, authorization

**Events:** `im.message.receive_v1` and `card.action.trigger` (header `type=event`, schema 2.0). Shapes per multica decoder;
`create_time` unit per V10. Everything else ⇒ ACK, debug-once, drop.
**Capability probing at runtime:** first `99991672`/`230027`-class reply on a capability ⇒ `capability:<x>=denied` (status +
console hint). ask cards always carry the text fallback (§6.3) in case card callbacks are unavailable (V2b).

### 4.1 Admission adapter (`hub/feishu/admission.ts`, R1 #5) — the ONLY path to `commandRouter.request`

Synchronously, immediately before every dispatch (also for retries/recovered work):

1. installation live (credential generation unchanged, status not `stopped`/reset) and tenant matches the pinned `tenantKey`;
2. sender still in the live allow-list (allow-list read now, never from a cached copy taken at receive);
3. op ∈ `{prompt(deliver:"followUp"), dialog_answer, dialog_cancel}` — nothing else is reachable from Feishu;
4. rate limits: the **shared** hub `CmdLimit` (same instance `hub/http.ts` uses — hoisted in hub.ts) bucket `agent:${agentKey}`
   (30/1 s) + `feishu:<openId>:cmd` (10/3 s) + `feishu:global` (60/min) + `feishu:cb` (callbacks, 20/min);
5. session resolution unambiguous (§5.1).
   Failure ⇒ refused, recorded on the request, never retried automatically. The synthetic origin
   `{listener:"lan", ip:"feishu", user:"feishu:"+openId, reqId}` has **wire attribution fields only**, never authorization authority.
   **FA verifier follow-up (§R2-k)**: command-ledger identity is instead selected by a trusted, private, hub-local origin brand
   with top-level principal `fsb:<installGen>:<openId>`; LAN derivation remains `lan:<origin.user>`. No username-grammar or
   numeric session-principal assumption is used to prove command-ledger isolation. The brand never crosses JSON.

### 4.2 Identity rules

- **Allow-list** (open_ids, per-app) seeded with the owner; managed by `/webhub feishu allow|deny`; cap 32 (add beyond ⇒ refused).
- **Tenant pin:** first owner event's `tenant_key` (TOFU) stored; other tenants dropped. Per-message sender check (groups too);
  `sender_type≠user` dropped. Group: `feishuBot.allowGroups` and @-bot (`mentions[].id` vs `botOpenId`/union_id); `@_user_N` stripped.
- **Stale:** `create_time` older than `staleMessageS` (300) ⇒ not executed, short notice; reactions only on messages <2 min old.
- **Strangers (Q2):** silent drop; owner p2p card "<name> wants to use the bot [Allow] [Ignore]": ≤1 per sender per 24 h, ≤16
  pending approvals globally (more ⇒ no card, counter), TTL 24 h; nonce owner-only; executing Allow re-checks the presser is still
  owner, the approval unexpired and the allow-list cap.
- **Revocation (R1 #6):** `deny <id>` immediately purges that sender's debounce buffers, unbound-held messages, queued not-yet-
  dispatched requests (state `received` ⇒ `revoked`), and all nonces issued to them; `reset` purges everything and closes the WS.
- **Logging:** routing + decision only (event_type, chat_type, sha256(open_id)[0:8], message_id, reason); never bodies, card JSON,
  file names, paths.

### 4.3 Action nonces (R1 #6)

Card values carry only `{n:<16 random bytes b64url>}`. Server record binds `{installGen, tenantKey, operatorOpenId (owner for owner
actions; the requesting sender otherwise), chatId, messageId (the card), action, target}`; callback must match operator,
`context.open_chat_id`, `context.open_message_id` and tenant; one-shot; TTL ≤24 h; cap 512 (full ⇒ new card degrades to text
fallback, nothing evicted).

### 4.4 Credentials

`<stateDir>/feishu-bot/credentials.json`, dir 0700 (`ensurePrivateDir`), file 0600 atomic (`hub/privacy/store.ts` pattern):
`{v:1,brand,appId,appSecret,ownerOpenId,botOpenId?,createdAt,gen}`. On load: `lstat` regular file (no symlink), owner = hub uid,
`mode & 0o077 === 0`, ≤4 KiB, schema valid — else `degraded(credentials-unsafe)`, not loaded, never auto-overwritten. Never in
HubConfig, hub.json, logs, frames.

## 5. Routing & delivery

### 5.1 Session directory (`sessions.ts`, pure)

From `registry.list()` (+ `supervisor.records()`). Durable key = `sessionId`; `agentKey` is a cache. Resolution: exactly one live
view with that sessionId ⇒ route; zero ⇒ `offline`; **more than one ⇒ `ambiguous`, fail closed** ("open in several processes —
close one or /use another"). Label: `<name ?? basename(cwd)> · <sessionId[0:6]>`.

### 5.2 Binding keys

p2p `p2p:<chat_id>` (current pointer); topic `grp:<chat_id>:<thread_id>`. Each binding has `rev` (+1 on every change).
Group @-bot outside a topic: only when V8 confirmed AND `feishuBot.groupRootTopics` (default false) ⇒ reply with
`reply_in_thread:true` and bind the resulting thread; otherwise reply (plain reply, notice only, never agent output) "use me inside
a topic".

### 5.3 Commands (first line, case-sensitive; text replies in v1)

`/list` (numbered: live first, then offline bound; state busy/idle/waiting/read-only/offline/ambiguous; mode tui/rpc/managed;
list generation kept 10 min) · `/use <n|sid-prefix|name>` · `/cur` · `/new <dir> [first message]` · `/unbind` · `/file <abs path>`
· `/help`. `//text` sends literal `/text`; unknown `/x` ⇒ help, never forwarded. Unbound binding + plain message ⇒ "no session
bound — /list then /use"; the message is not held.

Post (rich text) messages (live-acceptance fix, 2026-10-19): `inbound.ts`'s `feishuPostText` extracts plain text from
`content.<locale>.{title,content:[[tag…]]}` before the command grammar runs, so `/use` etc. work identically in a post.
The desktop client also sends a FLAT shape (no locale wrapper: `{title, content:[[…]]}`, live-accepted 2026-10-19) — it decodes with the same rules; a flat `content` that isn't the paragraph array still drops.
Rules: locale preference zh_cn → zh-CN → en_us → en-US → first other key (a present-but-malformed preferred locale is a
`content-invalid` drop, never a fall-through); a non-empty `title` becomes the first line (so a titled post can never start
with a command, same as any leading text); paragraphs join with `\n`, tags concatenate, empty (img/media-only) paragraphs are
dropped; `text` → text (required string), `a` → display text else href else `text (href)` when both differ, `at`/`img`/
`media`/`emotion`/unknown tags contribute nothing (mention stripping is unchanged). Structural caps: ≤16 locales scanned,
≤256 paragraphs, ≤256 tags/paragraph, ≤64 KiB per text/href/title — violations drop as `content-invalid`.

### 5.4 Durable request states (R1 #1/#2) — `state.json.requests`

> **See §R2-c** (full durable payload, budget check before ACK).
> `received` (persisted before ACK) → `dispatching` (persisted before `commandRouter.request`) → `accepted` | `rejected(code)` |
> `uncertain` → `replied` | `reply-failed` | `unattributed` | `revoked` | `expired`.

- Each request freezes `{sessionId, bindingKey, bindingRev, senderOpenId, batchId, cmdId, text digest}` at batch close (R1 #9).
  At dispatch, binding `rev` changed ⇒ not sent, `rejected(binding-changed)`, user told to resend.
- `cmdId = "fs" + b64url(sha256(batchId))[0:30]`, `batchId = sha256(sorted member message_ids)` (deterministic, R1 #10).
- Router result: ok ⇒ `accepted` + Typing reaction; ok:false `effect:"none"` ⇒ `rejected` (user told); `effect:"unknown"`,
  `E_DEADLINE`, throw ⇒ `uncertain`.
- **Never auto-redispatch an uncertain effect.** Boot recovery: `received` ⇒ resumes normally (no effect yet; stale rule applies);
  `dispatching`/`uncertain` ⇒ one `queryOnly` with the same cmdId; agent says done ⇒ adopt the result; anything else (incl.
  `E_UNKNOWN_ID`, agent gone) ⇒ `uncertain`, user gets "may not have been delivered" + a [Resend] button (requesting sender only;
  pressing creates a NEW request with a new batchId).
- Uploads pinning exactly as `hub/http.ts:2560-2640`, principal per §7.1.

### 5.5 Debounce (R1 #10)

Window `debounceMs` (1500). A batch merges only messages with identical `{bindingKey, bindingRev, frozen sessionId,
senderOpenId, thread root}`; any difference, a command, or 20 attachments closes the batch. Batch membership persists with the
`received` records.

### 5.6 Run attribution & final reply (`runs.ts`, R1 #11)

> **Superseded in part by §R2-a/§R2-b** (request-token anchor; continuity rule replaces snapshot backfill).
> Causal chain per request, all from the bus (`ctl` + non-droppable `ev`):

1. `ctl` item for our `cmdId` reaches `consumed` (agent `commands.ts` sets it exactly when the user `message_start` carrying that
   text starts); `dropped`/`recalled`/`returned`/session-mismatch ⇒ request ends `rejected`, no reply content.
2. Anchor = the user `message_start` on that agentKey, at/after our dispatch seq, whose text is byte-equal to the dispatched text.
3. Reply content = assistant `message_end`s after the anchor and before the next user `message_start` (any source) or
   `agent_settled`, whichever first; if cut by another user message, the reply says "continued by another input".
4. Emit on `agent_settled` only (**no `agent_end` fallback**). No anchor within 60 s of `consumed`, or any link missing ⇒
   `unattributed`: no content sent, notice "delivered; result could not be attributed — /cur". The next settled result of an
   agentKey is never attributed to a pending request by timing alone.
   `stopReason` error/aborted ⇒ failed card; wire-truncated text (`truncated:true`) ⇒ "output incomplete (truncated in transit)".
   Pending without settle: TTL 24 h ⇒ `expired` ("no end signal"), reaction removed — never reported as success.

**Session transfers (R1 #9):** a `session` bus event changing the sessionId of an agentKey that has our request `accepted`
but not consumed is followed ONLY with positive correlation: the new session's first user `message_start` within 60 s is
byte-equal to our text ⇒ rebind (`rev`+1) and note it; otherwise the binding goes `offline(session-changed)` and the user is
asked to `/use`.

**Hub-restart backfill (R1 #12):** only with causal proof: the recovered request has its cmdId, the reconnected agent's `ctl`
shows it `consumed`, and a bounded `snapshot` (3 s) `recent` contains the anchor + the assistant messages up to `agent_settled`
evidence (status idle). Any gap ⇒ `unattributed` notice, no content.

### 5.7 `/new` and relaunch

F5 extracts the non-session create path of `hub/spawn/routes.ts` (`dirs.admit` → confirm → `supervisor.start` →
`firstPrompt.accept` → idempotency) into **`hub/spawn/entry.ts` `startFresh(intent, ctx)`**; routes become a thin adapter with
**byte-identical HTTP status/body, limits, rate buckets and audit lines** (golden tests on the existing route suite).
Bot calls it with principal `feishu:<installGen>:<openId>`, own rate bucket, scope `feishuBot.spawnScope` (`known` default |
`roots`); unknown dir ⇒ confirm card (realpath, [Create], nonce bound to requester; `expectCwd`=realpath). Live ⇒ agentKey from
`spawns` ⇒ sessionId ⇒ bind. Bound session offline: terminal managed record + `spawn.restore` ⇒ [Relaunch] (`supervisor.relaunch`,
B-alive reason surfaced); else "offline — `/new <same dir>` or `/list`".

### 5.8 `state.json` and caps (R1 #17)

`<stateDir>/feishu-bot/state.json`, 0600 atomic + fsync, group commit (§2.4), ≤4 MiB. Every map/queue has a cap; at cap the
**new item is refused** (never silent eviction of security state):

| Store                         | Cap / TTL                               | At cap                                         |
| ----------------------------- | --------------------------------------- | ---------------------------------------------- |
| allow-list                    | 32                                      | refuse add                                     |
| dedup (event_id + message_id) | 16 384 / 72 h (≥ V7 redelivery horizon) | stop ACKing new events, `degraded`             |
| requests (non-terminal)       | 256; terminal kept 24 h                 | new inbound refused with notice                |
| bindings                      | 256                                     | refuse `/use` in new chat                      |
| dialog cards                  | 64 / 24 h                               | text-only ask notice                           |
| nonces                        | 512 / ≤24 h                             | text fallback                                  |
| approvals                     | 16 / 24 h                               | no card                                        |
| outbox parts                  | 512 (finals never dropped)              | notifications refused; finals → `reply-failed` |
| upload staging                | 100 MiB                                 | refuse attachment, noted in reply              |

**Corruption:** unreadable/invalid state ⇒ `.bak` copy, `degraded(state-corrupt)`, **connector not started** (fail closed: no
ACKs, Feishu keeps events per its policy), until local repair `/webhub feishu repair` (TUI confirm; keeps credentials, re-seeds
allow-list with the owner, clears dedup/requests, re-pins tenant on next owner event).

## 6. Replies

### 6.1 Format & splitting (R1 #13)

Schema-2.0 card, small header `pi · <label>` (green done / red failed / orange waiting / grey info), one markdown element; very short
system notices as text prefixed `【label】`; group replies @ the sender. Split by **UTF-8 byte length of the serialized card JSON**
(≤20 KB) at paragraph/fence boundaries (re-open fences), ≤4 parts `(i/n)`; more ⇒ part 1 + full text as `reply-<sid6>.md`.

### 6.2 Targets & outbox (R1 #12)

Topic ⇒ `reply` with `reply_in_thread:true`; p2p ⇒ reply to the trigger; proactive p2p ⇒ `send receive_id_type=open_id`; proactive
topic ⇒ reply to the topic's last trigger. A failed in-thread reply is `reply-failed` — **never** a chat-level fallback outside a
bound topic. Outbox (`outbox.ts`): persisted parts `{sendId=uuid(reqId:part), state queued|sent|failed}`; same uuid on every retry
(≤2, backoff); per-chat serial ≥250 ms, global ≤20/s, task budget 30 s; finals never evicted (§5.8).

### 6.3 ask_user bridge (R1 #14)

- Hub watches `dialogs` bus events for sessions bound to a chat; new `(dialogId, epoch)` ⇒ one card per dialog, recorded in
  `dialogCards`. Answer ⇒ admission (§4.1) ⇒ `dialog_answer` ⇒ agent `DialogBridge.answer()`; `createDialogRace` makes the first
  remote/TUI answer win; losers get `E_DIALOG_CLOSED`. **No change** to `src/ask-user/remote.ts` or the agent (closed `by` reads
  `"web"`; origin text shows `feishu:<openId>`).
- **Addressing:** every card names its dialog short code `#k3`; text fallback `#k3 1` / `#k3 1,3` / `#k3 text`; unaddressed text is
  accepted only when exactly one dialog is open in that binding (otherwise a disambiguation notice; the text is NOT sent as a prompt).
- **Bounded draft:** multi-question forms keep a server-side draft per `(dialogId, operator)`: ≤8 questions, Other ≤4 KiB, per-
  question skip, explicit [Cancel] only when `allowCancel`; submit validates locally against the dialog's questions first.
- **Reconcile:** on agent reconnect and hub boot, `dialogCards` are diffed against the registry's `dialogs.open`: missing ⇒ send,
  stale ⇒ PATCH "expired", closed ⇒ PATCH final ("answered via TUI/web/Feishu", "cancelled", "aborted").
- **Validation error** (`E_BAD_ANSWER`, local check) ⇒ PATCH the card with fresh nonces (tokens are one-shot). Card JSON
  `config.update_multi:true` (V5). No ask timeout; cards expire with the record (24 h).

### 6.3.1 PATCH recovery and phone links (2026-10-20 field fix)

- Schema 2.0 forms use `button.form_action_type:"submit"`, **not** the legacy `action_type:"form_submit"`;
  `input.max_length` is at most **1000 characters** (the answer protocol still accepts Other up to 4096 UTF-8 bytes).
  Two real tenant probe cards reproduced `230099` / inner `11310` for 4096, then `230099` / inner `300123` for the legacy
  submit field. Correcting both accepted the card, including long Chinese/emoji labels; both probes were deleted.
- Initial delivery already includes questions, numbered options/descriptions, short code, text-answer hint and web link.
  Non-capability interactive PATCH failure makes ONE bounded text-card PATCH with that same content; it does **not** close
  the live dialog record (single-question text answers must still work). Multi-question text answers remain unsupported
  (R2-g); the fallback says so and points to web. Settled/disposed cards never initiate this fallback.
- Display labels are bounded by Unicode code points (button 40 / selector 80), while callbacks still map indices to the
  original full labels. Quick buttons are limited to eight options, three columns per row; selectors admit at most 99
  options plus Skip. Larger controls/serialized JSON >20000 bytes use the text card. Oversized text fields shrink in
  stages; content too large even then explicitly points to the complete web questions, never claims to contain them all.
- `web-hub feishu:` events `dialog-refresh-skipped`, `card-patch-failed`, `dialog-text-fallback` explain gates/PATCH failures.
  Samples are keyed by static event/reason, once/minute, at most 20/minute, with 64 retained keys. No ids, bodies, questions,
  URLs or secrets. PATCH logs include numeric API code and a safe `msg`: known validation messages/inner ErrCode are kept;
  unknown platform prose/`ErrorValue` is omitted because it can reflect card content.
- All Feishu deep links use one selector: valid `lan.externalOrigins[0]` → most recently cookie-authenticated direct-LAN
  Host (revalidated against the LIVE allow-list, memory only) → first non-loopback allowed LAN Host → loopback listener.
  The host snapshot carries the actual LAN listener port. Public/failed-auth/Host-rejected requests cannot update it.
  Invalid injected links retain `web 会话页面`; before a listener binds, absent other evidence yields the same fallback.
  This is link selection only: no authentication or host-admission rules are widened.

Evidence, implementation coordinates and gate output: [ask-card-fix-report.md](ask-card-fix-report.md).

## 7. Files

### 7.1 Inbound (`files.ts`, R1 #15)

Image/file/media/audio messages and `post` `img`/`media`: `downloadResource` streamed, cap `files.maxInboundMiB` (30,
≤`UPLOAD_FILE_MAX_BYTES`), 30 s per file, ≤4 concurrent. Unknown length ⇒ staged in `<stateDir>/feishu-bot/staging/` (0700, §5.8 cap)
then uploaded with a known size; staging file deleted after commit or failure, swept at boot. One storage principal
`feishu:<installGen>:<openId>` for `begin`/`chunk`/`commit`/`abort`/`pinForPrompt`; bucket `bucketFor({sessionId, agentKey})`;
names via `sanitizeUploadName`; attachment block via `formatAttachmentBlock` (agent unchanged). Failures noted in the reply,
`uploads.abort` on partials. Inbound mime (2026-10-19): `begin` carries `feishuMimeForName(name)` — a small explicit
extension map (md/markdown/txt/log/json/csv, png/jpg/jpeg/gif/webp/svg, pdf, zip, mp4/mov/webm, mp3/wav/m4a/ogg), never
content-sniffed, unknown extensions pass no mime (attachment shows "unknown type"); every value satisfies `normalizeMime`.
A `media` tag's `image_key` is the video cover thumbnail and is never downloaded.

### 7.2 Outbound (Q3 + R-16)

Candidates: paths in the final reply (backtick spans + bare `/…`, `~/…`, ≥2 segments, ≤8). Each runs the preview chain
(`hub/preview/admit.ts` `createFsAdmitter`: denylist, realpath re-check, regular file; `hub/preview/open.ts` `openAdmittedPath`:
`O_NOFOLLOW`, fstat dev/ino), total budget 1.5 s.

- **Auto-send** iff p2p ∧ attributed reply (§5.6) ∧ image (png/jpg/gif/webp sniffed, ≤10 MB) ∧ canonical path inside the
  canonicalized cwd of the bound session; ≤3 per reply.
- **Otherwise button** "Send <name> (size)" (≤5/reply), nonce bound to `{owner or requesting sender, chat, card}`; press ⇒ full
  admission re-run ⇒ `uploadImage`/`uploadFile` (≤30 MB).
- `/file <path>` (allow-listed sender, p2p or bound topic) ⇒ same admission, explicit.
- Setting `files.outbound`: `auto` (default) | `buttons` | `off`. Denylist hits show "refused" only.

## 8. Notifications (R1 #19)

Scope `feishuBot.notify`: `bound` (default: sessions bound in any chat) | `off`.

- **done** for non-Feishu-initiated runs in bound sessions on `agent_settled` (first 1 500 chars), gated by **conservative
  background-idle evidence**: registry status fresh (≤10 s), `status.bashJobs` present and none running, all fleet rows terminal;
  missing/stale evidence ⇒ treated as busy ⇒ suppressed (not deferred). ≥60 s apart per session.
- **failed**: assistant `stopReason:error` or `session_compact_failed ∧ !willRetry`; ≤1/5 min/session.
- **waiting**: ask cards (§6.3) only. A prompt Feishu cannot answer (no card: unattributed native `ui_prompt_start`, > 8
  questions, card store refused) pushes nothing (user ruling 2026-10-19).
- Global ≤20 notices/min.
  **Coexistence with `src/feishu-notify` (Q4):** its triggers — result card (success/error at `agent_settled`), `waiting` (a tool
  waiting > `waitNotifyTimeoutSec`, default 120 s), long-task heartbeat (`heartbeatIntervalSec`), subagent summary, idle reminder,
  `/feishu-test` — fire per pi session once its gate opens (`@notify`/`#notify` keyword, `/watch`, `watchDefault`). Both can fire for
  the same run. `/webhub feishu setup|status` (agent side, which can read `~/.pi/agent/feishu-notify.json` / `FEISHU_WEBHOOK_URL`)
  prints a coexistence warning when feishu-notify is configured, suggesting `watchDefault:false`.

## 9. Settings, commands, setup

| Setting (non-live)                                                 | Default            |
| ------------------------------------------------------------------ | ------------------ |
| `feishuBot.enabled`                                                | false              |
| `feishuBot.allowGroups`                                            | true               |
| `feishuBot.groupRootTopics`                                        | false (V8)         |
| `feishuBot.notify`                                                 | `"bound"`          |
| `feishuBot.spawnScope`                                             | `"known"`          |
| `feishuBot.debounceMs`, `staleMessageS`                            | 1500, 300          |
| `feishuBot.files.outbound`, `files.inbound`, `files.maxInboundMiB` | `"auto"`, true, 30 |

(keepalive is not a setting — fixed by Q1.)

**Commands** (`src/commands/webhub.ts` `SUBCOMMANDS += "feishu"`; client `src/web-hub/agent/feishu-admin.ts`):
`setup [--replace]`, `status`, `allow|deny <open_id>`, `repair`, `reset`. Frames `fsb_req {rid, op}` / `fsb_res {rid, ok, data|code}`
intercepted in `agent-server.ts` like `lan_req`; sent only when `hello_ack.caps ∋ fsb.v1` (declared iff `config.feishuBot`; added to
both the `HubInfo.caps` fold and agent-server list, pinned by caps-coexist).

**Setup (R1 #7):** hub-side, at most ONE setup generation (`setupGen`). `setup_begin` while one runs ⇒ returns that run's public view.
Existing credentials ⇒ requires `--replace` + TUI confirm; old credentials stay active until the new ones succeed, then the connector
restarts on the new gen. Device flow: `action=begin` (`archetype=PersonalAgent`, `auth_method=client_secret`,
`request_user_info=open_id`), decorate `verification_uri_complete` (`from=sdk&tp=sdk&source=pi-toolkit&name=pi@<host>`); poll
honoring `interval` (+5 s on `slow_down`), brand switch on `tenant_brand`, hard stop at `expires_in` (≤600 s), every request 8 s.
`setup_cancel` fences the gen (late poll results discarded, nothing written). `fsb_res` carries only `{qrUrl, expiresAt, phase}` —
`device_code`, secret, token never leave the hub. Success ⇒ credentials (§4.4), owner allow-listed, `botInfo`, connector start,
welcome message. Agent renders the QR with `src/vendor/qrcodegen.ts` (Nayuki, MIT, header kept) as half-blocks + prints the URL,
polls `setup_status` every 2 s until done/expired/denied/Esc.
`reset` (confirm): `bot.stop()`, revoke all (§4.2), delete `credentials.json`, `state.json`, `staging/` by exact path, remind the user
to delete the app in Feishu.

## 10. Observability

Log prefix `web-hub feishu:`; audit `{phase:in|out|conn|cmd|setup, event, chatType, sender:hash8, decision, code, ms}`; 30-min stats
row; status shows the §1 status, gen, uptime, reconnects + last close reason, counters by reason, outbox ok/fail + last code,
bindings (offline/ambiguous), capabilities ✓/✗/?, keepalive line, masked owner/allow-list, coexistence warning. No bodies/JSON/paths.

## 11. Tests

**Fixtures** `tests/fixtures/feishu/`: `pbbp2-vectors.json` (§2.3); `fake-ws-server.ts` (test-only minimal RFC6455: handshake,
binary/close, scripted delays, drops, double connections); `fake-http.ts` (endpoint codes 0/1/514/403/1000040343/1000040350,
token, messages/reply/patch/reactions/resources/images/files, botInfo, registration incl. slow_down/brand switch; error injection
99991663, 230020, 230071, 99991672).
**Unit:** codec vectors both ways + malformed table; chunks limits/TTL/refusal; connector (fake clock): ACK only after durable
commit, gen fencing, liveness, clamps, pong reconfig, every bootstrap code, backoff/reset, `stop()` leaves no ref'd timer; admission
(allow/tenant re-read at dispatch, op restriction, shared `agent:` bucket); nonces (binding fields, one-shot, owner-only approvals);
request state machine incl. no auto-redispatch; debounce identity; attribution (consumed + anchor; interleaved TUI input; missing
link ⇒ unattributed); transfer follow; split by UTF-8 bytes; ask addressing/draft/reconcile/token reissue; uploads principal +
staging cleanup; outbound R-16 matrix; caps refuse; corrupt state ⇒ connector not started; credential file checks; setup gen/cancel/
replace; spawn `entry.ts` golden equivalence.
**Crash/race:** kill between `received` persist and ACK (redelivered ⇒ dedup), between `dispatching` and send, after send before
`accepted` (⇒ `uncertain`, no resend); web vs Feishu ask race; deny during debounce; reset during in-flight dispatch; supersede with
pending requests; two connections same app.
**Security:** stranger, other tenant, bot sender, forged/replayed/cross-chat nonce, non-owner Allow, origin not consulted.
**Starvation:** Feishu flood doesn't starve `/api/cmd` (shared per-agent bucket), preview/uploads/scrypt (existing starvation suite
extended).
**Keepalive:** off (feature absent ⇒ idle exit unchanged), configured with zero agents, `auth_failed`, reset ends it, startup
failure keeps status reachable, `/webhub stop` still stops.
**Integration** `tests/integration/web-hub-feishu-bot.test.ts` (real hub + fake Feishu + `fixtures/fake-rpc-pi.mjs`): FB1 p2p round
trip with label + reaction; FB2 `/list`→`/use`; FB3 two topics isolated; FB4 ask race; FB5 inbound image; FB6 outbound auto-image +
button; FB7 hub restart with proof-backed backfill and with missing proof; FB8 WS drop + redelivery dedup; FB9 `/new` ⇒ bind;
FB10 gate off ⇒ byte-identical hub.
**Real tenant:** `docs/dev/feishu-bot/acceptance.md` re-runs the F-probe checks against the finished bot.

## 12. Threat model

| #   | Threat                                                       | Mitigation / residual                                                                                                                 |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | allow-listed Feishu account compromised ⇒ local shell via pi | opt-in, owner-only default, live re-check at dispatch, `/new` known dirs + confirm; same class as a LAN password user — **accepted**  |
| T2  | strangers in tenant                                          | silent drop, owner-only approval with caps, body-less audit                                                                           |
| T3  | group members read agent output                              | @ + allow-listed sender only; no auto file send in groups; `allowGroups`                                                              |
| T4  | forged/replayed callbacks                                    | bound one-shot nonces, operator/chat/message/tenant match                                                                             |
| T5  | redelivery / replay                                          | durable receive-before-ACK, dedup, stale rule, deterministic cmdId/uuid, no auto-redispatch                                           |
| T6  | secret leakage                                               | 0600/0700 + type/owner/mode checks, memory-only token, redaction, destination allowlist, device_code never exposed                    |
| T7  | injected agent exfiltrates files                             | R-16: auto only p2p+images+cwd+attributed; else gated button re-checked; preview denylist — residual = preview U4 class, **accepted** |
| T8  | inbound file abuse                                           | caps, staging cap, sanitized names, UploadStore quotas/TTL                                                                            |
| T9  | same app on two machines                                     | `conn_limit` surfacing, host-named bot, docs                                                                                          |
| T10 | DoS / starvation                                             | per-sender/global/callback buckets, shared per-agent bucket, frame/chunk caps, refusing caps, bounded I/O                             |

## 13. Tenant facts (V#) — verified by F-probe BEFORE dependent packages

| V   | Question                                                                                   | Probe | Gates                              |
| --- | ------------------------------------------------------------------------------------------ | ----- | ---------------------------------- |
| V1  | PersonalAgent can bootstrap/connect long-conn                                              | P2    | everything                         |
| V2a | `im.message.receive_v1` subscribed by default                                              | P3    | F6+                                |
| V2b | `card.action.trigger` delivered by default (else which console switch)                     | P5    | ask buttons (text fallback always) |
| V3  | default scopes: reactions, image/file upload, resource download, group @                   | P6/P7 | §7, reactions                      |
| V4  | bot can join groups; topic groups work                                                     | P7    | §5.2 groups                        |
| V5  | PATCH of schema-2.0 cards needs `update_multi`                                             | P5    | §6.3                               |
| V6  | ACK shape accepted; `payload_encoding` values seen                                         | P2/P3 | §2.3                               |
| V7  | un-ACKed events redelivered to a NEW connection; delay/horizon; two live connections split | P4    | §2.4/§5.4/§5.8 dedup TTL           |
| V8  | `reply_in_thread` on a plain group message creates a topic + returns `thread_id`           | P7    | `groupRootTopics`                  |
| V9  | `Typing` emoji_type exists                                                                 | P6    | D2 reaction                        |
| V10 | `create_time` unit                                                                         | P3    | stale rule                         |
| V11 | bad-credential codes                                                                       | P8    | `auth_failed` mapping              |
| V12 | app visible to non-creators                                                                | P8    | meaning of `allow` (docs)          |

## 14. Packages (exclusive file domains, DAG)

**Sequencing (R1 #20):** packages touching `hub/hub.ts`, `hub/main.ts`, `hub/http.ts`, `agent/index.ts` start only after proxy
**X1c** has landed; **FA** is the single owner of all shared-assembly edits; other packages export factories only.

| Pkg         | Files (exclusive)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Depends                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| **F-probe** | `scripts/dev/feishu-probe.ts` (run by the USER via `npx tsx`, Node ≥22.4, no deps; steps P1 QR registration · P2 bootstrap+connect, record WS host/ClientConfig/pong · P3 receive+ACK, envelope/encoding/create_time · P4 no-ACK→reconnect redelivery, two connections · P5 card callback, ACK response, PATCH ± update_multi · P6 reactions, upload/send image+file, download · P7 group/topic/V8 · P8 bad creds, second user); writes a secrets-free JSON report to `~/.pi/agent/feishu-probe/`; `docs/dev/feishu-bot/probe-results.md` (filled from the report) | —                      |
| **F0**      | `protocol/feishu.ts` (limits, config, `fsb_*`, status wire); `protocol/messages.ts` (`fsb_req`/`fsb_res`, append-only); `protocol/version.ts` (`FSB_HUB_CAP`); `src/config/settings.ts` (`feishuBot` block) + tests                                                                                                                                                                                                                                                                                                                                                | F-probe                |
| **F1**      | `hub/feishu/frame.ts`, `chunks.ts`; `scripts/dev/feishu-vectors.ts`; `tests/fixtures/feishu/pbbp2-vectors.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | F0                     |
| **F2**      | `hub/feishu/http.ts`, `token.ts`, `api.ts`; `tests/fixtures/feishu/fake-http.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | F0                     |
| **F3**      | `hub/feishu/connector.ts`; `tests/fixtures/feishu/fake-ws-server.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | F1, F2                 |
| **F4**      | `hub/feishu/registration.ts`, `credentials.ts`, `state.ts` (stores, caps, group commit, corruption)                                                                                                                                                                                                                                                                                                                                                                                                                                                                | F2                     |
| **F5**      | `hub/spawn/entry.ts` (new), `hub/spawn/routes.ts` (refactor, golden-equivalent)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | — (before FA)          |
| **F6**      | `hub/feishu/admission.ts`, `inbound.ts`, `sessions.ts`, `router.ts`, `requests.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | F0, **F4**             |
| **F7**      | `hub/feishu/render.ts`, `split.ts`, `outbox.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | F2, F4                 |
| **F8**      | `hub/feishu/service.ts`, `runs.ts`, `dialogs.ts`, `files.ts`, `notify.ts` (factories, no hub.ts edits)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | F3, F5, F6, F7         |
| **FA**      | `hub/hub.ts` (construct, hoist shared `CmdLimit`, caps fold, `bot.stop()` first in every cleanup path), `hub/http.ts` (take the hoisted `CmdLimit` only), `hub/main.ts` (normalize), `hub/ports.ts` (`HubConfig.feishuBot`), `hub/idle.ts` (bot count), `hub/agent-server.ts` (`fsb_req`, caps), `agent/index.ts` (`buildHubConfig` only) + caps-coexist/keepalive tests                                                                                                                                                                                           | F8, **X1c landed**     |
| **F9**      | `src/commands/webhub.ts` (`feishu`), `agent/feishu-admin.ts`, `src/vendor/qrcodegen.ts`, `src/commands/qr-render.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                               | F0 (parallel to F1–F8) |
| **F10**     | `tests/integration/web-hub-feishu-bot.test.ts`; `docs/dev/feishu-bot/{acceptance,README}.md`; `AGENTS.md` (Feishu bot paragraph under web-hub); README settings table                                                                                                                                                                                                                                                                                                                                                                                              | FA, F9                 |

Parallelism: F1 ∥ F2 ∥ F5 ∥ F9 after F0; F4 then F6 ∥ F7; F8; FA; F10. Gates per package: format:check, typecheck, test; FA/F10 + build.
Probe-dependent scope cuts are decided from `probe-results.md` before F3 starts (e.g. V7 negative ⇒ redesign §2.4/§5.4 first).

## 15. Open questions

None.

## §R1 处置表 (review: gpt-6.1-sol, REVISE, 21 items — all adopted)

| #   | Review item                                                   | Change                                                                                                                                                                                  |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Delivery durability / ACK ordering                            | §5.4 durable `received→dispatching→accepted→replied` (+terminal states), `received` fsync'd before ACK via ≤100 ms group commit (§2.4); single shutdown policy (§1)                     |
| 2   | Uncertain effects / unknown encodings / cross-conn redelivery | §5.4 never auto-redispatch, boot `queryOnly` then [Resend]; §2.3 undecodable ⇒ durable record + `degraded` + owner notice; V7 gated by F-probe P4 before F3 (§13/§14)                   |
| 3   | Malformed frames, limits, fencing, timers                     | §2.3 frozen malformed table + aggregate chunk limits with refusal; §2.4 connection generations, clamped finite timers, liveness                                                         |
| 4   | Upstream pinning, fixtures, error codes                       | header + §2: node-sdk @ b188be6 pinned; §2.3 byte vectors from that commit (F1); §2.1 codes 514/403/1000040350/1/1000040343; pong reconfiguration §2.4                                  |
| 5   | Authorization before dispatch                                 | §4.1 admission adapter: live allow/tenant re-read, op allow-list, shared `agent:` bucket + sender/global/callback buckets; origin attribution-only (tested)                             |
| 6   | Nonce binding, approvals, revocation                          | §4.3 nonces bound to installGen/tenant/operator/chat/message/action; §4.2 owner-only approvals, re-checked at execution, global caps; deny/reset revoke queued work                     |
| 7   | Setup safety                                                  | §9 single setup gen, cancel fencing, `--replace` + confirm, device_code/secret never surfaced; §2.2 HTTPS destination allowlist; §4.4 credential file type/owner/mode checks            |
| 8   | Ambiguous sessionId                                           | §5.1 more than one live match ⇒ `ambiguous`, fail closed                                                                                                                                |
| 9   | Frozen routing, transfers                                     | §5.4 frozen `{sessionId, bindingRev}`, rev change ⇒ not sent; §5.6 transfers followed only on positive correlation, else `offline` + `/use`                                             |
| 10  | Debounce identity                                             | §5.5 merges only identical routing/identity context; deterministic batchId ⇒ cmdId                                                                                                      |
| 11  | Run attribution                                               | §5.6 `ctl consumed` + byte-equal user-message anchor; reply = assistant output up to the next user message/settle; `agent_end` fallback removed; never timing-based                     |
| 12  | Durable sends, eviction, backfill                             | §6.2 persisted per-part `uuid`; §5.8 finals never evicted (`reply-failed`); §5.6 backfill only with causal proof                                                                        |
| 13  | Topics & splitting                                            | §5.2 group-root topics gated on V8 + `groupRootTopics=false`; §6.2 never fall back outside a bound topic; §6.1 UTF-8 serialized-size split; truncated ⇒ "incomplete"                    |
| 14  | ask_user robustness                                           | §6.3 dialog short codes / explicit addressing, bounded draft (skip/Other/cancel), reconcile on reconnect/boot, nonce reissue after validation errors                                    |
| 15  | Upload principal & staging                                    | §7.1 one principal `feishu:<installGen>:<openId>` for begin/chunk/commit/abort/pin; bounded staging for unknown lengths; cleanup + boot sweep                                           |
| 16  | Outbound file bounds                                          | §0 R-16 ruling (to show the user) + §7.2: auto only p2p/images/cwd subtree/attributed; else re-checked gated button; `/file` explicit                                                   |
| 17  | Caps/TTL, corruption                                          | §5.8 cap table with refusal semantics; corrupt state ⇒ connector not started until `/webhub feishu repair`; credentials-unsafe degraded                                                 |
| 18  | Keepalive semantics/tests                                     | §1 explicit status machine + keepalive rules (stop/supersede/reset/startup failure); §11 keepalive tests                                                                                |
| 19  | feishu-notify coexistence                                     | §8 full trigger list, coexistence warning in setup/status, conservative background-idle evidence (fresh status, bashJobs present, fleet terminal)                                       |
| 20  | Sequencing & DAG                                              | §14: shared-assembly edits only in FA after proxy X1c; F6 depends on F4; F5 golden-equivalent HTTP/limits/audit                                                                         |
| 21  | Real-tenant probe first; trim; more tests                     | §14 F-probe (P1–P8) gates the rest (§13 table); §0 cut list (/watch, rich pickers, notify:all, history resume, ACK card responses); §11 crash/race/security/starvation/keepalive suites |

## §R2 主会话收口 (round-2 review r_VB6YNEVG: 11 closed, 10 partially/open — closed here by the main session, no third round)

These rulings **supersede** the conflicting sentences in §5.4/§5.6/§5.8/§2/§4/§6.3/§8/§9; implementers follow §R2 where they differ.

**R2-a Request token — the single identity anchor (#9, #11, #12).** Every dispatched prompt's first line is a bot header
`[飞书 · <sender display> · <chat label> · #<tok>]`, `tok = b64url(HMAC-SHA256(installSecret, cmdId))[0:12]` (installSecret: 32
random bytes in `state.json`, rotated on reset). The rest of the text is the batch body. Consequences:

- The dispatched text is unique per request, so the agent's existing text matching (`findDispatchedByText`, `dequeueByText`,
  idle-watch) becomes exclusive in practice: a TUI/web input can only collide by retyping the header incl. the token (local,
  trusted user — accepted residual). Feishu senders cannot spoof it: their body never starts the text.
- **Anchor** = a user `message_start` on the agentKey whose first text block **starts with this header line** (byte-equal header,
  body byte-equal too). `consumed` alone is never proof; `elsewhere()`-style consumption without an anchor ⇒ follow only per R2-b.
- **Session transfer (#9)** is followed ONLY when the token-bearing anchor appears under the new sessionId of the same agentKey
  (positive identity; topic-switch transfers carry the text verbatim). No anchor within 60 s ⇒ binding `offline(session-changed)`,
  ask `/use`. Byte-equal text without the token header never rebinds.
- Tests: identical body typed in TUI/web concurrently (no mis-attribution), same body sent twice from Feishu (two tokens, two
  replies), topic-switch transfer with anchor, TUI `/new` + same body without header (no rebind).

**R2-b Continuity, no snapshot backfill (#12).** Reply content is attributed only if the whole window anchor → `agent_settled` was
observed on ONE uninterrupted stream: same hub process, same agent connection generation, same sessionId/epoch, no `ev` gap
(sequence continuity on the per-agent stream). Any gap (hub restart, agent reconnect, dropped frames, epoch change) ⇒
`unattributed`: notice "已送达，结果无法确认归属 — 在 web 查看" + deep link to the session; no content. The §5.6 "hub-restart
backfill" paragraph is removed; idle snapshots are never proof.

**R2-c Durable payload (#1).** A `received` record stores the full batch payload, not a digest: body text ≤ 16 KiB UTF-8 (longer
inbound text is staged as a `.txt` upload attachment), ordered member message_ids, and committed+pinned upload ids. Recovery
rebuilds the exact dispatched text (header from the frozen fields). Payload is deleted on terminal state; terminal records keep
metadata only for 24 h. The byte budget (R2-f) is checked **before** persisting/ACKing; over budget ⇒ the event is ACKed with a
"队列已满，请稍后重发" reply (never silently dropped, never left un-ACKed to loop).

**R2-d Transport residuals (#3).** Disclosed residual: the platform WebSocket allocates a whole frame before our 1 MiB check
(bounded by Feishu's own frame limits). Physical sockets are bounded: at most 2 (current + one closing); a close not finished in
5 s is `terminate()`d; bootstrap/open/message callbacks carry the connection generation and are discarded when stale. Tests: stalled
close, late bootstrap completion after stop, repeated stop/start.

**R2-e Envelope consistency, setup ownership (#6, #7).** Every event/callback must carry `header.app_id === installed app_id` and a
tenant key equal to the pinned tenant across header/sender/operator fields that are present; mismatch ⇒ dropped + audit (no reply).
Setup/status/cancel/replace exist only as local TUI commands (`/webhub feishu …`, no web/LAN surface in v1) — the local admin is
the owner. `reset` bumps `setupGen`; a running poll re-checks `setupGen` immediately before committing credentials and aborts if
it changed.

**R2-f Complete caps (#17)** — added to §5.8's table: list generations 4 per chat / 10 min; debounce buffers 64 chats; ask_user
answer drafts 32 / 30 min; terminal request metadata 2 000 / 24 h. Admission computes the post-write size against the 4 MiB
budget before accepting durable work (R2-c), not at serialization time.

**R2-g ask_user text fallback (#14).** Text fallback is offered **only for single-question dialogs**; a multi-question dialog is
card-only (a text reply gets "请在卡片中作答"; if cards are unavailable: "请到 web 作答" + link). On reconnect, cards are not
expired until the agent's authoritative open-dialog list for that agentKey has arrived; if it doesn't within 30 s, cards are
patched to "状态未知 — 在 web 查看", never expired as answered.

**R2-h Notification evidence (#19).** A completion notification requires positive completeness evidence (fleet and bash
projections present, fresh and not truncated); unknown or truncated ⇒ the completion notice is suppressed (failed/waiting notices
unaffected).

| R1 # | Round 2   | Closed by |
| ---- | --------- | --------- |
| 1    | partially | R2-c      |
| 3    | partially | R2-d      |
| 6    | partially | R2-e      |
| 7    | partially | R2-e      |
| 9    | partially | R2-a      |
| 11   | open      | R2-a      |
| 12   | partially | R2-b      |
| 14   | partially | R2-g      |
| 17   | partially | R2-f      |
| 19   | partially | R2-h      |

**R2-i (2026-10-18, main-session ruling, from F1 upstream check).** Non-event data frames (e.g. `type=card`) are **not ACKed**,
matching pinned node-sdk b188be6 and the F-probe observation — this supersedes §2.3's "non-event data ⇒ ACK 200". Event headers:
last value wins; control `type` header: first wins; a duplicate fragment `seq` replaces the stored bytes (upstream
data-cache behaviour), still bounded by the chunk caps. F1 stays pure (codec + reassembly); ACK routing and undecodable
handling are F3's.

**R2-j (2026-10-18, main-session ruling, from F5 verification).** (1) With the default `feishuBot.spawnScope: "known"`,
`/new <dir>` on an unknown directory is **refused** with an explanation (「该目录不在已知目录中：先在终端/网页打开过它，或把
feishuBot.spawnScope 设为 roots」); the realpath confirm card exists only under `roots` (where `dirs.admit` returns
`known:false`). (2) The Feishu bot's supervisor principal must not be forgeable by a LAN username: FA forbids `:` in LAN
usernames (passwd/admin validation; existing users are unaffected unless they already contain `:`, which `/webhub status`
then flags), so `lan:feishu:<gen>:<openId>` can only come from the bot.

**R2-k (2026-10-18, main-session ruling after FA verifier r_5V38H7WY).** R2-j's command-ledger collision premise needs a
separate structural fix: numeric `lanIdentity().principal = u<id>` is NOT the same thing as the command router's
`lan:<origin.user>` idempotency principal. A legacy username such as `feishu:ou_x` must not share a ledger namespace with the
bot. FA uses `createFeishuCommandOrigin` to attach a private non-enumerable Symbol brand, read only by the HUB router's
`request` and `peekIdempotent` before serialization, yielding top-level `fsb:<installGen>:<openId>`. The ordinary origin fields
remain attribution only and serialize unchanged; HTTP/JSON cannot supply the brand. LAN principal derivation is unchanged.
No escaping, login/first-user warnings, DB enumeration or automatic migration is introduced; new colon-username creation is
still refused, existing users can rotate their passwords. This supersedes R2-j's warning/username-grammar explanation for
command-ledger isolation. Agent-side keying and command-id evidence are recorded in FA-report.md's verifier follow-up.

The same follow-up ruling accepts the existing agent process ledger's **cmdId-only** key: agent commands/ledger/index do not
derive an identity key from origin fields. Hashed bot ids and random browser ids have negligible accidental collision risk;
a LAN caller deliberately reusing a bot id is an authenticated user acting against their own bot (accepted T1/U1 threat
class). Structural cmdId disjointness is not required; F6/F8 id generators and agent wire/ledger code remain unchanged.
