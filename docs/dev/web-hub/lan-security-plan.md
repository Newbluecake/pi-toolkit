# web-hub LAN security hardening: implementation plan r2 (2026-10-19)

Status: plan, not built yet. **r2 closes all 15 r1 findings** (`lan-security-review-r1.md`; disposition table in §12). Scope and
user rulings are unchanged; they are recorded verbatim at the end of this file.

Scope:

1. Client IP allowlist (§2).
2. Feishu high-risk alerts (§4).
3. LAN login session management (§3).
4. Second factor for logins from a new IP: TOTP or Feishu approval, with recovery codes as fallback (§5).

Out of scope: HTTPS. Threat model: other hosts/accounts on the same LAN/VPN, and a leaked cookie from the owner's device.
Path prefixes `hub/…`, `agent/…`, `protocol/…`, `ui/…` are relative to `src/web-hub/`.

## 0. Verified facts this plan relies on

- **LAN listener.** Binds `0.0.0.0` (`hub/http.ts:190`), so peers are IPv4 only.
  - `connection` hook → `connGuard.admit` (`:604-617`); the request goes through `buildContext` (`:618-640`, `:494-536`).
  - No `upgrade` handler on this listener.
- **Proxy resolution.** Trusted-proxy XFF via `resolveProxy` (`hub/proxy.ts:28-94`). Warnings: `xff-missing`, `xff-malformed`,
  `xff-all-trusted`. A direct peer's forged XFF never changes `clientIp` (verified r1).
- **Proxy listener.** Its `connection` hook (`hub/proxy/listener.ts:101-128`) runs before both `request` and `upgrade` (`:279`).
  Binds `0.0.0.0` when LAN is on (`protocol/proxy.ts:107`). Open result fields: `outcome.result.target` host/port
  (`hub/proxy/service.ts:439-445`). Never the raw URL or the enter code.
- **DB.** v1 schema `hub/db.ts:38-55`.
  - Maintenance refuses structural corruption (`hub/db-child.ts:315-380`); extra tables pass.
  - The query child is a single process with a serial readline loop (`db-child.ts:228-245`), so one statement is atomic with
    respect to every other op.
  - Defaults (`hub/db-client.ts:27-30`): 64 interactive slots, 128 queued, **8 s deadline per IPC**.
- **Sessions.** `createSession` inserts without checking `users.epoch` (`db-child.ts:155-157`); `touchSession` does not join
  `users` (`:158-169`); `lanRecordValid` checks only expiry and origin (`hub/auth-identity.ts:157-160`); `getUserSummary` returns
  only `{username, initialPasswordInUse}` (`db-child.ts:140-144`; `hub/ports.ts:304-310`). No per-user session cap exists.
- **Login.** `runLanLogin` (`hub/lan-auth.ts:113-160`) runs in the route at `hub/http.ts:1937-1993` with **no ReqDeadline**.
  - KDF admission may queue for up to 20 s.
  - Passwords are compared with `timingSafeEqual` (`lan-auth.ts:85-88`).
  - passwd: `admin.ts:181-217` (setPassword tx bumps the epoch and deletes sessions).
  - Rotate: `admin.ts:254-290` (`revokeAllSessions` bumps every epoch).
- **Revoke bus.** Sync and isolated per subscriber (`hub/auth-revoke.ts:40-61`). Subscribers: HTML caps (`http.ts:2826`) and proxy
  sessions (`hub/hub.ts:1792`, matching rule `hub/proxy/sessions.ts:94-98`). LAN `sidTag = sidHash` (`auth-identity.ts:173-185`).
  The logout order (emit, delete, emit, SSE revoke) is at `http.ts:1995-2023`.
- **Spawn.** The real fresh spawn goes through `startFresh` (`hub/spawn/routes.ts:646-691`); its success audit and accepted
  result are in `hub/spawn/entry.ts:286-310`, shared with the Feishu bot (origin listener ≠ "lan"); `entry.ts:171-209` is the
  idempotent replay (`dup:true`). Session-branch success `routes.ts:1083`, its idempotent hit `:698-720`. Relaunch success
  `:1415-1426` carries no cwd; the authoritative cwd is the record field (`spawn/store.ts:122`).
- **Commands.** Web-captured command contexts keep `mode:"tui"` and add `webInvocation` (`agent/command-capture.ts:387-398`,
  read by `isWebInvocation`, `:486`); captured notify output flows back to the browser (`:318-326`). The `/webhub` web policy is
  deny-except-status, but user overrides win (`agent/command-policy.ts:203-208`, `:226-228`). Existing TUI checks look only at
  `ctx.mode` (`commands/webhub.ts:277`, `:552`).
- **Agent socket.** Admin frames are never logged by the hub (`hub/agent-server.ts:211-238`); unknown frames are dropped
  silently (`:204`), so a new frame type needs a cap gate. `LanResOk`/`LanInfoPayload` are `additionalProperties:false`
  (`protocol/messages.ts:2025-2054`).
- **Feishu.** `NewNonceInput` requires `installGen` and `tenantKey` (`hub/feishu/state.ts:236-248`); `redeem` consumes only
  its own nonce (`:1787-1808`; issue `:1752-1758`). Approval pattern (send card, attach nonces, patch):
  `hub/feishu/service.ts:1253-1270`, base fields `hub/feishu/inbound.ts:695-702`. `bounded()` races but does not cancel
  (`hub/feishu/runtime.ts:18-29`); the `sendCard` waiter is up to 30 s (`service.ts:439-460`). The outbox drops a repeated key
  (`hub/feishu/outbox.ts:790-793`). The notice rate reserve is private to `createFeishuNotify` (`hub/feishu/notify.ts:38-54`).

## 1. Settings (non-live: `/reload` then `/webhub restart`)

| Key                             | Default             | Parse (`config/settings.ts`)                                                                                                                                                                         | Hub wire                                                                                                      |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `webHub.lan.allowClients`       | `[]` = unrestricted | CSV or array. Each token goes through `parseClientCidr` (§2.1) and is canonicalized; at most 64 entries. Invalid tokens go to `invalidAllowClients`. ≥1 token configured but 0 valid ⇒ deny-all (Q1) | `HubLanConfig.allowClients?: string[]`. Present iff non-empty or deny-all (`[]`). Absent ⇒ hub byte-identical |
| `webHub.lan.sessionIdleMinutes` | 720 (Q2)            | int, clamp 5–10080                                                                                                                                                                                   | `sessionIdleMs?`, only when ≠ 720                                                                             |
| `feishuBot.securityAlerts`      | true (Q3)           | `bool()` in `parseFeishuBotBlock` (`:2320-2380`)                                                                                                                                                     | `FeishuBotHubConfig.securityAlerts?` (optional in the normalizer, absent ⇒ false)                             |

