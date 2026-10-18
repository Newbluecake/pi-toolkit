# F4 report — credentials, state.json, device-flow registration

Package F4 of `docs/dev/feishu-bot/plan.md` (§4.4, §5.4+§R2-c, §5.8+§R2-f, §9+§R2-e, R2-i/R2-j). Pi-free, hub-boundary clean
(`tests/web-hub/boundary.test.ts` green). No frozen file (`protocol/feishu.ts`) was changed — every constant used was already there.

## Files

New (all under `/home/bluecake/ai/pi-toolkit`):

- `src/web-hub/hub/feishu/credentials.ts` — private-file primitives + credential store
- `src/web-hub/hub/feishu/state.ts` — `state.json` stores, caps, group commit, corruption/repair
- `src/web-hub/hub/feishu/registration.ts` — device-flow setup state machine
- `tests/web-hub/hub/feishu/credentials.test.ts` (36), `state.test.ts` (73), `registration.test.ts` (48)

## APIs

### credentials.ts

| Export                                                                                      | Contract                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCredentialStore({dir, fs?, clock?, random?})`                                        | `dir` = `<stateDir>/feishu-bot`. `load()` (never creates/writes) → `absent \| loaded \| unsafe{check}`; `status()`, `unsafeCheck()`, `current()` (copy), `tokenCredentials()` (= `createTokenManager({credentials})` shape, `gen: number`), `secrets()` (= `createFeishuHttp({secrets})`) |
| `commit(input, {guard?})`                                                                   | atomic install; mints `gen`, `installSecret`, `createdAt`; serialized on one chain; `guard()` runs before the write AND synchronously right before the rename; `{ok:false, reason: guard\|unsafe\|invalid\|dir\|write-failed}`; memory changes only after the write landed                |
| `setBotOpenId(gen, openId)` / `remove()`                                                    | gen-pinned botInfo write-back / reset (unlinks by exact path — works on an unsafe symlink without following it)                                                                                                                                                                           |
| `computeRequestToken(installSecret, cmdId)`                                                 | §R2-a `b64url(HMAC-SHA256)[0:12]` — one shared definition for F6                                                                                                                                                                                                                          |
| `parseCredentials`, `validateCredentialInput`                                               | strict validators (unknown key ⇒ invalid)                                                                                                                                                                                                                                                 |
| `ensurePrivateDir`, `readPrivateFile`, `writeFileAtomicPrivate`, `FeishuFs`, `realFeishuFs` | shared primitives (state.ts uses them; F7/F8 staging may too). fs seam wraps `node:fs/promises` for failure injection                                                                                                                                                                     |

File: dir 0700 (a looser dir we own is tightened, foreign owner/symlink ⇒ unsafe), file 0600, ≤4 KiB, `lstat` regular/no symlink/uid/mode/size, re-checked on the `O_NOFOLLOW` fd with dev/ino identity, strict schema
`{v:1,brand,appId,appSecret,ownerOpenId,botOpenId?,createdAt,gen,installSecret}`. Atomic write = unlink stale `.tmp` → `O_EXCL|O_NOFOLLOW` 0600 → write → fsync → guard → rename → dir fsync (best effort).
`unsafe` ⇒ `degraded(credentials-unsafe)` for F8; `commit` is refused (never auto-overwritten) until `reset`'s `remove()`.

**Deviation (flag for the plan author):** `installSecret` lives in `credentials.json` (task text), not in `state.json` as §R2-a words it. Consequences: `reset` deletes it (rotation for free), `--replace` mints a new one with the new gen,
`repair` (state-only) keeps it. Tokens are recomputed from frozen request fields, so nothing in R2-a breaks.
`gen` is `max(clock.now(), lastGen+1)` (number, strictly increasing in-process incl. across reset, epoch-ms across restarts) — matches `TokenCredentials.gen`.

### registration.ts

`createRegistration({fetch?, clock?, hostname?, credentialsState, commit, log?, requestTimeoutMs?})`.

- `begin({replace?, confirm?})` → `{ok:true, view, adopted}` | `{ok:false, refused, failure?}`; refusals `confirm-required | exists | credentials-unsafe | active-conflict | begin-failed | cancelled | disposed`, `refusalToFsbCode()` maps them into the closed `E_FSB_*` vocabulary (`exists`/`confirm-required` ⇒ `E_FSB_CONFIRM_REQUIRED`, `active-conflict` ⇒ `E_FSB_SETUP_ACTIVE`, others ⇒ `E_FSB_STATE`).
- `status()` → `FsbSetupView | undefined` (exactly `{phase, qrUrl?, expiresAt?}`; `qrUrl` only while `pending`); `diagnostic()` (static local reason, brand, setupGen); `cancel()`; `fence()` (reset); `dispose()`; `setupGen`, `active`.
- Pure helpers exported + tested: `classifyPollResponse`, `decorateQrUrl`, `clampPollInterval`, `clampExpiresIn`.
- `commit(input, guard)` is the service's hook (F8): `credentials.commit(input, {guard})` + `botInfo` + `state.adoptInstall` + allow-list + connector start; it MUST honour `guard`.

Probe P1 semantics reproduced exactly: form POST to `accounts.feishu.cn|larksuite.com` only; HTTP-400 `authorization_pending`/`slow_down` are normal; `slow_down` +5 s (cap 600); `{}` ⇒ keep polling; `tenant_brand` switch re-polls immediately on the other origin with the same device code; partial credentials and credentials+error rejected; interval 1..60, `expires_in` 1..600, hard stop at expiry, per-request `min(8 s, remaining)`, ≤64 KiB bodies, `redirect:"error"`, ≤4 consecutive transient failures (network/timeout/5xx/429).
Small hardening over the probe: credentials + ANY error ⇒ failed (probe tolerated pending+credentials); a stated `tenant_brand` on the success body overrides the polled brand (a lark tenant is never stored as feishu — unverified live, the probe only saw feishu).
Setup ownership: one `setupGen`; every poll answer/commit re-checks `run === r && gen === setupGen && phase===pending`, the expiry is re-checked, and the same predicate is the commit `guard`. `device_code`/secret never leave the closure (views, diagnostics, logs and returns are asserted free of them, on success AND failure runs).
Mutation check: deleting the expiry recheck fails the "lands after the deadline" test; the `gen` clause in `current()` is belt-and-braces (cancel/fence also change phase/run), so removing only it is not caught — no public path bumps the gen without ending the run.

### state.ts

`createFeishuState({dir, fs?, clock?, random?, groupCommitMs?, commitDeadlineMs?, retryMs?, onHealth?, log?})`.

Lifecycle: `load()` → `fresh | loaded | corrupt{reason, backedUp}`; `phase()` (`unloaded|ok|corrupt`), `connectorMayStart()`, `degradedReasons()` (`state-corrupt`, `persist-failed`), `commit()`, `flush(budget?)`, `sweep()`, `usage()`, `adoptInstall({appId, ownerOpenId})`, `repair(...)`, `destroy()`, `dispose()`.
Stores (all mutators are synchronous in-memory; reads return copies; every mutator returns `Admit<T>` = `{ok:true,value} | {ok:false, refused: cap|budget|exists|invalid|unavailable|payload-too-large|recent}`):

| Store         | API                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`      | `get()`, `pin(key)` → `pinned\|same\|mismatch\|invalid\|unavailable` (TOFU)                                                                                |
| `allowList`   | `list/has/add/remove/size`                                                                                                                                 |
| `dedup`       | `keyFor("event"\|"message", id)` → `e:`/`m:` key, `has`, `add`                                                                                             |
| `requests`    | `receive(NewRequestInput)`, `get`, `list({states?,senderOpenId?})`, `transition(id,to,patch?)`, `patch`, `revokeSender(openId)`, `nonTerminal`, `terminal` |
| `bindings`    | `get/list/set(key,input)/remove/size` — `rev` = store-wide counter, strictly increases on every change and across remove/recreate                          |
| `dialogCards` | `add/get/list/update/remove/size`                                                                                                                          |
| `nonces`      | `issue(input, ttl?)` (16 random bytes b64url), `get`, `redeem(ctx)` (one-shot; field mismatch does NOT consume), `purgeOperator`, `size`                   |
| `approvals`   | `ask(sender, display)` (`recent` ≤1/24 h), `get/list/attach/resolve("allowed"\|"ignored")`                                                                 |
| `outbox`      | `add/get/list/update/remove/size` (`sent`/`failed` drop `content`)                                                                                         |
| `undecodable` | `record`, `snapshot`, `noticeDue` (≤1/h), `markNotice` — §2.3 durable `undecodable` record                                                                 |

