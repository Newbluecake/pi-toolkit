/**
 * web-hub-privacy plan v2.1 (P1 测试锚点, loopback listener): `POST /api/privacy/lock`
 * through the REAL `createHttpFrontend` — CSRF/auth gates, sessionId 409 E_SESSION_CHANGED
 * (agent 无 session 同码), unknown agent 404, loopback unlock needs NO password (v2.1 N1),
 * `/api/privacy/verify` is NOT mounted on loopback (404), E_LIMIT ⇒ 409 — plus the `privacy`
 * SSE frame discipline: connect burst carries the full snapshot BEFORE `agents`, change
 * broadcasts are direct-send (no `id:` — never the replay ring).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIVACY_MAX_ENTRIES } from "../../../src/web-hub/hub/privacy/store.js";
import { createPrivacyRoutes } from "../../../src/web-hub/hub/privacy/routes.js";
import { createPrivacyStore, type PrivacyStore } from "../../../src/web-hub/hub/privacy/store.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeAgent, makeTmp, openSse, postJson, type FakeDeps, type RawResponse } from "./helpers.js";
import { fakeClock } from "./lan-helpers.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let store: PrivacyStore;
const clock = fakeClock();

const AGENT = makeAgent("k1", {
  session: { sessionId: "sess-1", cwd: "/tmp/wa", reason: "new", leafId: null, mode: "tui" },
});
const NO_SESSION = makeAgent("k2");

beforeEach(async () => {
  tmp = makeTmp("pwh-privacy-http-");
  deps = fakeDeps(tmp.dir);
  mkdirSync(deps.paths.stateDir, { recursive: true });
  deps.agents.set("k1", AGENT);
  deps.agents.set("k2", NO_SESSION);
  store = createPrivacyStore({
    stateDir: deps.paths.stateDir,
    log: deps.log,
    onChange: (locked) => deps.emit({ type: "privacy", locked }),
  });
  await store.load();
  deps.privacy = createPrivacyRoutes({ store, registry: deps.registry, log: deps.log, now: clock.now });
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
});

afterEach(async () => {
  await fe.close();
  await store.close();
  tmp.cleanup();
});

function lock(body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return postJson(port, "/api/privacy/lock", body, { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, ...headers });
}

describe("loopback POST /api/privacy/lock", () => {
  it("happy path: locked:true ⇒ 200 {ok:true}, the mark persists and broadcasts on the bus", async () => {
    const events: string[] = [];
    deps.bus.subscribe((e) => {
      if (e.type === "privacy") events.push([...e.locked].join(","));
    });
    const r = await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(store.locked()).toEqual(["sess-1"]);
    expect(events).toEqual(["sess-1"]);
    // audit: one `audit:"privacy"` request line with the agentKey plaintext (v2 评审 #10
    // 惯例) — and NEVER the sessionId or any password material.
    const line = deps.logLines.find((l) => l.level === "info" && l.msg === "privacy");
    expect(line?.data).toMatchObject({
      audit: "privacy",
      phase: "request",
      op: "lock",
      agentKey: "k1",
      locked: true,
      ok: true,
    });
    expect(JSON.stringify(line?.data)).not.toContain("sess-1");
    // and it survives a store reload (persistence, not memory-only)
    const reread = createPrivacyStore({ stateDir: deps.paths.stateDir, log: deps.log });
    await reread.load();
    expect(reread.locked()).toEqual(["sess-1"]);
  });

  it("loopback unlock needs NO password (v2.1 N1) — locked:false alone ⇒ 200", async () => {
    await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
    const r = await lock({ agentKey: "k1", sessionId: "sess-1", locked: false });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(store.locked()).toEqual([]);
  });

  it("CSRF: missing X-PWH ⇒ 403 E_CSRF; missing Origin ⇒ 403 (strict write-endpoint rule)", async () => {
    const noXPwh = await postJson(
      port,
      "/api/privacy/lock",
      { agentKey: "k1", sessionId: "sess-1", locked: true },
      {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${port}`,
        "X-PWH": "",
      },
    );
    expect(noXPwh.status).toBe(403);
    const noOrigin = await postJson(
      port,
      "/api/privacy/lock",
      { agentKey: "k1", sessionId: "sess-1", locked: true },
      {
        Cookie: cookie,
        Origin: "",
      },
    );
    expect(noOrigin.status).toBe(403);
    expect(store.locked()).toEqual([]);
  });

  it("no session cookie ⇒ 401 E_AUTH", async () => {
    const r = await postJson(
      port,
      "/api/privacy/lock",
      { agentKey: "k1", sessionId: "sess-1", locked: true },
      {
        Origin: `http://127.0.0.1:${port}`,
      },
    );
    expect(r.status).toBe(401);
  });

  it("sessionId mismatch (the agent /new'd meanwhile) ⇒ 409 E_SESSION_CHANGED, mark untouched", async () => {
    const r = await lock({ agentKey: "k1", sessionId: "sess-old", locked: true });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_SESSION_CHANGED" });
    expect(store.locked()).toEqual([]);
  });

  it("agent without a session ⇒ same 409 E_SESSION_CHANGED (plan「接口」)", async () => {
    const r = await lock({ agentKey: "k2", sessionId: "sess-1", locked: true });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_SESSION_CHANGED" });
  });

  it("unknown agentKey ⇒ 404 E_NOT_FOUND", async () => {
    const r = await lock({ agentKey: "ghost", sessionId: "sess-1", locked: true });
    expect(r.status).toBe(404);
  });

  it("malformed body (missing locked / bad sessionId / unknown extra key) ⇒ 400 E_BAD_REQUEST", async () => {
    for (const body of [
      { agentKey: "k1", sessionId: "sess-1" },
      { agentKey: "k1", sessionId: "bad/id", locked: true },
      { agentKey: "k1", sessionId: "sess-1", locked: true, extra: 1 },
      { agentKey: "k1", sessionId: "sess-1", locked: "yes" },
    ]) {
      const r = await lock(body);
      expect(r.status).toBe(400);
    }
    expect(store.locked()).toEqual([]);
  });

  it("E_LIMIT: a full 4096-entry store refuses one more NEW mark with 409 E_LIMIT", async () => {
    await fe.close();
    const locked: Record<string, true> = {};
    for (let i = 0; i < PRIVACY_MAX_ENTRIES; i++) locked[`s-${i}`] = true;
    writeFileSync(join(deps.paths.stateDir, "privacy.json"), JSON.stringify({ version: 1, locked }));
    store = createPrivacyStore({
      stateDir: deps.paths.stateDir,
      log: deps.log,
      onChange: (l) => deps.emit({ type: "privacy", locked: l }),
    });
    await store.load();
    deps.privacy = createPrivacyRoutes({ store, registry: deps.registry, log: deps.log, now: clock.now });
    fe = createHttpFrontend(deps);
    port = (await fe.listen()).port;
    cookie = await login(port, deps.paths.tokenFile);
    const r = await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_LIMIT" });
  });

  it("POST /api/privacy/verify is NOT mounted on loopback ⇒ 404 (v2.1 N1: no second credential)", async () => {
    const r = await postJson(
      port,
      "/api/privacy/verify",
      { password: "whatever" },
      { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    );
    expect(r.status).toBe(404);
  });
});

describe("privacy SSE frame (loopback)", () => {
  it("connect burst: the full snapshot lands BEFORE `agents`", async () => {
    await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
    const conn = await openSse(port, { cookie });
    try {
      await conn.waitFor((e) => e.event === "agents");
      const order = conn.events.map((e) => e.event);
      const at = order.indexOf("privacy");
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(order.indexOf("agents"));
      const frame = conn.events[at]!;
      expect(frame.data).toEqual({ locked: ["sess-1"] });
      expect(frame.id).toBeUndefined(); // direct-send: never an id, never the replay ring
    } finally {
      conn.close();
    }
  });

  it("lock/unlock broadcasts are direct-send (no id) and carry the full new set", async () => {
    const conn = await openSse(port, { cookie });
    try {
      await conn.waitFor((e) => e.event === "agents");
      await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
      const locked1 = await conn.waitFor((e) => e.event === "privacy" && e.data.locked?.includes("sess-1"));
      expect(locked1.id).toBeUndefined();
      await lock({ agentKey: "k1", sessionId: "sess-1", locked: false });
      const cleared = await conn.waitFor((e) => e.event === "privacy" && e.data.locked?.length === 0);
      expect(cleared.id).toBeUndefined();
    } finally {
      conn.close();
    }
  });

  it("reconnect with Last-Event-ID: privacy is NOT replayed from the ring — the fresh snapshot rides the burst instead", async () => {
    const first = await openSse(port, { cookie });
    await first.waitFor((e) => e.event === "agents");
    await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
    // any ring frame (e.g. agent_up) gets an id; grab one so the reconnect has a cursor
    deps.emit({ type: "agent_up", agent: makeAgent("k9") });
    const ringFrame = await first.waitFor((e) => e.id !== undefined);
    first.close();
    const second = await openSse(port, { cookie, lastEventId: ringFrame.id });
    try {
      await second.waitFor((e) => e.event === "agents");
      const privacyFrames = second.events.filter((e) => e.event === "privacy");
      // exactly one privacy frame: the connect-burst snapshot (no id), nothing replayed
      expect(privacyFrames).toHaveLength(1);
      expect(privacyFrames[0]!.id).toBeUndefined();
      expect(privacyFrames[0]!.data).toEqual({ locked: ["sess-1"] });
    } finally {
      second.close();
    }
  });
});

describe("feature off (no FrontendDeps.privacy)", () => {
  it("both paths 404 and no privacy frame is ever sent — byte-identical to pre-feature", async () => {
    await fe.close();
    await store.close();
    deps = fakeDeps(tmp.dir);
    fe = createHttpFrontend(deps); // no deps.privacy
    port = (await fe.listen()).port;
    cookie = await login(port, deps.paths.tokenFile);
    const r = await lock({ agentKey: "k1", sessionId: "sess-1", locked: true });
    expect(r.status).toBe(404);
    const conn = await openSse(port, { cookie });
    try {
      await conn.waitFor((e) => e.event === "agents");
      expect(conn.events.some((e) => e.event === "privacy")).toBe(false);
    } finally {
      conn.close();
    }
  });
});
