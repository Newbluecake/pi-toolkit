import { describe, expect, it } from "vitest";
import { createXsLimits, XS_ACTIVATE_PAIR_INTERVAL_MS, type XsAdmit } from "../../../src/web-hub/hub/xs/limits.js";
import { XsProgressBag } from "../../../src/fabric/xs/progress.js";
import { LIMITS } from "./xs-fixtures.js";

/** fabric-xs-activation P3 (arch §4.6): control-attempt admission shares the send/wake windows. */
const HOUR = 3_600_000;
function mk() {
  const clock = { t: 10_000_000 };
  const limits = createXsLimits({ now: () => clock.t, hubSendsPerMin: 600 });
  const lim = { ...LIMITS, pairMinIntervalMs: 0, wakesOutPerHour: 20, sendsOutPerMin: 100, sendsOutPerHour: 1000 };
  const act = () => limits.admitActivate({ agentKey: "a1", pairKey: "A>B", limits: lim });
  const send = (wantWake: boolean): XsAdmit =>
    limits.admitSend({ agentKey: "a1", pairKey: "A>B", limits: lim, wantWake });
  return { clock, limits, act, send };
}

describe("admitActivate", () => {
  it("a new attempt takes one pair wake slot; the pair cap (2/h) refuses with the OLDEST occupant's recovery instant", () => {
    const { clock, act, send } = mk();
    const t0 = clock.t;
    expect(send(true)).toMatchObject({ ok: true, wake: true });
    clock.t += 1000;
    expect(send(true)).toMatchObject({ ok: true, wake: true });
    clock.t += 1000;
    const r = act();
    expect(r).toEqual({ ok: false, reason: "pair_wake_rate", retryAfterAt: t0 + HOUR });
    // a refusal reserves NOTHING (still exactly the same answer)
    expect(act()).toEqual({ ok: false, reason: "pair_wake_rate", retryAfterAt: t0 + HOUR });
  });

  it("the latest KNOWN constraint wins; an unknowable one (in-flight) drops retryAfterAt instead of inventing 0", () => {
    const { clock, limits } = mk();
    const lim = { ...LIMITS, pairMinIntervalMs: 0, wakesOutPerHour: 1, inFlightPerSession: 8 };
    const a = () => limits.admitActivate({ agentKey: "a1", pairKey: "A>B", limits: lim });
    const t0 = clock.t;
    const first = a();
    expect(first.ok).toBe(true);
    clock.t += XS_ACTIVATE_PAIR_INTERVAL_MS + 1;
    // both the out-wake cap (t0+1h) and nothing else fail; spacing already elapsed
    expect(a()).toEqual({ ok: false, reason: "outbound_wake_rate", retryAfterAt: t0 + HOUR });
    const tight = { ...LIMITS, pairMinIntervalMs: 0, inFlightPerSession: 1 };
    const l2 = createXsLimits({ now: () => clock.t, hubSendsPerMin: 600 });
    expect(l2.admitActivate({ agentKey: "x", pairKey: "P>Q", limits: tight }).ok).toBe(true);
    const blocked = l2.admitActivate({ agentKey: "x", pairKey: "P>Q", limits: tight });
    expect(blocked).toMatchObject({ ok: false, reason: "rate_in_flight" });
    expect("retryAfterAt" in blocked).toBe(false);
  });

  it("control attempts have their own 30s per-pair spacing (and skip only the body pairMinInterval check)", () => {
    const { clock, limits } = mk();
    const lim = { ...LIMITS, pairMinIntervalMs: 60_000, wakesOutPerHour: 20, pairWakesPerHour: 9 };
    const a = () => limits.admitActivate({ agentKey: "a1", pairKey: "A>B", limits: lim });
    const first = a();
    expect(first.ok).toBe(true);
    if (first.ok) limits.settleActivate(first.ticket, { none: true });
    expect(a()).toMatchObject({
      ok: false,
      reason: "rate_activate_interval",
      retryAfterAt: clock.t + XS_ACTIVATE_PAIR_INTERVAL_MS,
    });
    clock.t += XS_ACTIVATE_PAIR_INTERVAL_MS;
    expect(a().ok).toBe(true); // the 60s BODY pair interval does not apply to a control attempt
  });
});