Request record = §R2-c: frozen routing fields (`sessionId, bindingKey, bindingRev, senderOpenId, senderDisplay, chatLabel, chatId, chatType, threadId?, triggerMessageId, batchId, textDigest`) + durable `payload {body ≤16 KiB UTF-8, messageIds ≤64, uploadIds ≤20}` (deleted on any terminal state) + `agentKey?, dispatchedAt?, code?, reactionId?`. `id` = cmdId.
`REQUEST_TRANSITIONS` is the §5.4 graph (`received→dispatching|rejected|revoked|expired`, `dispatching→accepted|rejected|uncertain`, `accepted→replied|reply-failed|unattributed|expired|rejected`, `uncertain→accepted|rejected|replied|reply-failed|unattributed|expired`; terminal states have none; pinned pair-by-pair in the tests).

### Caps table (all enforced; refuse-at-cap, nothing evicted unless noted)

| Store                                              | Cap / TTL                                                              | At cap                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| allow-list                                         | 32                                                                     | `cap`                                                                                                                                |
| dedup                                              | 16 384 / 72 h                                                          | `cap` (expired entries are reclaimed first — not security state)                                                                     |
| requests non-terminal                              | 256                                                                    | `cap`                                                                                                                                |
| terminal request metadata                          | 2 000 / 24 h                                                           | **oldest evicted** (the one documented exception — a terminal transition can never be refused; dedup, not this, is the replay guard) |
| bindings                                           | 256                                                                    | `cap` for a new key (updates still work)                                                                                             |
| dialog cards                                       | 64 / 24 h                                                              | `cap`                                                                                                                                |
| nonces                                             | 512 / ≤24 h                                                            | `cap`                                                                                                                                |
| approvals                                          | 16 / 24 h (decided `ignored` entries stay as the 24 h gate)            | `cap`, `recent`                                                                                                                      |
| outbox parts                                       | 512; notices stop at 448 (64 slots reserved for `final`)               | `cap` (finals ⇒ F7 marks `reply-failed`); settled (`sent`/`failed`) parts expire after 1 h, queued parts never                       |
| undecodable ring                                   | 16 entries                                                             | oldest diagnostic entry rotates (count keeps counting)                                                                               |
| `state.json` bytes                                 | 4 MiB                                                                  | `budget` refusal BEFORE persisting: `tracked + delta + reserve > 4 MiB`, reserve = 32 KiB + 1 KiB × non-terminal requests            |
| list generations / debounce / ask drafts / staging | caps are in `FEISHU_CAPS` but these are in-memory/FS concerns of F6/F8 | not part of `state.json` — F4 does not store them                                                                                    |

