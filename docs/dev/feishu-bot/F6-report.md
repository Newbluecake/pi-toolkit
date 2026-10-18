# F6 — inbound identity, admission, sessions and durable requests

Status: implemented, uncommitted. Factories only; no hub/HTTP/agent assembly or protocol edits. Scope: plan §4.1–4.3, §5.1–5.5, R2-a/c/e/j and the F6 package row. F7/F8 own rendering, outbox, attribution, files, dialogs and notifications.

## Files (absolute paths)

- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/admission.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/inbound.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/sessions.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/router.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/requests.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/hub/feishu/state.ts` — only the explicitly authorized additive request-state/context changes below.
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/admission.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/inbound.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/sessions.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/router.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/requests.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/hub/feishu/state.test.ts` — extend the pairwise matrix and serialization/corruption tests for those additions only.
- `/home/bluecake/ai/pi-toolkit/tests/fixtures/feishu/f6.ts`
- `/home/bluecake/ai/pi-toolkit/docs/dev/feishu-bot/F6-report.md`

No edits to `hub.ts`, `http.ts`, `cmd-limit.ts`, `agent-server.ts`, `protocol/feishu.ts`, F7 files, P0 files or unrelated concurrent changes. No commit/stash/checkout/reset.

## User rulings during implementation

1. **ACK must not wait for debounce.** Each platform message becomes a complete durable singleton `received` request, with event/message dedup, before ACK. On close, create the deterministic batch first and move its singleton members to the new terminal **`merged`**, carrying **`mergedBatchId`**, in the same synchronous mutation stretch and one commit. Never use `rejected(code:batched)` or emit a rejection for a merged member. Boot dispatches only unmerged `received` units; a persisted batch with merged members is the dispatch unit. Before close, a crash can lose batching but not payloads or idempotency.
2. **Approval cards use the existing nonce store.** Emit an owner-only approval intent; F8 sends a button-less placeholder, calls `inbound.attachApproval` with its actual chat/message coordinates, then PATCHes the returned `{n}` buttons. No pending/activation nonce state or frozen nonce-store change.
3. **Persist platform source time.** Add optional frozen `sourceCreatedAt` (normalized ms) to requests and strict parsing/serialization. `received` work without it expires fail-closed; recovery uses the exact platform age, not receipt time.
4. **Persist installation/tenant identity.** Add optional frozen `installGen` and `tenantKey`. Missing/mismatched context on `received` work rejects without dispatch; unresolved already-dispatching work remains uncertain without querying another installation. F8 must additionally clear pending requests/nonces on credential replacement.

The optional fields preserve parsing of legacy state files; malformed supplied values or malformed `merged` metadata make the state corrupt. `merged` requires a 64-hex destination, drops payload, frees the nonterminal slot, counts toward the existing terminal cap/TTL, has no outgoing transitions, and cannot be introduced by ordinary `patch()`.

## APIs / ports

### `sessions.ts`

`createFeishuSessions(source, now?)` takes normalized **`views()`**, **`managed()`**, and **`bindings()`** ports. FA/F8 maps `registry.list()` and `supervisor.records()` to them; the module does not import assembly or infer connection state from a stale card.

- `resolve(sessionId)` → exactly one live writable view `{ok:true, agentKey, view}`, otherwise `offline | ambiguous | read-only`.
- `rows()` → live sessions first, then offline bound sessions only. Label: `name ?? basename(cwd)` + six-character session prefix. States: busy/idle/waiting/read-only/offline/ambiguous; modes tui/rpc/managed.
- `list(chatId, senderOpenId)` → a numbered generation; four/chat, ten-minute TTL, refuse-at-cap; at most 256 chat generation tables. Defensive copies.
- `select(chatId, senderOpenId, selector)` → last **that sender's** unexpired numeric generation, exact id, unique id-prefix, or exact name. Ambiguous ids/names/process views fail closed. Selection freezes sessionId, never an agentKey.
- `clear()` on reset/stop.
- `feishuBindingKey(type, chatId, threadId?)`: `p2p:<chat>` or `grp:<chat>:<thread>`; no group-root key exists.

### `admission.ts`

