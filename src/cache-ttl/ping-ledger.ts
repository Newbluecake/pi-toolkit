/**
 * Child-session keepalive ping admission ledger (child-ka-core plan.md §2.4/§7 P1).
 *
 * A process-wide, `Symbol.for`-backed singleton (same pattern as
 * `src/bash/child-registry.ts` / `src/core/worktree-origin.ts`) that owns the
 * two guardrails that must be shared across every child session's own
 * `CacheKeepaliveService` instance in this process:
 *
 *   - a concurrent-ping SLOT cap (`maxConcurrent`, plan default 4) — the
 *     total number of in-flight ping sequences across ALL child sessions at
 *     any instant;
 *   - a rolling 24h process-wide $ BUDGET (`processBudgetUsd`, plan default
 *     $10) — the total actually-charged spend across all child sessions in
 *     the trailing 24 hours.
 *
 * Deliberately pi-free (no pi imports) and holds no implicit clock: every
 * method takes `now: Millis` explicitly (AGENTS.md hard rule). Unlike the
 * PURE reducers in `keepalive-state.ts`, this module IS a stateful object —
 * the concurrency/budget guarantee is inherently about mutable shared state,
 * not a per-call decision — but it stays synchronous and side-effect-free
 * beyond its own bookkeeping (never calls `fetch`, never awaits anything).
 *
 * No module-scope mutable state (AGENTS.md: the extension re-activates on
 * `/reload` without busting Node's module cache) — the ledger singleton
 * lives behind `CHILD_KEEPALIVE_LEDGER_KEY` on `globalThis`, built lazily by
 * `getChildKeepaliveLedger()` and never reset (a `/reload` must not forget
 * outstanding leases or budget history for sessions still alive across it).
 * `createChildKeepaliveLedger()` is also exported directly for tests that
 * want an isolated instance instead of the shared process singleton.
 */

import type { Millis } from "../core/types.js";

export const CHILD_KEEPALIVE_LEDGER_KEY = Symbol.for("pi-subagent:child-keepalive-ledger");

/**
 * Worst-case single ping sequence duration (plan.md §2.4): auth await ≤
 * `authTimeoutMs` (30s) + up to 3 HTTP attempts × 20s hard timeout each +
 * backoff (2s + 5s) ≈ 97s. 150s = 97s + ~53s margin (~1.5×) — purely a
 * defensive backstop against a holder that never calls `settle()` (which
 * should never happen on the happy or any known error path; every exit of
 * `runPing` is wrapped in a `finally` that settles). NOT a settings key on
 * purpose (AGENTS.md-style safety knob, not something a misconfiguration
 * should be able to widen).
 */
export const CHILD_PING_LEASE_MS: Millis = 150_000;

/** Rolling-window bookkeeping: 24 hourly buckets (see `recordSpend`/`spent24h`). */
const LEDGER_BUCKET_MS: Millis = 3_600_000;
const LEDGER_BUCKET_COUNT = 24;
const LEDGER_WINDOW_MS: Millis = LEDGER_BUCKET_MS * LEDGER_BUCKET_COUNT;

export type LeaseDenyReason = "global-cap" | "usd-process";

export interface AcquireInput {
  /** Caller identity, for diagnostics only — the ledger never keys anything by it (T-K2: leases are per-token, not per-holder). */
  holderId: string;
  /** Pre-computed estimate (read-price × prefix tokens) for the ping about to be attempted. */
  estimateUsd: number;
  /** Process-wide concurrent-slot cap, read fresh from the caller's settings on every call (so `/agent settings` changes apply live — same convention as `KeepaliveConfig`). */
  maxConcurrent: number;
  /** Rolling 24h process-wide $ budget, read fresh from the caller's settings on every call. */
  processBudgetUsd: number;
  now: Millis;
}

export interface Lease {
  readonly token: string;
  readonly holderId: string;
  readonly acquiredAt: Millis;
  readonly expiresAt: Millis;
  /**
   * Releases the slot and replaces the up-front reservation with the actual
   * charge. `chargeUsd` omitted (or `undefined`) ⇒ revoke the reservation
   * entirely (the ping never actually cost anything — auth failure, timeout,
   * fingerprint drift, etc.). Idempotent by token: every call after the
   * first (including one that arrives after the lease was already reclaimed
   * as expired) is a silent no-op — it must never release a DIFFERENT
   * holder's later lease that happens to reuse the same concurrency slot.
   */
  settle(now: Millis, chargeUsd?: number): void;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; reason: LeaseDenyReason };

export interface ChildKeepaliveLedger {
  tryAcquire(input: AcquireInput): AcquireResult;
  /** Actually-charged spend in the trailing 24h window ending at `now`. Never includes outstanding (unsettled) reservations. */
  spent24h(now: Millis): number;
  /** Sum of `estimateUsd` for every lease currently held (not yet settled or reclaimed) — what `tryAcquire` adds to `spent24h` when judging the process budget, so concurrent in-flight pings can't collectively overspend before any of them settles. */
  reserved(): number;
  /** Number of leases currently held (not yet settled or reclaimed). Diagnostic/test use — `tryAcquire` is the only method allowed to change it via the concurrency check. */
  activeCount(): number;
}

