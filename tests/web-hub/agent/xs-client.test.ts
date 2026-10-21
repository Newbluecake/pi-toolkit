/**
 * fabric phase-2 X2 (phase2-plan §11.2「X2」行 / §8.2): the agent-side xs client anchors —
 * hub-port transport classification, the per-op request deadline table, the `xs_deliver`
 * exactly-one-ack contract, and stale-link deliver gating. Everything runs against a REAL
 * `Connection` over the fake socket (no hub process; the hub side is X1's `xs-socket.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, type AcquireOptions, type HubConnection } from "../../../src/web-hub/agent/connection.js";
import { createXsAgentBridge, type XsAgentPort, type XsStackPort } from "../../../src/web-hub/agent/xs.js";
import type { XsAckVerdict } from "../../../src/fabric/xs/dedup.js";
import { XS_HUB_CAP, XS_REQ_DEADLINE_MS } from "../../../src/web-hub/protocol/xs.js";
import type { XsDeliverFrame, XsMemberLimitsWire } from "../../../src/web-hub/protocol/xs.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS, tmpDir, type FakeSocket } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir();
  resetGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  resetGlobals();
  vi.useRealTimers();
  tmp.cleanup();
});

function opts(over: Partial<AcquireOptions> = {}): AcquireOptions {
  return {
    buildId: "1.0.0@abc",
    pluginVersion: "1.0.0",
    kind: "tui",
    cwd: "/tmp/wa",
    paths: pathsIn(tmp.dir),
    settings: SETTINGS,
    launcher: { error: "no loader in tests" },
    now: () => Date.now(),
    random: () => 0.5,
    ...over,
  };
}

function liveFake(caps?: string[]): { conn: HubConnection; sock: FakeSocket } {
  const n = fakeNet();
  const conn = acquireConnection(opts({ netConnect: n.netConnect }));
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame("a1-abcdef", 4242, caps));
  return { conn, sock: s };
}

const LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 30_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
};

interface StackState {
  sessionId: string;
  epoch: number;
  joined: boolean;
  verdict?: XsAckVerdict;
  thrown?: boolean;
  delivered: XsDeliverFrame[];
}

function fakePort(state: StackState): XsAgentPort {
  const stack: XsStackPort = {
    sessionId: () => state.sessionId,
    member: () => ({ epoch: state.epoch, joined: state.joined, receive: "wake" }),
    deliver: (frame) => {
      state.delivered.push(frame);
      if (state.thrown) throw new Error("pipeline boom");
      return state.verdict ?? { effect: "applied", woke: false };
    },
    status: () => ({ joined: state.joined, receive: "wake", blocked: 0 }),
  };
  return { stack: () => stack, memberLimits: () => ({ ...LIMITS }), hubSendsPerMin: () => 60 };
}

function deliverFrame(rid = "d1", xid = "x1"): XsDeliverFrame {
  return {
    t: "xs_deliver",
    rid,
    xid,
    to: { sessionId: "sess-aaaaaaaaaaaa", epoch: 7 },
    from: { sessionId: "sess-bbbbbbbbbbbb", ref: "sess-bbbbbbbb", cwdLabel: "~/x", agentId: "a2-key" },
    text: "hello",
    wake: false,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

describe("xs hub port (XsHubPort adapter, §8.2)", () => {
  it("no cap ⇒ {kind:'off'} — E_XS_OFF{hub}, nothing sent", async () => {
    const { conn, sock } = liveFake(["cmd.v1"]); // live hub WITHOUT xs.v1
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const before = sock.written.length;
    const reply = await bridge.hubPort().send({ origin: { sessionId: "s", epoch: 1 }, to: "t", text: "x" });
    expect(reply).toEqual({ kind: "off" });
    expect(sock.written.length).toBe(before); // nothing on the wire
  });

  it("cap present ⇒ exactly one xs_req frame, rid-correlated xs_res resolves it", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const p = bridge.hubPort().list({ origin: { sessionId: "s", epoch: 1 }, query: "a" });
    await vi.advanceTimersByTimeAsync(0);
    const frames = sock.frames();
    const req = frames.find((f) => f.t === "xs_req") as { rid: string; op: string; origin: unknown };
    expect(req).toBeDefined();
    expect(req.op).toBe("list");
    expect(req.origin).toEqual({ sessionId: "s", epoch: 1 });
    sock.hub({ t: "xs_res", rid: req.rid, ok: true, rows: [] });
    await expect(p).resolves.toEqual({
      kind: "res",
      res: { t: "xs_res", rid: req.rid, ok: true, rows: [] },
    });
  });

  it("send frame carries to/text, wake/level only when present (Q1 omit = false)", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    void bridge.hubPort().send({ origin: { sessionId: "s", epoch: 1 }, to: "t", text: "x" });
    void bridge.hubPort().send({ origin: { sessionId: "s", epoch: 1 }, to: "t2", text: "y", wake: true, level: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const reqs = sock.frames().filter((f) => f.t === "xs_req") as Array<{
      to: string;
      wake?: boolean;
      level?: number;
    }>;
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.wake).toBeUndefined();
    expect(reqs[0]!.level).toBeUndefined();
    expect(reqs[1]!.wake).toBe(true);
    expect(reqs[1]!.level).toBe(2);
  });

  it("link torn down mid-request ⇒ {kind:'link_lost'} (⇒ unknown downstream)", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const p = bridge.hubPort().send({ origin: { sessionId: "s", epoch: 1 }, to: "t", text: "x" });
    sock.fail("ECONNRESET");
    await expect(p).resolves.toEqual({ kind: "link_lost" });
  });

  it("no connection object at all ⇒ {kind:'link_lost'}", async () => {
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => undefined });
    await expect(bridge.hubPort().resolve({ origin: { sessionId: "s", epoch: 1 }, query: "q" })).resolves.toEqual({
      kind: "link_lost",
    });
  });
});

describe("request deadline table (§8.2: list/resolve/info 3s, send 8s)", () => {
  it.each([
    ["list", XS_REQ_DEADLINE_MS.list],
    ["resolve", XS_REQ_DEADLINE_MS.resolve],
  ] as const)("op %s times out at %dms without a reply", async (op, ms) => {
    const { conn } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const origin = { sessionId: "s", epoch: 1 };
    let settled = false;
    const p = (
      op === "list" ? bridge.hubPort().list({ origin }) : bridge.hubPort().resolve({ origin, query: "q" })
    ).then(
      (r) => {
        settled = true;
        return r;
      },
      (e) => {
        settled = true;
        throw e;
      },
    );
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(settled).toBe(false); // still pending right before its deadline
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    await expect(p).resolves.toEqual({ kind: "deadline" });
  });

  it("op info times out at 3s and maps to undefined", async () => {
    const { conn } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    let settled = false;
    const p = bridge.hubInfo().then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeUndefined();
  });

  it("op send times out at 8s — NOT at the generic 3s", async () => {
    const { conn } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const p = bridge.hubPort().send({ origin: { sessionId: "s", epoch: 1 }, to: "t", text: "x" });
    await vi.advanceTimersByTimeAsync(3_000); // generic admin timeout — must NOT fire
    const early = await Promise.race([p.then(() => true), Promise.resolve(false)]);
    expect(early).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000); // 8s total
    await expect(p).resolves.toEqual({ kind: "deadline" });
  });
});

describe("xs_deliver → exactly one xs_ack (§8.2, live-link-only)", () => {
  it("receiver verdict rides the ack verbatim, xid echoed", () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const state = { ...baseState(), verdict: { effect: "applied", woke: true } as XsAckVerdict };
    const bridge = createXsAgentBridge({ port: fakePort(state), conn: () => conn });
    bridge.onDeliver(deliverFrame("d9", "x42"));
    bridge.onDeliver(deliverFrame("d9", "x42")); // even a duplicate hand-off answers per call
    const acks = sock.frames().filter((f) => f.t === "xs_ack");
    expect(acks).toHaveLength(2); // one per deliver — the DEDUP layer is the receiver's, not ours
    expect(acks[0]).toEqual({ t: "xs_ack", rid: "d9", xid: "x42", effect: "applied", woke: true });
    expect(state.delivered).toHaveLength(2);
  });

  it("receiver throws ⇒ none{receiver_error} ack, still exactly one", () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const state = { ...baseState(), thrown: true };
    const bridge = createXsAgentBridge({ port: fakePort(state), conn: () => conn });
    bridge.onDeliver(deliverFrame());
    const acks = sock.frames().filter((f) => f.t === "xs_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ effect: "none", reason: "receiver_error", woke: false });
  });

  it("no stack (detached/replaced) ⇒ none{session_changed} ack", () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: { stack: () => undefined, ...emptyPortRest() }, conn: () => conn });
    bridge.onDeliver(deliverFrame());
    const acks = sock.frames().filter((f) => f.t === "xs_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ effect: "none", reason: "session_changed", woke: false });
  });

  it("xs_deliver on a non-live link never reaches the bridge (stale-link drop)", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    // still "connecting" — never handshook
    let called = 0;
    conn.attach(
      {
        onStateChange: () => undefined,
        onSnapshotReq: () => undefined,
        onBranchReq: () => undefined,
        onXsDeliver: () => {
          called += 1;
        },
      } as never,
      { sessionId: "s1", cwd: "/tmp/wa", reason: "startup", leafId: null, mode: "tui" } as never,
    );
    s.emit("data", Buffer.from(JSON.stringify(deliverFrame()) + "\n"));
    expect(called).toBe(0);
    expect(s.written.length).toBe(0); // no ack invented either
  });
});

describe("hubInfo / resolveBlock transport shapes", () => {
  it("hubInfo maps ok+hubLimits, undefined on failure", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const p = bridge.hubInfo();
    await vi.advanceTimersByTimeAsync(0);
    const req = sock.frames().find((f) => f.t === "xs_req") as { rid: string; op: string };
    expect(req.op).toBe("info");
    sock.hub({
      t: "xs_res",
      rid: req.rid,
      ok: true,
      hubLimits: { hubSendsPerMin: 60, expiresMs: 5000, deliverMs: 5000 },
    });
    await expect(p).resolves.toEqual({ hubSendsPerMin: 60, expiresMs: 5000, deliverMs: 5000 });
  });

  it("hubInfo with no stack ⇒ undefined", async () => {
    const bridge = createXsAgentBridge({ port: { stack: () => undefined, ...emptyPortRest() }, conn: () => undefined });
    await expect(bridge.hubInfo()).resolves.toBeUndefined();
  });

  it("resolveBlock: full-id query verified online returns the query as sessionId", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const full = "20261021_120000_ab12";
    const p = bridge.resolveBlock(full);
    await vi.advanceTimersByTimeAsync(0);
    const req = sock.frames().find((f) => f.t === "xs_req") as { rid: string };
    sock.hub({ t: "xs_res", rid: req.rid, ok: true, target: { ref: full.slice(0, 12), name: "peer" } });
    await expect(p).resolves.toEqual({ ok: true, sessionId: full, name: "peer" });
  });

  it("resolveBlock: learned full id from a received deliver beats the 12-char ref", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const state = { ...baseState() };
    const bridge = createXsAgentBridge({ port: fakePort(state), conn: () => conn });
    const full = "20261021_130000_cd34";
    bridge.onDeliver({
      ...deliverFrame(),
      from: { sessionId: full, ref: full.slice(0, 12), name: "peer", cwdLabel: "~/x", agentId: "k" },
    });
    const p = bridge.resolveBlock("peer"); // name query
    await vi.advanceTimersByTimeAsync(0);
    const req = sock
      .frames()
      .filter((f) => f.t === "xs_req")
      .pop() as { rid: string };
    sock.hub({ t: "xs_res", rid: req.rid, ok: true, target: { ref: full.slice(0, 12), name: "peer" } });
    await expect(p).resolves.toEqual({ ok: true, sessionId: full, name: "peer" });
  });

  it("resolveBlock: ambiguous ⇒ candidates pass through, nothing stored", async () => {
    const { conn, sock } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const p = bridge.resolveBlock("peer");
    await vi.advanceTimersByTimeAsync(0);
    const req = sock.frames().find((f) => f.t === "xs_req") as { rid: string };
    sock.hub({ t: "xs_res", rid: req.rid, ok: true, candidates: [{ ref: "aaaaaaaaaaaa" }, { ref: "bbbbbbbbbbbb" }] });
    await expect(p).resolves.toEqual({
      ok: false,
      kind: "ambiguous",
      candidates: [{ ref: "aaaaaaaaaaaa" }, { ref: "bbbbbbbbbbbb" }],
    });
  });

  it("resolveBlock: hub unreachable ⇒ offline; no stack ⇒ offline", async () => {
    const { conn } = liveFake([XS_HUB_CAP]);
    const bridge = createXsAgentBridge({ port: fakePort({ ...baseState() }), conn: () => conn });
    const p = bridge.resolveBlock("peer");
    conn.close("test");
    await expect(p).resolves.toEqual({ ok: false, kind: "offline" });
    const bridge2 = createXsAgentBridge({
      port: { stack: () => undefined, ...emptyPortRest() },
      conn: () => undefined,
    });
    await expect(bridge2.resolveBlock("peer")).resolves.toEqual({ ok: false, kind: "offline" });
  });
});

// --------------------------------------------------------------------- helpers

function baseState(): StackState {
  return { sessionId: "sess-aaaaaaaaaaaa", epoch: 7, joined: true, delivered: [] };
}

function emptyPortRest(): Pick<XsAgentPort, "memberLimits" | "hubSendsPerMin"> {
  return { memberLimits: () => ({ ...LIMITS }), hubSendsPerMin: () => 60 };
}
