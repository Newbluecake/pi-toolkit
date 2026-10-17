/**
 * Shared LAN + loopback harness for the web-hub HTML preview tests (a REAL LAN listener in
 * lan-helpers' assembly shape next to the loopback one, one `createHttpFrontend`).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { createAdminHandler } from "../../../src/web-hub/hub/admin.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { AuthRevokeEvent } from "../../../src/web-hub/hub/auth-revoke.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { createPreviewRoutes } from "../../../src/web-hub/hub/preview/routes.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import { createReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";
import type { AgentView, HttpFrontend, HubLanConfig, HubLog, PreviewRoutes } from "../../../src/web-hub/hub/ports.js";
import { PREVIEW_HTML_CAP_PATH } from "../../../src/web-hub/protocol/preview-html.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import { testHubPaths } from "../helpers/paths.js";
import { captureLog, login, makeAgent, postJson, rawRequest, type LogLine } from "./helpers.js";
import { lanPostJson, lanRequest, seedLanUser, type RawResponse } from "./lan-helpers.js";
import { AGENT, SESSION, copyPvSite } from "./pv-kit.js";

export interface Lan {
  fe: HttpFrontend & {
    auth: { check: (...a: never[]) => boolean };
    revokeAllSse(): number;
    subscribeAuthRevoke(fn: (ev: AuthRevokeEvent) => void): () => void;
  };
  lanPort: number;
  loopPort: number;
  site: string;
  dir: string;
  lanStore: ReturnType<typeof fakeLanStore>;
  routes: PreviewRoutes | undefined;
  logLines: LogLine[];
  loopCookie: string;
  lanCookie(id: number, user: string): Promise<string>;
  mintLan(cookie: string, extra?: Record<string, string>): Promise<RawResponse>;
  mintLoop(): Promise<RawResponse>;
  capOf(r: RawResponse): string;
  lanGet(path: string, headers?: Record<string, string>): Promise<RawResponse>;
  loopGet(path: string): Promise<RawResponse>;
  passwd(username: string): Promise<unknown>;
  cleanup(): Promise<void>;
}

const lans: Lan[] = [];
/** call from `afterEach` */
export async function cleanupLans(): Promise<void> {
  vi.restoreAllMocks();
  for (const l of lans.splice(0)) await l.cleanup();
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => resolve(a !== null && typeof a === "object" ? a.port : 0));
    });
  });
}

