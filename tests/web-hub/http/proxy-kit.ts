/**
 * Real-hub harness for the web-hub port-proxy wiring tests (X1c: T-H8 / T-A1 / T-A2).
 *
 * Everything is real except the LAN store/KDF (the W1 fakes every LAN harness uses) and the
 * upstream (`tests/fixtures/proxy-upstream.ts`): a REAL `startHub` (hub.ts composes the proxy
 * service/routes itself), the real `createHttpFrontend`, both listeners, the real hub.log file.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type {
  FrontendDeps,
  FrontendFactory,
  HubConfig,
  LanAssembly,
  LanFrontendDeps,
} from "../../../src/web-hub/hub/ports.js";
import type { ProxyOpenResult } from "../../../src/web-hub/protocol/proxy.js";
import { fakeKdf, fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { proxyUpstream } from "../../fixtures/proxy-upstream.js";
import { config } from "../hub/helpers.js";
import { login, rawRequest, type RawResponse } from "./helpers.js";
import { lanPostJson, seedLanUser } from "./lan-helpers.js";

import { freePort, freePortRange } from "../../helpers/free-port.js";

/** Thin re-export of tests/helpers/free-port.ts (kept for existing imports). */
export async function freeTcpPort(): Promise<number> {
  return await freePort();
}

/** A 16-port range that excludes every `avoid` port (+1 guard). */
export async function freeProxyRange(avoid: readonly number[]): Promise<[number, number]> {
  for (let i = 0; i < 64; i++) {
    const [base, last] = await freePortRange(16);
    if (avoid.some((p) => p >= base - 1 && p <= last + 1)) continue;
    return [base, last];
  }
  throw new Error("no free proxy range");
}

export interface ProxyHubOpts {
  /** `false` ⇒ the hub is started WITHOUT `config.proxy` (the off baseline). Default: on. */
  proxy?: boolean | { maxProxies?: number };
  /** LAN listener (fake store) — optionally behind a trusted reverse proxy. */
  lan?: boolean | { trustProxyFrom: string[]; externalOrigins: string[] };
  /** Occupy `config.port` first so the hub falls back to a random port. */
  occupyHubPort?: boolean;
  /** Wrap the real frontend factory (e.g. to break `ui.refresh` for the startup-failure test). */
  wrapFrontend?: (
    deps: FrontendDeps,
    fe: ReturnType<typeof createHttpFrontend>,
  ) => ReturnType<typeof createHttpFrontend>;
}

