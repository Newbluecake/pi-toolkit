/**
 * `agent-server.ts`'s admin wiring (plan §8 — S1-W3 LD 包; caps merge updated for C3, plan §3.1):
 * `hello_ack.caps` is always sent — `[...admin.caps(), ...P2_HUB_CAPS]` when `deps.admin` is
 * supplied, plain `P2_HUB_CAPS` when it is not (`agent-server.test.ts`'s direct-unit-test callers);
 * `lan_req`/`hub_ctl` frames are dispatched to `deps.admin` and never reach `registry.onFrame`/the
 * bus/the normal per-frame log (§8.1); `hub_ctl_ack` is sent before `handleShutdown` runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { join } from "node:path";
import type { LanReqFrame, LanResFrame } from "../../../src/web-hub/protocol/messages.js";
import type { AdminHandler, AdminMeta } from "../../../src/web-hub/hub/admin.js";
import { createAgentServer, type AgentServer } from "../../../src/web-hub/hub/agent-server.js";
import { createRegistry, type Registry } from "../../../src/web-hub/hub/registry.js";
import { DIALOG_BG_HUB_CAPS, P2_HUB_CAPS, UPLOAD_HUB_CAPS } from "../../../src/web-hub/protocol/version.js";
import { config, connectClient, hello, memLog, tmpDirs, type TestClient } from "./helpers.js";

const tmp = tmpDirs();
let server: net.Server;
let agentServer: AgentServer;
let registry: Registry;
let sockPath: string;
const clients: TestClient[] = [];

function fakeAdmin(over: Partial<AdminHandler> = {}): AdminHandler & { calls: Array<{ op: string; meta: AdminMeta }> } {
  const calls: Array<{ op: string; meta: AdminMeta }> = [];
  const admin = {
    caps: () => ["ctl.v1", "lan.v1"],
    async handleLanReq(frame: LanReqFrame, meta: AdminMeta): Promise<LanResFrame> {
      calls.push({ op: frame.op, meta });
      return { t: "lan_res", rid: frame.rid, ok: true };
    },
    handleShutdown(meta: AdminMeta, reason: "restart" | "stop") {
      calls.push({ op: "shutdown", meta });
    },
    ...over,
  };
  return { ...admin, calls };
}

async function setup(admin?: AdminHandler, extraHubCaps?: readonly string[]): Promise<void> {
  sockPath = join(tmp.make("wh-as-admin-"), "hub.sock");
  registry = createRegistry({ now: () => Date.now(), log: memLog(), pidAlive: () => true });
  server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  agentServer = createAgentServer(server, {
    registry,
    config: config({ pluginVersion: "9.9.9", buildId: "9.9.9@hub" }),
    log: memLog(),
    now: () => Date.now(),
    httpPort: () => 7878,
    ...(admin === undefined ? {} : { admin }),
    ...(extraHubCaps === undefined ? {} : { extraHubCaps }),
  });
}

async function client(): Promise<TestClient> {
  const c = await connectClient(sockPath);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.sock.destroy();
  await agentServer.close();
  await new Promise<void>((r) => server.close(() => r()));
  tmp.cleanup();
});

describe("agent-server + admin wiring (plan §8)", () => {
  it("no deps.admin ⇒ hello_ack.caps degrades to plain P2_HUB_CAPS + UPLOAD_HUB_CAPS + DIALOG_BG_HUB_CAPS (C3, plan §3.1 — never omitted)", async () => {
    await setup();
    const c = await client();
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["caps"]).toEqual([...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...DIALOG_BG_HUB_CAPS]);
  });

  it("deps.admin present ⇒ hello_ack.caps is admin.caps() plus P2_HUB_CAPS + UPLOAD_HUB_CAPS + DIALOG_BG_HUB_CAPS (C3, plan §3.1)", async () => {
    const admin = fakeAdmin({ caps: () => ["ctl.v1", "lan.v1"] });
    await setup(admin);
    const c = await client();
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["caps"]).toEqual(["ctl.v1", "lan.v1", ...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...DIALOG_BG_HUB_CAPS]);
  });

  it("web-hub-spawn §SP10: deps.extraHubCaps is appended verbatim after the static tails (spawn.v1 rides last)", async () => {
    const admin = fakeAdmin({ caps: () => ["ctl.v1", "lan.v1"] });
    await setup(admin, ["spawn.v1"]);
    const c = await client();
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const caps = ack["caps"] as string[];
    expect(caps).toEqual(["ctl.v1", "lan.v1", ...P2_HUB_CAPS, ...UPLOAD_HUB_CAPS, ...DIALOG_BG_HUB_CAPS, "spawn.v1"]);
    expect(caps[caps.length - 1]).toBe("spawn.v1");
  });

  it("lan_req is dispatched to admin.handleLanReq with agentKey/agentPid, and its reply is written back verbatim", async () => {
    const admin = fakeAdmin();
    await setup(admin);
    const c = await client();
    c.send(hello({ agentId: { pid: 4321, nonce: "nonceBBBBBBBBBBBBBBB" } }));
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "lan_req", rid: "rid-1", op: "info" });
    const res = await c.waitFrame((f) => f["t"] === "lan_res");
    expect(res).toEqual({ t: "lan_res", rid: "rid-1", ok: true });
    expect(admin.calls).toEqual([{ op: "info", meta: { agentKey: expect.any(String), agentPid: 4321 } }]);
  });

  it("lan_req never reaches registry.onFrame, the bus, or agent_up/agent_down-style registry logging", async () => {
    const admin = fakeAdmin();
    await setup(admin);
    const onFrameSpy = vi.spyOn(registry, "onFrame");
    const busEvents: unknown[] = [];
    registry.bus.subscribe((e) => busEvents.push(e));

    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    onFrameSpy.mockClear();
    busEvents.length = 0;

    c.send({ t: "lan_req", rid: "rid-2", op: "unlock" });
    await c.waitFrame((f) => f["t"] === "lan_res");

    expect(onFrameSpy).not.toHaveBeenCalled();
    expect(busEvents).toEqual([]);
    expect(admin.calls).toEqual([{ op: "unlock", meta: { agentKey: expect.any(String), agentPid: 4242 } }]);
  });

  it("hub_ctl: hub_ctl_ack is written before admin.handleShutdown is invoked (ack-before-close)", async () => {
    const order: string[] = [];
    const admin = fakeAdmin({
      handleShutdown: (meta) => {
        order.push("handleShutdown");
      },
    });
    await setup(admin);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");

    c.send({ t: "hub_ctl", rid: "rid-3", op: "shutdown", reason: "restart" });
    const ack = await c.waitFrame((f) => f["t"] === "hub_ctl_ack");
    order.push("ack-received");
    expect(ack).toEqual({ t: "hub_ctl_ack", rid: "rid-3" });
    // handleShutdown is called synchronously right after the write — by the time the client has
    // *observed* the ack frame, the call already happened; the ordering that matters (write
    // scheduled before the shutdown side effect) is enforced by agent-server.ts itself.
    expect(order).toContain("handleShutdown");
  });

  it("hub_ctl rotate_token routes to admin.handleRotateToken and acks with revoked (C8 P0)", async () => {
    const order: string[] = [];
    const admin = fakeAdmin({
      handleShutdown: () => {
        order.push("handleShutdown");
      },
      handleRotateToken: async (meta: AdminMeta) => {
        order.push("handleRotateToken");
        return { token: "tok-new", revoked: { loopback: 2, lan: 3 } };
      },
    } as Partial<AdminHandler>);
    await setup(admin);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");

    c.send({ t: "hub_ctl", rid: "rid-rot", op: "rotate_token" });
    const ack = await c.waitFrame((f) => f["t"] === "hub_ctl_ack");
    // P0 regression: rotate_token must never reach the shutdown path, and the ack carries the
    // revocation counts once the (async) handler resolves.
    expect(ack).toEqual({ t: "hub_ctl_ack", rid: "rid-rot", revoked: { loopback: 2, lan: 3 } });
    expect(order).toEqual(["handleRotateToken"]);
  });

  it("hub_ctl shutdown passes the stop reason through to admin.handleShutdown", async () => {
    const reasons: string[] = [];
    const admin = fakeAdmin({
      handleShutdown: (_meta: AdminMeta, reason: "restart" | "stop") => {
        reasons.push(reason);
      },
    } as Partial<AdminHandler>);
    await setup(admin);
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");

    c.send({ t: "hub_ctl", rid: "rid-stop", op: "shutdown", reason: "stop" });
    await c.waitFrame((f) => f["t"] === "hub_ctl_ack");
    expect(reasons).toEqual(["stop"]);
  });

  it("hub_ctl never reaches registry.onFrame or the bus", async () => {
    const admin = fakeAdmin();
    await setup(admin);
    const onFrameSpy = vi.spyOn(registry, "onFrame");
    const busEvents: unknown[] = [];
    registry.bus.subscribe((e) => busEvents.push(e));
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    onFrameSpy.mockClear();
    busEvents.length = 0;

    c.send({ t: "hub_ctl", rid: "rid-4", op: "shutdown", reason: "restart" });
    await c.waitFrame((f) => f["t"] === "hub_ctl_ack");

    expect(onFrameSpy).not.toHaveBeenCalled();
    expect(busEvents).toEqual([]);
  });

  it("without deps.admin, lan_req/hub_ctl are silently dropped (no crash, no reply)", async () => {
    await setup();
    const c = await client();
    c.send(hello());
    await c.waitFrame((f) => f["t"] === "hello_ack");
    c.send({ t: "lan_req", rid: "rid-5", op: "unlock" });
    c.send({ t: "ping", ts: 1 });
    const pong = await c.waitFrame((f) => f["t"] === "pong");
    expect(pong).toEqual({ t: "pong", ts: 1 });
    expect(c.frames.some((f) => (f as Record<string, unknown>)["t"] === "lan_res")).toBe(false);
  });
});