describe("settleActivate", () => {
  it("none releases ONLY this attempt's wake reservation; unknown never refunds; idempotent; send counts never refund", () => {
    const { clock, limits } = mk();
    const lim = { ...LIMITS, pairMinIntervalMs: 0, wakesOutPerHour: 20, pairWakesPerHour: 1, sendsOutPerMin: 1 };
    const first = limits.admitActivate({ agentKey: "a1", pairKey: "A>B", limits: lim });
    if (!first.ok) throw new Error("admitted");
    clock.t += XS_ACTIVATE_PAIR_INTERVAL_MS + 1; // out of the 1-minute... use a hub with room:
    const roomy = { ...lim, sendsOutPerMin: 100 };
    // unknown: the wake slot stays taken ⇒ pair cap (1) refuses the next attempt
    limits.settleActivate(first.ticket, { none: false });
    expect(limits.admitActivate({ agentKey: "a1", pairKey: "A>B", limits: roomy })).toMatchObject({
      ok: false,
      reason: "pair_wake_rate",
    });
    const l2 = createXsLimits({ now: () => clock.t, hubSendsPerMin: 600 });
    const t = l2.admitActivate({ agentKey: "k", pairKey: "P>Q", limits: roomy });
    if (!t.ok) throw new Error("admitted");
    l2.settleActivate(t.ticket, { none: true });
    l2.settleActivate(t.ticket, { none: true }); // idempotent: no double release
    clock.t += XS_ACTIVATE_PAIR_INTERVAL_MS + 1;
    expect(l2.admitActivate({ agentKey: "k", pairKey: "P>Q", limits: roomy }).ok).toBe(true);
    // the send-per-minute count of a released attempt is NOT refunded
    const l3 = createXsLimits({ now: () => clock.t, hubSendsPerMin: 600 });
    const tight = { ...lim, sendsOutPerMin: 1, pairWakesPerHour: 9 };
    const s = l3.admitActivate({ agentKey: "z", pairKey: "R>S", limits: tight });
    if (!s.ok) throw new Error("admitted");
    l3.settleActivate(s.ticket, { none: true });
    clock.t += XS_ACTIVATE_PAIR_INTERVAL_MS + 1;
    expect(l3.admitActivate({ agentKey: "z", pairKey: "R>S", limits: tight })).toMatchObject({
      ok: false,
      reason: "rate_sends_min",
    });
  });
});

describe("progress bag claim park (reload continuity)", () => {
  it("a restored dispatched/unknown claim becomes the terminal tombstone; a bound `available` key survives", () => {
    const bag = new XsProgressBag();
    bag.observe("m1", {
      deliveryEffect: "applied",
      phase: "delivered",
      activationKey: "k1",
      activationUntil: Date.now() + 60_000,
    });
    bag.observe("m2", {
      deliveryEffect: "applied",
      phase: "delivered",
      activationKey: "k2",
      activationUntil: Date.now() + 60_000,
    });
    expect(bag.claimReserve("m1", "k1").ok).toBe(true);
    bag.claimDispatch("m1");
    expect(bag.claimReserve("m2", "k2").ok).toBe(true);
    bag.claimRelease("m2");
    const snaps = bag.claimSnapshots();
    const next = new XsProgressBag();
    for (const m of ["m1", "m2"])
      next.observe(m, { deliveryEffect: "applied", phase: "delivered", activationUntil: Date.now() + 60_000 });
    for (const s of snaps) expect(next.claimRestore(s.messageId, s.view)).toBe(true);
    expect(next.claimReserve("m1", "k1")).toMatchObject({ ok: false, reason: "already_active" });
    expect(next.claimReserve("m2", "kother")).toMatchObject({ ok: false, reason: "key_mismatch" });
    expect(next.claimReserve("m2", "k2").ok).toBe(true);
    expect(next.claimRestore("m3", snaps[0]!.view)).toBe(false); // no row ⇒ nothing to adopt
  });
});
