# lan-security-plan review r1 (gpt-6.1-sol, run r_8YD136P0) — REJECT: Blocker 4 / Major 7 / Minor 4

Reviewed against the appended rulings (own device IP, no HTTPS, Feishu-only allowed, Q1–Q18 adopted); none of the
findings change scope. Paths: `hub/…`, `agent/…`, `protocol/…` relative to src/web-hub/. Plan line numbers =
version including the rulings section.

1. **Blocker — security state must not be auto-dropped as auxiliary data** (plan:123–125,234–246,259–261). §4b puts
   twofa/recovery_codes under §3.1's side-table rule ("structure mismatch ⇒ DROP + rebuild"); rebuilt empty ⇒ "no
   factor ⇒ password login" silently downgrades; user_version=2 doesn't stop the NEW hub doing it. Existing
   maintenance refuses on corruption (hub/db-child.ts:315–380). Fix: only session_meta may be rebuilt; v2 factor /
   recovery-code tables missing or malformed ⇒ LAN off or explicit TUI repair, never "not enrolled". login_ips loss
   ⇒ every IP new. "seed once" guarded by a persistent migration marker so forget-ips / enrollment never re-imports
   old trust. Tests: v2 missing table / bad table ⇒ refuse.
2. **Blocker — no challenge-level single completion protocol** (plan:283–306,320–327). TOTP step CAS, recovery-code
   CAS and a single Feishu nonce don't make the whole challenge create ≤1 session: repeated approved /wait, two
   recovery codes, TOTP vs approval race, approve vs deny race undefined; /wait lists only X-PWH + cookie, not the
   POST's IP/origin/epoch/lockout checks. Existing nonce redeem consumes only itself, not the sibling button
   (hub/feishu/state.ts:1787–1808). Fix: one frozen completion entry: check all bindings, TTL, current factor
   version, lockout; atomically claim the challenge before the first await; consumed forever after; cancel / deny /
   expire / evict irreversible; all late results void; close the sibling button + waiter. Tests: duplicate wait,
   cross-factor concurrency, approve/deny/cancel races, replay after revocation.
3. **Blocker — epoch guarantee relies on a non-existent interface + non-atomic check** (plan:279–297; hub/ports.ts:299–310).
   getUserSummary returns only username/initialPasswordInUse (hub/db-child.ts:140–144). Check-then-await-then-
   createSession lets passwd/rotate commit revocation in between and the old challenge then inserts an old-epoch
   session; INSERT doesn't check users.epoch, touch doesn't join users (db-child.ts:119–121,156–169);
   auth-identity.ts:157–160 checks only expiry + origin. Fix: P0 defines the epoch interface; verify expectedEpoch
   INSIDE the DB session-creation transaction; one completion path for Feishu, TOTP, recovery code and known-IP
   password login; passwd/rotate invalidate old challenges; test revocation after epoch read / after factor verify /
   before INSERT.
4. **Blocker — ctx.mode alone doesn't make it TUI-only; secrets may reach the web** (plan:345–360). Web-captured
   contexts keep mode "tui" and only add webInvocation (agent/command-capture.ts:387–398); notify output is collected
   back (:318–326); default webhub policy is deny but user overrides win (agent/command-policy.ts:203–208,226–228).
   Fix: sensitive commands require `ctx.mode === "tui" && !isWebInvocation(ctx)`, checked BEFORE begin / reading
   recovery codes / printing the QR; never rely on policy default deny; tests for tui+webInvocation, policy override,
   captured output contains no secret.
5. **Major — "sign out all other devices" may be partial yet report success** (plan:133–134,154–159). Fixed DELETE
   LIMIT 1024, pre-list ≤64; no per-user session cap (hub/lan-store.ts:163–178, db-child.ts:156–158). Sessions past
   1025 survive; their sidTags' proxy/HTML caps aren't revoked; 64-row truncation not disclosed; revoke-by-id depends
   on a shifting first-64. Fix: a session-admission invariant ≤ delete cap, or a bounded, resumable, explicitly
   partial bulk delete (never claim "all others" unless done); revoke every deleted sidTag; keep current; list shows
   truncation/pagination or stable target query. Tests >64 / >1024 + concurrent creation; check cookie, SSE, proxy
   HTTP/WS, HTML caps.
6. **Major — fresh-spawn alert anchor wrong** (plan:33,207; hub/spawn/routes.ts:642–691). True fresh spawn: startFresh
   at routes.ts:646, returns :691; :708 is the idempotent hit of the session branch (audit dup:true, :698–720); the
   real fresh success audit is hub/spawn/entry.ts:286–302; relaunch :1415–1426 has no cwd. Fix: emit from the fresh
   accepted outcome / entry's success seam; decide dup ⇒ no alert; resume/fork/relaunch from verified results (relaunch
   cwd from the authoritative record or no dirTail); add entry.ts to P4's domain; acceptance covers fresh / resume /
   fork / relaunch / idempotent retry.
7. **Major — "inherits the 2 s DB deadline" / "existing login auth budget" are false** (plan:127,265,281,390;
   hub/db-client.ts:30,119). DB default is 8 s; the login call in hub/http.ts:1937–1956 has no ReqDeadline. Serial IPCs
   add up; /wait's 25 s then still create/mark/note past the client's 30 s; the 15 s session-management fetch can expire
   first. Fix: absolute total deadlines for login, factor submit, wait completion and session revoke, each step
   derives the remainder; use the real 8 s DB fact; wait reserves budget for the final session creation; no cookie
   issuance after disconnect/timeout. Tests: slow DB, saturated queue, never-settling dependency, client disconnect,
   resource cleanup after real settle.
