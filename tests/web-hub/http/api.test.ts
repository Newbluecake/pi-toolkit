import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPayload } from "../../../src/web-hub/protocol/http-contract.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import {
  emptyHistory,
  fakeDeps,
  login,
  makeAgent,
  makeTmp,
  openSse,
  postJson,
  rawRequest,
  type FakeDeps,
  type SseConn,
} from "./helpers.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
const conns: SseConn[] = [];

beforeEach(async () => {
  tmp = makeTmp("pwh-api-");
  deps = fakeDeps(tmp.dir);
  deps.agents.set("a1", makeAgent("a1", { status: { leafId: "L1", busy: false, pending: false } }));
  deps.agents.set("a2", makeAgent("a2", { pid: 5151 }));
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
});

afterEach(async () => {
  vi.useRealTimers();
  for (const c of conns.splice(0)) c.close();
  await fe.close();
  tmp.cleanup();
});

async function events(lastEventId?: number): Promise<{ conn: SseConn; clientId: string }> {
  const conn = await openSse(port, lastEventId === undefined ? { cookie } : { cookie, lastEventId });
  conns.push(conn);
  expect(conn.status).toBe(200);
  const hello = await conn.waitFor((e) => e.event === "hello");
  await conn.waitFor((e) => e.event === "agents");
  return { conn, clientId: hello.data.clientId as string };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const ev = (agentKey: string, seq: number) =>
  ({ type: "ev", agentKey, seq, e: { type: "message_update", n: seq } }) as const;

describe("GET /api/events", () => {
  it("opens with hello, hub, agents (full cards without hub-internal fields)", async () => {
    const { conn } = await events();
    expect(conn.events.slice(0, 3).map((e) => e.event)).toEqual(["hello", "hub", "agents"]);
    expect(conn.events[1]!.data).toMatchObject({ version: "9.9.9", buildId: "b1", port, proto: { major: 1 } });
    const cards = conn.events[2]!.data.agents as Array<Record<string, unknown>>;
    expect(cards.map((c) => c.agentKey)).toEqual(["a1", "a2"]);
    expect(cards[0]).toMatchObject({ kind: "tui", state: "live", status: { leafId: "L1" }, prompts: [] });
    for (const c of cards) {
      expect(c).not.toHaveProperty("agentId");
      expect(c).not.toHaveProperty("seq");
      expect(c).not.toHaveProperty("lastFrameAt");
    }
    expect(fe.clientCount()).toBe(1);
  });

  it("global bus events reach every client; ev/gap only subscribers", async () => {
    const one = await events();
    const two = await events();
    expect(
      (await postJson(port, "/api/subscribe", { clientId: one.clientId, agentKey: "a1" }, { Cookie: cookie })).status,
    ).toBe(202);
    await one.conn.waitFor((e) => e.event === "history");
    deps.emit({ type: "status", agentKey: "a1", status: { leafId: "L2", busy: true, pending: false } });
    deps.emit(ev("a1", 3));
    deps.emit({ type: "gap", agentKey: "a1", fromSeq: 9 });
    deps.emit({ type: "agent_stale", agentKey: "a2" });
    await one.conn.waitFor((e) => e.event === "agent_stale");
    await two.conn.waitFor((e) => e.event === "agent_stale");
    expect(one.conn.events.map((e) => e.event)).toEqual(expect.arrayContaining(["status", "ev", "gap"]));
    expect(two.conn.events.map((e) => e.event)).toContain("status");
    expect(two.conn.events.map((e) => e.event)).not.toContain("ev");
    expect(two.conn.events.map((e) => e.event)).not.toContain("gap");
    const status = two.conn.events.find((e) => e.event === "status")!;
    expect(status.data).toEqual({ agentKey: "a1", status: { leafId: "L2", busy: true, pending: false } });
    expect(typeof status.id).toBe("number");
  });

  it("bus append ⇒ SSE append only to subscribers, stored in the ring (has an id)", async () => {
    const sub = await events();
    const other = await events();
    await postJson(port, "/api/subscribe", { clientId: sub.clientId, agentKey: "a1" }, { Cookie: cookie });
    await sub.conn.waitFor((e) => e.event === "history");
    const entries = [{ id: "e9", parentId: "e8", type: "custom_message", timestamp: "t", customType: "task" }];
    deps.emit({ type: "append", agentKey: "a1", entries: entries as never });
    deps.emit({ type: "agent_stale", agentKey: "a2" });
    const app = await sub.conn.waitFor((e) => e.event === "append");
    expect(app.data).toEqual({ agentKey: "a1", entries });
    expect(typeof app.id).toBe("number");
    await other.conn.waitFor((e) => e.event === "agent_stale");
    expect(other.conn.events.some((e) => e.event === "append")).toBe(false);
  });

  it("Last-Event-ID replay of global frames on reconnect; stale id ⇒ resync", async () => {
    const first = await events();
    deps.emit({ type: "agent_stale", agentKey: "a2" });
    const stale = await first.conn.waitFor((e) => e.event === "agent_stale");
    deps.emit({ type: "status", agentKey: "a1", status: { leafId: "L3", busy: false, pending: false } });
    await first.conn.waitFor((e) => e.event === "status");
    first.conn.close();
    const again = await events(stale.id);
    const replayed = again.conn.events.filter((e) => e.id !== undefined);
    expect(replayed.map((e) => e.event)).toEqual(["status"]);
    const bogus = await events(1);
    expect(bogus.conn.events.some((e) => e.event === "resync")).toBe(true);
  });

  it("fleet is cached and re-sent to new clients; dropped on agent_down", async () => {
    const runs = [
      { runId: "r1", status: "running", phaseLabel: "x", elapsedMs: 1, phaseMs: 1, highlight: "none", terminal: false },
    ];
    deps.emit({ type: "fleet", agentKey: "a1", runs: runs as never });
    const late = await events();
    const fleet = await late.conn.waitFor((e) => e.event === "fleet");
    expect(fleet.data).toEqual({ agentKey: "a1", runs });
    deps.emit({ type: "agent_down", agentKey: "a1", reason: "quit" });
    await late.conn.waitFor((e) => e.event === "agent_down");
    const later = await events();
    await new Promise((r) => setTimeout(r, 30));
    expect(later.conn.events.some((e) => e.event === "fleet")).toBe(false);
  });
});

describe("POST /api/subscribe", () => {
  it("history is pushed before buffered ev; ev already merged (seq < fromSeq) are dropped", async () => {
    const { conn, clientId } = await events();
    const d = deferred<HistoryPayload>();
    deps.setSnapshot(() => d.promise);
    const res = await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    expect(res.status).toBe(202);
    expect(deps.historyCalls.snapshot).toEqual(["a1"]);
    deps.emit(ev("a1", 5));
    deps.emit(ev("a1", 6));
    deps.emit(ev("a1", 7));
    deps.emit({ type: "agent_stale", agentKey: "a2" }); // global marker
    await conn.waitFor((e) => e.event === "agent_stale");
    expect(conn.events.some((e) => e.event === "ev" || e.event === "history")).toBe(false);
    d.resolve(emptyHistory("a1", 6));
    await conn.waitFor((e) => e.event === "ev" && e.data.seq === 7);
    const order = conn.events.filter((e) => e.event === "history" || e.event === "ev");
    expect(order.map((e) => (e.event === "ev" ? `ev${e.data.seq}` : e.event))).toEqual(["history", "ev6", "ev7"]);
    expect(order[0]!.id).toBeUndefined(); // history is directed, not in the ring
    deps.emit(ev("a1", 8)); // now live
    const live = await conn.waitFor((e) => e.event === "ev" && e.data.seq === 8);
    expect(typeof live.id).toBe("number");
  });

  it("snapshot rejecting with E_DEADLINE ⇒ history{error:E_DEADLINE}; client not subscribed", async () => {
    const { conn, clientId } = await events();
    deps.setSnapshot(() => Promise.reject(Object.assign(new Error("snapshot timed out"), { code: "E_DEADLINE" })));
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    const h = await conn.waitFor((e) => e.event === "history");
    expect(h.data).toMatchObject({ agentKey: "a1", error: "E_DEADLINE" });
    deps.emit(ev("a1", 1));
    deps.emit({ type: "agent_stale", agentKey: "a2" });
    await conn.waitFor((e) => e.event === "agent_stale");
    expect(conn.events.some((e) => e.event === "ev")).toBe(false);
  });

  it("snapshot rejecting with an unknown error ⇒ history{error:E_INTERNAL} without raw message", async () => {
    const { conn, clientId } = await events();
    deps.setSnapshot(() => Promise.reject(new Error("secret disk path /home/x")));
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    const h = await conn.waitFor((e) => e.event === "history");
    expect(h.data).toMatchObject({ agentKey: "a1", error: "E_INTERNAL" });
    expect((h.data as { message?: unknown }).message).toBeUndefined();
  });

  it("a hung snapshot is bounded by the frontend guard ⇒ history{error:E_DEADLINE}", async () => {
    const { conn, clientId } = await events();
    deps.setSnapshot(() => new Promise<HistoryPayload>(() => {}));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    await vi.advanceTimersByTimeAsync(6_500);
    vi.useRealTimers();
    const h = await conn.waitFor((e) => e.event === "history");
    expect(h.data).toMatchObject({ agentKey: "a1", error: "E_DEADLINE" });
  });

  it("validates input: unknown clientId/agentKey ⇒ 404, missing fields ⇒ 400", async () => {
    const { clientId } = await events();
    const h = { Cookie: cookie };
    expect((await postJson(port, "/api/subscribe", { clientId: "cX", agentKey: "a1" }, h)).status).toBe(404);
    expect((await postJson(port, "/api/subscribe", { clientId, agentKey: "zz" }, h)).status).toBe(404);
    expect((await postJson(port, "/api/subscribe", { clientId }, h)).status).toBe(400);
    expect((await postJson(port, "/api/subscribe", "str", h)).status).toBe(400);
  });

  it("unsubscribe stops scoped frames; re-subscribe re-snapshots", async () => {
    const { conn, clientId } = await events();
    const h = { Cookie: cookie };
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, h);
    await conn.waitFor((e) => e.event === "history");
    expect((await postJson(port, "/api/unsubscribe", { clientId, agentKey: "a1" }, h)).status).toBe(200);
    deps.emit(ev("a1", 2));
    deps.emit({ type: "agent_stale", agentKey: "a2" });
    await conn.waitFor((e) => e.event === "agent_stale");
    expect(conn.events.some((e) => e.event === "ev")).toBe(false);
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, h);
    await conn.waitFor((_e, all) => all.filter((x) => x.event === "history").length === 2);
    expect(deps.historyCalls.snapshot).toEqual(["a1", "a1"]);
  });

  it("agent_down while a snapshot is pending discards the result", async () => {
    const { conn, clientId } = await events();
    const d = deferred<HistoryPayload>();
    deps.setSnapshot(() => d.promise);
    await postJson(port, "/api/subscribe", { clientId, agentKey: "a1" }, { Cookie: cookie });
    deps.emit({ type: "agent_down", agentKey: "a1", reason: "quit" });
    await conn.waitFor((e) => e.event === "agent_down");
    d.resolve(emptyHistory("a1"));
    await new Promise((r) => setTimeout(r, 30));
    expect(conn.events.some((e) => e.event === "history")).toBe(false);
  });
});

