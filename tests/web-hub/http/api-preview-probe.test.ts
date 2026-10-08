/**
 * web-hub content-preview — `POST /api/preview/probe` through the REAL `createHttpFrontend`
 * (2026-10-07 修订「先探测后标记」, loopback listener).
 *
 * Dispatch-matrix + auth-alignment cases the route-level suite
 * (`tests/web-hub/hub/preview/probe.test.ts`) cannot see: the endpoint is wired at the same
 * insertion point as `GET /api/preview`, answers 401 without a cookie / 403 without `X-PWH`
 * exactly like it, an authed GET on the same path keeps the original 404 (method pin), and
 * the request caps (100 entries / 8 KiB body) hold over a real socket. LAN dispatch reuses
 * the identical `mode === "on"` gate the preview branch carries (§4.7 matrix — pinned for
 * `GET` by `lan-preview.test.ts`; probe rides the same branch).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_PROBE_MAX_PATHS, PREVIEW_PROBE_PATH } from "../../../src/web-hub/protocol/preview.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import type { FrontendDeps, HttpFrontend, PreviewRoutes } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeAgent, postJson, rawRequest, type FakeDeps, type RawResponse } from "./helpers.js";

const AGENT = "a4242-nonce12";
const SESSION = "sess123";

interface Harness {
  deps: FakeDeps;
  fe: HttpFrontend;
  port: number;
  cookie: string;
  cwd: string;
  file(rel: string, content: string | Buffer): string;
  cleanup(): Promise<void>;
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-probe-"));
  const deps = fakeDeps(dir);
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  deps.agents.set(
    AGENT,
    makeAgent(AGENT, {
      session: { sessionId: SESSION, cwd, reason: "test", leafId: null, mode: "tui" },
    }),
  );
  const routes: PreviewRoutes = createPreviewRoutes({
    mode: "on",
    denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
    uploadsRoot: webHubUploadsDir(dir),
    registry: deps.registry,
    log: deps.log,
    now: deps.now,
  });
  (deps as FrontendDeps).preview = routes;
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  return {
    deps,
    fe,
    port,
    cookie,
    cwd,
    file(rel, content) {
      const p = join(cwd, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    async cleanup() {
      await fe.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** POST the probe over a real socket (cookie + X-PWH by default). */
function post(
  h: Harness,
  body: unknown,
  opts: { headers?: Record<string, string>; agentKey?: string; sessionId?: string } = {},
): Promise<RawResponse> {
  const q = `agentKey=${encodeURIComponent(opts.agentKey ?? AGENT)}&sessionId=${encodeURIComponent(opts.sessionId ?? SESSION)}`;
  return postJson(h.port, `${PREVIEW_PROBE_PATH}?${q}`, body, { Cookie: h.cookie, ...(opts.headers ?? {}) });
}

describe("POST /api/preview/probe — loopback dispatch (2026-10-07 修订)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("a full batch over a real socket: text/image/missing in request order", async () => {
    const text = h.file("a.ts", "hello\n");
    const png = h.file("b.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const gone = join(h.cwd, "gone.ts");
    const r = await post(h, { paths: [text, png, gone] });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({
      results: [{ kind: "text" }, { kind: "image" }, { kind: "missing" }],
    });
  });

  it("auth/CSRF alignment with GET /api/preview: no cookie ⇒ 401, no X-PWH ⇒ 403", async () => {
    const noCookie = await rawRequest(h.port, {
      method: "POST",
      path: `${PREVIEW_PROBE_PATH}?agentKey=${AGENT}&sessionId=${SESSION}`,
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: JSON.stringify({ paths: [] }),
    });
    expect(noCookie.status).toBe(401);
    expect(JSON.parse(noCookie.body)).toEqual({ error: "E_AUTH" });

    const noCsrf = await rawRequest(h.port, {
      method: "POST",
      path: `${PREVIEW_PROBE_PATH}?agentKey=${AGENT}&sessionId=${SESSION}`,
      headers: { Cookie: h.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [] }),
    });
    expect(noCsrf.status).toBe(403);
    expect(JSON.parse(noCsrf.body)).toEqual({ error: "E_CSRF" });
  });

  it("unknown agent ⇒ 404 E_NOT_FOUND; session mismatch ⇒ 409 E_SESSION_CHANGED", async () => {
    const miss = await post(h, { paths: [] }, { agentKey: "other" });
    expect(miss.status).toBe(404);
    expect(JSON.parse(miss.body)).toEqual({ error: "E_NOT_FOUND" });
    const changed = await post(h, { paths: [] }, { sessionId: "other" });
    expect(changed.status).toBe(409);
    expect(JSON.parse(changed.body)).toEqual({ error: "E_SESSION_CHANGED" });
  });

  it("a GET on the probe path keeps the original generic answer (authed ⇒ 404, method pin)", async () => {
    const r = await rawRequest(h.port, {
      method: "GET",
      path: `${PREVIEW_PROBE_PATH}?agentKey=${AGENT}&sessionId=${SESSION}`,
      headers: { Cookie: h.cookie, "X-PWH": "1" },
    });
    expect(r.status).toBe(404);
  });

  it("caps over a real socket: >PREVIEW_PROBE_MAX_PATHS entries ⇒ 400; body >8 KiB ⇒ 413", async () => {
    const tooMany = await post(h, {
      paths: Array.from({ length: PREVIEW_PROBE_MAX_PATHS + 1 }, (_, i) => `/p/f${i}.ts`),
    });
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.body)).toEqual({ error: "E_BAD_REQUEST", reason: "too-many" });

    const tooBig = await post(h, {
      paths: Array.from({ length: 40 }, (_, i) => `/p/${String(i).padStart(6, "0")}-${"x".repeat(200)}.ts`),
    });
    expect(tooBig.status).toBe(413);
    expect(JSON.parse(tooBig.body)).toEqual({ error: "E_BAD_REQUEST", reason: "body" });
  });
});
