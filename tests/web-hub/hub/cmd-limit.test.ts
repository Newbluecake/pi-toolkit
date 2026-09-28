import { describe, expect, it } from "vitest";
import { createCmdLimit } from "../../../src/web-hub/hub/cmd-limit.js";

function clock(t = 0): { now: () => number; t: number; advance(ms: number): void } {
  const c = { t, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

describe("createCmdLimit (plan §6.5)", () => {
  it("admits up to capacity bursts, then rejects with a positive retryAfterMs", () => {
    const c = clock();
    const limit = createCmdLimit(c.now);
    for (let i = 0; i < 3; i++) expect(limit.admit("b", 3, 1_000)).toEqual({ ok: true });
    const rejected = limit.admit("b", 3, 1_000);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills one token every refillMs, clamped to capacity", () => {
    const c = clock();
    const limit = createCmdLimit(c.now);
    expect(limit.admit("b", 2, 1_000)).toEqual({ ok: true });
    expect(limit.admit("b", 2, 1_000)).toEqual({ ok: true });
    expect(limit.admit("b", 2, 1_000).ok).toBe(false);
    c.advance(999);
    expect(limit.admit("b", 2, 1_000).ok).toBe(false);
    c.advance(1);
    expect(limit.admit("b", 2, 1_000)).toEqual({ ok: true }); // exactly one token refilled
    expect(limit.admit("b", 2, 1_000).ok).toBe(false);
    c.advance(10_000); // clamps at capacity, does not accrue unboundedly
    expect(limit.admit("b", 2, 1_000)).toEqual({ ok: true });
    expect(limit.admit("b", 2, 1_000)).toEqual({ ok: true });
    expect(limit.admit("b", 2, 1_000).ok).toBe(false);
  });

  it("distinct bucket keys are independent", () => {
    const c = clock();
    const limit = createCmdLimit(c.now);
    expect(limit.admit("a", 1, 1_000)).toEqual({ ok: true });
    expect(limit.admit("a", 1, 1_000).ok).toBe(false);
    expect(limit.admit("b", 1, 1_000)).toEqual({ ok: true }); // unaffected by "a"'s exhaustion
  });

  it("never throws for refillMs:0 (degenerate bucket, no refill)", () => {
    const c = clock();
    const limit = createCmdLimit(c.now);
    expect(limit.admit("z", 1, 0)).toEqual({ ok: true });
    const rejected = limit.admit("z", 1, 0);
    expect(rejected).toEqual({ ok: false, retryAfterMs: 0 });
  });
});