interface LeaseRecord {
  readonly token: string;
  readonly holderId: string;
  readonly acquiredAt: Millis;
  readonly expiresAt: Millis;
  readonly estimateUsd: number;
}

interface Bucket {
  /** Floor(timestamp / LEDGER_BUCKET_MS) * LEDGER_BUCKET_MS of the last write to this slot, or `undefined` before the first write. */
  start: Millis | undefined;
  amountUsd: number;
}

let leaseSeq = 0;

class ChildKeepaliveLedgerImpl implements ChildKeepaliveLedger {
  private readonly active = new Map<string, LeaseRecord>();
  private readonly buckets: Bucket[] = Array.from({ length: LEDGER_BUCKET_COUNT }, () => ({
    start: undefined,
    amountUsd: 0,
  }));

  private recordSpend(now: Millis, amountUsd: number): void {
    if (!(amountUsd > 0)) return;
    const bucketStart = Math.floor(now / LEDGER_BUCKET_MS) * LEDGER_BUCKET_MS;
    const index = Math.floor(now / LEDGER_BUCKET_MS) % LEDGER_BUCKET_COUNT;
    const bucket = this.buckets[index]!;
    if (bucket.start !== bucketStart) {
      bucket.start = bucketStart;
      bucket.amountUsd = 0;
    }
    bucket.amountUsd += amountUsd;
  }

  spent24h(now: Millis): number {
    let total = 0;
    for (const bucket of this.buckets) {
      if (bucket.start === undefined) continue;
      // Absolute-time filter (not index-based): correct regardless of how long
      // ago a bucket slot was last touched, since the index alone repeats every
      // 24h and cannot distinguish "touched this cycle" from "touched exactly
      // one cycle ago" — only the stored timestamp can.
      if (bucket.start <= now && now - bucket.start < LEDGER_WINDOW_MS) total += bucket.amountUsd;
    }
    return total;
  }

  reserved(): number {
    let total = 0;
    for (const record of this.active.values()) total += record.estimateUsd;
    return total;
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Recycles every lease past its `expiresAt` (conservative: charges its estimate). Only ever called from `tryAcquire` (plan.md §2.4: "过期回收只在 tryAcquire 时发生"). */
  private reclaimExpired(now: Millis): void {
    for (const [token, record] of this.active) {
      if (now >= record.expiresAt) {
        this.recordSpend(now, record.estimateUsd);
        this.active.delete(token);
      }
    }
  }

  tryAcquire(input: AcquireInput): AcquireResult {
    const { holderId, estimateUsd, now } = input;
    const maxConcurrent = Math.max(0, input.maxConcurrent);
    const processBudgetUsd = Math.max(0, input.processBudgetUsd);
    this.reclaimExpired(now);

    if (this.active.size >= maxConcurrent) return { ok: false, reason: "global-cap" };

    const projected = this.spent24h(now) + this.reserved() + Math.max(0, estimateUsd);
    if (projected > processBudgetUsd) return { ok: false, reason: "usd-process" };

    leaseSeq += 1;
    const token = `pl_${now}_${leaseSeq}`;
    const record: LeaseRecord = {
      token,
      holderId,
      acquiredAt: now,
      expiresAt: now + CHILD_PING_LEASE_MS,
      estimateUsd: Math.max(0, estimateUsd),
    };
    this.active.set(token, record);

    const settle = (settleNow: Millis, chargeUsd?: number): void => {
      if (!this.active.has(token)) return; // idempotent: already settled, or reclaimed as expired.
      this.active.delete(token);
      const charge = chargeUsd ?? 0;
      if (charge > 0) this.recordSpend(settleNow, charge);
    };

    const lease: Lease = {
      token,
      holderId,
      acquiredAt: record.acquiredAt,
      expiresAt: record.expiresAt,
      settle,
    };
    return { ok: true, lease };
  }
}

/** Builds an isolated ledger instance — for tests that want full isolation instead of the shared process singleton (see `getChildKeepaliveLedger` for that). */
export function createChildKeepaliveLedger(): ChildKeepaliveLedger {
  return new ChildKeepaliveLedgerImpl();
}

/** Lazily builds (or reuses, across `/reload`) the single process-wide ledger instance. */
export function getChildKeepaliveLedger(): ChildKeepaliveLedger {
  const g = globalThis as Record<symbol, ChildKeepaliveLedger | undefined>;
  const existing = g[CHILD_KEEPALIVE_LEDGER_KEY];
  if (existing) return existing;
  const created = createChildKeepaliveLedger();
  g[CHILD_KEEPALIVE_LEDGER_KEY] = created;
  return created;
}
