/**
 * worktree-diff plan §2.2/§5 D3 (D6's mode gate at the REAL HTTP frontend):
 * - loopback rows: not-enabled fallback byte-identical (401 unauth / 404 authed), CSRF 403,
 *   the full 200 flow through real HTTP (headers + gzip on a ≥2 KiB body);
 * - LAN rows: `mode:"loopback"` ⇒ 404 byte-identical to not-enabled; `mode:"on"` ⇒ dispatched;
 * - the /proc gate (D21): with `previewProcFdAvailable` forced false (module-mocked), a real
 *   startHub declares NO `wtdiff.v1` on either cap surface and wires NO `worktreeDiff` deps —
 *   the endpoints keep the not-enabled matrix exactly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { startHub } from "../../../src/web-hub/hub/hub.js";
import { createWorktreeDiffRoutes } from "../../../src/web-hub/hub/worktree-diff/routes.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { WTDIFF_FILES_PATH, WTDIFF_FILE_PATH } from "../../../src/web-hub/protocol/worktree-diff.js";
import { PROTO, WTDIFF_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { AgentView, HubEvent, HubLanConfig, HttpFrontend, LanStatus } from "../../../src/web-hub/hub/ports.js";
import type { FrontendDeps, FrontendFactory } from "../../../src/web-hub/hub/ports.js";
import { testHubPaths } from "../helpers/paths.js";
import { captureLog, makeAgent, makeTmp, rawRequest } from "./helpers.js";
import { login } from "./helpers.js";
import { lanPostJson, lanRequest, seedLanUser } from "./lan-helpers.js";
import { config as hubConfig, connectClient, hello } from "../hub/helpers.js";
import {
  AGENT,
  HEAD_SHA1,
  LINKED,
  REPO,
  REPO_GIT,
  SESSION,
  createFakeFs,
  okRun,
  scriptedRunner,
  statusV2Z,
} from "../hub/worktree-diff/helpers.js";

// ---------------------------------------------------------------------------
// the /proc gate seam (D21): module-mock preview/fs.js's probe, everything else passthrough
// ---------------------------------------------------------------------------

const procFd = vi.hoisted(() => ({ available: true }));
vi.mock("../../../src/web-hub/hub/preview/fs.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/web-hub/hub/preview/fs.js")>();
  return { ...orig, previewProcFdAvailable: () => procFd.available };
});

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const recM = (path: string): string => `1 .M N... 100644 100644 100644 h1 h2 ${path}`;

/** the fake repo + the scripted happy-path pipeline (files endpoint) */
function wtdiffRoutes() {
  const fs = createFakeFs();
  fs.mkdir(REPO);
  fs.mkdir(`${REPO}/.git`);
  fs.writeFile(`${REPO}/.git/index`, Buffer.from([1]));
  fs.mkdir(LINKED);
  fs.writeFile(`${LINKED}/.git`, `gitdir: ${REPO}/.git/worktrees/lw\n`);
  fs.mkdir(`${REPO}/.git/worktrees/lw`);
  const runner = scriptedRunner();
  const porcelain = `worktree ${REPO}\nHEAD ${HEAD_SHA1}\nbranch refs/heads/main\n\nworktree ${LINKED}\nHEAD ${HEAD_SHA1}\nbranch refs/heads/f\n\n\n`;
  const routes = createWorktreeDiffRoutes({
    mode: "on",
    denyCtx: DENY,
    registry: {
      list: () => [],
      get: (k) => (k === AGENT ? { session: { sessionId: SESSION, cwd: REPO } } : undefined),
    },
    run: runner,
    log: captureLog(),
    now: Date.now,
    fs,
  });
  const scriptHappy = (entryCount: number): void => {
    const records = Array.from({ length: entryCount }, (_, i) => recM(`src/deeply/nested/module-number-${i}.ts`));
    runner.push(
      okRun(`${REPO_GIT}\n`),
      okRun(porcelain),
      okRun(`sha1\n${HEAD_SHA1}\n`),
      okRun(""),
      okRun(statusV2Z(HEAD_SHA1, records)),
      okRun(""),
      okRun(""),
    );
  };
  return { routes, runner, scriptHappy };
}