`createFeishuAdmission({installation, state, sessions, limit, commands, deadlineMs?})`:

- `installation()` is a **live** credential projection `{appId,gen,ownerOpenId,botOpenId?,botUnionId?,installSecret,active}`. Never log it. `active:false` for stopped/reset/degraded-paused installations as appropriate.
- `commands` is `Pick<CommandRouter, "request" | "peekIdempotent" | "inflight">`; default command deadline 8 s. **Only this module calls `commands.request`.**
- `limit` is the existing structural `CmdLimit` port. **FA must hoist and inject the SAME instance used by HTTP**, not construct a bot-local limiter.
- `authorize(identity)` re-reads live gen/app/tenant/allow state.
- `resolve(sessionId)` exposes a side-effect-free precommit process cache; dispatch independently resolves again.
- `callback(identity)` performs live authorization plus the callback bucket before nonce redemption. For actions coming through inbound, F8 subsequently calls `dispatch` without `callback:true` (callback token already spent); direct callback dispatches can set it to charge that bucket there instead. Neither path skips sender/global/per-agent command admission.
- `dispatch({installGen,tenantKey,senderOpenId,id,sessionId,cmd,bindingKey?,bindingRev?,expectedAgentKey?,queryOnly?,callback?})` → router result or static refusal. It accepts **no origin port**; synthetic `{listener:lan,ip:feishu,user:feishu:<openId>,reqId:id}` is attribution only.

### `inbound.ts`

- `decodeFeishuEvent(raw, appId)` → normalized message/callback or a static drop reason. Schema 2.0, app id, header/sender/operator tenant and optional app evidence are checked; open_id only (`user_id:null` is irrelevant). Message time is normalized from 13-digit ms; callback header time from 16-digit µs. Topic thread ids and mention ids survive. Callback values must be **exactly `{n}`**; action/form fields are untrusted F8 data, never routing authority.
- `createFeishuInbound({state,installation,admission,allowGroups,staleMessageS,now,prepare,emit,audit?})`.
- `handle(raw)` → **`{ack:boolean,reason}`**. F3 must ACK iff `ack:true`; never unconditionally ACK its resolved promise. Unsupported events, including bot-added, ACK/drop via the commit barrier. Invalid identity/tenant evidence gets no reply. Groups require enabled + @-bot, including stale-notice paths. Strangers get no reply; only an owner approval intent, at most one/sender/24 h and 16 retained approvals.
- `prepare(message,identity)` is normally `router.prepare`. It may stage files asynchronously but must not execute/send before returning its `durable()` continuation. Inbound records both durable dedup keys only for authorized effect paths and awaits `state.commit()` before invoking the continuation. Effect-free drops use a separate evictable 1,024-entry/60-second memory cache, never durable dedup or authorized in-flight slots. In-flight authorized copies coalesce; a memory-only duplicate must also commit. A failed commit retains a bounded 256-entry/60-second continuation (lazy cleanup on handle/fire/stats); expiry emits a health signal. Boot recovery handles durable requests after an actual crash.
- `attachApproval({senderOpenId,chatId,messageId,installGen,tenantKey})` → committed `{allow:{n},ignore:{n}}` or refusal. Issue only after placeholder send; PATCH only after success. Nonces bind owner, tenant, install, card chat and message; redemption is one-shot. Allow re-reads owner, pending TTL and allow-list cap. Attachment persists both nonce ids (additive `approvals.ignoreNonce?`); repeated same-card attachment returns the same pair even after reload, moving a pending approval to another card refuses without issuing new nonces, and partial issuance rolls back its unexposed nonce.
- After Allow, the existing F4 `ignored` value is retained as a **closed throttle marker** until its original TTL (the allow-list is the authorization source). This prevents allow→deny churn from producing a second approval inside 24 h. The `approval-decided{allowed:true}` intent, not that internal marker name, drives the card's success display.
- Audit contains only enumerated event type, chat type, eight-character sender hash, message id and static reason. No body/content/action/credential/path logging.
- `onHealth` surfaces static `undecodable-events`, persistence, expiry/cap and caught-background-failure diagnostics. Unknown schema-2 shapes also increment the durable undecodable counter/ring before ACK. `stats()` lazily sweeps transient TTLs; `dispose()` fences deferred effects and clears transient tables.

