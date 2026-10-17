/**
 * Shared kit for the web-hub HTML preview (P1b) HTTP tests: fixture-tree copy, a scripted
 * `PreviewFs` seam (pause / observe individual fs ops of the `/pv` flow), an fd counter, and a
 * loopback harness over the REAL `createHttpFrontend` + `createPreviewRoutes({ html })`.
 */
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { denyCtxOf } from "../../../src/web-hub/hub/preview/admit.js";
import { defaultPreviewFs } from "../../../src/web-hub/hub/preview/fs.js";
import { createPreviewRoutes, type PreviewRoutesDeps } from "../../../src/web-hub/hub/preview/routes.js";
import type { PreviewFs, PreviewHandle } from "../../../src/web-hub/hub/preview/admit.js";
import type { FrontendDeps, HttpFrontend, PreviewRoutes } from "../../../src/web-hub/hub/ports.js";
import { webHubUploadsDir } from "../../../src/web-hub/protocol/paths.js";
import { PREVIEW_HTML_CAP_PATH, PV_CAP_RE } from "../../../src/web-hub/protocol/preview-html.js";
import { createReqDeadline } from "../../../src/web-hub/hub/req-deadline.js";
import { fakeDeps, login, makeAgent, postJson, rawRequest, type FakeDeps, type RawResponse } from "./helpers.js";

export const AGENT = "a4242-nonce12";
export const SESSION = "sess123";

export const PV_SITE = fileURLToPath(new URL("../../fixtures/pv-site", import.meta.url));

export function copyPvSite(dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(PV_SITE, dest, { recursive: true });
}

/** Number of open fds of this process (the `/proc/self/fd` listing itself adds one, constantly). */
export function fdCount(): number {
  return readdirSync("/proc/self/fd").length;
}