- Hub re-validation in `hub/lan-config.ts:20-82`: `allowClients` must be canonical CIDRs, `sessionIdleMs` must be in range.
  Otherwise `{ok:false}` ⇒ `lanConfigError` ⇒ LAN off (`hub/main.ts:66-80`).
- `setting-specs.ts:317-345` gets the rows. Settings-level warnings extend `WebHubLanSettingsWarnings` (`commands/webhub.ts:60-80`).
- 2FA has **no setting**. It is active iff enrolled. "New IP" = not seen within `NEW_IP_WINDOW_MS = 30 d` (Q11).

## 2. Client IP allowlist

### 2.1 `protocol/client-allow.ts` (pure, browser-safe, importable from `settings.ts`)

- `parseClientCidr`: IPv4/IPv6 with an optional prefix. IPv4-mapped `::ffff:x/p≥96` becomes IPv4 `/p-96`. Host bits are masked.
- `normalizeClientIp`: handles dotted and hex `::ffff:` forms. Unparseable ⇒ `undefined` ⇒ deny.
- `createClientMatcher`.
- `IMPLICIT_ALLOWED = 127.0.0.0/8, ::1` (Q4).

### 2.2 `hub/client-allow.ts`: `ClientAllowGuard`

- Always constructed. `createClientAllowGuard({entries?: string[]})`; with no entries ⇒ `active:false` and every admit is `true`.
- Methods: `admitPeer(peerIp, trustedProxyPeer)`, `admitForwarded({clientIp, xffUsable})`, `snapshot()`, `onBurst(fn)`.
- Bounded, timer-free bookkeeping:
  - per-IP deny map ≤1024 (prune >10 min, then FIFO);
  - burst deque ≤512 (fires at ≥20 denials per 10 min, then re-arms after 1 h, Q12).
- Audit: `auditClientDeny` (§8). At most 1 line per IP per 10 min, carrying a `suppressed` count. 60 lines per 10 min globally, then
  one overflow line.
- Test seam `implicitLoopback?: false`. Never reachable from config.

### 2.3 Enforcement

1. **LAN, connection level** (`http.ts:604`, before `connGuard.admit`): if `!guard.admitPeer(...)`, destroy silently (Q5). No
   bytes, no lease. Trusted-proxy peers pass.
2. **LAN, request level, trusted-proxy hops only** (after `buildContext`, `http.ts:623`): `guard.admitForwarded`. `xffUsable` is
   false on any of the three XFF warnings (fail-closed). Denial ⇒ `403 {error:"E_CLIENT"}`, before any route or cookie read.
   - Plumbing: add `RequestContext.xffUsable` (additive readonly).
   - Test: allowed → denied → missing on **one keep-alive connection**.