### `router.ts`

`createFeishuRouter({state,sessions,requests,groupRootTopics,spawnScope,preparePayload?,emit})`:

- `prepare(message,identity)` handles first-line case-sensitive `/list`, `/use`, `/cur`, `/unbind`, `/help`, `/new`, `/file`. `//text` is literal `/text`; unknown slash forms produce help and never forward. `/new` supports JSON-quoted directories and an optional multiline first prompt.
- `/use` uses `bindings.set` (store-wide monotone rev), `/unbind` removes the pointer; pending work with the old rev will reject. Unbound plain messages are not held. Commands close any preceding debounce window without awaiting agent dispatch in the ACK path.
- `preparePayload(message,text,identity)` is F8's committed+pinned attachment port. Without it, non-text attachments refuse with a files notice and oversized text refuses with a staging notice; **never truncate**. Its output must include ordered unique source message ids and pinned upload ids. Request receive rechecks live installation/allow/tenant after the asynchronous staging. Revocation during staging is a silent drop, not a queue-full notice.
- Emits typed `notice | list | current | bound | new | file | open-topic` intents only from the postcommit continuation. No rendering, network API or spawn call lives here.
- Group-root opt-in emits `open-topic`; otherwise `use-topic`. `bindTopic({chatId,threadId,sessionId,label?})` takes the actual reply response's thread id, never a guessed id. Caller commits before treating it as bound.
- `/new` carries explicit F5 policy `{scope:spawnScope,confirm:unknown-dir}`. Exported `feishuNewDirectoryDecision(scope, known)` pins R2-j: unknown+known ⇒ refused, unknown+roots ⇒ confirm, known ⇒ create. F8 must preserve F5's authoritative admission outcome; it must not offer an unknown-dir confirm under `known`.

### `requests.ts`

`createFeishuRequests({state,installation,admission,clock?,debounceMs,staleMessageS,emit})`:

- `receive(input)` is synchronous memory-only; do **not** release/ACK until the caller's payload+dedup commit succeeds. Returns deterministic singleton record or store refusal. New receive rejects revoked senders or supplied stale install/tenant context.
- `release(id)` starts debounce after durability. Max 64 buffered chats; overflow bypasses batching and dispatches its already-durable singleton (no eviction/loss). Reset/stop: `dispose()` cancels all timers. Production timers use `systemFeishuClock` and are unref'd.
- `flushChat(chatId)` closes the buffer; do not await it in a platform ACK path. Context = binding key/rev, frozen session, sender, thread, install and tenant. Different context, a command, 20 attachments, body-size or 64-message ceiling closes a batch. Bodies retain receive order, joined with one newline; membership hashing uses JSON-framed **sorted** member ids. If an additional batch record cannot fit, dispatch durable singletons separately, never discard their bodies.
- `feishuBatchIdentity(ids)` → `batchId = hex(sha256(JSON.stringify(sortedIds)))`, `id = fs + b64url(sha256(batchId))[0:30]`. JSON framing avoids concatenation ambiguity. `feishuDigest` is SHA-256 UTF-8.
- `feishuRequestText(record, installSecret)` uses frozen display/chat/body and the **frozen protocol header formatter + F4 `computeRequestToken`**. Body cannot occupy the first line; identical bodies with different membership have different tokens.
- The process key and dispatch time are committed in `dispatching` **before** router effect. After that await, admission repeats live checks, binding/revision and unique session resolution; expected process identity also fences a process swap.
- `recover()` resumes `received` normally (exact body and source timestamp). `dispatching`/`uncertain`: at most one query-only attempt per pending id in this factory; never re-forward. Missing process identity, vanished process, unknown id, running/incomplete query or a throw remains uncertain. Only the authoritative inner `{op:query,state:ok|failed,result}` envelope may produce accepted/rejected. **Every outer refusal** (including `effect:none`, `E_HUB_RESTARTING`, `E_UNSUPPORTED`, `E_BAD_REQUEST`) remains uncertain: it describes the query, never the earlier prompt. An outer query `ok:true` is **not** acceptance. Recovered acceptance is **not attribution evidence**.
- `retryPending()` plus a one-second unref'd retry timer drains a bounded (256-item) failed-commit queue after the next successful commit. It can resume a batch or a `dispatching` unit **only when this factory knows the router has never been called**; already uncertain effects are never re-forwarded. Post-effect commit failures retry only the notification, not the command. `onHealth` signals persist/background/retry-cap failures; `pendingRetries` exposes the count. Disposal cancels retry timers.
- `resend(sourceId, callbackEventId, identity)` accepts only a sender-owned uncertain request in the same live frozen binding/install/tenant. A synthetic member `resend:<callbackEventId>` makes a new batch/cmd/token, idempotent for that callback. It copies the exact body/uploads, refreshes source time for the explicit user action, but does not dispatch. F8 must re-pin uploads, commit, then release the new id. Old uncertain work remains uncertain (its possible effect is not erased).
- `revokeSender(openId)` removes allow-list membership, purges buffered/received work and that operator's nonces, then commits; a request already `dispatching` is caught by the live authorization check before effect. There is no unbound-held queue to purge.

