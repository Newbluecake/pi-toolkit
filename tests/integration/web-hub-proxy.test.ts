/**
 * web-hub-proxy v2 + R1/R2, T-I1: REAL hub/main.ts children through pi's bundled jiti.
 * Reuses the spawnHub/resolveJitiCli path from web-hub-spawn and the HTTP/socket harnesses.
 * Only the upstream is a fixture; no in-process startHub, service seams or fake auth.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJitiCli, spawnHub } from "../../src/web-hub/agent/launcher.js";
import type { HubConfig } from "../../src/web-hub/hub/ports.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import type { ProxyOpenResult } from "../../src/web-hub/protocol/proxy.js";
import { PROXY_HUB_CAP, PROXY_LAN_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import { proxyUpstream } from "../fixtures/proxy-upstream.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { config, connectClient, hello } from "../web-hub/hub/helpers.js";
import { login, postJson, rawRequest } from "../web-hub/http/helpers.js";

const PI_CLI = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const HUB_MAIN = resolve("src/web-hub/hub/main.ts");
const homes = new Set<string>();
const children = new Set<HubChild>();
const reservations = new Set<Server>();
const clients = new Set<Socket>();
const upstreams = new Set<Awaited<ReturnType<typeof proxyUpstream>>>();

interface HubChild {
  child: ChildProcess;
  stderr: string;
  done: boolean;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Every async wait is bounded, including cleanup after an assertion/startup failure. */
