import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XsLimitsBroadcast as FrozenXsLimitsBroadcast } from "../../../src/fabric/xs/types-channel.js";
import { createXsLimits, type XsBroadcastAdmit } from "../../../src/web-hub/hub/xs/limits.js";
import type { XsAckFrame, XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { BCAST_LIMITS, CHANNEL_CAPS, LIMITS, rig, type Rig } from "./xs-fixtures.js";

/**
 * Channel-plan CH1 §5.2: hub-side broadcast fan-out — recipient set S / N unit, every admission
 * refusal (all-or-nothing, a refusal consumes nothing), the five wake steps, "never refunded",
 * aggregation and the audit lines.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

let seq = 0;
const SA = "sess-AAAAAAAA";
function bcast(over: Partial<XsReqFrame> = {}, sessionId = SA): XsReqFrame {
  return {
    t: "xs_req",
    rid: `b${++seq}`,
    op: "broadcast",
    origin: { sessionId, epoch: 1 },
    channel: "team",
    text: "hello all",
    ...over,
  };
}
function call(r: Rig, key: string, frame: XsReqFrame): XsResFrame[] {
  const out: XsResFrame[] = [];
  r.relay.router.handle(key, frame, (res) => out.push(res));
  return out;
}
const delivers = (conn: { sent: unknown[] }): XsDeliverFrame[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === "xs_deliver") as XsDeliverFrame[];
async function ackLast(r: Rig, a: { key: string; conn: { sent: unknown[] } }, over: Partial<XsAckFrame> = {}) {
  const d = delivers(a.conn).at(-1)!;
  r.registry.onFrame(a.key, { t: "xs_ack", rid: d.rid, xid: d.xid, effect: "applied", woke: false, ...over });
  await vi.advanceTimersByTimeAsync(0);
}

type AgentOpts = Parameters<Rig["agent"]>[0];
function member(
  r: Rig,
  pid: number,
  sessionId: string,
  channels: string[] | undefined,
  extra: Partial<AgentOpts> = {},
) {
  return r.agent({
    pid,
    sessionId,
    name: `n${pid}`,
    caps: CHANNEL_CAPS,
    limits: { ...BCAST_LIMITS, ...extra.limits },
    ...(channels === undefined ? {} : { channels }),
    ...extra,
  });
}
/** Sender A in [default, team] + n receivers in [team]. */
function team(
  n: number,
  senderLimits: Partial<typeof LIMITS> = {},
  hubChannels?: { maxRecipients: number; wakeMaxRecipients: number },
  hubSendsPerMin = 60,
) {
  const r = rig(hubSendsPerMin, hubChannels);
  const a = member(r, 1, SA, ["default", "team"], { limits: { ...BCAST_LIMITS, ...senderLimits } });
  const rcpts = Array.from({ length: n }, (_, i) => {
    r.clock.t += 1; // distinct activity ⇒ deterministic row order (most recent first)
    return member(r, 10 + i, `sess-R${i}-000000`, ["team"]);
  });
  return { r, a, rcpts };
}

describe("§5.2 step 1: pre-checks (provable none, nothing reserved)", () => {
  it("invalid / not-mine ⇒ E_XS_BAD_TARGET{reason:channel}; #default ⇒ {reason:default} (Q2); empty text ⇒ BAD_FRAME", () => {
    const { r, a, rcpts } = team(1);
    for (const [over, code, reason] of [
      [{ channel: "ｔｅａｍ" }, "E_XS_BAD_TARGET", "channel"],
      [{ channel: "-x" }, "E_XS_BAD_TARGET", "channel"],
      [{ channel: "other" }, "E_XS_BAD_TARGET", "channel"],
      [{ channel: "default" }, "E_XS_BAD_TARGET", "default"],
      [{ channel: "#DEFAULT" }, "E_XS_BAD_TARGET", "default"],
      [{ text: "" }, "E_XS_BAD_FRAME", undefined],
      [{ expect: { requestId: "q0123456789abcdef01", timeoutMs: 60_000 } }, "E_XS_BAD_FRAME", undefined],
    ] as const) {
      const out = call(r, a.key, bcast(over))[0]!;
      expect(out, code).toMatchObject({ ok: false, code, effect: "none" });
      expect(out.reason).toBe(reason);
    }
    expect(delivers(rcpts[0]!.conn)).toHaveLength(0);
    // nothing consumed: a valid broadcast still passes (interval never stamped)
    call(r, a.key, bcast({ channel: "#Team" }));
    expect(delivers(rcpts[0]!.conn)).toHaveLength(1);
  });

  it("a not-joined sender is E_XS_STALE_ORIGIN (same as send)", () => {
    const r = rig();
    const x = member(r, 1, SA, undefined, { joined: false });
    expect(call(r, x.key, bcast())[0]).toMatchObject({ code: "E_XS_STALE_ORIGIN" });
  });
});

describe("§5.2 step 2: recipient set S (unit = logical session)", () => {
  it("excludes off/replies/other-channel/no-cap/self (incl. my second socket); ambiguous counted in N", async () => {
    const r = rig();
    const a = member(r, 1, SA, ["default", "team"]);
    const b = member(r, 2, "sess-BBBBBBBB", ["team"]); // wake
    const c = member(r, 3, "sess-CCCCCCCC", ["team"], { receive: "deliver" });
    const off = member(r, 4, "sess-DDDDDDDD", ["team"], { receive: "off" });
    const replies = member(r, 5, "sess-EEEEEEEE", ["team"], { receive: "replies" });
    const nocap = member(r, 6, "sess-FFFFFFFF", ["team"], { caps: ["ev.v1", "xs.v1"] });
    const other = member(r, 7, "sess-GGGGGGGG", ["other"]);
    const mine2 = member(r, 8, SA, ["team"]); // my own session on another socket
    const h1 = member(r, 9, "sess-HHHHHHHH", ["team"]);
    const h2 = member(r, 10, "sess-HHHHHHHH", ["elsewhere"]); // second holder anywhere ⇒ ambiguous
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, bcast(), (res) => out.push(res));
    for (const x of [off, replies, nocap, other, mine2, h1, h2]) expect(delivers(x.conn)).toHaveLength(0);
    expect(delivers(b.conn)).toHaveLength(1);
    expect(delivers(c.conn)).toHaveLength(1);
    await ackLast(r, b);
    await ackLast(r, c);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      ok: true,
      effect: "unknown",
      reason: "partial",
      fanout: { total: 3, applied: 2, none: 1, unknown: 0, woke: 0 },
    });
    const amb = out[0]!.results!.find((x) => x.ref === "sess-HHHHHHH");
    expect(amb).toEqual({
      ref: "sess-HHHHHHH",
      name: expect.any(String),
      effect: "none",
      reason: "ambiguous",
      woke: false,
    });
    expect(out[0]!.results).toHaveLength(3);
  });

  it("each deliver: own xid, hub-stamped from, bc{channel}, via = shared set, wake false w/o wake", () => {
    const { r, a, rcpts } = team(2);
    call(r, a.key, bcast());
    const [d0, d1] = [delivers(rcpts[0]!.conn)[0]!, delivers(rcpts[1]!.conn)[0]!];
    expect(d0.xid).not.toBe(d1.xid);
    for (const d of [d0, d1]) {
      expect(d).toMatchObject({
        t: "xs_deliver",
        from: { sessionId: SA, ref: "sess-AAAAAAA", agentId: a.key },
        text: "hello all",
        wake: false,
        bc: { channel: "team" },
        via: ["team"],
      });
      expect("level" in d).toBe(false);
    }
  });

  it("N = 0 ⇒ none{no_recipients}, nothing reserved; N > maxRecipients ⇒ E_XS_FANOUT_TOO_LARGE", () => {
    const lone = team(0);
    expect(call(lone.r, lone.a.key, bcast())[0]).toEqual({
      t: "xs_res",
      rid: expect.any(String),
      ok: true,
      effect: "none",
      reason: "no_recipients",
    });
    const big = team(3, {}, { maxRecipients: 2, wakeMaxRecipients: 2 });
    expect(call(big.r, big.a.key, bcast())[0]).toMatchObject({
      ok: false,
      code: "E_XS_FANOUT_TOO_LARGE",
      effect: "none",
    });
    for (const x of big.rcpts) expect(delivers(x.conn)).toHaveLength(0);
  });
});