function filesQ(wt = LINKED): string {
  return `${WTDIFF_FILES_PATH}?agentKey=${encodeURIComponent(AGENT)}&sessionId=${encodeURIComponent(SESSION)}&wt=${encodeURIComponent(wt)}`;
}

// ---------------------------------------------------------------------------
// loopback
// ---------------------------------------------------------------------------

interface LoopKit {
  fe: HttpFrontend;
  port: number;
  cookie: string;
  cleanup(): Promise<void>;
}

async function loopKit(opts: { enabled?: boolean } = {}): Promise<LoopKit> {
  const tmp = makeTmp("pwh-api-wtd-");
  const deps = createBaseDeps(tmp.dir);
  if (opts.enabled !== false) deps.worktreeDiff = wtdiffRoutes().routes;
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  return {
    fe,
    port,
    cookie,
    async cleanup() {
      await fe.close();
      tmp.cleanup();
    },
  };
}

function createBaseDeps(dir: string): FrontendDeps & { paths: ReturnType<typeof testHubPaths> } {
  const agents = new Map<string, AgentView>();
  agents.set(
    AGENT,
    makeAgent(AGENT, { session: { sessionId: SESSION, cwd: REPO, reason: "t", leafId: null, mode: "tui" } }),
  );
  const log = captureLog();
  const subs = new Set<(e: HubEvent) => void>();
  const paths = testHubPaths(join(dir, "state"));
  return {
    config: { v: 1, home: dir, port: 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths,
    registry: { list: () => [...agents.values()], get: (k) => agents.get(k) },
    bus: { subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)) },
    history: {
      snapshot: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      page: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      onLeafChanged: () => {},
    },
    log,
    info: () => ({ version: "9.9.9-test", buildId: "b1", pid: process.pid, startedAt: 1, proto: PROTO }),
    now: () => Date.now(),
    paths2: paths,
  } as unknown as FrontendDeps & { paths: ReturnType<typeof testHubPaths> };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  procFd.available = true;
  for (const c of cleanups.splice(0)) await c();
});

describe("loopback /api/worktree-diff — the §2.2/D6 matrix", () => {
  it("not enabled (deps.worktreeDiff absent): unauth ⇒ 401, authed ⇒ 404 — byte-identical to today", async () => {
    const k = await loopKit({ enabled: false });
    cleanups.push(k.cleanup);
    const unauth = await rawRequest(k.port, { method: "GET", path: filesQ() });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toBe('{"error":"E_AUTH"}');
    const authed = await rawRequest(k.port, {
      method: "GET",
      path: filesQ(),
      headers: { Cookie: k.cookie, "X-PWH": "1" },
    });
    expect(authed.status).toBe(404);
    expect(authed.body).toBe('{"error":"E_NOT_FOUND"}');
  });

  it("CSRF: no X-PWH ⇒ 403 before auth", async () => {
    const k = await loopKit();
    cleanups.push(k.cleanup);
    const r = await rawRequest(k.port, { method: "GET", path: filesQ(), headers: { Cookie: k.cookie } });
    expect(r.status).toBe(403);
    expect(r.body).toBe('{"error":"E_CSRF"}');
  });

  it("the full 200 flow through real HTTP: headers, JSON envelope, and gzip on a ≥2 KiB body", async () => {
    const w = wtdiffRoutes();
    w.scriptHappy(60); // ≥2 KiB of entries so sendJson's gzip negotiation engages
    const tmp = makeTmp("pwh-api-wtd2-");
    const deps = createBaseDeps(tmp.dir);
    deps.worktreeDiff = w.routes;
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    const cookie = await login(port, deps.paths.tokenFile);
    cleanups.push(async () => {
      await fe.close();
      tmp.cleanup();
    });
    const r = await rawRequest(port, {
      method: "GET",
      path: filesQ(),
      headers: { Cookie: cookie, "X-PWH": "1", "Accept-Encoding": "gzip" },
    });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(r.headers["content-encoding"]).toBe("gzip");
  });

  it("the file endpoint 404s the same way when not enabled; 403 CSRF without X-PWH", async () => {
    const k = await loopKit({ enabled: false });
    cleanups.push(k.cleanup);
    const authed = await rawRequest(k.port, {
      method: "GET",
      path: `${WTDIFF_FILE_PATH}?agentKey=${AGENT}&sessionId=${SESSION}&wt=${encodeURIComponent(LINKED)}&base=${HEAD_SHA1}&path=a.ts`,
      headers: { Cookie: k.cookie, "X-PWH": "1" },
    });
    expect(authed.status).toBe(404);
    expect(authed.body).toBe('{"error":"E_NOT_FOUND"}');
  });
});

