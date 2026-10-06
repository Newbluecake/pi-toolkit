/**
 * web-hub-spawn plan §SP9 验收: `/api/headless*` on the LOOPBACK listener — the real
 * `createSpawnRoutes` wired through the real `createHttpFrontend` HTTP stack (repo style:
 * `tests/web-hub/http/`), with the spawn-kit fakes for supervisor/dirs/first-prompt.
 *
 * Covers: CSRF quartet, GET X-PWH, 401, the logout race (second authorize), the confirm flow,
 * known-dir loopback confirmation exemption, idempotency (dup / digest conflict / confirm-only
 * delta), 429+Retry-After, E_LIMIT trio, E_LAUNCHER reason table, body caps (52 KiB body ⇒ 413
 * + connection close; 48 KiB+1 firstPrompt ⇒ 400), `dirs?path=` ⇒ 400, stop 404/202/idempotent,
 * and the first-prompt body never leaking into any response or audit line.
 *
 * The not-enabled matrix lives in `headless-matrix.test.ts`; LAN-scope/visibility in
 * `lan-headless.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeClock, type FakeClock } from "./lan-helpers.js";
import { fakeDeps, login, makeTmp, postJson, rawRequest, type FakeDeps, type RawResponse } from "./helpers.js";
import { spawnKit, type SpawnKit } from "./spawn-kit.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let kit: SpawnKit;
let clock: FakeClock;
const closers: Array<() => void> = [];

beforeEach(async () => {
  tmp = makeTmp("pwh-headless-");
  deps = fakeDeps(tmp.dir);
  clock = fakeClock();
  kit = spawnKit({}, clock);
  deps.spawn = kit.spawn;
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
});

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await fe.close();
  tmp.cleanup();
});

const ID = "reqid-0000-aaaaaaaa"; // SPAWN_ID_RE-shaped browser id
const ID2 = "reqid-0000-bbbbbbbb";
const BODY = { id: ID, cwd: "/home/u/proj" };
const ORIGIN = (p: number): string => `http://127.0.0.1:${p}`;

/** POST with full strict-CSRF headers + cookie (the happy-path default). */
function spawnPost(body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return postJson(port, "/api/headless", body, { Cookie: cookie, Origin: ORIGIN(port), ...headers });
}

function headlessGet(path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return rawRequest(port, { path, headers: { Cookie: cookie, "X-PWH": "1", ...headers } });
}

/** POST whose body arrives in two tranches (no Content-Length) — parks the body read so another
 *  request (e.g. logout) can land between the first and second authorize. */
function parkedSpawnPost(body: string, midway: () => Promise<unknown>): Promise<RawResponse> {
  return parkedPost("/api/headless", body, midway);
}

/** The parked-body trick for an arbitrary path (the prefs race test below). */
function parkedPost(path: string, body: string, midway: () => Promise<unknown>): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/json",
          "X-PWH": "1",
          Cookie: cookie,
          Origin: ORIGIN(port),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body.slice(0, 5));
    void Promise.resolve(midway()).then(() => req.end(body.slice(5)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GET /api/headless", () => {
  it("missing X-PWH ⇒ 403 E_CSRF", async () => {
    const res = await rawRequest(port, { path: "/api/headless", headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "E_CSRF" });
  });

  it("unauthenticated ⇒ 401; authed ⇒ 200 {policy, items} with loopback owner projection", async () => {
    expect((await headlessGet("/api/headless", { Cookie: "pwh_sid=bogus" })).status).toBe(401);
    kit.supervisor.seedRecord({
      spawnId: "s1",
      cwd: "/home/u/proj",
      firstPrompt: { state: "pending", textLen: 12 },
      owner: { listener: "loopback", reqId: ID },
    });
    kit.firstPrompt.setView("s1", { state: "delivered", textLen: 12, attempts: 1 });
    const res = await headlessGet("/api/headless");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.policy).toMatchObject({ allowed: true, confirm: "unknown-dir", scope: "known", max: 4 });
    expect(parsed.items).toHaveLength(1);
    // loopback principal owns every record (arch §6.0): owner fields are present
    expect(parsed.items[0]).toMatchObject({ spawnId: "s1", cwd: "/home/u/proj", cwdLabel: "proj" });
    expect(parsed.items[0].firstPrompt).toEqual({ state: "delivered", textLen: 12, attempts: 1 });
  });

  it("read bucket (10/1s) 429s with Retry-After", async () => {
    for (let i = 0; i < 10; i++) await headlessGet("/api/headless");
    const res = await headlessGet("/api/headless");
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: "E_RATE" });
    expect(res.headers["retry-after"]).toBe("1");
  });
});

