/**
 * One identity-resolution API for the hub's two session cookies (web-hub-proxy plan v2 §4.1,
 * package XA). The session cookie is resolved ONCE per request into a single result; every
 * consumer (auth gate, principal for rate-limit keys, HTML-preview `sidTag`, logout, LAN
 * `userId`) takes its fields from that result — nothing re-parses `Cookie` after authentication.
 *
 * This module is the ONLY place in `hub/` that parses `Cookie` headers (pinned by
 * `tests/web-hub/http/auth-identity.test.ts`'s source scan). It is pi-free and holds no state.
 *
 * Duplicate-cookie handling (§4.1 "Candidates"):
 * - `max === 1` (the default everywhere, and the ONLY mode while the proxy is not wired): the
 *   FIRST same-name pair wins, an empty first value means "no cookie" — byte-identical to the
 *   pre-XA `readCookie`.
 * - `max > 1` (opt-in, flipped by the proxy package through the frontend's `multiCandidateAuth`
 *   option): every distinct non-empty value is a candidate. Exactly one distinct VALID identity ⇒
 *   use it (invalid candidates are ignored); ≥ 2 distinct valid identities, or more distinct
 *   candidates than `max` ⇒ `conflict` (the caller answers 401 + best-effort clearing
 *   `Set-Cookie` lines, see `clearingSetCookies`). Exact duplicate values collapse first (the same
 *   sid presented under a host-only and a `Domain=` cookie is one identity).
 */
import type { LanSessionRecord } from "./ports.js";

/** Cookie-candidate caps when multi-candidate mode is on (§4.1). LAN is small because each
 * candidate costs one shared `touchSession` IPC. */
export const LOOPBACK_COOKIE_MAX = 8;
export const LAN_COOKIE_MAX = 3;
/** Reserved for the proxy gate cookie (later package). */
export const PROXY_GATE_COOKIE_MAX = 4;
/** `clearingSetCookies` bounds: ≤ 8 path prefixes × {host-only, Domain=<host>} ⇒ ≤ 16 lines. */
export const CLEAR_COOKIE_MAX_PREFIXES = 8;

/** The reason string the conflict 401 carries (`{ error: "E_AUTH", reason }`). */
export const COOKIE_CONFLICT_REASON = "cookie-conflict";

/** The LAN half of a resolved LAN identity (what `requireLanSession` already returned). */
export interface LanSessionResult {
  userId: number;
  epoch: number;
  sidHash: string;
  /** §4.2 review fix (LC #1): threaded through so `/api/events` can arm `scheduleAbsoluteExpiry`. */
  absoluteExpiresAt: number;
}

export interface AuthIdentity {
  listener: "loopback" | "lan";
  /** loopback: the session's `sidTag` (never the raw sid); LAN: `u<userId>`. */
  principal: string;
  /** `sha256(sid)` base64url — the revocation / preview-cap session tag. */
  sidTag: string;
  /** LAN only. */
  userId?: number;
  /** Hard end of the parent login: loopback = sliding expiry after this resolve; LAN =
   * `min(expiresAt, absoluteExpiresAt)`. */
  parentExpiresAt: number;
  /** loopback only, never leaves the hub process. */
  sid?: string;
  /** LAN only. */
  lan?: LanSessionResult;
}

export type IdentityResult =
  { ok: true; id: AuthIdentity } | { ok: false; code: "E_AUTH" | "E_DB" | "E_RATE"; conflict?: true };

export type CookieResolution<T> =
  /** `candidates` = number of distinct values presented (0 ⇒ no cookie at all). */
  | { kind: "none"; candidates: number }
  | { kind: "one"; value: string; rec: T }
  | { kind: "conflict"; why: "multiple" | "overflow" };

/** Extract one cookie value from a `Cookie:` header (first match wins; an empty first value ⇒ `undefined`). */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined || cookieHeader.length === 0) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * The distinct non-empty values of every `name=` pair, in header order. `max <= 1` is the legacy
 * first-value rule (`readCookie`); `overflow` is true when there are more distinct values than
 * `max` (the values list is then truncated to `max`, but callers treat overflow as a conflict
 * without validating anything).
 */
export function cookieCandidates(
  cookieHeader: string | undefined,
  name: string,
  max: number,
): { values: string[]; overflow: boolean } {
  if (max <= 1) {
    const v = readCookie(cookieHeader, name);
    return { values: v === undefined ? [] : [v], overflow: false };
  }
  const values: string[] = [];
  if (cookieHeader === undefined || cookieHeader.length === 0) return { values, overflow: false };
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (value.length === 0 || values.includes(value)) continue;
    values.push(value);
  }
  const overflow = values.length > max;
  return { values: overflow ? values.slice(0, max) : values, overflow };
}

/**
 * Async resolver (LAN: `validate` is a `touchSession` IPC). `validate` returns the validated
 * record, or `undefined` for an invalid candidate; a THROW aborts the whole resolution (fail
 * closed — the caller maps it to its own 429/503). Validation stops as soon as a second distinct
 * valid candidate is seen (conflict is decided; no further IPC is spent).
 */
