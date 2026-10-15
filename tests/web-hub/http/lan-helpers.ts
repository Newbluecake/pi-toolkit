/**
 * Shared harness for LAN HTTP tests (plan §11 LC row): spins up a real
 * `createHttpFrontend` with `deps.lan` populated from real `net-hosts.ts` /
 * `ratelimit.ts` / `kdf-admission.ts` / `conn-guard.ts` plus `tests/web-hub/
 * contract/fakes.ts`'s fake store/KDF — never a real SQLite-backed store
 * (LS's territory), per the task's "用 fakes.ts 的假 store/kdf，不依赖 LS
 * 实现".
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { verifyPassword } from "../../../src/web-hub/hub/lan-auth.js";
import type { PrivacyRoutes } from "../../../src/web-hub/hub/ports.js";
import { createPrivacyRoutes } from "../../../src/web-hub/hub/privacy/routes.js";
import { createPrivacyStore, type PrivacyStore } from "../../../src/web-hub/hub/privacy/store.js";
import { createLoginLimiter, type LoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { HubEvent, HubLanConfig, HubLoadConfig, HttpFrontend, LanStatus } from "../../../src/web-hub/hub/ports.js";
import type { CommandRouter } from "../../../src/web-hub/hub/ports.js";
import type { SpawnFrontendPort } from "../../../src/web-hub/hub/spawn/ports.js";
import type { AgentRemoveFrontendPort } from "../../../src/web-hub/hub/agent-remove.js";
import type { RegistryView } from "../../../src/web-hub/hub/ports.js";
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
  /** The configured LAN port (fixed at harness construction, before any `start()`/`close()` —
   * useful with `autoStart: false` when `status`/`port` haven't settled yet). */
  cfg: HubLanConfig;
  store: FakeLanStore;
  limiter: LoginLimiter;
  clock: FakeClock;
  logLines: LogLine[];
  /** web-hub-privacy P1: the real privacy store when `opts.privacy === true` (else undefined). */
  privacyStore?: PrivacyStore;
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
    /** Review fix (LC, plan §1.4/§3, W3 acceptance item 1): set `false` to get the harness back
     * *before* `fe.lan.start()` is called, so a test can control the timing of `start()`/`close()`
     * itself (e.g. to exercise the deadline or a close()∥start() race). `status`/`port` on the
     * returned harness are then just the pre-start placeholders (`{state:"starting"}` / `0`).  */
    autoStart?: boolean;
    /** plan §6.1/§6.3 (C3): a fake/real `CommandRouter` for `/api/cmd`/`/api/dialog` tests —
     * omitted (undefined) preserves every existing caller's behavior byte-for-byte (those
     * endpoints answer 501, same as before this option existed). */
    commands?: CommandRouter;
    /** web-hub-spawn plan §SP9: the spawn route frontend (`createSpawnRoutes` over the
     * spawn-kit fakes) — omitted keeps the LAN face byte-identical to not-enabled. */
    spawn?: SpawnFrontendPort;
    /** web-hub-delete-session plan v2 §2.9: the agent/managed-session removal route frontend
     * — omitted keeps `POST /api/agents/remove` on LAN at its legacy 404 (not-enabled). */
    agentRemove?: AgentRemoveFrontendPort;
    /** web-hub-delete-session plan v2 §2.9: lets a test supply a registry with a working
     * `.remove()` (the LAN `agentRemove` path's row-6 fallback needs one) — omitted keeps the
     * pre-existing empty stub (`list`/`get` only, no agents ever present). */
    registry?: RegistryView;
    /** web-hub load/top LAN budget regression: lets a test wire `config.load` (and therefore
     * `rt.load`/`GET /api/load/top`) through the SAME `createHttpFrontend` call the rest of this
     * harness builds — omitted keeps the LAN face byte-identical to not-enabled (404). */
    load?: HubLoadConfig;
    /** Lets a test supply its own (possibly latency-injecting) `FakeLanStore` — e.g. to simulate
     * a slow `touchSession` IPC round-trip. Omitted keeps the default in-memory `fakeLanStore()`. */
    store?: FakeLanStore;
    /** web-hub-privacy plan v2.1 (P1): `true` builds the REAL privacy store (tmpfs stateDir) +
     * routes over this harness's SAME store/kdf/limiter/admission instances (mirroring hub.ts's
     * assembly, incl. the shared login limiter) and wires `FrontendDeps.privacy` — omitted keeps
     * both `/api/privacy/*` paths at their byte-identical not-enabled 404s. */
    privacy?: boolean;
  } = {},
): Promise<LanHarness> {
  const dir = mkdtempSync(join(tmpdir(), "pwh-lan-"));
  let fe: HttpFrontend | undefined;
  let scope: ReturnType<typeof createScope> | undefined;
  const body = async (): Promise<LanHarness> => {
    const clock = opts.clock ?? fakeClock();
    const stateDir = join(dir, "state");
    const paths = testHubPaths(stateDir);
    const log = captureLog();
    const store = opts.store ?? fakeLanStore();
    const kdf = fakeKdf();
    const limiter = createLoginLimiter({ now: clock.now });
    const admission = createKdfAdmission({ now: clock.now, isTightened: limiter.isTightened });
    const hosts = createHostsPort();
    const scopeCreated = createScope({ log, now: clock.now });
    scope = scopeCreated;

    const subs = new Set<(e: HubEvent) => void>();

    const cfg: HubLanConfig = {
      port: opts.cfg?.port ?? (await freePort()),
      extraHosts: [],
      trustProxyFrom: [],
      externalOrigins: [],
      ...opts.cfg,
    };

    let lastStatus: LanStatus = { state: "starting" };

    // web-hub-privacy plan v2.1 (P1): assembled exactly like hub.ts does — the store loads from
    // the harness's tmpfs stateDir, and `verifyPassword` shares the login pipeline's limiter/kdf/
    // admission instances (the「limiter 共享」test anchor depends on that instance identity).
    let privacyRoutes: PrivacyRoutes | undefined;
    let privacyStore: PrivacyStore | undefined;
    if (opts.privacy === true) {
      // hub.ts's `ensurePrivateDir` equivalent — the harness never creates stateDir on its own.
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      privacyStore = createPrivacyStore({ stateDir, log });
      await privacyStore.load();
      privacyRoutes = createPrivacyRoutes({
        store: privacyStore,
        registry: opts.registry ?? { list: () => [], get: () => undefined },
        verifyPassword: (userId, password, clientIp) =>
          verifyPassword({ clientIp }, userId, password, { store, kdf, limiter, admission }),
        log,
        now: clock.now,
      });
    }

    const feCreated = createHttpFrontend({
      config: {
        v: 1,
        home: dir,
        port: 0,
        idleExitMinutes: 10,
        pluginVersion: "0.0.0-test",
        buildId: "b1",
        ...(opts.load === undefined ? {} : { load: opts.load }),
      },
      paths,
      registry: opts.registry ?? { list: () => [], get: () => undefined },
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
      lan: { cfg, store, kdf, limiter, admission, hosts, scope: scopeCreated, onStatus: (s) => (lastStatus = s) },
      ...(opts.commands === undefined ? {} : { commands: opts.commands }),
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
      ...(opts.agentRemove === undefined ? {} : { agentRemove: opts.agentRemove }),
      ...(privacyRoutes === undefined ? {} : { privacy: privacyRoutes }),
    });
    fe = feCreated;

    if (feCreated.lan === undefined) throw new Error("test bug: fe.lan not constructed");
    const autoStart = opts.autoStart ?? true;
    let status: LanStatus = lastStatus;
    let port = 0;
    if (autoStart) {
      status = await feCreated.lan.start();
      lastStatus = status;
      port = status.state === "on" ? status.port : 0;
    }

    return {
      fe: feCreated,
      status,
      port,
      cfg,
      store,
      limiter,
      clock,
      logLines: log.lines,
      ...(privacyStore === undefined ? {} : { privacyStore }),
      async cleanup() {
        await feCreated.close();
        await scopeCreated.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };
  try {
    return await body();
  } catch (err) {
    // fail-safe: any throw between mkdtemp and the returned cleanup must not leak the temp dir
    try {
      await fe?.close();
      await scope?.dispose();
    } catch {
      // best effort — releasing the temp dir matters more
    }
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
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
    /**
     * TCP dial target — defaults to `127.0.0.1`, which is what the LC unit suites in this
     * directory want: they intentionally send a *spoofed* `Host`/`X-Forwarded-Host` header over
     * a real loopback connection to exercise the allow-list/origin logic without needing a
     * second real interface. That trick stops working once `trustProxyFrom` contains
     * `127.0.0.1` (a common real deployment: a local reverse proxy) — per plan §2.4/§6.3,
     * `resolveProxy` treats *every* connection whose peer is a `trustProxyFrom` entry as arriving
     * via that proxy, headers or not, so a same-peer "direct" request would 400 on missing
     * `X-Forwarded-*` instead of exercising the direct path at all. `destHost` lets a caller (the
     * LI e2e suite, `tests/integration/web-hub-lan.test.ts`) actually dial the machine's real
     * non-loopback LAN address so the peer IP is genuinely outside `trustProxyFrom`.
     */
    destHost?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      {
        host: opts.destHost ?? "127.0.0.1",
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

export interface SseEvent {
  event: string;
  data: unknown;
}

function parseFrames(chunk: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of chunk.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length > 0) out.push({ event, data: JSON.parse(dataLines.join("\n")) });
  }
  return out;
}

/** Opens a real SSE connection (raw `node:http`, no `EventSource` polyfill needed for tests). */
export async function openSse(
  port: number,
  cookie: string,
): Promise<{ events: SseEvent[]; waitFor(event: string, ms?: number): Promise<SseEvent>; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/events",
      headers: { Host: `127.0.0.1:${port}`, Cookie: cookie, Accept: "text/event-stream" },
    });
    req.on("error", reject);
    req.end();
    req.on("response", (res) => {
      const events: SseEvent[] = [];
      const waiters: Array<() => void> = [];
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) events.push(...parseFrames(p + "\n\n"));
        for (const w of [...waiters]) w();
      });
      resolve({
        events,
        close: () => req.destroy(),
        waitFor(eventName, ms = 3_000) {
          return new Promise((res2, rej2) => {
            const check = (): boolean => {
              const hit = events.find((e) => e.event === eventName);
              if (hit !== undefined) {
                cleanup();
                res2(hit);
                return true;
              }
              return false;
            };
            const timer = setTimeout(() => {
              cleanup();
              rej2(new Error(`waitFor(${eventName}) timeout; got ${events.map((e) => e.event).join(",")}`));
            }, ms);
            const cleanup = (): void => {
              clearTimeout(timer);
              const i = waiters.indexOf(onEv);
              if (i >= 0) waiters.splice(i, 1);
            };
            const onEv = (): void => {
              check();
            };
            if (!check()) waiters.push(onEv);
          });
        },
      });
    });
  });
}

