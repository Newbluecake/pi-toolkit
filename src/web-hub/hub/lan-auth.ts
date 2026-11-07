/**
 * LAN login pipeline, session cookie and session-check glue (plan §6.1,
 * §6.4, LC). Wires `LanStorePort` / `KdfPort` / `LoginLimiterPort` /
 * `KdfAdmissionPort` (all already resolved by the time `hub/http.ts`'s LAN
 * request handler calls in here) into the exact sequence §6.1 describes:
 * `limiter.admit` (saturation + per-IP backoff) → KDF fair-scheduling
 * admission → `kdf.run` → constant-work comparison → `finally` release →
 * Login completion now lives exclusively in `lan-login.ts` (checked insertion).
 *
 * Cookie: `pwh_lan` — distinct name and store from loopback's `pwh_sid`
 * (`hub/auth.ts`), so the two auth domains never collide (§6.4).
 */
import { timingSafeEqual } from "node:crypto";
import { lanRecordValid, resolveCookieIdentity, type CookieResolution } from "./auth-identity.js";
import { dummyParams, KDF_LEGACY, kdfCost, padParamsFor, validateKdfParams } from "./kdf.js";
import { hashSid } from "./sid-hash.js";
import type {
  KdfAdmissionPort,
  KdfParams,
  KdfPolicy,
  KdfPort,
  LanSessionRecord,
  LanStorePort,
  LanUserRecord,
  LoginLimiterPort,
  PortOptions,
  RequestContext,
} from "./ports.js";

export const LAN_SESSION_COOKIE = "pwh_lan";

/** `sha256(sid)`, base64url (§6.4 "库中只存 sha256(sid)"); re-exported from the shared
 * `hub/sid-hash.ts` helper (LC review fix, lan-plan.md §15.9 item 5) so existing importers of
 * `hashSid` from this module keep working unchanged. */
export { hashSid };

export function formatLanCookie(value: string, opts: { secure: boolean; clear?: boolean }): string {
  const base = `${LAN_SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/`;
  const secureAttr = opts.secure ? "; Secure" : "";
  return opts.clear === true ? `${base}${secureAttr}; Max-Age=0` : `${base}${secureAttr}`;
}

export interface LanLoginDeps {
  store: LanStorePort;
  kdf: KdfPort;
  limiter: LoginLimiterPort & { isFresh?(clientIp: string): boolean };
  admission: KdfAdmissionPort;
  /** #66: the shape every verification is timed against; absent ⇒ `KDF_LEGACY` (v0.10 behaviour). */
  kdfPolicy?: KdfPolicy;
  /** LC review fix (lan-plan.md §15.9 #2): called (never awaited, never thrown) when a stored
   * user's KDF params fail §5.1's "读取校验" — the caller (`http.ts`) logs it tagged
   * `db-invalid:kdf` (never the plaintext password/hash). The login itself always still fails
   * closed with a plain 401 `E_AUTH` (§6.1 "不区分失败原因"); a dummy KDF run keeps the timing
   * profile identical to the unknown-user / wrong-password branches. */
  onCorruptKdfParams?: (username: string, reason: string) => void;
}

/** The KDF half of the §6.1 pipeline, shared verbatim by login and privacy-verify
 * (web-hub-privacy plan v2.1「校验管线」): §5.1 "读取校验" on the stored params (corrupt ⇒
 * dummy run + `onCorruptKdfParams` + mismatch verdict), a real KDF run either way (a missing
 * user runs the DUMMY params so the timing profile never discloses user existence), and a
 * constant-time compare. #66 D6: every path costs `cost(verifyTarget)` — unknown/corrupt ⇒ one
 * dummy run at the verify target; a valid record cheaper than the target ⇒ ONE padded run
 * (real + compensation in a single pool slot); a record at/above the target ⇒ a plain run. Caller owns the KDF admission slot (acquire/release) and the limiter
 * accounting. */
export async function kdfMatches(
  user: LanUserRecord | undefined,
  password: string,
  deps: LanLoginDeps,
  opts?: PortOptions,
): Promise<boolean> {
  const target = deps.kdfPolicy?.verifyTarget ?? KDF_LEGACY;
  let corruptKdf = false;
  let params: KdfParams = dummyParams(target);
  let pad: KdfParams | undefined;
  if (user !== undefined) {
    const validity = validateKdfParams(user);
    if (validity.ok) {
      params = { n: user.n, r: user.r, p: user.p, keyLen: user.hash.length, salt: user.salt };
      if (kdfCost(user) < kdfCost(target)) pad = padParamsFor(user, target);
    } else {
      corruptKdf = true;
      deps.onCorruptKdfParams?.(user.username, validity.reason);
    }
  }
  let derived: Uint8Array;
  if (pad === undefined) {
    derived = await deps.kdf.run(password, params, opts);
  } else if (deps.kdf.runPadded !== undefined) {
    derived = await deps.kdf.runPadded(password, params, pad, opts);
  } else {
    // Legacy fakes without `runPadded` (tests only): two plain runs, real result first.
    derived = await deps.kdf.run(password, params, opts);
    await deps.kdf.run(password, pad, opts);
  }
  return (
    user !== undefined && !corruptKdf && derived.length === user.hash.length && timingSafeEqual(derived, user.hash)
  );
}