describe("GET /api/headless/dirs", () => {
  it("returns the dirs service's recent list (desc, ≤50) and partial flag", async () => {
    kit.dirs.knownEntries = [
      { cwd: "/home/u/a", label: "a", at: 2 },
      { cwd: "/home/u/b", label: "b", at: 1 },
    ];
    kit.dirs.knownPartial = true;
    const res = await headlessGet("/api/headless/dirs");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      recent: [
        { cwd: "/home/u/a", label: "a", at: 2 },
        { cwd: "/home/u/b", label: "b", at: 1 },
      ],
      partial: true,
    });
  });

  it("S1 has no browse: ?path= ⇒ 400 E_DIR{reason:browse-unavailable}", async () => {
    const res = await headlessGet("/api/headless/dirs?path=/tmp");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "E_DIR", reason: "browse-unavailable" });
  });
});

describe("POST /api/headless — gates before the body", () => {
  it.each([
    ["cross-origin Origin", { Origin: "http://evil.example" }],
    ["Sec-Fetch-Site: cross-site", { "Sec-Fetch-Site": "cross-site" }],
  ])("CSRF: %s ⇒ 403 E_CSRF, no record, no start", async (_name, headers) => {
    const res = await spawnPost(BODY, headers);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "E_CSRF" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("CSRF: missing Origin ⇒ 403 (strictCsrfOk requires it, unlike the lenient loopback csrfOk)", async () => {
    const res = await postJson(port, "/api/headless", BODY, { Cookie: cookie }); // spawnPost defaults Origin in — go bare
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "E_CSRF" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("CSRF: missing X-PWH ⇒ 403", async () => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/headless",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN(port) },
      body: JSON.stringify(BODY),
    });
    expect(res.status).toBe(403);
  });

  it("unauthenticated ⇒ 401 E_AUTH (auth after CSRF)", async () => {
    const res = await postJson(port, "/api/headless", BODY, { Origin: ORIGIN(port) });
    expect(res.status).toBe(401);
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("policy not allowed: platform ⇒ 403 E_SPAWN_DENIED; launcher-class ⇒ 503 E_LAUNCHER", async () => {
    kit.supervisor.setPolicy({
      allowed: false,
      reason: "platform",
      detail: "not linux",
      confirm: "unknown-dir",
      scope: "known",
      max: 4,
      maxPerPrincipal: 2,
      active: 0,
      activeMine: 0,
      registerTimeoutS: 30,
      maxLifetimeMinutes: 720,
    });
    const denied = await spawnPost(BODY);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body)).toEqual({ error: "E_SPAWN_DENIED", reason: "platform", detail: "not linux" });

    kit.supervisor.setPolicy({
      allowed: false,
      reason: "breaker",
      retryAfterS: 600,
      confirm: "unknown-dir",
      scope: "known",
      max: 4,
      maxPerPrincipal: 2,
      active: 0,
      activeMine: 0,
      registerTimeoutS: 30,
      maxLifetimeMinutes: 720,
    });
    const broken = await spawnPost({ ...BODY, id: ID2 });
    expect(broken.status).toBe(503);
    expect(JSON.parse(broken.body)).toEqual({ error: "E_LAUNCHER", reason: "breaker", retryAfterS: 600 });
    expect(broken.headers["retry-after"]).toBe("600");
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });
});

describe("POST /api/headless — body caps", () => {
  it("declared body above SPAWN_BODY_MAX (52 KiB) ⇒ 413 and the connection closes", async () => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/headless",
      headers: {
        "Content-Type": "application/json",
        "X-PWH": "1",
        Cookie: cookie,
        Origin: ORIGIN(port),
      },
      body: "x".repeat(52 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_BAD_REQUEST" });
    expect(String(res.headers["connection"] ?? "").toLowerCase()).toBe("close");
  });

  it("firstPrompt.text passing the UTF-16 prefilter but exceeding 48 KiB UTF-8 bytes ⇒ 400", async () => {
    // 20 000 中 chars = 60 000 UTF-8 bytes but only 20 000 UTF-16 units — only the exact byte
    // re-check catches it (the ASCII +1 prefilter case is pinned in protocol/spawn.test.ts)
    const res = await spawnPost({ ...BODY, firstPrompt: { text: "中".repeat(17_000) } }); // 51 000 bytes < 52 KiB body cap
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_BAD_REQUEST", message: "first prompt too large" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("schema violations ⇒ 400 (unknown field, bad id)", async () => {
    expect((await spawnPost({ ...BODY, model: "x" })).status).toBe(400);
    expect((await spawnPost({ ...BODY, id: "short" })).status).toBe(400);
    expect((await spawnPost({ id: ID })).status).toBe(400); // cwd required
  });
});

describe("POST /api/headless — confirm flow (arch §6.3/D8)", () => {
  it("unknown dir on loopback: 409 with resolvedCwd → confirm+expectCwd 202; 409s never write the LRU", async () => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/srv/real/proj", dev: 1, ino: 2, known: false });
    // step 1 — no confirm: 409 with the RESOLVED cwd
    const first = await spawnPost(BODY);
    expect(first.status).toBe(409);
    expect(JSON.parse(first.body)).toEqual({
      error: "E_CONFIRM_REQUIRED",
      resolvedCwd: "/srv/real/proj",
      reason: "unknown-dir",
    });
    expect(kit.supervisor.startCalls).toHaveLength(0);
    // step 1b — confirm:true but a STALE expectCwd is not bound (D8): still 409, reason changed
    const stale = await spawnPost({ ...BODY, confirm: true, expectCwd: "/somewhere/else" });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ resolvedCwd: "/srv/real/proj", reason: "changed" });
    // the 409 wrote no LRU entry: the same id with a DIFFERENT admissible cwd is not a digest conflict
    kit.dirs.setAdmitResult({ ok: true, realpath: "/srv/other", dev: 1, ino: 3, known: false });
    const other = await spawnPost({ ...BODY, id: ID2, cwd: "/srv/other-x", confirm: true, expectCwd: "/srv/other" });
    expect(other.status).toBe(202);
    // step 2 — the real confirm lands 202 (admit back to the original dir)
    kit.dirs.setAdmitResult({ ok: true, realpath: "/srv/real/proj", dev: 1, ino: 2, known: false });
    const confirmed = await spawnPost({ ...BODY, confirm: true, expectCwd: "/srv/real/proj" });
    expect(confirmed.status).toBe(202);
    expect(JSON.parse(confirmed.body)).toMatchObject({ state: "starting", cwd: "/srv/real/proj" });
    expect(kit.supervisor.startCalls).toHaveLength(2); // one per distinct intent (no LRU from 409s)
  });

  it("known dir on loopback needs NO confirmation", async () => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
    const res = await spawnPost(BODY);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toMatchObject({
      spawnId: kit.supervisor.startCalls[0]!.spawnId,
      state: "starting",
      cwd: "/home/u/proj",
    });
  });

  it("admit rejections map 1:1 onto 400 E_DIR{reason}", async () => {
    for (const reason of ["not-found", "not-dir", "no-access", "not-allowed", "relative", "too-long"] as const) {
      kit.dirs.setAdmitResult({ ok: false, reason });
      const res = await spawnPost({
        ...BODY,
        id: `reqid-0000-c${reason.length}${reason.slice(0, 3)}`.padEnd(20, "x").slice(0, 20),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "E_DIR", reason });
    }
  });
});

