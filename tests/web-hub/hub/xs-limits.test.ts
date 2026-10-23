import { describe, expect, it } from "vitest";
import {
  createXsLimits,
  normalizeHubCrossSessionConfig,
  type XsAdmit,
  type XsTicket,
} from "../../../src/web-hub/hub/xs/limits.js";
import { LIMITS } from "./xs-fixtures.js";

function mk(hubSendsPerMin = 60) {
  const clock = { t: 10_000_000 };
  const limits = createXsLimits({ now: () => clock.t, hubSendsPerMin });
  return { clock, limits };
}
const send = (
  l: ReturnType<typeof mk>["limits"],
  over: {
    agentKey?: string;
    pairKey?: string;
    wantWake?: boolean;
    isReply?: boolean;
    lim?: Partial<typeof LIMITS>;
  } = {},
): XsAdmit =>
  l.admitSend({
    agentKey: over.agentKey ?? "a1",
    pairKey: over.pairKey ?? "A>B",
    limits: { ...LIMITS, ...over.lim },
    wantWake: over.wantWake ?? false,
    ...(over.isReply === undefined ? {} : { isReply: over.isReply }),
  });
const ok = (a: XsAdmit): Extract<XsAdmit, { ok: true }> => {
  if (!a.ok) throw new Error(`expected admit, got ${a.reason}`);
  return a;
};

describe("xs limits: admission (reserve)", () => {
  it("in-flight cap: the (N+1)th concurrent send is refused until a settle frees a slot", () => {
    const { clock, limits } = mk();
    const lim = { inFlightPerSession: 2, pairMinIntervalMs: 5_000 };
    const t1 = ok(send(limits, { pairKey: "A>1", lim }));
    ok(send(limits, { pairKey: "A>2", lim }));
    expect(send(limits, { pairKey: "A>3", lim })).toEqual({ ok: false, reason: "rate_in_flight" });
    limits.settle(t1.ticket, { acked: true, woke: false });
    clock.t += 1;
    ok(send(limits, { pairKey: "A>3", lim }));
  });

  it("pair interval: same pair inside pairMinIntervalMs refused, other pair fine, after the interval fine", () => {
    const { clock, limits } = mk();
    ok(send(limits, { pairKey: "A>B" }));
    expect(send(limits, { pairKey: "A>B" })).toEqual({ ok: false, reason: "rate_pair_interval" });
    ok(send(limits, { pairKey: "A>C" }));
    clock.t += 5_000;
    ok(send(limits, { pairKey: "A>B" }));
  });

  it("per-minute and per-hour sender windows (sliding)", () => {
    const { clock, limits } = mk();
    const lim = { sendsOutPerMin: 3, sendsOutPerHour: 5, inFlightPerSession: 16 };
    for (let i = 0; i < 3; i++) ok(send(limits, { pairKey: `A>${i}`, lim }));
    expect(send(limits, { pairKey: "A>x", lim })).toEqual({ ok: false, reason: "rate_sends_min" });
    clock.t += 61_000; // minute window clears
    for (let i = 3; i < 5; i++) ok(send(limits, { pairKey: `A>${i}`, lim }));
    clock.t += 61_000;
    expect(send(limits, { pairKey: "A>y", lim })).toEqual({ ok: false, reason: "rate_sends_hour" });
    clock.t += 3_600_000;
    ok(send(limits, { pairKey: "A>y", lim }));
  });

  it("hubSendsPerMin is global across senders", () => {
    const { limits } = mk(2);
    ok(send(limits, { agentKey: "a1", pairKey: "1>x" }));
    ok(send(limits, { agentKey: "a2", pairKey: "2>x" }));
    expect(send(limits, { agentKey: "a3", pairKey: "3>x" })).toEqual({ ok: false, reason: "rate_hub" });
  });

  it("a refused admission consumes nothing (no counter, no in-flight, no pair stamp)", () => {
    const { limits } = mk();
    const lim = { sendsOutPerMin: 1, inFlightPerSession: 16 };
    ok(send(limits, { pairKey: "A>B", lim }));
    expect(send(limits, { pairKey: "A>C", lim }).ok).toBe(false); // rate_sends_min
    // C was never stamped as a pair, B's stamp is the only one
    expect(limits.snapshot()).toEqual({ senders: 1, pairs: 1, hubLastMin: 1 });
  });

  it("list budget: listPerMin, sliding, per sender", () => {
    const { clock, limits } = mk();
    for (let i = 0; i < 6; i++) expect(limits.admitList("a1", { listPerMin: 6 })).toBe(true);
    expect(limits.admitList("a1", { listPerMin: 6 })).toBe(false);
    expect(limits.admitList("a2", { listPerMin: 6 })).toBe(true);
    clock.t += 60_000;
    expect(limits.admitList("a1", { listPerMin: 6 })).toBe(true);
  });
});