Byte ledger: each entry costs exactly `utf8(JSON(key)) + utf8(JSON(value)) + 2` (its member in the compact document), envelope fixed at 4 KiB. Tests pin `file size ≤ ledger ≤ budget` after (a) 16 KiB bodies to the budget refusal + max-size growth patches on every record, (b) JSON-escape-heavy bodies (budget counts serialized bytes, ~6× for control chars), (c) every store at cap with max-size entries.

## Group commit / ACK barrier (what F3/F6 must do)

- Mutations are memory-first; the first one arms an unref'd timer (`FEISHU_ACK.groupCommitMs` = 100 ms); all mutations before the write starts ride one fsync'd write.
- `await state.commit()` → `true` ⇒ everything applied before the call is durable. `false` ⇒ write failed OR not durable within 1.5 s ⇒ **do not ACK**; `onHealth({persistFailed:true})` fires (connector pause + `degraded(persist-failed)`), writes retry every 1 s and `onHealth({persistFailed:false})` resumes.
- **A duplicate (`dedup.has`) must also `await commit()` before its ACK** — the first copy's `received` record may still be memory-only.
- `requests.transition(…,"dispatching")` must be committed before `commandRouter.request`.
- Shutdown step 5: `await state.flush()` (≤1 s default).

## Crash / durability matrix