## State transition table

| From                                        | Event                                                                                       | To / action                                                    | Durability / emitted event                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| absent                                      | valid bound message                                                                         | singleton `received` + full payload + source context + dedup   | commit true before ACK; then release                                          |
| received members                            | close compatible batch                                                                      | new batch `received`; members terminal `merged{mergedBatchId}` | one synchronous mutation stretch, one commit; only `merged` bookkeeping event |
| received                                    | source stale/missing                                                                        | expired                                                        | commit, `expired(stale)` notice intent                                        |
| received                                    | old/missing install/tenant, offline/ambiguous, changed binding, denied sender, rate refusal | rejected; no effect                                            | commit, rejection intent; never auto-retry                                    |
| received                                    | eligible dispatch                                                                           | dispatching + process cache/time                               | commit; synchronous `dispatching{request,text}` before router call            |
| dispatching                                 | router ok                                                                                   | accepted                                                       | commit, `accepted`                                                            |
| dispatching                                 | effect none except deadline                                                                 | rejected                                                       | commit, rejection intent                                                      |
| dispatching                                 | effect unknown, deadline, throw                                                             | uncertain                                                      | commit, uncertainty intent                                                    |
| dispatching / uncertain on recovery         | authoritative done query result                                                             | accepted / rejected / uncertain according to embedded result   | queryOnly with same id/process, never forward                                 |
| dispatching / uncertain on recovery         | unknown/gone/running/incomplete/missing context                                             | uncertain                                                      | commit; user must explicitly resend                                           |
| received                                    | deny                                                                                        | revoked, payload deleted                                       | committed purge                                                               |
| uncertain                                   | sender-bound Resend click                                                                   | old remains uncertain; new received record                     | new batch/token; caller commits before release                                |
| accepted and later attribution/final states | F8 only                                                                                     | existing F4 transitions                                        | F6 does not claim attribution or render content                               |
| merged / other terminals                    | any dispatch/recovery                                                                       | no outgoing transition                                         | payload absent; existing terminal cap and 24h TTL                             |

## Admission matrix

All checks are synchronous immediately before `commands.request` (no intervening await). Admission itself never trusts synthetic origin fields.

| Gate                                                                            | Refusal / handling                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| installation absent, stopped, changed gen/app, state unavailable/persist-failed | installation-changed                                                                 |
| header/sender/operator evidence inconsistent                                    | drop/audit, no reply and no routing                                                  |
| tenant not pinned by owner or differs from live pin                             | no effect; unpinned stranger cannot trigger an approval                              |
| sender no longer allowed                                                        | sender-denied                                                                        |
| op not prompt(followUp)/dialog_answer/dialog_cancel                             | op-denied                                                                            |
| binding removed/offline, sid or rev differs                                     | binding-changed                                                                      |
| zero / multiple live views, read-only view                                      | offline / ambiguous / read-only                                                      |
| expected process differs after commit                                           | agent-changed                                                                        |
| hub in-flight ≥32                                                               | E_RATE                                                                               |
| shared `agent:<key>`                                                            | capacity 30; refill one/1000 ms (same HTTP bucket)                                   |
| `feishu:<openId>:cmd`                                                           | capacity 10; refill one/300 ms (10 per 3 s)                                          |
| `feishu:global`                                                                 | capacity 60; refill one/1000 ms                                                      |
| `feishu:cb`                                                                     | capacity 20; refill one/3000 ms; before nonce redemption or direct callback dispatch |
| exact `peekIdempotent(origin,agent,id,cmd)` hit                                 | no bucket spend, but still all live authorization/routing gates                      |
| nonce operator/chat/card/tenant/install/TTL mismatch                            | no action; a mismatch does not consume the real holder's nonce                       |