async function bounded<T>(promise: Promise<T>, label: string, ms = 8_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function release(server: Server): Promise<void> {
  if (!reservations.delete(server)) return;
  await bounded(new Promise<void>((resolve) => server.close(() => resolve())), "port reservation close");
}

/**
 * Reserve EVERY port, not just a free base + unchecked neighbours. Use a low, non-ephemeral
 * band so concurrent HTTP clients cannot steal a chosen port as their ephemeral source port.
 * Hold reservations through hub startup (port:0 cannot land inside the proxy range), and
 * release immediately before minting. EADDRINUSE retries only happen HERE, never around tests.
 */
async function reserveRange(avoid: readonly number[] = []): Promise<{
  range: [number, number];
  release(): Promise<void>;
}> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const lo = randomInt(16_000, 28_000);
    const range: [number, number] = [lo, lo + 7];
    if (avoid.some((p) => p >= range[0] && p <= range[1])) continue;
    const held: Server[] = [];
    try {
      for (let port = range[0]; port <= range[1]; port++) {
        const server = createServer();
        reservations.add(server);
        held.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
        server.unref();
      }
      return { range, release: async () => void (await Promise.all(held.map(release))) };
    } catch (err) {
      await Promise.all(held.map(release));
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("could not reserve a complete proxy range");
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pwh-proxy-child-"));
  homes.add(home);
  return home;
}

async function boot(cfg: HubConfig) {
  const launcher = resolveJitiCli({ argv1: PI_CLI, override: "" });
  // A hard integration gate must fail clearly, not silently return/pass if dev deps are absent.
  if (!launcher.ok) throw new Error(`pi bundled jiti unavailable: ${launcher.reason}`);
  let tracked: HubChild | undefined;
  const observeSpawn: typeof spawn = ((file, args, options) => {
    const child = spawn(file, args, {
      ...options,
      detached: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...options?.env, HOME: cfg.home, XDG_RUNTIME_DIR: "" },
    });
    const live: HubChild = {
      child,
      stderr: "",
      done: false,
      exit: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          live.done = true;
          resolve({ code, signal });
        });
      }),
    };
    // boot polls done too; attach a rejection observer even if spawn fails before readiness.
    void live.exit.catch(() => undefined);
    child.stderr?.on("data", (b: Buffer) => (live.stderr += b.toString("utf8")));
    children.add(live);
    tracked = live;
    return child;
  }) as typeof spawn;
  spawnHub({ execPath: process.execPath, jitiCli: launcher.jitiCli, argv1: PI_CLI }, HUB_MAIN, cfg, observeSpawn);
  if (tracked === undefined) throw new Error("spawnHub did not start a child");
  const live: HubChild = tracked;
  const paths = resolveHubPaths({ home: cfg.home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: undefined });
  let port = 0;
  try {
    await waitUntil(
      () => {
        if (live.done) throw new Error(`hub exited before ready: ${live.stderr}`);
        try {
          const record = JSON.parse(readFileSync(paths.hubJson, "utf8"));
          if (record.pid !== live.child.pid || !Number.isInteger(record.port)) return false;
          port = record.port;
          return port > 0;
        } catch {
          return false;
        }
      },
      20_000,
      "child hub.json (matching pid)",
    );
  } catch (err) {
    throw new Error(`${String(err)}; stderr: ${live.stderr}`);
  }
  const cookie = await login(port, paths.tokenFile);
  return {
    live,
    paths,
    port,
    cookie,
    api: (method: "GET" | "POST", path: string, body?: unknown) =>
      method === "POST"
        ? postJson(port, path, body, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` })
        : rawRequest(port, { path, headers: { Cookie: cookie, "X-PWH": "1" } }),
    async caps(): Promise<string[]> {
      const agent = await connectClient(paths.socketPath);
      clients.add(agent.sock);
      try {
        agent.send(hello({ agentId: { pid: process.pid, nonce: "proxyintegration0001" } }));
        const ack = await agent.waitFrame((f) => f["t"] === "hello_ack");
        expect(Array.isArray(ack["caps"])).toBe(true);
        return ack["caps"] as string[];
      } finally {
        agent.sock.destroy();
      }
    },
  };
}

type Hub = Awaited<ReturnType<typeof boot>>;
async function open(hub: Hub, target: string): Promise<ProxyOpenResult> {
  const r = await hub.api("POST", "/api/proxy/open", { target });
  expect(r.status, r.body).toBe(200);
  const opened = JSON.parse(r.body) as ProxyOpenResult;
  expect(opened.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  return opened;
}

function proxyRequest(url: string, cookie?: string) {
  const u = new URL(url);
  return rawRequest(Number(u.port), {
    path: u.pathname + u.search,
    ...(cookie === undefined ? {} : { headers: { Cookie: cookie } }),
  });
}

async function enter(opened: ProxyOpenResult) {
  const r = await proxyRequest(opened.enterUrl);
  expect(r.status, r.body).toBe(303);
  const setCookie = r.headers["set-cookie"]?.[0] ?? "";
  expect(setCookie).toMatch(new RegExp(`^pwh_px_${new URL(opened.origin).port}=`));
  expect(setCookie).toMatch(/; HttpOnly/i);
  expect(setCookie).toMatch(/; SameSite=Lax/i);
  expect(r.headers.location).toBe("/echo?via=integration");
  return setCookie.split(";")[0]!;
}

async function echoWs(opened: ProxyOpenResult, cookie: string) {
  const u = new URL(opened.origin);
  const socket = connect(Number(u.port), "127.0.0.1");
  clients.add(socket);
  let closed = false;
  socket.on("error", () => undefined);
  socket.once("close", () => (closed = true));
  const chunks: Buffer[] = [];
  socket.on("data", (b: Buffer) => chunks.push(b));
  await bounded(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    "WS TCP connect",
  );
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: ${u.host}\r\nCookie: ${cookie}\r\nOrigin: ${opened.origin}\r\n` +
      "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  );
  await waitUntil(() => Buffer.concat(chunks).includes("\r\n\r\n") || closed, 5_000, "WS handshake");
  const head = Buffer.concat(chunks).toString("utf8").split("\r\n\r\n")[0]!;
  expect(head).toMatch(/^HTTP\/1\.1 101 /);
  expect(head.toLowerCase()).toContain("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=");
  const bodyAt = Buffer.concat(chunks).indexOf("\r\n\r\n") + 4;
  // The fixture echoes raw frames. Send a real masked client text frame and compare all bytes,
  // rather than treating 101 / a successful connect as evidence that the tunnel forwards data.
  const payload = Buffer.from("X3 echo");
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | payload.length]),
    mask,
    Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)),
  ]);
  socket.write(frame);
  await waitUntil(() => Buffer.concat(chunks).length >= bodyAt + frame.length || closed, 5_000, "WS echo bytes");
  expect(Buffer.concat(chunks).subarray(bodyAt)).toEqual(frame);
  return { socket, closed: () => closed };
}

