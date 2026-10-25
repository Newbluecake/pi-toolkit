import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XsAckFrame, XsDeliverFrame, XsReqFrame, XsResFrame } from "../../../src/web-hub/protocol/xs.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import {
  emitQuiet,
  quietVerdict,
  XS_MIRROR_QUEUED,
  type XsQuietDelivered,
  type XsQuietObserver,
} from "../../../src/web-hub/hub/xs/mirror.js";
import { createXsRelay, type XsRelay } from "../../../src/web-hub/hub/xs/router.js";
import { fakeConn, hello, memLog, type FakeConn, type MemLog } from "./helpers.js";
import { BCAST_LIMITS, CHANNEL_CAPS, LIMITS, memberFrame, session } from "./xs-fixtures.js";

/** feishu-xs-mirror P2: the quiet-delivery observation point (plan §3.2 / §4.1 / §7.1). */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- rig (fixtures' rig has no observer seam)

interface MRig {
  clock: { t: number };
  registry: ReturnType<typeof createRegistry>;
  relay: XsRelay;
  log: MemLog;
  events: string[];
  agent(o: {
    pid: number;
    sessionId: string;
    name?: string;
    channels?: string[];
    caps?: string[];
    limits?: Partial<typeof LIMITS>;
  }): { key: string; conn: FakeConn };
}

function mrig(observer: XsQuietObserver | undefined, opts: { logInfoThrowsOn?: string } = {}): MRig {
  const clock = { t: 1_000_000 };
  const base = memLog();
  const log: MemLog = {
    lines: base.lines,
    info: (msg, data) => {
      if (opts.logInfoThrowsOn !== undefined && (data as { op?: string } | undefined)?.op === opts.logInfoThrowsOn) {
        throw new Error("audit boom");
      }
      base.info(msg, data);
    },
    warn: base.warn,
    error: base.error,
  };
  const registry = createRegistry({ now: () => clock.t, log, pidAlive: () => true });
  const relay = createXsRelay({
    registry,
    config: { home: "/home/u", crossSession: { limits: { hubSendsPerMin: 60 } } },
    log,
    now: () => clock.t,
    ...(observer === undefined ? {} : { onQuietDelivered: observer }),
  });
  return {
    clock,
    registry,
    relay,
    log,
    events: [],
    agent(o) {
      const conn = fakeConn();
      const { agentKey } = registry.register(
        hello({
          agentId: { pid: o.pid, nonce: `nonce${String(o.pid).padStart(15, "0")}` },
          caps: o.caps ?? ["ev.v1", "xs.v1"],
          cwd: "/tmp/work",
        }),
        conn,
      );
      registry.onFrame(
        agentKey,
        session({ sessionId: o.sessionId, cwd: "/tmp/work", ...(o.name !== undefined ? { name: o.name } : {}) }),
      );
      registry.onFrame(
        agentKey,
        memberFrame({
          sessionId: o.sessionId,
          epoch: 1,
          joined: true,
          receive: "wake",
          limits: { ...LIMITS, ...(o.limits ?? {}) },
          ...(o.channels === undefined ? {} : { channels: o.channels }),
        }),
      );
      return { key: agentKey, conn };
    },
  };
}

let seq = 0;
const SA = "sess-AAAAAAAA";
const B_ID = "sess-BBBBBBBBBBBB-long";
const REPLY_CAPS = ["ev.v1", "xs.v1", "xs.reply.v1"];
const REQUEST_ID = "q0123456789abcdef01";

const delivers = (conn: { sent: unknown[] }): XsDeliverFrame[] =>
  conn.sent.filter((x) => (x as { t?: string }).t === "xs_deliver") as XsDeliverFrame[];
function call(r: MRig, key: string, frame: XsReqFrame): XsResFrame[] {
  const out: XsResFrame[] = [];
  r.relay.router.handle(key, frame, (res) => out.push(res));
  return out;
}
const send = (over: Partial<XsReqFrame> = {}, sessionId = SA): XsReqFrame => ({
  t: "xs_req",
  rid: `s${++seq}`,
  op: "send",
  origin: { sessionId, epoch: 1 },
  to: B_ID,
  text: "hello B",
  ...over,
});
const bcast = (over: Partial<XsReqFrame> = {}): XsReqFrame => ({
  t: "xs_req",
  rid: `b${++seq}`,
  op: "broadcast",
  origin: { sessionId: SA, epoch: 1 },
  channel: "team",
  text: "hello all",
  ...over,
});
async function ack(r: MRig, a: { key: string; conn: { sent: unknown[] } }, over: Partial<XsAckFrame> = {}) {
  const d = delivers(a.conn).at(-1)!;
  r.registry.onFrame(a.key, { t: "xs_ack", rid: d.rid, xid: d.xid, effect: "applied", woke: false, ...over });
  await vi.advanceTimersByTimeAsync(0);
  return d;
}

function pair(observer: XsQuietObserver | undefined, caps = REPLY_CAPS) {
  const r = mrig(observer);
  const a = r.agent({ pid: 1, sessionId: SA, name: "alpha", caps });
  const b = r.agent({ pid: 2, sessionId: B_ID, name: "beta", caps });
  return { r, a, b };
}

// ---------------------------------------------------------------- quietVerdict

describe("quietVerdict (§3.2 truth table)", () => {
  it("XS_MIRROR_QUEUED is true (Q2)", () => {
    expect(XS_MIRROR_QUEUED).toBe(true);
  });
  const N = { late: false, queued: false };
  it.each([
    [{ effect: "applied", woke: false }, N],
    [
      { effect: "applied", woke: false, reason: "reply_late" },
      { late: true, queued: false },
    ],
    [
      { effect: "unknown", woke: false, reason: "queued" },
      { late: false, queued: true },
    ],
    // not mirrored
    [{ effect: "applied", woke: true }, undefined],
    [{ effect: "unknown", woke: true, reason: "start_deferred" }, undefined],
    [{ effect: "unknown", woke: true, reason: "queued" }, undefined],
    [{ effect: "unknown", woke: false, reason: "accept_unverified" }, undefined],
    [{ effect: "unknown", woke: false, reason: "receiver_error" }, undefined],
    [{ effect: "unknown", woke: false }, undefined],
    [{ effect: "none", woke: false }, undefined],
    [{ effect: "none", woke: false, reason: "rejected" }, undefined],
    [{ effect: "none", woke: false, reason: "queued" }, undefined],
    [{ effect: "applied", woke: false, reason: "something_else" }, undefined],
    [{ effect: "applied", woke: false, reason: "reply late!" }, undefined], // non-token reason
    [{ effect: "unknown", woke: false, reason: "queued now" }, undefined], // non-token reason
    [{ effect: "applied", woke: false, reason: "" }, undefined],
    [{ effect: "applied" }, N], // woke omitted ≡ not woken
  ])("%j ⇒ %j", (ack, want) => {
    expect(quietVerdict(ack)).toEqual(want);
  });
});

describe("emitQuiet", () => {
  const ev = { sessionId: "s" } as XsQuietDelivered;
  it("no observer / no events ⇒ nothing is even queued; observer runs on a microtask; throws are swallowed with a bare code", async () => {
    const log = memLog();
    const spy = vi.fn();
    emitQuiet(undefined, [ev], log);
    emitQuiet(spy, [], log);
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    emitQuiet(spy, [ev, ev], log);
    expect(spy).not.toHaveBeenCalled(); // deferred
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
    emitQuiet(
      () => {
        throw new Error("secret body");
      },
      [ev, ev],
      log,
    );
    await Promise.resolve();
    expect(log.lines.filter((l) => l.level === "warn")).toEqual([
      { level: "warn", msg: "xs mirror observer failed", data: { code: "E_XS_MIRROR" } },
      { level: "warn", msg: "xs mirror observer failed", data: { code: "E_XS_MIRROR" } },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("secret");
  });
});

// ---------------------------------------------------------------- send

describe("send observation", () => {
  it("applied/woke:false ⇒ exactly one event after a microtask, fields from hub records", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, b } = pair((e) => seen.push(e));
    call(r, a.key, send());
    const d = await ack(r, b);
    expect(seen).toEqual([
      {
        sessionId: B_ID,
        agentKey: b.key,
        xid: d.xid,
        kind: "message",
        from: { ref: SA.slice(0, 12), name: "alpha" },
        text: "hello B",
      },
    ]);
    expect(seen[0]).not.toHaveProperty("late");
    expect(seen[0]).not.toHaveProperty("queued");
    expect(seen[0]).not.toHaveProperty("wakeDowngraded");
  });

  it("from.alias is the hub-stamped alias of the deliver frame (absent without alias)", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, b } = pair((e) => seen.push(e));
    call(r, a.key, send());
    expect(delivers(b.conn)[0]!.from).not.toHaveProperty("alias");
    await ack(r, b);
    expect(seen[0]!.from).not.toHaveProperty("alias");
  });

  it("reply: kind reply + late on reply_late; queued on unknown{queued}", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, b } = pair((e) => seen.push(e));
    call(r, a.key, send({ replyTo: REQUEST_ID, wake: true, level: 3 }));
    await ack(r, b, { reason: "reply_late" });
    call(r, a.key, send({ replyTo: REQUEST_ID }));
    await ack(r, b, { effect: "unknown", reason: "queued" });
    r.clock.t += 10_000;
    call(r, a.key, send({ text: "busy" }));
    await ack(r, b, { effect: "unknown", reason: "queued" });
    expect(seen.map((e) => [e.kind, e.late, e.queued, e.text])).toEqual([
      ["reply", true, undefined, "hello B"],
      ["reply", undefined, true, "hello B"],
      ["message", undefined, true, "busy"],
    ]);
  });

  it("wakeDowngraded: from the ack, and from admit (outbound_wake_rate) when the ack carries none", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, b } = pair((e) => seen.push(e));
    call(r, a.key, send({ wake: true, level: 0 }));
    await ack(r, b, { wakeDowngraded: "busy" });
    expect(seen[0]!.wakeDowngraded).toBe("busy");
    // admit-side: exhaust the outbound wakes
    const r2 = mrig((e) => seen.push(e));
    const a2 = r2.agent({
      pid: 1,
      sessionId: SA,
      caps: REPLY_CAPS,
      limits: { wakesOutPerHour: 1, pairMinIntervalMs: 0 },
    });
    const b2 = r2.agent({ pid: 2, sessionId: B_ID, name: "beta", caps: REPLY_CAPS });
    call(r2, a2.key, send({ wake: true, level: 0 }));
    await ack(r2, b2, { woke: true });
    r2.clock.t += 10_000;
    call(r2, a2.key, send({ wake: true, level: 0 }));
    expect(delivers(b2.conn).at(-1)!.wake).toBe(false);
    await ack(r2, b2);
    expect(seen.at(-1)!.wakeDowngraded).toBe("outbound_wake_rate");
  });

  it.each([
    ["woke:true", { woke: true }],
    ["none", { effect: "none" as const }],
    ["none{rejected}", { effect: "none" as const, reason: "rejected" }],
    ["unknown{accept_unverified}", { effect: "unknown" as const, reason: "accept_unverified" }],
    ["unknown{receiver_error}", { effect: "unknown" as const, reason: "receiver_error" }],
    ["unknown{start_deferred}+woke", { effect: "unknown" as const, reason: "start_deferred", woke: true }],
    ["applied with a non-token reason", { reason: "has spaces" }],
  ])("%s ⇒ 0 observations", async (_n, over) => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, b } = pair((e) => seen.push(e));
    call(r, a.key, send());
    await ack(r, b, over as Partial<XsAckFrame>);
    expect(seen).toEqual([]);
  });

  it("deadline / ack_mismatch / late ack after timeout / duplicate ack ⇒ 0 observations", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, b } = pair((e) => seen.push(e));
    // deadline
    call(r, a.key, send());
    const d1 = delivers(b.conn).at(-1)!;
    await vi.advanceTimersByTimeAsync(5_001);
    // late ack after the hub settled
    r.registry.onFrame(b.key, { t: "xs_ack", rid: d1.rid, xid: d1.xid, effect: "applied", woke: false });
    await vi.advanceTimersByTimeAsync(0);
    // ack_mismatch
    r.clock.t += 10_000;
    call(r, a.key, send());
    const d2 = delivers(b.conn).at(-1)!;
    r.registry.onFrame(b.key, { t: "xs_ack", rid: d2.rid, xid: "xWRONG", effect: "applied", woke: false });
    await vi.advanceTimersByTimeAsync(0);
    // duplicate ack: first (woke) settles, second applied/quiet must not be observed
    r.clock.t += 10_000;
    call(r, a.key, send());
    const d3 = delivers(b.conn).at(-1)!;
    r.registry.onFrame(b.key, { t: "xs_ack", rid: d3.rid, xid: d3.xid, effect: "applied", woke: true });
    r.registry.onFrame(b.key, { t: "xs_ack", rid: d3.rid, xid: d3.xid, effect: "applied", woke: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });

  it("timing: observer runs after settleOut (res + audit) and not synchronously inside the ack continuation", async () => {
    const order: string[] = [];
    let auditSeenAtObserver = 0;
    let r!: MRig;
    r = mrig(() => {
      order.push("observer");
      auditSeenAtObserver = r.log.lines.filter((l) => (l.data as { op?: string })?.op === "send").length;
    });
    const a = r.agent({ pid: 1, sessionId: SA, caps: REPLY_CAPS });
    const b = r.agent({ pid: 2, sessionId: B_ID, name: "beta", caps: REPLY_CAPS });
    r.relay.router.handle(a.key, send(), () => order.push("res"));
    await ack(r, b);
    expect(order).toEqual(["res", "observer"]);
    expect(auditSeenAtObserver).toBe(1);
  });

  it("an observer that throws does not change res / audit / frames / limits", async () => {
    async function run(observer: XsQuietObserver | undefined) {
      const { r, a, b } = pair(observer);
      const out = call(r, a.key, send());
      await ack(r, b);
      return {
        out: JSON.stringify(out).replace(/"rid":"[a-z]\d+"/g, '"rid":"RID"'),
        sent: [a.conn.sent, b.conn.sent].map((x) =>
          JSON.stringify(x)
            .replace(/x[0-9a-f]{18}/g, "XID")
            .replace(/"rid":"[a-z]\d+"/g, '"rid":"RID"'),
        ),
        audit: JSON.stringify(r.log.lines.filter((l) => l.msg !== "xs mirror observer failed")).replace(
          /x[0-9a-f]{18}/g,
          "XID",
        ),
        limits: r.relay.limits.snapshot(),
      };
    }
    const off = await run(undefined);
    const on = await run(() => undefined);
    const boom = await run(() => {
      throw new Error("boom");
    });
    expect(on).toEqual(off);
    expect(boom).toEqual(off);
  });
});

