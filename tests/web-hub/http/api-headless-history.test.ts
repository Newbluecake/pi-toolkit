/**
 * session-history plan §4.6.6: `GET /api/headless/history` + the POST `session` branch, over
 * the real `createSpawnRoutes` wired through the real `createHttpFrontend` HTTP stack (repo
 * style, same harness `api-headless.test.ts` uses) — `spawn-kit.ts`'s `fakeHistory()` stands in
 * for the (P-scan-owned, still-WIP) real `HistoryService`.
 *
 * Covers: GET's auth/CSRF/rate/four-400/cursor-expired/policy-deny rows; POST's gate order
 * (admit ∥ resolve → prove → confirm → snapshot(fork) → auth2 → sync reprove/verify → start);
 * occupancy-forced-fork 409; sync new-process 409; session-changed 409 (both resume and fork);
 * snapshot too-large 400; pin released exactly once on every exit path; a failed `start()`
 * discards the fork snapshot; `model-with-session` 400; PD13 (hub model preference never
 * applies); dup replay with `session`; resolve-over-admit reject priority.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeClock, type FakeClock } from "./lan-helpers.js";
import { fakeDeps, login, makeTmp, postJson, rawRequest, type FakeDeps, type RawResponse } from "./helpers.js";
import { fakeHistory, fakeSessionPin, spawnKit, type FakeHistoryService, type SpawnKit } from "./spawn-kit.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let kit: SpawnKit;
let history: FakeHistoryService;
let clock: FakeClock;

beforeEach(async () => {
  tmp = makeTmp("pwh-history-");
  deps = fakeDeps(tmp.dir);
  clock = fakeClock();
  history = fakeHistory();
  kit = spawnKit({ history: true }, clock, undefined, history);
  deps.spawn = kit.spawn;
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
});

afterEach(async () => {
  await fe.close();
  tmp.cleanup();
});

const ORIGIN = (p: number): string => `http://127.0.0.1:${p}`;
const SESSION_REF = { key: "dir/sess-old.jsonl", id: "sess-old", mode: "resume" as const };

function spawnPost(body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return postJson(port, "/api/headless", body, { Cookie: cookie, Origin: ORIGIN(port), ...headers });
}

function historyGet(query = "", headers: Record<string, string> = {}): Promise<RawResponse> {
  return rawRequest(port, {
    path: `/api/headless/history${query}`,
    headers: { Cookie: cookie, "X-PWH": "1", ...headers },
  });
}

// ---------------------------------------------------------------------------
// GET /api/headless/history
// ---------------------------------------------------------------------------

describe("GET /api/headless/history", () => {
  it("missing X-PWH ⇒ 403 E_CSRF", async () => {
    const r = await rawRequest(port, { path: "/api/headless/history", headers: { Cookie: cookie } });
    expect(r.status).toBe(403);
  });

  it("no cookie ⇒ 401", async () => {
    const r = await rawRequest(port, { path: "/api/headless/history", headers: { "X-PWH": "1" } });
    expect(r.status).toBe(401);
  });

  it("rate bucket (capacity 4, 500ms refill) ⇒ 429 + Retry-After", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await historyGet();
      expect(r.status).toBe(200);
    }
    const limited = await historyGet();
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("bad q (too long) ⇒ 400 reason q", async () => {
    const r = await historyGet(`?q=${"a".repeat(200)}`);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "q" });
  });

  it("bad kind ⇒ 400 reason kind", async () => {
    const r = await historyGet("?kind=bogus");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "kind" });
  });

  it("bad cursor ⇒ 400 reason cursor", async () => {
    const r = await historyGet("?cursor=not-a-cursor");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "cursor" });
  });

  it("bad limit (0, non-integer, over max) ⇒ 400 reason limit", async () => {
    for (const limit of ["0", "abc", "101", "-1"]) {
      const r = await historyGet(`?limit=${limit}`);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "limit" });
    }
  });

  it("cursor-expired ⇒ 409 E_BAD_REQUEST", async () => {
    history.setPageResult({ ok: false, reason: "cursor-expired" });
    const r = await historyGet();
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "cursor-expired" });
  });

  it("policy not allowed ⇒ every row forced startable:false", async () => {
    kit.supervisor.setPolicy({
      allowed: false,
      reason: "launcher",
      confirm: "unknown-dir",
      scope: "known",
      max: 4,
      maxPerPrincipal: 2,
      active: 0,
      activeMine: 0,
      registerTimeoutS: 30,
      maxLifetimeMinutes: 720,
    });
    history.setPageResult({
      ok: true,
      page: {
        items: [
          {
            key: "dir/a.jsonl",
            id: "sess-1",
            cwd: "/home/u/proj",
            cwdLabel: "proj",
            startedAt: "2026-01-01T00:00:00Z",
            mtimeMs: 1,
            size: 10,
            titleSource: "none",
            kind: "main",
            cwdState: "ok",
            startable: true,
            indexed: true,
          },
        ],
        stats: { files: 1, indexed: 1, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
      },
    });
    const r = await historyGet();
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].startable).toBe(false);
  });

  it("incomplete and stats.enum pass through unchanged", async () => {
    history.setPageResult({
      ok: true,
      page: {
        items: [],
        incomplete: true,
        stats: { files: 3, indexed: 2, enum: { complete: false, dirsDone: 1, dirsTotal: 2 } },
      },
    });
    const r = await historyGet();
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.incomplete).toBe(true);
    expect(body.stats.enum).toEqual({ complete: false, dirsDone: 1, dirsTotal: 2 });
  });

  it("success never writes a reject-audit line", async () => {
    history.setPageResult({
      ok: true,
      page: { items: [], stats: { files: 0, indexed: 0, enum: { complete: true, dirsDone: 0, dirsTotal: 0 } } },
    });
    kit.log.lines.length = 0;
    const r = await historyGet();
    expect(r.status).toBe(200);
    expect(
      kit.log.lines.filter((l) => l.data !== undefined && (l.data as Record<string, unknown>).audit === "spawn"),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/headless — session branch
// ---------------------------------------------------------------------------

const ID = "hist-0000-aaaaaaaaaa";

describe("POST /api/headless — session resume", () => {
  it("gate order: admit ∥ resolve → prove → confirm → auth2 → sync reprove/verifyForSpawn → start", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(r.status).toBe(202);
    expect(history.calls).toEqual(["resolve", "prove", "reprove", "verifyForSpawn"]);
    expect(kit.supervisor.startCalls).toHaveLength(1);
  });

  it("prove not free + mode resume ⇒ 409 session-open with forkReason/proofGap/live; no LRU write, start not called", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    history.setProveResult({
      free: false,
      reason: "open",
      gap: undefined,
      live: { state: "open", by: "card", agentKey: "k1" },
    });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(r.status).toBe(409);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({
      error: "E_CONFIRM_REQUIRED",
      reason: "session-open",
      forkReason: "open",
      live: { state: "open", by: "card", agentKey: "k1" },
    });
    expect(kit.supervisor.startCalls).toHaveLength(0);
    // a dup replay of the SAME id must NOT see an idempotency hit (409 confirm never writes LRU)
    const replay = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(replay.status).toBe(409);
  });

  it("mode:fork + confirm resent with the same id ⇒ 202, startCalls[0]'s argv material is the snapshot path", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    history.setProveResult({ free: false, reason: "open", live: { state: "open", by: "card" } });
    const forkBody = {
      id: ID,
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: { ...SESSION_REF, mode: "fork" as const },
    };
    const r = await spawnPost(forkBody);
    expect(r.status).toBe(202);
    const body = JSON.parse(r.body);
    expect(body.session.mode).toBe("fork");
    expect(kit.supervisor.startCalls).toHaveLength(1);
    const started = kit.supervisor.startCalls[0]!;
    expect(started.session?.mode).toBe("fork");
    expect(started.session?.abs).toContain("fork-src");
  });

  it("sync reprove returns new-process ⇒ 409 and start is never called", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    history.setReproveResult({ free: false, reason: "unverified", gap: "new-process" });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(r.status).toBe(409);
    const body = JSON.parse(r.body);
    expect(body).toMatchObject({
      error: "E_CONFIRM_REQUIRED",
      reason: "session-open",
      forkReason: "unverified",
      proofGap: "new-process",
    });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("verifyForSpawn failure ⇒ 409 session-changed", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    history.setVerifyForSpawnResult({ ok: false, reason: "session-changed" });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_DIR", reason: "session-changed" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("verifySnapshot failure ⇒ 409 session-changed AND the snapshot is discarded", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    history.setVerifySnapshotResult(false);
    const r = await spawnPost({
      id: ID,
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: { ...SESSION_REF, mode: "fork" as const },
    });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_DIR", reason: "session-changed" });
    expect(history.discardedSnapshots.length).toBeGreaterThan(0);
    expect(kit.supervisor.startCalls).toHaveLength(0);
  });

  it("snapshot too-large ⇒ 400 E_DIR", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    history.setSnapshotResult({ ok: false, status: 400, reason: "session-too-large" });
    const r = await spawnPost({
      id: ID,
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: { ...SESSION_REF, mode: "fork" as const },
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "E_DIR", reason: "session-too-large" });
  });

  it("start() failure ⇒ the fork snapshot is discarded", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    kit.supervisor.setStartResult({ ok: false, code: "E_LIMIT", reason: "limit", limit: "global", active: 4, max: 4 });
    const r = await spawnPost({
      id: ID,
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: { ...SESSION_REF, mode: "fork" as const },
    });
    expect(r.status).toBe(409);
    expect(history.discardedSnapshots.length).toBeGreaterThan(0);
  });

  it("model-with-session ⇒ 400", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, model: "anthropic/claude", session: SESSION_REF });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({
      error: "E_BAD_REQUEST",
      reason: "model-with-session",
      message: "model cannot be set when resuming a session",
    });
  });

  it("bad session key ⇒ 400 session-ref", async () => {
    const r = await spawnPost({ id: ID, cwd: "/home/u/proj", session: { key: "not-valid", id: "sess-1" } });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "session-ref", message: "bad session ref" });
  });

  it("PD13: even with a hub model preference set, a session-backed start carries no model", async () => {
    kit.prefs.setValue("anthropic/claude-default");
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(r.status).toBe(202);
    expect(kit.supervisor.startCalls[0]?.model).toBeUndefined();
  });

  it("resolve AND admit both fail ⇒ resolve's error wins (higher priority)", async () => {
    history.setResolveResult({ ok: false, status: 400, code: "E_DIR", reason: "session-missing" });
    kit.dirs.setAdmitResult({ ok: false, reason: "moved" });
    const r = await spawnPost({ id: ID, cwd: "/home/u/proj", session: SESSION_REF });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "E_DIR", reason: "session-missing" });
  });

  it("dup replay with session carries the original record's session verdict", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    const body = { id: ID, cwd: pin.cwd, session: SESSION_REF };
    const first = await spawnPost(body);
    expect(first.status).toBe(202);
    const replay = await spawnPost(body);
    expect(replay.status).toBe(202);
    const replayBody = JSON.parse(replay.body);
    expect(replayBody.dup).toBe(true);
    expect(replayBody.session).toEqual({ mode: "resume", id: pin.id });
  });

  it("startReq.session.pathPin carries the pin's three dev/ino levels", async () => {
    const pin = fakeSessionPin({
      root: { dev: 7, ino: 70 },
      dir: { dev: 7, ino: 71 },
      file: { dev: 7, ino: 72 },
    });
    history.setResolveResult({ ok: true, pin });
    const r = await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(r.status).toBe(202);
    const started = kit.supervisor.startCalls[0]!;
    expect(started.session?.pathPin).toEqual({
      abs: pin.abs,
      root: { dev: 7, ino: 70 },
      dir: { dev: 7, ino: 71 },
      file: { dev: 7, ino: 72 },
    });
  });

  it.each([
    ["prove forces fork and mode stays resume", () => history.setProveResult({ free: false, reason: "open" })],
    [
      "sync reprove new-process",
      () => history.setReproveResult({ free: false, reason: "unverified", gap: "new-process" }),
    ],
    ["verifyForSpawn fails", () => history.setVerifyForSpawnResult({ ok: false, reason: "session-changed" })],
    ["admit fails", () => kit.dirs.setAdmitResult({ ok: false, reason: "moved" })],
  ])("pin is released exactly once on exit path: %s", async (_label, arrange) => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    arrange();
    await spawnPost({ id: `${ID}-${Math.random()}`.slice(0, 20), cwd: pin.cwd, session: SESSION_REF });
    expect(pin.releaseCalls).toBe(1);
  });

  it("pin is released exactly once on the happy (202) path", async () => {
    const pin = fakeSessionPin();
    history.setResolveResult({ ok: true, pin });
    await spawnPost({ id: ID, cwd: pin.cwd, session: SESSION_REF });
    expect(pin.releaseCalls).toBe(1);
  });
});
