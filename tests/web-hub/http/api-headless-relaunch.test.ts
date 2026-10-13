/**
 * spawn-relaunch 验收: `POST /api/headless/relaunch` on the LOOPBACK listener — the REAL
 * `createSpawnRoutes` through the REAL `createHttpFrontend` HTTP stack (repo style), with the
 * spawn-kit fakes for supervisor/dirs/first-prompt (the fork/identity/procfs machinery lives
 * behind the supervisor and is covered by `tests/web-hub/hub/spawn/supervisor.test.ts`'s
 * relaunch suite + `tests/integration/web-hub-headless.test.ts`'s real-fake-pi e2e).
 *
 * Covers: 202 accepted (supervisor call + audit), 404 unknown record, 409
 * `E_AGENT_ONLINE{reason:"exit-unconfirmed"}` (process not confirmably dead — L6/B-alive),
 * 410 `E_SPAWN_GONE{reason:"session-missing"}` (session file deleted), 409
 * `E_BAD_REQUEST{reason:"no-session"}`, 503 `E_LAUNCHER`, idempotent re-entry (non-terminal
 * record ⇒ 202 `dup:true`, no second supervisor transition), the CSRF/auth gates (403/401),
 * GET ⇒ 404, schema 400s, the >1 KiB body 413, the rate bucket (429), and the audit whitelist
 * (endpoint:"relaunch" rides, no session paths anywhere).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeClock } from "./lan-helpers.js";
import { fakeDeps, login, makeTmp, postJson, rawRequest, type FakeDeps, type RawResponse } from "./helpers.js";
import { spawnKit, type SpawnKit } from "./spawn-kit.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let kit: SpawnKit;

const SPAWN_ID = "relau000-0000-0001";

beforeEach(async () => {
  tmp = makeTmp("pwh-relaunch-");
  deps = fakeDeps(tmp.dir);
  kit = spawnKit({}, fakeClock());
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

/** POST with full strict-CSRF headers + cookie (the happy-path default). */
function relaunchPost(body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return postJson(port, "/api/headless/relaunch", body, { Cookie: cookie, Origin: ORIGIN(port), ...headers });
}

