/**
 * web-hub-spawn plan §SP2 验收：`WebHubSettings.spawn` → `PI_WEBHUB_CONFIG` 的下发矩阵。
 *
 *   - `spawn` 缺失 / `enabled:false` ⇒ `PI_WEBHUB_CONFIG` 与 spawn 合入前的形态**深相等**
 *     （连 `spawn` 键都不存在 —— arch §8.2 未启用矩阵的 wire 层前提）；
 *   - `enabled:true` ⇒ `config.spawn` 恰好 9 个 `HubSpawnConfig` 字段（`enabled` 本身从不上 wire；
 *     第 9 个 `history` 是 session-history plan §3.7 P-cfg）。
 *
 * 手法照抄 `wiring-lan.test.ts`：auto-spawn 一条 hub 进程（nodeLoader 指向假 jiti-cli、
 * netConnect 抛 ENOENT），从 spawnImpl spy 的 env 里读 `PI_WEBHUB_CONFIG`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  wireWebHub,
  type WebHubDeps,
  type WebHubSettings,
  type WebHubSpawnSettings,
} from "../../../src/web-hub/agent/index.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-wire-spawn-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

/** A `webHub.nodeLoader` override that resolves ok (so `shouldSpawnHub` can pass launcherOk). */
function fakeNodeLoader(): string {
  const p = join(tmp.dir, "fake-jiti-cli.mjs");
  writeFileSync(p, "");
  return p;
}

function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function enoentConnect(): typeof import("node:net").connect {
  return (() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof import("node:net").connect;
}

/** Drive session_start through wireWebHub with autoStart on and capture PI_WEBHUB_CONFIG. */
async function hubConfigFor(settings: WebHubSettings): Promise<Record<string, unknown>> {
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const { pi, fire } = fakePi();
  wireWebHub(pi, deps({ settings, netConnect: enoentConnect(), spawnImpl }));
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  await flush();
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
  return JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
}

/** The pre-spawn hub config shape PLUS the post-PV1 default `preview:"on"` (what the off
 * cases must deep-equal — the "现状" baseline moves forward each time a default-on feature lands). */
function baselineConfig(): Record<string, unknown> {
  return {
    v: 1,
    home: tmp.dir,
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "1.2.3",
    buildId: "1.2.3@test",
    launcher: [process.execPath, "/nonexistent/pi"],
    preview: "on", // web-hub-preview PV1: default mode (U1)
  };
}

describe("wireWebHub — spawn config (plan §SP2: off ⇒ no spawn key; on ⇒ exactly the 9 policy fields)", () => {
  it("settings.spawn undefined ⇒ PI_WEBHUB_CONFIG deep-equals the pre-spawn shape (no spawn key at all)", async () => {
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader() };
    const config = await hubConfigFor(settings);
    expect(config).toEqual(baselineConfig());
    expect("spawn" in config).toBe(false);
  });

  it("settings.spawn.enabled: false ⇒ same deep-equal (the key is still absent)", async () => {
    const spawn: WebHubSpawnSettings = {
      enabled: false,
      roots: ["/srv/never-reaches-the-hub"],
      maxProcesses: 9,
      maxPerPrincipal: 9,
      ratePerMinute: 30,
      maxLifetimeMinutes: 10_080,
      registerTimeoutS: 120,
      lan: "roots",
      restore: true,
      history: true,
    };
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader(), spawn };
    const config = await hubConfigFor(settings);
    expect(config).toEqual(baselineConfig());
    expect("spawn" in config).toBe(false);
  });

  it("settings.spawn.enabled: true ⇒ config.spawn carries exactly the 8 HubSpawnConfig fields + history (field count +1)", async () => {
    const spawn: WebHubSpawnSettings = {
      enabled: true,
      roots: ["~/proj", "/srv/work"],
      maxProcesses: 5,
      maxPerPrincipal: 1,
      ratePerMinute: 7,
      maxLifetimeMinutes: 480,
      registerTimeoutS: 45,
      lan: "known",
      restore: false,
      history: false,
    };
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader(), spawn };
    const config = await hubConfigFor(settings);
    const expectedSpawn = {
      roots: ["~/proj", "/srv/work"],
      maxProcesses: 5,
      maxPerPrincipal: 1,
      ratePerMinute: 7,
      maxLifetimeMinutes: 480,
      registerTimeoutS: 45,
      lan: "known" as const,
      restore: false,
      history: false,
    };
    expect(config).toEqual({ ...baselineConfig(), spawn: expectedSpawn });
    // pin the exact key set — `enabled` never crosses the wire, nothing else sneaks in
    expect(Object.keys(config.spawn as Record<string, unknown>).sort()).toEqual(
      [
        "history",
        "lan",
        "maxLifetimeMinutes",
        "maxPerPrincipal",
        "maxProcesses",
        "ratePerMinute",
        "registerTimeoutS",
        "restore",
        "roots",
      ].sort(),
    );
  });

  it("enabled:true with defaults-only policy still sends the block (the hub revalidates strictly)", async () => {
    const settings: WebHubSettings = {
      ...SETTINGS,
      autoStart: true,
      nodeLoader: fakeNodeLoader(),
      spawn: {
        enabled: true,
        roots: [],
        maxProcesses: 4,
        maxPerPrincipal: 2,
        ratePerMinute: 3,
        maxLifetimeMinutes: 720,
        registerTimeoutS: 30,
        lan: "off",
        restore: true,
        history: true,
      },
    };
    const config = await hubConfigFor(settings);
    expect(config.spawn).toEqual({
      roots: [],
      maxProcesses: 4,
      maxPerPrincipal: 2,
      ratePerMinute: 3,
      maxLifetimeMinutes: 720,
      registerTimeoutS: 30,
      lan: "off",
      restore: true,
      history: true,
    });
  });
});
