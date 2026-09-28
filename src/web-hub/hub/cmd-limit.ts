/**
 * hub command rate limiting (plan §6.5, C3): a plain in-memory token bucket keyed by an
 * arbitrary caller-chosen bucket name (`hub/http.ts` composes the key from
 * `${listener}:${principal-ish}:${category}` / `${agentKey}`, per §6.5's table — this module has
 * no opinion on what a "bucket" represents, it just refills/spends tokens for whatever string key
 * it is given). Pure, `now()`-injected (fake-clock friendly); a bucket that has never been spent
 * from costs nothing to create (lazy) and is evicted (oldest-first) once the map grows past a
 * generous cap so a churn of many distinct LAN users/agents over a long-lived hub process cannot
 * leak memory unbounded.
 */
export interface CmdLimit {
  /** Spends one token from `bucket` (capacity `capacity`, refilling one token every `refillMs`).
   * Never throws. A rejected admission does not spend a token (§6.5 "幂等命中不扣令牌" is enforced
   * by the *caller* simply not calling `admit()` on a cache-hit path — this function has no idea
   * what a "dup" is). */
  admit(bucket: string, capacity: number, refillMs: number): { ok: true } | { ok: false; retryAfterMs: number };
}

interface Bucket {
  tokens: number;
  /** Wall-clock instant the bucket's token count was last true (i.e. as if it had refilled
   * exactly up to `tokens` at this instant) — advances by whole `refillMs` steps only, so unspent
   * fractional time is never lost across repeated small refills. */
  at: number;
}

const MAX_BUCKETS = 4_096;
const EVICT_BATCH = 256;

export function createCmdLimit(now: () => number = Date.now): CmdLimit {
  const buckets = new Map<string, Bucket>();

  function evictIfNeeded(): void {
    if (buckets.size <= MAX_BUCKETS) return;
    let n = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++n >= EVICT_BATCH) break;
    }
  }

  return {
    admit(bucket, capacity, refillMs) {
      const t = now();
      let b = buckets.get(bucket);
      if (b === undefined) {
        b = { tokens: capacity, at: t };
        buckets.set(bucket, b);
        evictIfNeeded();
      } else if (refillMs > 0) {
        const elapsed = t - b.at;
        if (elapsed >= refillMs) {
          const refills = Math.floor(elapsed / refillMs);
          b.tokens = Math.min(capacity, b.tokens + refills);
          b.at += refills * refillMs;
        }
      }
      if (b.tokens <= 0) {
        const retryAfterMs = refillMs <= 0 ? 0 : Math.max(0, refillMs - (t - b.at));
        return { ok: false, retryAfterMs };
      }
      b.tokens--;
      return { ok: true };
    },
  };
}