describe("POST /api/headless/relaunch (spawn-relaunch)", () => {
  it("202: a terminal, confirmed-dead record relaunches — supervisor called once, audit line written", async () => {
    kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "exited", endReason: "user" });
    kit.supervisor.setDeathOf("confirmed");
    const r = await relaunchPost({ spawnId: SPAWN_ID });
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ spawnId: SPAWN_ID, state: "starting" });
    expect(kit.supervisor.relaunchCalls).toEqual([{ spawnId: SPAWN_ID }]);
    const audit = kit.log.lines.filter((l) => JSON.stringify(l).includes('"relaunch"'));
    expect(audit.length).toBeGreaterThan(0);
    // zero-path-leak discipline: no cwd / session file anywhere in the audit lines
    expect(JSON.stringify(kit.log.lines)).not.toContain(kit.supervisor.recordsOut[0]!.cwd);
  });

  it("404: unknown spawnId (record gone — trimmed, deleted, or never existed)", async () => {
    const r = await relaunchPost({ spawnId: SPAWN_ID });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toMatchObject({ error: "E_NOT_FOUND" });
  });

  it("409 E_AGENT_ONLINE{exit-unconfirmed}: the process may still be alive — never forked over", async () => {
    kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "exited", endReason: "crash" });
    kit.supervisor.setDeathOf("alive"); // /proc probe says the identity still runs
    const r = await relaunchPost({ spawnId: SPAWN_ID });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" });
  });

  it("410 E_SPAWN_GONE{session-missing}: the session file the user once had is gone", async () => {
    kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "exited", endReason: "user" });
    kit.supervisor.setRelaunchResult({ ok: false, code: "E_SPAWN_GONE", reason: "session-missing" });
    const r = await relaunchPost({ spawnId: SPAWN_ID });
    expect(r.status).toBe(410);
    expect(JSON.parse(r.body)).toEqual({ error: "E_SPAWN_GONE", reason: "session-missing" });
  });

  it("409 E_BAD_REQUEST{no-session}: a terminal record that never had a session to resume", async () => {
    kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "failed", endReason: "spawn_error" });
    kit.supervisor.setRelaunchResult({ ok: false, code: "E_BAD_REQUEST", reason: "no-session" });
    const r = await relaunchPost({ spawnId: SPAWN_ID });
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_BAD_REQUEST", reason: "no-session" });
  });

  it("503 E_LAUNCHER: launcher/persist/reaper preconditions refuse synchronously", async () => {
    kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "exited", endReason: "user" });
    kit.supervisor.setRelaunchResult({ ok: false, code: "E_LAUNCHER", reason: "launcher" });
    const r = await relaunchPost({ spawnId: SPAWN_ID });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ error: "E_LAUNCHER", reason: "launcher" });
  });

  it("idempotent re-entry: the record turned non-terminal (relaunch in flight) ⇒ 202 dup:true, no state change", async () => {
    const rec = kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "exited", endReason: "user" });
    kit.supervisor.setDeathOf("confirmed");
    const first = await relaunchPost({ spawnId: SPAWN_ID });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toEqual({ spawnId: SPAWN_ID, state: "starting" });
    // the hub's commit moved the record to starting before the 202 went out; a retried/parallel
    // call must never fork again — the fake mirrors that (non-terminal ⇒ dup)
    rec.state = "starting";
    const dup = await relaunchPost({ spawnId: SPAWN_ID });
    expect(dup.status).toBe(202);
    expect(JSON.parse(dup.body)).toEqual({ spawnId: SPAWN_ID, state: "starting", dup: true });
    expect(kit.supervisor.relaunchCalls).toHaveLength(2); // both reached the supervisor…
    // …but the SECOND returned without transitioning (its result is the dup marker)
  });

  it("gates: 403 without strict-CSRF headers, 401 without auth, GET ⇒ 404", async () => {
    // no X-PWH/Origin ⇒ CSRF
    expect((await postJson(port, "/api/headless/relaunch", { spawnId: SPAWN_ID }, { Cookie: cookie })).status).toBe(
      403,
    );
    // authed headers but no cookie ⇒ 401
    expect(
      (await postJson(port, "/api/headless/relaunch", { spawnId: SPAWN_ID }, { Origin: ORIGIN(port), "X-PWH": "1" }))
        .status,
    ).toBe(401);
    // GET is not part of the surface (write-only, like prefs/mkdir)
    expect(
      (await rawRequest(port, { path: "/api/headless/relaunch", headers: { Cookie: cookie, "X-PWH": "1" } })).status,
    ).toBe(404);
    expect(kit.supervisor.relaunchCalls).toHaveLength(0);
  });

  it("400: schema rejects — missing spawnId, bad shape, unknown keys", async () => {
    for (const body of [{}, { spawnId: "too short" }, { spawnId: SPAWN_ID, extra: 1 }, "nope"]) {
      const r = await relaunchPost(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(r.body)).toMatchObject({ error: "E_BAD_REQUEST" });
    }
    expect(kit.supervisor.relaunchCalls).toHaveLength(0);
  });

  it("413: a body over RELAUNCH_BODY_MAX never reaches the supervisor", async () => {
    const r = await relaunchPost({ spawnId: SPAWN_ID, pad: "x".repeat(2048) });
    expect(r.status).toBe(413);
    expect(kit.supervisor.relaunchCalls).toHaveLength(0);
  });

  it("429: the per-principal write bucket (10/min) bounds relaunch storms", async () => {
    kit.supervisor.seedRecord({ spawnId: SPAWN_ID, state: "exited", endReason: "user" });
    kit.supervisor.setDeathOf("confirmed");
    let last: RawResponse | undefined;
    for (let i = 0; i < 11; i++) last = await relaunchPost({ spawnId: SPAWN_ID });
    expect(last!.status).toBe(429);
    expect(JSON.parse(last!.body)).toMatchObject({ error: "E_RATE" });
  });
});
