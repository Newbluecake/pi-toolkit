/**
 * `hub/lan-sessions.ts` (LAN security r2 §3.2, package D): the sessions route frontend against
 * the contract fake store (`tests/web-hub/contract/fakes.ts`) and a fake `LanSessionsIo`.
 * Asserts, per plan §10 row D: path/method matrix, loopback 404, X-PWH/CSRF gates, the ≤32
 * complete-list honesty (via the store's own cap eviction), revoke-by-id (incl. self ⇒ cookie
 * cleared), revoke-others with a CONCURRENT LOGIN landing mid-delete (the reply counts it and
 * the emits cover it), the 6/min per-user bucket, audit lines, and the absolute deadline ⇒
 * `503 E_DEADLINE` (+ `effect:"unknown"` once a delete was dispatched, with fail-closed emits).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  LAN_SESSION_PUBLIC_ID_RE,
  LAN_SESSIONS_PATH,
  LAN_SESSIONS_REVOKE_PATH,
  LanSessionsResponseSchema,
  type LanSessionsResponse,
} from "../../../src/web-hub/protocol/lan-sessions.js";
import { createLanSessionsRoutes } from "../../../src/web-hub/hub/lan-sessions.js";
import type { LanSessionsAuth, LanSessionsDeps, LanSessionsIo } from "../../../src/web-hub/hub/lan-sessions.js";
import { createAuthRevokeBus, type AuthRevokeEvent } from "../../../src/web-hub/hub/auth-revoke.js";
import { hashSid, publicSessionId } from "../../../src/web-hub/hub/sid-hash.js";
import { fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { captureLog, type LogLine } from "./helpers.js";

const ORIGIN = "http://192.168.32.10:8964";
const IP = "192.168.32.38";
const IDLE_MS = 720 * 60_000;

interface Sent {
  status: number;
  body: unknown;
  headers?: Record<string, string> | undefined;
}

interface Harness {
  store: FakeLanStore;
  routes: ReturnType<typeof createLanSessionsRoutes>;
  sent: Sent[];
  cleared: string[];
  sseRevoked: string[];
  revokeEvents: AuthRevokeEvent[];
  logs: LogLine[];
  nowRef: { t: number };
  auth: LanSessionsAuth;
  call(
    method: string,
    path: string,
    over?: { body?: unknown; xPwh?: boolean; csrf?: boolean; listener?: "loopback" | "lan"; handled?: boolean },
  ): Promise<boolean>;
}

function seedOwner(store: FakeLanStore): void {
  store.seedUser({
    id: 1,
    username: "owner",
    kdf: "scrypt",
    n: 2,
    r: 1,
    p: 1,
    salt: new Uint8Array(16),
    hash: new Uint8Array(32),
    epoch: 1,
    createdAt: 0,
    updatedAt: 0,
  });
}

async function addSession(
  store: FakeLanStore,
  now: number,
  extra: { ip?: string; ua?: string } = {},
): Promise<{ sid: string; sidHash: string }> {
  const r = await store.createSessionChecked({
    userId: 1,
    expectedEpoch: 1,
    expectedFactorGen: 0,
    boundOrigin: ORIGIN,
    createdIp: extra.ip ?? IP,
    now,
    ...(extra.ua === undefined ? {} : { ua: extra.ua }),
  });
  if (!r.ok) throw new Error("seed failed");
  return { sid: r.sid, sidHash: hashSid(r.sid) };
}

function harness(storeOver: Parameters<typeof fakeLanStore>[0] = {}, opts: { fastClock?: boolean } = {}): Harness {
  const store = fakeLanStore({ idleMs: IDLE_MS, ...storeOver });
  seedOwner(store);
  const sent: Sent[] = [];
  const cleared: string[] = [];
  const sseRevoked: string[] = [];
  const revokeEvents: AuthRevokeEvent[] = [];
  const log = captureLog();
  const nowRef = { t: 1_700_000_000_000 };
  const auth: LanSessionsAuth = { userId: 1, sidHash: "", user: "owner" };
  const authRevoke = createAuthRevokeBus(log);
  authRevoke.subscribe((ev) => revokeEvents.push(ev));
  // fastClock: every now() read jumps +30 s, so the 10 s request budget is exhausted by the
  // time a later store IPC is dispatched — the deadline race resolves in ~1 ms of real time.
  const fast = opts.fastClock === true;
  const routes = createLanSessionsRoutes({
    store,
    idleMs: IDLE_MS,
    now: fast
      ? () => {
          const t = nowRef.t;
          nowRef.t += 30_000;
          return t;
        }
      : () => nowRef.t,
    log,
    authRevoke,
    revokeSse: (sidHash) => sseRevoked.push(sidHash),
  } satisfies LanSessionsDeps);

  async function call(
    method: string,
    path: string,
    over: { body?: unknown; xPwh?: boolean; csrf?: boolean; listener?: "loopback" | "lan"; handled?: boolean } = {},
  ): Promise<boolean> {
    const res = { headersSent: false, writableEnded: false, destroy: vi.fn() } as unknown as ServerResponse;
    const io: LanSessionsIo = {
      listener: over.listener ?? "lan",
      ip: IP,
      xPwhOk: () => over.xPwh ?? true,
      csrfOkLan: () => over.csrf ?? true,
      requireLanSession: async () => {
        if (over.handled === true) {
          (res as { writableEnded: boolean }).writableEnded = true;
          sent.push({ status: 401, body: { error: "E_AUTH" } });
          return { handled: true };
        }
        return auth;
      },
      readJson: async () => over.body,
      sendJson: (_res, status, body, headers) => {
        sent.push({ status, body, headers });
        (res as { writableEnded: boolean }).writableEnded = true;
      },
      clearCookie: () => cleared.push("pwh_lan"),
    };
    return routes.handle({} as IncomingMessage, res, method, path, io);
  }
  return { store, routes, sent, cleared, sseRevoked, revokeEvents, logs: log.lines, nowRef, auth, call };
}

function lastSent(h: Harness): Sent {
  const s = h.sent.at(-1);
  if (s === undefined) throw new Error("nothing sent");
  return s;
}

function auditLines(h: Harness): Array<Record<string, unknown>> {
  return h.logs.filter((l) => l.msg === "lan-session").map((l) => (l.data ?? {}) as Record<string, unknown>);
}

describe("lan-sessions routes", () => {
  it("ignores foreign paths/methods (returns false)", async () => {
    const h = harness();
    expect(await h.call("GET", "/api/other")).toBe(false);
    expect(await h.call("POST", LAN_SESSIONS_PATH)).toBe(false);
    expect(await h.call("GET", LAN_SESSIONS_REVOKE_PATH)).toBe(false);
    expect(await h.call("DELETE", LAN_SESSIONS_PATH)).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  it("answers 404 on the loopback listener for both routes (LAN-only, Q6)", async () => {
    const h = harness();
    expect(await h.call("GET", LAN_SESSIONS_PATH, { listener: "loopback" })).toBe(true);
    expect(lastSent(h)).toMatchObject({ status: 404, body: { error: "E_NOT_FOUND" } });
    expect(await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { listener: "loopback", body: { others: true } })).toBe(true);
    expect(lastSent(h)).toMatchObject({ status: 404, body: { error: "E_NOT_FOUND" } });
  });

  it("GET requires X-PWH: 1 before any auth or store call", async () => {
    const h = harness();
    const spy = vi.spyOn(h.store, "listSessions");
    expect(await h.call("GET", LAN_SESSIONS_PATH, { xPwh: false })).toBe(true);
    expect(lastSent(h)).toMatchObject({ status: 403, body: { error: "E_CSRF" } });
    expect(spy).not.toHaveBeenCalled();
    expect(auditLines(h)).toEqual([expect.objectContaining({ op: "list", ok: false, code: "E_CSRF", ip: IP })]);
  });

  it("GET stops at requireLanSession's own answer ({handled:true}) and audits E_AUTH", async () => {
    const h = harness();
    expect(await h.call("GET", LAN_SESSIONS_PATH, { handled: true })).toBe(true);
    expect(h.sent).toHaveLength(1); // only the auth failure written by the io itself
    expect(lastSent(h)).toMatchObject({ status: 401 });
    expect(auditLines(h)).toEqual([expect.objectContaining({ op: "list", ok: false, code: "E_AUTH" })]);
  });

  it("GET lists wire-shaped sessions, current first, public ids only", async () => {
    const h = harness();
    const a = await addSession(h.store, h.nowRef.t - 3_600_000, { ip: "192.168.32.15", ua: "Chrome/130" });
    const cur = await addSession(h.store, h.nowRef.t, { ua: "Edge/155" });
    await addSession(h.store, h.nowRef.t - 60_000, { ip: "192.168.32.51" });
    h.auth.sidHash = cur.sidHash;
    expect(await h.call("GET", LAN_SESSIONS_PATH)).toBe(true);
    const sent = lastSent(h);
    expect(sent.status).toBe(200);
    expect(Value.Check(LanSessionsResponseSchema, sent.body)).toBe(true);
    const body = sent.body as LanSessionsResponse;
    expect(body.idleMinutes).toBe(720);
    expect(body.absoluteDays).toBe(7);
    expect(body.max).toBe(32);
    expect(body.sessions).toHaveLength(3);
    expect(body.sessions[0]!.current).toBe(true);
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
    for (const s of body.sessions) expect(s.id).toMatch(LAN_SESSION_PUBLIC_ID_RE);
    // stable id: the same sidHash maps to the same public id across calls
    const again = await h.call("GET", LAN_SESSIONS_PATH);
    expect(again).toBe(true);
    expect((lastSent(h).body as LanSessionsResponse).sessions.map((s) => s.id)).toEqual(body.sessions.map((s) => s.id));
    // no sidHash / raw sid ever leaves the route
    expect(JSON.stringify(sent.body)).not.toContain(cur.sidHash);
    expect(JSON.stringify(sent.body)).not.toContain(cur.sid);
    expect(JSON.stringify(sent.body)).not.toContain(a.sid);
    expect(auditLines(h).at(-1)).toEqual(expect.objectContaining({ op: "list", ok: true, n: 3, user: "owner" }));
  });

  it("list stays complete at the 32-session cap (the 33rd login evicts, never truncates)", async () => {
    const h = harness();
    let t = h.nowRef.t - 100_000;
    const hashes: string[] = [];
    for (let i = 0; i < 33; i++) {
      t += 1000;
      hashes.push((await addSession(h.store, t)).sidHash);
    }
    h.nowRef.t = t + 1;
    h.auth.sidHash = hashes.at(-1)!;
    await h.call("GET", LAN_SESSIONS_PATH);
    const body = lastSent(h).body as LanSessionsResponse;
    expect(body.sessions).toHaveLength(32);
    expect(body.sessions[0]!.current).toBe(true);
    // every listed id resolves to a live store session — no phantom rows, none missing
    const liveHashes = new Set(h.store.sessionsBySidHash.keys());
    expect(liveHashes.size).toBe(32);
    expect(new Set(body.sessions.map((s) => s.id))).toEqual(
      new Set([...liveHashes].map((hash) => publicSessionId(hash))),
    );
  });

  it("POST revoke requires csrfOkLan (403 E_CSRF) and a schema-valid body (400)", async () => {
    const h = harness();
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { csrf: false, body: { others: true } });
    expect(lastSent(h)).toMatchObject({ status: 403, body: { error: "E_CSRF" } });
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { foo: 1 } });
    expect(lastSent(h)).toMatchObject({ status: 400, body: { error: "E_BAD_REQUEST" } });
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { id: "not-a-valid-id!!" } });
    expect(lastSent(h)).toMatchObject({ status: 400, body: { error: "E_BAD_REQUEST" } });
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: false } });
    expect(lastSent(h)).toMatchObject({ status: 400, body: { error: "E_BAD_REQUEST" } });
    expect(auditLines(h).map((l) => l.code)).toEqual(["E_CSRF", "E_BAD_REQUEST", "E_BAD_REQUEST", "E_BAD_REQUEST"]);
  });

  it("revoke {id} of an unknown/other-user session answers 404 and touches nothing", async () => {
    const h = harness();
    const mine = await addSession(h.store, h.nowRef.t);
    h.auth.sidHash = mine.sidHash;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { id: "A".repeat(16) } });
    expect(lastSent(h)).toMatchObject({ status: 404, body: { error: "E_NOT_FOUND" } });
    expect(h.store.sessionsBySidHash.size).toBe(1);
    expect(h.revokeEvents).toHaveLength(0);
    expect(h.sseRevoked).toHaveLength(0);
  });

  it("revoke {id} deletes the session, emits before+after, SSE-revokes, answers complete", async () => {
    const h = harness();
    const cur = await addSession(h.store, h.nowRef.t, { ip: IP });
    const other = await addSession(h.store, h.nowRef.t, { ip: "192.168.32.15" });
    h.auth.sidHash = cur.sidHash;
    // resolve the public id through a list call — exactly what the UI does
    await h.call("GET", LAN_SESSIONS_PATH);
    const id = (lastSent(h).body as LanSessionsResponse).sessions.find((s) => !s.current)!.id;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { id } });
    expect(lastSent(h)).toMatchObject({ status: 200, body: { ok: true, revoked: 1, complete: true } });
    expect(h.store.sessionsBySidHash.has(other.sidHash)).toBe(false);
    expect(h.store.sessionsBySidHash.has(cur.sidHash)).toBe(true);
    expect(h.revokeEvents).toEqual([
      { sel: { sidTag: other.sidHash }, reason: "logout" },
      { sel: { sidTag: other.sidHash }, reason: "logout" },
    ]);
    expect(h.sseRevoked).toEqual([other.sidHash]);
    expect(h.cleared).toHaveLength(0);
    expect(auditLines(h).at(-1)).toEqual(
      expect.objectContaining({ op: "revoke", ok: true, n: 1, complete: true, self: false }),
    );
  });

  it("self-revoke additionally clears the pwh_lan cookie", async () => {
    const h = harness();
    const cur = await addSession(h.store, h.nowRef.t);
    h.auth.sidHash = cur.sidHash;
    await h.call("GET", LAN_SESSIONS_PATH);
    const id = (lastSent(h).body as LanSessionsResponse).sessions.find((s) => s.current)!.id;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { id } });
    expect(lastSent(h)).toMatchObject({ status: 200, body: { ok: true, revoked: 1, complete: true } });
    expect(h.cleared).toEqual(["pwh_lan"]);
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(auditLines(h).at(-1)).toEqual(expect.objectContaining({ op: "revoke", ok: true, self: true }));
  });

  it("revoke {others:true} deletes every other session, keeps current, honest counts", async () => {
    const h = harness();
    const cur = await addSession(h.store, h.nowRef.t, { ip: IP });
    const o1 = await addSession(h.store, h.nowRef.t, { ip: "192.168.32.15" });
    const o2 = await addSession(h.store, h.nowRef.t, { ip: "192.168.32.51" });
    h.auth.sidHash = cur.sidHash;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: true } });
    expect(lastSent(h)).toMatchObject({ status: 200, body: { ok: true, revoked: 2, complete: true } });
    expect([...h.store.sessionsBySidHash.keys()]).toEqual([cur.sidHash]);
    const emitted = h.revokeEvents.map((e) => (e.sel as { sidTag: string }).sidTag);
    // pre-listed emit (both) + post-delete emit (both)
    expect(emitted.filter((x) => x === o1.sidHash)).toHaveLength(2);
    expect(emitted.filter((x) => x === o2.sidHash)).toHaveLength(2);
    expect(emitted).not.toContain(cur.sidHash);
    expect(h.sseRevoked.sort()).toEqual([o1.sidHash, o2.sidHash].sort());
    expect(h.cleared).toHaveLength(0);
  });

  it("revoke-others counts and revokes a session that logged in concurrently (honest complete)", async () => {
    let concurrentHash = "";
    const h = harness({
      beforeOp: async (op) => {
        if (op !== "deleteSessionsExcept") return;
        const r = await h.store.createSessionChecked({
          userId: 1,
          expectedEpoch: 1,
          expectedFactorGen: 0,
          boundOrigin: ORIGIN,
          createdIp: "192.168.32.99",
          now: h.nowRef.t,
        });
        if (r.ok) concurrentHash = hashSid(r.sid);
      },
    });
    const cur = await addSession(h.store, h.nowRef.t, { ip: IP });
    const other = await addSession(h.store, h.nowRef.t, { ip: "192.168.32.15" });
    h.auth.sidHash = cur.sidHash;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: true } });
    // 3 others existed at delete time: the pre-listed one + the concurrent login
    expect(concurrentHash).not.toBe("");
    expect(lastSent(h)).toMatchObject({ status: 200, body: { ok: true, revoked: 2, complete: true } });
    expect([...h.store.sessionsBySidHash.keys()]).toEqual([cur.sidHash]);
    const emitted = h.revokeEvents.map((e) => (e.sel as { sidTag: string }).sidTag);
    expect(emitted).toContain(other.sidHash);
    expect(emitted).toContain(concurrentHash);
    expect(h.sseRevoked).toContain(concurrentHash);
  });

  it("rate-limits revoke to 6 per minute per user (429 E_RATE + Retry-After)", async () => {
    const h = harness();
    const cur = await addSession(h.store, h.nowRef.t);
    h.auth.sidHash = cur.sidHash;
    for (let i = 0; i < 6; i++) {
      await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: true } });
      expect(lastSent(h).status).toBe(200);
    }
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: true } });
    const sent = lastSent(h);
    expect(sent.status).toBe(429);
    expect(sent.body).toMatchObject({ error: "E_RATE" });
    expect(sent.headers?.["Retry-After"]).toBeDefined();
    // refills after a minute of fake time
    h.nowRef.t += 61_000;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: true } });
    expect(lastSent(h).status).toBe(200);
  });

  it("a store failure on list answers 503 E_DB (fail-closed) and audits it", async () => {
    const h = harness({
      beforeOp: async (op) => {
        if (op === "listSessions") throw new Error("db down");
      },
    });
    const cur = await addSession(h.store, h.nowRef.t);
    h.auth.sidHash = cur.sidHash;
    await h.call("GET", LAN_SESSIONS_PATH);
    expect(lastSent(h)).toMatchObject({ status: 503, body: { error: "E_DB" } });
    expect(auditLines(h).at(-1)).toEqual(expect.objectContaining({ op: "list", ok: false, code: "E_DB" }));
  });

  it("deadline on the list IPC answers 503 E_DEADLINE", async () => {
    const hang = new Promise<void>(() => {});
    const h = harness(
      {
        beforeOp: async (op) => {
          if (op === "listSessions") await hang;
        },
      },
      { fastClock: true },
    );
    const cur = await addSession(h.store, h.nowRef.t);
    h.auth.sidHash = cur.sidHash;
    await h.call("GET", LAN_SESSIONS_PATH);
    expect(lastSent(h)).toMatchObject({ status: 503, body: { error: "E_DEADLINE" } });
    expect(auditLines(h).at(-1)).toEqual(expect.objectContaining({ op: "list", ok: false, code: "E_DEADLINE" }));
  });

  it("deadline AFTER a delete was dispatched: 503 effect:unknown and still emits (fail-closed)", async () => {
    const hang = new Promise<void>(() => {});
    const h = harness(
      {
        beforeOp: async (op) => {
          if (op === "deleteSessionsExcept") await hang;
        },
      },
      { fastClock: true },
    );
    const cur = await addSession(h.store, h.nowRef.t, { ip: IP });
    const other = await addSession(h.store, h.nowRef.t, { ip: "192.168.32.15" });
    h.auth.sidHash = cur.sidHash;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { others: true } });
    expect(lastSent(h)).toMatchObject({ status: 503, body: { error: "E_DEADLINE", effect: "unknown" } });
    // pre-listed hashes were emitted before dispatch AND again on the uncertain path
    const emitted = h.revokeEvents.map((e) => (e.sel as { sidTag: string }).sidTag);
    expect(emitted.filter((x) => x === other.sidHash)).toHaveLength(2);
    expect(h.sseRevoked).toEqual([other.sidHash]);
    expect(auditLines(h).at(-1)).toEqual(
      expect.objectContaining({ op: "others", ok: false, code: "E_DEADLINE", n: 1 }),
    );
  });

  it("deadline on a single revoke emits fail-closed and clears the cookie on self", async () => {
    const hang = new Promise<void>(() => {});
    const h = harness(
      {
        beforeOp: async (op) => {
          if (op === "deleteSession") await hang;
        },
      },
      { fastClock: true },
    );
    const cur = await addSession(h.store, h.nowRef.t);
    h.auth.sidHash = cur.sidHash;
    await h.call("GET", LAN_SESSIONS_PATH);
    const id = (lastSent(h).body as LanSessionsResponse).sessions[0]!.id;
    await h.call("POST", LAN_SESSIONS_REVOKE_PATH, { body: { id } });
    expect(lastSent(h)).toMatchObject({ status: 503, body: { error: "E_DEADLINE", effect: "unknown" } });
    const emitted = h.revokeEvents.map((e) => (e.sel as { sidTag: string }).sidTag);
    expect(emitted.filter((x) => x === cur.sidHash).length).toBeGreaterThanOrEqual(2);
    expect(h.sseRevoked).toEqual([cur.sidHash]);
    expect(h.cleared).toEqual(["pwh_lan"]);
  });

  it("handle never throws, even when the io throws", async () => {
    const h = harness();
    const res = { headersSent: false, writableEnded: false, destroy: vi.fn() } as unknown as ServerResponse;
    const io: LanSessionsIo = {
      listener: "lan",
      ip: IP,
      xPwhOk: () => true,
      csrfOkLan: () => true,
      requireLanSession: async () => {
        throw new Error("boom");
      },
      readJson: async () => ({}),
      sendJson: (_r, status, body) => {
        h.sent.push({ status, body });
        (res as { writableEnded: boolean }).writableEnded = true;
      },
      clearCookie: () => {},
    };
    await expect(h.routes.handle({} as IncomingMessage, res, "GET", LAN_SESSIONS_PATH, io)).resolves.toBe(true);
    expect(lastSent(h)).toMatchObject({ status: 500, body: { error: "E_INTERNAL" } });
  });
});
