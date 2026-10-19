# LAN security package B — integration request

## Open / status (I: lan-assembly + hub)

```ts
const opened = await createLanStore({
  dbFile: paths.dbFile,
  log,
  ...(config.lan?.sessionIdleMs === undefined ? {} : { idleMs: config.lan.sessionIdleMs }),
});
if (!opened.ok) {
  // Preserve reason/detail: security refusals are reason="db-invalid" and detail EXACTLY
  // "2fa-at-v1" | "2fa-schema" | "2fa-missing-row" (without a db-invalid prefix).
  return opened;
}
const store = opened.store;
if (opened.loginIpsRebuilt) {
  // Publish LanStatus.on.loginIpsRebuiltAt = Date.now(); A renders the notice.
}
```

No new mandatory dependency besides existing `dbFile` / `log`; `idleMs` defaults to 12 h,
clamped to 5 min–7 d. The result adds REQUIRED `loginIpsRebuilt:boolean` on success.
Fresh/legacy first migration is not a rebuild; damaged or previously seeded/missing history is.
The store logs a rebuild warning. Security refusals must leave LAN OFF and show the repair hint.

## Login / sessions (I: C/D wiring)

```ts
// C is the only HTTP login caller; NEVER fall back to legacy createSession on any failure.
const result = await store.createSessionChecked(
  {
    userId: user.id,
    expectedEpoch: user.epoch,
    expectedFactorGen: state.factorGen,
    boundOrigin: ctx.externalOrigin,
    createdIp: ctx.clientIp,
    ua,
    now: Date.now(),
  },
  { signal },
);
if (result.ok) {
  for (const sidTag of result.evicted) {
    authRevoke.emit({ sel: { sidTag }, reason: "logout" });
    lanFacade.revoke({ sidHash: sidTag });
  }
}
// Normal request + SSE activity (hold the concrete LanStore for the reserved lane):
await store.touchSession(sidHash, now, { signal, ip: ctx.clientIp });
await store.touchSessionReserved(sidHash, now, { signal, ip: ctx.clientIp });
```

Preserve C's request-level absolute deadline races: the existing IPC has its own 8 s ceiling
but cannot cancel an already-dispatched operation. A late successful checked insertion needs
C's delete/revoke cleanup; never issue its cookie after deadline/client disconnect.
Every facade method is async; malformed OTP/recovery codes reject `E_BAD_REQUEST` BEFORE IPC.
Callers normalize recovery codes via `normalizeRecoveryCode` before passing canonical codes.
Unknown user/epoch/gen at checked insertion returns `{ok:false,reason:"stale"}`; inconsistent
security metadata throws `E_DB` instead. Keep all internal hashes server-side; D uses the
already-implemented `publicSessionId()` from sid-hash.ts (tested, unchanged in B).
Only the post-response success hook writes `noteLoginIp`; B does NOT write trust at insertion.

## TFA admin / repair (I/F)

```ts
// Active store: begin/commit, Feishu toggles, recovery, reset and forget use frozen port methods.
const pending = await store.beginTotp({ userId, replace: true, now }, { signal });
const committed = await store.commitTotp({ userId, code, expectedGen, now }, { signal });
// expectedGen comes from get2faState before begin; all generation-changing operations invalidate it.
// When LAN is OFF, repair does not need a resident store:
const repaired = await repairLan2fa({ dbFile: paths.dbFile, log, signal });
```

Close/dispose an active LAN store and its login core BEFORE repair; reopen afterwards. Do not
run maintenance repair concurrently with requests or pending challenges. The helper file-checks
and runs a SIGKILL-bounded 5 s maintenance child. It already writes exactly one admin repair
audit (`op`, `ok` only); F must not duplicate it. F still owns the `2fa-changed` event.
Secrets travel ONLY in begin's local-socket response or the one-time recovery-code response.
`commitTotp` NEVER replaces an existing recovery set, even when every code is used: success
returns `recoveryCodes:[]` when no new set was generated. F must not promise ten NEW codes then
(use the frozen `data.kind:"ok"` response, not `totp_confirm`'s ten-code-only response variant).
A first factor enrollment generates ten, clears login IPs and keeps the seed marker; sessions
remain intact. TOTP enrollment confirmation itself consumes its TOTP step (same-step replay fails).

## Persistent safety / bounds

- Main-session ruling (2026-10-19): reset / removing the sole Feishu factor retains the `twofa`
  tombstone with bumped gen but removes its id from enrolled metadata IN THE SAME transaction.
  Reopen succeeds; re-enrollment re-adds the id and continues the monotonic generation.
- Explicit reset/off on a never-enrolled v1 user also creates v2 tombstone storage, so generation
  cannot roll back to zero. Explicit repair is the documented exception: clears 2FA and keeps v2.
- Missing/malformed `session_meta` is rebuilt. Missing/malformed `login_ips` with a seed marker is
  rebuilt EMPTY. A malformed unseeded table is also rebuilt empty. Legacy sessions seed only once.
- Exact security column/type/nullability/PK-order/FK/STRICT checks; v2 security data is NEVER
  auto-dropped. Listed enrolled ids require a valid row/factor. Unlisted live factors also refuse.
- Sessions <=32/user, history <=256, pending child TOTP secrets <=64 / TTL 5 min, no new timers.
  UA metadata has a 512-byte JSON-content ceiling so a full 32-row list fits the IPC frame.
- Touch validates user epoch and the configured idle immediately; IP writes share the 60 s throttle.
  File-check waits are bounded (1 s each); IPC/maintenance remain child-process bounded.
- `close()` still owns checkpoint/timer cleanup. All new timeout handles are unref'd.

## Contract issues / deviations

No frozen files changed. P0 fake `commitTotp` still regenerates recovery unconditionally and differs
from binding addendum #4; I owns any fake parity update. Recovery-set reuse and tombstone semantics
are covered by real SQLite tests. Additional fail-closed checks reject a v1 enrolled-metadata marker
and unlisted live factors; explicit repair remains the only path that clears security evidence.
HTTP/hub/admin wiring and whole-system acceptance remain I's work; no capabilities activated here.
