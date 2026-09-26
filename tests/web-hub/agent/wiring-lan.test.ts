import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../../src/web-hub/agent/index.js";
import type { AgentFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  ackFrame,
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  startFakeHub,
  tmpDir,
  waitUntil,
  type FakeHub,
} from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
let hub: FakeHub | undefined;
beforeEach(() => {
  tmp = tmpDir("wh-d-wire-lan-");
  resetGlobals();
});
afterEach(async () => {
  resetGlobals();
  await hub?.close();
  hub = undefined;
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

describe("wireWebHub — LAN spawn config (plan §11 LE row: lan off ⇒ P1 深相等; §9.1 四字段)", () => {
  it("settings.lan undefined ⇒ PI_WEBHUB_CONFIG has no `lan` key at all (byte-identical to P1)", async () => {
    const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader() };
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings, netConnect: enoentConnect(), spawnImpl }));
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await flush();
    await flush();
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    const config = JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(
      ["buildId", "home", "idleExitMinutes", "launcher", "pluginVersion", "port", "v"].sort(),
    );
    expect(config.lan).toBeUndefined();
    expect("lan" in config).toBe(false);
  });

  it("settings.lan.enabled: false ⇒ same as undefined (no `lan` key)", async () => {
    const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
    const settings: WebHubSettings = {
      ...SETTINGS,
      autoStart: true,
      nodeLoader: fakeNodeLoader(),
      lan: { enabled: false, port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    };
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings, netConnect: enoentConnect(), spawnImpl }));
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await flush();
    await flush();
    const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    const config = JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
    expect("lan" in config).toBe(false);
  });

  it("settings.lan.enabled: true ⇒ PI_WEBHUB_CONFIG.lan carries exactly the four HubLanConfig fields", async () => {
    const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
    const settings: WebHubSettings = {
      ...SETTINGS,
      autoStart: true,
      nodeLoader: fakeNodeLoader(),
      lan: {
        enabled: true,
        port: 7879,
        extraHosts: ["nas.local"],
        trustProxyFrom: ["127.0.0.1"],
        externalOrigins: ["https://hub.example.com"],
      },
    };
    const { pi, fire } = fakePi();
    wireWebHub(pi, deps({ settings, netConnect: enoentConnect(), spawnImpl }));
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await flush();
    await flush();
    const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    const config = JSON.parse(env.PI_WEBHUB_CONFIG) as { lan?: Record<string, unknown> };
    expect(config.lan).toEqual({
      port: 7879,
      extraHosts: ["nas.local"],
      trustProxyFrom: ["127.0.0.1"],
      externalOrigins: ["https://hub.example.com"],
    });
  });
});

describe("wireWebHub — control.lan.statusLines() (plan §9.3, reads hub.json directly)", () => {
  it("settings on, hub.json has no lan key ⇒ 未生效 mismatch line with the hub pid", () => {
    writeFileSync(pathsIn(tmp.dir).hubJson, JSON.stringify({ pid: 4321, port: 7878 }));
    const settings: WebHubSettings = {
      ...SETTINGS,
      lan: { enabled: true, port: 7879, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    };
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ settings, netConnect: fakeNet().netConnect }));
    expect(control.lan.statusLines()).toEqual([expect.stringContaining("未生效")]);
    expect(control.lan.statusLines()[0]).toContain("4321");
  });

  it("settings off, hub.json.lan is on ⇒ 注意 mismatch line", () => {
    writeFileSync(
      pathsIn(tmp.dir).hubJson,
      JSON.stringify({
        pid: 1,
        port: 7878,
        lan: { state: "on", port: 7879, hosts: ["1.2.3.4"], omitted: [], warnings: [] },
      }),
    );
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: fakeNet().netConnect }));
    expect(control.lan.statusLines()).toEqual([expect.stringContaining("注意")]);
  });

  it("no hub.json at all ⇒ no lines, never throws", () => {
    const { pi } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: fakeNet().netConnect }));
    expect(() => control.lan.statusLines()).not.toThrow();
    expect(control.lan.statusLines()).toEqual([]);
  });
});