describe("§5.2 step 4: per-head all-or-nothing admission", () => {
  it.each([
    ["rate_sends_min", { sendsOutPerMin: 2 }, 60],
    ["rate_sends_hour", { sendsOutPerHour: 2 }, 60],
    ["rate_hub", {}, 2],
    ["rate_broadcast_hour", { broadcastsOutPerHour: 0 }, 60],
  ] as const)("%s ⇒ none{reason}, nothing delivered", (reason, lim, hub) => {
    const { r, a, rcpts } = team(3, lim, undefined, hub);
    expect(call(r, a.key, bcast())[0]).toMatchObject({ ok: true, effect: "none", reason });
    for (const x of rcpts) expect(delivers(x.conn)).toHaveLength(0);
  });

  it("a member that never declared the broadcast keys cannot broadcast (lower bound 0/h)", () => {
    const r = rig();
    const a = r.agent({ pid: 1, sessionId: SA, caps: CHANNEL_CAPS, channels: ["team"] });
    member(r, 2, "sess-BBBBBBBB", ["team"]);
    expect(call(r, a.key, bcast())[0]).toMatchObject({ effect: "none", reason: "rate_broadcast_hour" });
  });

  it("interval and in-flight; a refused broadcast leaves every window untouched", async () => {
    const { r, a, rcpts } = team(1, { inFlightPerSession: 1, broadcastMinIntervalMs: 60_000 });
    call(r, a.key, bcast());
    // in flight (1 slot): both a broadcast and a send are refused
    r.clock.t += 61_000;
    expect(call(r, a.key, bcast())[0]).toMatchObject({ effect: "none", reason: "rate_in_flight" });
    await ackLast(r, rcpts[0]!);
    expect(call(r, a.key, bcast())[0]).toBeUndefined(); // admitted (answer pending)
    await ackLast(r, rcpts[0]!);
    r.clock.t += 30_000;
    expect(call(r, a.key, bcast())[0]).toMatchObject({ effect: "none", reason: "rate_broadcast_interval" });
    r.clock.t += 30_000;
    expect(call(r, a.key, bcast())[0]).toBeUndefined();
  });

  it("pair interval is SKIPPED for a broadcast but stamped: a P2P send right after hits rate_pair_interval", async () => {
    const { r, a, rcpts } = team(1);
    call(r, a.key, {
      t: "xs_req",
      rid: "p1",
      op: "send",
      origin: { sessionId: SA, epoch: 1 },
      to: "sess-R0-000000",
      text: "p",
    });
    await ackLast(r, rcpts[0]!);
    // inside pairMinIntervalMs (5 s): the broadcast is NOT refused …
    call(r, a.key, bcast());
    await ackLast(r, rcpts[0]!);
    expect(delivers(rcpts[0]!.conn)).toHaveLength(2);
    // … but it stamped the pair: a P2P send 4 s later is still inside the interval
    r.clock.t += 4_000;
    expect(
      call(r, a.key, {
        t: "xs_req",
        rid: "p2",
        op: "send",
        origin: { sessionId: SA, epoch: 1 },
        to: "sess-R0-000000",
        text: "q",
      })[0],
    ).toMatchObject({ effect: "none", reason: "rate_pair_interval" });
  });
});

