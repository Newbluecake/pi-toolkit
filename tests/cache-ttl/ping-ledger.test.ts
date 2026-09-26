/**
 * T-K2 (child-ka-core, docs/dev/child-context-switch/plan.md §2.4/§7 P1):
 * the process-level ping admission ledger. Every test uses
 * `createChildKeepaliveLedger()` (an isolated instance) rather than the
 * shared `getChildKeepaliveLedger()` singleton, EXCEPT the dedicated
 * "shares the process singleton" test below — mirrors the convention in
 * `tests/bash/child-registry.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  CHILD_KEEPALIVE_LEDGER_KEY,
  CHILD_PING_LEASE_MS,
  createChildKeepaliveLedger,
  getChildKeepaliveLedger,
} from "../../src/cache-ttl/ping-ledger.js";

describe("ping-ledger — process singleton (mirrors child-registry.ts's Symbol.for pattern)", () => {
  it("getChildKeepaliveLedger() returns the same instance across calls (survives /reload)", () => {
    expect(getChildKeepaliveLedger()).toBe(getChildKeepaliveLedger());
    const g = globalThis as Record<symbol, unknown>;
    expect(g[CHILD_KEEPALIVE_LEDGER_KEY]).toBe(getChildKeepaliveLedger());
  });

  it("createChildKeepaliveLedger() builds a fresh, isolated instance every time", () => {
    const a = createChildKeepaliveLedger();
    const b = createChildKeepaliveLedger();
    expect(a).not.toBe(b);
    expect(a).not.toBe(getChildKeepaliveLedger());
  });
});

describe("ping-ledger — concurrency cap", () => {
  it("denies global-cap once maxConcurrent leases are held, and admits again after one settles", () => {
    const ledger = createChildKeepaliveLedger();
    const a = ledger.tryAcquire({ holderId: "a", estimateUsd: 0.1, maxConcurrent: 2, processBudgetUsd: 100, now: 0 });
    const b = ledger.tryAcquire({ holderId: "b", estimateUsd: 0.1, maxConcurrent: 2, processBudgetUsd: 100, now: 0 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(ledger.activeCount()).toBe(2);

    const c = ledger.tryAcquire({ holderId: "c", estimateUsd: 0.1, maxConcurrent: 2, processBudgetUsd: 100, now: 0 });
    expect(c).toEqual({ ok: false, reason: "global-cap" });

    if (a.ok) a.lease.settle(1, 0.05);
    expect(ledger.activeCount()).toBe(1);

    const d = ledger.tryAcquire({ holderId: "d", estimateUsd: 0.1, maxConcurrent: 2, processBudgetUsd: 100, now: 1 });
    expect(d.ok).toBe(true);
  });

  it("any moment's held count never exceeds maxConcurrent (property-style, mixed settle/deny traffic)", () => {
    const ledger = createChildKeepaliveLedger();
    const maxConcurrent = 3;
    const held: Array<{ token: string; settle: (now: number, charge?: number) => void }> = [];
    let now = 0;
    for (let i = 0; i < 50; i += 1) {
      now += 1;
      const result = ledger.tryAcquire({
        holderId: `h${i}`,
        estimateUsd: 0,
        maxConcurrent,
        processBudgetUsd: 1000,
        now,
      });
      expect(ledger.activeCount()).toBeLessThanOrEqual(maxConcurrent);
      if (result.ok) held.push(result.lease);
      // Settle roughly a third of what's held so the pool churns instead of only ever growing.
      if (held.length > 0 && i % 3 === 0) {
        const lease = held.shift()!;
        lease.settle(now, 0);
        expect(ledger.activeCount()).toBeLessThanOrEqual(maxConcurrent);
      }
    }
  });
});

describe("ping-ledger — settle idempotency and reservation accounting", () => {
  it("settle is idempotent by token: a second call is a no-op and never double-charges", () => {
    const ledger = createChildKeepaliveLedger();
    const result = ledger.tryAcquire({
      holderId: "a",
      estimateUsd: 1,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lease.settle(10, 5);
    expect(ledger.spent24h(10)).toBe(5);
    result.lease.settle(10, 5); // second call: no-op
    expect(ledger.spent24h(10)).toBe(5);
  });

  it("settle(now) with chargeUsd omitted revokes the reservation entirely (charges 0)", () => {
    const ledger = createChildKeepaliveLedger();
    const result = ledger.tryAcquire({
      holderId: "a",
      estimateUsd: 5,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ledger.reserved()).toBe(5);
    result.lease.settle(10);
    expect(ledger.reserved()).toBe(0);
    expect(ledger.spent24h(10)).toBe(0);
  });

  it("reserved() prevents concurrent in-flight pings from collectively overspending the process budget before any settles", () => {
    const ledger = createChildKeepaliveLedger();
    // budget 1.0; two concurrent estimates of 0.6 each — the SECOND must be denied
    // even though neither has settled yet (the reservation from the first counts).
    const a = ledger.tryAcquire({ holderId: "a", estimateUsd: 0.6, maxConcurrent: 10, processBudgetUsd: 1.0, now: 0 });
    expect(a.ok).toBe(true);
    const b = ledger.tryAcquire({ holderId: "b", estimateUsd: 0.6, maxConcurrent: 10, processBudgetUsd: 1.0, now: 0 });
    expect(b).toEqual({ ok: false, reason: "usd-process" });
  });

  it("denies usd-process when the estimate alone would exceed the remaining budget", () => {
    const ledger = createChildKeepaliveLedger();
    const result = ledger.tryAcquire({
      holderId: "a",
      estimateUsd: 10,
      maxConcurrent: 10,
      processBudgetUsd: 5,
      now: 0,
    });
    expect(result).toEqual({ ok: false, reason: "usd-process" });
  });

  it("processBudgetUsd: 0 always denies usd-process (0 = never ping, matches the settings semantics)", () => {
    const ledger = createChildKeepaliveLedger();
    const result = ledger.tryAcquire({
      holderId: "a",
      estimateUsd: 0.01,
      maxConcurrent: 10,
      processBudgetUsd: 0,
      now: 0,
    });
    expect(result).toEqual({ ok: false, reason: "usd-process" });
  });
});

describe("ping-ledger — expired-lease reclamation (only at tryAcquire time)", () => {
  it("a lease past CHILD_PING_LEASE_MS is reclaimed (charged at its estimate) only when the NEXT tryAcquire runs", () => {
    const ledger = createChildKeepaliveLedger();
    const result = ledger.tryAcquire({
      holderId: "a",
      estimateUsd: 2,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: 0,
    });
    expect(result.ok).toBe(true);

    // Long past expiry, but nothing has called tryAcquire again yet — still "held".
    expect(ledger.activeCount()).toBe(1);
    expect(ledger.spent24h(CHILD_PING_LEASE_MS + 1000)).toBe(0); // not yet charged

    // The next tryAcquire (any holder) triggers reclamation first.
    const b = ledger.tryAcquire({
      holderId: "b",
      estimateUsd: 0.5,
      maxConcurrent: 2,
      processBudgetUsd: 100,
      now: CHILD_PING_LEASE_MS + 1000,
    });
    expect(b.ok).toBe(true);
    expect(ledger.activeCount()).toBe(1); // a's slot was freed, b now holds the only one
    expect(ledger.spent24h(CHILD_PING_LEASE_MS + 1000)).toBe(2); // a's estimate was charged conservatively
  });

  it("a lease exactly at its expiresAt is reclaimed (>= boundary)", () => {
    const ledger = createChildKeepaliveLedger();
    const result = ledger.tryAcquire({
      holderId: "a",
      estimateUsd: 1,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    ledger.tryAcquire({
      holderId: "b",
      estimateUsd: 0,
      maxConcurrent: 5,
      processBudgetUsd: 100,
      now: result.lease.expiresAt,
    });
    expect(ledger.activeCount()).toBe(1); // a reclaimed, b holds
  });

  it("the expired token's late settle() is a no-op and does NOT release a different holder's later lease in the same slot", () => {
    const ledger = createChildKeepaliveLedger();
    const a = ledger.tryAcquire({ holderId: "a", estimateUsd: 1, maxConcurrent: 1, processBudgetUsd: 100, now: 0 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // a expires and gets reclaimed by b's tryAcquire.
    const reclaimAt = CHILD_PING_LEASE_MS + 1;
    const b = ledger.tryAcquire({
      holderId: "b",
      estimateUsd: 1,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: reclaimAt,
    });
    expect(b.ok).toBe(true);
    expect(ledger.activeCount()).toBe(1); // only b's slot

    // a's holder finally calls settle() long after being reclaimed — must be a no-op.
    a.lease.settle(reclaimAt + 100, 0.5);
    expect(ledger.activeCount()).toBe(1); // b's slot is untouched — NOT released
    if (b.ok) {
      // b can still settle its own lease normally afterwards.
      b.lease.settle(reclaimAt + 200, 0.2);
      expect(ledger.activeCount()).toBe(0);
    }
  });
});

describe("ping-ledger — 24h rolling bucket window", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  it("spent24h sums charges within the trailing 24h and drops anything older", () => {
    const ledger = createChildKeepaliveLedger();
    const a = ledger.tryAcquire({ holderId: "a", estimateUsd: 1, maxConcurrent: 5, processBudgetUsd: 100, now: 0 });
    expect(a.ok).toBe(true);
    if (a.ok) a.lease.settle(0, 3);

    expect(ledger.spent24h(HOUR)).toBe(3);
    expect(ledger.spent24h(DAY - 1)).toBe(3);
    // Exactly 24h later the bucket is no longer within the window (< DAY, strict).
    expect(ledger.spent24h(DAY)).toBe(0);
    expect(ledger.spent24h(DAY + HOUR)).toBe(0);
  });

  it("charges land in the correct hourly bucket and roll off independently as time advances", () => {
    const ledger = createChildKeepaliveLedger();
    const settleAt = (holderId: string, at: number, charge: number) => {
      const r = ledger.tryAcquire({
        holderId,
        estimateUsd: charge,
        maxConcurrent: 10,
        processBudgetUsd: 1000,
        now: at,
      });
      expect(r.ok).toBe(true);
      if (r.ok) r.lease.settle(at, charge);
    };
    settleAt("a", 0, 1); // hour 0
    settleAt("b", HOUR * 5, 2); // hour 5
    settleAt("c", HOUR * 23, 4); // hour 23

    // At hour 23.5: all three still within the last 24h.
    expect(ledger.spent24h(HOUR * 23 + HOUR / 2)).toBe(7);
    // At hour 24.5: the hour-0 charge has rolled off; the other two remain.
    expect(ledger.spent24h(HOUR * 24 + HOUR / 2)).toBe(6);
    // At hour 29.5: only the hour-23 charge remains.
    expect(ledger.spent24h(HOUR * 29 + HOUR / 2)).toBe(4);
    // At hour 47.6+: everything has rolled off.
    expect(ledger.spent24h(HOUR * 48)).toBe(0);
  });

  it("a bucket slot revisited a full cycle (24h) later resets instead of accumulating stale spend", () => {
    const ledger = createChildKeepaliveLedger();
    const settleAt = (holderId: string, at: number, charge: number) => {
      const r = ledger.tryAcquire({
        holderId,
        estimateUsd: charge,
        maxConcurrent: 10,
        processBudgetUsd: 1000,
        now: at,
      });
      expect(r.ok).toBe(true);
      if (r.ok) r.lease.settle(at, charge);
    };
    settleAt("a", 0, 5); // hour-0 slot
    expect(ledger.spent24h(0)).toBe(5);
    settleAt("b", DAY, 1); // same slot index one full day later — must reset, not add to the stale 5.
    expect(ledger.spent24h(DAY)).toBe(1);
  });
});
