/**
 * fabric-xs-activation plan §3 P1 (arch §4.4/§4.7): the AGENT bridge's state surface —
 * cap/config gating (`activationEnabled` port absent ⇒ byte-identical caps + HubConfig),
 * the source-side mirror (`onState` merges, drives a status republish, resolves a receipt
 * waiter), the receiver-stack subscription (evidence pushes as `xs_state`, `replyWritten`
 * marks `replied`), the `StatusInfo.xsRequests` projection (rows-or-absent) and the read-only
 * `receipt` round trip over a real connection (xs_res + the pushed xs_state correlated by
 * messageId; a refusal ⇒ unavailable, never a fabricated snapshot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireConnection,
  type AcquireOptions,
  type BindingPort,
  type HubConnection,
} from "../../../src/web-hub/agent/connection.js";
import { createXsAgentBridge, type XsAgentPort, type XsStackPort } from "../../../src/web-hub/agent/xs.js";
import { XS_HUB_CAP, XS_REPLY_HUB_CAP } from "../../../src/web-hub/protocol/xs.js";
import { XS_STATE_HUB_CAP, type XsProgress } from "../../../src/web-hub/protocol/xs-activation.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

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

const SESSION = {
  sessionId: "sess-aaaaaaaaaaaa",
  sessionFile: "/tmp/s1.jsonl",
  cwd: "/tmp/wa",
  reason: "startup",
  leafId: "e1",
  mode: "tui",
} as const;

const LIMITS = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 30_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
} as const;

interface FakeStackProgress {
  rowsStore: Map<string, XsProgress>;
  progressSubs: Set<(p: XsProgress) => void>;
  replySubs: Set<(requestId: string, at: number) => void>;
}

function makePort(over: { activation?: boolean; progress?: FakeStackProgress } = {}) {
  const fakeProgress: FakeStackProgress =
    over.progress ??
    ({
      rowsStore: new Map(),
      progressSubs: new Set(),
      replySubs: new Set(),
    } as FakeStackProgress);
  const stack: XsStackPort = {
    sessionId: () => SESSION.sessionId,
    member: () => ({ epoch: 3, joined: true, receive: "wake" }),
    deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
    status: () => ({ joined: true, receive: "wake", blocked: 0 }),
    progress: {
      subscribe: (cb) => {
        fakeProgress.progressSubs.add(cb);
        return () => fakeProgress.progressSubs.delete(cb);
      },
      subscribeReplyWritten: (cb) => {
        fakeProgress.replySubs.add(cb);
        return () => fakeProgress.replySubs.delete(cb);
      },
      rows: () => [...fakeProgress.rowsStore.values()],
      snapshot: (id) => fakeProgress.rowsStore.get(id),
    },
  };
  const port: XsAgentPort = {
    stack: () => stack,
    memberLimits: () => ({ ...LIMITS }),
    hubSendsPerMin: () => 60,
    ...(over.activation === undefined ? {} : { activationEnabled: () => over.activation! }),
  };
  return { port, fakeProgress };
}

const BINDING: BindingPort = {
  onStateChange: () => undefined,
  onSnapshotReq: () => undefined,
  onBranchReq: () => undefined,
};

describe("xs agent bridge: activation gating (fabric-xs-activation P1)", () => {
  it("activationEnabled absent/false ⇒ caps and HubConfig stay byte-identical (key absent)", () => {
    for (const activation of [undefined, false]) {
      const { port } = makePort(activation === undefined ? {} : { activation });
      const bridge = createXsAgentBridge({ port, conn: () => undefined });
      expect(bridge.caps()).toEqual(["xs.v1"]);
      const cfg = bridge.hubCrossSessionConfig();
      expect(cfg).toEqual({ limits: { hubSendsPerMin: 60 } });
      expect("activation" in cfg).toBe(false);
    }
  });

  it("activationEnabled true ⇒ the state cap is appended and the hub key written (activate cap NOT)", () => {
    const { port } = makePort({ activation: true });
    const bridge = createXsAgentBridge({ port, conn: () => undefined });
    expect(bridge.caps()).toEqual(["xs.v1", "xs.state.v1"]);
    expect(bridge.hubCrossSessionConfig()).toEqual({ limits: { hubSendsPerMin: 60 }, activation: true });
  });
});

describe("xs agent bridge: source-side mirror", () => {
  it("onState merges, bumps the projection revision and drives a status republish", () => {
    const { port } = makePort({ activation: true });
    const publishes = { n: 0 };
    const bridge = createXsAgentBridge({ port, conn: () => undefined, publishStatus: () => publishes.n++ });
    expect(bridge.requestsProjection()).toBeUndefined(); // no rows ⇒ absent (byte-equal status)
    bridge.onState({
      t: "xs_state",
      messageId: "x1",
      revision: 2,
      deliveryEffect: "unknown",
      observation: "live",
      wake: { requested: true, decision: "unknown" },
      sourceRid: "rid-1",
      activationKey: "k1",
      activationUntil: Date.now() + 30 * 60_000,
    });
    const projection = bridge.requestsProjection();
    expect(projection).toBeDefined();
    expect(projection!.sessionId).toBe(SESSION.sessionId);
    expect(projection!.revision).toBe(1);
    expect(projection!.rows[0]).toMatchObject({ messageId: "x1", activationKey: "k1" });
    expect(publishes.n).toBe(1);
    // a STALE revision (below the stored one) does not bump the projection revision again
    bridge.onState({
      t: "xs_state",
      messageId: "x1",
      revision: 0,
      deliveryEffect: "unknown",
      observation: "offline",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(bridge.requestsProjection()!.revision).toBe(1);
  });

  it("off ⇒ onState is a no-op (no mirror, no publish)", () => {
    const { port } = makePort({});
    const publishes = { n: 0 };
    const bridge = createXsAgentBridge({ port, conn: () => undefined, publishStatus: () => publishes.n++ });
    bridge.onState({
      t: "xs_state",
      messageId: "x1",
      revision: 0,
      deliveryEffect: "unknown",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(bridge.requestsProjection()).toBeUndefined();
    expect(publishes.n).toBe(0);
  });

  it("replyWritten marks the mirror row replied (requester-side fact)", () => {
    const { port, fakeProgress } = makePort({ activation: true });
    const bridge = createXsAgentBridge({ port, conn: () => undefined });
    bridge.onState({
      t: "xs_state",
      messageId: "xreq",
      revision: 0,
      deliveryEffect: "applied",
      phase: "delivered",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
      requestId: "q-1",
      replyState: "pending",
    });
    // wireProgress subscribes on the first onDeliver/publishMember — drive it via a deliver
    bridge.onDeliver({
      t: "xs_deliver",
      rid: "r",
      xid: "other",
      to: { sessionId: SESSION.sessionId, epoch: 3 },
      from: { sessionId: "sess-bbbb", ref: "ab12cd34ef56", cwdLabel: "~/p", agentId: "a" },
      text: "x",
      wake: false,
      expiresAt: Date.now() + 5_000,
    });
    // simulate the stack's reply pipeline confirming the solicited reply written
    for (const cb of fakeProgress.replySubs) cb("q-1", Date.now());
    expect(bridge.requestsProjection()!.rows[0]).toMatchObject({ phase: "replied", requestId: "q-1" });
  });
});

describe("xs agent bridge: receipt round trip (read-only, 3s)", () => {
  const STATE_CAPS = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP, XS_REPLY_HUB_CAP, XS_STATE_HUB_CAP];

  function liveConn(caps: string[]): {
    conn: HubConnection;
    sock: ReturnType<typeof fakeNet>["sockets"][number];
    n: ReturnType<typeof fakeNet>;
  } {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const sock = n.sockets[0]!;
    sock.emit("connect");
    sock.hub(ackFrame("k", 4242, caps));
    return { conn, sock, n };
  }

  it("ok + pushed xs_state resolves known; the waiter correlates by messageId", async () => {
    const { port } = makePort({ activation: true });
    const { conn, sock } = liveConn(STATE_CAPS);
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach({ ...BINDING, onXsState: (frame) => bridge.onState(frame) }, SESSION as never);
    const pending = bridge.hubPort().receipt!({ messageId: "xrcpt-1" });
    await vi.advanceTimersByTimeAsync(0);
    const reqFrame = sock.frames().find((f) => (f as { t?: string }).t === "xs_req") as {
      op: string;
      messageId?: string;
    };
    expect(reqFrame).toMatchObject({ op: "receipt", messageId: "xrcpt-1" });
    sock.hub({ t: "xs_res", rid: reqFrame.rid, ok: true });
    sock.hub({
      t: "xs_state",
      messageId: "xrcpt-1",
      revision: 2,
      deliveryEffect: "applied",
      phase: "delivered",
      observation: "live",
      wake: { requested: false, decision: "deliver_only" },
      sourceRid: "rid-orig",
    });
    const result = await pending;
    expect(result).toMatchObject({ status: "known", messageId: "xrcpt-1" });
    expect(result.progress).toMatchObject({ phase: "delivered", revision: 2 });
    // the answer push also fed the mirror
    expect(bridge.requestsProjection()!.rows[0]).toMatchObject({ messageId: "xrcpt-1" });
    conn.close("test");
  });

  it("a refusal (not tracked) ⇒ unavailable; a missing state push times out ⇒ unavailable", async () => {
    const { port } = makePort({ activation: true });
    const { conn, sock } = liveConn(STATE_CAPS);
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach({ ...BINDING, onXsState: (frame) => bridge.onState(frame) }, SESSION as never);
    const refused = bridge.hubPort().receipt!({ messageId: "x-none" });
    await vi.advanceTimersByTimeAsync(0);
    const req1 = sock.frames().find((f) => (f as { t?: string }).t === "xs_req") as { rid: string };
    sock.hub({ t: "xs_res", rid: req1.rid, ok: false, code: "E_XS_NOT_TRACKED", effect: "none" });
    expect(await refused).toMatchObject({ status: "unavailable", messageId: "x-none" });

    const silent = bridge.hubPort().receipt!({ messageId: "x-silent" });
    await vi.advanceTimersByTimeAsync(0);
    const req2 = [...sock.frames()].filter((f) => (f as { t?: string }).t === "xs_req").at(-1) as { rid: string };
    sock.hub({ t: "xs_res", rid: req2.rid, ok: true });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await silent).toMatchObject({ status: "unavailable", messageId: "x-silent" });
    conn.close("test");
  });

  it("a hub without the cap ⇒ unsupported (nothing sent); activation off ⇒ unsupported", async () => {
    const noCap = liveConn([...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP]);
    const onPort = makePort({ activation: true });
    const onBridge = createXsAgentBridge({ port: onPort.port, conn: () => noCap.conn });
    noCap.conn.attach({ ...BINDING }, SESSION as never);
    expect(await onBridge.hubPort().receipt!({ messageId: "x" })).toMatchObject({ status: "unsupported" });

    const offPort = makePort({});
    const offBridge = createXsAgentBridge({ port: offPort.port, conn: () => noCap.conn });
    expect(await offBridge.hubPort().receipt!({ messageId: "x" })).toMatchObject({ status: "unsupported" });
    noCap.conn.close("test");
  });
  it("P2 associates parallel sends ONLY by original sourceRid, not latest state/body", async () => {
    const { port } = makePort({ activation: true });
    const { conn, sock } = liveConn(STATE_CAPS);
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach({ ...BINDING, onXsState: (frame) => bridge.onState(frame) }, SESSION as never);
    const args = { origin: { sessionId: SESSION.sessionId, epoch: 3 }, to: "target", text: "same text" };
    const first = bridge.hubPort().send(args);
    const second = bridge.hubPort().send(args);
    await vi.advanceTimersByTimeAsync(0);
    const frames = sock.frames().filter((f) => f.t === "xs_req" && f.op === "send") as Array<{ rid: string }>;
    expect(frames).toHaveLength(2);
    for (const [i, req] of [...frames].reverse().entries()) {
      sock.hub({
        t: "xs_state",
        sourceRid: req.rid,
        messageId: `x${i}`,
        activationKey: `k${i}`,
        revision: 0,
        observation: "live",
        deliveryEffect: "unknown",
        wake: { requested: false, decision: "deliver_only" },
      });
      sock.hub({ t: "xs_res", rid: req.rid, ok: true, effect: "applied" });
    }
    expect(await first).toMatchObject({ progress: { messageId: "x1", activationKey: "k1" } });
    expect(await second).toMatchObject({ progress: { messageId: "x0", activationKey: "k0" } });
    conn.close("test");
  });

  it("P2 unmatched/late state cannot create send.track; intent is internal, revisions unchanged", async () => {
    const { port } = makePort({ activation: true });
    const { conn, sock } = liveConn(STATE_CAPS);
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach({ ...BINDING, onXsState: (frame) => bridge.onState(frame) }, SESSION as never);
    const pending = bridge.hubPort().send({
      origin: { sessionId: SESSION.sessionId, epoch: 3 },
      to: "target",
      text: "body",
      wakeView: { requested: true, defaulted: true, decision: "downgraded", stage: "sender", reason: "level_limit" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const req = sock.frames().find((f) => f.t === "xs_req" && f.op === "send") as { rid: string };
    expect(req).not.toHaveProperty("wakeView");
    expect(req).not.toHaveProperty("defaulted");
    sock.hub({
      t: "xs_state",
      sourceRid: req.rid,
      messageId: "original",
      revision: 0,
      observation: "live",
      deliveryEffect: "unknown",
      wake: { requested: false, decision: "deliver_only" },
    });
    // Receiver revision 0 is a new evidence point; source-private default must NOT bump it.
    sock.hub({
      t: "xs_state",
      sourceRid: req.rid,
      messageId: "original",
      revision: 0,
      observation: "live",
      deliveryEffect: "applied",
      phase: "delivered",
      wake: { requested: false, decision: "deliver_only" },
    });
    sock.hub({ t: "xs_res", rid: req.rid, ok: true, effect: "applied" });
    expect(await pending).toMatchObject({
      progress: { revision: 0, phase: "delivered", wake: { requested: true, defaulted: true, reason: "level_limit" } },
    });
    const withoutState = bridge
      .hubPort()
      .send({ origin: { sessionId: SESSION.sessionId, epoch: 3 }, to: "target", text: "body" });
    await vi.advanceTimersByTimeAsync(0);
    const req2 = sock
      .frames()
      .filter((f) => f.t === "xs_req" && f.op === "send")
      .at(-1) as { rid: string };
    sock.hub({ t: "xs_res", rid: req2.rid, ok: true, effect: "unknown" });
    expect(await withoutState).not.toHaveProperty("progress");
    sock.hub({
      t: "xs_state",
      sourceRid: req2.rid,
      messageId: "late",
      revision: 0,
      observation: "live",
      deliveryEffect: "unknown",
      wake: { requested: false, decision: "deliver_only" },
    });
    expect(bridge.requestsProjection()!.rows.some((r) => r.messageId === "late")).toBe(true);
    conn.close("test");
  });

  it("P2 target-state proof requires both live hub negotiation and authoritative resolve field", async () => {
    const { port } = makePort({ activation: true });
    const { conn, sock } = liveConn(STATE_CAPS);
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach(BINDING, SESSION as never);
    const pending = bridge.hubPort().resolve({ origin: { sessionId: SESSION.sessionId, epoch: 3 }, query: "target" });
    await vi.advanceTimersByTimeAsync(0);
    const req = sock.frames().find((f) => f.t === "xs_req" && f.op === "resolve") as { rid: string };
    sock.hub({ t: "xs_res", rid: req.rid, ok: true, target: { ref: "bbbb", sessionId: "target", xsState: true } });
    expect(await pending).toMatchObject({ targetState: true });
    expect(bridge.hubPort().stateCapable!()).toBe(true);
    conn.close("test");
  });
  it("P2 a transport timeout AFTER registration still exposes the original relation", async () => {
    const { port } = makePort({ activation: true });
    const { conn, sock } = liveConn(STATE_CAPS);
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach({ ...BINDING, onXsState: (frame) => bridge.onState(frame) }, SESSION as never);
    const pending = bridge
      .hubPort()
      .send({ origin: { sessionId: SESSION.sessionId, epoch: 3 }, to: "target", text: "body" });
    await vi.advanceTimersByTimeAsync(0);
    const req = sock.frames().find((f) => f.t === "xs_req" && f.op === "send") as { rid: string };
    sock.hub({
      t: "xs_state",
      sourceRid: req.rid,
      messageId: "registered",
      activationKey: "key",
      revision: 0,
      observation: "live",
      deliveryEffect: "unknown",
      wake: { requested: false, decision: "deliver_only" },
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await pending).toMatchObject({
      kind: "deadline",
      progress: { messageId: "registered", activationKey: "key" },
    });
    expect(sock.frames().filter((f) => f.t === "xs_req" && f.op === "send")).toHaveLength(1);
    conn.close("test");
  });
});

describe("#20 progressPhaseOf: synchronous read-only source mirror", () => {
  function setup(activation = true, stateCap = true) {
    const { port } = makePort({ activation });
    let sid = SESSION.sessionId as string;
    const stack = port.stack()!;
    stack.sessionId = () => sid;
    const publishStatus = vi.fn();
    const conn = {
      caps: stateCap ? [XS_STATE_HUB_CAP] : [],
      setSlot: vi.fn(),
      send: vi.fn(),
      status: () => ({ state: "live" }),
    } as unknown as HubConnection;
    const bridge = createXsAgentBridge({ port, conn: () => conn, publishStatus });
    bridge.publishMember(); // adopts the mirror identity; queries themselves may not do this
    const put = (over: Partial<XsProgress> = {}) =>
      bridge.onState({
        t: "xs_state",
        messageId: "x-phase",
        requestId: "q-phase",
        revision: 0,
        observation: "live",
        deliveryEffect: "applied",
        phase: "delivered",
        wake: { requested: false, decision: "deliver_only" },
        activationUntil: Date.now() + 600_000,
        ...over,
      });
    return {
      bridge,
      put,
      publishStatus,
      conn,
      switchSession: () => {
        sid = "different-session";
      },
    };
  }

  it.each(["queued", "delivered", "started", "replied"] as const)(
    "live %s is returned without changing revision, publishing, or sending",
    (phase) => {
      const h = setup();
      h.put({ phase });
      const before = h.bridge.requestsProjection();
      const publishes = h.publishStatus.mock.calls.length;
      const sends = vi.mocked(h.conn.send).mock.calls.length;
      expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBe(phase);
      expect(h.bridge.requestsProjection()).toEqual(before);
      expect(h.publishStatus).toHaveBeenCalledTimes(publishes);
      expect(h.conn.send).toHaveBeenCalledTimes(sends);
    },
  );

  it.each(["offline", "expired", "unavailable"] as const)(
    "observation %s is unknown, even with a retained started phase",
    (observation) => {
      const h = setup();
      h.put({ phase: "started", observation });
      expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBeUndefined();
    },
  );

  it("read-time deadline overlay is expired, not a current delivered observation", () => {
    const h = setup();
    h.put();
    vi.advanceTimersByTime(600_001);
    expect(h.bridge.requestsProjection()!.rows[0]).toMatchObject({ phase: "delivered", observation: "expired" });
    expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBeUndefined();
  });

  it("off, missing cap/row, wrong mirror sid, and switched current session are unknown", () => {
    for (const [on, cap] of [
      [false, true],
      [true, false],
    ]) {
      const h = setup(on, cap);
      h.put();
      expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBeUndefined();
    }
    const h = setup();
    h.put();
    expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "missing")).toBeUndefined();
    expect(h.bridge.progressPhaseOf!("wrong-sid", "q-phase")).toBeUndefined();
    h.switchSession();
    expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBeUndefined();
    expect(h.bridge.progressPhaseOf!("different-session", "q-phase")).toBeUndefined();
  });

  it("duplicate requestIds agree or fail closed on conflicting phase/non-live row", () => {
    const h = setup();
    h.put();
    h.put({ messageId: "x2" });
    expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBe("delivered");
    h.put({ messageId: "x2", revision: 1, phase: "started" });
    expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBeUndefined();
    h.put({ messageId: "x-phase", revision: 1, phase: "started", observation: "offline" });
    expect(h.bridge.progressPhaseOf!(SESSION.sessionId, "q-phase")).toBeUndefined();
  });
});
