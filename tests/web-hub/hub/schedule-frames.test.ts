/**
 * scheduled-reports plan r3 §10.1 (H1) — agent-server routes the three `sched_*` agent frames to
 * the coordinator dep BEFORE the registry: they never enter the registry record path, the bus, or
 * the normal per-frame handling (same posture as `fsb_req`/`xs_req`). No coordinator ⇒ the frames
 fall through to the registry exactly as before (ignored), byte-identical.
 */
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import type { SchedAgentFrame } from "../../../src/web-hub/protocol/schedule.js";
import { config, connectClient, hello, memLog, tmpDirs, type TestClient } from "./helpers.js";

const tmp = tmpDirs();
let server: net.Server;
let agentServer: AgentServer;
let registry: Registry;
let sockPath: string;
const clients: TestClient[] = [];

const frames: Array<{ agentKey: string; frame: SchedAgentFrame }> = [];
const schedDep = {
  onAgentFrame: (agentKey: string, frame: SchedAgentFrame): void => {
    frames.push({ agentKey, frame });
  },
};

async function boot(dep?: typeof schedDep): Promise<void> {
  sockPath = join(tmp.make("wh-sched-frames-"), "hub.sock");
  registry = createRegistry({ now: () => Date.now(), log: memLog(), pidAlive: () => true });
  server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  agentServer = createAgentServer(server, {
    registry,
    config: config({ pluginVersion: "9.9.9", buildId: "9.9.9@hub" }),
    log: memLog(),
    now: () => Date.now(),
    httpPort: () => 7878,
    ...(dep === undefined ? {} : { schedule: dep }),
  });
}

beforeEach(async () => {
  frames.length = 0;
  await boot(schedDep);
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.sock.destroy();
  await agentServer.close();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

async function client(): Promise<TestClient> {
  const c = await connectClient(sockPath);
  clients.push(c);
  c.send(hello());
  await c.waitFrame((f) => f["t"] === "hello_ack");
  return c;
}

describe("agent-server: sched_* frame routing", () => {
  it("sched_changed / sched_bound / sched_run_ack reach the coordinator, never the registry", async () => {
    const c = await client();
    c.send({ t: "sched_changed", sessionId: "sid-a" });
    c.send({ t: "sched_bound", agentKey: "a1", runKey: "s_abcd2345@1761350400000" });
    c.send({ t: "sched_run_ack", reqId: "req-1234567890abcdef", result: "refused", reason: "E_OVERLAP" });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.map((f) => f.frame.t)).toEqual(["sched_changed", "sched_bound", "sched_run_ack"]);
    expect(frames.every((f) => f.agentKey === frames[0]!.agentKey)).toBe(true);
    const last = frames[2]!.frame as { reqId: string; result: string; reason?: string };
    expect(last.reqId).toBe("req-1234567890abcdef");
    expect(last.result).toBe("refused");
    expect(last.reason).toBe("E_OVERLAP");
  });

  it("malformed sched frames are dropped by the decoder (never reach the coordinator)", async () => {
    const c = await client();
    c.send({ t: "sched_changed" }); // missing sessionId
    c.send({ t: "sched_run_ack", reqId: "short", result: "started" }); // bad reqId shape
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toEqual([]);
    // The connection stays alive (no disconnect).
    c.send({ t: "ping", ts: 1 });
    const pong = await c.waitFrame((f) => f["t"] === "pong");
    expect(pong).toBeDefined();
  });

  it("without the coordinator dep the frames fall through silently (byte-identical)", async () => {
    await agentServer.close();
    await new Promise<void>((r) => server.close(() => r()));
    await boot(undefined);
    const c = await client();
    c.send({ t: "sched_changed", sessionId: "sid-a" });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toEqual([]);
    c.send({ t: "ping", ts: 1 });
    expect(await c.waitFrame((f) => f["t"] === "pong")).toBeDefined();
  });

  it("frames before hello are ignored (no coordinator call)", async () => {
    const c = await connectClient(sockPath);
    clients.push(c);
    c.send({ t: "sched_changed", sessionId: "sid-a" });
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    await new Promise((r) => setTimeout(r, 50));
    expect(frames).toEqual([]);
  });
});
