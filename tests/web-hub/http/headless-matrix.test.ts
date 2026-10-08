/**
 * web-hub-spawn plan §SP9 验收（#13 硬门槛）: the not-enabled / unavailable response matrix —
 * arch §8.2's "未启用 / 不可用时的响应矩阵" is THE single table every plan/test/acceptance
 * references; this suite asserts it cell by cell (status AND body bytes) through the real HTTP
 * stack:
 *
 * | 情形                        | loopback GET        | loopback POST                  | LAN GET      | LAN POST             | SSE spawns | caps     |
 * | 未启用 (no deps.spawn)      | 401 / 404           | 403 / 401 / 501                | 404 (noauth) | 403 / 401 / 404      | 不发       | 无        |
 * | 启用, lan:"off"             | 正常                | 正常                           | 同未启用     | 同未启用             | LAN 不发   | 有        |
 * | 启用, 平台不支持            | 200 allowed:false   | 403 E_SPAWN_DENIED{platform}   | 按 LAN 策略  | 同左                 | 发(空)     | 有        |
 * | 启用, launcher/persist/reaper| 200 allowed:false  | 503 E_LAUNCHER{reason}         | 同左         | 同左                 | 发         | 有        |
 *
 * `tests/web-hub/http/api.test.ts`'s legacy headless-501 case stays untouched (it pins the
 * not-enabled POST column from its own harness).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeTmp, openSse, postJson, rawRequest, type FakeDeps, type SseConn } from "./helpers.js";
import { lanPostJson, lanRequest, seedLanUser, startLan, type LanHarness } from "./lan-helpers.js";
import { fakeHistory, spawnKit, ALLOWED_POLICY } from "./spawn-kit.js";
import type { SpawnPolicyWire } from "../../../src/web-hub/protocol/spawn.js";
import { fakeClock } from "./lan-helpers.js";

const ID = "matrix-0000-aaaaaaaa";
const BODY = { id: ID, cwd: "/home/u/proj" };

const deniedPolicy = (extra: Partial<SpawnPolicyWire>): SpawnPolicyWire => ({
  ...ALLOWED_POLICY,
  ...extra,
});

describe("matrix row: 未启用 (no deps.spawn) — current behavior, byte-identical", () => {
  let tmp: ReturnType<typeof makeTmp>;
  let deps: FakeDeps;
  let fe: HttpFrontend;
  let port: number;
  let cookie: string;

  beforeEach(async () => {
    tmp = makeTmp("pwh-matrix-off-");
    deps = fakeDeps(tmp.dir);
    fe = createHttpFrontend(deps);
    port = (await fe.listen()).port;
    cookie = await login(port, deps.paths.tokenFile);
  });
  afterEach(async () => {
    await fe.close();
    tmp.cleanup();
  });

  it("loopback GET /api/headless*: 401 unauthed, 404 authed; dirs likewise", async () => {
    expect((await rawRequest(port, { path: "/api/headless" })).status).toBe(401);
    expect((await rawRequest(port, { path: "/api/headless", headers: { Cookie: cookie } })).status).toBe(404);
    expect((await rawRequest(port, { path: "/api/headless/dirs", headers: { Cookie: cookie } })).status).toBe(404);
  });

  it("loopback POST /api/headless*: 403 (no CSRF) / 401 (no auth) / 501 (authed)", async () => {
    // the legacy gate is the LENIENT csrfOk: missing X-PWH trips it (missing Origin alone does not)
    expect(
      (
        await rawRequest(port, {
          method: "POST",
          path: "/api/headless",
          headers: { "Content-Type": "application/json", Cookie: `pwh_sid=x` },
          body: JSON.stringify(BODY),
        })
      ).status,
    ).toBe(403);
    expect((await postJson(port, "/api/headless", BODY)).status).toBe(401);
    const ok = await postJson(port, "/api/headless", BODY, {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${port}`,
    });
    expect(ok.status).toBe(501);
    expect(JSON.parse(ok.body)).toEqual({ error: "E_NOT_IMPLEMENTED" });
  });
});

const harnesses: LanHarness[] = [];
const conns: SseConn[] = [];
afterEach(async () => {
  for (const c of conns.splice(0)) c.close();
  for (const h of harnesses.splice(0)) await h.cleanup();
});

async function lanLogin(h: LanHarness, username = "alice"): Promise<string> {
  seedLanUser(h.store, { id: username === "alice" ? 1 : 2, username, password: "correct-horse-battery" });
  const r = await lanPostJson(h.port, "/api/login", { username, password: "correct-horse-battery" });
  return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
}

describe("matrix rows: 启用 (deps.spawn wired) × LAN policy × availability", () => {
  it("row 'lan:off': LAN face identical to not-enabled (GET 404 noauth; POST 403/401/404), LAN SSE has no spawns frame", async () => {
    const kit = spawnKit({ lan: "off" }, fakeClock());
    const h = await startLan({ spawn: kit.spawn });
    harnesses.push(h);
    // GET: 404, no auth challenge (byte-identical fall-through)
    expect((await lanRequest(h.port, { path: "/api/headless" })).status).toBe(404);
    expect((await lanRequest(h.port, { path: "/api/headless/dirs" })).status).toBe(404);
    // POST: no Origin → 403; good CSRF without cookie → 401; authed → falls through to 404
    expect(
      (
        await lanRequest(h.port, {
          method: "POST",
          path: "/api/headless",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify(BODY),
        })
      ).status,
    ).toBe(403);
    expect((await lanPostJson(h.port, "/api/headless", BODY)).status).toBe(401);
    const cookie = await lanLogin(h);
    const authed = await lanPostJson(h.port, "/api/headless", BODY, { Cookie: cookie });
    expect(authed.status).toBe(404);
    expect(JSON.parse(authed.body)).toEqual({ error: "E_NOT_FOUND" });
    // SSE: no spawns frame on the LAN face
    const sse = await openSse(h.port, { cookie });
    conns.push(sse);
    await sse.waitFor((e) => e.event === "agents");
    await new Promise((r) => setTimeout(r, 100));
    expect(sse.events.some((e) => e.event === "spawns")).toBe(false);

    // default-model plan §3 ④ (D1/A9): the prefs surface obeys the same LAN guard — POST (and
    // GET /api/headless, already covered above) 404 pre-auth on LAN, byte-identical to off,
    // while the loopback face of the SAME hub keeps reading and writing normally.
    expect(
      (
        await lanRequest(h.port, {
          method: "POST",
          path: "/api/headless/prefs",
          headers: { Host: `127.0.0.1:${h.port}`, "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify({ defaultModel: "p1/m" }),
        })
      ).status,
    ).toBe(403); // no cookie + no Origin ⇒ the LAN gate's own CSRF tripped first (pre-dispatch)
    const lanAuthed = await lanPostJson(h.port, "/api/headless/prefs", { defaultModel: "p1/m" }, { Cookie: cookie });
    expect(lanAuthed.status).toBe(404);
    expect(JSON.parse(lanAuthed.body)).toEqual({ error: "E_NOT_FOUND" });

    const tmpLoop = makeTmp("pwh-matrix-prefs-");
    const depsLoop = fakeDeps(tmpLoop.dir);
    depsLoop.spawn = kit.spawn;
    const feLoop = createHttpFrontend(depsLoop);
    const portLoop = (await feLoop.listen()).port;
    try {
      const cookieLoop = await login(portLoop, depsLoop.paths.tokenFile);
      const origin = `http://127.0.0.1:${portLoop}`;
      const write = await postJson(
        portLoop,
        "/api/headless/prefs",
        { defaultModel: "p1/m" },
        { Cookie: cookieLoop, Origin: origin },
      );
      expect(write.status).toBe(200);
      expect(JSON.parse(write.body)).toEqual({ prefs: { defaultModel: "p1/m" } });
      const get = await rawRequest(portLoop, { path: "/api/headless", headers: { Cookie: cookieLoop, "X-PWH": "1" } });
      expect(JSON.parse(get.body).prefs).toEqual({ defaultModel: "p1/m" });
    } finally {
      await feLoop.close();
      tmpLoop.cleanup();
    }
  });

  it.each(["platform", "launcher", "persist", "reaper"] as const)(
    "row '%s' (policy not allowed): loopback GET 200 {allowed:false}; POST %s; SSE still sends spawns",
    async (reason) => {
      const kit = spawnKit({}, fakeClock());
      kit.supervisor.setPolicy(
        deniedPolicy({ allowed: false, reason, ...(reason === "platform" ? { detail: "not linux" } : {}) }),
      );
      const tmp = makeTmp("pwh-matrix-deny-");
      const deps = fakeDeps(tmp.dir);
      deps.spawn = kit.spawn;
      const fe = createHttpFrontend(deps);
      const port = (await fe.listen()).port;
      try {
        const cookie = await login(port, deps.paths.tokenFile);
        const origin = `http://127.0.0.1:${port}`;
        const get = await rawRequest(port, { path: "/api/headless", headers: { Cookie: cookie, "X-PWH": "1" } });
        expect(get.status).toBe(200);
        expect(JSON.parse(get.body).policy).toMatchObject({ allowed: false, reason });

        const post = await postJson(port, "/api/headless", BODY, { Cookie: cookie, Origin: origin });
        if (reason === "platform") {
          expect(post.status).toBe(403);
          expect(JSON.parse(post.body)).toEqual({ error: "E_SPAWN_DENIED", reason: "platform", detail: "not linux" });
        } else {
          expect(post.status).toBe(503);
          expect(JSON.parse(post.body)).toEqual({ error: "E_LAUNCHER", reason });
        }
        // SSE: spawns frame is still sent (empty list — the supervisor owns the records)
        const sse = await openSse(port, { cookie });
        conns.push(sse);
        const spawns = await sse.waitFor((e) => e.event === "spawns");
        expect(spawns.data).toMatchObject({ items: [], active: 0, max: 4 });
        sse.close();
      } finally {
        await fe.close();
        tmp.cleanup();
      }
    },
  );

  it("row 'enabled + allowed': loopback GET 200 / POST 202 — the healthy baseline (caps passthrough untouched)", async () => {
    const kit = spawnKit({}, fakeClock());
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
    const tmp = makeTmp("pwh-matrix-on-");
    const deps = fakeDeps(tmp.dir);
    const proto = deps.info().proto;
    deps.info = () => ({
      version: "9.9.9",
      buildId: "b1",
      pid: process.pid,
      startedAt: 1,
      proto,
      caps: ["dialog.v1", "spawn.v1"],
    });
    deps.spawn = kit.spawn;
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    try {
      const cookie = await login(port, deps.paths.tokenFile);
      const origin = `http://127.0.0.1:${port}`;
      const get = await rawRequest(port, { path: "/api/headless", headers: { Cookie: cookie, "X-PWH": "1" } });
      expect(get.status).toBe(200);
      expect(JSON.parse(get.body).policy.allowed).toBe(true);
      const post = await postJson(port, "/api/headless", BODY, { Cookie: cookie, Origin: origin });
      expect(post.status).toBe(202);
      // caps flow through the hub frame verbatim (SP10 owns actually adding spawn.v1)
      const sse = await openSse(port, { cookie });
      conns.push(sse);
      const hub = await sse.waitFor((e) => e.event === "hub");
      expect(hub.data.caps).toEqual(["dialog.v1", "spawn.v1"]);
      const spawns = await sse.waitFor((e) => e.event === "spawns");
      // the fake supervisor auto-owns the record created by the POST above (kit mirrors the
      // real "202 ⇔ 有记录" contract) — the snapshot reflects it with the Public projection only
      expect(spawns.data).toMatchObject({ active: 1, max: 4 });
      expect(spawns.data.items).toHaveLength(1);
      expect("cwd" in spawns.data.items[0]).toBe(false);
      sse.close();
    } finally {
      await fe.close();
      tmp.cleanup();
    }
  });
});

describe("history rows (session-history plan §5, byte-identical when off/unavailable)", () => {
  it("row ①: not enabled — GET /api/headless/history is byte-identical to GET /api/headless/dirs", async () => {
    const tmp = makeTmp("pwh-matrix-hist-off-");
    const deps = fakeDeps(tmp.dir);
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    try {
      const cookie = await login(port, deps.paths.tokenFile);
      const history = await rawRequest(port, {
        path: "/api/headless/history",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      const dirs = await rawRequest(port, { path: "/api/headless/dirs", headers: { Cookie: cookie, "X-PWH": "1" } });
      expect(history.status).toBe(dirs.status);
      expect(history.body).toBe(dirs.body);
      // unauthed too (401 before dispatch either way)
      const historyNoAuth = await rawRequest(port, { path: "/api/headless/history" });
      const dirsNoAuth = await rawRequest(port, { path: "/api/headless/dirs" });
      expect(historyNoAuth.status).toBe(dirsNoAuth.status);
    } finally {
      await fe.close();
      tmp.cleanup();
    }
  });

  it("row ②: enabled but history defaults off — GET 404 byte-identical to /zzz; session POST byte-identical to a bogus-field POST", async () => {
    const kit = spawnKit({}, fakeClock());
    const tmp = makeTmp("pwh-matrix-hist-default-");
    const deps = fakeDeps(tmp.dir);
    deps.spawn = kit.spawn;
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    try {
      const cookie = await login(port, deps.paths.tokenFile);
      const origin = `http://127.0.0.1:${port}`;
      const history = await rawRequest(port, {
        path: "/api/headless/history",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      const zzz = await rawRequest(port, { path: "/api/headless/zzz", headers: { Cookie: cookie, "X-PWH": "1" } });
      expect(history.status).toBe(404);
      expect(history.status).toBe(zzz.status);
      expect(history.body).toBe(zzz.body);
      const sessionPost = await postJson(
        port,
        "/api/headless",
        { id: "histmx00aaaaaaaaaaaa", cwd: "/home/u/proj", session: { key: "dir/a.jsonl", id: "sess-1" } },
        { Cookie: cookie, Origin: origin },
      );
      const bogusPost = await postJson(
        port,
        "/api/headless",
        { id: "histmx00aaaaaaaaaaaa", cwd: "/home/u/proj", bogus: true },
        { Cookie: cookie, Origin: origin },
      );
      expect(sessionPost.status).toBe(bogusPost.status);
      expect(sessionPost.body).toBe(bogusPost.body);
    } finally {
      await fe.close();
      tmp.cleanup();
    }
  });

  it("row ③: history:true but no service injected — same as row ②", async () => {
    const kit = spawnKit({ history: true }, fakeClock());
    const tmp = makeTmp("pwh-matrix-hist-noservice-");
    const deps = fakeDeps(tmp.dir);
    deps.spawn = kit.spawn;
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    try {
      const cookie = await login(port, deps.paths.tokenFile);
      const history = await rawRequest(port, {
        path: "/api/headless/history",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      const zzz = await rawRequest(port, { path: "/api/headless/zzz", headers: { Cookie: cookie, "X-PWH": "1" } });
      expect(history.status).toBe(404);
      expect(history.body).toBe(zzz.body);
    } finally {
      await fe.close();
      tmp.cleanup();
    }
  });

  it('row ④: lan:"off" — LAN GET /api/headless/history returns 404', async () => {
    const kit = spawnKit({ history: true, lan: "off" }, fakeClock(), undefined, fakeHistory());
    const h = await startLan({ spawn: kit.spawn });
    try {
      const r = await lanRequest(h.port, { path: "/api/headless/history" });
      expect(r.status).toBe(404);
    } finally {
      await h.cleanup();
    }
  });

  it("row ⑤: history on (service injected) — missing X-PWH ⇒ 403, unauthed ⇒ 401", async () => {
    const kit = spawnKit({ history: true }, fakeClock(), undefined, fakeHistory());
    const tmp = makeTmp("pwh-matrix-hist-on-");
    const deps = fakeDeps(tmp.dir);
    deps.spawn = kit.spawn;
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    try {
      const cookie = await login(port, deps.paths.tokenFile);
      const noCsrf = await rawRequest(port, { path: "/api/headless/history", headers: { Cookie: cookie } });
      expect(noCsrf.status).toBe(403);
      const noAuth = await rawRequest(port, { path: "/api/headless/history", headers: { "X-PWH": "1" } });
      expect(noAuth.status).toBe(401);
    } finally {
      await fe.close();
      tmp.cleanup();
    }
  });
});