describe("§5.2 step 5: broadcast wake (five steps, first unmet wins)", () => {
  const wakeOf = (rcpts: Array<{ conn: { sent: unknown[] } }>) => rcpts.map((x) => delivers(x.conn).at(-1)?.wake);

  it("5.1: no level ⇒ sender_wake_disabled; level ≥1 ⇒ level_limit; level 0 ⇒ wakes", async () => {
    for (const [level, dg] of [
      [undefined, "sender_wake_disabled"],
      [1, "level_limit"],
      [0, undefined],
    ] as const) {
      const { r, a, rcpts } = team(2);
      const out: XsResFrame[] = [];
      r.relay.router.handle(a.key, bcast({ wake: true, ...(level === undefined ? {} : { level }) }), (x) =>
        out.push(x),
      );
      expect(wakeOf(rcpts)).toEqual(dg === undefined ? [true, true] : [false, false]);
      for (const x of rcpts) await ackLast(r, x, { woke: dg === undefined });
      expect(out[0]!.wakeDowngraded).toBe(dg);
      if (level !== undefined) for (const x of rcpts) expect(delivers(x.conn)[0]!.level).toBe(level);
    }
  });

  it("5.2: N above wakeMaxRecipients (hub config, hard ≤4) ⇒ broadcast_wake_fanout", () => {
    const five = team(5);
    const out = call(five.r, five.a.key, bcast({ wake: true, level: 0 }));
    expect(out).toHaveLength(0);
    expect(wakeOf(five.rcpts)).toEqual([false, false, false, false, false]);
    const two = team(3, {}, { maxRecipients: 16, wakeMaxRecipients: 2 });
    call(two.r, two.a.key, bcast({ wake: true, level: 0 }));
    expect(wakeOf(two.rcpts)).toEqual([false, false, false]);
  });

  it("5.3: broadcastWakesOutPerHour (hard 2) ⇒ broadcast_wake_rate; NEVER refunded even on woke:false", async () => {
    const { r, a, rcpts } = team(1, { broadcastWakesOutPerHour: 1 });
    call(r, a.key, bcast({ wake: true, level: 0 }));
    await ackLast(r, rcpts[0]!, { effect: "applied", woke: false, wakeDowngraded: "busy" });
    r.clock.t += 60_000;
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, bcast({ wake: true, level: 0 }), (x) => out.push(x));
    expect(wakeOf(rcpts)).toEqual([false]);
    await ackLast(r, rcpts[0]!);
    expect(out[0]).toMatchObject({ effect: "applied", wakeDowngraded: "broadcast_wake_rate" });
  });

  it("5.4: outbound wakes < N ⇒ outbound_wake_rate; reserved outbound wakes are never refunded", async () => {
    const { r, a, rcpts } = team(2, { wakesOutPerHour: 3 });
    call(r, a.key, bcast({ wake: true, level: 0 }));
    for (const x of rcpts) await ackLast(r, x, { effect: "applied", woke: false });
    r.clock.t += 60_000;
    // 3 − 2 = 1 outbound wake left < N = 2 ⇒ whole broadcast deliver-only
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, bcast({ wake: true, level: 0 }), (x) => out.push(x));
    expect(wakeOf(rcpts)).toEqual([false, false]);
    for (const x of rcpts) await ackLast(r, x);
    expect(out[0]!.wakeDowngraded).toBe("outbound_wake_rate");
    // the 1 remaining wake is still there for a P2P send (counted, not refunded, not over-consumed)
    r.clock.t += 6_000;
    call(r, a.key, {
      t: "xs_req",
      rid: "w",
      op: "send",
      origin: { sessionId: SA, epoch: 1 },
      to: "sess-R1-000000",
      text: "x",
      wake: true,
      level: 0,
    });
    expect(delivers(rcpts[1]!.conn).at(-1)!.wake).toBe(true);
  });

  it("5.5: a row whose pair wakes are exhausted is downgraded alone (pair_wake_rate), others wake", async () => {
    const { r, a, rcpts } = team(2, { pairWakesPerHour: 1 });
    // spend the A→R0 pair wake with a P2P wake send
    call(r, a.key, {
      t: "xs_req",
      rid: "w0",
      op: "send",
      origin: { sessionId: SA, epoch: 1 },
      to: "sess-R0-000000",
      text: "x",
      wake: true,
      level: 0,
    });
    await ackLast(r, rcpts[0]!, { woke: true });
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, bcast({ wake: true, level: 0 }), (x) => out.push(x));
    expect(delivers(rcpts[0]!.conn).at(-1)!.wake).toBe(false);
    expect(delivers(rcpts[1]!.conn).at(-1)!.wake).toBe(true);
    await ackLast(r, rcpts[0]!);
    await ackLast(r, rcpts[1]!, { woke: true });
    expect(out[0]!.wakeDowngraded).toBeUndefined();
    const row0 = out[0]!.results!.find((x) => x.woke === false)!;
    expect(row0.wakeDowngraded).toBe("pair_wake_rate");
    expect(out[0]!.fanout).toMatchObject({ total: 2, applied: 2, woke: 1 });
  });
});