describe("wireWebHub — control.lan.info/unlock/restart against a live fake hub (caps-gated)", () => {
  async function liveWithCaps(caps: string[]): Promise<{
    control: ReturnType<typeof wireWebHub>;
    hub: FakeHub;
  }> {
    const fakeHub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    await waitUntil(() => fakeHub.conns.length > 0, 3_000, "connection");
    fakeHub.send(fakeHub.conns[0]!, ackFrame("a1-key", 4242, caps));
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    return { control, hub: fakeHub };
  }

  it("info(): no lan.v1 cap ⇒ unavailable, nothing sent", async () => {
    const { control, hub: h } = await liveWithCaps(["ctl.v1"]);
    hub = h;
    const before = hub.all().length;
    const res = await control.lan.info();
    expect(res).toEqual({ ok: false, reason: "unavailable" });
    expect(hub.all().length).toBe(before);
  });

  it("info(): cap present ⇒ sends lan_req and resolves with the hub's info payload", async () => {
    const { control, hub: h } = await liveWithCaps(["lan.v1"]);
    hub = h;
    const p = control.lan.info();
    await waitUntil(() => hub!.all().some((f) => f.t === "lan_req" && f.op === "info"), 3_000, "lan_req");
    const req = hub.all().find((f) => f.t === "lan_req") as Extract<AgentFrame, { t: "lan_req" }>;
    hub.send(hub.conns[0]!, {
      t: "lan_res",
      rid: req.rid,
      ok: true,
      info: { username: "alice", lan: { state: "starting" } },
    });
    const res = await p;
    expect(res).toEqual({ ok: true, value: { username: "alice", lan: { state: "starting" } } });
  });

  it("unlock(): hub rejects ⇒ surfaced as rejected with code/message", async () => {
    const { control, hub: h } = await liveWithCaps(["lan.v1"]);
    hub = h;
    const p = control.lan.unlock();
    await waitUntil(() => hub!.all().some((f) => f.t === "lan_req" && f.op === "unlock"), 3_000, "lan_req");
    const req = hub.all().find((f) => f.t === "lan_req") as Extract<AgentFrame, { t: "lan_req" }>;
    hub.send(hub.conns[0]!, { t: "lan_res", rid: req.rid, ok: false, code: "E_DB", message: "unavailable" });
    const res = await p;
    expect(res).toEqual({ ok: false, reason: "rejected", code: "E_DB", message: "unavailable" });
  });

  it("restart(): ctl.v1 present ⇒ hub_ctl shutdown sent; ack ⇒ never reads /proc, never signals", async () => {
    const { control, hub: h } = await liveWithCaps(["ctl.v1"]);
    hub = h;
    const p = control.lan.restart();
    await waitUntil(() => hub!.all().some((f) => f.t === "hub_ctl"), 3_000, "hub_ctl");
    const req = hub.all().find((f) => f.t === "hub_ctl") as Extract<AgentFrame, { t: "hub_ctl" }>;
    hub.send(hub.conns[0]!, { t: "hub_ctl_ack", rid: req.rid });
    const outcome = await p;
    // no hub.json written here ⇒ readHubRecord() gives no pid to poll ⇒ waitExit treats it as exited.
    expect(outcome).toEqual({ kind: "restarted" });
  });

  it("restart(): no ctl.v1 cap, no hub.json ⇒ manual (never calls process.kill)", async () => {
    const { control, hub: h } = await liveWithCaps(["lan.v1"]);
    hub = h;
    const outcome = await control.lan.restart();
    expect(outcome.kind).toBe("manual");
  });
});

describe("wireWebHub — changePasswordInteractive() (plan §9.3 passwd; TUI-only)", () => {
  it("non-TUI mode ⇒ no-cap without touching ui at all", async () => {
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps({ netConnect: fakeNet().netConnect }));
    const { ctx } = fakeCtx({ mode: "rpc" });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    const outcome = await control.lan.changePasswordInteractive();
    expect(outcome).toEqual({ ok: false, reason: "no-cap" });
  });

  it("TUI, hub live with lan.v1 ⇒ full round trip through the real MaskedInputComponent", async () => {
    hub = await startFakeHub(pathsIn(tmp.dir).socketPath, { autoAck: false });
    const { pi, fire } = fakePi();
    const control = wireWebHub(pi, deps());
    const fakeTui = { requestRender: () => undefined };
    const { ctx } = fakeCtx({
      mode: "tui",
      uiInput: async () => "alice",
      uiCustom: (factory) =>
        new Promise((resolve) => {
          const comp = (
            factory as (
              tui: unknown,
              theme: unknown,
              kb: unknown,
              done: (v: unknown) => void,
            ) => { handleInput: (d: string) => void }
          )(fakeTui, {}, {}, resolve);
          for (const ch of "hunter2-hunter2") comp.handleInput(ch);
          comp.handleInput("\r");
        }),
    });
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => hub!.conns.length > 0, 3_000, "connection");
    hub.send(hub.conns[0]!, ackFrame("a1-key", 4242, ["lan.v1"]));
    await waitUntil(() => control.status().state === "live", 3_000, "live");
    const p = control.lan.changePasswordInteractive();
    await waitUntil(() => hub!.all().some((f) => f.t === "lan_req" && f.op === "passwd"), 3_000, "passwd req");
    const req = hub.all().find((f) => f.t === "lan_req" && f.op === "passwd") as Extract<
      AgentFrame,
      { t: "lan_req"; op: "passwd" }
    >;
    expect(req.username).toBe("alice");
    expect(req.password).toBe("hunter2-hunter2");
    hub.send(hub.conns[0]!, { t: "lan_res", rid: req.rid, ok: true });
    expect(await p).toEqual({ ok: true });
  });
});
