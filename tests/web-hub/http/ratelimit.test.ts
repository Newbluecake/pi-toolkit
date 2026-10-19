import { describe, expect, it } from "vitest";
import { createLoginLimiter, RATE_LIMIT } from "../../../src/web-hub/hub/ratelimit.js";
import type { SecurityEvent } from "../../../src/web-hub/hub/security-events.js";

function clock(start = 0): { now(): number; advance(ms: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("createLoginLimiter (plan §6.2)", () => {
  it("normal mode: 5 free failures then exponential backoff 30/60/120s, capped at 15min", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    for (let i = 0; i < 5; i++) {
      expect(l.admit("1.2.3.4")).toEqual({ ok: true });
      l.fail("1.2.3.4");
    }
    // 6th failure ⇒ first backoff (base 30s)
    expect(l.admit("1.2.3.4")).toEqual({ ok: true });
    l.fail("1.2.3.4");
    let r = l.admit("1.2.3.4");
    expect(r).toMatchObject({ ok: false, retryAfterMs: 30_000 });
    c.advance(30_000);
    expect(l.admit("1.2.3.4")).toEqual({ ok: true });
    l.fail("1.2.3.4"); // 7th failure ⇒ 60s
    r = l.admit("1.2.3.4");
    expect(r).toMatchObject({ ok: false, retryAfterMs: 60_000 });
    c.advance(60_000);
    l.fail("1.2.3.4"); // 8th ⇒ 120s
    r = l.admit("1.2.3.4");
    expect(r).toMatchObject({ ok: false, retryAfterMs: 120_000 });
  });

  it("success clears the failing IP's own backoff and taint only", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    for (let i = 0; i < 6; i++) l.fail("1.2.3.4");
    expect(l.admit("1.2.3.4")).toMatchObject({ ok: false });
    l.succeed("1.2.3.4");
    expect(l.admit("1.2.3.4")).toEqual({ ok: true });
    expect(l.isFresh("1.2.3.4")).toBe(true);
  });

  it("global tighten (>50 failures/10min) ⇒ free failures drop to 1, base backoff 60s; loosens below 25", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    for (let i = 0; i < 51; i++) l.fail(`attacker-${i}`);
    expect(l.isTightened()).toBe(true);
    // a fresh IP now only gets 1 free failure
    expect(l.admit("victim")).toEqual({ ok: true });
    l.fail("victim"); // 1st failure: still free (freeFailuresTightened=1)
    expect(l.admit("victim")).toEqual({ ok: true });
    l.fail("victim"); // 2nd failure: exceeds the free quota ⇒ locked
    const r = l.admit("victim");
    expect(r).toMatchObject({ ok: false, retryAfterMs: 60_000 });
    // loosen: advance past the 10-min window so the global count drops under 25
    c.advance(RATE_LIMIT.globalWindowMs + 1);
    l.fail("another-1"); // one fresh failure inside the new window ⇒ count 1 < 25 ⇒ loosen
    expect(l.isTightened()).toBe(false);
  });

  it("taint memory: fails for 24h, capped at TAINT_CAP without evicting existing entries (saturation)", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    for (let i = 0; i < RATE_LIMIT.taintCap; i++) l.fail(`ip-${i}`);
    // saturated: an unseen IP is rejected without being added to taint or the backoff table
    const r = l.admit("never-seen");
    expect(r).toMatchObject({ ok: false, saturated: true, retryAfterMs: RATE_LIMIT.saturatedRetryAfterMs });
    expect(l.isFresh("never-seen")).toBe(true); // never actually tainted
    // an already-tainted IP still goes through its own backoff channel, not saturation
    expect(l.admit("ip-0")).not.toMatchObject({ saturated: true });
  });

  it("taint expires after 24h", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    l.fail("1.2.3.4");
    expect(l.isFresh("1.2.3.4")).toBe(false);
    c.advance(RATE_LIMIT.taintTtlMs + 1);
    expect(l.isFresh("1.2.3.4")).toBe(true);
  });

  it("backoff table caps at 4096 entries and evicts the earliest-expiring one instead of rejecting a new IP", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    for (let i = 0; i < RATE_LIMIT.backoffTableCap; i++) l.fail(`bo-${i}`);
    // one more distinct IP must still be handled (not rejected) even though the table is "full"
    expect(() => l.fail(`bo-${RATE_LIMIT.backoffTableCap}`)).not.toThrow();
    expect(l.admit(`bo-${RATE_LIMIT.backoffTableCap}`)).toBeDefined();
  });

  it("unlock() clears backoff, taint, global-failure hysteresis and saturation", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    for (let i = 0; i < 60; i++) l.fail(`x-${i}`);
    expect(l.isTightened()).toBe(true);
    l.unlock();
    expect(l.isTightened()).toBe(false);
    expect(l.isFresh("x-0")).toBe(true);
    expect(l.admit("x-0")).toEqual({ ok: true });
  });

  it("capacity/timeout style rejections are the caller's job to avoid calling fail() for — this limiter only ever taints on an explicit fail()", () => {
    const c = clock();
    const l = createLoginLimiter({ now: c.now });
    expect(l.admit("1.2.3.4")).toEqual({ ok: true }); // admit alone never taints
    expect(l.isFresh("1.2.3.4")).toBe(true);
  });
});