export async function resolveCookieIdentity<T>(
  cookieHeader: string | undefined,
  name: string,
  max: number,
  validate: (value: string, index: number) => T | undefined | Promise<T | undefined>,
): Promise<CookieResolution<T>> {
  const { values, overflow } = cookieCandidates(cookieHeader, name, max);
  if (overflow) return { kind: "conflict", why: "overflow" };
  let found: { value: string; rec: T } | undefined;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    const rec = await validate(value, i);
    if (rec === undefined) continue;
    if (found !== undefined) return { kind: "conflict", why: "multiple" };
    found = { value, rec };
  }
  return found === undefined ? { kind: "none", candidates: values.length } : { kind: "one", ...found };
}

/** Synchronous twin (loopback: `validate` is a Map lookup). Same semantics as `resolveCookieIdentity`. */
export function resolveCookieIdentitySync<T>(
  cookieHeader: string | undefined,
  name: string,
  max: number,
  validate: (value: string, index: number) => T | undefined,
): CookieResolution<T> {
  const { values, overflow } = cookieCandidates(cookieHeader, name, max);
  if (overflow) return { kind: "conflict", why: "overflow" };
  let found: { value: string; rec: T } | undefined;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    const rec = validate(value, i);
    if (rec === undefined) continue;
    if (found !== undefined) return { kind: "conflict", why: "multiple" };
    found = { value, rec };
  }
  return found === undefined ? { kind: "none", candidates: values.length } : { kind: "one", ...found };
}

/** The LAN session validity rule (§4.2): both the sliding and the absolute deadline, plus origin binding. */
export function lanRecordValid(rec: LanSessionRecord, now: number, externalOrigin: string): boolean {
  if (now >= Math.min(rec.expiresAt, rec.absoluteExpiresAt)) return false;
  return rec.boundOrigin === externalOrigin;
}

export function loopbackIdentity(r: { sid: string; sidTag: string; expiresAt: number }): AuthIdentity {
  return {
    listener: "loopback",
    principal: r.sidTag,
    sidTag: r.sidTag,
    parentExpiresAt: r.expiresAt,
    sid: r.sid,
  };
}

export function lanIdentity(
  lan: LanSessionResult,
  rec: Pick<LanSessionRecord, "expiresAt" | "absoluteExpiresAt">,
): AuthIdentity {
  return {
    listener: "lan",
    principal: `u${lan.userId}`,
    sidTag: lan.sidHash,
    userId: lan.userId,
    parentExpiresAt: Math.min(rec.expiresAt, rec.absoluteExpiresAt),
    lan,
  };
}

/** `/a/b/c` → `["/", "/a", "/a/b", "/a/b/c"]` (query/fragment ignored), capped at `CLEAR_COOKIE_MAX_PREFIXES`. */
export function pathPrefixes(requestUrl: string): string[] {
  const cut = requestUrl.search(/[?#]/);
  const path = cut < 0 ? requestUrl : requestUrl.slice(0, cut);
  const out = ["/"];
  let acc = "";
  for (const seg of path.split("/")) {
    if (seg.length === 0) continue;
    acc += `/${seg}`;
    if (out.length >= CLEAR_COOKIE_MAX_PREFIXES) break;
    out.push(acc);
  }
  return out;
}

/** The host part of a `Host` header (port stripped); `undefined` for IPv6 literals / junk (no `Domain=` line). */
function domainOf(hostHeader: string | undefined): string | undefined {
  if (hostHeader === undefined) return undefined;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return undefined;
  const colon = h.indexOf(":");
  const host = colon < 0 ? h : h.slice(0, colon);
  return /^[a-z0-9.-]+$/.test(host) && host.length > 0 ? host : undefined;
}

/**
 * BEST-EFFORT clearing `Set-Cookie` lines for a conflicting cookie `name` (§4.1/§R2 #4): one
 * `Max-Age=0` line per directory-segment path prefix of the request path × {host-only,
 * `Domain=<host>`} (≤ 16 lines). A shadow cookie with a non-segment `Path` (`/ap` for `/api`) or a
 * parent-domain `Domain=` cannot be named by these lines, so re-login is NOT guaranteed to recover —
 * the UI carries manual-recovery copy.
 */
export function clearingSetCookies(
  name: string,
  requestUrl: string,
  hostHeader: string | undefined,
  opts: { secure: boolean },
): string[] {
  const domain = domainOf(hostHeader);
  const secure = opts.secure ? "; Secure" : "";
  const lines: string[] = [];
  for (const p of pathPrefixes(requestUrl)) {
    const base = `${name}=; HttpOnly; SameSite=Strict; Path=${p}; Max-Age=0${secure}`;
    lines.push(base);
    if (domain !== undefined) lines.push(`${base}; Domain=${domain}`);
  }
  return lines;
}
