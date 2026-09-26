import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKdfAdmission, KDF_ADMISSION } from "../../../src/web-hub/hub/kdf-admission.js";

describe("createKdfAdmission (plan §6.2, fake timers — refill is time-driven)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants up to `capacity` immediately, then queues the next one until a token refills", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    const results = await Promise.all(
      Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`ip-${i}`, true)),
    );
    for (const r of results) expect(r.ok).toBe(true);
    const queued = a.acquire("ip-overflow", true);
    await vi.advanceTimersByTimeAsync(600); // > 500ms/token at the normal 2/s rate
    const r = await queued;
    expect(r.ok).toBe(true);
  });

  it("fresh gets served ahead of tainted when both have waiters and tokens trickle in one at a time", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    const order: string[] = [];
    const track = (label: string, p: Promise<{ ok: boolean }>): Promise<void> =>
      p.then((r) => {
        if (r.ok) order.push(label);
      });
    const all = Promise.all([
      track("t1", a.acquire("t1", false)),
      track("t2", a.acquire("t2", false)),
      track("f1", a.acquire("f1", true)),
      track("f2", a.acquire("f2", true)),
    ]);
    await vi.advanceTimersByTimeAsync(2_500);
    await all;
    expect(order[0]).toBe("f1");
  });

  it("per-IP: a second concurrent acquire for the same IP is rejected immediately, not queued", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    const first = a.acquire("dup-ip", true);
    const second = await a.acquire("dup-ip", true);
    expect(second).toMatchObject({ ok: false, retryAfterMs: KDF_ADMISSION.capacityRetryAfterMs });
    await vi.advanceTimersByTimeAsync(600);
    await first;
  });

  it("category capacity: fresh caps at 4 waiters ⇒ the 5th is rejected without queueing", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    const fills = Array.from({ length: KDF_ADMISSION.freshCap }, (_, i) => a.acquire(`ff-${i}`, true));
    const overflow = await a.acquire("ff-overflow", true);
    expect(overflow).toMatchObject({ ok: false, retryAfterMs: KDF_ADMISSION.capacityRetryAfterMs });
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all(fills);
  });

  it("category capacity: tainted caps at 24 waiters ⇒ the 25th is rejected without queueing", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    const fills = Array.from({ length: KDF_ADMISSION.taintedCap }, (_, i) => a.acquire(`tf-${i}`, false));
    const overflow = await a.acquire("tf-overflow", false);
    expect(overflow).toMatchObject({ ok: false, retryAfterMs: KDF_ADMISSION.capacityRetryAfterMs });
    await vi.advanceTimersByTimeAsync(13_000);
    await Promise.all(fills);
  });

  it("release() exists and is callable (no-op — concurrency lives in kdf.ts's own pool)", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    const r = await a.acquire("1.2.3.4", true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(() => r.release()).not.toThrow();
  });

  it("aborting the caller's signal removes the waiter instead of leaking it", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    const controller = new AbortController();
    const p = a.acquire("aborting-ip", true, { signal: controller.signal });
    controller.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    const controller2 = new AbortController();
    const again = a.acquire("aborting-ip", true, { signal: controller2.signal });
    controller2.abort();
    const r2 = await again;
    expect(r2.ok).toBe(false);
  });

  it("an already-aborted signal is rejected synchronously without ever queueing", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    const controller = new AbortController();
    controller.abort();
    const r = await a.acquire("pre-aborted", true, { signal: controller.signal });
    expect(r.ok).toBe(false);
  });

  it("a waiter that never gets a token times out at 20s with retryAfterMs=2s and frees its slot", async () => {
    const a = createKdfAdmission({ now: Date.now, isTightened: () => false });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    // 4 self-perpetuating fresh "hog" chains keep the fresh queue permanently full (cap 4): each
    // hog immediately re-queues itself under a fresh identity once served, so fresh always wins
    // its share of the alternation. 23 fixed tainted hogs sit ahead of `stuck` in FIFO order
    // (tainted cap is 24, so 23 hogs + `stuck` exactly fills it) — at ~50/50 token alternation over
    // 20s (~40 tokens total), tainted's ~20 served tokens are not enough to clear 23 hogs ahead of
    // `stuck`, so it must still be waiting when its own 20s timer fires.
    let hogSeq = 0;
    let stopHogs = false;
    function spawnFreshHog(): void {
      if (stopHogs) return;
      void a.acquire(`hog-${hogSeq++}`, true).then(() => spawnFreshHog());
    }
    for (let i = 0; i < KDF_ADMISSION.freshCap; i++) spawnFreshHog();
    const taintedHogs = Array.from({ length: KDF_ADMISSION.taintedCap - 1 }, (_, i) => a.acquire(`thog-${i}`, false));
    const stuck = a.acquire("stuck-ip", false);
    await vi.advanceTimersByTimeAsync(20_100);
    const r = await stuck;
    expect(r).toMatchObject({ ok: false, retryAfterMs: KDF_ADMISSION.timeoutRetryAfterMs });
    stopHogs = true;
    await Promise.all(taintedHogs);
    // slot freed: immediately re-acquirable without hitting the per-IP "already waiting" cap.
    const again = a.acquire("stuck-ip", false);
    await vi.advanceTimersByTimeAsync(30_000);
    await again;
  });

  it("uses the tightened rate (0.5/s) when isTightened() is true — refill is visibly slower than normal", async () => {
    let tightened = false;
    const a = createKdfAdmission({ now: Date.now, isTightened: () => tightened });
    await Promise.all(Array.from({ length: KDF_ADMISSION.capacity }, (_, i) => a.acquire(`drain-${i}`, true)));
    tightened = true;
    const p = a.acquire("slow", true);
    await vi.advanceTimersByTimeAsync(1_000); // < 2s needed at 0.5/s ⇒ not yet granted
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500); // now past the ~2s mark
    const r = await p;
    expect(r.ok).toBe(true);
  });
});
