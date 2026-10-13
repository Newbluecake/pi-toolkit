/**
 * spawn-dirmkdir 验收: `POST /api/headless/mkdir` on the LOOPBACK listener — the REAL
 * `createSpawnRoutes` + the REAL `createMkdirService` (real fs against tmp dirs) wired through
 * the real `createHttpFrontend` HTTP stack (repo style: `tests/web-hub/http/`), with the
 * spawn-kit fakes for supervisor/dirs/first-prompt.
 *
 * Covers: 200 happy path (dir really created, `{path}` echo is the RESOLVED absolute path),
 * the name-rule 400 forms (empty / `/` / `.` / `..` / NUL / >255 bytes), a denylist hit (403
 * `E_DENIED`, NO path in body or audit line), already-exists 409 `E_CONFLICT{reason:"exists"}`,
 * missing parent 404, `~` expansion, the CSRF/auth gates (403/401), and the not-wired 404
 * (`deps.mkdir` absent — the `historyOn` gate pattern). The spawn-OFF matrix row (501,
 * byte-identical to pre-feature) stays pinned by `headless-matrix.test.ts`'s generic POST row
 * plus the not-wired case below.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { createPreviewIoTracker } from "../../../src/web-hub/hub/preview/fs.js";
import { createMkdirService } from "../../../src/web-hub/hub/spawn/mkdir.js";
import { fakeClock } from "./lan-helpers.js";
import { fakeDeps, login, makeTmp, postJson, rawRequest, type FakeDeps, type RawResponse } from "./helpers.js";
import { spawnKit, type SpawnKit } from "./spawn-kit.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let kit: SpawnKit;

beforeEach(async () => {
  tmp = makeTmp("pwh-mkdir-");
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
function mkdirPost(body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return postJson(port, "/api/headless/mkdir", body, { Cookie: cookie, Origin: ORIGIN(port), ...headers });
}

/** Rewire the frontend with a REAL mkdir service rooted at the tmp dir (denyCtx literal-only). */
async function withRealMkdir(): Promise<void> {
  await fe.close();
  deps = fakeDeps(tmp.dir);
  kit = spawnKit(
    {},
    fakeClock(),
    undefined,
    undefined,
    createMkdirService({
      denyCtx: denyCtxOf(tmp.dir, join(tmp.dir, ".pi/agent")),
      tracker: createPreviewIoTracker(),
      log: kit.log,
      now: fakeClock().now,
    }),
  );
  deps.spawn = kit.spawn;
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
}

describe("POST /api/headless/mkdir (spawn-dirmkdir)", () => {
  it("200: creates the directory for real and echoes its resolved absolute path", async () => {
    await withRealMkdir();
    const r = await mkdirPost({ path: tmp.dir, name: "fresh" });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ ok: true, path: join(tmp.dir, "fresh") });
    expect(existsSync(join(tmp.dir, "fresh"))).toBe(true);
  });

  it("200: a `~` parent expands against the hub home (here: the tmp dir)", async () => {
    await withRealMkdir();
    const r = await mkdirPost({ path: "~", name: "via-tilde" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).path).toBe(join(tmp.dir, "via-tilde"));
    expect(existsSync(join(tmp.dir, "via-tilde"))).toBe(true);
  });

  it("200: a trailing-slash parent is tolerated and canonicalized (no `//` in the join)", async () => {
    await withRealMkdir();
    const r = await mkdirPost({ path: `${tmp.dir}/`, name: "trail" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).path).toBe(join(tmp.dir, "trail"));
    expect(existsSync(join(tmp.dir, "trail"))).toBe(true);
  });

  it("400 E_BAD_REQUEST{name-invalid}: empty / slash / dot / dotdot / NUL / >255 bytes", async () => {
    await withRealMkdir();
    for (const name of ["", "a/b", ".", "..", "a\0b", "x".repeat(256)]) {
      const r = await mkdirPost({ path: tmp.dir, name });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toMatchObject({ error: "E_BAD_REQUEST", reason: "name-invalid" });
    }
    // schema-level failures (missing/wrong-typed fields) stay the plain 400
    for (const body of [{ path: tmp.dir }, { name: "x" }, { path: 1, name: "x" }, "nope"]) {
      const r = await mkdirPost(body);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body).error).toBe("E_BAD_REQUEST");
    }
  });

  it("403 E_DENIED on a denylist hit — and the path never leaks into body or audit line", async () => {
    await withRealMkdir();
    const r = await mkdirPost({ path: tmp.dir, name: ".ssh" });
    expect(r.status).toBe(403);
    const body = JSON.parse(r.body);
    expect(body).toEqual({ error: "E_DENIED", reason: "denylist" });
    expect(r.body).not.toContain(tmp.dir);
    expect(r.body).not.toContain(".ssh");
    const audit = kit.log.lines.filter((l) => l.msg === "spawn");
    expect(audit.length).toBeGreaterThan(0);
    for (const line of audit) {
      expect(JSON.stringify(line.data ?? {})).not.toContain(".ssh");
      expect(JSON.stringify(line.data ?? {})).not.toContain(tmp.dir);
    }
  });

  it("409 E_CONFLICT{exists} when the name is already taken; 404 when the parent is missing", async () => {
    await withRealMkdir();
    const r1 = await mkdirPost({ path: tmp.dir, name: "dup" });
    expect(r1.status).toBe(200);
    const r2 = await mkdirPost({ path: tmp.dir, name: "dup" });
    expect(r2.status).toBe(409);
    expect(JSON.parse(r2.body)).toEqual({ error: "E_CONFLICT", reason: "exists" });

    const r3 = await mkdirPost({ path: join(tmp.dir, "no-such-parent"), name: "x" });
    expect(r3.status).toBe(404);
    expect(JSON.parse(r3.body)).toEqual({ error: "E_NOT_FOUND" });
  });

  it("gates: 403 E_CSRF without the strict quartet, 401 unauthenticated, GET 404", async () => {
    await withRealMkdir();
    // no Origin ⇒ strict CSRF fails before auth
    const csrf = await postJson(port, "/api/headless/mkdir", { path: tmp.dir, name: "x" }, { Cookie: cookie });
    expect(csrf.status).toBe(403);
    // good CSRF but no cookie ⇒ 401
    const unauth = await postJson(port, "/api/headless/mkdir", { path: tmp.dir, name: "x" }, { Origin: ORIGIN(port) });
    expect(unauth.status).toBe(401);
    // GET on the write-only path ⇒ 404
    const get = await rawRequest(port, {
      path: "/api/headless/mkdir",
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    expect(get.status).toBe(404);
    expect(existsSync(join(tmp.dir, "x"))).toBe(false);
  });

  it("deps.mkdir absent ⇒ POST is byte-identical to an unknown path (404, authed + CSRF-clean)", async () => {
    // the default beforeEach kit wires NO mkdir service
    const r = await mkdirPost({ path: tmp.dir, name: "x" });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: "E_NOT_FOUND" });
  });
});
