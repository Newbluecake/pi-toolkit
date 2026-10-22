/**
 * fabric phase-2 X2 (phase2-plan §11.2「X2」行 / §8.1): the `xs_member` SLOT lifecycle anchors —
 * slot order (right after `session`), hello_ack replay on reconnect, cap gating (no `xs.v1` ⇒ the
 * frame is never written), and the xs-off byte-identity of the slot surface (no slot at all).
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
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { XsMemberLimitsWire } from "../../../src/web-hub/protocol/xs.js";
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

const LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 30_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
};

function makePort(
  over: Partial<{ sessionId: string; epoch: number; joined: boolean; limits: XsMemberLimitsWire }> = {},
): {
  port: XsAgentPort;
  state: { sessionId: string; epoch: number; joined: boolean };
} {
  const state = {
    sessionId: over.sessionId ?? "sess-aaaaaaaaaaaa",
    epoch: over.epoch ?? 3,
    joined: over.joined ?? true,
  };
  const stack: XsStackPort = {
    sessionId: () => state.sessionId,
    member: () => ({ epoch: state.epoch, joined: state.joined, receive: "wake" }),
    deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
    status: () => ({ joined: state.joined, receive: "wake", blocked: 0 }),
  };
  return {
    port: { stack: () => stack, memberLimits: () => ({ ...LIMITS, ...over.limits }), hubSendsPerMin: () => 60 },
    state,
  };
}

const BINDING: BindingPort = {
  onStateChange: () => undefined,
  onSnapshotReq: () => undefined,
  onBranchReq: () => undefined,
};

const SESSION = {
  sessionId: "sess-aaaaaaaaaaaa",
  sessionFile: "/tmp/s1.jsonl",
  cwd: "/tmp/wa",
  reason: "startup",
  leafId: "e1",
  mode: "tui",
} as const;

const XS_CAPS = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP];
const NO_XS_CAPS = [...P2_HUB_CAPS, VERSION_HUB_CAP];

describe("xs_member slot (§8.1)", () => {
  it("lands right after the session frame on the live path, before status", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, XS_CAPS));
    const { port } = makePort();
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    conn.setSlot("status", { t: "status", leafId: null, busy: false, pending: false });
    const types = s.types();
    const iSession = types.indexOf("session");
    const iXs = types.indexOf("xs_member");
    const iStatus = types.indexOf("status");
    expect(iSession).toBeGreaterThanOrEqual(0);
    expect(iXs).toBeGreaterThan(iSession); // §8.1: SLOT_ORDER places xs directly after session
    expect(iXs).toBeLessThan(iStatus);
    const member = s.frames().find((f) => f.t === "xs_member");
    expect(member).toEqual({
      t: "xs_member",
      sessionId: "sess-aaaaaaaaaaaa",
      epoch: 3,
      joined: true,
      receive: "wake",
      limits: LIMITS,
    });
  });

  it("replays (fresh) on every hello_ack — reconnect replays the stored slot", async () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s1 = n.sockets[0]!;
    s1.emit("connect");
    s1.hub(ackFrame("k", 4242, XS_CAPS));
    const { port, state } = makePort();
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    expect(s1.types().filter((t) => t === "xs_member")).toHaveLength(1);
    // membership changes mid-session (join bump), then the link dies and reconnects
    state.epoch = 4;
    state.joined = true;
    bridge.publishMember(); // updated stored slot (also written live)
    s1.fail("ECONNRESET");
    for (let i = 0; i < 40 && n.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const s2 = n.sockets[1]!;
    s2.emit("connect");
    s2.hub(ackFrame("k", 4242, XS_CAPS));
    const replayed = s2.frames().filter((f) => f.t === "xs_member");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ epoch: 4, joined: true, sessionId: "sess-aaaaaaaaaaaa" });
    // and the session slot replayed before it
    const types = s2.types();
    expect(types.indexOf("session")).toBeLessThan(types.indexOf("xs_member"));
  });

  it("hub without xs.v1 ⇒ the member slot is cap-gated: stored but never written", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, NO_XS_CAPS)); // live, but no xs.v1
    const { port } = makePort();
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    expect(s.types()).not.toContain("xs_member"); // §8.6: old hub — send ⇒ E_XS_OFF{hub} later
  });

  it("xs off (no bridge) ⇒ no xs slot anywhere, even on a cap-carrying hub", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, XS_CAPS));
    conn.attach(BINDING, SESSION as never);
    expect(s.types()).not.toContain("xs_member");
    expect(s.types()[0]).toBe("hello");
  });

  it("publishMember with no connection object or no stack is a safe no-op", () => {
    const { port } = makePort();
    const b1 = createXsAgentBridge({ port, conn: () => undefined });
    expect(() => b1.publishMember()).not.toThrow();
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const b2 = createXsAgentBridge({
      port: { stack: () => undefined, memberLimits: () => ({ ...LIMITS }), hubSendsPerMin: () => 60 },
      conn: () => conn,
    });
    expect(() => b2.publishMember()).not.toThrow();
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, XS_CAPS));
    expect(s.types()).not.toContain("xs_member");
  });

  it("out-of-bounds member limits are clamped before the wire (X1-report note 2)", () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, XS_CAPS));
    const { port } = makePort({
      limits: {
        sendsOutPerMin: 9_999,
        wakesOutPerHour: -3,
        pairMinIntervalMs: 1,
        inFlightPerSession: 99,
        listPerMin: 0,
        sendsOutPerHour: 60,
        pairWakesPerHour: 2,
      },
    });
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    bridge.publishMember();
    const member = s.frames().find((f) => f.t === "xs_member") as { limits: XsMemberLimitsWire };
    expect(member.limits).toEqual({
      sendsOutPerMin: 60,
      sendsOutPerHour: 60,
      wakesOutPerHour: 0,
      pairMinIntervalMs: 5_000,
      pairWakesPerHour: 2,
      inFlightPerSession: 16,
      listPerMin: 1,
    });
  });

  it("caps()/hubCrossSessionConfig(): agent caps + clamped hub key", () => {
    const { port } = makePort();
    const bridge = createXsAgentBridge({ port, conn: () => undefined });
    expect(bridge.caps()).toEqual(["xs.v1"]);
    expect(bridge.hubCrossSessionConfig()).toEqual({ limits: { hubSendsPerMin: 60 } });
    const wild = makePort();
    const wildPort: XsAgentPort = {
      stack: wild.port.stack,
      memberLimits: () => ({ ...LIMITS }),
      hubSendsPerMin: () => 99_999,
    };
    expect(createXsAgentBridge({ port: wildPort, conn: () => undefined }).hubCrossSessionConfig()).toEqual({
      limits: { hubSendsPerMin: 600 },
    });
  });
});

describe("slot flush downgrade (reply-plan §5.2 / r2 #9)", () => {
  const stackWith = (receive: "replies" | "wake") => {
    const stack: XsStackPort = {
      sessionId: () => "sess-aaaaaaaaaaaa",
      member: () => ({ epoch: 3, joined: true, receive }),
      deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
      status: () => ({ joined: true, receive, blocked: 0 }),
    };
    return stack;
  };
  const mk = (receive: "replies" | "wake", replyEnabled: boolean | undefined, caps: string[]) => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, caps));
    const stack = stackWith(receive);
    const port: XsAgentPort = {
      stack: () => stack,
      memberLimits: () => ({ ...LIMITS }),
      hubSendsPerMin: () => 60,
      ...(replyEnabled !== undefined ? { replyEnabled: () => replyEnabled } : {}),
    };
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    conn.setSlot(
      "status",
      { t: "status", leafId: null, busy: false, pending: false, xs: stack.status() },
      bridge.slotFlush,
    );
    return { s };
  };
  const recv = (s: FakeSocket) => ({
    member: (s.frames().find((f) => f.t === "xs_member") as { receive: string }).receive,
    status: (s.frames().find((f) => f.t === "status") as unknown as { xs: { receive: string } }).xs.receive,
  });

  const withCap = [...XS_CAPS, XS_REPLY_HUB_CAP];
  it.each([
    ["reply on + hub cap", true, withCap, "replies"],
    ["old hub", true, XS_CAPS, "off"],
    ["local reply off", false, withCap, "off"],
    ["replyEnabled unset", undefined, withCap, "off"],
  ] as const)("truth table: %s ⇒ %s", (_n, enabled, caps, want) => {
    expect(recv(mk("replies", enabled, [...caps]).s)).toEqual({ member: want, status: want });
  });

  it("non-replies receive is passed through byte-identically (same frame object semantics)", () => {
    const { s } = mk("wake", undefined, XS_CAPS);
    expect(recv(s)).toEqual({ member: "wake", status: "wake" });
  });
});
