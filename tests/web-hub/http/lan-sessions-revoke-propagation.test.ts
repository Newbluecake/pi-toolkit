/**
 * LAN security r2 §3.2 + §10 row D (package D): revoke PROPAGATION. The sessions route is the
 * producer side of the revocation fan-out; its consumers (HTML preview caps + proxy HTTP/WS
 * sessions via the auth-revoke bus, SSE clients via `revokeSse`, the browser cookie via
 * `clearCookie`) are wired by I. This suite pins the producer contract those consumers rely on:
 *
 *  - every revoke emits `authRevoke {sel:{sidTag:<sidHash>}, reason:"logout"}` BOTH before and
 *    after the awaited store delete (the double emit is what kills anything minted inside the
 *    await window — same order as `http.ts`'s `/api/logout`);
 *  - `revokeSse(sidHash)` runs AFTER the second emit;
 *  - a self-revoke also clears the `pwh_lan` cookie;
 *  - bus subscribers standing in for the proxy/HTML-cap consumers (matching on `sel.sidTag`,
 *    the shape the real subscribers use at `http.ts:2826` / `proxy/sessions.ts:94-98`) observe
 *    the death of exactly the revoked sessions — never the current one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { LAN_SESSIONS_REVOKE_PATH } from "../../../src/web-hub/protocol/lan-sessions.js";
import { createLanSessionsRoutes, type LanSessionsDeps } from "../../../src/web-hub/hub/lan-sessions.js";
import { createAuthRevokeBus, type AuthRevokeEvent } from "../../../src/web-hub/hub/auth-revoke.js";
import { hashSid, publicSessionId } from "../../../src/web-hub/hub/sid-hash.js";
import { fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { captureLog } from "./helpers.js";

const ORIGIN = "http://192.168.32.10:8964";
const IP = "192.168.32.38";

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

async function addSession(store: FakeLanStore, now: number, ip: string): Promise<string> {
  const r = await store.createSessionChecked({
    userId: 1,
    expectedEpoch: 1,
    expectedFactorGen: 0,
    boundOrigin: ORIGIN,
    createdIp: ip,
    now,
  });
  if (!r.ok) throw new Error("seed failed");
  return hashSid(r.sid);
}

interface Rig {
  store: FakeLanStore;
  order: string[];
  capsKilled: string[];
  proxyKilled: string[];
  sseKilled: string[];
  cleared: string[];
  status(): number;
  setCurrent(sidHash: string): void;
  call(method: string, path: string, body?: unknown): Promise<void>;
}

function rig(): Rig {
  const store = fakeLanStore({ idleMs: 720 * 60_000 });
  seedOwner(store);
  const order: string[] = [];
  const capsKilled: string[] = [];
  const proxyKilled: string[] = [];
  const sseKilled: string[] = [];
  const cleared: string[] = [];
  let status = 0;
  let currentHash = "";
  const log = captureLog();
  const authRevoke = createAuthRevokeBus(log);
  // Stand-ins for the two real bus consumers (HTML preview caps + proxy sessions), matching on
  // the same `sel.sidTag` shape the real subscribers use.
  authRevoke.subscribe((ev: AuthRevokeEvent) => {
    if ("sidTag" in ev.sel) {
      order.push(`emit:${ev.sel.sidTag.slice(0, 8)}`);
      capsKilled.push(ev.sel.sidTag);
    }
  });
  authRevoke.subscribe((ev: AuthRevokeEvent) => {
    if ("sidTag" in ev.sel) proxyKilled.push(ev.sel.sidTag);
  });
  const deps: LanSessionsDeps = {
    store,
    idleMs: 720 * 60_000,
    now: () => 1_000_000,
    log,
    authRevoke,
    revokeSse: (sidHash) => {
      order.push(`sse:${sidHash.slice(0, 8)}`);
      sseKilled.push(sidHash);
    },
  };
  const routes = createLanSessionsRoutes(deps);
  return {
    store,
    order,
    capsKilled,
    proxyKilled,
    sseKilled,
    cleared,
    status: () => status,
    setCurrent: (sidHash) => {
      currentHash = sidHash;
    },
    async call(method, path, body) {
      const res = { headersSent: false, writableEnded: false, destroy: vi.fn() } as unknown as ServerResponse;
      await routes.handle({} as IncomingMessage, res, method, path, {
        listener: "lan",
        ip: IP,
        xPwhOk: () => true,
        csrfOkLan: () => true,
        requireLanSession: async () => ({ userId: 1, sidHash: currentHash, user: "owner" }),
        readJson: async () => body,
        sendJson: (_r, s) => {
          status = s;
          (res as { writableEnded: boolean }).writableEnded = true;
        },
        clearCookie: () => cleared.push("pwh_lan"),
      });
    },
  };
}

describe("lan-sessions revoke propagation", () => {
  it("revoke {id}: emit → delete → emit → SSE, cookie untouched for a non-self target", async () => {
    const r = rig();
    const cur = await addSession(r.store, 999_000, IP);
    const victim = await addSession(r.store, 999_000, "192.168.32.15");
    r.setCurrent(cur);
    const origDelete = r.store.revokeSession.bind(r.store);
    vi.spyOn(r.store, "revokeSession").mockImplementation(async (userId, sidHash, keepIp, opts) => {
      r.order.push(`delete:${sidHash.slice(0, 8)}`);
      return origDelete(userId, sidHash, keepIp, opts);
    });
    await r.call("POST", LAN_SESSIONS_REVOKE_PATH, { id: publicSessionId(victim) });
    expect(r.status()).toBe(200);
    const v = victim.slice(0, 8);
    expect(r.order).toEqual([`emit:${v}`, `delete:${v}`, `emit:${v}`, `sse:${v}`]);
    expect(r.capsKilled).toEqual([victim, victim]);
    expect(r.proxyKilled).toEqual([victim, victim]);
    expect(r.sseKilled).toEqual([victim]);
    expect(r.cleared).toHaveLength(0);
    expect(r.store.sessionsBySidHash.has(victim)).toBe(false);
    expect(r.store.sessionsBySidHash.has(cur)).toBe(true);
  });

  it("self-revoke clears the pwh_lan cookie in addition to the full fan-out", async () => {
    const r = rig();
    const cur = await addSession(r.store, 999_000, IP);
    r.setCurrent(cur);
    await r.call("POST", LAN_SESSIONS_REVOKE_PATH, { id: publicSessionId(cur) });
    expect(r.status()).toBe(200);
    expect(r.capsKilled).toEqual([cur, cur]);
    expect(r.proxyKilled).toEqual([cur, cur]);
    expect(r.sseKilled).toEqual([cur]);
    expect(r.cleared).toEqual(["pwh_lan"]);
    expect(r.store.sessionsBySidHash.has(cur)).toBe(false);
  });

  it("revoke-others: every deleted hash (incl. a concurrent login) dies on all channels; current survives", async () => {
    const r = rig();
    const cur = await addSession(r.store, 999_000, IP);
    const o1 = await addSession(r.store, 999_000, "192.168.32.15");
    const o2 = await addSession(r.store, 999_000, "192.168.32.51");
    r.setCurrent(cur);
    let concurrent = "";
    // a concurrent login lands between the route's pre-list and the delete
    const orig = r.store.deleteSessionsExcept.bind(r.store);
    vi.spyOn(r.store, "deleteSessionsExcept").mockImplementation(async (userId, keepSidHash, opts) => {
      concurrent = await addSession(r.store, 1_000_000, "192.168.32.99");
      return orig(userId, keepSidHash, opts);
    });
    await r.call("POST", LAN_SESSIONS_REVOKE_PATH, { others: true });
    expect(r.status()).toBe(200);
    for (const h of [o1, o2]) {
      // pre-listed hashes: one emit before the delete and one after it
      expect(r.capsKilled.filter((x) => x === h)).toHaveLength(2);
      expect(r.proxyKilled.filter((x) => x === h)).toHaveLength(2);
      expect(r.sseKilled).toContain(h);
      expect(r.store.sessionsBySidHash.has(h)).toBe(false);
    }
    // the concurrent login was not pre-listed (it did not exist yet) but is deleted inside the
    // same store op ⇒ exactly one post-delete emit + SSE revoke, honestly counted
    expect(r.capsKilled.filter((x) => x === concurrent)).toHaveLength(1);
    expect(r.proxyKilled.filter((x) => x === concurrent)).toHaveLength(1);
    expect(r.sseKilled).toContain(concurrent);
    expect(r.store.sessionsBySidHash.has(concurrent)).toBe(false);
    expect(r.capsKilled).not.toContain(cur);
    expect(r.sseKilled).not.toContain(cur);
    expect(r.store.sessionsBySidHash.has(cur)).toBe(true);
  });
});