8. **Major — the "hard cap of 10" distributed-guessing claim is false** (plan:294–299; hub/db-client.ts:27–28). Count-
   after-failure + lock at >10 is already not "≤10"; concurrent requests pass the check before the counter updates
   (DB allows 64 in-flight / 128 queued). Same for the per-challenge 5. Fix: synchronously reserve per-user and
   per-challenge attempt budget before calling the verifier, or ≤1 verification in flight per challenge; define
   reject/timeout counting; tests with concurrent batches across challenges/IPs asserting the actual number of HMAC
   verifications.
9. **Major — P0 frozen contract insufficient for P7/P8** (plan:320–321,336–344,398–405,432–433). LanResFrame success has
   only optional info; LanInfoPayload/LanResOk are additionalProperties:false (protocol/messages.ts:1014–1016,2025–2054)
   — can't return otpauthUri / recoveryCodes / factor status. nonce.issue example misses NewNonceInput's required
   installGen/tenantKey (hub/feishu/state.ts:236–248,1752–1758). Fix: P0 freezes request + success/failure response
   unions + cap + the local transport boundary for every secret field; Feishu nonce gen/tenant from the current
   installation/state along the existing redeem chain; real encode/decode round-trip + old agent/new hub + old hub
   without cap tests.
10. **Major — P4 vs P6 fight over login-IP history** (plan:209,279,374,394). P4's post-response noteLoginIp drives the
    isNew alert; P6's completeLanLogin notes the IP first ⇒ P4 sees isNew=false and the new-IP alert is swallowed;
    awaiting it violates §5 "response never waits for history". Fix: ONE shared post-success hook for direct password,
    TOTP/recovery and Feishu-wait successes: note once after the response, alert by the result, include the method;
    a failed write ⇒ the IP stays unknown; merged-package alert tests.
11. **Major — packages don't really freeze shared write surfaces** (plan:407–435). P1/P2/P4 all write http.ts in
    parallel; "different hunks, rebase later" violates the single-writer frozen-surface rule; P6 rewrites P4's login
    logic (#10); P0 frozen files reappear in later packages. Fix: one integration owner for http.ts and other shared
    assembly/declaration files; packages deliver modules + wiring requests; shared schema/audit/command changes
    serialized; if worktrees, define isolation + single merger + semantic merge checks. P5 acceptance covers every
    factor success path + alerts.
12. **Minor — absent optional guard becomes deny** (plan:93–95). `!deps.clientAllow?.admitPeer(...)` ⇒ !undefined
    ⇒ destroys every proxy connection when the dep isn't provided (hub/proxy/listener.ts:101–128). Fix: destroy only
    when the dep exists and denies, or always inject an explicit no-op guard; tests: no dep / inactive / allow / deny,
    HTTP + upgrade.
13. **Minor — the 5 s bound doesn't cancel the real card send** (plan:304,318–331; hub/feishu/runtime.ts:18–29;
    sendCard waiter 30 s hub/feishu/service.ts:439–460). Late sends can still issue nonces after "unavailable". Fix:
    generation/closed fence so late sends never activate approval; cancel/evict/success/expire/dispose all clear nonces
    and settle waiters; follow createFeishuWork's real-promise slot accounting. Tests: success after 5 s, arrival
    after cancel, stop/restart.
14. **Minor — alert dedupe / global rate traps** (plan:218–220). passwd cooldown=0 with floor(now/cooldown) ⇒ constant
    Infinity suffix; outbox same key ⇒ duplicate drop (hub/feishu/outbox.ts:790–793), the second password-change alert
    is swallowed. The "global 20/min" isn't outbox's: reserve lives in notify's private closure (hub/feishu/notify.ts:38–54).
    Fix: cooldown=0 ⇒ unique event key; time-window dedupe only with a cooldown; security alerts and existing notices
    share one lightweight reserve. Tests: two passwd in one hour, shared budget, drop never blocks the action.
15. **Minor — TOTP timing boundary not in the acceptance contract** (plan:270,446; hub/lan-auth.ts:85–88 uses
    timingSafeEqual for passwords). Fix: accept only 6 ASCII digits; compute and constant-time compare all three
    candidates before deciding; bad/replay/none never become distinguishable external errors or secret logs; verify via
    code path, not wall-clock timing.

Also verified OK (no change needed): direct-peer forged XFF doesn't change clientIp today; trusted-proxy allowlist per
buildContext covers keep-alive XFF changes (add an allowed→denied→missing same-connection test); normalizePeerIp is not a
full mapped-IPv6 normalizer; proxy listener `connection` event precedes request/upgrade; settings/LAN fail-closed seams
exist; old Feishu normalizer ignores unknown fields; v2 bump blocks old maintenance scripts; idle/absolute/touch/SSE
facts; auth-revoke fan-out and proxy/HTML revoke paths reusable; crypto available in the DB child; proxy-open alerts must
carry only `outcome.result.target` host/port, never the raw URL or the enterUrl code (hub/proxy/service.ts:439–445).