| Kill point                                                     | On-disk result                                                           | Recovery (tested)                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| after `receive()`, before group commit fires                   | not durable, never ACKed                                                 | redelivery re-creates it (`boot.requests.get` undefined, `receive` ok)                                        |
| after `received` durable, before ACK                           | `received` + dedup + payload on disk                                     | redelivery is a duplicate; request recovered with its exact payload                                           |
| `dispatching` durable, `accepted` not                          | `dispatching` with `agentKey`/`dispatchedAt`                             | recovers as `dispatching` ⇒ F6 `queryOnly`, never auto-redispatch                                             |
| mid-write (partial `state.json.tmp`)                           | live file untouched                                                      | next boot loads the live file; next write unlinks the stale tmp first                                         |
| I/O error at open / write / fsync / rename                     | previous file byte-identical, tmp removed                                | `commit()` false, `persist-failed`, retry heals (tested at all four stages)                                   |
| write hangs                                                    | —                                                                        | `commit()` false at 1.5 s, `persist-failed`, clears when the write lands                                      |
| `state.json` garbage / bad schema / over caps / oversize       | file left in place, `.bak` copy (when safely readable)                   | `corrupt`, `connectorMayStart()=false`, mutators `unavailable`; **every boot corrupt again until `repair()`** |
| `state.json` symlink / mode ≠ 0600 / foreign owner             | corrupt, no `.bak`, target never followed                                | `repair()` replaces a symlink by a regular file, link target untouched                                        |
| `credentials.json` unsafe (symlink/mode/owner/size/schema/dir) | untouched                                                                | status `unsafe`, `commit` refused; `remove()` (reset) unlinks without following                               |
| reset racing setup commit                                      | `fence()` waits for a commit past the guard; store chain then `remove()` | no credential survives reset                                                                                  |
| `destroy()` racing an in-flight write                          | writer stops at its next phase check; state/bak/tmp unlinked             | nothing left behind                                                                                           |

## Hand-off

**F6 (admission/requests/sessions):** use `state.requests` as the durable request table (key = cmdId); build the dispatched text from the frozen fields + `payload.body` (header via `formatRequestHeader` + `computeRequestToken(credentials.installSecret, id)`); `receive` → `await commit()` → ACK; `transition(..."dispatching")` → `await commit()` → router. `bindings.set` for `/use`/`/unbind` (`rev` from the returned binding is what a request freezes). `nonces.redeem` already enforces operator/chat/message/tenant/gen one-shot semantics (admission still owns the live allow/tenant re-read). `revokeSender` + `nonces.purgeOperator` for `deny`. `tenant.pin` for TOFU (R2-e header/sender/operator consistency is F6's).
**F7 (outbox/render):** `state.outbox` stores `{sendId, kind final|notice, route, targetId, msgType, content ≤20 000 B, attempts, state}`; use `sendId` as the Feishu `uuid`; `update(...,{state:"sent"|"failed"})` drops the content; `remove` when done. Finals have 64 reserved slots; `cap` on a final ⇒ mark the request `reply-failed`.
**F8 (service/dialogs/files/notify):** wiring order at start: `credentials.load()` → (`unsafe` ⇒ `degraded(credentials-unsafe)`, no connector) → `state.load()` (`corrupt` ⇒ `degraded(state-corrupt)`, no connector, `/webhub feishu repair`) → `state.adoptInstall({appId, ownerOpenId})` → connector. Registration `commit` hook = `credentials.commit(input,{guard})` → `state.adoptInstall` (wipes per-app state when the appId changed) → `credentials.setBotOpenId` after `botInfo` → start connector; welcome message. `onHealth` ⇒ pause/resume connector + status. `dialogCards` caps/TTL are stored here; F8 must PATCH-expire cards before their 24 h `expiresAt` (sweep deletes them silently). Staging bytes (100 MiB) are NOT tracked by F4. Undecodable events: `undecodable.record` → `await commit()` → ACK, and use `noticeDue/markNotice` for the ≤1/h owner notice. `reset` = `registration.fence()` → `connector.stop()` → `credentials.remove()` → `state.destroy()` → staging dir removal (F8) — `destroy()` also removes `state.json.bak` (it holds message bodies).
**FA:** nothing to assemble from F4 except constructing the three factories with `dir = join(stateDir, "feishu-bot")`; `degradedReasons()`/`credentials.status()` feed the status machine; `keepalive` = `credentials.status() === "loaded" || "unsafe"` (status ≠ off/unconfigured).
**F9/agent side:** `FsbSetupView` is what `registration.status()` returns verbatim; `begin` refusals map through `refusalToFsbCode`.

## Self-verification

- `timeout 280 npm run typecheck` — clean (all three projects).
- `timeout 400 npx vitest run tests/web-hub/hub/feishu tests/web-hub/boundary.test.ts` — 9 files, 616 tests green (F4: 157).
- `npx prettier --check` on all six F4 files — clean.

## Residuals / notes

- Multi-byte-heavy dedup ids are not a concern (ids are validated `[A-Za-z0-9_.:-]{1,100}`); other id-like fields accept any control-free text ≤256 B.
- A `commit()` that times out (1.5 s) flips `persist-failed` even though the write may still land; the flag clears automatically on that write.
- `destroy()` leaves the state object reusable (`unloaded` → `load()` is fresh); `dispose()` is final.
- The success-body `tenant_brand` override and the "success + any error ⇒ failed" strictness are not covered by the live probe (probe saw a feishu tenant only).
