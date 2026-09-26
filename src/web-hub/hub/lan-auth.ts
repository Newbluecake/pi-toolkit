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
import { createHash, timingSafeEqual } from "node:crypto";
import { readCookie } from "./auth.js";
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

/** `sha256(sid)`, base64url — must match `LanStorePort`'s own internal hashing convention
 * (`tests/web-hub/contract/fakes.ts`'s `fakeLanStore` uses the identical scheme; the real S1
 * store (LS) is expected to follow §6.4's "库中只存 sha256(sid)" the same way). */
export function hashSid(sid: string): string {
  return createHash("sha256").update(sid).digest("base64url");
}

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
}

export type LanLoginOutcome =
  | { status: 200; cookie: string; initialPasswordInUse: boolean }
  | { status: 401 }
  | { status: 429; retryAfterMs: number; saturated?: boolean };

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
  if (!admission.ok) return { status: 429, retryAfterMs: admission.retryAfterMs };
  opts?.onAdmitted?.();
  try {
    const user = username === undefined ? undefined : await deps.store.getUser(username, opts);
    const params: KdfParams =
      user === undefined
        ? DUMMY_PARAMS
        : { n: user.n, r: user.r, p: user.p, keyLen: user.hash.length, salt: user.salt };
    const derived = await deps.kdf.run(password, params, opts);
    const matches = user !== undefined && derived.length === user.hash.length && timingSafeEqual(derived, user.hash);
    if (user === undefined || !matches) {
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