describe("GET /api/history", () => {
  it("delegates to history.page with limit clamped to 400", async () => {
    deps.setPage(async (k) => ({ ...emptyHistory(k), hasMore: true, oldestEntryId: "e1" }));
    const res = await rawRequest(port, {
      path: "/api/history?agent=a1&before=e5&limit=9999",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ agentKey: "a1", hasMore: true, oldestEntryId: "e1" });
    await rawRequest(port, { path: "/api/history?agent=a1&before=e5", headers: { Cookie: cookie } });
    await rawRequest(port, { path: "/api/history?agent=a1&before=e5&limit=0", headers: { Cookie: cookie } });
    expect(deps.historyCalls.page).toEqual([
      ["a1", "e5", 400],
      ["a1", "e5", 400],
      ["a1", "e5", 1],
    ]);
  });

  it("errors: bad params 400, unknown agent 404, E_DEADLINE 504, E_AGENT_GONE 410", async () => {
    const h = { Cookie: cookie };
    expect((await rawRequest(port, { path: "/api/history?agent=a1", headers: h })).status).toBe(400);
    expect((await rawRequest(port, { path: "/api/history?agent=a1&before=x&limit=abc", headers: h })).status).toBe(400);
    expect((await rawRequest(port, { path: "/api/history?agent=zz&before=x", headers: h })).status).toBe(404);
    deps.setPage(() => Promise.reject(Object.assign(new Error("slow"), { code: "E_DEADLINE" })));
    const slow = await rawRequest(port, { path: "/api/history?agent=a1&before=x", headers: h });
    expect(slow.status).toBe(504);
    expect(JSON.parse(slow.body)).toMatchObject({ error: "E_DEADLINE" });
    deps.setPage(() => Promise.reject(new Error("E_AGENT_GONE")));
    expect((await rawRequest(port, { path: "/api/history?agent=a1&before=x", headers: h })).status).toBe(410);
    deps.setPage(() => Promise.reject(new Error("boom")));
    const boom = await rawRequest(port, { path: "/api/history?agent=a1&before=x", headers: h });
    expect(boom.status).toBe(500);
    expect(JSON.parse(boom.body)).toEqual({ error: "E_INTERNAL" }); // raw message never leaks
    deps.setPage(() => Promise.reject(Object.assign(new Error("db corrupted at /home/x/secret"), { code: "weird" })));
    const weird = await rawRequest(port, { path: "/api/history?agent=a1&before=x", headers: h });
    expect(weird.status).toBe(500);
    expect(JSON.parse(weird.body)).toEqual({ error: "E_INTERNAL" });
    expect(JSON.parse(weird.body).message).toBeUndefined();
  });
});