describe("xs limits: wake reservation + downgrade", () => {
  it("wake reserved when both sender and pair have room", () => {
    const { limits } = mk();
    const a = ok(send(limits, { wantWake: true }));
    expect(a.wake).toBe(true);
    expect(a.wakeDowngraded).toBeUndefined();
    expect(a.ticket.wakeReserved).toBe(true);
  });

  it("wakesOutPerHour exhausted ⇒ message continues deliver-only with outbound_wake_rate", () => {
    const { clock, limits } = mk();
    const lim = { wakesOutPerHour: 1, pairWakesPerHour: 20 };
    ok(send(limits, { pairKey: "A>1", wantWake: true, lim }));
    clock.t += 5_000;
    const b = ok(send(limits, { pairKey: "A>2", wantWake: true, lim }));
    expect(b).toMatchObject({ wake: false, wakeDowngraded: "outbound_wake_rate" });
    expect(b.ticket.wakeReserved).toBe(false);
  });

  it("wakesOutPerHour 0 ⇒ always deliver-only", () => {
    const { limits } = mk();
    expect(ok(send(limits, { wantWake: true, lim: { wakesOutPerHour: 0 } }))).toMatchObject({
      wake: false,
      wakeDowngraded: "outbound_wake_rate",
    });
  });

  it("pairWakesPerHour exhausted ⇒ pair_wake_rate (anti ping-pong), another pair still wakes", () => {
    const { clock, limits } = mk();
    const lim = { pairWakesPerHour: 1, wakesOutPerHour: 60 };
    ok(send(limits, { wantWake: true, lim }));
    clock.t += 5_000;
    expect(ok(send(limits, { wantWake: true, lim }))).toMatchObject({
      wake: false,
      wakeDowngraded: "pair_wake_rate",
    });
    clock.t += 5_000;
    expect(ok(send(limits, { pairKey: "A>C", wantWake: true, lim })).wake).toBe(true);
  });

  it("no wake requested ⇒ no wake reservation and no downgrade note", () => {
    const { limits } = mk();
    const a = ok(send(limits));
    expect(a).toMatchObject({ wake: false });
    expect(a.wakeDowngraded).toBeUndefined();
  });
});

describe("xs limits: settlement matrix (§4.6 step 2)", () => {
  const prep = (wantWake: boolean) => {
    const m = mk();
    const lim = { wakesOutPerHour: 1, pairWakesPerHour: 1, sendsOutPerMin: 2, inFlightPerSession: 1 };
    const a = ok(send(m.limits, { wantWake, lim }));
    return { ...m, lim, ticket: a.ticket };
  };
  const wakeRoom = (m: ReturnType<typeof prep>) => {
    m.clock.t += 5_000;
    return ok(send(m.limits, { wantWake: true, lim: m.lim })).wake;
  };
  const sendCountRoom = (m: ReturnType<typeof prep>) => {
    // sendsOutPerMin = 2: one used. After a settle another send fits, then the minute is full.
    m.clock.t += 5_000;
    ok(send(m.limits, { wantWake: false, lim: m.lim }));
    m.clock.t += 5_000;
    return send(m.limits, { wantWake: false, lim: m.lim }).ok;
  };

  it("applied (woke:true): everything kept — wake not refunded, send counted, in-flight released", () => {
    const m = prep(true);
    m.limits.settle(m.ticket, { acked: true, woke: true });
    expect(wakeRoom(m)).toBe(false);
  });

  it("ack woke:false with a known effect ⇒ the wake reservation is refunded (a new wake fits again)", () => {
    for (const effect of ["applied", "none"] as const) {
      const m = prep(true);
      m.limits.settle(m.ticket, { acked: true, woke: false, effect });
      expect(wakeRoom(m)).toBe(true);
    }
  });

  it("channel-plan NQ2: ack woke:false with effect unknown (or no effect) refunds NOTHING", () => {
    const m = prep(true);
    m.limits.settle(m.ticket, { acked: true, woke: false, effect: "unknown" });
    expect(wakeRoom(m)).toBe(false);
    const m2 = prep(true);
    m2.limits.settle(m2.ticket, { acked: true, woke: false });
    expect(wakeRoom(m2)).toBe(false);
  });

  it("ack woke:false does not refund the SEND count", () => {
    const m = prep(true);
    m.limits.settle(m.ticket, { acked: true, woke: false });
    // used: 1 send. one more fits…
    m.clock.t += 5_000;
    const second = ok(send(m.limits, { wantWake: false, lim: m.lim }));
    m.limits.settle(second.ticket, { acked: true, woke: false });
    // …and then the minute (limit 2) is exhausted — the first send is still counted.
    m.clock.t += 5_000;
    expect(send(m.limits, { wantWake: false, lim: m.lim })).toEqual({ ok: false, reason: "rate_sends_min" });
  });

  it("no ack (deadline / disconnect / teardown): in-flight released, NOTHING refunded (unknown is conservative)", () => {
    const m = prep(true);
    m.limits.settle(m.ticket, { acked: false });
    expect(wakeRoom(m)).toBe(false); // wake still spent
    // in-flight (limit 1) was released though: that second send was admitted at all
  });

  it("effect none with an ack but woke:true is still kept (only woke:false refunds)", () => {
    const m = prep(true);
    m.limits.settle(m.ticket, { acked: true, woke: true });
    expect(sendCountRoom(m)).toBe(false); // 1 original + 1 admitted = minute full
  });

  it("settle is idempotent: a second settle neither double-releases in-flight nor double-refunds", () => {
    const { clock, limits } = mk();
    const lim = { inFlightPerSession: 2, wakesOutPerHour: 5, pairWakesPerHour: 5, pairMinIntervalMs: 5_000 };
    const t1: XsTicket = ok(send(limits, { pairKey: "A>1", wantWake: true, lim })).ticket;
    ok(send(limits, { pairKey: "A>2", lim }));
    limits.settle(t1, { acked: true, woke: false });
    limits.settle(t1, { acked: true, woke: false }); // must not free a second slot
    clock.t += 1;
    ok(send(limits, { pairKey: "A>3", lim })); // 2 in flight? t1 freed ⇒ 2 (A>2, A>3)
    expect(send(limits, { pairKey: "A>4", lim })).toEqual({ ok: false, reason: "rate_in_flight" });
  });
});