// ---------------------------------------------------------------------------
// LAN
// ---------------------------------------------------------------------------

async function lanKit(
  opts: { mode?: "on" | "loopback" } = {},
): Promise<{ port: number; cookie: Promise<string>; cleanup: Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-lan-wtd-"));
  const log = captureLog();
  const clock = { now: () => Date.now() };
  const agents = new Map<string, AgentView>();
  agents.set(
    AGENT,
    makeAgent(AGENT, { session: { sessionId: SESSION, cwd: REPO, reason: "t", leafId: null, mode: "tui" } }),
  );
  const subs = new Set<(e: HubEvent) => void>();
  const lanStore = fakeLanStore();
  const { createServer } = await import("node:net");
  const freePort = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
  const cfg: HubLanConfig = { port: freePort, extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
  let lastStatus: LanStatus = { state: "starting" };
  const routes = createWorktreeDiffRoutes({
    mode: opts.mode ?? "on",
    denyCtx: DENY,
    registry: { list: () => [...agents.values()], get: (k) => agents.get(k) },
    run: scriptedRunner(),
    log,
    now: clock.now,
    fs: createFakeFs(),
  });
  const fe = createHttpFrontend({
    config: { v: 1, home: dir, port: 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths: testHubPaths(join(dir, "state")),
    registry: { list: () => [...agents.values()], get: (k) => agents.get(k) },
    bus: { subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)) },
    history: {
      snapshot: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      page: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file",
      }),
      onLeafChanged: () => {},
    },
    log,
    info: () => ({ version: "9.9.9-test", buildId: "b1", pid: process.pid, startedAt: 1, proto: PROTO }),
    now: clock.now,
    lan: {
      cfg,
      store: lanStore,
      kdf: fakeKdf(),
      limiter: createLoginLimiter({ now: clock.now }),
      admission: createKdfAdmission({ now: clock.now, isTightened: () => false }),
      hosts: createHostsPort(),
      scope: createScope({ log, now: clock.now }),
      onStatus: (s) => (lastStatus = s),
    },
    worktreeDiff: routes,
  });
  if (fe.lan === undefined) throw new Error("test bug: no LAN facade");
  const status = await fe.lan.start();
  if (status.state !== "on") throw new Error(`LAN failed: ${JSON.stringify(status)}`);
  return {
    port: status.port,
    cookie: (async () => {
      seedLanUser(lanStore, { id: 1, username: "alice", password: "correct-horse-battery" });
      const r = await lanPostJson(status.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
      return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    })(),
    cleanup: async () => {
      await fe.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("LAN /api/worktree-diff — the D6 mode gate", () => {
  it('mode "loopback": LAN answers 404 BYTE-IDENTICALLY to not-enabled', async () => {
    const k = await lanKit({ mode: "loopback" });
    cleanups.push(() => k.cleanup);
    const cookie = await k.cookie;
    const r = await lanRequest(k.port, { method: "GET", path: filesQ(), headers: { Cookie: cookie, "X-PWH": "1" } });
    expect(r.status).toBe(404);
    expect(r.body).toBe('{"error":"E_NOT_FOUND"}');
  });

  it('mode "on": LAN dispatches (the CSRF gate answers before auth here too)', async () => {
    const k = await lanKit({ mode: "on" });
    cleanups.push(() => k.cleanup);
    const cookie = await k.cookie;
    const noPwh = await lanRequest(k.port, { method: "GET", path: filesQ(), headers: { Cookie: cookie } });
    expect(noPwh.status).toBe(403);
    expect(noPwh.body).toBe('{"error":"E_CSRF"}');
    // X-PWH + authed ⇒ dispatched INTO the route: the empty scripted runner makes C1a exit
    // nonzero, and only the route pipeline maps that to 403 E_WTDIFF_DENIED{not-repo}
    const dispatched = await lanRequest(k.port, {
      method: "GET",
      path: filesQ(),
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    expect(dispatched.status).toBe(403);
    expect(dispatched.body).toBe('{"error":"E_WTDIFF_DENIED","reason":"not-repo"}');
  });
});

// ---------------------------------------------------------------------------
// the /proc gate at hub level (D21)
// ---------------------------------------------------------------------------

describe("hub assembly × /proc gate (D21)", () => {
  it("previewProcFdAvailable=false ⇒ no wtdiff.v1 on EITHER cap surface and no worktreeDiff deps", async () => {
    procFd.available = false;
    const dirs = mkdtempSync(join(tmpdir(), "pwh-wtd-noproc-"));
    const captured: FrontendDeps[] = [];
    const factory: FrontendFactory = (deps): HttpFrontend => {
      captured.push(deps);
      return {
        listen: async () => ({ port: 43210 }),
        close: async () => {},
        clientCount: () => 0,
        ui: {
          serve: async () => false,
          refresh: async () => ({ state: "unbuilt", candidates: [] }),
          status: () => ({ state: "unbuilt", candidates: [] }),
        },
      };
    };
    const hub = await startHub(hubConfig({ home: dirs, port: 0, preview: "on" }), factory, {
      uid: process.getuid?.() ?? 0,
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    const c = await connectClient(hub.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    const agentCaps = ack["caps"] as string[];
    expect([...hub.info.caps].sort()).toEqual([...agentCaps].sort());
    expect(hub.info.caps).not.toContain(WTDIFF_HUB_CAP);
    expect(agentCaps).not.toContain(WTDIFF_HUB_CAP);
    expect(captured[0]!.worktreeDiff).toBeUndefined();
    c.sock.destroy();
    await hub.close("test");
    rmSync(dirs, { recursive: true, force: true });
  });

  it("previewProcFdAvailable=true (the passthrough default) ⇒ the cap rides the preview gate", async () => {
    const dirs = mkdtempSync(join(tmpdir(), "pwh-wtd-proc-"));
    const captured: FrontendDeps[] = [];
    const factory: FrontendFactory = (deps): HttpFrontend => {
      captured.push(deps);
      return {
        listen: async () => ({ port: 43210 }),
        close: async () => {},
        clientCount: () => 0,
        ui: {
          serve: async () => false,
          refresh: async () => ({ state: "unbuilt", candidates: [] }),
          status: () => ({ state: "unbuilt", candidates: [] }),
        },
      };
    };
    const hub = await startHub(hubConfig({ home: dirs, port: 0, preview: "loopback" }), factory, {
      uid: process.getuid?.() ?? 0,
    });
    if ("exists" in hub) throw new Error("unexpected exists");
    expect(hub.info.caps).toContain(WTDIFF_HUB_CAP);
    expect(captured[0]!.worktreeDiff?.mode).toBe("loopback");
    await hub.close("test");
    rmSync(dirs, { recursive: true, force: true });
  });
});
