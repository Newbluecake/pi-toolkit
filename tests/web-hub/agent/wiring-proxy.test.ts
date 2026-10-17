/**
 * web-hub-proxy X1c — agent side: `webHub.proxy` → `PI_WEBHUB_CONFIG.proxy` translation
 * (`buildHubConfig`) and `control.proxy.statusLines()` (reads hub.json directly).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../../src/web-hub/agent/index.js";
import { fakeCtx, fakeNet, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-wire-proxy-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

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

async function spawnedConfig(settings: WebHubSettings): Promise<Record<string, unknown>> {
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const { pi, fire } = fakePi();
  wireWebHub(
    pi,
    deps({
      settings: { ...settings, autoStart: true, nodeLoader: fakeNodeLoader() },
      netConnect: enoentConnect(),
      spawnImpl,
    }),
  );
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  await flush();
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
  return JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
}

describe("buildHubConfig — webHub.proxy translation", () => {
  it("undefined / enabled:false ⇒ no `proxy` key (PI_WEBHUB_CONFIG byte-identical to pre-feature)", async () => {
    for (const proxy of [undefined, { enabled: false, portRange: "7900-7949", maxProxies: 8 }]) {
      const config = await spawnedConfig({ ...SETTINGS, ...(proxy === undefined ? {} : { proxy }) });
      expect("proxy" in config).toBe(false);
      expect(Object.keys(config).sort()).toEqual(
        ["buildId", "home", "idleExitMinutes", "launcher", "pluginVersion", "port", "preview", "v"].sort(),
      );
      resetGlobals();
    }
  });

  it("enabled ⇒ exactly { portRange: [lo, hi], maxProxies } (no `enabled`, no LAN field)", async () => {
    const config = await spawnedConfig({
      ...SETTINGS,
      proxy: { enabled: true, portRange: "7900-7949", maxProxies: 8 },
    });
    expect(config.proxy).toEqual({ portRange: [7900, 7949], maxProxies: 8 });
    resetGlobals();
    const custom = await spawnedConfig({
      ...SETTINGS,
      proxy: { enabled: true, portRange: "20000-20009", maxProxies: 3 },
    });
    expect(custom.proxy).toEqual({ portRange: [20000, 20009], maxProxies: 3 });
  });

  it("control:false (a control-plane feature) ⇒ key omitted even when enabled", async () => {
    const config = await spawnedConfig({
      ...SETTINGS,
      control: false,
      proxy: { enabled: true, portRange: "7900-7949", maxProxies: 8 },
    });
    expect("proxy" in config).toBe(false);
  });

  it("an unparsable range in a hand-built settings object omits the key rather than inventing a default", async () => {
    const config = await spawnedConfig({ ...SETTINGS, proxy: { enabled: true, portRange: "nope", maxProxies: 8 } });
    expect("proxy" in config).toBe(false);
  });

  it("LAN reach is derived on the hub from config.lan — the proxy wire carries no LAN field", async () => {
    const config = await spawnedConfig({
      ...SETTINGS,
      lan: { enabled: true, port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
      proxy: { enabled: true, portRange: "7900-7949", maxProxies: 8 },
    });
    expect(Object.keys(config.proxy as object).sort()).toEqual(["maxProxies", "portRange"]);
    expect(config.lan).toBeDefined();
  });
});

describe("control.proxy.statusLines()", () => {
  const on: WebHubSettings = { ...SETTINGS, proxy: { enabled: true, portRange: "7900-7949", maxProxies: 8 } };

  it("settings off ⇒ silent (even with a stray hub.json proxy key)", () => {
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 1, port: 7878, proxy: { portsStore: "ok" } }));
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: fakeNet().netConnect }));
    expect(control.proxy!.statusLines()).toEqual([]);
  });

  it("on + hub.json.proxy ok ⇒ `proxy: on · loopback · 7900-7949 · max 8` and nothing else", () => {
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 1, port: 7878, proxy: { portsStore: "ok" } }));
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ settings: on, netConnect: fakeNet().netConnect }));
    expect(control.proxy!.statusLines()).toEqual(["proxy: on · loopback · 7900-7949 · max 8"]);
  });

  it("LAN setting on ⇒ `lan` token; portRange warnings from the raw-settings snapshot are surfaced", () => {
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 1, port: 7878, proxy: { portsStore: "ok" } }));
    const { pi } = fakePi();
    const settings: WebHubSettings = {
      ...on,
      lan: { enabled: true, port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    };
    const control = wireWebHub(
      pi,
      deps({ settings, proxyWarnings: () => ["port-range-invalid"], netConnect: fakeNet().netConnect }),
    );
    const lines = control.proxy!.statusLines();
    expect(lines[0]).toBe("proxy: on · lan · 7900-7949 · max 8");
    expect(lines[1]).toContain("portRange 格式无效");
  });

  it("hub.json present without a proxy key ⇒ one `未挂载` warning; no hub.json ⇒ just the settings line", () => {
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ settings: on, netConnect: fakeNet().netConnect }));
    expect(control.proxy!.statusLines()).toEqual(["proxy: on · loopback · 7900-7949 · max 8"]);
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 1, port: 7878 }));
    const lines = control.proxy!.statusLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("未挂载端口代理");
  });

  it("ports-store broken ⇒ the prose recovery note names the exact ports.json path", () => {
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 1, port: 7878, proxy: { portsStore: "broken" } }));
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ settings: on, netConnect: fakeNet().netConnect }));
    const lines = control.proxy!.statusLines();
    expect(lines[1]).toContain(join(pathsIn(tmp.dir).stateDir, "proxy", "ports.json"));
    expect(lines[1]).toContain("/webhub stop");
  });

  it("a malformed hub.json proxy field is treated as absent (never throws)", () => {
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 1, port: 7878, proxy: { portsStore: 7 } }));
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ settings: on, netConnect: fakeNet().netConnect }));
    expect(() => control.proxy!.statusLines()).not.toThrow();
    expect(control.proxy!.statusLines()[1]).toContain("未挂载端口代理");
  });

  it("control:false + enabled ⇒ a single not-enabled warning", () => {
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ settings: { ...on, control: false }, netConnect: fakeNet().netConnect }));
    const lines = control.proxy!.statusLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("control=false");
  });
});
