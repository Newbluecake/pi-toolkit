/**
 * hub HTTP auth (plan §包 C): a single long-lived bearer token on disk
 * (`<stateDir>/token`, created `wx` + 0600) is exchanged once for a
 * server-side session id carried in an `HttpOnly; SameSite=Strict` cookie.
 *
 * - token: 32 random bytes, base64url. A token file whose mode is wider than
 *   0600 is repaired (chmod) and logged; an unreadable/corrupt one is rewritten.
 * - login: sha256 both sides then `timingSafeEqual` (equal-length digests ⇒
 *   no length oracle); at most 5 failures per rolling 60 s window, after which
 *   every attempt (even a correct one) is refused with `E_RATE`.
 * - sessions: in-memory `sid → expiresAt`, 12 h sliding, bounded count.
 *
 * All state lives in the `createAuth` closure (no module-level mutable state).
 */
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { HubLog } from "./ports.js";
import { cleanupTokenTemps, replaceTokenAtomic } from "../protocol/token-file.js";

export interface Auth {
  token(): string;
  /** Re-read the complete token file after recovery/atomic replacement. */
  reload(): string;
  /** Rotate the bearer token and invalidate every loopback session. */
  rotateToken(): { token: string; revoked: number };
  revokeAllSessions(): number;
  authGen(): number;
  login(candidate: unknown, now: number): { ok: true; sid: string } | { ok: false; code: "E_AUTH" | "E_RATE" };
  check(cookieHeader: string | undefined, now: number): boolean;
  logout(sid: string): void;
}

export const SESSION_COOKIE = "pwh_sid";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 60_000;
const MAX_SESSIONS = 1024;
const MIN_TOKEN_CHARS = 16;
const MAX_CANDIDATE_CHARS = 1024;

/** Extract one cookie value from a `Cookie:` header (first match wins). */
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

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

export function createAuth(opts: { tokenFile: string; randomBytes?: (n: number) => Buffer; log: HubLog }): Auth {
  const rand = opts.randomBytes ?? nodeRandomBytes;
  const { tokenFile, log } = opts;
  let cached: string | undefined;
  let cachedDigest: Buffer | undefined;
  let generation = 0;
  const failures: number[] = []; // timestamps of recent failed logins
  const sessions = new Map<string, number>(); // sid → expiresAt (insertion order ≈ age)

  function newToken(): string {
    return rand(32).toString("base64url");
  }

  function writeFresh(): string {
    const value = newToken();
    replaceTokenAtomic(tokenFile, value);
    return value;
  }

  function loadToken(): string {
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
    let st;
    try {
      st = statSync(tokenFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const value = writeFresh();
      log.info("web-hub token created", { file: tokenFile });
      return value;
    }
    if ((st.mode & 0o077) !== 0) {
      chmodSync(tokenFile, 0o600);
      log.warn("web-hub token file mode too wide; fixed to 0600", {
        file: tokenFile,
        mode: (st.mode & 0o777).toString(8),
      });
    }
    let value = "";
    try {
      value = readFileSync(tokenFile, "utf8").trim();
    } catch {
      /* corrupt/unreadable is regenerated below */
    }
    if (value.length < MIN_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) {
      log.warn("web-hub token file corrupt; regenerated", { file: tokenFile });
      return writeFresh();
    }
    return value;
  }

  function token(): string {
    if (cached === undefined) {
      cleanupTokenTemps(tokenFile);
      cached = loadToken();
      cachedDigest = sha256(cached);
    }
    return cached;
  }

  function reload(): string {
    cached = undefined;
    cachedDigest = undefined;
    return token();
  }

  function revokeAllSessions(): number {
    const n = sessions.size;
    sessions.clear();
    generation++;
    return n;
  }

  function rotateToken(): { token: string; revoked: number } {
    const next = newToken();
    replaceTokenAtomic(tokenFile, next);
    cached = next;
    cachedDigest = sha256(next);
    return { token: next, revoked: revokeAllSessions() };
  }

  function pruneFailures(now: number): void {
    while (failures.length > 0 && now - failures[0]! >= LOGIN_WINDOW_MS) failures.shift();
  }

  function pruneSessions(now: number): void {
    for (const [sid, exp] of sessions) if (exp <= now) sessions.delete(sid);
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done === true) break;
      sessions.delete(oldest.value);
    }
  }

  function login(
    candidate: unknown,
    now: number,
  ): { ok: true; sid: string } | { ok: false; code: "E_AUTH" | "E_RATE" } {
    pruneFailures(now);
    if (failures.length >= LOGIN_MAX_FAILURES) return { ok: false, code: "E_RATE" };
    token();
    const expected = cachedDigest!;
    // Non-string / oversized candidates still take the same compare path.
    const text = typeof candidate === "string" && candidate.length <= MAX_CANDIDATE_CHARS ? candidate : "";
    const match = timingSafeEqual(sha256(text), expected) && text.length > 0;
    if (!match) {
      failures.push(now);
      log.warn("web-hub login failed", { recentFailures: failures.length });
      return { ok: false, code: "E_AUTH" };
    }
    pruneSessions(now);
    const sid = rand(32).toString("base64url");
    sessions.set(sid, now + SESSION_TTL_MS);
    return { ok: true, sid };
  }

  function check(cookieHeader: string | undefined, now: number): boolean {
    const sid = readCookie(cookieHeader, SESSION_COOKIE);
    if (sid === undefined) return false;
    const exp = sessions.get(sid);
    if (exp === undefined) return false;
    if (exp <= now) {
      sessions.delete(sid);
      return false;
    }
    // sliding expiry: re-insert so Map order tracks recency for the size cap
    sessions.delete(sid);
    sessions.set(sid, now + SESSION_TTL_MS);
    return true;
  }

  function logout(sid: string): void {
    sessions.delete(sid);
  }

  return { token, reload, rotateToken, revokeAllSessions, authGen: () => generation, login, check, logout };
}