describe("POST /api/headless — idempotency (plan §SP9)", () => {
  beforeEach(() => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
  });

  it("same id + same intent ⇒ 202 dup:true on the SAME record, start called once; no rate token burned", async () => {
    const first = await spawnPost(BODY);
    expect(first.status).toBe(202);
    const second = await spawnPost(BODY);
    expect(second.status).toBe(202);
    const b1 = JSON.parse(first.body);
    const b2 = JSON.parse(second.body);
    expect(b2.dup).toBe(true);
    expect(b2.spawnId).toBe(b1.spawnId);
    expect(b2.cwd).toBe("/home/u/proj");
    expect(kit.supervisor.startCalls).toHaveLength(1);
    // dup hit does not spend a rate token: with ratePerMinute=1 (below) this matters; here just
    // assert the start count once more after a third replay
    await spawnPost(BODY);
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("same id + different intent ⇒ 409 E_BAD_REQUEST", async () => {
    await spawnPost(BODY);
    const res = await spawnPost({ ...BODY, cwd: "/home/u/other" });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_BAD_REQUEST" });
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("a confirm-only delta is the SAME intent (confirm/expectCwd excluded from the digest)", async () => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/srv/x", dev: 1, ino: 9, known: false });
    await spawnPost(BODY); // 409 confirm required
    const confirmed = await spawnPost({ ...BODY, confirm: true, expectCwd: "/srv/x" }); // 202, LRU written
    expect(confirmed.status).toBe(202);
    const replay = await spawnPost({ ...BODY, confirm: true, expectCwd: "/srv/x" }); // dup
    expect(replay.status).toBe(202);
    expect(JSON.parse(replay.body).dup).toBe(true);
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("a firstPrompt change is a DIFFERENT intent; text rides to the forwarder, never the reply", async () => {
    await spawnPost({ ...BODY, firstPrompt: { text: "hello world", deliver: "steer" } });
    const res = await spawnPost({ ...BODY, firstPrompt: { text: "hello world!!" } });
    expect(res.status).toBe(409); // digest conflict
    expect(res.body).not.toContain("hello world");
    expect(kit.firstPrompt.accepts).toHaveLength(1);
    expect(kit.firstPrompt.accepts[0]).toMatchObject({ text: "hello world", deliver: "steer" });
    expect(kit.firstPrompt.accepts[0]!.deadlineAt).toBeGreaterThan(0);
  });

  it("LRU entries expire after 10 minutes (fresh spawnId for the same id)", async () => {
    const first = await spawnPost(BODY);
    clock.advance(60_001 * 10 + 1);
    const second = await spawnPost(BODY);
    expect(JSON.parse(second.body).dup).toBeUndefined();
    expect(JSON.parse(second.body).spawnId).not.toBe(JSON.parse(first.body).spawnId);
    expect(kit.supervisor.startCalls).toHaveLength(2);
  });

  it("deliver defaults to followUp (a fresh session has no turn to steer)", async () => {
    await spawnPost({ ...BODY, firstPrompt: { text: "hi" } });
    expect(kit.firstPrompt.accepts[0]!.deliver).toBe("followUp");
    const start = kit.supervisor.startCalls[0]!;
    expect(start.firstPrompt).toEqual({ textLen: 2, deliver: "followUp" });
  });

  it("web-hub-delete-session plan v2 §2.5 (r1 #3, B-fork): dup LRU hit but the record was deleted ⇒ 409 spawn-gone, no fork, no new record, creation token untouched", async () => {
    const first = await spawnPost(BODY);
    expect(first.status).toBe(202);
    const spawnId = JSON.parse(first.body).spawnId as string;
    // simulate the record having been deleted (web-hub-delete-session supervisor.remove()) —
    // the in-memory map outliving every LRU entry is exactly the scenario this guards against.
    kit.supervisor.recordsOut.length = 0;
    const replay = await spawnPost(BODY);
    expect(replay.status).toBe(409);
    expect(JSON.parse(replay.body)).toEqual({ error: "E_BAD_REQUEST", reason: "spawn-gone" });
    expect(kit.supervisor.startCalls).toHaveLength(1); // no fresh fork
    expect(kit.supervisor.recordsOut).toHaveLength(0); // no new record appeared
    // a different digest for the SAME id is still a normal digest conflict, unaffected
    const differentIntent = await spawnPost({ ...BODY, cwd: "/home/u/other" });
    expect(differentIntent.status).toBe(409);
    expect(JSON.parse(differentIntent.body)).toMatchObject({ error: "E_BAD_REQUEST" });
    expect(JSON.parse(differentIntent.body).reason).toBeUndefined();
    void spawnId;
  });
});

describe("POST /api/headless — rate + supervisor results", () => {
  it("creation bucket 429s with Retry-After once exhausted (fresh frontend: capacity is captured at construction)", async () => {
    const slowKit = spawnKit({ ratePerMinute: 1 }, clock);
    const deps2 = fakeDeps(tmp.dir);
    deps2.spawn = slowKit.spawn;
    const fe2 = createHttpFrontend(deps2);
    const port2 = (await fe2.listen()).port;
    try {
      const cookie2 = await login(port2, deps2.paths.tokenFile);
      slowKit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
      const post = (body: unknown): Promise<RawResponse> =>
        postJson(port2, "/api/headless", body, { Cookie: cookie2, Origin: ORIGIN(port2) });
      expect((await post(BODY)).status).toBe(202);
      const res = await post({ ...BODY, id: ID2 });
      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBe("60");
      // the dup exemption: replaying the ORIGINAL id still 202s without spending a token
      expect((await post(BODY)).status).toBe(202);
    } finally {
      await fe2.close();
    }
  });

  it.each([
    ["global", 4, 4],
    ["principal", 2, 2],
    ["starting", 2, 2],
  ] as const)("E_LIMIT{limit:%s} ⇒ 409 with limit/active/max", async (limit, active, max) => {
    kit.supervisor.setStartResult({ ok: false, code: "E_LIMIT", limit, active, max });
    const res = await spawnPost(BODY);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: "E_LIMIT", limit, active, max });
  });

  it.each([
    ["persist", undefined],
    ["reaper", undefined],
    ["missing", undefined],
    ["changed", undefined],
    ["cooldown", 7],
  ] as const)("E_LAUNCHER{reason:%s} ⇒ 503 (+Retry-After when retryAfterS)", async (reason, retryAfterS) => {
    kit.supervisor.setStartResult({
      ok: false,
      code: "E_LAUNCHER",
      reason,
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    });
    const res = await spawnPost(BODY);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: "E_LAUNCHER",
      reason,
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
    });
    if (retryAfterS !== undefined) expect(res.headers["retry-after"]).toBe(String(retryAfterS));
    else expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("logout racing the body read: second authorize 401s and supervisor.start is never called", async () => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
    const res = await parkedSpawnPost(JSON.stringify(BODY), async () => {
      await sleep(50);
      await postJson(port, "/api/logout", {}, { Cookie: cookie, Origin: ORIGIN(port) });
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "E_AUTH" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });
});

describe("POST /api/headless/:id/stop", () => {
  const STOP_ID = "stopid-0000-aaaaaaa";

  it("CSRF/auth/rate gates first, then 404 for an unknown spawnId", async () => {
    expect((await spawnPost({})).status).toBe(400); // sanity: not accidentially routed
    kit.supervisor.setStopResult({ ok: false, code: "E_NOT_FOUND" });
    const res = await postJson(port, `/api/headless/${STOP_ID}/stop`, {}, { Cookie: cookie, Origin: ORIGIN(port) });
    expect(res.status).toBe(404);
    expect(kit.supervisor.stopCalls).toEqual([{ spawnId: STOP_ID, force: false }]);
  });

  it("202 {state}; force threads through; idempotent for terminal records", async () => {
    kit.supervisor.setStopResult({ ok: true, state: "stopping" });
    const res = await postJson(
      port,
      `/api/headless/${STOP_ID}/stop`,
      { force: true },
      { Cookie: cookie, Origin: ORIGIN(port) },
    );
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ state: "stopping" });
    expect(kit.supervisor.stopCalls).toEqual([{ spawnId: STOP_ID, force: true }]);

    kit.supervisor.setStopResult({ ok: true, state: "exited" });
    const again = await postJson(port, `/api/headless/${STOP_ID}/stop`, {}, { Cookie: cookie, Origin: ORIGIN(port) });
    expect(again.status).toBe(202);
    expect(JSON.parse(again.body)).toEqual({ state: "exited" });
  });

  it("empty body is fine; stop bucket 429s at 10 per 2s", async () => {
    kit.supervisor.setStopResult({ ok: true, state: "stopping" });
    const raw = await rawRequest(port, {
      method: "POST",
      path: `/api/headless/${STOP_ID}/stop`,
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: cookie, Origin: ORIGIN(port) },
    });
    expect(raw.status).toBe(202);
    for (let i = 0; i < 9; i++)
      await postJson(port, `/api/headless/${STOP_ID}/stop`, {}, { Cookie: cookie, Origin: ORIGIN(port) });
    const burst = await postJson(port, `/api/headless/${STOP_ID}/stop`, {}, { Cookie: cookie, Origin: ORIGIN(port) });
    expect(burst.status).toBe(429);
  });
});

