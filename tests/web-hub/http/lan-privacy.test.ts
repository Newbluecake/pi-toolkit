/**
 * web-hub-privacy plan v2.1 (P1 测试锚点, LAN listener): `POST /api/privacy/verify` (LAN-only)
 * and `POST /api/privacy/lock` through the real LAN stack (`startLan` harness, REAL privacy
 * store + routes + the extracted `verifyPassword` over the harness's SAME login limiter):
 *
 * - verify: wrong password ⇒ `200 {ok:false}` — NEVER 401 (401 is session-lost semantics);
 *   no session ⇒ 401; CSRF ⇒ 403; body >4 KiB ⇒ 413 (LAN_LOGIN_BODY_BYTES).
 * - 「limiter 共享，只记 fail」: verify failures count toward the SAME per-IP login backoff
 *   (a later LOGIN is locked out by verify failures), and a successful verify does NOT call
 *   `limiter.succeed()` (复审 N-3 — it must not reset an accumulating login backoff).
 * - lock on LAN: `locked:true` needs no password; `locked:false` requires an inline password,
 *   wrong ⇒ 200 {ok:false} (mark stays), right ⇒ 200 {ok:true} (mark drops); sessionId
 *   mismatch ⇒ 409 E_SESSION_CHANGED.
 * - 对等/缺省: a harness WITHOUT `privacy` wired 404s both paths (byte-identical not-enabled).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RegistryView } from "../../../src/web-hub/hub/ports.js";
import { lanPostJson, seedLanUser, startLan, type LanHarness } from "./lan-helpers.js";
import { makeAgent } from "./helpers.js";

const harnesses: LanHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});

const PW = "correct-horse-battery";

function registryWithSession(): RegistryView {
  const agents = new Map([
    [
      "k1",
      makeAgent("k1", { session: { sessionId: "sess-1", cwd: "/tmp/wa", reason: "new", leafId: null, mode: "tui" } }),
    ],
  ]);
  return { list: () => [...agents.values()], get: (k) => agents.get(k) };
}

async function start(privacy: boolean): Promise<LanHarness> {
  const h = await startLan({ privacy, registry: registryWithSession() });
  harnesses.push(h);
  return h;
}

async function loginAs(h: LanHarness, username: string, id: number): Promise<string> {
  seedLanUser(h.store, { id, username, password: PW });
  const r = await lanPostJson(h.port, "/api/login", { username, password: PW });
  expect(r.status).toBe(200);
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

const verify = (h: LanHarness, password: string, cookie: string) =>
  lanPostJson(h.port, "/api/privacy/verify", { password }, { Cookie: cookie });
const lock = (h: LanHarness, body: unknown, cookie: string) =>
  lanPostJson(h.port, "/api/privacy/lock", body, { Cookie: cookie });

describe("LAN POST /api/privacy/verify", () => {
  it("right password ⇒ 200 {ok:true}; wrong password ⇒ 200 {ok:false} (NEVER 401)", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    const good = await verify(h, PW, cookie);
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body)).toEqual({ ok: true });
    const bad = await verify(h, "nope", cookie);
    expect(bad.status).toBe(200);
    expect(JSON.parse(bad.body)).toEqual({ ok: false });
  });

  it("no LAN session ⇒ 401 E_AUTH; bad CSRF ⇒ 403", async () => {
    const h = await start(true);
    await loginAs(h, "alice", 1);
    const anon = await verify(h, PW, "");
    expect(anon.status).toBe(401);
    const cookie = await loginAs(h, "alice", 1);
    const noCsrf = await lanPostJson(h.port, "/api/privacy/verify", { password: PW }, { Cookie: cookie, "X-PWH": "" });
    expect(noCsrf.status).toBe(403);
  });

  it("body over 4 KiB ⇒ 413 (LAN_LOGIN_BODY_BYTES)", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    const r = await verify(h, "x".repeat(5_000), cookie);
    expect(r.status).toBe(413);
  });

  it("「limiter 共享」: 6 failed verifies lock out the SAME IP's login too (429 E_LOCKED + Retry-After)", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    // 6 free failures (same cadence as the login pipeline's F=5 + 1), the 7th locks.
    for (let i = 0; i < 6; i++) {
      const r = await verify(h, "wrong", cookie);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ ok: false });
    }
    const seventh = await verify(h, "wrong", cookie);
    expect(seventh.status).toBe(429);
    expect(JSON.parse(seventh.body)).toMatchObject({ error: "E_LOCKED" });
    expect(seventh.headers["retry-after"]).toBe("30");
    // the SAME backoff now gates the login endpoint (one limiter, one credential strength)
    const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: PW });
    expect(login.status).toBe(429);
    expect(login.headers["retry-after"]).toBe("30");
  });

  it("「只记 fail」(unit pin): verifyPassword shares the limiter but a success never calls succeed()", async () => {
    // Direct call against a spying limiter (the HTTP-level integration above proves the wiring;
    // this pins the fail-only accounting — 复审 N-3 — without the admission queue's clock games).
    const { createLoginLimiter } = await import("../../../src/web-hub/hub/ratelimit.js");
    const { fakeKdf, fakeKdfAdmission, fakeLanStore } = await import("../contract/fakes.js");
    const { verifyPassword } = await import("../../../src/web-hub/hub/lan-auth.js");
    const store = fakeLanStore();
    seedLanUser(store, { id: 1, username: "alice", password: PW });
    const limiter = createLoginLimiter({ now: () => Date.now() });
    const calls: string[] = [];
    const spy = {
      admit: (ip: string) => {
        calls.push(`admit:${ip}`);
        return limiter.admit(ip);
      },
      fail: (ip: string) => {
        calls.push(`fail:${ip}`);
        limiter.fail(ip);
      },
      succeed: (ip: string) => {
        calls.push(`succeed:${ip}`);
        limiter.succeed(ip);
      },
      unlock: () => limiter.unlock(),
      isFresh: (ip: string) => limiter.isFresh(ip),
    };
    const deps = { store, kdf: fakeKdf(), limiter: spy, admission: fakeKdfAdmission() };
    const ctx = { clientIp: "10.0.0.9" };
    const bad = await verifyPassword(ctx, 1, "wrong", deps);
    expect(bad).toEqual({ status: 200, ok: false });
    const good = await verifyPassword(ctx, 1, PW, deps);
    expect(good).toEqual({ status: 200, ok: true });
    // fail counted, success NEVER reset: exactly one fail call, zero succeed calls.
    expect(calls.filter((c) => c === "fail:10.0.0.9")).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("succeed"))).toBe(false);
    // unknown userId (session's user vanished) — dummy KDF run, ok:false, still fail-counted
    const ghost = await verifyPassword(ctx, 999, PW, deps);
    expect(ghost).toEqual({ status: 200, ok: false });
    expect(calls.filter((c) => c === "fail:10.0.0.9")).toHaveLength(2);
  });
});

describe("LAN POST /api/privacy/lock", () => {
  it("locked:true needs no password; the mark lands and is visible to the store", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    const r = await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: true }, cookie);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(h.privacyStore?.isLocked("sess-1")).toBe(true);
  });

  it("locked:false WITHOUT password ⇒ 400 (LAN is the server-side enforcement point, v2 评审 #2)", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: true }, cookie);
    const r = await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: false }, cookie);
    expect(r.status).toBe(400);
    expect(h.privacyStore?.isLocked("sess-1")).toBe(true); // mark untouched
  });

  it("locked:false with a WRONG password ⇒ 200 {ok:false} (never 401), mark stays", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: true }, cookie);
    const r = await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: false, password: "nope" }, cookie);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: false });
    expect(h.privacyStore?.isLocked("sess-1")).toBe(true);
  });

  it("locked:false with the RIGHT password ⇒ 200 {ok:true}, mark drops", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: true }, cookie);
    const r = await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: false, password: PW }, cookie);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(h.privacyStore?.isLocked("sess-1")).toBe(false);
  });

  it("sessionId mismatch ⇒ 409 E_SESSION_CHANGED (same code as loopback — 两 listener 对等)", async () => {
    const h = await start(true);
    const cookie = await loginAs(h, "alice", 1);
    const r = await lock(h, { agentKey: "k1", sessionId: "sess-old", locked: true }, cookie);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_SESSION_CHANGED" });
    expect(h.privacyStore?.locked()).toEqual([]);
  });
});

describe("feature off (harness without privacy)", () => {
  it("both /api/privacy/* paths 404 on LAN — byte-identical to not-enabled", async () => {
    const h = await start(false);
    const cookie = await loginAs(h, "alice", 1);
    expect((await verify(h, PW, cookie)).status).toBe(404);
    expect((await lock(h, { agentKey: "k1", sessionId: "sess-1", locked: true }, cookie)).status).toBe(404);
  });
});