export async function waitUntil(pred: () => boolean, timeoutMs = 4_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// scripted fs
// ---------------------------------------------------------------------------

export type FsOpName = "realpath" | "stat" | "open" | "readlink";
export type FsHook = (op: FsOpName, arg: string, flags?: number) => Promise<void> | void;

export interface ScriptedFs {
  fs: Partial<PreviewFs>;
  /** awaited before every real op (in registration order). */
  hooks: FsHook[];
  /** wraps every handle `open` returns (file or dir; `flags` tells them apart). */
  wrapHandle?: ((fh: PreviewHandle, arg: string, flags: number) => PreviewHandle) | undefined;
}

export function scriptedFs(): ScriptedFs {
  const real = defaultPreviewFs();
  const s: ScriptedFs = { fs: {}, hooks: [] };
  const run = async (op: FsOpName, arg: string, flags?: number): Promise<void> => {
    for (const h of [...s.hooks]) await h(op, arg, flags);
  };
  s.fs = {
    realpath: async (p) => {
      await run("realpath", p);
      return real.realpath(p);
    },
    stat: async (p) => {
      await run("stat", p);
      return real.stat(p);
    },
    readlink: async (p) => {
      await run("readlink", p);
      return real.readlink(p);
    },
    open: async (p, flags) => {
      await run("open", p, flags);
      const fh = await real.open(p, flags);
      return s.wrapHandle === undefined ? fh : s.wrapHandle(fh, p, flags);
    },
  };
  return s;
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// loopback harness
// ---------------------------------------------------------------------------

export interface PvHarness {
  deps: FakeDeps;
  fe: HttpFrontend & { auth: { check: (...a: never[]) => boolean }; revokeAllSse(): number };
  routes: PreviewRoutes;
  port: number;
  cookie: string;
  /** the hub "home" (also the deny context's home). */
  dir: string;
  /** a copy of the pv-site fixture inside `dir`. */
  site: string;
  logLines: FakeDeps["logLines"];
  mint(path: string, opts?: { headers?: Record<string, string>; agentKey?: string }): Promise<RawResponse>;
  /** mint + parse: returns the cap and the two URLs (throws unless 200). */
  mintOk(path?: string): Promise<{ cap: string; url: string; openUrl: string; body: Record<string, unknown> }>;
  get(path: string, headers?: Record<string, string>): Promise<RawResponse>;
  logout(): Promise<RawResponse>;
  cleanup(): Promise<void>;
}

export async function startPvHarness(
  opts: {
    html?: PreviewRoutesDeps["html"] | false;
    mode?: "on" | "loopback";
    /** wraps / replaces the routes instance handed to the frontend (fault injection). */
    wrapRoutes?: (r: PreviewRoutes) => PreviewRoutes;
    now?: () => number;
    /** uploads root relative to the hub home (default: the real `webHubUploadsDir(home)`, which
     * sits under the agent dir and is therefore already denylisted by the admitter). */
    uploadsRootRel?: string;
  } = {},
): Promise<PvHarness> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-pvhtml-"));
  const deps = fakeDeps(dir);
  if (opts.now !== undefined) deps.now = opts.now;
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  const site = join(dir, "site");
  copyPvSite(site);
  deps.agents.set(
    AGENT,
    makeAgent(AGENT, { session: { sessionId: SESSION, cwd, reason: "test", leafId: null, mode: "tui" } }),
  );
  const routes0 = createPreviewRoutes({
    mode: opts.mode ?? "on",
    denyCtx: denyCtxOf(dir, join(dir, ".pi/agent")),
    uploadsRoot: opts.uploadsRootRel === undefined ? webHubUploadsDir(dir) : join(dir, opts.uploadsRootRel),
    registry: deps.registry,
    log: deps.log,
    now: deps.now,
    ...(opts.html === false ? {} : { html: opts.html ?? {} }),
  });
  const routes = opts.wrapRoutes === undefined ? routes0 : opts.wrapRoutes(routes0);
  (deps as FrontendDeps).preview = routes;
  const fe = createHttpFrontend(deps) as PvHarness["fe"];
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  const q = (agentKey: string): string =>
    `agentKey=${encodeURIComponent(agentKey)}&sessionId=${encodeURIComponent(SESSION)}`;
  const h: PvHarness = {
    deps,
    fe,
    routes,
    port,
    cookie,
    dir,
    site,
    logLines: deps.logLines,
    mint: (path, o = {}) =>
      postJson(port, `${PREVIEW_HTML_CAP_PATH}?${q(o.agentKey ?? AGENT)}`, { path }, { Cookie: cookie, ...o.headers }),
    async mintOk(path = join(site, "index.html")) {
      const r = await h.mint(path);
      if (r.status !== 200) throw new Error(`mint failed: ${r.status} ${r.body}`);
      const body = JSON.parse(r.body) as { url: string; openUrl: string };
      const cap = body.url.split("/")[2] ?? "";
      if (!PV_CAP_RE.test(cap)) throw new Error(`bad cap in ${body.url}`);
      return { cap, url: body.url, openUrl: body.openUrl, body };
    },
    get: (path, headers = {}) => rawRequest(port, { path, headers }),
    logout: () => postJson(port, "/api/logout", {}, { Cookie: cookie }),
    async cleanup() {
      // hub.ts disposes the preview routes between spawn shutdown and `fe.close()`; mirror it so
      // held dir fds are closed explicitly (a GC close would warn and mask real leaks).
      await routes.dispose("close", createReqDeadline(deps.now, 1_000));
      await fe.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Stream a GET and hand back the live response so a test can pause/destroy it. */
export function openGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ res: IncomingMessage; destroy(): void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: `127.0.0.1:${port}`, ...headers },
        agent: false,
      },
      (res) => resolve({ res, destroy: () => req.destroy() }),
    );
    req.on("error", reject);
    req.end();
  });
}

export function writeSiteFile(site: string, rel: string, content: string | Buffer): void {
  const p = join(site, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}