describe("audit lines (arch §6.6 — rejects by the routes, request-phase on 202)", () => {
  it("reject phases carry endpoint/listener/ip/code; 202 carries the realpath cwd + dup flag", async () => {
    await spawnPost(BODY, { Origin: "http://evil.example" }); // 403 → reject line
    for (let i = 0; i < 10; i++) await headlessGet("/api/headless"); // fill the read bucket
    const limited = await headlessGet("/api/headless"); // 429 → throttled reject line
    expect(limited.status).toBe(429);
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
    await spawnPost(BODY); // 202 → request line
    await spawnPost(BODY); // dup 202 → request line with dup:true
    const spawnAudits = kit.log.lines.filter((l) => l.msg === "spawn").map((l) => l.data as Record<string, unknown>);
    expect(spawnAudits.every((a) => a["audit"] === "spawn")).toBe(true);
    const rejects = spawnAudits.filter((a) => a["phase"] === "reject");
    expect(
      rejects.some((a) => a["code"] === "E_CSRF" && a["endpoint"] === "spawn" && a["listener"] === "loopback"),
    ).toBe(true);
    expect(rejects.some((a) => a["code"] === "E_RATE" && a["endpoint"] === "list")).toBe(true);
    const requests = spawnAudits.filter((a) => a["phase"] === "request");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ endpoint: "spawn", cwd: "/home/u/proj", known: true, confirmed: false });
    expect(requests[1]).toMatchObject({ dup: true });
    // U7: the first-prompt body (nor its hash) never lands in an audit line
    await spawnPost({ ...BODY, id: ID2, firstPrompt: { text: "AUDIT-SECRET-BODY-𝄞" } });
    const blob = JSON.stringify(kit.log.lines);
    expect(blob).not.toContain("AUDIT-SECRET-BODY");
  });

  it("body/firstPrompt lengths (not contents) ride the request line", async () => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
    await spawnPost({ ...BODY, id: ID2, firstPrompt: { text: "four" } });
    const line = kit.log.lines
      .map((l) => l.data as Record<string, unknown>)
      .find((d) => d["phase"] === "request" && d["endpoint"] === "spawn" && d["textLen"] === 4);
    expect(line).toMatchObject({ firstPrompt: "pending", textLen: 4 });
  });
});