async function expectRefused(port: number): Promise<void> {
  await expect(rawRequest(port, { path: "/" })).rejects.toMatchObject({ code: "ECONNREFUSED" });
}

async function terminate(hub: Hub): Promise<void> {
  expect(hub.live.done).toBe(false);
  expect(hub.live.child.kill("SIGTERM")).toBe(true);
  expect(await bounded(hub.live.exit, "SIGTERM clean hub exit", 12_000), hub.live.stderr).toEqual({
    code: 0,
    signal: null,
  });
  expect(hub.live.stderr).not.toMatch(/uncaught|unhandled|EADDRINUSE/);
  await expectRefused(hub.port);
}

afterEach(async () => {
  // All children are registered synchronously at spawn, even if boot/login/assertions fail.
  for (const socket of clients) socket.destroy();
  clients.clear();
  try {
    await Promise.all(
      [...children].map(async (live) => {
        if (!live.done) live.child.kill("SIGTERM");
        try {
          await bounded(live.exit, "cleanup TERM", 12_000);
        } catch {
          live.child.kill("SIGKILL");
          await bounded(live.exit, "cleanup KILL", 5_000);
        }
      }),
    );
  } finally {
    children.clear();
    await Promise.all([...upstreams].map((up) => up.close()));
    upstreams.clear();
    await Promise.all([...reservations].map(release));
    for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    homes.clear();
  }
}, 25_000);