export async function startLanPv(
  opts: {
    mode?: "on" | "loopback";
    previewOff?: boolean;
    html?: boolean;
    wrapRoutes?: (r: PreviewRoutes) => PreviewRoutes;
    wrapLog?: (l: ReturnType<typeof captureLog>) => HubLog;
    /** web-hub-proxy XA: flip the frontend's multi-candidate duplicate-cookie option (default off). */
    multiCandidateAuth?: boolean;
  } = {},
): Promise<Lan> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-lan-pvhtml-"));
  const captured = captureLog();
  const log: HubLog = opts.wrapLog === undefined ? captured : opts.wrapLog(captured);
  const now = (): number => Date.now();
  const lanStore = fakeLanStore();
  const kdf = fakeKdf();
  const limiter = createLoginLimiter({ now });
  const admission = createKdfAdmission({ now, isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const scope = createScope({ log, now });
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const site = join(dir, "site");
  copyPvSite(site);
  const agents = new Map<string, AgentView>();
  agents.set(
    AGENT,
    makeAgent(AGENT, { kind: "tui", session: { sessionId: SESSION, cwd, reason: "t", leafId: null, mode: "tui" } }),
  );
  const registry = { list: () => [...agents.values()], get: (k: string) => agents.get(k) };
  const cfg: HubLanConfig = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
  const routes0 =
    opts.previewOff === true
      ? undefined
      : createPreviewRoutes({
          mode: opts.mode ?? "on",
          denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
          uploadsRoot: join(dir, "uploads"),
          registry,
          log,
          now,
          ...(opts.html === false ? {} : { html: {} }),
        });
  const routes = routes0 === undefined || opts.wrapRoutes === undefined ? routes0 : opts.wrapRoutes(routes0);
  const paths = testHubPaths(join(dir, "state"));
  const fe = createHttpFrontend({
    config: { v: 1, home: dir, port: 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths,
    registry,
    bus: { subscribe: () => () => undefined },
    history: {
      snapshot: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file" as const,
      }),
      page: async (agentKey: string) => ({
        agentKey,
        entries: [],
        tailMessages: [],
        fromSeq: 1,
        hasMore: false,
        source: "file" as const,
      }),
      onLeafChanged: () => {},
    },
    log,
    info: () => ({ version: "9.9.9-test", buildId: "b1", pid: process.pid, startedAt: now(), proto: PROTO }),
    now,
    lan: { cfg, store: lanStore, kdf, limiter, admission, hosts, scope, onStatus: () => undefined },
    ...(routes === undefined ? {} : { preview: routes }),
    // `multiCandidateAuth` is deliberately off the frozen FrontendDeps surface (FrontendIdentityDeps)
    ...(opts.multiCandidateAuth === true ? ({ multiCandidateAuth: true } as object) : {}),
  }) as Lan["fe"];
  const loopPort = (await fe.listen()).port;
  if (fe.lan === undefined) throw new Error("fe.lan missing");
  const st = await fe.lan.start();
  if (st.state !== "on") throw new Error(`LAN failed: ${JSON.stringify(st)}`);
  const lanPort = st.port;
  const loopCookie = await login(loopPort, paths.tokenFile);
  const q = `agentKey=${AGENT}&sessionId=${SESSION}`;
  const admin = createAdminHandler({
    log,
    hasLan: () => true,
    store: () => lanStore,
    kdf: () => kdf,
    limiter: () => limiter,
    lan: () => fe.lan,
    lanStatus: () => undefined,
    shutdown: () => undefined,
    now,
    auth: () => fe.auth as never,
    rotateIntentFile: join(dir, "rotate.json"),
    revokeLanSessions: () => undefined,
    revokeLoopbackSse: () => fe.revokeAllSse(),
    revokeLanSse: () => 0,
    bumpLanRevokeGen: () => undefined,
  });
  const l: Lan = {
    fe,
    lanPort,
    loopPort,
    site,
    dir,
    lanStore,
    routes,
    logLines: captured.lines,
    loopCookie,
    async lanCookie(id, user) {
      seedLanUser(lanStore, { id, username: user, password: "correct-horse-battery" });
      const r = await lanPostJson(lanPort, "/api/login", { username: user, password: "correct-horse-battery" });
      if (r.status !== 200) throw new Error(`login failed ${r.status}`);
      return (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    },
    mintLan: (cookie, extra = {}) =>
      lanPostJson(
        lanPort,
        `${PREVIEW_HTML_CAP_PATH}?${q}`,
        { path: join(site, "index.html") },
        { Cookie: cookie, ...extra },
      ),
    mintLoop: () =>
      postJson(loopPort, `${PREVIEW_HTML_CAP_PATH}?${q}`, { path: join(site, "index.html") }, { Cookie: loopCookie }),
    capOf(r) {
      if (r.status !== 200) throw new Error(`mint failed ${r.status} ${r.body}`);
      return (JSON.parse(r.body) as { url: string }).url.split("/")[2]!;
    },
    lanGet: (path, headers = {}) => lanRequest(lanPort, { path, headers }),
    loopGet: (path) => rawRequest(loopPort, { path }),
    passwd: (username) =>
      admin.handleLanReq(
        { t: "lan_req", rid: "r1", op: "passwd", username, password: "a-brand-new-password" },
        { agentKey: AGENT },
      ),
    async cleanup() {
      await routes?.dispose("close", createReqDeadline(now, 1_000));
      await fe.close();
      await scope.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  lans.push(l);
  return l;
}
