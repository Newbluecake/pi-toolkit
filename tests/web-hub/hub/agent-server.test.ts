import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { join } from "node:path";
import { TIMING } from "../../../src/web-hub/protocol/messages.js";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { config, connectClient, hello, memLog, recordBus, tmpDirs, waitFor, type TestClient } from "./helpers.js";

const tmp = tmpDirs();
let server: net.Server;
let agentServer: AgentServer;
let registry: Registry;
let sockPath: string;
const clients: TestClient[] = [];

async function setup(): Promise<void> {
  sockPath = join(tmp.make("wh-as-"), "hub.sock");
  registry = createRegistry({ now: () => Date.now(), log: memLog(), pidAlive: () => true });
  server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  agentServer = createAgentServer(server, {
    registry,
    config: config({ pluginVersion: "9.9.9", buildId: "9.9.9@hub" }),
    log: memLog(),
    now: () => Date.now(),
    httpPort: () => 7878,
  });
}

async function client(): Promise<TestClient> {
  const c = await connectClient(sockPath);
  clients.push(c);
  return c;
}

beforeEach(setup);

afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.sock.destroy();
  await agentServer.close();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

const fakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
};

describe("agent-server handshake", () => {
  it("hello ⇒ hello_ack with agentKey, timings and http.port", async () => {
    const c = await client();
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack).toEqual({
      t: "hello_ack",
      hubVersion: "9.9.9",
      buildId: "9.9.9@hub",
      proto: { major: 1, minor: 0 },
      agentKey: "a4242-nonceA",
      pingMs: TIMING.pingMs,
      leaseMs: TIMING.staleMs,
      http: { port: 7878 },
    });
    expect(registry.list()).toHaveLength(1);
    expect(agentServer.connectionCount()).toBe(1);
  });

  it("no hello within 2s ⇒ disconnected", async () => {
    fakeTimers();
    const c = await client();
    await vi.advanceTimersByTimeAsync(TIMING.helloAckMs - 100);
    expect(c.sock.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await c.closed;
    expect(registry.list()).toHaveLength(0);
  });

  it("malformed hello ⇒ hello_reject E_BAD_HELLO, then closed", async () => {
    const c = await client();
    c.send({ ...hello(), agentId: { pid: 1, nonce: "short" } });
    const rej = await c.waitFrame((f) => f["t"] === "hello_reject");
    expect(rej).toMatchObject({ code: "E_BAD_HELLO" });
    await c.closed;
    expect(registry.list()).toHaveLength(0);
  });

  it("proto major ≠ 1 ⇒ hello_reject E_PROTO", async () => {
    const c = await client();
    c.send(hello({ proto: { major: 2, minor: 0 } }));
    const rej = await c.waitFrame((f) => f["t"] === "hello_reject");
    expect(rej).toMatchObject({ code: "E_PROTO" });
    expect(typeof rej["retryAfterMs"]).toBe("number");
    await c.closed;
  });

  it("non-hello frames before the handshake are ignored (timer still applies)", async () => {
    const c = await client();
    c.send({ t: "status", leafId: null, busy: false, pending: false });
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(registry.get("a4242-nonceA")?.status).toBeUndefined();
  });
});

describe("agent-server liveness and limits", () => {
  it("30s of silence ⇒ disconnect (record enters the claim window)", async () => {
    fakeTimers();
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    await vi.advanceTimersByTimeAsync(TIMING.silenceMs - 1000);
    expect(c.sock.destroyed).toBe(false);
    c.send({ t: "ping", ts: 1 }); // traffic resets the silence timer
    await c.waitFrame((f) => f["t"] === "pong");
    await vi.advanceTimersByTimeAsync(TIMING.silenceMs - 1000);
    expect(c.sock.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    await c.closed;
    await waitFor(() => agentServer.connectionCount() === 0);
    expect(registry.get("a4242-nonceA")?.state).toBe("live"); // claiming shows as live
  });

  it("hub pings every 10s after the handshake; ping is answered with pong", async () => {
    fakeTimers();
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "ping", ts: 123 });
    expect(await c.waitFrame((f) => f["t"] === "pong")).toEqual({ t: "pong", ts: 123 });
    await vi.advanceTimersByTimeAsync(TIMING.pingMs);
    await c.waitFrame((f) => f["t"] === "ping");
  });

  it("a frame over 4 MiB ⇒ disconnect", async () => {
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.raw("x".repeat(4 * 1024 * 1024 + 16));
    await c.closed;
    await waitFor(() => agentServer.connectionCount() === 0);
  });

  it("frames after the handshake reach the registry; bye{quit} ⇒ agent_down", async () => {
    const events = recordBus(registry);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "status", leafId: "L1", busy: true, pending: false });
    c.send({ t: "cmd", rid: "x" }); // reserved: ignored
    c.send({ t: "bye", reason: "quit" });
    await c.closed;
    await waitFor(() => registry.list().length === 0);
    expect(events.map((e) => e.type)).toEqual(["agent_up", "status", "agent_down"]);
  });

  it("a reclaim closes the superseded socket without reporting onClose", async () => {
    const events = recordBus(registry);
    const c1 = await client();
    c1.send(hello());
    await c1.waitFrame((f) => f["t"] === "hello_ack");
    const c2 = await client();
    c2.send(hello({ epoch: "epoch-1" }));
    await c2.waitFrame((f) => f["t"] === "hello_ack");
    await c1.closed;
    await waitFor(() => agentServer.connectionCount() === 1);
    const v = registry.get("a4242-nonceA");
    expect(v?.state).toBe("live");
    // the reclaimed record still has a working connection
    await expect(registry.request("a4242-nonceA", { t: "snapshot_req", rid: "" }, 50)).rejects.toMatchObject({
      code: "E_DEADLINE",
    });
    expect(events.map((e) => e.type)).toEqual(["agent_up"]);
  });

  it("close() destroys live connections", async () => {
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    await agentServer.close();
    await c.closed;
    expect(agentServer.connectionCount()).toBe(0);
  });
});
