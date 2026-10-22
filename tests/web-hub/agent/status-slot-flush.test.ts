/**
 * reply-plan §5.2 / r2 #9 (RX3): the `status` and `xs_member` slots keep the RAW frame and are
 * transformed on every write — replay "new hub → old hub → new hub" with NO fresh status
 * sample in between: the old hub gets `off`, the new hub gets `replies`, and no hub ever
 * loses a status / xs_member frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, type AcquireOptions, type BindingPort } from "../../../src/web-hub/agent/connection.js";
import { createXsAgentBridge, type XsAgentPort, type XsStackPort } from "../../../src/web-hub/agent/xs.js";
import { XS_HUB_CAP, XS_REPLY_HUB_CAP } from "../../../src/web-hub/protocol/xs.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
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

const opts = (over: Partial<AcquireOptions>): AcquireOptions => ({
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
});

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
const OLD = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP];
const NEW = [...OLD, XS_REPLY_HUB_CAP];

const rx = (s: FakeSocket, t: "xs_member" | "status") => {
  const fs = s.frames().filter((f) => f.t === t) as unknown as Array<{ receive?: string; xs?: { receive: string } }>;
  return fs.map((f) => (t === "xs_member" ? f.receive : f.xs?.receive));
};

describe("slot replay across hub generations", () => {
  it("new hub → old hub → new hub, no new sample in between", async () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const stack: XsStackPort = {
      sessionId: () => "sess-aaaaaaaaaaaa",
      member: () => ({ epoch: 1, joined: true, receive: "replies" }),
      deliver: () => ({ effect: "none", reason: "rejected", woke: false }),
      status: () => ({ joined: true, receive: "replies", blocked: 0 }),
    };
    const port: XsAgentPort = {
      stack: () => stack,
      memberLimits: () => ({
        sendsOutPerMin: 10,
        sendsOutPerHour: 60,
        wakesOutPerHour: 6,
        pairMinIntervalMs: 30_000,
        pairWakesPerHour: 2,
        inFlightPerSession: 4,
        listPerMin: 6,
      }),
      hubSendsPerMin: () => 60,
      replyEnabled: () => true,
    };
    const bridge = createXsAgentBridge({ port, conn: () => conn });
    const hubs = [NEW, OLD, NEW];
    const socks: FakeSocket[] = [];
    const up = async (i: number) => {
      if (i > 0) {
        socks[i - 1]!.fail("ECONNRESET");
        for (let k = 0; k < 60 && n.sockets.length < i + 1; k++) await vi.advanceTimersByTimeAsync(100);
      }
      const s = n.sockets[i]!;
      socks.push(s);
      s.emit("connect");
      s.hub(ackFrame("k", 4242, hubs[i]));
    };
    await up(0);
    conn.attach(BINDING, SESSION as never);
    bridge.publishMember();
    // one status sample ONLY here (raw receive:"replies"); never re-sampled afterwards.
    conn.setSlot(
      "status",
      { t: "status", leafId: null, busy: false, pending: false, xs: stack.status() },
      bridge.slotFlush,
    );
    expect(rx(socks[0]!, "xs_member")[0]).toBe("replies");
    expect(rx(socks[0]!, "status")[0]).toBe("replies");

    await up(1);
    // onHubCaps isn't wired in this unit harness, so only the hello_ack replay speaks here
    expect(rx(socks[1]!, "xs_member")).toEqual(["off"]);
    expect(rx(socks[1]!, "status")).toEqual(["off"]);

    await up(2);
    expect(rx(socks[2]!, "xs_member")).toEqual(["replies"]);
    expect(rx(socks[2]!, "status")).toEqual(["replies"]);
  });
});
