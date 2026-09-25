import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as net from "node:net";
import {
  acquireConnection,
  currentConnection,
  MODULE_INSTANCE,
  processAgentId,
  releaseConnection,
  type AcquireOptions,
  type BindingPort,
  type HubConnection,
} from "../../../src/web-hub/agent/connection.js";
import { LIMITS, TIMING, type AgentFrame, type SessionInfo } from "../../../src/web-hub/protocol/messages.js";
import { MAX_FRAME_BYTES } from "../../../src/web-hub/protocol/ndjson.js";
import {
  ackFrame,
  CONN_KEY,
  fakeNet,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
  type FakeSocket,
} from "./helpers.js";

const SESSION: SessionInfo = {
  sessionId: "s1",
  sessionFile: "/tmp/s1.jsonl",
  cwd: "/tmp/wa",
  reason: "startup",
  leafId: "e1",
  mode: "tui",
};

function binding(): BindingPort & { states: string[]; snaps: string[] } {
  const states: string[] = [];
  const snaps: string[] = [];
  return {
    states,
    snaps,
    onSnapshotReq: (rid) => snaps.push(rid),
    onBranchReq: () => undefined,
    onStateChange: (v) => states.push(v.state),
  };
}

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir();
  resetGlobals();
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

/** Fake-socket connection driven to `live`. */
function liveFake(over: Partial<AcquireOptions> = {}): {
  conn: HubConnection;
  net: ReturnType<typeof fakeNet>;
  sock: () => FakeSocket;
} {
  const n = fakeNet();
  const conn = acquireConnection(opts({ netConnect: n.netConnect, ...over }));
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame());
  return { conn, net: n, sock: () => n.sockets[n.sockets.length - 1]! };
}