describe("reserved P2/P3 endpoints and misc", () => {
  it("cmd/dialog/headless ⇒ 501 E_NOT_IMPLEMENTED after auth + CSRF", async () => {
    for (const path of ["/api/cmd", "/api/dialog", "/api/headless", "/api/headless/a1/close"]) {
      const res = await postJson(port, path, { agentKey: "a1" }, { Cookie: cookie });
      expect(res.status, path).toBe(501);
      expect(JSON.parse(res.body)).toEqual({ error: "E_NOT_IMPLEMENTED" });
      expect((await postJson(port, path, {})).status, `${path} no cookie`).toBe(401);
      expect((await rawRequest(port, { method: "POST", path, headers: { Cookie: cookie }, body: "{}" })).status).toBe(
        403,
      );
    }
  });

  it("unknown api routes ⇒ 404; clientCount follows SSE connections", async () => {
    expect((await rawRequest(port, { path: "/api/nope", headers: { Cookie: cookie } })).status).toBe(404);
    expect((await postJson(port, "/api/nope", {}, { Cookie: cookie })).status).toBe(404);
    expect(
      (await rawRequest(port, { method: "DELETE", path: "/api/events", headers: { Cookie: cookie } })).status,
    ).toBe(404);
    expect(fe.clientCount()).toBe(0);
    const { conn } = await events();
    expect(fe.clientCount()).toBe(1);
    conn.close();
    await vi.waitFor(() => expect(fe.clientCount()).toBe(0));
  });
});
