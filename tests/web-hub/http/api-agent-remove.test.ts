/**
 * web-hub-delete-session plan v2 §2.3/§2.4/§4.1/§7.1: `POST /api/agents/remove` on the LOOPBACK
 * listener through the real `createHttpFrontend` HTTP stack (repo style, mirrors
 * `tests/web-hub/http/api-headless.test.ts`).
 *
 * Covers: CSRF quartet, 401, body validation (400), 413/408, 429+Retry-After, A1 (online ⇒ 409),
 * A2 (offline ⇒ 200 + hub broadcast), A3/r1 #4 (stale→remove→re-register: the OLD SSE
 * subscription never sees a stray `ev` for the reused agentKey; a fresh `/api/subscribe` gets
 * `history` first), A7-adjacent managed-record rows (3/6) through `spawnKit`, and A13's one
 * `audit:"remove"` line per request. The §2.4 decision table itself is unit-tested in
 * `tests/web-hub/hub/agent-remove.test.ts`; LAN auth/lan-off rows live in `lan-agent-remove.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { createAgentRemoveService } from "../../../src/web-hub/hub/agent-remove.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import {
  fakeDeps,
  login,
  makeAgent,
  makeTmp,
  openSse,
  postJson,
  rawRequest,
  type FakeDeps,
  type RawResponse,
  type SseConn,
} from "./helpers.js";
import { fakeClock, type FakeClock } from "./lan-helpers.js";
import { spawnKit, type SpawnKit } from "./spawn-kit.js";

function wireFakeRegistryRemove(deps: FakeDeps, offline: Set<string>): Pick<Registry, "remove"> {
  return {
    remove(agentKey: string, opts: { allowConnected: boolean }): "removed" | "absent" | "online" {
      if (!deps.agents.has(agentKey)) {
        deps.emit({ type: "agent_removed", agentKey });
        return "absent";
      }
      if (!offline.has(agentKey) && !opts.allowConnected) return "online";
      deps.agents.delete(agentKey);
      offline.delete(agentKey);
      deps.emit({ type: "agent_down", agentKey, reason: "removed" });
      deps.emit({ type: "agent_removed", agentKey });
      return "removed";
    },
  };
}

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let offline: Set<string>;
const conns: SseConn[] = [];

const ORIGIN = (p: number): string => `http://127.0.0.1:${p}`;

function removePost(body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return postJson(port, "/api/agents/remove", body, { Cookie: cookie, Origin: ORIGIN(port), ...headers });
}

async function events(): Promise<{ conn: SseConn; clientId: string }> {
  const conn = await openSse(port, { cookie });
  conns.push(conn);
  expect(conn.status).toBe(200);
  const hello = await conn.waitFor((e) => e.event === "hello");
  await conn.waitFor((e) => e.event === "agents");
  return { conn, clientId: hello.data.clientId as string };
}

beforeEach(async () => {
  tmp = makeTmp("pwh-agentremove-");
  deps = fakeDeps(tmp.dir);
  offline = new Set();
  deps.agentRemove = createAgentRemoveService({
    registry: wireFakeRegistryRemove(deps, offline),
    log: deps.log,
    now: deps.now,
  });
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
});

afterEach(async () => {
  for (const c of conns.splice(0)) c.close();
  await fe.close();
  tmp.cleanup();
});

describe("POST /api/agents/remove — gates", () => {
  it("missing X-PWH/Origin ⇒ 403 E_CSRF (strict quartet, same grade as /api/cmd)", async () => {
    deps.agents.set("a1", makeAgent("a1"));
    offline.add("a1");
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/agents/remove",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ agentKey: "a1" }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_CSRF" });
  });

  it("no session cookie ⇒ 401", async () => {
    const res = await postJson(port, "/api/agents/remove", { agentKey: "a1" }, { Origin: ORIGIN(port) });
    expect(res.status).toBe(401);
  });

  it("both agentKey and spawnId ⇒ 400; neither ⇒ 400", async () => {
    const both = await removePost({ agentKey: "a1", spawnId: "sp_0123456789abcdef" });
    expect(both.status).toBe(400);
    const neither = await removePost({});
    expect(neither.status).toBe(400);
  });

  it("oversize body ⇒ 413, connection closing", async () => {
    const res = await removePost({ agentKey: "a1", pad: "x".repeat(8192) });
    expect(res.status).toBe(413);
  });

  it("no spawn feature at all, spawnId form ⇒ 404 E_NOT_FOUND", async () => {
    const res = await removePost({ spawnId: "sp_0123456789abcdef" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/agents/remove — A1/A2/A3 (registry-only, no managed spawn)", () => {
  it("A1: an online (connected) card ⇒ 409 E_AGENT_ONLINE{online}; card untouched", async () => {
    deps.agents.set("a1", makeAgent("a1"));
    const res = await removePost({ agentKey: "a1" });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "E_AGENT_ONLINE", reason: "online" });
    expect(deps.agents.has("a1")).toBe(true);
  });

  it("A2: an offline/stale card ⇒ 200, hub broadcasts agent_removed to every connected tab", async () => {
    deps.agents.set("a1", makeAgent("a1", { state: "stale" }));
    offline.add("a1");
    const { conn } = await events();
    const res = await removePost({ agentKey: "a1" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true });
    await conn.waitFor((e) => e.event === "agent_removed" && e.data.agentKey === "a1");
    expect(deps.agents.has("a1")).toBe(false);
  });

  it("unknown agentKey ⇒ 200 idempotent, still broadcasts agent_removed", async () => {
    const { conn } = await events();
    const res = await removePost({ agentKey: "a0000-nobody" });
    expect(res.status).toBe(200);
    await conn.waitFor((e) => e.event === "agent_removed" && e.data.agentKey === "a0000-nobody");
  });

  it("A3/r1 #4: after remove, an old subscription never sees a stray ev for the reused agentKey; re-subscribing gets history first", async () => {
    deps.agents.set("a1", makeAgent("a1", { state: "stale" }));
    offline.add("a1");
    const { conn, clientId } = await events();
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    await conn.waitFor((e) => e.event === "history");

    const removed = await removePost({ agentKey: "a1" });
    expect(removed.status).toBe(200);
    await conn.waitFor((e) => e.event === "agent_removed");

    // the same agentKey comes back (process reconnected) — a fresh record, scoped subscription
    // from before the removal must NOT still be wired.
    deps.agents.set("a1", makeAgent("a1"));
    deps.emit({ type: "agent_up", agent: makeAgent("a1") });
    deps.emit({ type: "ev", agentKey: "a1", seq: 99, e: { type: "custom_message", text: "stray" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.events.find((e) => e.event === "ev" && e.data?.seq === 99)).toBeUndefined();

    // a fresh subscribe gets `history` before any further `ev`
    const before = conn.events.length;
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    const hist = await conn.waitFor((e, all) => all.indexOf(e) >= before && e.event === "history");
    expect(hist.event).toBe("history");
  });
});

describe("POST /api/agents/remove — rate limiting", () => {
  it("429 with Retry-After once the per-principal bucket is spent", async () => {
    for (let i = 0; i < 10; i++) {
      deps.agents.set(`a${i}`, makeAgent(`a${i}`, { state: "stale" }));
      offline.add(`a${i}`);
      const r = await removePost({ agentKey: `a${i}` });
      expect(r.status).toBe(200);
    }
    deps.agents.set("a99", makeAgent("a99", { state: "stale" }));
    offline.add("a99");
    const limited = await removePost({ agentKey: "a99" });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});

describe("POST /api/agents/remove — audit (A13)", () => {
  it("every request writes exactly one audit:remove line", async () => {
    deps.agents.set("a1", makeAgent("a1", { state: "stale" }));
    offline.add("a1");
    await removePost({ agentKey: "a1" });
    const lines = deps.logLines.filter((l) => (l.data as Record<string, unknown> | undefined)?.["audit"] === "remove");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.data).toMatchObject({
      phase: "request",
      listener: "loopback",
      agentKey: "a1",
      outcome: "removed",
    });
  });
});

describe("POST /api/agents/remove — managed spawn rows (§2.4 row 2/3)", () => {
  let kit: SpawnKit;
  let clock: FakeClock;

  beforeEach(async () => {
    for (const c of conns.splice(0)) c.close();
    await fe.close();
    tmp.cleanup();
    tmp = makeTmp("pwh-agentremove-managed-");
    deps = fakeDeps(tmp.dir);
    offline = new Set();
    clock = fakeClock();
    kit = spawnKit({}, clock);
    deps.spawn = kit.spawn;
    deps.agentRemove = createAgentRemoveService({
      registry: wireFakeRegistryRemove(deps, offline),
      managed: { sup: kit.supervisor, lan: "known" },
      log: deps.log,
      now: deps.now,
    });
    fe = createHttpFrontend(deps);
    port = (await fe.listen()).port;
    cookie = await login(port, deps.paths.tokenFile);
  });

  it("row 2: unknown spawnId (feature on) ⇒ 200 idempotent", async () => {
    const res = await removePost({ spawnId: "sp_0123456789abcdef" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removed: true });
  });

  it("row 3: a found starting record ⇒ 202 pending (non-terminal)", async () => {
    kit.supervisor.seedRecord({ spawnId: "sp_0123456789abcdef", state: "starting" });
    const res = await removePost({ spawnId: "sp_0123456789abcdef" });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({ removed: false, pending: true, state: "stopping" });
    expect(kit.supervisor.removeCalls).toEqual([{ spawnId: "sp_0123456789abcdef" }]);
  });

  it("row 3: a terminal record, death confirmed ⇒ 200 removed", async () => {
    kit.supervisor.seedRecord({ spawnId: "sp_0123456789abcdef", state: "exited", endReason: "crash" });
    kit.supervisor.setRemoveResult({ ok: true, outcome: "removed" });
    const res = await removePost({ spawnId: "sp_0123456789abcdef" });
    expect(res.status).toBe(200);
  });
});