// ---------------------------------------------------------------------------
// web-hub-privacy plan v2.1「校验管线」(P1): stateless password re-verification for an
// ALREADY-authenticated LAN session (view-unlock + LAN-side unlock of a privacy mark).
// ---------------------------------------------------------------------------

export type LanVerifyOutcome =
  | { status: 200; ok: boolean }
  | {
      status: 429;
      retryAfterMs: number;
      saturated?: boolean;
      /** Same split as the login core's 429 (backoff lockout vs KDF admission queue) — the
       * route maps it to the same `E_LOCKED`/`E_RATE` wire codes the login handler uses. */
      kind: "backoff" | "admission";
    };

/**
 * Shared with the checked login core (plan「接口」评审 #3): verify the CURRENT session user's LAN
 * password — 会话取 userId → `getUserSummary(userId)` 取 username → `getUser` → 共用 KDF
 * admission → 比对. Deliberate differences from login:
 *
 * - **No session is created** (stateless check) and no cookie is touched.
 * - **Shares the per-IP login limiter** (`limiter.admit` gates, `limiter.fail` counts a wrong
 *   password toward the SAME backoff as failed logins — same credential, same strength), but a
 *   SUCCESS never calls `limiter.succeed()` (复审 N-3: an unlock success must not reset the
 *   login backoff an attacker is currently accumulating against the same account).
 * - The verdict is `200 {ok:false}` material, never a 401 — the ROUTE owns that mapping
 *   (`hub/privacy/routes.ts`); a port rejection (`E_DB`…) propagates exactly like login's.
 */
export async function verifyPassword(
  ctx: Pick<RequestContext, "clientIp">,
  userId: number,
  password: string,
  deps: LanLoginDeps,
  opts?: { signal?: AbortSignal; onAdmitted?: () => void },
): Promise<LanVerifyOutcome> {
  const admitResult = deps.limiter.admit(ctx.clientIp);
  if (!admitResult.ok) {
    return {
      status: 429,
      retryAfterMs: admitResult.retryAfterMs,
      kind: "backoff",
      ...(admitResult.saturated === true ? { saturated: true as const } : {}),
    };
  }
  const fresh = deps.limiter.isFresh?.(ctx.clientIp) ?? true;
  const admission = await deps.admission.acquire(ctx.clientIp, fresh, opts);
  if (!admission.ok) return { status: 429, retryAfterMs: admission.retryAfterMs, kind: "admission" };
  opts?.onAdmitted?.();
  try {
    const summary = await deps.store.getUserSummary(userId, opts);
    const user = summary === undefined ? undefined : await deps.store.getUser(summary.username, opts);
    const matches = await kdfMatches(user, password, deps, opts);
    if (!matches) {
      deps.limiter.fail(ctx.clientIp);
      return { status: 200, ok: false };
    }
    return { status: 200, ok: true }; // deliberately NO limiter.succeed() — see doc comment
  } finally {
    admission.release();
  }
}

export interface LanSessionCheck {
  userId: number;
  epoch: number;
  sidHash: string;
  /** The raw store record's absolute ceiling — together with `expiresAt` the parent expiry. */
  absoluteExpiresAt: number;
}

/**
 * The single LAN session resolution used by `checkLanSession` (web-hub-proxy plan §4.1): resolves
 * the `pwh_lan` cookie ONCE through `resolveCookieIdentity` — `touchSession` + the main-thread
 * re-checks §4.2 requires: expiry (both the sliding and absolute deadlines) and origin binding
 * (§2.4/§6.4 — `bound_origin === ctx.externalOrigin`, otherwise invalid *without* touching the
 * session record). `maxCandidates` (default 1 ⇒ first cookie value, byte-identical to pre-XA) > 1
 * enables the multi-candidate path (≤ one `touchSession` per distinct candidate).
 */
export function resolveLanSession(
  cookieHeader: string | undefined,
  ctx: Pick<RequestContext, "externalOrigin">,
  store: Pick<LanStorePort, "touchSession">,
  now: number,
  opts?: PortOptions & { maxCandidates?: number },
): Promise<CookieResolution<{ rec: LanSessionRecord; sidHash: string }>> {
  const portOpts: PortOptions | undefined = opts?.signal === undefined ? undefined : { signal: opts.signal };
  return resolveCookieIdentity(cookieHeader, LAN_SESSION_COOKIE, opts?.maxCandidates ?? 1, async (sid) => {
    const sidHash = hashSid(sid);
    const rec = await store.touchSession(sidHash, now, portOpts);
    if (rec === undefined || !lanRecordValid(rec, now, ctx.externalOrigin)) return undefined;
    return { rec, sidHash };
  });
}

/** Legacy shape of `resolveLanSession`: a conflict (multi-candidate mode only) is "not authenticated". */
export async function checkLanSession(
  cookieHeader: string | undefined,
  ctx: RequestContext,
  store: LanStorePort,
  now: number,
  opts?: PortOptions & { maxCandidates?: number },
): Promise<LanSessionCheck | undefined> {
  const r = await resolveLanSession(cookieHeader, ctx, store, now, opts);
  if (r.kind !== "one") return undefined;
  const { rec, sidHash } = r.rec;
  return { userId: rec.userId, epoch: rec.epoch, sidHash, absoluteExpiresAt: rec.absoluteExpiresAt };
}