describe("connection state machine (fake socket + fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("connecting → handshaking(hello) → live; hello carries agentId/epoch/caps", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    expect(conn.status().state).toBe("connecting");
    expect(n.calls()).toBe(1);
    const s = n.sockets[0]!;
    expect(s.unrefCalls).toBeGreaterThan(0);
    s.emit("connect");
    const hello = s.frames()[0]!;
    expect(hello.t).toBe("hello");
    expect(hello.agentId).toEqual(processAgentId());
    expect(hello.epoch).toBe(MODULE_INSTANCE);
    expect(hello.caps).toEqual(["ev.v1", "fleet.v1", "snapshot.v1", "branch.v1"]);
    expect(conn.status().state).toBe("connecting");
    s.hub(ackFrame("a1-xyz", 7878));
    expect(conn.status()).toMatchObject({ state: "live", agentKey: "a1-xyz", httpPort: 7878, hubVersion: "9.9.9" });
    expect(conn.implVersion).toBe(`1.0.0@abc#${MODULE_INSTANCE}`);
  });

  it("connect deadline 1s, hello_ack deadline 2s ⇒ disconnect + backoff; ev during handshake never queued", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    vi.advanceTimersByTime(TIMING.connectMs);
    expect(n.sockets[0]!.destroyed).toBe(true);
    expect(conn.status().state).toBe("backoff");
    vi.advanceTimersByTime(1_000); // 500ms ± 0 backoff
    expect(n.calls()).toBe(2);
    const s = n.sockets[1]!;
    s.emit("connect");
    const before = s.written.length;
    conn.send({ t: "ev", seq: conn.nextSeq(), e: { type: "agent_start" } });
    expect(s.written.length).toBe(before); // not queued, not written
    vi.advanceTimersByTime(TIMING.helloAckMs);
    expect(s.destroyed).toBe(true);
    expect(conn.status().state).toBe("backoff");
    expect(conn.status().lastError).toContain("hello_ack timeout");
  });

  it("backoff sequence 0.5s → 30s cap (jitter-free at random=0.5)", () => {
    const n = fakeNet();
    acquireConnection(opts({ netConnect: n.netConnect }));
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      n.sockets[n.sockets.length - 1]!.fail("ENOENT");
      const start = n.calls();
      let waited = 0;
      while (n.calls() === start && waited < 60_000) {
        vi.advanceTimersByTime(50);
        waited += 50;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("backoff jitter stays within ±20%", () => {
    for (const r of [0, 0.999]) {
      resetGlobals();
      const n = fakeNet();
      acquireConnection(opts({ netConnect: n.netConnect, random: () => r }));
      n.sockets[0]!.fail("ECONNREFUSED");
      let waited = 0;
      while (n.calls() === 1) {
        vi.advanceTimersByTime(10);
        waited += 10;
      }
      expect(waited).toBeGreaterThanOrEqual(400);
      expect(waited).toBeLessThanOrEqual(600);
    }
  });

  it("30s without any hub frame ⇒ disconnect; a hub ping refreshes the lease and gets a pong", () => {
    const { conn, sock } = liveFake();
    const s = sock();
    vi.advanceTimersByTime(TIMING.silenceMs - 1);
    expect(conn.status().state).toBe("live");
    expect(s.types()).toContain("ping"); // agent pings every 10s
    s.hub({ t: "ping", ts: 1 });
    expect(s.frames().some((f) => f.t === "pong" && f.ts === 1)).toBe(true);
    vi.advanceTimersByTime(TIMING.silenceMs - 1);
    expect(conn.status().state).toBe("live");
    vi.advanceTimersByTime(2);
    expect(conn.status().state).toBe("backoff");
    expect(s.destroyed).toBe(true);
  });

  it("reconnect replays hello + slots (session,status,fleet) + gap{fromSeq}", () => {
    const { conn, net: n, sock } = liveFake();
    conn.attach(binding(), SESSION);
    conn.setSlot("status", { t: "status", leafId: "e1", busy: false, pending: false });
    conn.setSlot("fleet", { t: "fleet", runs: [] });
    const s1 = sock();
    const seq1 = conn.nextSeq();
    conn.send({ t: "ev", seq: seq1, e: { type: "agent_start" } });
    s1.fail("EPIPE");
    expect(conn.status().state).toBe("backoff");
    expect(conn.bufferedBytes).toBe(0);
    const seq2 = conn.nextSeq();
    conn.send({ t: "ev", seq: seq2, e: { type: "turn_start" } }); // dropped while backoff
    conn.setSlot("status", { t: "status", leafId: "e2", busy: true, pending: false }); // overwrite
    expect(seq2).toBe(seq1 + 1); // seq never rewinds
    vi.advanceTimersByTime(600);
    expect(n.calls()).toBe(2);
    const s2 = sock();
    s2.emit("connect");
    s2.hub(ackFrame());
    expect(s2.types()).toEqual(["hello", "session", "status", "fleet", "gap"]);
    const frames = s2.frames();
    expect(frames[2]).toMatchObject({ leafId: "e2", busy: true });
    expect(frames[4]).toEqual({ t: "gap", fromSeq: seq1 }); // conservative: from first ev on the dead link
  });

  it("hello_reject E_PROTO ⇒ state proto, retry only after 10 min", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub({ t: "hello_reject", code: "E_PROTO", message: "major mismatch", retryAfterMs: 1_000 });
    expect(conn.status().state).toBe("proto");
    vi.advanceTimersByTime(9 * 60_000);
    expect(n.calls()).toBe(1);
    vi.advanceTimersByTime(60_001);
    expect(n.calls()).toBe(2);
  });

  it("detach grace: 10s without attach ⇒ bye{detach-timeout} + release; attach inside the window cancels it", () => {
    const { conn, sock } = liveFake();
    const b = binding();
    conn.attach(b, SESSION);
    conn.detach("new");
    expect(sock().frames().at(-1)).toEqual({ t: "session_detached", reason: "new" });
    vi.advanceTimersByTime(TIMING.detachGraceMs - 1);
    conn.attach(b, { ...SESSION, sessionId: "s2" });
    vi.advanceTimersByTime(5_000); // well past the original grace deadline, still inside the 30s lease
    expect(conn.status().state).toBe("live");
    expect(sock().types()).not.toContain("bye");
    conn.detach("resume");
    vi.advanceTimersByTime(TIMING.detachGraceMs);
    expect(sock().frames().at(-1)).toEqual({ t: "bye", reason: "detach-timeout" });
    expect(sock().ended).toBe(true);
    expect(conn.status().state).toBe("off");
    expect(currentConnection()).toBeUndefined();
  });

  it("detach(quit) ⇒ bye{quit} + end + release, synchronously", () => {
    const { conn, sock } = liveFake();
    conn.detach("quit");
    expect(sock().frames().at(-1)).toEqual({ t: "bye", reason: "quit" });
    expect(sock().ended).toBe(true);
    expect(currentConnection()).toBeUndefined();
  });

  it("identity-checked release: an old instance never deletes its successor", () => {
    const n = fakeNet();
    const a = acquireConnection(opts({ netConnect: n.netConnect, buildId: "A" }));
    const b = acquireConnection(opts({ netConnect: n.netConnect, buildId: "B" }));
    expect(a).not.toBe(b);
    expect(a.status().state).toBe("off"); // handed over
    releaseConnection(a);
    expect((globalThis as Record<symbol, unknown>)[CONN_KEY]).toBe(b);
    releaseConnection(b);
    expect((globalThis as Record<symbol, unknown>)[CONN_KEY]).toBeUndefined();
  });

  it("live soft cap: droppable frames above 1 MiB are dropped (gap after drain), control frames still written", () => {
    const { conn, sock } = liveFake();
    const s = sock();
    s.writableLength = LIMITS.writeQueueBytes + 1;
    const n0 = s.written.length;
    const seq = conn.nextSeq();
    conn.send({ t: "ev", seq, e: { type: "message_update" } }, { droppable: true });
    expect(s.written.length).toBe(n0);
    conn.send({ t: "status", leafId: "x", busy: false, pending: false });
    expect(s.written.length).toBe(n0 + 1);
    s.writableLength = 0;
    s.emit("drain");
    expect(s.frames().at(-1)).toEqual({ t: "gap", fromSeq: seq });
  });

  it("live hard cap: > 4 MiB ⇒ destroy + clear + backoff", () => {
    const { conn, sock } = liveFake();
    const s = sock();
    s.writableLength = LIMITS.hardQueueBytes + 1;
    conn.send({ t: "status", leafId: "x", busy: false, pending: false });
    expect(s.destroyed).toBe(true);
    expect(conn.status().state).toBe("backoff");
    expect(conn.bufferedBytes).toBe(0);
  });

  it("auto-start: ENOENT spawns once per 30s, then fast 250ms→4s reconnects inside the 8s window", () => {
    let t = 1_000_000;
    const spawn = vi.fn();
    const n = fakeNet();
    acquireConnection(
      opts({
        netConnect: n.netConnect,
        spawn,
        now: () => t,
        settings: { ...SETTINGS, autoStart: true },
        launcher: { execPath: "/n", jitiCli: "/j", argv1: "/p" },
      }),
    );
    n.sockets[0]!.fail("ENOENT");
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(n.calls()).toBe(2);
    t += 1_000;
    n.sockets[1]!.fail("ENOENT");
    expect(spawn).toHaveBeenCalledTimes(1); // throttled
    vi.advanceTimersByTime(499);
    expect(n.calls()).toBe(2);
    vi.advanceTimersByTime(1);
    expect(n.calls()).toBe(3);
    t += TIMING.spawnThrottleMs;
    n.sockets[2]!.fail("ECONNREFUSED");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("headless (PI_WEBHUB_HEADLESS=1) and unresolved launcher never spawn; the latter reports state loader", () => {
    const spawn = vi.fn();
    const n = fakeNet();
    acquireConnection(
      opts({
        netConnect: n.netConnect,
        spawn,
        headless: true,
        settings: { ...SETTINGS, autoStart: true },
        launcher: { execPath: "/n", jitiCli: "/j", argv1: "/p" },
      }),
    );
    n.sockets[0]!.fail("ENOENT");
    resetGlobals();
    const n2 = fakeNet();
    const c2 = acquireConnection(
      opts({ netConnect: n2.netConnect, spawn, settings: { ...SETTINGS, autoStart: true }, launcher: { error: "x" } }),
    );
    n2.sockets[0]!.fail("ENOENT");
    expect(spawn).not.toHaveBeenCalled();
    expect(c2.status().state).toBe("loader");
  });
});

describe("connection over a real unix socket (fake hub)", () => {
  let hub: FakeHub | undefined;
  afterEach(async () => {
    resetGlobals();
    await hub?.close();
    hub = undefined;
  });

  it("K4 path 1: same instance detach(new) → attach reuses the socket (zero extra net.connect)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const connectSpy = vi.fn(net.connect);
    const o = opts({ netConnect: connectSpy as unknown as typeof net.connect });
    const conn = acquireConnection(o);
    conn.attach(binding(), SESSION);
    await waitUntil(() => conn.status().state === "live", 3_000, "live");
    conn.detach("new");
    const again = acquireConnection(o);
    expect(again).toBe(conn);
    again.attach(binding(), { ...SESSION, sessionId: "s2", sessionFile: "/tmp/s2.jsonl", reason: "new" });
    await waitUntil(() => (hub?.all().length ?? 0) >= 4, 3_000, "frames");
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(hub.conns).toHaveLength(1);
    const types = hub.all().map((f) => f.t);
    expect(types).toEqual(["hello", "session", "session_detached", "session"]);
    expect(hub.all()[3]).toMatchObject({ sessionId: "s2", reason: "new" });
    // same-instance detach("reload") → attach also reuses
    again.detach("reload");
    expect(acquireConnection(o)).toBe(conn);
  });

  it("K4 path 2: module re-evaluation ⇒ new MODULE_INSTANCE, old says bye{handover}, same agentId, new epoch", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const o = opts();
    const oldConn = acquireConnection(o);
    await waitUntil(() => oldConn.status().state === "live", 3_000, "old live");
    vi.resetModules();
    const mod2 = await import("../../../src/web-hub/agent/connection.js");
    expect(mod2.MODULE_INSTANCE).not.toBe(MODULE_INSTANCE);
    expect(mod2.processAgentId()).toEqual(processAgentId());
    const newConn = mod2.acquireConnection(o); // same buildId
    expect(newConn).not.toBe(oldConn);
    await waitUntil(() => newConn.status().state === "live", 3_000, "new live");
    await waitUntil(() => hub!.conns[0]!.frames.some((f) => f.t === "bye"), 3_000, "bye");
    expect(hub.conns[0]!.frames.at(-1)).toEqual({ t: "bye", reason: "handover" });
    const h1 = hub.conns[0]!.frames[0] as Extract<AgentFrame, { t: "hello" }>;
    const h2 = hub.conns[1]!.frames[0] as Extract<AgentFrame, { t: "hello" }>;
    expect(h2.agentId).toEqual(h1.agentId);
    expect(h2.epoch).not.toBe(h1.epoch);
    expect(h2.epoch).toBe(mod2.MODULE_INSTANCE);
    // old instance's release must not remove the new one
    releaseConnection(oldConn);
    expect(mod2.currentConnection()).toBe(newConn);
  });

  it("backpressure is bounded: hub acks then never reads; 10k ev + status stay ≤ 4 MiB + one frame, every send is synchronous", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { pauseAfterAck: true });
    const conn = acquireConnection(opts());
    conn.attach(binding(), SESSION);
    await waitUntil(() => conn.status().state === "live", 3_000, "live");
    const payload = "x".repeat(2_000);
    let maxBuffered = 0;
    const sendMs: number[] = [];
    let sawBackoff = false;
    for (let i = 0; i < 10_000; i++) {
      const t0 = performance.now();
      conn.send({ t: "ev", seq: conn.nextSeq(), e: { type: "message_end", message: { role: "assistant", payload } } });
      if (i % 100 === 0) conn.setSlot("status", { t: "status", leafId: `e${i}`, busy: true, pending: false });
      sendMs.push(performance.now() - t0);
      if (conn.bufferedBytes > maxBuffered) maxBuffered = conn.bufferedBytes;
      if (conn.status().state === "backoff") sawBackoff = true;
    }
    expect(maxBuffered).toBeLessThanOrEqual(LIMITS.hardQueueBytes + MAX_FRAME_BYTES);
    expect(maxBuffered).toBeLessThanOrEqual(LIMITS.hardQueueBytes + 4_096); // + one ~2 KiB frame
    expect(sawBackoff).toBe(true); // destroy → backoff
    expect(conn.bufferedBytes).toBe(0);
    sendMs.sort((a, b) => a - b);
    expect(sendMs[Math.floor(sendMs.length * 0.99)]!).toBeLessThan(5); // p99 < 5ms
    expect(sendMs.at(-1)!).toBeLessThan(50); // headroom for a GC pause, still synchronous
  });

  it("hub accepts but never acks ⇒ 2s disconnect; ev meanwhile is not queued", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const conn = acquireConnection(opts());
    await waitUntil(() => (hub?.all().length ?? 0) === 1, 3_000, "hello");
    for (let i = 0; i < 1_000; i++) conn.send({ t: "ev", seq: conn.nextSeq(), e: { type: "agent_start" } });
    expect(conn.bufferedBytes).toBe(0);
    await waitUntil(() => conn.status().state === "backoff", 3_000, "backoff");
    expect(hub.all().map((f) => f.t)).toEqual(["hello"]);
  });

  it("all handles are unref'd (socket + every timer)", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const timers: NodeJS.Timeout[] = [];
    const fromAgent = (): boolean => (new Error().stack ?? "").includes("src/web-hub/agent/");
    const origTimeout = globalThis.setTimeout;
    const origInterval = globalThis.setInterval;
    const st = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = origTimeout(fn, ms);
      if (fromAgent()) timers.push(t);
      return t;
    }) as typeof setTimeout);
    const si = vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
      const t = origInterval(fn, ms);
      if (fromAgent()) timers.push(t);
      return t;
    }) as typeof setInterval);
    const sockets: net.Socket[] = [];
    const connect = ((o: net.NetConnectOpts) => {
      const s = net.connect(o);
      sockets.push(s);
      vi.spyOn(s, "unref");
      return s;
    }) as unknown as typeof net.connect;
    try {
      const conn = acquireConnection(opts({ netConnect: connect }));
      conn.attach(binding(), SESSION);
      await waitUntil(() => conn.status().state === "live", 3_000, "live");
      conn.detach("new"); // grace timer
      expect(timers.length).toBeGreaterThanOrEqual(3); // connect, hello, silence, ping, grace…
      expect(timers.every((t) => !t.hasRef())).toBe(true);
      expect(sockets[0]!.unref).toHaveBeenCalled();
      conn.close("test");
    } finally {
      st.mockRestore();
      si.mockRestore();
    }
  });

  it("snapshot_req from the hub reaches the binding while live", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath);
    const conn = acquireConnection(opts());
    const b = binding();
    conn.attach(b, SESSION);
    await waitUntil(() => conn.status().state === "live", 3_000, "live");
    hub.send(hub.conns[0]!, { t: "snapshot_req", rid: "r1" });
    await waitUntil(() => b.snaps.length === 1, 3_000, "snapshot_req");
    expect(b.snaps).toEqual(["r1"]);
    expect(b.states).toContain("live");
  });
});
