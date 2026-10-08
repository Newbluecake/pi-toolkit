import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { join } from "node:path";
import { TIMING } from "../../../src/web-hub/protocol/messages.js";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import {
  DIALOG_BG_HUB_CAPS,
  HOLD_HUB_CAPS,
  P2_HUB_CAPS,
  RUNTX_HUB_CAPS,
  UPLOAD_HUB_CAPS,
} from "../../../src/web-hub/protocol/version.js";
import {
  config,
  connectClient,
  hello,
  memLog,
  recordBus,
  sleepReal,
  tmpDirs,
  waitFor,
  type TestClient,
} from "./helpers.js";

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

describe("agent-server: hub_ctl shutdown ack (spawn-restore §9.3)", () => {
  it("restart ack carries restoreCount; stop ack does not", async () => {
    await agentServer.close();
    await new Promise<void>((r) => server.close(() => r()));
    const shutdowns: string[] = [];
    server = net.createServer();
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    agentServer = createAgentServer(server, {
      registry,
      config: config({ pluginVersion: "9.9.9", buildId: "9.9.9@hub" }),
      log: memLog(),
      now: () => Date.now(),
      httpPort: () => 7878,
      admin: {
        caps: () => [],
        handleShutdown: (_meta: unknown, reason: string) => {
          shutdowns.push(reason);
        },
      } as never,
      restoreCount: () => 3,
    });

    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "hub_ctl", rid: "r1", op: "shutdown", reason: "restart" });
    const ack1 = await c.waitFrame((f) => f["t"] === "hub_ctl_ack" && f["rid"] === "r1");
    expect(ack1).toEqual({ t: "hub_ctl_ack", rid: "r1", restoreCount: 3 });
    c.send({ t: "hub_ctl", rid: "r2", op: "shutdown", reason: "stop" });
    const ack2 = await c.waitFrame((f) => f["t"] === "hub_ctl_ack" && f["rid"] === "r2");
    expect(ack2).toEqual({ t: "hub_ctl_ack", rid: "r2" });
    expect(shutdowns).toEqual(["restart", "stop"]);
  });
});

describe("agent-server handshake", () => {
  it("hello ⇒ hello_ack with agentKey, timings and http.port", async () => {
    const c = await client();
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack).toEqual({
      t: "hello_ack",
      hubVersion: "9.9.9",
      buildId: "9.9.9@hub",
      proto: { major: 1, minor: 2 },
      agentKey: "a4242-nonceA",
      pingMs: TIMING.pingMs,
      leaseMs: TIMING.staleMs,
      http: { port: 7878 },
      caps: [...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...DIALOG_BG_HUB_CAPS, ...HOLD_HUB_CAPS, ...RUNTX_HUB_CAPS],
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

describe("agent-server: P2 caps pass-through (plan §3.1/§6.1, C3)", () => {
  it("hello.caps (cmd.v1/dialog.v1/command.v1) reach the registry via the normal hello handshake, gating /api/cmd admission downstream", async () => {
    const c = await client();
    c.send(hello({ caps: ["ev.v1", "cmd.v1", "dialog.v1", "command.v1"] }));
    await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(registry.getCaps("a4242-nonceA")).toEqual(["ev.v1", "cmd.v1", "dialog.v1", "command.v1"]);
    expect(registry.get("a4242-nonceA")?.control).toBe(true);
  });

  it("a cmd_result/cmd_late/dialogs/ctl/commands frame sent by the agent reaches the registry unmodified (no special-casing in agent-server.ts, unlike lan_req/hub_ctl)", async () => {
    const events = recordBus(registry);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "dialogs", epoch: "epoch-1", open: [], closed: [] });
    c.send({ t: "ctl", epoch: "epoch-1", sessionId: "s1", items: [] });
    c.send({ t: "commands", epoch: "epoch-1", items: [] });
    await waitFor(() => events.map((e) => e.type).includes("commands"));
    expect(events.map((e) => e.type)).toEqual(["agent_up", "dialogs", "ctl", "commands"]);
  });
});

// ---------------------------------------------------------------------------
// fleet-drawer plan §5.3 (F3b): run-transcript frames pass through the agent socket untouched
// (no special-casing in agent-server.ts, unlike lan_req/hub_ctl) and hello_ack.caps stays
// byte-identical with hub.ts's HubInfo.caps after the RUNTX fold (full parity matrix:
// tests/web-hub/hub/caps-coexist.test.ts).
// ---------------------------------------------------------------------------

describe("agent-server: run-transcript frames (fleet-drawer §5.3, F3b)", () => {
  it("run_ev/run_gap/run_end/run_tx_reply frames reach the registry and its bus unmodified", async () => {
    const events = recordBus(registry);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    const p = registry.request(
      "a4242-nonceA",
      { t: "run_tx_req", rid: "", runId: "r_ABCDEFGH", limit: 1, maxBytes: 1 },
      1000,
    );
    const req = await c.waitFrame((f) => f["t"] === "run_tx_req");
    const rid = req["rid"] as string;
    c.send({ t: "run_ev", runId: "r_ABCDEFGH", tapId: "tapAAAAAAAAAAAA", seq: 1, e: { type: "turn_start" } });
    c.send({ t: "run_gap", runId: "r_ABCDEFGH", tapId: "tapAAAAAAAAAAAA", fromSeq: 1 });
    c.send({
      t: "run_tx_reply",
      rid,
      runId: "r_ABCDEFGH",
      ok: true,
      source: "live",
      status: "running",
      tapId: "tapAAAAAAAAAAAA",
      seq: 2,
      watching: true,
      entries: [],
      truncated: false,
      hasMore: false,
    });
    await expect(p).resolves.toMatchObject({ t: "run_tx_reply", ok: true, source: "live", seq: 2 });
    c.send({ t: "run_end", runId: "r_ABCDEFGH", tapId: "tapAAAAAAAAAAAA", lastSeq: 2, status: "completed" });
    await waitFor(() => events.some((e) => e.type === "run_end"));
    expect(events.filter((e) => e.type.startsWith("run_")).map((e) => e.type)).toEqual([
      "run_ev",
      "run_gap",
      "run_end",
    ]);
  });

  it("a run_watch frame sent BY the agent is ignored (hub→agent direction; decode-side only)", async () => {
    const events = recordBus(registry);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "run_watch", runId: "r_ABCDEFGH", on: true });
    await sleepReal(20);
    expect(events.filter((e) => e.type.startsWith("run_"))).toEqual([]);
  });
});
