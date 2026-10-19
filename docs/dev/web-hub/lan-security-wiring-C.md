# Package C — login core wiring request

## Construction (one core per LAN frontend)

```ts
const core = createLanLoginCore({
  store: rt.lan.store,
  kdf: rt.lan.kdf,
  limiter: rt.lan.limiter,
  admission: rt.lan.admission,
  approval,
  security,
  authRevoke: rt.authRevoke,
  revokeSse: (hash) => rt.lanSse.revoke((c) => c.auth?.sidHash === hash, "revoked"),
  now: rt.now,
  log: rt.log,
});
const unsubscribe = rt.authRevoke.subscribe((ev) => core.onRevoke(ev));
// Feishu callback: core.onApprovalDecision(challengeId, allowed, gen).
// Without the bot: approval = {request: async () => "unavailable", close() {}}.
// Teardown: unsubscribe(); core.dispose(); before releasing the store.
```

Install B's real ops first. Optional `limiter.isFresh(ip)` drives admission; absent ⇒ true.
I owns revoke subscription lifecycle; the core does not self-subscribe.

## HTTP call sites (pre-auth LAN branch, next to existing /api/login)

Allowlist enforcement must precede all four routes. Do not mount on loopback.
Set `ctx.ua` = `io.ua` (complete header, empty if absent); `xffUsable` from proxy warnings.
Attach a request-local abort controller: abort on response close before finish or request abort;
**do not** abort on IncomingMessage's ordinary successful `close`/`end`.

```ts
let finished = false;
const controller = new AbortController();
req.once("aborted", () => controller.abort());
res.once("finish", () => {
  finished = true;
});
res.once("close", () => {
  if (!finished) controller.abort();
});
const io: LoginIo = {
  ua: req.headers["user-agent"] ?? "",
  signal: controller.signal,
  responseOpen: () => !res.destroyed && !res.writableEnded,
  onAdmitted: () => lease.enterLoginPending(),
};
let result: LoginReply;
// POST /api/login: csrfOkLan; bounded readJson (existing login body cap).
result = await core.passwordLogin(ctx, body, io.ua, io);
// POST /api/login/2fa: csrfOkLan; bounded readJson; I MUST schema-validate body.method
// and normalized code BEFORE calling core (normalizeRecoveryCode for recovery).
result = await core.submitFactor(token, body, ctx, io);
// GET /api/login/2fa/wait: X-PWH:1 (no csrfOkLan GET gate).
lease.enterLoginPending();
result = await core.waitApproval(token, ctx, io);
// POST /api/login/2fa/cancel: csrfOkLan; then core.cancel(token, ctx);
// reply 200 {ok:true} and clear pwh_lan2fa with Path=/api/login.
```

`token` is the raw `pwh_lan2fa` cookie (missing => empty string). Never expose/log it,
challenge id/hash, sid/hash, UA, codes or enrollment secrets. Request body parsing is I-owned.
Factor/wait: enter login-pending first; password invokes `onAdmitted` after KDF admission.

## Sending replies and post-success hook

```ts
if (!io.responseOpen() || io.signal.aborted) {
  controller.abort(); // triggers post-insert cleanup, including core-to-send gap
  lease.leaveLoginPending();
  return;
}
if (result.after) {
  res.once("finish", () => {
    void result.after!().catch(() => rt.log.error("login after failed"));
  });
}
if (result.status === 200 && "ok" in result.body) lease.enterAuthed();
else lease.leaveLoginPending();
sendJson(res, result.status, result.body, result.headers);
```

`Set-Cookie` may be a **string array** (session + cleared challenge cookie); preserve it.
Attach after BEFORE send, ONCE to **finish**, never close; after is internally consume-once.
No route may call `createSession`/`createSessionChecked`, `markInitialLogin`, `limiter.succeed`,
`noteLoginIp`, or emit login-success/recovery-used separately. This includes known-IP logins.
Remove the old `runLanLogin` invocation in http.ts; privacy's `verifyPassword` remains unchanged.
Do not advertise `lan.2fa.v1` until C, B, E, F and G wiring is complete.

## Core guarantees / integration checks

- Single checked INSERT site; atomic epoch/factor generation CAS is B-owned.
- Challenge cap 64 / per-IP 4; FIFO evict closes old card/waiter; dead/done never resurrect.
- Binding → expiry → limiter → method → synchronous budget/lock before verifier dispatch.
- Per-user/method ≤10 dispatches per sliding 15min; five attempts/challenge, one in flight.
  E_BUSY/E_RATE refund only because DB contract means pre-dispatch admission rejection.
- Gates share post-KDF10s; factor12s; wait hold15s + reserve8s, even after card expiry.
  Mere poll abort detaches waiter; claimed completion/factor abort kills challenge.
  Each awaited op races deadline/cancellation; timers unref and cleared.
- Extra defensive pre-KDF bounds: admission20s, getUser8s, KDF20s. Physical KDF lease
  remains held until real settle even if the request logically timed out.
- Late INSERT success and post-insert client close cause hash delete + revoke/SSE propagation.
- History/alerts run after finish; `newIp` uses the password gate snapshot, not note result.
- Password/finish caps64; method-user map256; live attempt windows never evicted.
- Completion reasons: capacity ⇒ evict; internal failure ⇒ dispose (enum lacks error);
  timeout ⇒ deadline; disconnect ⇒ client-gone; only CAS/revoke ⇒ revoked.

## Contract issues / accepted residuals

1. **Accepted main-session ruling:** after-hook runs only after successful login; a late
   successful `noteLoginIp` after its 8s logical timeout correctly makes the IP known.
   Failed/never-landed writes never mark it known and never bypass 2FA. Keep bounded wait + log.
   Frozen port has no CAS/individual forget; concurrent forget-ips is not undone by core.
2. `LoginIo` has no finish subscription: I must call after exactly on finish, and abort on close.
   Core tracks the reply-to-finish gap for up to8s (unref timer), bounded to64 subscriptions;
   HTTP must still enforce send/close semantics after that window.
3. E owns late-send nonce fencing (§5.7); core closes immediately and on late settle.
4. User revoke during unresolved getUser conservatively invalidates any such request.