describe("§5.2 steps 6–8: settlement + aggregation", () => {
  it("all applied ⇒ applied; all none ⇒ none; all unknown ⇒ unknown (no partial)", async () => {
    for (const [acks, effect, reason] of [
      [["applied", "applied"], "applied", undefined],
      [["none", "none"], "none", undefined],
      [["unknown", "unknown"], "unknown", undefined],
      [["applied", "none"], "unknown", "partial"],
    ] as const) {
      const { r, a, rcpts } = team(2);
      const out: XsResFrame[] = [];
      r.relay.router.handle(a.key, bcast(), (x) => out.push(x));
      for (let i = 0; i < 2; i++) {
        await ackLast(r, rcpts[i]!, { effect: acks[i]!, ...(acks[i] === "none" ? { reason: "rejected" } : {}) });
      }
      expect(out).toHaveLength(1);
      expect(out[0]!.effect).toBe(effect);
      expect(out[0]!.reason).toBe(reason);
    }
  });

  it("deadline / disconnect / ack mismatch ⇒ unknown rows (never none); in-flight released once at the end", async () => {
    const { r, a, rcpts } = team(3, { inFlightPerSession: 1 });
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, bcast(), (x) => out.push(x));
    r.registry.onClose(rcpts[1]!.key, false); // link lost
    const d2 = delivers(rcpts[2]!.conn)[0]!;
    r.registry.onFrame(rcpts[2]!.key, { t: "xs_ack", rid: d2.rid, xid: "x-other", effect: "applied", woke: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toHaveLength(0); // row 0 still pending ⇒ slot held
    r.clock.t += 61_000;
    expect(call(r, a.key, bcast())[0]).toMatchObject({ reason: "rate_in_flight" });
    await vi.advanceTimersByTimeAsync(5_000); // row 0 hits the hub deliver deadline
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ effect: "unknown", fanout: { total: 3, applied: 0, none: 0, unknown: 3, woke: 0 } });
    expect(out[0]!.results!.map((x) => x.reason).sort()).toEqual(["ack_mismatch", "deliver_deadline", "link_lost"]);
    r.clock.t += 61_000;
    expect(call(r, a.key, bcast())[0]).toBeUndefined(); // slot free again
  });

  it("dispose settles every in-flight row as unknown", async () => {
    const { r, a } = team(2);
    const out: XsResFrame[] = [];
    r.relay.router.handle(a.key, bcast(), (x) => out.push(x));
    r.relay.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(out[0]).toMatchObject({ ok: true, effect: "unknown", fanout: { unknown: 2 } });
  });

  it("audit: one op:broadcast line + one op:send bcast line per recipient; never the body", async () => {
    const { r, a, rcpts } = team(2);
    call(r, a.key, bcast({ text: "SECRET-BODY" }));
    for (const x of rcpts) await ackLast(r, x);
    const xs = r.log.lines.filter((l) => l.msg === "xs").map((l) => l.data as Record<string, unknown>);
    expect(xs.filter((d) => d["op"] === "broadcast")).toEqual([
      expect.objectContaining({ op: "broadcast", outcome: "applied", recipients: 2, textLen: 11, wake: false }),
    ]);
    const rows = xs.filter((d) => d["op"] === "send");
    expect(rows).toHaveLength(2);
    for (const d of rows) expect(d).toMatchObject({ bcast: true, outcome: "applied", fromSession: "sess-AAA" });
    expect(JSON.stringify(r.log.lines)).not.toContain("SECRET-BODY");
  });
});

