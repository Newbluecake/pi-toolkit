import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { LoadSettings } from "../../src/config/settings.js";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../src/web-hub/agent/index.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createHubLoad } from "../../src/web-hub/hub/load.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type {
  FrontendDeps,
  FrontendFactory,
  HttpFrontend,
  HubConfig,
  HubLoadConfig,
} from "../../src/web-hub/hub/ports.js";
import { config as hubConfig, connectClient, hello, tmpDirs, waitFor } from "../web-hub/hub/helpers.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS } from "../web-hub/agent/helpers.js";
import { fakeDeps, login, makeTmp, openSse, rawRequest } from "../web-hub/http/helpers.js";

const load: HubLoadConfig = {
  sampleIntervalMs: 5_000,
  sustainMs: 60_000,
  recoverMs: 30_000,
  thresholds: {
    cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
    mem: { warnAvailPercent: 15, critAvailPercent: 8 },
    disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
  },
};

/** The non-gating LoadSettings the agent side hands `buildHubConfig` via `deps.load.settings`. */
const loadSettings: LoadSettings = {
  enabled: true,
  gate: false,
  gateLevel: "crit",
  sampleIntervalMs: load.sampleIntervalMs,
  sustainMs: load.sustainMs,
  recoverMs: load.recoverMs,
  cpu: load.thresholds.cpu,
  mem: load.thresholds.mem,
  disk: load.thresholds.disk,
  hint: { enabled: false, display: false, repeatMs: 0, minIntervalMs: 0 },
  hud: false,
};

const IS_LINUX = process.platform === "linux";
const HUB_MAIN = resolve("src/web-hub/hub/main.ts");

/** `webHub.nodeLoader` override resolving ok, so `shouldSpawnHub` passes `launcherOk`. */
function fakeNodeLoader(dir: string): string {
  const p = join(dir, "fake-jiti-cli.mjs");
  writeFileSync(p, "");
  return p;
}

/** A `net.connect` that always throws ENOENT — the connection never establishes, only spawns. */
function enoentConnect(): typeof import("node:net").connect {
  return (() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof import("node:net").connect;
}

describe("web-hub P3 load wiring", () => {
  it("authenticates before top scans and serves one host-load SSE snapshot", async () => {
    if (!IS_LINUX) return;
    const tmp = makeTmp("pwh-load-");
    const deps = fakeDeps(tmp.dir);
    deps.config = { ...deps.config, load };
    const frontend = createHttpFrontend(deps);
    try {
      const port = (await frontend.listen()).port;
      const noHeader = await rawRequest(port, { path: "/api/load/top" });
      expect(noHeader.status).toBe(403);
      const cookie = await login(port, deps.paths.tokenFile);
      const top = await rawRequest(port, {
        path: "/api/load/top",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      expect(top.status).toBe(200);
      const body = JSON.parse(top.body) as { byCpu?: unknown[]; byRss?: unknown[] };
      expect(Array.isArray(body.byCpu)).toBe(true);
      expect(Array.isArray(body.byRss)).toBe(true);

      const sse = await openSse(port, { cookie });
      expect(sse.status).toBe(200);
      const frame = await sse.waitFor((event) => event.event === "load", 3_000);
      expect(frame.id).toBeUndefined();
      expect(frame.data).toMatchObject({ v: 1, scope: "host", intervalMs: load.sampleIntervalMs });
      sse.close();
    } finally {
      await frontend.close();
      tmp.cleanup();
    }
  });

  it("Last-Event-ID reconnect does not replay stale load frames (single snapshot, no id)", async () => {
    if (!IS_LINUX) return;
    const tmp = makeTmp("pwh-load-replay-");
    const deps = fakeDeps(tmp.dir);
    deps.config = { ...deps.config, load };
    const frontend = createHttpFrontend(deps);
    try {
      const port = (await frontend.listen()).port;
      const cookie = await login(port, deps.paths.tokenFile);
      const first = await openSse(port, { cookie });
      const frame = await first.waitFor((e) => e.event === "load", 5_000);
      expect(frame.id).toBeUndefined();
      // Extra direct-send load frames: they fan out to CURRENT clients only and never enter
      // the replay ring, so a reconnect must not see them replayed.
      for (let i = 1; i <= 3; i++) deps.emit({ type: "load", wire: { ...frame.data, at: frame.data.at + i } });
      first.close();
      const second = await openSse(port, { cookie, lastEventId: 1 });
      const snapshot = await second.waitFor((e) => e.event === "load", 3_000);
      expect(snapshot.id).toBeUndefined();
      // Sentinel: a hub broadcast (ring path, carries an id) published AFTER the synchronous
      // connect burst — its arrival proves the stream drained past the snapshot, so a replayed
      // stale load frame anywhere in the burst could not have been missed (no fixed sleep).
      deps.emit({ type: "hub" });
      await second.waitFor((e) => e.event === "hub" && e.id !== undefined, 3_000);
      const loadFrames = second.events.filter((e) => e.event === "load");
      expect(loadFrames).toHaveLength(1);
      expect(loadFrames[0]!.id).toBeUndefined();
      second.close();
    } finally {
      await frontend.close();
      tmp.cleanup();
    }
  });

  it("rate limit ⇒ 429 + Retry-After on the 4th rapid /api/load/top request", async () => {
    if (!IS_LINUX) return;
    const tmp = makeTmp("pwh-load-rate-");
    const deps = fakeDeps(tmp.dir);
    deps.config = { ...deps.config, load };
    const frontend = createHttpFrontend(deps);
    try {
      const port = (await frontend.listen()).port;
      const cookie = await login(port, deps.paths.tokenFile);
      const headers = { Cookie: cookie, "X-PWH": "1" };
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => rawRequest(port, { path: "/api/load/top", headers })),
      );
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 429)).toHaveLength(1);
      const limited = responses.find((r) => r.status === 429)!;
      expect(limited.headers["retry-after"]).toBe("1");
      expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    } finally {
      await frontend.close();
      tmp.cleanup();
    }
  });
});

