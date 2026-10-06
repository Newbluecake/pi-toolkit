/**
 * web-hub-delete-session plan v2 §2.4/§4.1/§7.1 (C2 regression, A11): `POST /api/agents/remove`
 * on the LAN listener. Mirrors `lan-headless.test.ts`'s harness style
 * (`lan-helpers.ts`'s `startLan`, extended with `agentRemove`/`registry` passthroughs).
 *
 * Covers: LAN session auth, spawnId form ⇒ 404 when `spawn.lan==="off"`, C2's non-terminal
 * `lan-off` ⇒ 403 `E_SPAWN_DENIED{lan-off}` with the process AND the card both left untouched
 * (no `agent_removed` broadcast), terminal+confirmed ⇒ 200 (card only), terminal+unconfirmed ⇒
 * 409, and an online unmanaged card ⇒ 409 `E_AGENT_ONLINE{online}`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan, fakeClock, type LanHarness } from "./lan-helpers.js";
import type { HubEvent } from "../../../src/web-hub/hub/ports.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import { createAgentRemoveService } from "../../../src/web-hub/hub/agent-remove.js";
import { spawnKit, type SpawnKit } from "./spawn-kit.js";

const harnesses: LanHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function loginAs(h: LanHarness, username: string, id: number): Promise<string> {
  seedLanUser(h.store, { id, username, password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username, password: "correct-horse-battery" });
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

interface FakeRegistryRemove extends Pick<Registry, "remove"> {
  calls: Array<{ agentKey: string; allowConnected: boolean }>;
  online: Set<string>;
  present: Set<string>;
  events: HubEvent[];
}

function fakeRegistryRemove(): FakeRegistryRemove {
  const calls: FakeRegistryRemove["calls"] = [];
  const online = new Set<string>();
  const present = new Set<string>();
  const events: HubEvent[] = [];
  return {
    calls,
    online,
    present,
    events,
    remove(agentKey, opts) {
      calls.push({ agentKey, allowConnected: opts.allowConnected });
      if (!present.has(agentKey)) {
        events.push({ type: "agent_removed", agentKey });
        return "absent";
      }
      if (online.has(agentKey) && !opts.allowConnected) return "online";
      present.delete(agentKey);
      online.delete(agentKey);
      events.push({ type: "agent_down", agentKey, reason: "removed" });
      events.push({ type: "agent_removed", agentKey });
      return "removed";
    },
  };
}

async function start(opts: {
  lan: "off" | "known" | "roots";
}): Promise<{ h: LanHarness; kit: SpawnKit; reg: FakeRegistryRemove }> {
  const clock = fakeClock();
  const kit = spawnKit({ lan: opts.lan }, clock);
  const reg = fakeRegistryRemove();
  const agentRemove = createAgentRemoveService({
    registry: reg,
    managed: { sup: kit.supervisor, lan: opts.lan },
    log: kit.log,
    now: clock.now,
  });
  const h = await startLan({ spawn: kit.spawn, agentRemove });
  harnesses.push(h);
  return { h, kit, reg };
}

describe("LAN POST /api/agents/remove", () => {
  it("requires a LAN session (401 without one)", async () => {
    const { h } = await start({ lan: "known" });
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a1-abcdef" }, {});
    expect(res.status).toBe(401);
  });

  it("spawnId form, spawn.lan===off ⇒ 404 (byte-identical to not-enabled)", async () => {
    const { h } = await start({ lan: "off" });
    const cookie = await loginAs(h, "alice", 1);
    const res = await lanPostJson(h.port, "/api/agents/remove", { spawnId: "sp_0123456789abcdef" }, { Cookie: cookie });
    expect(res.status).toBe(404);
  });

  it("C2: non-terminal managed record, spawn.lan===off ⇒ 403 E_SPAWN_DENIED{lan-off}; process AND card untouched, no agent_removed", async () => {
    const { h, kit, reg } = await start({ lan: "off" });
    const cookie = await loginAs(h, "alice", 1);
    kit.supervisor.seedRecord({ spawnId: "sp_0123456789abcdef", state: "live", agentKey: "a1-abcdef" });
    reg.present.add("a1-abcdef");
    reg.online.add("a1-abcdef");
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a1-abcdef" }, { Cookie: cookie });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "E_SPAWN_DENIED", reason: "lan-off" });
    expect(kit.supervisor.removeCalls).toEqual([]); // the spawn record was never touched
    expect(reg.calls).toEqual([]); // the registry was never touched either
    expect(reg.events.some((e) => e.type === "agent_removed")).toBe(false);
  });

  it("C2: terminal managed record, spawn.lan===off, death confirmed ⇒ 200, card deleted via registry.remove(allowConnected:true), spawn record untouched", async () => {
    const { h, kit, reg } = await start({ lan: "off" });
    const cookie = await loginAs(h, "alice", 1);
    kit.supervisor.seedRecord({
      spawnId: "sp_0123456789abcdef",
      state: "exited",
      endReason: "crash",
      agentKey: "a1-abcdef",
    });
    kit.supervisor.setDeathOf("confirmed");
    reg.present.add("a1-abcdef");
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a1-abcdef" }, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true });
    expect(kit.supervisor.removeCalls).toEqual([]);
    expect(reg.calls).toEqual([{ agentKey: "a1-abcdef", allowConnected: true }]);
  });

  it("C2: terminal managed record, spawn.lan===off, death unconfirmed ⇒ 409 exit-unconfirmed, registry untouched", async () => {
    const { h, kit, reg } = await start({ lan: "off" });
    const cookie = await loginAs(h, "alice", 1);
    kit.supervisor.seedRecord({
      spawnId: "sp_0123456789abcdef",
      state: "exited",
      endReason: "crash",
      agentKey: "a1-abcdef",
    });
    kit.supervisor.setDeathOf("alive");
    reg.present.add("a1-abcdef");
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a1-abcdef" }, { Cookie: cookie });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" });
    expect(reg.calls).toEqual([]);
  });

  it("A11: lan='known' (feature usable on LAN), a managed live record ⇒ remove() drives the normal pending flow", async () => {
    const { h, kit } = await start({ lan: "known" });
    const cookie = await loginAs(h, "alice", 1);
    kit.supervisor.seedRecord({ spawnId: "sp_0123456789abcdef", state: "live", agentKey: "a1-abcdef" });
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a1-abcdef" }, { Cookie: cookie });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ pending: true, state: "stopping" });
  });

  it("an online, unmanaged card ⇒ 409 E_AGENT_ONLINE{online}", async () => {
    const { h, reg } = await start({ lan: "known" });
    const cookie = await loginAs(h, "alice", 1);
    reg.present.add("a9-nomanage");
    reg.online.add("a9-nomanage");
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a9-nomanage" }, { Cookie: cookie });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "E_AGENT_ONLINE", reason: "online" });
  });

  it("an offline unmanaged card ⇒ 200, registry.remove(allowConnected:false)", async () => {
    const { h, reg } = await start({ lan: "known" });
    const cookie = await loginAs(h, "alice", 1);
    reg.present.add("a9-nomanage");
    const res = await lanPostJson(h.port, "/api/agents/remove", { agentKey: "a9-nomanage" }, { Cookie: cookie });
    expect(res.status).toBe(200);
    expect(reg.calls).toEqual([{ agentKey: "a9-nomanage", allowConnected: false }]);
  });

  it("CSRF quartet still applies on LAN (missing X-PWH ⇒ 403)", async () => {
    const { h } = await start({ lan: "known" });
    const cookie = await loginAs(h, "alice", 1);
    const res = await lanRequest(h.port, {
      method: "POST",
      path: "/api/agents/remove",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: `http://127.0.0.1:${h.port}` },
      body: JSON.stringify({ agentKey: "a1-abcdef" }),
    });
    expect(res.status).toBe(403);
  });
});
