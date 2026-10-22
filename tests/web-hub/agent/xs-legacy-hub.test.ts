/**
 * channel-plan §3.2 / §9.1 CH2 / §9.4 旧 hub 行为: slotFlush grid for `xs_member` / status against a
 * hub with and without `xs.channel.v1`, incl. new → old → new replay, caps, HubConfig key, and the
 * channel-op guard on `xs_req`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, type AcquireOptions, type BindingPort } from "../../../src/web-hub/agent/connection.js";
import { createXsAgentBridge, type XsAgentPort, type XsStackPort } from "../../../src/web-hub/agent/xs.js";
import { XS_CHANNEL_HUB_CAP, XS_HUB_CAP, type XsMemberLimitsWire } from "../../../src/web-hub/protocol/xs.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { XsChannelView } from "../../../src/fabric/xs/types-channel.js";
import { effectiveChannels, linkChannels, linkJoined } from "../../../src/fabric/xs/channel.js";
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

const LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 30_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
  broadcastsOutPerHour: 10,
  broadcastMinIntervalMs: 60_000,
  broadcastWakesOutPerHour: 2,
};
const BASE_LIMITS: XsMemberLimitsWire = {
  sendsOutPerMin: 10,
  sendsOutPerHour: 60,
  wakesOutPerHour: 6,
  pairMinIntervalMs: 30_000,
  pairWakesPerHour: 2,
  inFlightPerSession: 4,
  listPerMin: 6,
};

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
const OLD_CAPS = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP];
const NEW_CAPS = [...OLD_CAPS, XS_CHANNEL_HUB_CAP];

function setup(pref: string[], enabled = true) {
  const view: XsChannelView = {
    pref: () => pref,
    effective: () => effectiveChannels(pref, enabled),
    link: (hubCap) => linkChannels(pref, enabled, hubCap),
    linkJoined: (hubCap) => linkJoined(pref, enabled, hubCap),
  };
  const eff = effectiveChannels(pref, enabled);
  const stack: XsStackPort = {
    sessionId: () => SESSION.sessionId,
    member: () => ({ epoch: 3, joined: eff.includes("default"), receive: "wake" }),
    deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
    status: () => ({
      joined: eff.length > 0,
      receive: "wake",
      blocked: 0,
      ...(eff.length > 0 && !(eff.length === 1 && eff[0] === "default") ? { channels: eff } : {}),
    }),
    channelView: () => view,
  };
  const port: XsAgentPort = {
    stack: () => stack,
    memberLimits: () => ({ ...LIMITS }),
    hubSendsPerMin: () => 60,
    channelsEnabled: () => enabled,
    channelsHubConfig: () => ({ maxRecipients: 16, wakeMaxRecipients: 4 }),
  };
  const n = fakeNet();
  const conn = acquireConnection(opts({ netConnect: n.netConnect }));
  const bridge = createXsAgentBridge({ port, conn: () => conn });
  return { n, conn, bridge };
}

const memberOf = (s: { frames(): any[] }) => s.frames().filter((f) => f.t === "xs_member");

describe("slotFlush grid (§3.2)", () => {
  it("default-only: new hub and old hub both get the pre-channel shape (no channels, no broadcast keys)", () => {
    for (const caps of [NEW_CAPS, OLD_CAPS]) {
      resetGlobals();
      const { n, conn, bridge } = setup(["default"]);
      const s = n.sockets[0]!;
      s.emit("connect");
      s.hub(ackFrame("k", 4242, caps));
      conn.attach(BINDING, SESSION as never);
      bridge.publishMember();
      expect(memberOf(s)[0]).toEqual({
        t: "xs_member",
        sessionId: SESSION.sessionId,
        epoch: 3,
        joined: true,
        receive: "wake",
        limits: BASE_LIMITS,
      });
    }
  });

  it("[a] on a new hub: channels + broadcast keys written, joined true", () => {
    const { n, conn, bridge } = setup(["a"]);
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, NEW_CAPS));
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    expect(memberOf(s)[0]).toMatchObject({ joined: true, channels: ["a"], limits: LIMITS });
  });

  it("[a] on an OLD hub: not joined, no channels, no broadcast keys (hub treats it as not a member)", () => {
    const { n, conn, bridge } = setup(["a"]);
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, OLD_CAPS));
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    const m = memberOf(s)[0];
    expect(m.joined).toBe(false);
    expect("channels" in m).toBe(false);
    expect(m.limits).toEqual(BASE_LIMITS);
  });

  it("[default,a] on an OLD hub: joined as default, #a does not ride", () => {
    const { n, conn, bridge } = setup(["default", "a"]);
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, OLD_CAPS));
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    const m = memberOf(s)[0];
    expect(m.joined).toBe(true);
    expect("channels" in m).toBe(false);
    expect(m.limits).toEqual(BASE_LIMITS);
  });

  it("new → old → new replay: each hello_ack replays what THAT hub can decode", async () => {
    const { n, conn, bridge } = setup(["default", "a"]);
    const hubs = [NEW_CAPS, OLD_CAPS, NEW_CAPS];
    const seen: any[] = [];
    for (let i = 0; i < hubs.length; i++) {
      if (i === 0) conn.attach(BINDING, SESSION as never);
      const s = n.sockets[i]!;
      s.emit("connect");
      s.hub(ackFrame("k", 4242, hubs[i]!));
      if (i === 0) bridge.publishMember();
      seen.push(memberOf(s));
      s.fail("ECONNRESET");
      for (let j = 0; j < 40 && n.sockets.length < i + 2; j++) await vi.advanceTimersByTimeAsync(100);
    }
    expect(seen.map((x) => x.length)).toEqual([1, 1, 1]);
    expect(seen[0][0]).toMatchObject({ channels: ["default", "a"], joined: true });
    expect("channels" in seen[1][0]).toBe(false);
    expect(seen[1][0].limits).toEqual(BASE_LIMITS);
    expect(seen[2][0]).toMatchObject({ channels: ["default", "a"], limits: LIMITS });
  });

  it("channels disabled with a saved [a]: suspended — wire is the legacy shape, no cap", () => {
    const { n, conn, bridge } = setup(["a"], false);
    expect(bridge.caps()).not.toContain("xs.channel.v1");
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, NEW_CAPS));
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    const m = memberOf(s)[0];
    expect("channels" in m).toBe(false);
    expect(m.limits).toEqual(BASE_LIMITS);
    expect(m.joined).toBe(false);
  });

  it("status slot: channels dropped and joined ← linkJoined on an old hub; kept on a new hub", () => {
    for (const [caps, joined, hasCh] of [
      [NEW_CAPS, true, true],
      [OLD_CAPS, false, false],
    ] as const) {
      resetGlobals();
      const { n, conn, bridge } = setup(["a"]);
      const s = n.sockets[0]!;
      s.emit("connect");
      s.hub(ackFrame("k", 4242, caps));
      conn.attach(BINDING, SESSION as never);
      conn.setSlot(
        "status",
        { t: "status", leafId: null, busy: false, pending: false, xs: bridge.statusProjection() } as never,
        bridge.slotFlush,
      );
      const st = s.frames().find((f) => f.t === "status") as any;
      expect(st.xs.joined).toBe(joined);
      expect("channels" in st.xs).toBe(hasCh);
    }
  });
});

describe("caps / HubConfig / req guard", () => {
  it("advertises xs.channel.v1 last iff channels enabled; HubConfig.channels only then", () => {
    const on = setup(["default"]).bridge;
    expect(on.caps()).toEqual(["xs.v1", "xs.channel.v1"]);
    expect(on.hubCrossSessionConfig()).toEqual({
      limits: { hubSendsPerMin: 60 },
      channels: { maxRecipients: 16, wakeMaxRecipients: 4 },
    });
    const off = setup(["default"], false).bridge;
    expect(off.caps()).toEqual(["xs.v1"]);
    expect(off.hubCrossSessionConfig()).toEqual({ limits: { hubSendsPerMin: 60 } });
  });

  it("hubConfig channel params are clamped (wake recipients ≤ 4)", () => {
    const { bridge } = setup(["default"]);
    const b2 = createXsAgentBridge({
      port: {
        stack: () => undefined,
        memberLimits: () => ({ ...BASE_LIMITS }),
        hubSendsPerMin: () => 60,
        channelsEnabled: () => true,
        channelsHubConfig: () => ({ maxRecipients: 999, wakeMaxRecipients: 99 }),
      },
      conn: () => undefined,
    });
    expect(b2.hubCrossSessionConfig().channels).toEqual({ maxRecipients: 32, wakeMaxRecipients: 4 });
    expect(bridge).toBeDefined();
  });

  it("old hub: a channel-only xs_req is never written (reply `off`), a plain list still rides", async () => {
    const { n, conn, bridge } = setup(["default"]);
    const s = n.sockets[0]!;
    s.emit("connect");
    s.hub(ackFrame("k", 4242, OLD_CAPS));
    conn.attach(BINDING, SESSION as never);
    const port = bridge.hubPort();
    expect(port.channelCapable?.()).toBe(false);
    const before = s.types().filter((t) => t === "xs_req").length;
    const reply = await port.list({ origin: { sessionId: SESSION.sessionId, epoch: 3 }, channel: "a" } as never);
    expect(reply).toEqual({ kind: "off" });
    expect(s.types().filter((t) => t === "xs_req").length).toBe(before);
  });
});