describe.skipIf(!IS_LINUX)("web-hub P3 load cap matrix (HubInfo.caps ≡ hello_ack.caps)", () => {
  const tmp = tmpDirs();
  const hubs: RunningHub[] = [];

  afterEach(async () => {
    for (const h of hubs.splice(0)) await h.close("test");
    tmp.cleanup();
  });

  function fakeFrontend(): { factory: FrontendFactory; deps: FrontendDeps[] } {
    const holder: { deps: FrontendDeps[] } = { deps: [] };
    const factory: FrontendFactory = (deps): HttpFrontend => {
      holder.deps.push(deps);
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
    return { factory, deps: holder.deps };
  }

  async function startCaps(
    home: string,
    loadConfig?: unknown,
  ): Promise<{ browserCaps: string[]; agentCaps: string[] }> {
    const r = await startHub(
      hubConfig({ home, ...(loadConfig === undefined ? {} : { load: loadConfig as HubLoadConfig }) }),
      fakeFrontend().factory,
      { uid: process.getuid?.() ?? 0 },
    );
    if ("exists" in r) throw new Error("unexpected non-running hub");
    hubs.push(r);
    const browserCaps = [...r.info.caps].sort();
    const c = await connectClient(r.paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    c.sock.destroy();
    const agentCaps = [...(ack["caps"] as string[])].sort();
    return { browserCaps, agentCaps };
  }

  it("load enabled ⇒ load.v1 on BOTH surfaces", async () => {
    const { browserCaps, agentCaps } = await startCaps(tmp.make("wh-cap-on-"), load);
    expect(browserCaps).toContain("load.v1");
    expect(agentCaps).toContain("load.v1");
    expect(browserCaps).toEqual(agentCaps);
  });

  it("load missing ⇒ no load.v1 on either surface", async () => {
    const { browserCaps, agentCaps } = await startCaps(tmp.make("wh-cap-off-"));
    expect(browserCaps).not.toContain("load.v1");
    expect(agentCaps).not.toContain("load.v1");
  });

  it("invalid config.load ⇒ no load.v1 on either surface (dropped at assembly)", async () => {
    const { browserCaps, agentCaps } = await startCaps(tmp.make("wh-cap-bad-"), { ...load, recoverMs: 1 });
    expect(browserCaps).not.toContain("load.v1");
    expect(agentCaps).not.toContain("load.v1");
  });
});

describe.skipIf(!IS_LINUX)("web-hub P3 load enable/disable matrix (real buildHubConfig)", () => {
  const tmp = tmpDirs();
  const hubs: RunningHub[] = [];

  beforeEach(() => resetGlobals());
  afterEach(async () => {
    resetGlobals();
    for (const h of hubs.splice(0)) await h.close("test");
    tmp.cleanup();
  });

  /** Drive session_start through wireWebHub (the REAL assembly) and capture PI_WEBHUB_CONFIG. */
  async function buildConfig(
    dir: string,
    opts: { loadEnabled: boolean; webHubLoad?: boolean },
  ): Promise<Record<string, unknown>> {
    const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader(dir) };
    if (opts.webHubLoad === false) settings.load = false;
    const deps: WebHubDeps = {
      settings,
      fleet: () => [],
      env: { HOME: dir },
      paths: pathsIn(dir),
      buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
      argv1: "/nonexistent/pi",
      load: { port: () => undefined, settings: { ...loadSettings, enabled: opts.loadEnabled } },
      netConnect: enoentConnect(),
      spawnImpl,
    };
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps);
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    return JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
  }

  const cases: Array<[string, { loadEnabled: boolean; webHubLoad?: boolean }]> = [
    ["load.enabled=false", { loadEnabled: false }],
    ["webHub.load=false", { loadEnabled: true, webHubLoad: false }],
  ];

  it.each(cases)(
    "%s ⇒ config.load omitted, /api/load/top 404, no SSE load frames, no load.v1 cap",
    async (_name, opts) => {
      const dir = tmp.make("wh-load-matrix-");
      const config = await buildConfig(dir, opts);
      expect("load" in config).toBe(false);

      const started = await startHub(config as unknown as HubConfig, createHttpFrontend, {
        uid: process.getuid?.() ?? 0,
      });
      if ("exists" in started) throw new Error("unexpected singleton collision");
      hubs.push(started);

      expect(started.info.caps).not.toContain("load.v1");

      const cookie = await login(started.httpPort, started.paths.tokenFile);
      const top = await rawRequest(started.httpPort, {
        path: "/api/load/top",
        headers: { Cookie: cookie, "X-PWH": "1" },
      });
      expect(top.status).toBe(404);

      // `agents` is the terminal frame of the no-load connect burst (no spawns/load/fleet), so
      // its arrival is the deterministic "burst drained" point — no fixed sleep.
      const sse = await openSse(started.httpPort, { cookie });
      await sse.waitFor((e) => e.event === "agents", 3_000);
      expect(sse.events.some((e) => e.event === "load")).toBe(false);
      sse.close();
    },
  );
});