export interface ProxyHub {
  hub: RunningHub;
  home: string;
  stateDir: string;
  port: number;
  cookie: string;
  range: [number, number];
  up: Awaited<ReturnType<typeof proxyUpstream>>;
  lanStore: FakeLanStore | undefined;
  deps: FrontendDeps;
  configured: HubConfig;
  /** Loopback JSON API call with the hub cookie + same-origin headers (override anything). */
  api(
    method: "GET" | "POST",
    path: string,
    opts?: { body?: unknown; headers?: Record<string, string>; cookie?: string | null; port?: number },
  ): Promise<RawResponse>;
  /** `POST /api/proxy/open` on loopback; throws unless 200. */
  open(target?: string): Promise<ProxyOpenResult>;
  lanPort(): Promise<number>;
  /** Log in a seeded LAN user (through the trusted reverse proxy when so configured). */
  lanLogin(username?: string): Promise<{ cookie: string; origin: string; headers: Record<string, string> }>;
  logText(): string;
  http(
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>;
  cleanup(): Promise<void>;
}

const live: ProxyHub[] = [];
export async function cleanupProxyHubs(): Promise<void> {
  for (const h of live.splice(0)) await h.cleanup();
}

export async function startProxyHub(opts: ProxyHubOpts = {}): Promise<ProxyHub> {
  const home = mkdtempSync(join(tmpdir(), "pwh-proxy-wire-"));
  const up = await proxyUpstream();
  const range = await freeProxyRange([up.port]);
  const blockers: Server[] = [];
  let hubPort = 0;
  if (opts.occupyHubPort === true) {
    const blocker = createNetServer();
    blocker.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => blocker.once("listening", resolve));
    hubPort = (blocker.address() as { port: number }).port;
    blockers.push(blocker);
  }
  let lanStore: FakeLanStore | undefined;
  const lanOpt = opts.lan === undefined || opts.lan === false ? undefined : opts.lan;
  const lanCfgPort = lanOpt === undefined ? undefined : await freeTcpPort();
  const lanAssembly: LanAssembly | undefined =
    lanOpt === undefined
      ? undefined
      : {
          async build(args): Promise<LanFrontendDeps> {
            lanStore = fakeLanStore();
            const limiter = createLoginLimiter({ now: args.now });
            return {
              cfg: args.cfg,
              store: lanStore,
              kdf: fakeKdf(),
              limiter,
              admission: createKdfAdmission({ now: args.now, isTightened: () => limiter.isTightened() }),
              hosts: createHostsPort(),
              scope: args.scope,
              onStatus: args.onStatus,
            };
          },
        };
  const proxyOpt = opts.proxy === undefined ? true : opts.proxy;
  const configured = config({
    home,
    port: hubPort,
    ...(proxyOpt === false
      ? {}
      : { proxy: { portRange: range, maxProxies: typeof proxyOpt === "object" ? (proxyOpt.maxProxies ?? 8) : 8 } }),
    ...(lanOpt === undefined
      ? {}
      : {
          lan: {
            port: lanCfgPort!,
            extraHosts: [],
            trustProxyFrom: lanOpt === true ? [] : lanOpt.trustProxyFrom,
            externalOrigins: lanOpt === true ? [] : lanOpt.externalOrigins,
          },
        }),
  });
  let captured: FrontendDeps | undefined;
  const factory: FrontendFactory = (d) => {
    captured = d;
    const fe = createHttpFrontend(d);
    return opts.wrapFrontend === undefined ? fe : opts.wrapFrontend(d, fe);
  };
  let hub: RunningHub;
  try {
    const started = await startHub(configured, factory, {
      uid: process.getuid?.() ?? 0,
      ...(lanAssembly === undefined ? {} : { lanAssembly }),
    });
    if ("exists" in started) throw new Error("unexpected exists");
    hub = started;
  } catch (err) {
    await up.close();
    for (const b of blockers) b.close();
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
  const port = hub.httpPort;
  const cookie = await login(port, hub.paths.tokenFile);
  const trusted = lanOpt !== undefined && lanOpt !== true;
  const self: ProxyHub = {
    hub,
    home,
    stateDir: hub.paths.stateDir,
    port,
    cookie,
    range,
    up,
    get lanStore() {
      return lanStore;
    },
    deps: captured!,
    configured,
    api(method, path, o = {}) {
      const p = o.port ?? port;
      return rawRequest(p, {
        method,
        path,
        headers: {
          "X-PWH": "1",
          Origin: `http://127.0.0.1:${p}`,
          ...(o.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(o.cookie === null ? {} : { Cookie: o.cookie ?? cookie }),
          ...(o.headers ?? {}),
        },
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      });
    },
    async open(target = `127.0.0.1:${up.port}`) {
      const r = await self.api("POST", "/api/proxy/open", { body: { target } });
      if (r.status !== 200) throw new Error(`open failed: ${r.status} ${r.body}`);
      return JSON.parse(r.body) as ProxyOpenResult;
    },
    async lanPort() {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const st = hub.lanStatus();
        if (st !== undefined && st.state === "on") return st.port;
        if (Date.now() > deadline) throw new Error(`LAN never came up: ${JSON.stringify(st)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async lanLogin(username = "alice") {
      const lp = await self.lanPort();
      seedLanUser(lanStore!, { id: 7, username, password: "correct-horse-battery" });
      const origin = trusted ? lanOpt.externalOrigins[0]! : `http://127.0.0.1:${lp}`;
      const headers: Record<string, string> = trusted
        ? { "X-Forwarded-Proto": "https", "X-Forwarded-Host": new URL(origin).host, Origin: origin }
        : { Origin: origin };
      const r = await lanPostJson(lp, "/api/login", { username, password: "correct-horse-battery" }, headers);
      if (r.status !== 200) throw new Error(`lan login failed: ${r.status} ${r.body}`);
      return { cookie: (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!, origin, headers };
    },
    logText() {
      try {
        return readFileSync(hub.paths.logFile, "utf8");
      } catch {
        return "";
      }
    },
    http(url, o = {}) {
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: Number(u.port),
            path: u.pathname + u.search,
            method: o.method ?? "GET",
            headers: { Host: u.host, ...(o.headers ?? {}) },
            agent: false,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (b: Buffer) => chunks.push(b));
            res.on("error", reject);
            res.on("end", () =>
              resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        req.on("error", reject);
        req.setTimeout(5_000, () => req.destroy(new Error("test http timeout")));
        req.end(o.body);
      });
    },
    async cleanup() {
      try {
        await hub.close("test");
      } finally {
        await up.close();
        for (const b of blockers) b.close();
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
  live.push(self);
  return self;
}