3. **Proxy listeners** (`proxy/listener.ts:101`): `ProxyListenerDeps.clientAllow: ClientAllowGuard` is **required**. Callers pass
   the shared guard (inert when inactive). Code: `if (!deps.clientAllow.admitPeer(peer, false)) { socket.destroy(); return; }`.
   No optional chaining (#12).
4. The loopback listener and the agent socket are untouched.

### 2.4 Status

- `LanStatus.on.allowClients?: {entries, denyAll?, denied?:{total,lastAt,lastIp}}` (`protocol/lan.ts:227`).
- The facade re-emits status at most every 30 s, plus one unref'd trailing timer, cleared in `close()`.
- `agent/lan-status.ts:91` renders the lines; settings warnings render the invalid tokens.

## 3. LAN login session management (LAN only, Q6)

### 3.1 Storage: side tables, `user_version` 1 (or 2 once 2FA is enrolled, §5.2)

| Table                                                             | Class         | Missing / malformed at open-check-migrate                                                          |
| ----------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `session_meta(sid_hash PK→sessions CASCADE, user_agent, last_ip)` | auxiliary     | DROP + recreate                                                                                    |
| `login_ips(ip PK, first_at, last_at)`                             | trust history | DROP + recreate **empty** ⇒ every IP is new (safe direction). Logged and shown in `/webhub status` |
| `twofa`, `recovery_codes`                                         | **security**  | never auto-dropped (§5.2)                                                                          |

- **Seed once**: `INSERT OR IGNORE INTO login_ips … FROM sessions` runs only when meta `login_ips_seeded` is absent; the marker is
  written in the same tx. `forget-ips`, enrollment and a login_ips rebuild keep the marker ⇒ old trust is never re-imported (#1).
- **Session-admission invariant (#5):** at most `LAN_SESSIONS_PER_USER_MAX = 32` live sessions per user.
  - `createSessionChecked` (§5.4) deletes the oldest-by-`last_seen_at` beyond 32 **inside the same tx** and returns the evicted
    hashes. The caller emits `authRevoke {sidTag}` and `lanSse.revoke` for each.
  - At open-check-migrate, users above 32 are trimmed. This is safe: proxy sessions and HTML caps are in-memory and empty at hub
    start.
  - As a result, list ≤32, bulk delete ≤31, and every count is complete and honest.
- Ops (B owns them; frozen in P0 `LanStorePort`):
  - `listSessions(userId, now)` → ≤32 rows (LEFT JOIN meta).
  - `deleteSessionsExcept(userId, keepSidHash)` → all deleted hashes (≤31 by the invariant). Defensive cap 64 ⇒ `{deleted, more:true}`.
  - `noteLoginIp(ip, now)` → `{wasKnown}`, ≤256 rows.
  - `isKnownIp(ip, now, windowMs)`.
  - `touchSession` gains optional `ip`. The throttled ≥60 s update writes `last_ip`.
  - Idle: `touchSession` uses the store's configured `idleMs` (`createLanStore({idleMs})`). The SELECT adds
    `last_seen_at > now-idleMs`, so a shortened idle applies immediately. The SSE tick counts as activity (Q8).

### 3.2 Routes: `hub/lan-sessions.ts` (module, package D; mounted by I in `handleLanRequestInner` after the proxy branch, `http.ts:~1611`)

- Public id = `base64url(sha256("pwh-lan-sess\0"+sidHash))[0:16]` (`hub/sid-hash.ts`). The sidHash never leaves the hub.
- `GET /api/lan/sessions`
  - Gate: `X-PWH: 1`, then `requireLanSession`.
  - → `{idleMinutes, absoluteDays:7, max:32, sessions:[{id,current,createdAt,lastSeenAt,expiresAt,absoluteExpiresAt,createdIp,lastIp?,ua?}]}`.
- `POST /api/lan/sessions/revoke` with `{id}` | `{others:true}`
  - Gate: `csrfOkLan`, `requireLanSession`, then a per-principal bucket of 6/min.
  - `id`: lookup against the full list (≤32), so the id is stable. Then logout order: emit, delete, emit, SSE revoke. A self
    revoke clears the cookie.
  - `others`: pre-list and emit each hash → `deleteSessionsExcept` → emit each returned hash → SSE revoke (excluding current).
  - Reply `{ok:true, revoked:n, complete: !more}`. The UI says 「已退出 n 台」, and adds 「部分未完成，请重试」 when `complete:false`.
- **Absolute deadline (#7):** `REVOKE_TOTAL_MS = 10 s` via `ReqDeadline`.
  - Every IPC gets `signal = AbortSignal.timeout(remaining)`.
  - On timeout after a delete was dispatched: emit revoke for the pre-listed hashes anyway (fail-closed) and reply `503 E_DEADLINE`
    with `effect:"unknown"`.
  - The UI fetch timeout is 15 s (> server 10 s).
- Cap `lan.sessions.v1` (static iff `config.lan`). Audit `auditLanSession` (§8).
- UI: `ui/components/shell/SettingsSessionsCard.vue` + `ui/composables/useLanSessions.ts` + `ui/logic/userAgent.ts`, i18n
  `sessions.ts` (zh/en). Shown iff cap ∧ `authMode==="password"`.

## 4. Feishu high-risk alerts

### 4.1 Hub bus `hub/security-events.ts` (P0; clone of auth-revoke)

`SecurityEvent` (frozen in P0): `lan-spawn {ip,user?,mode:"new"|"resume"|"fork"|"relaunch",dirTail?}`, `proxy-open {ip,host,port}`,
`login-success {ip,method:"password"|"totp"|"recovery"|"feishu",device,newIp}`, `login-2fa-challenge {ip,device,cardSent}`,
`login-2fa-denied {ip}`, `login-2fa-burst {kind}`, `recovery-used {left}`, `2fa-changed {op}`, `passwd {}`,
`login-lockout {ip,failures,lockMs}`, `login-tightened {}`, `login-saturated {}`, `allowlist-burst {count,ips,lastIp}`.

Zero subscribers ⇒ no-op.

### 4.2 Emit seams (one owner per file, §9)

| Event                                       | Seam                                                             | Rule                                                                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lan-spawn new                               | `spawn/entry.ts:286-302`, after `ctx.audit` on the accepted path | new optional `FreshSpawnContext.onAccepted?(info)`. `routes.ts:646` passes it iff `io.listener==="lan"`. The dup path (`entry.ts:171-209`) never calls it. The Feishu bot origin never sets it |
| lan-spawn resume/fork                       | `spawn/routes.ts:1083` success                                   | mode from `sessionArgv.mode`; the dup hit at `:698-720` is excluded                                                                                                                            |
| lan-spawn relaunch                          | `routes.ts:1415`                                                 | only when `!r.dup`; `dirTail` from `supervisor.records().find(spawnId)?.cwd` (`store.ts:122`), omitted if absent                                                                               |
| proxy-open                                  | `proxy/routes.ts:170`                                            | `outcome.ok && io.listener==="lan"`; host/port from `outcome.result.target` only                                                                                                               |
| login-success / login-2fa-* / recovery-used | `hub/lan-login.ts` post-success hook (§5.6)                      | single source                                                                                                                                                                                  |
| passwd, 2fa-changed                         | `admin.ts` after commit                                          | —                                                                                                                                                                                              |
| lockout/tightened/saturated                 | `ratelimit.ts` `createLoginLimiter({onEvent})`                   | transitions only; wired through `LanAssembly.build({security})` (additive)                                                                                                                     |
| allowlist-burst                             | guard `onBurst`, wired by I in `hub.ts`                          | —                                                                                                                                                                                              |

`dirTail` = last two path segments (Q9). LAN origin only (Q10).

### 4.3 Bot side: `hub/feishu/security.ts` (package E)

- Coalesce window 5 s per key `kind:disc`. Per-kind cooldowns:

  | Kind                                          | Cooldown      |
  | --------------------------------------------- | ------------- |
  | spawn                                         | 10 min/ip     |
  | proxy                                         | 30 min/target |
  | login-success newIp                           | 24 h/ip       |
  | lockout                                       | 15 min/ip     |
  | tightened / saturated / burst                 | 1 h           |
  | passwd / 2fa-changed / denied / recovery-used | **0**         |

  Events arriving during a cooldown add to `count`; the aggregate flushes when the cooldown ends.
  Bounds: ≤128 keys, ≤1 unref'd timer per key, all cleared on dispose.

- **Keys (#14):**
  - cooldown > 0 ⇒ `sec-<kind>-<hash12(disc)>-<floor(now/cooldown)>` (outbox dedup across restarts);
  - cooldown 0 ⇒ `sec-<kind>-<seq>-<rand8>`, unique, so a second passwd within the hour is never swallowed.
- **Shared budget (#14):** extract `reserve` from `notify.ts:38-54` into an exported `createNoticeBudget(clock)`, one instance per
  runtime, used by both notify and security. Exhaustion ⇒ drop and count, never block.
- `service.ts` subscribes via `FeishuBotServiceDeps.security?` iff `config.securityAlerts` ∧ an owner exists. It unsubscribes on
  runtime teardown. Events arriving while stopped are dropped.
- Text goes through `renderNotice` (zh, ≤600 chars). Never included: UA string (only the parsed device label), ids, cookies, codes,
  full paths, proxy URL path.

## 5. Second factor (2FA) for new-IP LAN logins

### 5.1 Rules

- Factors: **TOTP** (SHA1/6/30 s/±1, Q17) and **Feishu approval**; either one passes. **Recovery codes** (10 × 60 bit, Q18) are
  always issued alongside. Feishu-only enrollment is allowed (Q19).
- Required iff the user is enrolled ∧ `!isKnownIp(clientIp)`. Behind the trusted proxy with `!xffUsable` ⇒ always new.
- Order: allowlist → password → second factor → session.
- **A pending challenge is never a session**: no DB row, no `pwh_lan`, no identity, absent from `/api/lan/sessions`.
- Login-IP history is written only by the post-success hook (§5.6).

### 5.2 Security storage (B; never auto-dropped, #1)

- `twofa(user_id PK→users CASCADE, totp_secret BLOB, totp_last_step INT, feishu INT, recovery_salt BLOB, factor_gen INT NOT NULL, enrolled_at, updated_at)`.
- `recovery_codes(user_id, code_hash, used_at, PK(user_id,code_hash))`.
- First enrollment tx: create the tables (if absent), write rows, set meta `twofa_users=<json ids>`, **`PRAGMA user_version=2`** (Q13).
- open-check-migrate:

  | Situation                                             | Result                       |
  | ----------------------------------------------------- | ---------------------------- |
  | v1 with twofa/recovery tables present                 | `db-invalid:2fa-at-v1`       |
  | v2 with either table missing or column/PK/FK mismatch | `db-invalid:2fa-schema`      |
  | v2 with a `twofa_users` id lacking a row or a factor  | `db-invalid:2fa-missing-row` |

  In every case **LAN is off**, and `/webhub status` shows the reason plus the hint 「/webhub 2fa repair --confirm」.

- Never "not enrolled" by accident.
- Repair is an **explicit TUI maintenance op**, maint script `repair-2fa`, runnable while the LAN store is off. It recreates empty
  2FA tables, clears `twofa_users`, keeps v2 and audits. The TUI says 2FA was cleared and recommends `enroll` immediately.
- Runtime `get2faState` → `{state:"none"|"enrolled"|"inconsistent", totp, feishu, recoveryLeft, factorGen}`. `inconsistent` (meta
  lists the user, row gone) ⇒ every new-IP login fails 503 `E_DB`.
- The TOTP secret never leaves the DB child after enrollment; verification runs in the child (crypto is available,
  `db-child.ts:47`). `secure_delete=ON` (`db.ts:141`).
- Secret ops: `verifyTotp`, `consumeRecovery`, `beginTotp`, `commitTotp`, `setFeishu2fa`, `regenRecovery`, `reset2fa`,
  `forgetLoginIps`. Every change bumps `factor_gen`.

### 5.3 TOTP and recovery verification contract (#15)

- Input must match `/^[0-9]{6}$/` (recovery: 12 Crockford chars after normalization). Malformed ⇒ `400 E_BAD_REQUEST`; no
  attempt consumed, no IPC.
- In the child, `hub/totp.ts` (pure and import-free; embedded into the query script via `Function.prototype.toString`) computes
  **all three** candidates (t−1, t, t+1). Each is compared with `timingSafeEqual` on fixed 6-byte buffers and the results are
  OR-combined.
- Only then: if matched at step s, CAS `totp_last_step < s AND factor_gen = expectedGen`. 0 changes ⇒ `replay`/`stale`.
- Recovery: `sha256(salt‖code)` looked up by primary key, then CAS `used_at IS NULL AND factor_gen = expectedGen`.
- Externally, `bad`, `replay`, `stale` and `none` all map to one `E_2FA_CODE`. The audit records an internal `reason`, never the
  code. Tests assert via the code path (spy on the comparisons), not wall-clock timing.

### 5.4 Single completion entry (#2, #3): `hub/lan-login.ts` (package C, frozen signatures in P0)

```ts
interface LanLoginCore {
  passwordLogin(ctx, body, ua, io: LoginIo): Promise<LoginReply>;            // POST /api/login
  submitFactor(token, {method:"totp"|"recovery", code}, ctx, io): Promise<LoginReply>; // POST /api/login/2fa
  waitApproval(token, ctx, io): Promise<LoginReply>;                         // GET /api/login/2fa/wait
  cancel(token, ctx): void;                                                  // POST /api/login/2fa/cancel
  onApprovalDecision(challengeId, allowed, gen): void;                       // from Feishu (§5.7)
  onRevoke(ev: AuthRevokeEvent): void;                                       // bus subscriber (passwd/rotate)
}
```

Every success, including a **known-IP password login**, goes through one private `complete(user, method, ch?)` path, which calls
`store.createSessionChecked`.

`createSessionChecked({userId, expectedEpoch, expectedFactorGen, …})` → `{ok, sid, evicted[]} | {ok:false, reason:"stale"}` (P0
`LanStorePort`). It is one tx with one guarded statement:

```sql
INSERT INTO sessions(...) SELECT ... FROM users u LEFT JOIN twofa t ON t.user_id=u.id
 WHERE u.id=? AND u.epoch=? AND COALESCE(t.factor_gen,0)=?
```

The meta insert and the per-user cap trim happen in the same tx. Because the child is serial, a passwd/rotate commit that lands
before the INSERT makes it insert 0 rows ⇒ `stale` ⇒ `401 E_AUTH`. `expectedEpoch` comes from `getUser` (`LanUserRecord.epoch`) at
password time and is stored in the challenge. `getUserSummary` is not used for this.

Challenge (in memory, `hub/lan-login.ts`):

- Fields: `{idHash, userId, epoch, factorGen, clientIp, externalOrigin, uaHash, createdAt, expiresAt(5 min), attemptsLeft(5),
state, approval?:{gen, state}}`.
- Caps: ≤64 global, ≤4 per IP.
- States: `pending → verifying → pending|claimed`, `claimed → done`; any non-terminal state `→ dead(reason)`.
- **dead and done are irreversible.** Reasons: cancel, deny, expire, evict, revoked, attempts, deadline, client-gone.

Entry checks, in this order, **synchronously before the first await**: (1) token cookie lookup by sha256; (2) `clientIp`,
`externalOrigin` and UA hash match; (3) not expired (else `dead:expire` + close the card); (4) `limiter.admit(ip)`; (5) method
enabled per the challenge's snapshot; (6) budget reservation (§5.5); (7) state transition — `submitFactor`: `pending → verifying`
(any other state ⇒ `409 E_2FA_BUSY|E_2FA_USED|E_2FA_EXPIRED`); `waitApproval`: registers the single waiter (a second ⇒ 409);
approval completion: `pending → claimed` synchronously in the waiter wake-up when `approval.state==="approved"`.

After awaits:

- Verify result while `state === verifying` (still not dead):
  - ok ⇒ `claimed`;
  - fail ⇒ `attemptsLeft` was already reserved; `pending`, or `dead:attempts` at 0.
- A result arriving after the challenge died is **void** (no claim, no session).
- `claimed` ⇒ `complete()` ⇒ `done`. A `stale` ⇒ `dead:revoked`.
- **Client gone (#7):** if `res` is closed before the INSERT ⇒ `dead:client-gone`, no session. If it closed after the INSERT and
  before the send ⇒ best-effort `deleteSession` + revoke emit. A cookie is never issued on a destroyed response.

`onRevoke` (passwd ⇒ `{userId}`, rotate ⇒ `{listener:"lan"}`) kills the matching challenges. I wires it to the revoke bus.
`cancel`/deny/expire/evict/dead also:

- close the Feishu approval (§5.7: both nonces redeemed, card patched);
- settle the waiter with `E_2FA_EXPIRED`.

### 5.5 Attempt budgets, reserved before verification (#8)

- **Per challenge**: at most 1 verification in flight (`verifying` is the lock). `attemptsLeft--` happens **before** dispatch.
- **Per user**: one **sliding window of at most 10 attempts per 15 min** per method (TOTP, recovery) — a bounded ring of attempt
  timestamps (≤10 entries), checked and appended synchronously before dispatch; NOT a refilling token bucket (r2-review #8). A
  full window ⇒ that method is refused (`E_2FA_METHOD_LOCKED`) + `login-2fa-burst` until the oldest attempt ages out; other methods
  still work.
- Counting: a reject counts; a timeout, `E_DB` or abort after dispatch counts (fail-closed); `E_BUSY`/`E_RATE` refused **before**
  the child received the op refunds both budgets.
- **Per IP**: a reject also calls `limiter.fail(ip)` (shared lockout, §4.2 alerts).
- Hard bound: real verifier executions ≤ 10 per any sliding 15 min per method per user. Tests: 200 concurrent submits across 20
  challenges and 10 IPs, then assert the child's verify-op count; **exhaust, advance the fake clock < 15 min, submit again ⇒
  refused; advance past the oldest attempt + 15 min ⇒ exactly one more allowed**.

### 5.6 Wire, deadlines and the post-success hook (#7, #10)

Shapes are frozen in `protocol/lan-2fa.ts` (P0). All routes live in the LAN pre-auth branch next to `/api/login` (`http.ts:1936`),
mounted by I, with `lease.enterLoginPending()`.

| Route                        | Request                                | Reply                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/login`            | as today                               | known IP or not enrolled ⇒ `200` + `pwh_lan`. 2FA ⇒ `401 {error:"E_2FA", methods, feishu:"sent"\|"unavailable", expiresAt}` + `Set-Cookie: pwh_lan2fa=<token>; HttpOnly; SameSite=Strict; Path=/api/login; Max-Age=300` |
| `POST /api/login/2fa`        | `{method, code}` + cookie, `csrfOkLan` | `200` + `pwh_lan` + cleared `pwh_lan2fa`, or `401 E_2FA_CODE {attemptsLeft}`, `409 E_2FA_*`, `429 E_LOCKED`                                                                                                             |
| `GET /api/login/2fa/wait`    | `X-PWH:1` + cookie                     | `{state:"pending"\|"denied"\|"expired"}` or `200` + `pwh_lan` when approved                                                                                                                                             |
| `POST /api/login/2fa/cancel` | cookie, `csrfOkLan`                    | `{ok:true}`                                                                                                                                                                                                             |

**Absolute deadlines** (one `ReqDeadline` per request; the DB default is 8 s per IPC, `db-client.ts:30`). An `AbortSignal` alone
does NOT bound the wait: `db-client.ts:391–403` ignores abort once an op is dispatched and `req-deadline.ts:41–43` is only a clock
(r2-review #7). Therefore **every awaited step is wrapped in a deadline race** (`raceDeadline(promise, remaining − reserve)`): on
the logical timeout the route stops waiting, treats the step as failed (fail-closed, never skip 2FA, never issue a cookie), and the
late result is isolated (ignored; a late successful session insert is revoked by hash in the step's own `.then`). The real IPC slot
stays occupied until the real settle (db-client accounting unchanged). **All pre-reply steps count against the budget**, including
`markInitialLogin` and `limiter.succeed` (moved inside the completion reserve). Acceptance covers "IPC already dispatched, then the
deadline fires" (not just queue cancellation) with a never-settling fake child:

| Request      | Budget                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/login` | KDF admission keeps its own ≤20 s queue, then **post-KDF 10 s**: `isKnownIp` + `get2faState` ≤ remaining − 4 s, `createSessionChecked` ≤ remaining |
| `/2fa`       | **12 s**: verify ≤ remaining − 4 s; create ≤ remaining                                                                                             |
| `/wait`      | **hold ≤ 15 s + completion reserve 8 s = 23 s** < UI per-poll timeout 30 s                                                                         |
| UI           | treats any timeout as "retry poll"; a challenge `dead:deadline` ⇒ restart login                                                                    |

A DB failure in the gate ⇒ `503 E_DB` (fail-closed, never skip 2FA).

**Post-success hook** (`hub/lan-login.ts`, the only writer of login history and login alerts): `complete()` returns
`{reply, after}`. The route sends the reply, then runs `after()` via `res.once("finish")`, which does three things:

1. `noteLoginIp(ip)`. A failure is logged and the IP stays unknown.
2. Emits `login-success {method, newIp: !knownAtGate}`. `knownAtGate` comes from the gate's `isKnownIp` at password time, so
   there is no ordering race with the note.
3. Recovery ⇒ also `recovery-used {left}`.

`limiter.succeed(ip)` and `markInitialLogin` happen inside `complete()` before the reply. A password hit that triggers 2FA never
calls `succeed`.

`login-2fa-challenge` is emitted at challenge creation with `cardSent`. The bot suppresses its text alert when `cardSent`, because
the card is the alert.

### 5.7 Feishu approval (package E, port frozen in P0)

`LoginApprovalPort { request(c:{challengeId, gen, ip, device, user, expiresAt}): Promise<"sent"|"unavailable">; close(challengeId, why): void }`.
`hub.ts` wires the bot implementation when `config.feishuBot`, else a stub that answers `"unavailable"`.

- **Fence (#13):** each request creates `{gen, closed:false}`.
  - The send runs inside `work.run`. Its slot is released only when the real promise settles (createFeishuWork accounting).
  - `request` resolves `"unavailable"` at 5 s via `bounded()` and sets `closed=true`.
  - When a late `sendCard` resolves, it checks `closed`/gen **before** issuing nonces. If closed: no nonces, card patched
    「已失效」.
  - `close()` comes from success, cancel, deny, expire, evict or dispose. It redeems **both** nonces (consumes the sibling),
    patches the card and drops the entry.
- **Nonces (#9):** `state.nonces.issue({installGen: install.gen, tenantKey: state.tenant.get(), operatorOpenId: install.ownerOpenId,
chatId, messageId, action:"login-approve"|"login-deny", target: challengeId}, expiresAt-now)`. Same base fields as
  `inbound.ts:695-702`, from the current installation only.
- **Callback:** the existing redeem chain (`inbound.ts:523-531`), then the generic intent branch (`service.ts:1273`). Steps:
  1. re-check the live owner and installation;
  2. redeem the **sibling** nonce;
  3. `core.onApprovalDecision(challengeId, allowed, gen)`. It is ignored unless the challenge is non-dead and the gen matches;
  4. patch the card 「已批准/已拒绝/已失效」.
- Deny ⇒ `dead:deny` + `limiter.fail(ip)` + `login-2fa-denied`.
- Approval TTL 120 s (Q14). An expired approval leaves the challenge usable for TOTP/recovery.
- Card caps: 1 per challenge, ≤3 per IP per 10 min, ≤6 global per 10 min. Over the cap ⇒ `"unavailable"`.
- Bot down + Feishu-only enrollment ⇒ only recovery is offered.

### 5.8 TUI enrollment (package F; trusted channel, #4, #9)

- **Frames:** new `tfa_req`/`tfa_res` (not `lan_req`: strict schemas, and an old hub drops unknown frames, `agent-server.ts:204`).
  The agent sends them only if `hello_ack.caps` has `lan.2fa.v1`; otherwise it shows 「hub 版本过旧，请 /webhub restart」.
- **P0 freezes the full unions:**
  - requests: `status | totp_begin | totp_confirm{code} | feishu{on} | recovery_regen | reset | forget_ips | repair`;
  - success responses: `status{state,totp,feishu,recoveryLeft,knownIps,repairNeeded?}`, `totp_begin{otpauthUri,secretB32}`,
    `totp_confirm{recoveryCodes:string[10]}`, `recovery_regen{recoveryCodes}`, `ok{}`;
  - failure: `{ok:false, code, message}`;
  - real TypeBox schemas plus encode/decode round-trip tests.
- **Secret transport boundary:**
  - `otpauthUri`, `secretB32` and `recoveryCodes` exist only in those three response variants.
  - They travel only over the local agent socket, which is never logged.
  - They never enter `hub.json`, the browser, Feishu, audit or `/webhub status`.
  - Test: scan the hub log and `hub.json` after an enrollment.
- **Gate (#4):** every subcommand except `status` first checks `ctx.mode === "tui" && !isWebInvocation(ctx)`. The check runs
  **before** sending `totp_begin`/`recovery_regen`/`totp_confirm` and before any QR or code is rendered. Implemented in
  `agent/twofa-cmd.ts`, independent of command policy.
  Tests:
  - `mode:"tui"` + `webInvocation` ⇒ refused before any frame;
  - a policy override `webhub: allow` ⇒ still refused;
  - the captured output contains no secret.
- **Subcommands** (`agent/twofa-cmd.ts` + `agent/twofa-prompt.ts`; I adds `"2fa"` to `commands/webhub.ts:681` and the
  dispatch): `status` (web-safe, no secrets); `enroll [--replace]` (QR via `renderQr`, `commands/qr-render.ts:23`, then base32
  fallback, masked code prompt, confirm, codes printed once); `feishu on|off` (`on` requires a bot owner, `fsb info`);
  `recovery`; `reset --confirm`; `forget-ips`; `repair --confirm`.
- First enrollment clears `login_ips` (Q15) and keeps the seed marker. Sessions are not revoked; the TUI prints a hint (Q16).
- `hub/admin.ts` gets `handleTfaReq`. `repair` works with the LAN store off (maint script).

### 5.9 Login UI (package G)

- `ui/logic/password-client.js:281`: state `second-factor`, `submitSecondFactor`, `waitApproval` (30 s per-poll timeout, loops
  until `expiresAt`), `cancelSecondFactor`.
- `ui/components/shell/LoginSecondFactor.vue`: 6-digit `inputmode=numeric autocomplete=one-time-code`, recovery toggle, Feishu
  wait + countdown, `attemptsLeft`, the existing `E_LOCKED` countdown.
- i18n `login.2fa.*` (zh/en).

## 6. Status lines (`/webhub status`)

- `lan` line additions: allowlist (§2.4); `2fa=totp+feishu（恢复码剩 7）` | `2fa=off` (via `tfa_req status`); repair-needed reason;
  `login_ips` rebuilt notice.

## 7. Bounded resources and zero-hang

| Resource   | Bound                             |
| ---------- | --------------------------------- |
| guard maps | 1024 / 512                        |
| notifier   | 128 keys                          |
| challenges | 64 (≤4 per IP)                    |
| waiters    | 1 per challenge                   |
| approvals  | 1 per challenge, global card caps |
| sessions   | 32 per user                       |
| login_ips  | 256                               |
| allowlist  | 64 entries                        |

- Every timer is unref'd and cleared on close/dispose: guard trailing status, notifier windows, wait hold, approval expiry.
- Every request has an absolute deadline (§3.2, §5.6), and every IPC carries an abort signal ≤ remaining.
- No alert or history write sits on a response path.

## 8. Audit channels (all added in P0 to `hub/audit.ts`, runtime-whitelisted)

- `auditClientDeny{listener,ip,via,reason,suppressed}`.
- `auditLanSession{op,ip,user,ok,code,n,complete,self}`.
- `auditLan2fa{phase,method,ip,user,ok,code,reason,left,ms}`.
- None of them ever carries a code, secret, URI, token/challenge id, sidHash or UA string.
- Admin ops log `{op, ok}` only.

## 9. Packages: single-writer ownership (#11)

**I = integrator (one agent, serial).** Sole writer of every shared file: `hub/{http,hub,main,lan-assembly,agent-server,ports,audit}.ts`,
`protocol/{messages,version,lan,lan-2fa,lan-sessions,client-allow,feishu}.ts`, `config/{settings,setting-specs}.ts`,
`agent/index.ts`, `commands/webhub.ts`, `ui/components/shell/{SettingsView,LoginView}.vue`, `ui/i18n/index.ts`.

Module packages edit **only** their listed files. Each delivers its module, unit tests and a written _wiring request_ (call
snippets plus the deps it needs). They run in separate worktrees branched from the P0 commit. A scripted check fails the package
if `git diff --name-only P0..HEAD` leaves its allowlist.

| Pkg                   | Owns (exclusive)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 (I)**            | every frozen surface: settings keys/parsers/specs, `protocol/*` above (types, schemas, caps incl. `lan.2fa.v1` and `lan.sessions.v1`), `ports.ts` (`HubLanConfig`, `RequestContext.xffUsable`, `LanStorePort` incl. `createSessionChecked`/session/2FA ops, `LanAssembly.build({security})`, `LoginApprovalPort`, `LanLoginCore`, `ClientAllowGuard`), `hub/security-events.ts`, audit channels, `tests/web-hub/contract/fakes.ts` (fake store implementing every new op), stub modules that compile |
| A allowlist           | `hub/client-allow.ts`, `proxy/listener.ts`, `proxy/service.ts`, `agent/lan-status.ts`, `agent/proxy-status.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| B DB                  | `hub/db.ts`, `hub/db-child.ts`, `hub/lan-store.ts`, `hub/sid-hash.ts`, `hub/totp.ts`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| C login core          | `hub/lan-login.ts` (+ the extracted helpers of `hub/lan-auth.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D sessions            | `hub/lan-sessions.ts`, `ui/components/shell/SettingsSessionsCard.vue`, `ui/composables/useLanSessions.ts`, `ui/logic/userAgent.ts`, `ui/i18n/{zh,en}/sessions.ts`                                                                                                                                                                                                                                                                                                                                    |
| E Feishu + emit seams | `hub/feishu/{security,notify,service}.ts` (+ `inbound.ts` if needed), `hub/ratelimit.ts`, `spawn/entry.ts`, `spawn/routes.ts`, `proxy/routes.ts`                                                                                                                                                                                                                                                                                                                                                     |
| F TUI 2FA             | `hub/admin.ts`, `agent/twofa-cmd.ts`, `agent/twofa-prompt.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| G login UI            | `ui/logic/password-client.js`, `ui/components/shell/LoginSecondFactor.vue`, `ui/i18n/{zh,en}/login.ts`                                                                                                                                                                                                                                                                                                                                                                                               |

**Order:** P0 → (A ∥ B ∥ C ∥ D ∥ E ∥ F ∥ G against P0 fakes) → I merges A → B → C → D → E → F → G. Each merge is followed by the
wiring for that package and a full test suite run. Per-merge semantic checks: **I1** guard injected into both listener kinds;
**I2** real-store contract tests pass against B; **I3** every success path goes through `complete()` (`createSessionChecked` has
exactly one caller); **I4** revoke bus wired into `core.onRevoke` and the sessions route; **I5** emits only from §4.2 seams;
**I6** tfa gate precedes frames; **I7** UI caps.

Then **P5 (I)**: integration tests and docs.

## 10. Test plan

| Pkg | Files                                                                                                                                                                                              | Must prove                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0  | `tests/config/web-hub-settings.test.ts`, `feishu-bot-settings.test.ts` (ext); `tests/web-hub/protocol/{client-allow,lan-2fa,tfa-frames}.test.ts`; `tests/web-hub/hub/hub-lan-config.test.ts` (ext) | CIDR parse/canon/mapped; deny-all; absent keys ⇒ byte-identical `buildHubConfig`; tfa frame encode/decode round-trip, strictness; old hub w/o cap ⇒ agent never sends; new agent/old-hub + old agent/new-hub matrix                                                                                                                                                                                                                 |
| A   | `tests/web-hub/hub/client-allow.test.ts`; `tests/web-hub/http/lan-allowlist.test.ts`; `tests/web-hub/hub/proxy/listener-allowlist.test.ts`; `tests/web-hub/agent/lan-status.test.ts` (ext)         | no bytes/no slot on deny; same keep-alive allowed→denied→missing XFF; proxy: inactive / allow / deny, for HTTP, enter and upgrade; audit throttle; burst once per hour                                                                                                                                                                                                                                                              |
| B   | `tests/web-hub/hub/{db-child,lan-store,db,totp}.test.ts` (ext/new, real sqlite)                                                                                                                    | side-table rules; **v2 missing / bad twofa ⇒ refuse; meta row missing ⇒ refuse; repair op**; v1 with 2FA tables ⇒ refuse; seed exactly once (marker survives forget-ips/rebuild); login_ips rebuilt empty; `createSessionChecked` stale on epoch / factorGen change, trim to 32 returns evicted; TOTP RFC 6238 vectors, compares all 3 candidates, replay CAS (two concurrent ⇒ one ok); recovery single-use; enrollment tx sets v2 |
| C   | `tests/web-hub/hub/lan-login.test.ts` (fake store with controllable latches)                                                                                                                       | duplicate wait; TOTP vs recovery vs approval concurrent ⇒ ≤1 session; approve/deny/cancel races; late verify after death void; passwd/rotate after epoch read / after verify / before INSERT ⇒ no session; budget reservation (200 concurrent ⇒ ≤10 verifies); client-gone before/after INSERT; deadline paths; post-success hook runs once per success incl. known-IP password; history failure ⇒ IP stays unknown                 |
| D   | `tests/web-hub/http/lan-sessions.test.ts`, `lan-sessions-revoke-propagation.test.ts`; `tests/web-hub/ui/{settings-sessions-card,user-agent}.test.ts`                                               | CSRF/X-PWH; loopback 404; cap 32 ⇒ complete list; revoke-others with concurrent login (honest `complete`); cookie, SSE, proxy HTTP+WS, HTML caps all die; deadline ⇒ `effect:"unknown"` and still emits                                                                                                                                                                                                                             |
| E   | `tests/web-hub/hub/feishu/{security,login-approval}.test.ts`; `service.test.ts`, `ratelimit.test.ts` (ext); `tests/web-hub/http/lan-headless.test.ts` (ext)                                        | spawn seams: fresh/resume/fork/relaunch emit, idempotent retries don't, Feishu-origin spawn doesn't; two passwd in one hour ⇒ two messages; shared budget; approval: success after 5 s timeout ⇒ no nonces; arrival after cancel; sibling consumed; stop/restart clears                                                                                                                                                             |
| F   | `tests/web-hub/hub/admin-tfa.test.ts`; `tests/commands/webhub-2fa.test.ts`                                                                                                                         | tui+webInvocation and policy override ⇒ refused before frames; captured output secret-free; codes printed once; audit/log/hub.json scans                                                                                                                                                                                                                                                                                            |
| G   | `tests/web-hub/ui/login-second-factor.test.ts`; `tests/web-hub/http/lan-password-client.test.ts` (ext)                                                                                             | state machine incl. poll timeout/retry, expiry, cancel; i18n parity                                                                                                                                                                                                                                                                                                                                                                 |
| P5  | `tests/integration/web-hub-lan.test.ts` (ext, real hub child; allowlist via host LAN IP `localAddress`, `skipIf` none); `tests/integration/web-hub-feishu-bot.test.ts` (ext)                       | each success path (known-IP password, TOTP, recovery, Feishu approve) ⇒ one session + one `login-success` alert with the method; LAN spawn ⇒ one alert; feature-off hub byte-identical                                                                                                                                                                                                                                              |

CI: `format:check`, `typecheck`, `test`, `build`, `build:web`, `check:web`.

## 11. Risks

- Silent drops look like a dead hub. Mitigation: deny counter in `/webhub status`; loopback is always allowed.
- Trusted proxy without XFF ⇒ everyone gets 403 (intended).
- IPv6 entries are inert (the binds are IPv4).
- Approval fatigue. Mitigation: IP and device on the card, 120 s TTL, card caps; a deny adds to the lockout.
- A known-IP attacker needs only the password. Accepted: the client IP is the user's own device (ruling), and the allowlist covers it.
- Lost phone and lost codes ⇒ local `/webhub 2fa reset`.
- Feishu sees IPs and dir tails.
- Integrator throughput is the bottleneck (serial merges). Accepted in exchange for single-writer safety.

## 12. r1 review disposition

| #   | Sev | Finding                                   | Closed by                                                                                                                                                                                         | §            |
| --- | --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | B   | security tables auto-dropped              | Table classes. 2FA tables never dropped. v2 missing/malformed/meta-row ⇒ LAN off + explicit `repair`. login_ips loss ⇒ all IPs new. Persistent seed marker                                        | 3.1, 5.2     |
| 2   | B   | no challenge-level single completion      | One `LanLoginCore` entry; sync bindings/TTL/lockout/budget; claim before first await; irreversible dead/done; late results void; sibling nonce + waiter closed                                    | 5.4, 5.7     |
| 3   | B   | non-existent epoch interface / non-atomic | P0 `createSessionChecked{expectedEpoch,expectedFactorGen}` guarded INSERT in one tx (serial child); one `complete()` for all incl. known-IP password; passwd/rotate ⇒ `onRevoke` kills challenges | 5.4          |
| 4   | B   | ctx.mode alone not TUI-only               | `ctx.mode==="tui" && !isWebInvocation(ctx)` before any frame/secret; policy-independent; tests                                                                                                    | 5.8          |
| 5   | M   | bulk revoke partial yet "success"         | Per-user cap 32 enforced in the create tx (evicted ⇒ revoked); full list; `complete` flag; defensive `more`                                                                                       | 3.1, 3.2     |
| 6   | M   | wrong fresh-spawn anchor                  | `entry.ts:286` `onAccepted` seam; dup excluded; resume/fork at `:1083`; relaunch `!dup` + record cwd; entry.ts in E                                                                               | 4.2          |
| 7   | M   | false 2 s / budget claims                 | Real 8 s per IPC; absolute per-request deadlines; wait 15+8 s < 30 s client; no cookie after disconnect                                                                                           | 3.2, 5.6     |
| 8   | M   | "hard cap 10" false                       | Synchronous reservation before dispatch; ≤1 in flight per challenge; counting rules; concurrency test counts verifies                                                                             | 5.5          |
| 9   | M   | P0 contract insufficient                  | New `tfa_req/res` full unions + schemas + cap gate + secret boundary; nonce `installGen`/`tenantKey` from the current installation; round-trip and version-matrix tests                           | 5.7, 5.8, 10 |
| 10  | M   | login-IP history race                     | Single post-success hook; `newIp` from the gate's `knownAtGate`; note after send; failure ⇒ stays unknown                                                                                         | 5.6          |
| 11  | M   | no real frozen shared surfaces            | Integrator is the sole writer of shared files; exclusive module allowlists + scripted check; serial merges with I1–I7                                                                             | 9            |
| 12  | m   | absent guard ⇒ deny                       | Guard always injected (required dep, inert when inactive); no `?.`                                                                                                                                | 2.3          |
| 13  | m   | 5 s bound doesn't cancel                  | Gen/closed fence before nonce issue; work-slot accounting; close() on every terminal path                                                                                                         | 5.7          |
| 14  | m   | dedupe/global-rate traps                  | Unique key when cooldown 0; shared `createNoticeBudget`                                                                                                                                           | 4.3          |
| 15  | m   | TOTP timing contract                      | 6-digit only; all 3 candidates constant-time then decide; one external error                                                                                                                      | 5.3          |

## User / main-session rulings (2026-10-19)

- **Client IP**: the user confirmed 192.168.32.38 is an internal-network IP of their own device (not a shared VPN
  NAT gateway) ⇒ /32 allowlisting and the "new IP" definition are meaningful as planned.
- **Q19**: Feishu-only 2FA enrollment is ALLOWED (recovery codes always issued alongside) — user ruling.
- Q1–Q18: the plan's recommended answers are adopted by the main session (deny-all on an all-invalid allowlist;
  720 min idle; securityAlerts default on; loopback always allowed; silent close; sessions managed in LAN web
  settings; extra tables, schema v1 → v2 only on first 2FA enrollment; open tab counts as activity; spawn alert
  shows last 2 path segments; alerts only for LAN-origin actions; new IP = not seen in 30 days (constant);
  denial-burst alert ≥20/10 min at most hourly; schema bump on enrollment; Feishu approval 120 s, challenge 5 min /
  5 attempts; first enrollment clears seen-IP history; enrollment does not revoke sessions (TUI hint);
  TOTP SHA1/6/30 s/±1; 10 recovery codes × 60 bit, salted sha256, regenerated as a set).

## 13. r2 review disposition (main-session adjudication, 2026-10-19)

r2 re-review (r_FNC534T9): 13 closed, 2 partially, all 4 Blockers closed, no new Blocker. Per the convergence rule the main
session closed both partials directly (no third review round):

- r1 #7 (partially → closed): every awaited pre-reply step uses a deadline race with late-result isolation (late session insert
  revoked by hash); `markInitialLogin` / `limiter.succeed` are inside the completion reserve; acceptance includes
  dispatched-then-deadline with a never-settling child (§5.6).
- r1 #8 (partially → closed): per-user per-method limit is a sliding window of ≤10 attempts / 15 min (bounded timestamp ring),
  not a refilling token bucket; acceptance includes exhaust → advance <15 min → refused, then past the window → one allowed (§5.5).