describe.skipIf(!IS_LINUX)("web-hub P3 load timer lifecycle", () => {
  it("stop clears the sampler tick timer and never re-arms it", async () => {
    const clock = new FakeClock(0);
    let resolveWire!: () => void;
    const wire = new Promise<void>((r) => (resolveWire = r));
    const service = createHubLoad(load, { home: "/", mono: () => clock.now(), clock, onWire: () => resolveWire() });
    expect(service).toBeDefined();
    await wire; // first sample published
    await new Promise((r) => setImmediate(r)); // .finally() armed the next tick
    expect(clock.pendingTimers).toBe(1);
    await service!.dispose();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(600_000); // far past sampleIntervalMs — nothing re-arms
    expect(clock.pendingTimers).toBe(0);
  });

  it("the sampler tick timer is unref'd (idle self-exit is not held open)", async () => {
    const created: Array<{ hasRef?: () => boolean }> = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const t = origSetTimeout(fn, ms);
      created.push(t as { hasRef?: () => boolean });
      return t;
    }) as typeof globalThis.setTimeout;
    let resolveWire!: () => void;
    const wire = new Promise<void>((r) => (resolveWire = r));
    try {
      const service = createHubLoad(load, { home: "/", onWire: () => resolveWire() });
      expect(service).toBeDefined();
      await wire;
      await new Promise((r) => setImmediate(r));
      await service!.dispose();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
    expect(created.length).toBeGreaterThanOrEqual(1);
    for (const t of created) expect(t.hasRef?.()).toBe(false);
  });
});

describe.skipIf(!IS_LINUX)("web-hub P3 load config drop (real hub main process)", () => {
  it("invalid config.load is dropped with a stderr note before the hub starts", async () => {
    const tmp = makeTmp("pwh-load-drop-");
    const child = spawn(process.execPath, ["--import", "tsx", HUB_MAIN], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        HOME: tmp.dir,
        PI_WEBHUB_CONFIG: JSON.stringify({
          v: 1,
          home: tmp.dir,
          port: 0,
          idleExitMinutes: 10,
          pluginVersion: "0.0.0-test",
          buildId: "b1",
          load: { ...load, recoverMs: 1 },
        }),
      },
    });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    try {
      await waitFor(() => stderr.includes("dropping config.load") || child.exitCode !== null, 15_000);
      expect(stderr).toContain("web-hub main: dropping config.load");
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((r) => child.once("exit", () => r()));
      tmp.cleanup();
    }
  }, 25_000);
});