describe("T-I1 proxy (real hub child + HTTP/WS upstream)", () => {
  async function setup() {
    const up = await proxyUpstream();
    upstreams.add(up);
    const ports = await reserveRange([up.port]);
    const cfg = config({ home: newHome(), port: 0, proxy: { portRange: ports.range, maxProxies: 2 } });
    const hub = await boot(cfg);
    await ports.release();
    return { hub, cfg, up, target: `http://127.0.0.1:${up.port}/echo?via=integration` };
  }

  it("open → one-time enter/303/cookie → HTTP forward → WS echo → stop closes listener and socket", async () => {
    const { hub, cfg, up, target } = await setup();
    expect(await hub.caps()).toContain(PROXY_HUB_CAP);
    const opened = await open(hub, target);
    const port = Number(new URL(opened.origin).port);
    expect(port).toBeGreaterThanOrEqual(cfg.proxy!.portRange[0]);
    expect(port).toBeLessThanOrEqual(cfg.proxy!.portRange[1]);
    expect((await proxyRequest(`${opened.origin}/echo`)).status).toBe(401);
    expect(up.requests).toHaveLength(0);
    const gate = await enter(opened);
    expect((await proxyRequest(opened.enterUrl)).status).toBe(410); // consumed code cannot mint twice
    const http = await proxyRequest(`${opened.origin}/echo?via=integration`, `${gate}; app=X3; ${hub.cookie}`);
    expect(http.status).toBe(200);
    expect(JSON.parse(http.body)).toMatchObject({
      path: "/echo?via=integration",
      method: "GET",
      headers: { cookie: "app=X3" },
    });
    expect(up.requests).toHaveLength(1);
    const ws = await echoWs(opened, gate);
    expect(up.requests.at(-1)?.path).toBe("/ws");
    const list = await hub.api("GET", "/api/proxy");
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toMatchObject({
      policy: { maxProxies: 2, portRange: cfg.proxy!.portRange, lan: false },
      items: [expect.objectContaining({ instanceId: opened.instanceId, origin: opened.origin, mine: true })],
    });
    const stopped = await hub.api("POST", "/api/proxy/stop", { instanceId: opened.instanceId });
    expect([stopped.status, JSON.parse(stopped.body)]).toEqual([200, { ok: true }]);
    await waitUntil(ws.closed, 5_000, "stop closes upgraded client");
    await waitUntil(() => up.upgraded.size === 0, 5_000, "stop closes upstream WS");
    await expectRefused(port);
    expect(JSON.parse((await hub.api("GET", "/api/proxy")).body).items).toEqual([]);
    await terminate(hub);
  }, 40_000);

  it("SIGTERM/close disposes live proxies; restart preserves target port but invalidates old cookies/codes", async () => {
    const { hub, cfg, up, target } = await setup();
    const opened = await open(hub, target);
    const gate = await enter(opened);
    const unused = await open(hub, target); // unconsumed pre-restart code must also be forgotten
    const ws = await echoWs(opened, gate);
    const port = Number(new URL(opened.origin).port);
    const store = join(hub.paths.stateDir, "proxy", "ports.json");
    const before = readFileSync(store, "utf8");
    await terminate(hub);
    await waitUntil(ws.closed, 5_000, "shutdown closes upgraded client");
    await waitUntil(() => up.upgraded.size === 0, 5_000, "shutdown closes upstream WS");
    await expectRefused(port);
    expect(readFileSync(store, "utf8")).toBe(before);

    const restarted = await boot(cfg); // SAME home/config, SAME upstream/target, a new hub process
    expect(restarted.live.child.pid).not.toBe(hub.live.child.pid);
    const reopened = await open(restarted, target);
    expect(reopened.origin).toBe(opened.origin);
    expect(readFileSync(store, "utf8")).toBe(before);
    const seen = up.requests.length;
    expect((await proxyRequest(`${reopened.origin}/echo`, gate)).status).toBe(401);
    expect((await proxyRequest(unused.enterUrl)).status).toBe(410);
    expect(up.requests).toHaveLength(seen); // refused before touching upstream
    const freshGate = await enter(reopened);
    expect(freshGate).not.toBe(gate);
    expect((await proxyRequest(`${reopened.origin}/echo?via=integration`, freshGate)).status).toBe(200);
    const freshWs = await echoWs(reopened, freshGate);
    await terminate(restarted);
    await waitUntil(freshWs.closed, 5_000, "restarted hub closes WS");
    await expectRefused(port);
  }, 60_000);

  it("main.ts drops a range overlapping config.port: stderr note, no proxy caps/disk, all /api/proxy* 404", async () => {
    const ports = await reserveRange();
    const cfg = config({ home: newHome(), port: ports.range[0], proxy: { portRange: ports.range, maxProxies: 2 } });
    await ports.release();
    const hub = await boot(cfg);
    expect(hub.port).toBe(cfg.port);
    expect(hub.live.stderr).toContain(`dropping config.proxy: portRange overlaps webHub.port (${cfg.port})`);
    const caps = await hub.caps();
    expect(caps).not.toContain(PROXY_HUB_CAP);
    expect(caps).not.toContain(PROXY_LAN_HUB_CAP);
    for (const [method, path, body] of [
      ["GET", "/api/proxy", undefined],
      ["POST", "/api/proxy/open", { target: "127.0.0.1:23434" }],
      ["POST", "/api/proxy/stop", { instanceId: "inst_12345678" }],
    ] as const) {
      const r = await hub.api(method, path, body);
      expect(r.status, `${path}: ${r.body}`).toBe(404);
    }
    expect(existsSync(join(hub.paths.stateDir, "proxy"))).toBe(false);
    expect(JSON.parse(readFileSync(hub.paths.hubJson, "utf8"))).not.toHaveProperty("proxy");
    for (let port = ports.range[0] + 1; port <= ports.range[1]; port++) await expectRefused(port);
    await terminate(hub);
  }, 40_000);
});