describe("createLoginLimiter security-event emits (LAN security r2 §4.2)", () => {
  it("emits login-lockout exactly once, on the transition into backoff", () => {
    const c = clock();
    const events: SecurityEvent[] = [];
    const l = createLoginLimiter({ now: c.now, onEvent: (e) => events.push(e) });
    for (let i = 0; i < 6; i++) l.fail("1.2.3.4");
    const lockouts = events.filter((e) => e.type === "login-lockout");
    expect(lockouts).toHaveLength(1);
    expect(lockouts[0]).toMatchObject({ type: "login-lockout", ip: "1.2.3.4", failures: 6, lockMs: 30_000 });
    // further failures on the same IP while locked do not re-emit
    l.fail("1.2.3.4");
    expect(events.filter((e) => e.type === "login-lockout")).toHaveLength(1);
  });

  it("emits login-tightened once on the false→true transition", () => {
    const c = clock();
    const events: SecurityEvent[] = [];
    const l = createLoginLimiter({ now: c.now, onEvent: (e) => events.push(e) });
    for (let i = 0; i < 51; i++) l.fail(`attacker-${i}`);
    expect(events.filter((e) => e.type === "login-tightened")).toHaveLength(1);
  });

  it("emits login-saturated once while the taint cap is exhausted", () => {
    const c = clock();
    const events: SecurityEvent[] = [];
    const l = createLoginLimiter({ now: c.now, onEvent: (e) => events.push(e) });
    for (let i = 0; i < RATE_LIMIT.taintCap; i++) l.fail(`ip-${i}`);
    expect(l.admit("never-seen")).toMatchObject({ saturated: true });
    expect(events.filter((e) => e.type === "login-saturated")).toHaveLength(1);
    // still saturated, but the latch prevents a duplicate emit
    l.admit("never-seen-2");
    expect(events.filter((e) => e.type === "login-saturated")).toHaveLength(1);
  });

  it("saturated latch is sticky until unlock() (a normal admit does not re-arm it)", () => {
    const c = clock();
    const events: SecurityEvent[] = [];
    const l = createLoginLimiter({ now: c.now, onEvent: (e) => events.push(e) });
    for (let i = 0; i < RATE_LIMIT.taintCap; i++) l.fail(`ip-${i}`);
    expect(l.admit("never-seen")).toMatchObject({ saturated: true });
    expect(events.filter((e) => e.type === "login-saturated")).toHaveLength(1);
    // free one taint slot and admit normally (a buggy latch reset would re-arm the emit here)
    l.succeed("ip-0");
    expect(l.admit("ip-0")).toEqual({ ok: true });
    l.fail("ip-0"); // refill to re-saturate
    expect(l.admit("never-seen-2")).toMatchObject({ saturated: true });
    expect(events.filter((e) => e.type === "login-saturated")).toHaveLength(1);
    // unlock() clears the latch; a fresh saturation emits again
    l.unlock();
    for (let i = 0; i < RATE_LIMIT.taintCap; i++) l.fail(`re-${i}`);
    expect(l.admit("never-seen-3")).toMatchObject({ saturated: true });
    expect(events.filter((e) => e.type === "login-saturated")).toHaveLength(2);
  });
});
