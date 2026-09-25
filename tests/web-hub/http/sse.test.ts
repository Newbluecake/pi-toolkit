import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHub, formatSseFrame, type SseClient, type SseHub } from "../../../src/web-hub/hub/sse.js";
import { openSse, type SseConn } from "./helpers.js";

let server: Server | undefined;
let hub: SseHub | undefined;
const conns: SseConn[] = [];

/** Real node:http server whose only route attaches to the hub (Last-Event-ID from header). */
async function setup(opts: Partial<Parameters<typeof createSseHub>[0]> = {}): Promise<{
  hub: SseHub;
  port: number;
  attached: SseClient[];
}> {
  const h = createSseHub({ now: () => 0, ...opts });
  hub = h;
  const attached: SseClient[] = [];
  server = createServer((req, res) => {
    const raw = req.headers["last-event-id"];
    attached.push(h.attach(req, res, typeof raw === "string" ? Number(raw) : undefined));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { hub: h, port: (server.address() as { port: number }).port, attached };
}

async function connect(port: number, lastEventId?: number): Promise<SseConn> {
  const c = await openSse(port, lastEventId === undefined ? {} : { lastEventId });
  conns.push(c);
  await c.waitFor((e) => e.event === "hello");
  return c;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const c of conns.splice(0)) c.close();
  hub?.closeAll();
  hub = undefined;
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("SseHub", () => {
  it("first frame is hello{clientId}; directed frames carry no id and get() finds the client", async () => {
    const { hub: h, port, attached } = await setup();
    const c = await connect(port);
    expect(c.events[0]).toEqual({ event: "hello", data: { clientId: attached[0]!.id } });
    expect(h.get(attached[0]!.id)).toBe(attached[0]);
    expect(h.count()).toBe(1);
    attached[0]!.send("hub", { v: 1 });
    const hubEv = await c.waitFor((e) => e.event === "hub");
    expect(hubEv.id).toBeUndefined();
  });

  it("publish assigns increasing ids; agentKey frames reach only subscribers", async () => {
    const { hub: h, port, attached } = await setup();
    const a = await connect(port);
    const b = await connect(port);
    attached[0]!.subscribed.add("a1");
    h.publish("status", { n: 1 });
    h.publish("ev", { n: 2 }, "a1");
    h.publish("append", { n: 3 }, "a2");
    h.publish("status", { n: 4 });
    await a.waitFor((e) => e.data?.n === 4);
    await b.waitFor((e) => e.data?.n === 4);
    expect(a.events.filter((e) => e.id !== undefined).map((e) => [e.id, e.data.n])).toEqual([
      [1, 1],
      [2, 2],
      [4, 4],
    ]);
    expect(b.events.filter((e) => e.id !== undefined).map((e) => e.data.n)).toEqual([1, 4]);
  });

  it("replays ring frames after Last-Event-ID; nothing when up to date", async () => {
    const { hub: h, port } = await setup();
    for (let i = 1; i <= 5; i++) h.publish("status", { n: i });
    const c = await connect(port, 2);
    await c.waitFor((e) => e.data?.n === 5);
    expect(c.events.map((e) => e.event)).toEqual(["hello", "status", "status", "status"]);
    expect(c.events.slice(1).map((e) => e.id)).toEqual([3, 4, 5]);
    const upToDate = await connect(port, 5);
    await settle();
    expect(upToDate.events.map((e) => e.event)).toEqual(["hello"]);
  });

  it("Last-Event-ID outside the ring (count eviction) or from the future ⇒ resync", async () => {
    const { hub: h, port } = await setup({ ringSize: 3 });
    for (let i = 1; i <= 6; i++) h.publish("status", { n: i }); // ring keeps ids 4..6
    const edge = await connect(port, 3); // == oldest - 1 ⇒ still covered
    await edge.waitFor((e) => e.data?.n === 6);
    expect(edge.events.slice(1).map((e) => e.id)).toEqual([4, 5, 6]);
    const old = await connect(port, 2);
    const rs = await old.waitFor((e) => e.event === "resync");
    expect(rs.id).toBeUndefined();
    expect(old.events.some((e) => e.event === "status")).toBe(false);
    const future = await connect(port, 99);
    await future.waitFor((e) => e.event === "resync");
  });

  it("ring byte cap: 1 MiB frames beyond 16 MiB evict the oldest; evicted Last-Event-ID ⇒ resync", async () => {
    const { hub: h, port } = await setup({ maxBufferedBytes: 64 * 1024 * 1024 });
    const payload = "x".repeat(1024 * 1024);
    for (let i = 1; i <= 20; i++) h.publish("fleet", { n: i, payload });
    const frameBytes = Buffer.byteLength(formatSseFrame("fleet", { n: 20, payload }, 20));
    const kept = Math.floor((16 * 1024 * 1024) / frameBytes); // 15 frames fit under 16 MiB
    expect(kept).toBeLessThan(20);
    expect(kept).toBeLessThan(8192);
    const oldestKept = 20 - kept + 1;
    const covered = await connect(port, oldestKept - 1);
    await covered.waitFor((e) => e.data?.n === 20, 10_000);
    const replayed = covered.events.filter((e) => e.event === "fleet");
    expect(replayed.length).toBe(kept);
    expect(replayed[0]!.id).toBe(oldestKept);
    const evicted = await connect(port, oldestKept - 2);
    await evicted.waitFor((e) => e.event === "resync");
    expect(evicted.events.some((e) => e.event === "fleet")).toBe(false);
  });

  it("a replay larger than the per-client buffer budget degrades to resync", async () => {
    const { hub: h, port } = await setup({ maxBufferedBytes: 64 * 1024 });
    for (let i = 1; i <= 4; i++) h.publish("status", { n: i, pad: "y".repeat(40 * 1024) });
    const c = await connect(port, 0);
    await c.waitFor((e) => e.event === "resync");
    expect(c.events.some((e) => e.event === "status")).toBe(false);
    expect(h.count()).toBe(1); // not closed as a slow consumer
  });

  it("directed history frames never enter the ring nor consume ids", async () => {
    const { hub: h, port, attached } = await setup();
    await connect(port);
    h.publish("status", { n: 1 });
    attached[0]!.send("history", { agentKey: "a1", entries: [] });
    h.publish("status", { n: 2 });
    const late = await connect(port, 0);
    await late.waitFor((e) => e.data?.n === 2);
    expect(late.events.map((e) => e.event)).toEqual(["hello", "status", "status"]);
    expect(late.events.slice(1).map((e) => e.id)).toEqual([1, 2]);
  });

  it("slow consumer (writableLength > budget) is closed", async () => {
    const { hub: h, port, attached } = await setup({ maxBufferedBytes: 256 * 1024 });
    const slow = await connect(port);
    slow.pause();
    const fast = await connect(port);
    const big = "z".repeat(32 * 1024);
    // ~64 MiB upper bound: far beyond kernel socket buffers, so the paused
    // client's userland queue must grow past the budget; the reading client drains.
    for (let i = 0; i < 2048 && h.count() === 2; i++) {
      h.publish("fleet", { i, big });
      await new Promise((r) => setTimeout(r, i % 8 === 0 ? 1 : 0));
    }
    expect(h.count()).toBe(1);
    expect(h.get(attached[0]!.id)).toBeUndefined(); // the paused one was dropped
    expect(h.get(attached[1]!.id)).toBe(attached[1]);
    h.publish("status", { alive: true });
    await fast.waitFor((e) => e.data?.alive === true, 10_000);
  });

  it("disconnecting clients are removed; closeAll ends every stream", async () => {
    const { hub: h, port } = await setup();
    const a = await connect(port);
    const b = await connect(port);
    expect(h.count()).toBe(2);
    a.close();
    await vi.waitFor(() => expect(h.count()).toBe(1));
    h.closeAll();
    await b.waitEnd();
    expect(h.count()).toBe(0);
  });

  it("pings every 15 s (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { port } = await setup({ now: () => 777 });
    const c = await connect(port);
    await settle();
    expect(c.events.some((e) => e.event === "ping")).toBe(false);
    vi.advanceTimersByTime(15_000);
    const ping = await c.waitFor((e) => e.event === "ping");
    expect(ping).toEqual({ event: "ping", data: { ts: 777 } });
    vi.advanceTimersByTime(15_000);
    await c.waitFor((_e, all) => all.filter((x) => x.event === "ping").length === 2);
  });

  it("ids start at now() so a restarted hub never replays into a stale range", async () => {
    const h = createSseHub({ now: () => 1_700_000_000_000 });
    hub = h;
    server = createServer((req, res) => h.attach(req, res, undefined));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const c = await connect((server.address() as { port: number }).port);
    h.publish("status", {});
    const ev = await c.waitFor((e) => e.event === "status");
    expect(ev.id).toBe(1_700_000_000_001);
  });
});

// S1 (§4.2, §11 W1 契约测试 ⑩): attach(auth) / revoke(pred, reason) / list().
describe("SseHub auth / revoke / list (plan §4.2)", () => {
  function authOf(userId: number): NonNullable<SseClient["auth"]> {
    return { sidHash: `sid-${userId}`, userId, epoch: 1, boundOrigin: "http://192.168.1.5:7879", verifiedAt: 0 };
  }

  async function setupAuthed(): Promise<{ hub: SseHub; port: number; attached: SseClient[] }> {
    const h = createSseHub({ now: () => 0 });
    hub = h;
    const attached: SseClient[] = [];
    server = createServer((req, res) => {
      const userId = attached.length + 1;
      attached.push(h.attach(req, res, undefined, authOf(userId)));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return { hub: h, port: (server.address() as { port: number }).port, attached };
  }

  it("attach(..., auth) stores it on the returned client and in list()", async () => {
    const { port, attached } = await setupAuthed();
    const c = await connect(port);
    expect(attached[0]!.auth).toEqual(authOf(1));
    expect(hub!.list()).toHaveLength(1);
    expect(hub!.list()[0]!.auth).toEqual(authOf(1));
    c.close();
  });

  it("a plain attach() (no auth arg) leaves `auth` unset", async () => {
    const { port } = await setup();
    const c = await connect(port);
    expect(hub!.list()[0]!.auth).toBeUndefined();
    c.close();
  });

  it("revoke(pred, reason) stops publish/send, emits event:auth, then ends the stream — only for matching clients", async () => {
    const { hub: h, port } = await setupAuthed();
    const a = await connect(port); // user 1
    const b = await connect(port); // user 2
    const n = h.revoke((c) => c.auth?.userId === 1, "revoked");
    expect(n).toBe(1);
    const authEv = await a.waitFor((e) => e.event === "auth");
    expect(authEv.data).toEqual({ reason: "revoked" });
    await a.waitEnd();
    await vi.waitFor(() => expect(h.count()).toBe(1)); // only b remains attached
    h.publish("status", {}); // broadcast after revoke
    await settle();
    expect(b.events.some((e) => e.event === "status")).toBe(true);
    expect(a.events.filter((e) => e.event === "status")).toHaveLength(0); // revoked client received nothing further
    b.close();
  });

  it("revoke() is idempotent per client (a second matching call counts/ends nothing more)", async () => {
    const { hub: h, port } = await setupAuthed();
    const a = await connect(port);
    const first = h.revoke((c) => c.auth?.userId === 1, "revoked");
    const second = h.revoke((c) => c.auth?.userId === 1, "revoked");
    expect(first).toBe(1);
    expect(second).toBe(0);
    await a.waitEnd();
  });

  it("list() only returns currently attached (non-closed) clients", async () => {
    const { hub: h, port } = await setupAuthed();
    const a = await connect(port);
    expect(h.list()).toHaveLength(1);
    a.close();
    await vi.waitFor(() => expect(h.count()).toBe(0));
    expect(h.list()).toHaveLength(0);
  });
});