// ---------------------------------------------------------------- broadcast

type AgentOpts = Parameters<MRig["agent"]>[0];
function team(observer: XsQuietObserver | undefined, n: number, senderLimits: Partial<typeof LIMITS> = {}, mopts = {}) {
  const r = mrig(observer, mopts);
  const a = r.agent({
    pid: 1,
    sessionId: SA,
    name: "alpha",
    caps: CHANNEL_CAPS,
    channels: ["default", "team"],
    limits: { ...BCAST_LIMITS, ...senderLimits },
  } as AgentOpts);
  const rcpts = Array.from({ length: n }, (_, i) => {
    r.clock.t += 1;
    return r.agent({
      pid: 10 + i,
      sessionId: `sess-R${i}-000000`,
      name: `n${10 + i}`,
      caps: CHANNEL_CAPS,
      channels: ["team"],
      limits: BCAST_LIMITS,
    } as AgentOpts);
  });
  return { r, a, rcpts };
}

describe("broadcast observation", () => {
  it("mixed results ⇒ only applied/queued rows observed once each, channel set, partial still mirrors", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, rcpts } = team((e) => seen.push(e), 6);
    // 6th recipient is a duplicate holder of rcpts[5]'s sessionId ⇒ ambiguous row (no delivery)
    r.agent({
      pid: 99,
      sessionId: "sess-R5-000000",
      caps: CHANNEL_CAPS,
      channels: ["team"],
      limits: BCAST_LIMITS,
    } as AgentOpts);
    const out = call(r, a.key, bcast());
    // rows are ordered most-recent-first: the duplicate pid99 made R5 ambiguous; rows = R5(amb),R4,R3,R2,R1,R0
    const results: Array<[number, Partial<XsAckFrame>]> = [
      [4, {}], // applied ⇒ mirrored
      [3, { effect: "unknown", reason: "queued" }], // queued ⇒ mirrored
      [2, { effect: "none", reason: "rejected" }],
      [1, { effect: "unknown", reason: "accept_unverified" }],
      [0, { woke: true }],
    ];
    for (const [i, over] of results) await ack(r, rcpts[i]!, over);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ effect: "unknown", reason: "partial" });
    expect(seen.map((e) => [e.sessionId, e.queued, e.kind, e.channel])).toEqual([
      ["sess-R4-000000", undefined, "broadcast", "team"],
      ["sess-R3-000000", true, "broadcast", "team"],
    ]);
    expect(seen[0]).toMatchObject({
      from: { ref: SA.slice(0, 12), name: "alpha" },
      text: "hello all",
      agentKey: rcpts[4]!.key,
    });
    expect(seen[0]).not.toHaveProperty("late");
  });

  it("wakeDowngraded fallback chain: ack > row (pair_wake_rate) > whole (step1 / admit)", async () => {
    // ack-sourced
    {
      const seen: XsQuietDelivered[] = [];
      const { r, a, rcpts } = team((e) => seen.push(e), 1);
      call(r, a.key, bcast({ wake: true, level: 0 }));
      await ack(r, rcpts[0]!, { wakeDowngraded: "busy" });
      expect(seen.map((e) => e.wakeDowngraded)).toEqual(["busy"]);
    }
    // row-sourced: spend the A→R0 pair wake with a P2P wake send first
    {
      const seen: XsQuietDelivered[] = [];
      const { r, a, rcpts } = team((e) => seen.push(e), 2, { pairWakesPerHour: 1 });
      r.relay.router.handle(
        a.key,
        {
          t: "xs_req",
          rid: "w0",
          op: "send",
          origin: { sessionId: SA, epoch: 1 },
          to: "sess-R0-000000",
          text: "x",
          wake: true,
          level: 0,
        },
        () => undefined,
      );
      await ack(r, rcpts[0]!, { woke: true });
      expect(seen).toEqual([]);
      call(r, a.key, bcast({ wake: true, level: 0 }));
      await ack(r, rcpts[0]!);
      await ack(r, rcpts[1]!, { woke: true });
      expect(seen.map((e) => [e.sessionId, e.wakeDowngraded])).toEqual([["sess-R0-000000", "pair_wake_rate"]]);
    }
    // whole step1
    for (const [level, dg] of [
      [undefined, "sender_wake_disabled"],
      [1, "level_limit"],
    ] as const) {
      const seen: XsQuietDelivered[] = [];
      const { r, a, rcpts } = team((e) => seen.push(e), 2);
      call(r, a.key, bcast({ wake: true, ...(level === undefined ? {} : { level }) }));
      for (const x of rcpts) await ack(r, x);
      expect(seen.map((e) => e.wakeDowngraded)).toEqual([dg, dg]);
    }
    // whole admit: fanout / broadcast rate / outbound rate
    {
      const seen: XsQuietDelivered[] = [];
      const { r, a, rcpts } = team((e) => seen.push(e), 5);
      call(r, a.key, bcast({ wake: true, level: 0 }));
      for (const x of rcpts) await ack(r, x);
      expect(seen.map((e) => e.wakeDowngraded)).toEqual(Array(5).fill("broadcast_wake_fanout"));
    }
    {
      const seen: XsQuietDelivered[] = [];
      const { r, a, rcpts } = team((e) => seen.push(e), 1, { broadcastWakesOutPerHour: 1 });
      call(r, a.key, bcast({ wake: true, level: 0 }));
      await ack(r, rcpts[0]!);
      r.clock.t += 60_000;
      seen.length = 0;
      call(r, a.key, bcast({ wake: true, level: 0 }));
      await ack(r, rcpts[0]!);
      expect(seen.map((e) => e.wakeDowngraded)).toEqual(["broadcast_wake_rate"]);
    }
    {
      const seen: XsQuietDelivered[] = [];
      const { r, a, rcpts } = team((e) => seen.push(e), 2, { wakesOutPerHour: 3 });
      call(r, a.key, bcast({ wake: true, level: 0 }));
      for (const x of rcpts) await ack(r, x);
      r.clock.t += 60_000;
      seen.length = 0;
      call(r, a.key, bcast({ wake: true, level: 0 }));
      for (const x of rcpts) await ack(r, x);
      expect(seen.map((e) => e.wakeDowngraded)).toEqual(["outbound_wake_rate", "outbound_wake_rate"]);
    }
  });

  it("timing: observer runs after releaseSlot → res → aggregate audit, never inside the row continuation", async () => {
    const order: string[] = [];
    let r!: MRig;
    let auditAtObserver = 0;
    r = mrig(() => {
      order.push("observer");
      auditAtObserver = r.log.lines.filter((l) => (l.data as { op?: string })?.op === "broadcast").length;
    });
    const a = r.agent({
      pid: 1,
      sessionId: SA,
      caps: CHANNEL_CAPS,
      channels: ["default", "team"],
      limits: BCAST_LIMITS,
    } as AgentOpts);
    const rc = r.agent({
      pid: 10,
      sessionId: "sess-R0-000000",
      caps: CHANNEL_CAPS,
      channels: ["team"],
      limits: BCAST_LIMITS,
    } as AgentOpts);
    const orig = r.relay.limits.settleBroadcast.bind(r.relay.limits);
    r.relay.limits.settleBroadcast = (t) => {
      order.push("slot");
      orig(t);
    };
    r.relay.router.handle(a.key, bcast(), () => order.push("res"));
    await ack(r, rc);
    expect(order).toEqual(["slot", "res", "observer"]);
    expect(auditAtObserver).toBe(1);
  });

  it(".catch aggregate failure: slot released, internal error answered, THEN candidates observed", async () => {
    const order: string[] = [];
    const seen: XsQuietDelivered[] = [];
    const { r, a, rcpts } = team(
      (e) => (seen.push(e), order.push("observer")),
      1,
      {},
      { logInfoThrowsOn: "broadcast" },
    );
    const orig = r.relay.limits.settleBroadcast.bind(r.relay.limits);
    r.relay.limits.settleBroadcast = (t) => {
      order.push("slot");
      orig(t);
    };
    const origWarn = r.log.warn;
    r.log.warn = (m, d) => {
      order.push(`warn:${m}`);
      origWarn(m, d);
    };
    r.relay.router.handle(a.key, bcast(), (x) => order.push(x.ok ? "res-ok" : `res-${x.code}`));
    await ack(r, rcpts[0]!);
    expect(order).toEqual(["slot", "res-ok", "res-E_XS_INTERNAL", "warn:xs handler failed", "observer"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "broadcast", channel: "team" });
  });

  it("observer-on/off byte parity: frames, sender xs_res and audit lines; also when the observer throws", async () => {
    async function run(observer: XsQuietObserver | undefined) {
      const { r, a, rcpts } = team(observer, 3);
      const out = call(r, a.key, bcast({ wake: true, level: 0 }));
      await ack(r, rcpts[2]!, {});
      await ack(r, rcpts[1]!, { effect: "unknown", reason: "queued" });
      await ack(r, rcpts[0]!, { woke: true });
      const norm = (v: unknown) =>
        JSON.stringify(v)
          .replace(/x[0-9a-f]{18}/g, "XID")
          .replace(/"rid":"[a-z]\d+"/g, '"rid":"RID"');
      return {
        out: norm(out),
        sent: norm([a.conn.sent, ...rcpts.map((x) => x.conn.sent)]),
        audit: norm(r.log.lines.filter((l) => l.msg !== "xs mirror observer failed")),
        limits: r.relay.limits.snapshot(),
      };
    }
    const off = await run(undefined);
    expect(await run(() => undefined)).toEqual(off);
    expect(
      await run(() => {
        throw new Error("boom");
      }),
    ).toEqual(off);
  });

  it("no observer ⇒ nothing queued (undefined path); all-failed broadcast ⇒ 0 observations", async () => {
    const seen: XsQuietDelivered[] = [];
    const { r, a, rcpts } = team((e) => seen.push(e), 2);
    call(r, a.key, bcast());
    await vi.advanceTimersByTimeAsync(5_001); // every row hits the deadline
    expect(seen).toEqual([]);
    expect(rcpts).toHaveLength(2);
  });
});
