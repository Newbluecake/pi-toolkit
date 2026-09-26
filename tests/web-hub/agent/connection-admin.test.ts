import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireConnection, type AcquireOptions, type HubConnection } from "../../../src/web-hub/agent/connection.js";
import type { HubCtlFrame, LanReqFrame } from "../../../src/web-hub/protocol/messages.js";
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

/** Drive a fake-socket connection to `live`, optionally with hub `caps`. */
function liveFake(caps?: string[]): { conn: HubConnection; sock: FakeSocket } {
  const n = fakeNet();
  const conn = acquireConnection(opts({ netConnect: n.netConnect }));
  const s = n.sockets[0]!;
  s.emit("connect");
  s.hub(ackFrame("a1-abcdef", 4242, caps));
  return { conn, sock: s };
}

const INFO_REQ: LanReqFrame = { t: "lan_req", rid: "r1", op: "info" };
const CTL_REQ: HubCtlFrame = { t: "hub_ctl", rid: "r2", op: "shutdown", reason: "restart" };

describe("connection admin request()/caps (plan §8.1; LE)", () => {
  it("no cap on the live link ⇒ rejects immediately and sends nothing", async () => {
    const { conn, sock } = liveFake([]); // hub live, no caps at all
    const before = sock.written.length;
    const p = conn.request(INFO_REQ, "lan.v1");
    await expect(p).rejects.toThrow(/E_NO_CAP/);
    expect(sock.written.length).toBe(before); // nothing new written
  });

  it("cap missing among others ⇒ still rejects without sending", async () => {
    const { conn, sock } = liveFake(["ctl.v1"]); // no lan.v1
    const before = sock.written.length;
    await expect(conn.request(INFO_REQ, "lan.v1")).rejects.toThrow(/E_NO_CAP/);
    expect(sock.written.length).toBe(before);
  });

  it("not live (still connecting) ⇒ rejects without sending", async () => {
    const n = fakeNet();
    const conn = acquireConnection(opts({ netConnect: n.netConnect }));
    const before = n.sockets[0]!.written.length;
    await expect(conn.request(INFO_REQ, "ctl.v1")).rejects.toThrow(/E_NO_CAP/);
    expect(n.sockets[0]!.written.length).toBe(before);
  });

  it("cap present ⇒ sends the frame and resolves on the matching lan_res by rid", async () => {
    const { conn, sock } = liveFake(["lan.v1"]);
    const p = conn.request(INFO_REQ, "lan.v1");
    const sent = sock.frames().find((f) => f.t === "lan_req");
    expect(sent).toBeDefined();
    expect(sent!.rid).toBe("r1");
    sock.hub({ t: "lan_res", rid: "r1", ok: true, info: { username: "alice", lan: { state: "starting" } } });
    const res = await p;
    expect(res).toMatchObject({ t: "lan_res", ok: true });
  });

  it("hub_ctl / hub_ctl_ack round-trips through the same request() correlation", async () => {
    const { conn, sock } = liveFake(["ctl.v1"]);
    const p = conn.request(CTL_REQ, "ctl.v1");
    sock.hub({ t: "hub_ctl_ack", rid: "r2" });
    const res = await p;
    expect(res).toEqual({ t: "hub_ctl_ack", rid: "r2" });
  });

  it("mismatched rid never resolves the pending request; matching rid still does", async () => {
    const { conn, sock } = liveFake(["lan.v1"]);
    const p = conn.request(INFO_REQ, "lan.v1");
    sock.hub({ t: "lan_res", rid: "other-rid", ok: true });
    sock.hub({ t: "lan_res", rid: "r1", ok: true });
    const res = await p;
    expect(res).toMatchObject({ rid: "r1" });
  });

  it("times out after 3s (unref'd) when the hub never answers", async () => {
    const { conn } = liveFake(["lan.v1"]);
    const p = conn.request(INFO_REQ, "lan.v1");
    let rejected: unknown;
    p.catch((e) => (rejected = e));
    vi.advanceTimersByTime(2_999);
    await Promise.resolve();
    expect(rejected).toBeUndefined();
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(rejected).toBeInstanceOf(Error);
    expect(String(rejected)).toMatch(/E_TIMEOUT/);
  });

  it("connection close(): every pending request rejects", async () => {
    const { conn } = liveFake(["lan.v1", "ctl.v1"]);
    const p1 = conn.request(INFO_REQ, "lan.v1");
    const p2 = conn.request(CTL_REQ, "ctl.v1");
    conn.close("test-close");
    await expect(p1).rejects.toThrow(/E_CLOSED/);
    await expect(p2).rejects.toThrow(/E_CLOSED/);
  });

  it("socket error/teardown (no explicit close()): every pending request rejects and caps reset", async () => {
    const { conn, sock } = liveFake(["lan.v1"]);
    const p = conn.request(INFO_REQ, "lan.v1");
    expect(conn.caps).toContain("lan.v1");
    sock.fail("ECONNRESET");
    await expect(p).rejects.toThrow(/E_CONN_LOST/);
    expect(conn.caps).toEqual([]);
  });

  it("caps reflect the live link's hello_ack.caps; empty when the hub omits it", async () => {
    const { conn } = liveFake();
    expect(conn.caps).toEqual([]);
  });

  it("caps reflect exactly what hello_ack carried", async () => {
    const { conn } = liveFake(["ctl.v1", "lan.v1"]);
    expect(conn.caps).toEqual(["ctl.v1", "lan.v1"]);
  });
});