describe("limits.admitBroadcast (pure)", () => {
  const mk = () => {
    const clock = { t: 50_000_000 };
    const limits = createXsLimits({ now: () => clock.t, hubSendsPerMin: 60 });
    return { clock, limits };
  };
  const rcpts = (n: number) => Array.from({ length: n }, (_, i) => ({ pairKey: `A>R${i}` }));
  const lim = { ...LIMITS, ...BCAST_LIMITS, inFlightPerSession: 16, wakesOutPerHour: 60, pairWakesPerHour: 20 };
  const ok = (a: XsBroadcastAdmit) => {
    if (!a.ok) throw new Error(a.reason);
    return a;
  };

  it("implements the CH0-frozen XsLimitsBroadcast port", () => {
    const port: FrozenXsLimitsBroadcast = mk().limits;
    expect(typeof port.admitBroadcast).toBe("function");
    expect(typeof port.settleBroadcast).toBe("function");
  });

  it("hard ceilings: wakeMaxRecipients > 4 and broadcastWakesOutPerHour > 2 are clamped down", () => {
    const { clock, limits } = mk();
    const five = ok(
      limits.admitBroadcast({
        agentKey: "a",
        recipients: rcpts(5),
        limits: lim,
        wantWake: true,
        wakeMaxRecipients: 99,
      }),
    );
    expect(five).toMatchObject({ wake: false, wakeDowngraded: "broadcast_wake_fanout" });
    const big = { ...lim, broadcastWakesOutPerHour: 9, broadcastsOutPerHour: 60, broadcastMinIntervalMs: 10_000 };
    const results: Array<boolean> = [];
    for (let i = 0; i < 4; i++) {
      clock.t += 10_000;
      results.push(
        ok(
          limits.admitBroadcast({
            agentKey: "b",
            recipients: rcpts(1),
            limits: big,
            wantWake: true,
            wakeMaxRecipients: 4,
          }),
        ).wake,
      );
    }
    expect(results).toEqual([true, true, false, false]);
  });

  it("a refusal consumes nothing: the same request after the blocker clears is admitted with full room", () => {
    const { limits } = mk();
    const tight = { ...lim, sendsOutPerMin: 3 };
    expect(
      limits.admitBroadcast({
        agentKey: "a",
        recipients: rcpts(4),
        limits: tight,
        wantWake: false,
        wakeMaxRecipients: 4,
      }),
    ).toEqual({
      ok: false,
      reason: "rate_sends_min",
    });
    const t = ok(
      limits.admitBroadcast({
        agentKey: "a",
        recipients: rcpts(3),
        limits: tight,
        wantWake: true,
        wakeMaxRecipients: 4,
      }),
    );
    expect(t.wake).toBe(true);
    expect(t.rows).toEqual([{ wake: true }, { wake: true }, { wake: true }]);
    limits.settleBroadcast(t.ticket);
    limits.settleBroadcast(t.ticket); // idempotent
    expect(t.ticket.settled).toBe(true);
  });

  it("settleBroadcast never refunds: windows stay spent after settle", () => {
    const { clock, limits } = mk();
    const l1 = { ...lim, broadcastWakesOutPerHour: 1, broadcastMinIntervalMs: 10_000 };
    const t = ok(
      limits.admitBroadcast({ agentKey: "a", recipients: rcpts(2), limits: l1, wantWake: true, wakeMaxRecipients: 4 }),
    );
    limits.settleBroadcast(t.ticket);
    clock.t += 10_000;
    expect(
      ok(
        limits.admitBroadcast({
          agentKey: "a",
          recipients: rcpts(2),
          limits: l1,
          wantWake: true,
          wakeMaxRecipients: 4,
        }),
      ),
    ).toMatchObject({
      wake: false,
      wakeDowngraded: "broadcast_wake_rate",
    });
  });
});
