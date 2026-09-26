/**
 * `LoginLimiterPort` implementation (plan §6.2, LC): per-IP exponential
 * backoff, a global 10-minute failure count driving a hysteretic "tightened"
 * mode, and a 24h taint memory whose exhaustion is the saturation gate for
 * *unseen* addresses. All state lives in the `createLoginLimiter` closure.
 *
 * The concrete return type (`LoginLimiter`) adds `isFresh` on top of the
 * frozen `LoginLimiterPort` shape — `hub/ports.ts`'s `admit()` signature has
 * no channel to report per-IP freshness, but `hub/kdf-admission.ts`'s fair
 * scheduler needs it (§6.2 "两个类别分开: fresh 4 个保留席位, tainted 24
 * 个") and `hub/lan-auth.ts` is the one call site that owns both. `isFresh`
 * is declared *optional* on the narrower type callers actually consume
 * (`LoginLimiterPort & { isFresh?(ip): boolean }`) so a `LanFrontendDeps.
 * limiter` typed as the plain port (any other `LoginLimiterPort`
 * implementation, including `fakes.ts`'s `fakeLoginLimiter`) is still
 * structurally assignable — callers fall back to treating an unknown limiter
 * as "fresh" (§6.2's less-restrictive category) when the method is absent.
 */
import type { LoginLimiterPort } from "./ports.js";

export interface LoginLimiter extends LoginLimiterPort {
  /** Not in `tainted` (§6.2 "新鲜 = 不在 tainted 中"). Exposed for `kdf-admission.ts`'s fair
   * scheduler; not part of the frozen `LoginLimiterPort` surface. */
  isFresh(clientIp: string): boolean;
  /** Global hysteretic mode (§6.2 "> 50 次 ⇒ 收紧；< 25 ⇒ 退出"), read by `kdf-admission.ts`'s
   * token-bucket refill rate. */
  isTightened(): boolean;
}

export const RATE_LIMIT = {
  windowMs: 15 * 60_000,
  freeFailuresNormal: 5,
  freeFailuresTightened: 1,
  baseBackoffNormalMs: 30_000,
  baseBackoffTightenedMs: 60_000,
  maxBackoffMs: 15 * 60_000,
  globalWindowMs: 10 * 60_000,
  tightenAboveFailures: 50,
  loosenBelowFailures: 25,
  taintTtlMs: 24 * 3_600_000,
  taintCap: 4096,
  backoffTableCap: 4096,
  saturatedRetryAfterMs: 60_000,
} as const;

interface BackoffEntry {
  failCount: number;
  lockedUntil: number;
  lastFailAt: number;
}

export function createLoginLimiter(deps: { now: () => number }): LoginLimiter {
  const { now } = deps;
  const backoff = new Map<string, BackoffEntry>(); // insertion order ≈ age, capped at 4096
  const tainted = new Map<string, number>(); // ip → expiresAt (24h), capped at 4096, never evicted
  const globalFailures: number[] = []; // recent failure timestamps, pruned to the 10-min window
  let tightened = false;

  function pruneGlobal(t: number): void {
    while (globalFailures.length > 0 && t - globalFailures[0]! >= RATE_LIMIT.globalWindowMs) globalFailures.shift();
  }

  function pruneTaint(t: number): void {
    for (const [ip, exp] of tainted) if (exp <= t) tainted.delete(ip);
  }

  function isFresh(clientIp: string): boolean {
    pruneTaint(now());
    return !tainted.has(clientIp);
  }

  function isTightened(): boolean {
    return tightened;
  }

  function admit(clientIp: string): { ok: true } | { ok: false; retryAfterMs: number; saturated?: boolean } {
    const t = now();
    pruneTaint(t);
    const entry = backoff.get(clientIp);
    if (entry !== undefined && entry.lockedUntil > t) {
      return { ok: false, retryAfterMs: entry.lockedUntil - t };
    }
    if (!tainted.has(clientIp) && tainted.size >= RATE_LIMIT.taintCap) {
      return { ok: false, retryAfterMs: RATE_LIMIT.saturatedRetryAfterMs, saturated: true };
    }
    return { ok: true };
  }

  function evictOldestBackoffIfFull(clientIp: string): void {
    if (backoff.has(clientIp) || backoff.size < RATE_LIMIT.backoffTableCap) return;
    let victim: string | undefined;
    let victimEntry: BackoffEntry | undefined;
    for (const [ip, e] of backoff) {
      if (victimEntry === undefined || e.lockedUntil < victimEntry.lockedUntil) {
        victim = ip;
        victimEntry = e;
      }
    }
    if (victim !== undefined) backoff.delete(victim);
  }

  function fail(clientIp: string): void {
    const t = now();
    pruneTaint(t);
    if (tainted.size < RATE_LIMIT.taintCap || tainted.has(clientIp)) {
      tainted.set(clientIp, t + RATE_LIMIT.taintTtlMs);
    }
    globalFailures.push(t);
    pruneGlobal(t);
    if (globalFailures.length > RATE_LIMIT.tightenAboveFailures) tightened = true;
    else if (globalFailures.length < RATE_LIMIT.loosenBelowFailures) tightened = false;

    evictOldestBackoffIfFull(clientIp);
    const entry = backoff.get(clientIp) ?? { failCount: 0, lockedUntil: 0, lastFailAt: t };
    entry.failCount++;
    entry.lastFailAt = t;
    const freeFailures = tightened ? RATE_LIMIT.freeFailuresTightened : RATE_LIMIT.freeFailuresNormal;
    if (entry.failCount > freeFailures) {
      const base = tightened ? RATE_LIMIT.baseBackoffTightenedMs : RATE_LIMIT.baseBackoffNormalMs;
      const k = entry.failCount - freeFailures - 1;
      entry.lockedUntil = t + Math.min(RATE_LIMIT.maxBackoffMs, base * 2 ** k);
    } else {
      entry.lockedUntil = t;
    }
    backoff.set(clientIp, entry);
  }

  function succeed(clientIp: string): void {
    backoff.delete(clientIp);
    tainted.delete(clientIp);
  }

  function unlock(): void {
    backoff.clear();
    tainted.clear();
    globalFailures.length = 0;
    tightened = false;
  }

  return { admit, fail, succeed, unlock, isFresh, isTightened };
}