## Hand-offs

### F7

Consume typed notices/list/current/bound/approval events via F8 rendering; F6 never supplies pre-rendered card JSON or calls the outbox. Use request's frozen chat/thread/trigger message, never widen a topic reply. Terminal `merged` is **silent bookkeeping**, not a rejection/final. If necessary render a static code → prose dictionary in F8; do not echo untrusted form/action objects.

### F8

1. Subscribe to bus/sequence/epoch evidence before enabling inbound. Handle **`dispatching` synchronously** to install the attribution watcher before a very fast user anchor arrives; waiting for `accepted` is too late. `accepted.recovered:true` comes from query-only recovery, so cannot prove uninterrupted attribution and is not reaction-eligible. `accepted` itself is never reply-success proof. Preserve R2-a token and R2-b continuity rules in `runs.ts`.
2. Factory composition: live credential projection + `sessions` + shared-limit `admission` → `requests` → `router` → `inbound`. Connect F3 decoded event handler to `inbound.handle`; ACK only its `ack:true`. Run requests recovery after state/credentials/session directory are available; query failures must not become forwards.
3. `preparePayload` owns staged long-text `.txt`, downloads, upload commit/pin deadlines and the Feishu principal `feishu:<installGen>:<openId>`. Pins must survive debounce and attribution. Transfer member pin ownership to a merged batch; do not release them just because a singleton became `merged`. Re-pin before explicit resend. Observe late installation cancellation inside the staging service; F6 also checks it on receive and before effect.
4. Approval intent goes only to `ownerOpenId` as p2p. Obtain the actual owner-chat/card coordinates; send a placeholder → `attachApproval` → PATCH returned `{n}` buttons. At nonce cap use text fallback. F2's send projection does not expose `chat_id`; retain the owner p2p chat from inbound events (or obtain an authoritative coordinate in F8), never assume a group chat or an open_id is a chat_id. Generic `action` intent includes the server nonce record plus untrusted form/select data; F8 validates the action schema and restricts dispatch to the admission port. Inbound has already charged the callback bucket; omit `callback:true` on that subsequent dispatch to avoid double charging.
5. `/new` intent goes through F5 `startFresh`, explicit spawn scope and exact gen-qualified bot principal; only roots may yield unknown-dir confirmation. **R2-j refusal text is F8's rendering hand-off:** 「该目录不在已知目录中：先在终端/网页打开过它，或把 feishuBot.spawnScope 设为 roots」. F5 already refuses it through `dirs.admit`; do not turn that refusal into a confirm card. Nonces/confirmation/relaunch/binding of a newly live spawn belong to F8. A `/new` first prompt must receive the same token-bearing request treatment before attribution; F6 does not invent a sessionId before spawn resolves it.
6. On group-root intent, use `reply_in_thread:true`, require the actual returned thread id, then bind/commit it. Never send agent output outside that topic. On deny call `requests.revokeSender`; on reset/replace dispose factories, clear pending/nonces and list generations, then recreate with the new live generation.
7. All `emit`/`durable` sinks are synchronous nonthrowing ownership transfers. Start and track asynchronous outbox/spawn/file work in F8; do not await it in inbound's ACK continuation. Local administrative/list/approval response intents are not a durable outbox by themselves: F8 owns durable enqueue. A crash after request/dedup commit but before a local command intent is enqueued can lose that command response/effect; it cannot cause automatic uncertain prompt re-forward. Persist any stronger `/new`/card action execution guarantee in F8's orchestration before treating it as accepted.

### FA