describe("methods with no spawn route keep the legacy fall-through", () => {
  it("DELETE /api/headless/x ⇒ 404 pre-auth (same as not-enabled)", async () => {
    const res = await rawRequest(port, { method: "DELETE", path: "/api/headless/x" });
    expect(res.status).toBe(404);
  });

  it("GET /api/headless/nonsense ⇒ 404 after auth", async () => {
    const res = await headlessGet("/api/headless/nonsense");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// default-model plan §2/§3 (D2 tri-state, prefs endpoint, R2-2 SpawnAccepted.model)
// ---------------------------------------------------------------------------

describe("POST /api/headless — default-model tri-state (plan D2)", () => {
  beforeEach(() => {
    kit.dirs.setAdmitResult({ ok: true, realpath: "/home/u/proj", dev: 1, ino: 2, known: true });
  });

  it("absent body model ⇒ the hub preference is forked with; 202 carries the effective model", async () => {
    kit.prefs.setValue("p1/preferred");
    const res = await spawnPost(BODY);
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body).model).toBe("p1/preferred");
    expect(kit.supervisor.startCalls[0]!.model).toBe("p1/preferred");
  });

  it('body "" ⇒ explicit pi default — NO --model even with a preference set; no `model` key in the reply', async () => {
    kit.prefs.setValue("p1/preferred");
    const res = await spawnPost({ ...BODY, model: "" });
    expect(res.status).toBe(202);
    expect("model" in JSON.parse(res.body)).toBe(false);
    expect(kit.supervisor.startCalls[0]!.model).toBeUndefined();
  });

  it("body provider/id wins over the preference (R2-2: reply/persisted record/argv input all agree)", async () => {
    kit.prefs.setValue("p1/preferred");
    const res = await spawnPost({ ...BODY, model: "p2/explicit" });
    expect(res.status).toBe(202);
    const parsed = JSON.parse(res.body);
    expect(parsed.model).toBe("p2/explicit");
    expect(kit.supervisor.startCalls[0]!.model).toBe("p2/explicit");
    // the fake supervisor auto-owns the record — the persisted record's model matches too
    const rec = kit.supervisor.recordsOut.find((r) => r.spawnId === parsed.spawnId);
    expect(rec?.model).toBe("p2/explicit");
  });

  it('invalid model (no `/`, leading `-`, whitespace, zero-width) ⇒ 400 E_BAD_REQUEST{reason:"model-invalid"}; >257B is caught by the schema prefilter first', async () => {
    for (const [i, model] of ["x", "-flag/value", "p1/ mo del", "p1/\u200bzero", "\u00a0p1/m"].entries()) {
      const id = `reqid-0000-mv${i}`.padEnd(20, "x").slice(0, 20);
      const res = await spawnPost({ ...BODY, id, model });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: "E_BAD_REQUEST",
        reason: "model-invalid",
        message: "invalid model ref",
      });
    }
    // >257 UTF-8 bytes trips the request schema's maxLength PREFILTER (the prefs body has none
    // by design — plan §2 — so the same value surfaces as model-invalid there instead)
    const huge = await spawnPost({ ...BODY, model: `p1/${"x".repeat(300)}` });
    expect(huge.status).toBe(400);
    expect(JSON.parse(huge.body)).toEqual({ error: "E_BAD_REQUEST", message: "bad spawn request body" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("same id + different model ⇒ 409 (the model joined the intent digest)", async () => {
    await spawnPost(BODY);
    const res = await spawnPost({ ...BODY, model: "p1/other" });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_BAD_REQUEST" });
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("same id + same model ⇒ dup 202 replaying the record; a later preference change never rewrites it", async () => {
    kit.prefs.setValue("p1/a");
    const first = await spawnPost({ ...BODY, model: "p1/a" });
    expect(JSON.parse(first.body).model).toBe("p1/a");
    kit.prefs.setValue("p2/b");
    const replay = await spawnPost({ ...BODY, model: "p1/a" });
    expect(replay.status).toBe(202);
    const parsed = JSON.parse(replay.body);
    expect(parsed.dup).toBe(true);
    expect(parsed.model).toBe("p1/a"); // R2-2: the ORIGINAL record's value
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("absent-model replay after a preference change still dups (digest unchanged — model joins only when present)", async () => {
    kit.prefs.setValue("p1/a");
    const first = await spawnPost(BODY); // record forked with p1/a
    expect(JSON.parse(first.body).model).toBe("p1/a");
    kit.prefs.setValue("p2/b");
    const replay = await spawnPost(BODY); // same absent-model intent ⇒ dup, still p1/a
    const parsed = JSON.parse(replay.body);
    expect(parsed.dup).toBe(true);
    expect(parsed.model).toBe("p1/a");
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("digest canonicalization is key-order independent (a reordered body is the SAME intent)", async () => {
    await spawnPost(BODY);
    const reordered = `{"cwd":"/home/u/proj","id":"${ID}"}`; // cwd BEFORE id vs the helper's id-first
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/headless",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: cookie, Origin: ORIGIN(port) },
      body: reordered,
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body).dup).toBe(true);
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("the no-model digest keeps the pre-feature canonical shape (pinned hex)", async () => {
    // sha256 of the EXACT pre-feature canonical strings — plan §3 ①'s byte-compat invariant.
    // (Behavioral guard: the dup tests above; this documents/pins the literal form.)
    expect(createHash("sha256").update('{"cwd":"/home/u/proj"}').digest("hex")).toBe(
      "b40c162fcda128763acf957b44c09cbbcb8cc97cf3fdc9b653eb5c31fee10cb5",
    );
  });
});

describe("GET /api/headless — prefs field (plan §3 ③)", () => {
  it("rides the list reply: null when unset, the value once written", async () => {
    const before = await headlessGet("/api/headless");
    expect(JSON.parse(before.body).prefs).toEqual({ defaultModel: null });
    kit.prefs.setValue("p1/m");
    const after = await headlessGet("/api/headless");
    expect(JSON.parse(after.body).prefs).toEqual({ defaultModel: "p1/m" });
  });
});

describe("POST /api/headless/prefs (plan §3 ④)", () => {
  const prefsPost = (body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> =>
    postJson(port, "/api/headless/prefs", body, { Cookie: cookie, Origin: ORIGIN(port), ...headers });

  it("CSRF quartet ⇒ 403, no write", async () => {
    expect((await prefsPost({ defaultModel: "p1/m" }, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await postJson(port, "/api/headless/prefs", { defaultModel: "p1/m" }, { Cookie: cookie })).status).toBe(
      403,
    ); // no Origin
    expect((await prefsPost({ defaultModel: "p1/m" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const noPwh = await rawRequest(port, {
      method: "POST",
      path: "/api/headless/prefs",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN(port) },
      body: JSON.stringify({ defaultModel: "p1/m" }),
    });
    expect(noPwh.status).toBe(403);
    expect(kit.prefs.setCalls).toHaveLength(0);
  });

  it("unauthenticated ⇒ 401", async () => {
    const res = await postJson(port, "/api/headless/prefs", { defaultModel: "p1/m" }, { Origin: ORIGIN(port) });
    expect(res.status).toBe(401);
  });

  it("200 write + audit {listener, ip, from, to}; GET list reflects it; the next spawn forks with it", async () => {
    const res = await prefsPost({ defaultModel: "p1/m" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ prefs: { defaultModel: "p1/m" } });
    expect(kit.prefs.setCalls).toEqual(["p1/m"]);
    const line = kit.log.lines
      .map((l) => l.data as Record<string, unknown>)
      .find((d) => d["endpoint"] === "prefs" && d["phase"] === "request");
    expect(line).toMatchObject({ listener: "loopback", from: null, to: "p1/m" });
    const list = await headlessGet("/api/headless");
    expect(JSON.parse(list.body).prefs).toEqual({ defaultModel: "p1/m" });
    // clear: "" is the explicit 「清空」
    const cleared = await prefsPost({ defaultModel: "" });
    expect(JSON.parse(cleared.body)).toEqual({ prefs: { defaultModel: null } });
    const clearLine = kit.log.lines
      .map((l) => l.data as Record<string, unknown>)
      .findLast((d) => d["endpoint"] === "prefs" && d["phase"] === "request");
    expect(clearLine).toMatchObject({ from: "p1/m", to: null });
  });

  it("schema: array/string body ⇒ not-an-object; unknown/missing field ⇒ schema; bad ref ⇒ model-invalid", async () => {
    expect((await prefsPost([1, 2])).status).toBe(400);
    expect(JSON.parse((await prefsPost([1, 2])).body)).toEqual({ error: "E_BAD_REQUEST", reason: "not-an-object" });
    expect(JSON.parse((await prefsPost({ nope: 1 })).body)).toEqual({ error: "E_BAD_REQUEST", reason: "schema" });
    expect(JSON.parse((await prefsPost({ defaultModel: "p1/m", extra: 1 })).body)).toEqual({
      error: "E_BAD_REQUEST",
      reason: "schema",
    });
    expect(JSON.parse((await prefsPost({ defaultModel: 7 })).body)).toEqual({
      error: "E_BAD_REQUEST",
      reason: "schema",
    });
    expect(JSON.parse((await prefsPost({ defaultModel: "garbage" })).body)).toEqual({
      error: "E_BAD_REQUEST",
      reason: "model-invalid",
    });
    expect(kit.prefs.setCalls).toHaveLength(0);
  });

  it('persist failure ⇒ 503 E_LAUNCHER{reason:"persist"}, memory unchanged', async () => {
    kit.prefs.setValue("p1/old");
    kit.prefs.setPersistResultTo({ ok: false, code: "ENOSPC" });
    const res = await prefsPost({ defaultModel: "p1/new" });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "E_LAUNCHER", reason: "persist" });
    expect(kit.prefs.get()).toBe("p1/old"); // value NOT flipped
    const list = await headlessGet("/api/headless");
    expect(JSON.parse(list.body).prefs).toEqual({ defaultModel: "p1/old" });
    expect(
      kit.log.lines.some(
        (l) =>
          (l.data as Record<string, unknown>)["endpoint"] === "prefs" &&
          (l.data as Record<string, unknown>)["phase"] === "reject",
      ),
    ).toBe(true);
  });

  it("write bucket: the 11th write in a minute ⇒ 429", async () => {
    for (let i = 0; i < 10; i++) await prefsPost({ defaultModel: "" });
    const burst = await prefsPost({ defaultModel: "p1/m" });
    expect(burst.status).toBe(429);
    expect(burst.headers["retry-after"]).toBe("6");
  });

  it("body over 1 KiB ⇒ 413 + connection close", async () => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/headless/prefs",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: cookie, Origin: ORIGIN(port) },
      body: JSON.stringify({ defaultModel: `p1/${"a".repeat(1200)}` }),
    });
    expect(res.status).toBe(413);
    expect(String(res.headers["connection"] ?? "").toLowerCase()).toBe("close");
  });

  it("logout racing the body read: second authorize 401s, prefs.set NEVER called, value unchanged", async () => {
    kit.prefs.setValue("p1/old");
    const res = await parkedPost("/api/headless/prefs", JSON.stringify({ defaultModel: "p1/new" }), async () => {
      await sleep(50);
      await postJson(port, "/api/logout", {}, { Cookie: cookie, Origin: ORIGIN(port) });
    });
    // same mechanism as the cmd plane's §6.3 step ⑥: the second authorize() re-reads the loopback
    // session map, which /api/logout (and a landed token rotation — it clears the same map) emptied.
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "E_AUTH" });
    expect(kit.prefs.setCalls).toHaveLength(0);
    expect(kit.prefs.get()).toBe("p1/old");
  });

  it("GET /api/headless/prefs ⇒ 404 after auth (the prefs ride GET /api/headless)", async () => {
    const res = await headlessGet("/api/headless/prefs");
    expect(res.status).toBe(404);
  });
});