describe("xs limits: bounded maps", () => {
  it("idle sender/pair entries are swept once the maps grow (no unbounded growth)", () => {
    const { clock, limits } = mk(600);
    const lim = { inFlightPerSession: 16, sendsOutPerMin: 60, pairMinIntervalMs: 5_000 };
    for (let i = 0; i < 300; i++) {
      const a = ok(send(limits, { agentKey: `k${i}`, pairKey: `k${i}>x`, lim }));
      limits.settle(a.ticket, { acked: true });
    }
    clock.t += 2 * 3_600_000;
    ok(send(limits, { agentKey: "fresh", pairKey: "fresh>x", lim }));
    expect(limits.snapshot().senders).toBeLessThan(10);
  });
});

describe("HubConfig.crossSession normalisation (main.ts re-check, §4.6)", () => {
  it("accepts an integer hubSendsPerMin in 1..600 and drops everything else", () => {
    expect(normalizeHubCrossSessionConfig({ limits: { hubSendsPerMin: 60 } })).toEqual({
      limits: { hubSendsPerMin: 60 },
    });
    expect(normalizeHubCrossSessionConfig({ limits: { hubSendsPerMin: 1 } })).toBeDefined();
    expect(normalizeHubCrossSessionConfig({ limits: { hubSendsPerMin: 600 } })).toBeDefined();
    for (const bad of [
      undefined,
      null,
      "x",
      [],
      {},
      { limits: null },
      { limits: {} },
      { limits: { hubSendsPerMin: 0 } },
      { limits: { hubSendsPerMin: 601 } },
      { limits: { hubSendsPerMin: 1.5 } },
      { limits: { hubSendsPerMin: "60" } },
      { limits: { hubSendsPerMin: Number.NaN } },
    ]) {
      expect(normalizeHubCrossSessionConfig(bad)).toBeUndefined();
    }
  });

  it("extra keys are not carried through", () => {
    expect(normalizeHubCrossSessionConfig({ limits: { hubSendsPerMin: 5, evil: 1 }, x: 2 })).toEqual({
      limits: { hubSendsPerMin: 5 },
    });
  });
});

describe("xs reply limits (RX2)", () => {
  it("replies bypass the pair interval, never reserve wake, and still count as sends", () => {
    const { limits } = mk();
    const first = ok(send(limits, { wantWake: true }));
    limits.settle(first.ticket, { acked: true, woke: true });
    expect(send(limits)).toMatchObject({ ok: false, reason: "rate_pair_interval" });
    const reply = ok(send(limits, { isReply: true, wantWake: true }));
    expect(reply).toMatchObject({ wake: false, ticket: { wakeReserved: false } });
    expect(reply.wakeDowngraded).toBeUndefined();
    expect(limits.snapshot().hubLastMin).toBe(2);
  });

  it.each([
    ["rate_in_flight", { inFlightPerSession: 1 }],
    ["rate_sends_min", { sendsOutPerMin: 1 }],
    ["rate_sends_hour", { sendsOutPerHour: 1 }],
  ])("replies do not bypass %s", (reason, lim) => {
    const { limits } = mk();
    ok(send(limits, { isReply: true, lim }));
    expect(send(limits, { isReply: true, lim })).toEqual({ ok: false, reason });
    expect(limits.snapshot().hubLastMin).toBe(1);
  });

  it("replies do not bypass the hub cap", () => {
    const { limits } = mk(1);
    ok(send(limits, { isReply: true }));
    expect(send(limits, { isReply: true })).toEqual({ ok: false, reason: "rate_hub" });
  });

  it("reply config absent stays absent; booleans survive main's recheck, malformed values disable reply only", () => {
    const base = { limits: { hubSendsPerMin: 60 } };
    expect(normalizeHubCrossSessionConfig(base)).toEqual(base);
    for (const reply of [true, false])
      expect(normalizeHubCrossSessionConfig({ ...base, reply })).toEqual({ ...base, reply });
    for (const reply of [null, 0, "false", {}, []]) {
      expect(normalizeHubCrossSessionConfig({ ...base, reply })).toEqual({ ...base, reply: false });
    }
  });
});