Hoist the **shared CmdLimit** once and pass it to HTTP, existing spawn entry and `createFeishuAdmission`. Map registry/supervisor into normalized directory ports; wire status/lifecycle to `installation.active`. No hoist, capability advertisement, sockets, disk lifecycle, API client or listener was added here. Keep synthetic command origin attribution separate from F5's gen-qualified supervisor principal; preserve the R2-j LAN username `:` exclusion in FA's admin validation.

## Verification

- `timeout 280 npm run typecheck` — passed (all three stages).
- `timeout 280 npm run build` — passed.
- `timeout 120 npx vitest run tests/web-hub/hub/feishu/{admission,inbound,sessions,router,requests,state}.test.ts tests/web-hub/boundary.test.ts` — passed: 7 files, 209 tests (117 in the five new F6 suites; state 81; boundary 11).
- `timeout 400 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts` — **final passed: 17 files, 922 tests**, including F7's completed outbox suite (48). An earlier in-flight F7 snapshot had 35 outbox failures; the owning agent resolved them, without F6 editing its files.
- `timeout 60 npx prettier --check` over the 14 files listed above — passed.
- `git diff --check -- <F6 paths>` — passed.
- Final typecheck/build rerun immediately before the 922-test gate — passed.

No real tenant/network acceptance was attempted by F6. F8/FA assembly and live Feishu acceptance remain downstream work; no running bot is claimed by this factory package.

## Rework after r_7ZQCJ4W7

All F6 findings were addressed; item 7 remains an explicit F8 rendering hand-off, not a change to F5/F7. No F7 files were edited. The only extra frozen-store change is append-only **`FeishuApproval.ignoreNonce?`**, its optional attach field, strict parse/serialization and cleanup on decision, needed for restart-safe nonce-pair idempotency. Existing methods and legacy records remain compatible.