export function lanPostJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  localAddress?: string,
  destHost?: string,
): Promise<RawResponse> {
  const host = headers.Host ?? `127.0.0.1:${port}`;
  const origin = headers.Origin ?? `http://${host}`;
  return lanRequest(port, {
    method: "POST",
    path,
    headers: { ...LAN_JSON_HEADERS, Origin: origin, ...headers },
    body: JSON.stringify(body),
    ...(localAddress === undefined ? {} : { localAddress }),
    ...(destHost === undefined ? {} : { destHost }),
  });
}

/** Seed a LAN user (bypassing the (LI/LD-owned) admin passwd flow, which is not part of LC's scope). */
export function seedLanUser(
  store: FakeLanStore,
  opts: {
    id?: number;
    username: string;
    password: string;
    initial?: boolean;
    /** §5.1 "读取校验" review-fix tests (LC #2): seed a corrupt KDF params row (e.g. `n` not a
     * power of 2) without ever feeding it to real scrypt — mirrors `tests/web-hub/hub/lan-auth.
     * test.ts`'s local `seedUser` override. */
    kdfOverride?: Partial<{ n: number; r: number; p: number }>;
  },
): void {
  const salt = Buffer.alloc(16, 7);
  const n = opts.kdfOverride?.n ?? 16384;
  const r = opts.kdfOverride?.r ?? 8;
  const p = opts.kdfOverride?.p ?? 1;
  const validParams = Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0 && 128 * n * r <= 32 * 1024 * 1024;
  const hash = validParams
    ? scryptSync(opts.password, salt, 32, { N: n, r, p, maxmem: 128 * n * r + 1024 * 1024 })
    : Buffer.alloc(32, 1); // corrupt params never actually get fed to scrypt for real
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
