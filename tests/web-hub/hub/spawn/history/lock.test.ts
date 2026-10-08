/**
 * web-hub session-history plan v3.2 V1 + v3.3 W2 (`lock.ts`): the per-generation cancellable
 * FIFO lock. `createGenLock`/`withGenLock` are tested directly (generation.ts always goes
 * through this module, never a bare promise chain).
 */
import { describe, expect, it } from "vitest";
import { createGenLock, withGenLock } from "../../../../../src/web-hub/hub/spawn/history/lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createGenLock / withGenLock", () => {
  it("serializes holders FIFO — a second acquire only runs after the first releases", async () => {
    const lock = createGenLock();
    const order: number[] = [];
    const p1 = withGenLock(lock, 1000, async () => {
      order.push(1);
      await sleep(10);
      order.push(2);
    });
    const p2 = withGenLock(lock, 1000, async () => {
      order.push(3);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("a queued waiter whose remainingMs elapses before its turn is cancelled and never runs its fn", async () => {
    const lock = createGenLock();
    const ran: string[] = [];
    // Holder 1 holds the lock for 50ms.
    const p1 = withGenLock(lock, 1000, async () => {
      ran.push("holder1");
      await sleep(50);
    });
    // Holder 2 only has 10ms of budget — it will still be queued when its deadline fires.
    const p2 = withGenLock(lock, 10, async () => {
      ran.push("holder2"); // must NEVER run
    });
    const [, r2] = await Promise.all([p1, p2]);
    expect(r2).toEqual({ ok: false });
    expect(ran).toEqual(["holder1"]);
  });

  it("remainingMs <= 0 cancels immediately without ever queuing", async () => {
    const lock = createGenLock();
    const result = await withGenLock(lock, 0, async () => "should not run");
    expect(result).toEqual({ ok: false });
  });

  it("release() is idempotent — double release never double-advances the queue", async () => {
    const lock = createGenLock();
    const node = await lock.acquire(1000);
    expect(node).toBeDefined();
    if (node === undefined) throw new Error("unreachable");
    lock.release(node);
    lock.release(node); // must be a no-op, not corrupt the queue
    const node2 = await lock.acquire(1000);
    expect(node2?.state).toBe("running");
  });

  it("a holder's thrown error still releases the lock (try/finally discipline) and propagates", async () => {
    const lock = createGenLock();
    await expect(
      withGenLock(lock, 1000, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // the lock must be free again
    const result = await withGenLock(lock, 1000, async () => "ok");
    expect(result).toEqual({ ok: true, value: "ok" });
  });

  it("a cancelled node reaching the head of the queue is skipped entirely (never granted running)", async () => {
    const lock = createGenLock();
    const ran: string[] = [];
    const p1 = withGenLock(lock, 1000, async () => {
      ran.push("1");
      await sleep(30);
    });
    // Two more queued behind it; the middle one's budget expires before its turn.
    const p2 = withGenLock(lock, 5, async () => {
      ran.push("2-should-not-run");
    });
    const p3 = withGenLock(lock, 1000, async () => {
      ran.push("3");
    });
    const results = await Promise.all([p1, p2, p3]);
    expect(results[1]).toEqual({ ok: false });
    expect(ran).toEqual(["1", "3"]);
  });
});
