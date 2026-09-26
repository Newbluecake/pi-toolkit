/**
 * LAN login pipeline, session cookie and session-check glue (plan §6.1,
 * §6.4, LC). Wires `LanStorePort` / `KdfPort` / `LoginLimiterPort` /
 * `KdfAdmissionPort` (all already resolved by the time `hub/http.ts`'s LAN
 * request handler calls in here) into the exact sequence §6.1 describes:
 * `limiter.admit` (saturation + per-IP backoff) → KDF fair-scheduling
 * admission → `kdf.run` → constant-work comparison → `finally` release →
 * success: `store.createSession` + `limiter.succeed`; failure:
 * `limiter.fail` + 401 (no reason disclosed, §6.1).
 *
 * Cookie: `pwh_lan` — distinct name and store from loopback's `pwh_sid`
 * (`hub/auth.ts`), so the two auth domains never collide (§6.4).
 */
import { timingSafeEqual } from "node:crypto";
import { readCookie } from "./auth.js";
import { validateKdfParams } from "./kdf.js";
import { hashSid } from "./sid-hash.js";
import type {
  KdfAdmissionPort,
  KdfParams,
  KdfPort,
  LanStorePort,
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

export function readLanCookie(cookieHeader: string | undefined): string | undefined {
  return readCookie(cookieHeader, LAN_SESSION_COOKIE);
}

// Fixed dummy scrypt params for the "no such user" branch (§5.1 "没有用户时用 dummy 记录") — a
// KDF run always happens, so a missing/wrong username is indistinguishable in timing from a
// wrong password. Never used to protect a real secret.
const DUMMY_SALT = new Uint8Array(16);
const DUMMY_PARAMS: KdfParams = { n: 32768, r: 8, p: 1, keyLen: 32, salt: DUMMY_SALT };

export interface LanLoginDeps {
  store: LanStorePort;
  kdf: KdfPort;
  limiter: LoginLimiterPort & { isFresh?(clientIp: string): boolean };
  admission: KdfAdmissionPort;
  /** LC review fix (lan-plan.md §15.9 #2): called (never awaited, never thrown) when a stored
   * user's KDF params fail §5.1's "读取校验" — the caller (`http.ts`) logs it tagged
   * `db-invalid:kdf` (never the plaintext password/hash). The login itself always still fails
   * closed with a plain 401 `E_AUTH` (§6.1 "不区分失败原因"); a dummy KDF run keeps the timing
   * profile identical to the unknown-user / wrong-password branches. */
  onCorruptKdfParams?: (username: string, reason: string) => void;
}

export type LanLoginOutcome =
  | { status: 200; cookie: string; initialPasswordInUse: boolean }
  | { status: 401 }
  | {
      status: 429;
      retryAfterMs: number;
      saturated?: boolean;
      /** LC review fix (lan-plan.md §15.9 #4): which gate produced this 429, so `http.ts` can pick
       * an `error` tag the frontend actually differentiates on (§10) — `"backoff"` (§6.2 per-IP
       * lockout, incl. its `saturated` sub-case) is a punitive lock the client must NOT auto-retry
       * without a user-visible countdown; `"admission"` (§6.2 KDF fair-scheduling queue full /
       * 20s wait timeout) is a transient capacity signal that is safe to auto-retry. */
      kind: "backoff" | "admission";
    };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Runs the full §6.1 login pipeline; `now`/`opts.signal` are threaded through to every port
 * call. Never throws for a "normal" bad-credentials outcome — only a port itself rejecting
 * (e.g. `E_DB`) propagates, which the caller (`http.ts`) maps to 503 per §2.5. */
export async function runLanLogin(
  ctx: RequestContext,
  body: unknown,
  deps: LanLoginDeps,
  now: number,
  opts?: { signal?: AbortSignal; onAdmitted?: () => void },
): Promise<LanLoginOutcome> {
  const admitResult = deps.limiter.admit(ctx.clientIp);
  if (!admitResult.ok) {
    return {
      status: 429,
      retryAfterMs: admitResult.retryAfterMs,
      kind: "backoff",
      ...(admitResult.saturated === true ? { saturated: true as const } : {}),
    };
  }

  const rawUsername =
    body !== null && typeof body === "object" ? (body as Record<string, unknown>).username : undefined;
  const rawPassword =
    body !== null && typeof body === "object" ? (body as Record<string, unknown>).password : undefined;
  const username = isNonEmptyString(rawUsername) ? rawUsername : undefined;
  const password = isNonEmptyString(rawPassword) ? rawPassword : "";
  const fresh = deps.limiter.isFresh?.(ctx.clientIp) ?? true;

  const admission = await deps.admission.acquire(ctx.clientIp, fresh, opts);
  if (!admission.ok) return { status: 429, retryAfterMs: admission.retryAfterMs, kind: "admission" };
  opts?.onAdmitted?.();
  try {
    const user = username === undefined ? undefined : await deps.store.getUser(username, opts);
    // §5.1 "读取校验" (LC review fix, lan-plan.md §15.9 #2): a stored record's KDF params must be
    // re-validated before they're ever fed to `scrypt` — a corrupted row (n/r/p out of range) could
    // otherwise turn a login attempt into a memory/time DoS. A dummy KDF run (same shape as the
    // "no such user" branch) keeps this indistinguishable in timing; the login still just 401s
    // (§6.1 "不区分失败原因") and the corruption is surfaced only via `onCorruptKdfParams` for logging.
    let corruptKdf = false;
    let params: KdfParams = DUMMY_PARAMS;
    if (user !== undefined) {
      const validity = validateKdfParams(user);
      if (validity.ok) {
        params = { n: user.n, r: user.r, p: user.p, keyLen: user.hash.length, salt: user.salt };
      } else {
        corruptKdf = true;
        deps.onCorruptKdfParams?.(user.username, validity.reason);
      }
    }
    const derived = await deps.kdf.run(password, params, opts);
    const matches =
      user !== undefined && !corruptKdf && derived.length === user.hash.length && timingSafeEqual(derived, user.hash);
    if (user === undefined || corruptKdf || !matches) {
      deps.limiter.fail(ctx.clientIp);
      return { status: 401 };
    }
    const session = await deps.store.createSession(
      { userId: user.id, epoch: user.epoch, boundOrigin: ctx.externalOrigin, createdIp: ctx.clientIp, now },
      opts,
    );
    deps.limiter.succeed(ctx.clientIp);
    const initialPasswordInUse = user.initialPassword !== undefined;
    if (initialPasswordInUse) await deps.store.markInitialLogin(user.username, ctx.clientIp, now, opts);
    return { status: 200, cookie: session.sid, initialPasswordInUse };
  } finally {
    admission.release();
  }
}

export interface LanSessionCheck {
  userId: number;
  epoch: number;
  sidHash: string;
}

/**
 * `touchSession` + the main-thread re-checks §4.2 requires: expiry (both the sliding and
 * absolute deadlines) and origin binding (§2.4/§6.4 — `bound_origin === ctx.externalOrigin`,
 * otherwise 401 *without* touching the session record).
 */
export async function checkLanSession(
  cookieHeader: string | undefined,
  ctx: RequestContext,
  store: LanStorePort,
  now: number,
  opts?: PortOptions,
): Promise<LanSessionCheck | undefined> {
  const sid = readLanCookie(cookieHeader);
  if (sid === undefined) return undefined;
  const sidHash = hashSid(sid);
  const rec = await store.touchSession(sidHash, now, opts);
  if (rec === undefined) return undefined;
  if (now >= Math.min(rec.expiresAt, rec.absoluteExpiresAt)) return undefined;
  if (rec.boundOrigin !== ctx.externalOrigin) return undefined;
  return { userId: rec.userId, epoch: rec.epoch, sidHash };
}
