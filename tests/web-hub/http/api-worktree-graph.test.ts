/**
 * worktree-graph plan v2 §2.6/§3 (P2, real HTTP frontend): same matrix discipline as
 * `api-worktree-diff.test.ts`:
 * - loopback: not-enabled fallback byte-identical (401 unauth / 404 authed), CSRF 403;
 * - LAN: `mode:"loopback"` ⇒ 404 byte-identical to not-enabled; `mode:"on"` ⇒ dispatched;
 * - the /proc gate (same gate as wtdiff, §0.2/§3): with `previewProcFdAvailable` forced false, a
 *   real `startHub` declares NO `wtgraph.v1` on either cap surface and wires NO `worktreeGraph`
 *   dep — byte-identical to not-enabled.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { startHub } from "../../../src/web-hub/hub/hub.js";
import { createWorktreeGraphRoutes } from "../../../src/web-hub/hub/worktree-graph/routes.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { WTGRAPH_PATH } from "../../../src/web-hub/protocol/worktree-graph.js";
import { PROTO, WTGRAPH_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import type { AgentView, HubEvent, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import type { FrontendDeps, FrontendFactory } from "../../../src/web-hub/hub/ports.js";
import { testHubPaths } from "../helpers/paths.js";
import { captureLog, makeAgent, makeTmp, rawRequest } from "./helpers.js";
import { login } from "./helpers.js";
import { lanPostJson, lanRequest, seedLanUser } from "./lan-helpers.js";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { HubLanConfig, LanStatus } from "../../../src/web-hub/hub/ports.js";
import { config as hubConfig, connectClient, hello } from "../hub/helpers.js";
import {
  AGENT,
  HEAD_SHA1,
  LINKED,
  REPO,
  SESSION,
  glStdout,
  grStdout,
  okRun,
  scriptGraphAdmission,
} from "../hub/worktree-graph/helpers.js";
import { repoFixture } from "../hub/worktree-diff/helpers.js";

const procFd = vi.hoisted(() => ({ available: true }));
vi.mock("../../../src/web-hub/hub/preview/fs.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/web-hub/hub/preview/fs.js")>();
  return { ...orig, previewProcFdAvailable: () => procFd.available };
});

const DENY = denyCtxOf("/home/tester", "/home/tester/.pi/agent");
const MAIN_REF = { type: "commit" as const, oid: HEAD_SHA1, refname: "refs/heads/main" };

function wtgraphRoutes(mode: "on" | "loopback" = "on") {
  const fx = repoFixture();
  const routes = createWorktreeGraphRoutes({
    mode,
    denyCtx: DENY,
    registry: {
      list: () => [],
      get: (k: string) => (k === AGENT ? { session: { sessionId: SESSION, cwd: REPO } } : undefined),
    },
    run: fx.runner,
    log: captureLog(),
    now: Date.now,
    fs: fx.fs,
  });
  return { routes, fx };
}

function gq(wt = LINKED): string {
  return `${WTGRAPH_PATH}?agentKey=${encodeURIComponent(AGENT)}&sessionId=${encodeURIComponent(SESSION)}&wt=${encodeURIComponent(wt)}`;
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

interface LoopKit {
  fe: HttpFrontend;
  port: number;
  cookie: string;
  cleanup(): Promise<void>;
}

async function loopKit(opts: { enabled?: boolean } = {}): Promise<LoopKit> {
  const tmp = makeTmp("pwh-api-wtg-");
  const deps = createBaseDeps(tmp.dir);
  if (opts.enabled !== false) deps.worktreeGraph = wtgraphRoutes().routes;
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  procFd.available = true;
  for (const c of cleanups.splice(0)) await c();
});

describe("loopback /api/worktree-graph — the §2.6/§3 matrix", () => {
  it("not enabled (deps.worktreeGraph absent): unauth ⇒ 401, authed ⇒ 404 — byte-identical to not-enabled", async () => {
    const k = await loopKit({ enabled: false });
    cleanups.push(k.cleanup);
    const unauth = await rawRequest(k.port, { method: "GET", path: gq() });
    expect(unauth.status).toBe(401);
    expect(unauth.body).toBe('{"error":"E_AUTH"}');
    const authed = await rawRequest(k.port, {
      method: "GET",
      path: gq(),
      headers: { Cookie: k.cookie, "X-PWH": "1" },
    });
    expect(authed.status).toBe(404);
    expect(authed.body).toBe('{"error":"E_NOT_FOUND"}');
  });

  it("CSRF: no X-PWH ⇒ 403 before auth", async () => {
    const k = await loopKit();
    cleanups.push(k.cleanup);
    const r = await rawRequest(k.port, { method: "GET", path: gq(), headers: { Cookie: k.cookie } });
    expect(r.status).toBe(403);
    expect(r.body).toBe('{"error":"E_CSRF"}');
  });

  it("mode:on works end to end over real HTTP: 200, no-store, same-origin CORP", async () => {
    const w = wtgraphRoutes("on");
    scriptGraphAdmission(w.fx);
    w.fx.runner.push(okRun(grStdout([MAIN_REF])));
    w.fx.runner.push(okRun(glStdout([{ h: HEAD_SHA1, p: [], an: "a", at: 1, s: "s" }])));
    const tmp = makeTmp("pwh-api-wtg2-");
    const deps = createBaseDeps(tmp.dir);
    deps.worktreeGraph = w.routes;
    const fe = createHttpFrontend(deps);
    const port = (await fe.listen()).port;
    const cookie = await login(port, deps.paths.tokenFile);
    cleanups.push(async () => {
      await fe.close();
      tmp.cleanup();
    });
    const r = await rawRequest(port, {
      method: "GET",
      path: gq(),
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const payload = JSON.parse(r.body) as { v: number; commits: unknown[] };
    expect(payload.v).toBe(1);
    expect(payload.commits).toHaveLength(1);
  });
});

async function lanKit(
  opts: { mode?: "on" | "loopback" } = {},
): Promise<{ port: number; cookie: Promise<string>; cleanup: Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-lan-wtg-"));
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
  const { fx, routes } = (() => {
    const w = wtgraphRoutes(opts.mode ?? "on");
    return { fx: w.fx, routes: w.routes };
  })();
  void fx;
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
    worktreeGraph: routes,
  });
  void lastStatus;
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

describe("LAN /api/worktree-graph — the mode gate", () => {
  it('mode "loopback": LAN answers 404 BYTE-IDENTICALLY to not-enabled', async () => {
    const k = await lanKit({ mode: "loopback" });
    cleanups.push(() => k.cleanup);
    const cookie = await k.cookie;
    const r = await lanRequest(k.port, { method: "GET", path: gq(), headers: { Cookie: cookie, "X-PWH": "1" } });
    expect(r.status).toBe(404);
    expect(r.body).toBe('{"error":"E_NOT_FOUND"}');
  });

  it('mode "on": LAN dispatches (CSRF before auth; a scripted admission failure maps through the pipeline)', async () => {
    const k = await lanKit({ mode: "on" });
    cleanups.push(() => k.cleanup);
    const cookie = await k.cookie;
    const noPwh = await lanRequest(k.port, { method: "GET", path: gq(), headers: { Cookie: cookie } });
    expect(noPwh.status).toBe(403);
    expect(noPwh.body).toBe('{"error":"E_CSRF"}');
    const dispatched = await lanRequest(k.port, {
      method: "GET",
      path: gq(),
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    // empty scripted runner ⇒ C1a exit nonzero ⇒ the route pipeline maps it to 403 not-repo
    expect(dispatched.status).toBe(403);
    expect(dispatched.body).toBe('{"error":"E_WTDIFF_DENIED","reason":"not-repo"}');
  });
});

describe("hub assembly × /proc gate", () => {
  it("previewProcFdAvailable=false ⇒ no wtgraph.v1 on EITHER cap surface and no worktreeGraph deps", async () => {
    procFd.available = false;
    const dirs = mkdtempSync(join(tmpdir(), "pwh-wtg-noproc-"));
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
    expect(hub.info.caps).not.toContain(WTGRAPH_HUB_CAP);
    expect(agentCaps).not.toContain(WTGRAPH_HUB_CAP);
    expect(captured[0]!.worktreeGraph).toBeUndefined();
    c.sock.destroy();
    await hub.close("test");
    rmSync(dirs, { recursive: true, force: true });
  });

  it("previewProcFdAvailable=true (passthrough default) ⇒ the cap rides the preview gate", async () => {
    const dirs = mkdtempSync(join(tmpdir(), "pwh-wtg-proc-"));
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
    expect(hub.info.caps).toContain(WTGRAPH_HUB_CAP);
    expect(captured[0]!.worktreeGraph?.mode).toBe("loopback");
    await hub.close("test");
    rmSync(dirs, { recursive: true, force: true });
  });
});
