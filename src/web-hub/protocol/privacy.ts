/**
 * web-hub-privacy plan v2.1 (P1 hub 包 — frozen protocol face): the per-session privacy lock
 * （会话隐私锁） surface. Lock marks are keyed by sessionId and persisted hub-side in
 * `<stateDir>/privacy.json` (`hub/privacy/store.ts`); this module pins only the wire
 * constants/types both the hub routes (`hub/privacy/routes.ts`) and the UI transports
 * (`ui/src/logic/{token-client,password-client}.js`, via `logic/contract.js`) code against —
 * same anti-drift rule as every other protocol module.
 *
 * Two endpoints (plan「接口」节): `lock` rides BOTH listeners (LAN + loopback), `verify` is
 * LAN-only (a loopback/token session has no second credential to check — v2.1 N1). Both add
 * no agent↔hub frames, so no PROTO bump (same §2.3 只加帧不改 rule as preview/spawn; the hub
 * cap `privacy.v1` lives in `version.ts` next to every other hub cap).
 */

/** `POST /api/privacy/verify` — `{password}` → `200 {ok:true|false}`. LAN listener only; a
 * wrong password is `200 {ok:false}`, NEVER 401 (401 is the session-lost semantic that would
 * kick the UI into its `conn:"auth"` flow — plan v2 评审 #3). */
export const PRIVACY_VERIFY_PATH = "/api/privacy/verify";

/** `POST /api/privacy/lock` — `{agentKey, sessionId, locked, password?}` → `200 {ok:true}`.
 * `locked:true` needs no password (locking is not a sensitive operation); `locked:false` on
 * the LAN listener must carry an inline `password` verified on the spot (v2 评审 #2), on
 * loopback it must not (v2.1 N1). A `sessionId` that no longer matches the agent's CURRENT
 * `session.sessionId` is refused with `409 E_SESSION_CHANGED` (the preview ⑤ precedent — the
 * code is REUSED, `API_ERRORS` gains nothing). */
export const PRIVACY_LOCK_PATH = "/api/privacy/lock";

/** Request-body cap for both endpoints (plan: 体上限 LAN_LOGIN_BODY_BYTES) — mirrored from
 * `hub/http.ts`'s `LAN_LOGIN_BODY_BYTES` (4 KiB); a JSON body here is a few hundred bytes. */
export const PRIVACY_BODY_BYTES = 4 * 1024;

/** `privacy` SSE payload (plan「锁状态下发」): the FULL locked-sessionId set (it is tiny —
 * ≤4096 entries of a few dozen bytes), sent as a connect-burst snapshot BEFORE `agents` and
 * broadcast on every change. Direct-send only: never an `id:` field, never the replay ring. */
export interface PrivacyPayload {
  locked: string[];
}

/** `POST /api/privacy/verify` 200 body. */
export interface PrivacyVerifyResult {
  ok: boolean;
}

/** `POST /api/privacy/lock` 200 body — `ok:false` is the wrong-password verdict on a LAN
 * unlock (same never-401 discipline as verify). */
export interface PrivacyLockResult {
  ok: boolean;
}

/** `hub.json`'s `privacy` field shape (plan v2.1 P3): the hub writes it only when
 * `config.privacy === true` (feature off ⇒ key absent, hub.json byte-identical); `degraded`
 * mirrors `hub/privacy/store.ts`'s load-time flag (corrupt `privacy.json` ⇒ renamed `.bak`,
 * marks cleared). Read by the agent side's `/webhub status` (`agent/privacy-status.ts`) — it
 * lives HERE, in protocol/, because the agent layer may not import `../hub/**`. */
export interface PrivacyHubStatus {
  readonly degraded: boolean;
}
