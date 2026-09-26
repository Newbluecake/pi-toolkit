/**
 * Shared harness for LAN HTTP tests (plan §11 LC row): spins up a real
 * `createHttpFrontend` with `deps.lan` populated from real `net-hosts.ts` /
 * `ratelimit.ts` / `kdf-admission.ts` / `conn-guard.ts` plus `tests/web-hub/
 * contract/fakes.ts`'s fake store/KDF — never a real SQLite-backed store
 * (LS's territory), per the task's "用 fakes.ts 的假 store/kdf，不依赖 LS
 * 实现".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { scryptSync } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeKdf, fakeLanStore, type FakeLanStore } from "../contract/fakes.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter, type LoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { HubEvent, HubLanConfig, HttpFrontend, LanStatus } from "../../../src/web-hub/hub/ports.js";
import { PROTO } from "../../../src/web-hub/protocol/version.js";
import { captureLog, type LogLine } from "./helpers.js";
import { testHubPaths } from "../helpers/paths.js";

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export interface LanHarness {
  fe: HttpFrontend;
  status: LanStatus;
  port: number;
  store: FakeLanStore;
  limiter: LoginLimiter;
  clock: FakeClock;
  logLines: LogLine[];
  cleanup(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startLan(
  opts: {
    cfg?: Partial<HubLanConfig>;
    clock?: FakeClock;
  } = {},
): Promise<LanHarness> {
  const clock = opts.clock ?? fakeClock();
  const dir = mkdtempSync(join(tmpdir(), "pwh-lan-"));
  const stateDir = join(dir, "state");
  const paths = testHubPaths(stateDir);
  const log = captureLog();
  const store = fakeLanStore();
  const kdf = fakeKdf();
  const limiter = createLoginLimiter({ now: clock.now });
  const admission = createKdfAdmission({ now: clock.now, isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const scope = createScope({ log, now: clock.now });

  const subs = new Set<(e: HubEvent) => void>();

  const cfg: HubLanConfig = {
    port: opts.cfg?.port ?? (await freePort()),
    extraHosts: [],
    trustProxyFrom: [],
    externalOrigins: [],
    ...opts.cfg,
  };

  let lastStatus: LanStatus = { state: "starting" };

  const fe = createHttpFrontend({
    config: { v: 1, home: dir, port: 0, idleExitMinutes: 10, pluginVersion: "0.0.0-test", buildId: "b1" },
    paths,
    registry: { list: () => [], get: () => undefined },
    bus: {
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    },
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
    info: () => ({ version: "9.9.9-test", buildId: "b1", pid: process.pid, startedAt: clock.now(), proto: PROTO }),
    now: clock.now,
    lan: { cfg, store, kdf, limiter, admission, hosts, scope, onStatus: (s) => (lastStatus = s) },
  });

  if (fe.lan === undefined) throw new Error("test bug: fe.lan not constructed");
  const status = await fe.lan.start();
  lastStatus = status;
  const port = status.state === "on" ? status.port : 0;

  return {
    fe,
    status,
    port,
    store,
    limiter,
    clock,
    logLines: log.lines,
    async cleanup() {
      await fe.close();
      await scope.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RawResponse {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

export function lanRequest(
  port: number,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    host?: string;
    localAddress?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers,
        agent: false,
        ...(opts.localAddress === undefined ? {} : { localAddress: opts.localAddress }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export const LAN_JSON_HEADERS = { "Content-Type": "application/json", "X-PWH": "1" } as const;

export function lanPostJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  localAddress?: string,
): Promise<RawResponse> {
  const host = headers.Host ?? `127.0.0.1:${port}`;
  const origin = headers.Origin ?? `http://${host}`;
  return lanRequest(port, {
    method: "POST",
    path,
    headers: { ...LAN_JSON_HEADERS, Origin: origin, ...headers },
    body: JSON.stringify(body),
    ...(localAddress === undefined ? {} : { localAddress }),
  });
}

/** Seed a LAN user (bypassing the (LI/LD-owned) admin passwd flow, which is not part of LC's scope). */
export function seedLanUser(
  store: FakeLanStore,
  opts: { id?: number; username: string; password: string; initial?: boolean },
): void {
  const salt = Buffer.alloc(16, 7);
  const n = 16384;
  const r = 8;
  const p = 1;
  const hash = scryptSync(opts.password, salt, 32, { N: n, r, p, maxmem: 128 * n * r + 1024 * 1024 });
  store.seedUser({
    id: opts.id ?? 1,
    username: opts.username,
    kdf: "scrypt",
    n,
    r,
    p,
    salt,
    hash,
    epoch: 1,
    ...(opts.initial === true ? { initialPassword: opts.password, initialCreatedAt: Date.now() } : {}),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}
