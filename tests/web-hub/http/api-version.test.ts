/** web-hub-version plan §3.9/§3.11 — loopback `GET /api/version`. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunResult, GitRunner } from "../../../src/git/run.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend, VersionInfoOutcome, VersionInfoPort } from "../../../src/web-hub/hub/ports.js";
import { createUiServer, type UiServer } from "../../../src/web-hub/hub/static.js";
import { createVersionInfoService } from "../../../src/web-hub/hub/version-info.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import { VERSION_INFO_PATH, type VersionInfoWire } from "../../../src/web-hub/protocol/version-info.js";
import { fakeDeps, login, makeTmp, rawRequest, type FakeDeps } from "./helpers.js";

const WIRE: VersionInfoWire = { v: 1, checkedAt: 5, hub: { pid: 1, startedAt: 1 } };

interface H {
  tmp: ReturnType<typeof makeTmp>;
  deps: FakeDeps;
  fe: HttpFrontend;
  port: number;
  cookie: string;
}
const hs: H[] = [];
afterEach(async () => {
  for (const h of hs.splice(0)) {
    await h.fe.close();
    h.tmp.cleanup();
  }
});

async function start(extra: { version?: VersionInfoPort; ui?: UiServer } = {}): Promise<H> {
  const tmp = makeTmp();
  const deps = fakeDeps(tmp.dir);
  mkdirSync(deps.paths.stateDir, { recursive: true });
  if (extra.version !== undefined) deps.version = extra.version;
  if (extra.ui !== undefined) deps.ui = extra.ui;
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  const h = { tmp, deps, fe, port, cookie };
  hs.push(h);
  return h;
}
const get = (h: H, headers: Record<string, string>) => rawRequest(h.port, { path: VERSION_INFO_PATH, headers });
const authed = (h: H) => ({ Cookie: h.cookie, "X-PWH": "1" });

const fixed = (o: VersionInfoOutcome): VersionInfoPort & { calls: number } => {
  const p = { calls: 0, snapshot: async () => (p.calls++, o) };
  return p;
};

describe("GET /api/version (loopback)", () => {
  it("service absent ⇒ the legacy matrix: unauth 401, authed 404 (no 403 for a missing X-PWH either)", async () => {
    const h = await start();
    expect((await get(h, { "X-PWH": "1" })).status).toBe(401);
    expect((await get(h, authed(h))).status).toBe(404);
    expect((await get(h, { Cookie: h.cookie })).status).toBe(404);
  });

  it("missing X-PWH ⇒ 403; unauthenticated ⇒ 401; ok ⇒ 200 JSON verbatim + no-store", async () => {
    const svc = fixed({ ok: true, data: WIRE });
    const h = await start({ version: svc });
    expect((await get(h, { Cookie: h.cookie })).status).toBe(403);
    expect((await get(h, { "X-PWH": "1" })).status).toBe(401);
    expect(svc.calls).toBe(0);
    const r = await get(h, authed(h));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toEqual(WIRE);
    expect(svc.calls).toBe(1);
  });

  it("E_BUSY ⇒ 503, E_DEADLINE ⇒ 504 (no-store, no new error code)", async () => {
    const busy = await start({ version: fixed({ ok: false, code: "E_BUSY" }) });
    const r1 = await get(busy, authed(busy));
    expect(r1.status).toBe(503);
    expect(JSON.parse(r1.body)).toEqual({ error: "E_BUSY" });
    expect(r1.headers["cache-control"]).toBe("no-store");
    const dl = await start({ version: fixed({ ok: false, code: "E_DEADLINE" }) });
    const r2 = await get(dl, authed(dl));
    expect(r2.status).toBe(504);
    expect(JSON.parse(r2.body)).toEqual({ error: "E_DEADLINE" });
  });

  it("burst beyond the per-principal limit ⇒ 429 with Retry-After", async () => {
    const h = await start({ version: fixed({ ok: true, data: WIRE }) });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await get(h, authed(h))).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes).toContain(429);
  });

  it("every request awaits the UI redeploy probe (and a probe E_BUSY ⇒ 503)", async () => {
    let probes = 0;
    let busy = false;
    const ui: UiServer = {
      serve: async () => false,
      refresh: async () => ({ state: "unbuilt", candidates: [] }),
      status: () => ({ state: "unbuilt", candidates: [] }),
      probe: async () => {
        probes++;
        if (busy) throw new Error("E_BUSY");
        return { state: "unbuilt", candidates: [] };
      },
    };
    const h = await start({ version: fixed({ ok: true, data: WIRE }), ui });
    expect((await get(h, authed(h))).status).toBe(200);
    expect(probes).toBe(1);
    busy = true;
    const r = await get(h, authed(h));
    expect(r.status).toBe(503);
    expect(probes).toBe(2);
  });
});

describe("response never carries paths, git stderr or UiStatus rejection details (§3.10)", () => {
  it("deep-scans every string of a real-service response", async () => {
    const pkgRoot = mkdtempSync(join(tmpdir(), "pwh-leak-pkg-"));
    const uiDir = join(mkdtempSync(join(tmpdir(), "pwh-leak-ui-")), "SECRET-CANDIDATE-DIR");
    try {
      writeFileSync(join(pkgRoot, "CHANGELOG.md"), "## [1.0.0] - 2026-01-01\n- plain entry\n");
      writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
      const STDERR = "STDERR-SECRET-MARKER";
      const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stdoutCapped: false, stderr: STDERR });
      const git: GitRunner = async (args) => {
        const a = args.join(" ");
        if (a.includes("--show-toplevel")) return ok(`${pkgRoot}\n`);
        if (a.includes("rev-list")) return ok("1\n");
        if (a.includes("--format=%h%x09%ct%x09%s")) return ok("abc1234\t100\tsubject without paths\n");
        if (a.includes("--format=%h%x09%ct")) return ok("abc1234\t100\n");
        if (a.includes("describe")) return ok("v0.9.0\n");
        return ok("");
      };
      const info = { version: "1.0.0", buildId: "b", pid: process.pid, startedAt: 1, proto: PROTO, caps: [] };
      const svc = createVersionInfoService({
        pkgRoot,
        info,
        git,
        realpath: async (p) => p,
        now: () => Date.now(),
        log: { info() {}, warn() {}, error() {}, debug() {}, close() {} } as never,
      });
      const ui = createUiServer({
        candidates: [{ ok: true, spec: { kind: "package", dir: uiDir } }],
        hubVersion: "1.0.0",
        log: { info() {}, warn() {}, error() {}, debug() {}, close() {} } as never,
      });
      const h = await start({ version: svc, ui });
      const r = await get(h, authed(h));
      svc.dispose();
      expect(r.status).toBe(200);
      const strings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            strings.push(k);
            walk(x);
          }
        }
      };
      walk(JSON.parse(r.body));
      expect(strings.length).toBeGreaterThan(5);
      const forbidden = [
        pkgRoot,
        uiDir,
        "SECRET-CANDIDATE-DIR",
        STDERR,
        homedir(),
        tmpdir(),
        "candidates",
        "reason",
        "detail",
      ];
      for (const s of strings) for (const f of forbidden) expect(s.includes(f), `${s} ⊇ ${f}`).toBe(false);
      expect(JSON.parse(r.body)).toMatchObject({
        repo: { head: { commit: "abc1234" } },
        changelog: { sections: [{ title: "1.0.0" }] },
      });
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
    }
  });
});