| Finding                                                       | Fix                                                                                                                                                                                                                                                                                                                                                                                                                        | Regression evidence                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — BLOCKER, outer query failure misreported as failed prompt | Query-only outer admission/router failures always remain uncertain regardless of effect. Only a structurally consistent authoritative inner done result can be adopted.                                                                                                                                                                                                                                                    | `requests.test.ts`: parameterized E_HUB_RESTARTING / E_UNSUPPORTED / E_BAD_REQUEST outer-none failures remain uncertain, no rejection event, one query only. Existing ok/failed/running/incomplete inner-envelope cases remain pinned.                                                                                                       |
| 2 — MAJOR, unauthorized dedup exhaustion                      | Added `FeishuDropCache`: evictable, 1,024 entries, 60-second TTL, consulted only after current authorization/addressing classification. Stranger/no-@/non-user/stale-without-notice/invalid nonce drops never write durable dedup. Only authorized effect paths reserve durable keys. Unauthorized events never occupy the authorized in-flight cap either.                                                                | `inbound.test.ts`: **20,000** same-tenant messages from one stranger use zero durable slots; a following owner message ACKs with exactly its two keys. Concurrent 600-message stranger flood also cannot block owner admission. No-@/non-user/stale drops, eviction/expiry, and a newly allowed sender bypassing its old cache are asserted. |
| 3 — deferred continuation lifetime                            | Explicit 256-entry bound and 60-second TTL; handle/fire/stats lazily purge expired continuations and signal `pending-expired`. Dispose clears both memory classes. There is no ref'd cleanup interval.                                                                                                                                                                                                                     | `inbound.test.ts`: commit-failed continuation is counted, expires at its deadline, reports degraded, cannot run after expiry, and does not block a later owner message. A separate regression fills all 256 continuation slots and asserts explicit refusal and subsequent TTL cleanup.                                                      |
| 4 — failed commit silently parks runtime work                 | Request engine emits static persistence health and retains a bounded retry action, driven by a one-second unref'd timer or `retryPending()` after commit heals. A pre-forward retry carries process-local proof of **no router call yet** and rechecks all live gates. Batches resume as their durable unit. Failed commits after router effect only replay notification; uncertain command effects never auto-redispatch. | `requests.test.ts`: failed dispatching commit reports degradation then forwards exactly once after healing; failed batch commit resumes without restart; denial during parking prevents effects; uncertain result notification retry does not call the router again; dispose removes the retry timer/queue.                                  |
| 5 — schema drift silently ACKed                               | Unknown recognized-envelope shapes record durable undecodable evidence and signal `undecodable-events` with enumerated event type/reason only, then commit before ACK. App/tenant security mismatches remain no-reply security drops; intentionally unsupported subscriptions remain ordinary drops.                                                                                                                       | `inbound.test.ts`: unseen `topic_group` increments counter/ring, emits degraded event with eventType/code, exposes no body in diagnostics, and uses no durable dedup slots.                                                                                                                                                                  |
| 6 — header-only prompts                                       | Empty/whitespace source text and empty prepared payload bodies return a short `usage` intent. Bare @bot is treated the same; no request is created.                                                                                                                                                                                                                                                                        | `router.test.ts`: empty, spaces, newline/tab, bare @bot in a bound topic, and a staging port returning whitespace all create usage hints with no command effect.                                                                                                                                                                             |
| 7 — HAND-OFF, R2-j prose                                      | Added exact refusal explanation above to F8 hand-offs. F5 already refuses unknown directories in known scope.                                                                                                                                                                                                                                                                                                              | No F6 production change required. Existing scope-decision regression remains in `router.test.ts`.                                                                                                                                                                                                                                            |
| 8a — staged revocation gives queue-full                       | Router returns a silent `drop` result after live post-staging authorization fails; inbound neither emits queue pressure nor writes durable dedup.                                                                                                                                                                                                                                                                          | `router.test.ts`: revoke sender while payload staging awaits, then finish staging — silent ACK/drop, no notice, request or durable dedup. F8 must release unused staged pins on this discard.                                                                                                                                                |
| 8b — detached promises without catches                        | Every detached close/dispatch/retry/flush/cleanup promise has a catch that reports a static health reason; no raw error is logged. Health-sink failures themselves are isolated.                                                                                                                                                                                                                                           | `requests.test.ts`: thrown detached resolution reports background-failed without unhandled rejection or error text. `router.test.ts`: rejected detached flush reaches a static diagnostic, without leaking the injected path/message.                                                                                                        |
| 8c — duplicate approval attachment leaves nonce               | Persist both pair ids, return same-card pair idempotently (including concurrent calls/reload), refuse other-card reattachment, roll back partial unexposed pair issuance.                                                                                                                                                                                                                                                  | `inbound.test.ts`: concurrent repeated attach, alternate-card refusal, real state reload, and partial-issuance rollback. `state.test.ts`: strict malformed-pair rejection, round-trip and pair-field cleanup on decision.                                                                                                                    |

### Additional F8/FA wiring requirements after rework

- Wire `requests.onHealth`, `inbound.onHealth`, and `router.onHealth` to the service's static diagnostics/log/status handling. `undecodable-events` maps to that existing degraded reason; persistence failure maps to existing persistence health. Do not expand the frozen wire status vocabulary merely for diagnostic reasons such as `pending-expired` or `background-failed`.
- On healed persistence, F8 may call `requests.retryPending()` (the default one-shot retry timer already handles it). On an expired initial inbound continuation, warn and run tracked `requests.recover()` for its durable request backlog; never re-run a consumed card action by timing alone. Generic card/command orchestration still belongs to F8.
- Drop-cache entries are not security state and may be evicted without consequence. Durable approval per-sender/24h and global 16 caps remain the source of stranger-card rate control; allowing a sender takes effect immediately even if its old drop cache entry exists.
- R2-j refusal prose and staged-upload pin release are explicit F8 hand-offs as above.

### Rework verification

- `timeout 280 npm run typecheck` — passed; no transient consult-cache-marker diagnostic was present in the final run.
- `timeout 400 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts` — **17 files / 961 tests passed**, including F7's concurrent suites. The 20k-flood regression completed in about 1.3 s.
- Targeted F6/state/boundary suites now contain **234 tests** (141 in the five F6 suites, state 82, boundary 11).
- `timeout 280 npm run build` — passed.
- `timeout 60 npx prettier --check` over all F6 paths — passed.
- Scoped `git diff --check` — passed.
