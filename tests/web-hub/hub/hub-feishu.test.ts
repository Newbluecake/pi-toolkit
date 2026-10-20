import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  startHub,
  FEISHU_STOP_RESERVE_MS,
  type RunningHub,
  type StartHubDeps,
  installProcessHandlers,
} from "../../../src/web-hub/hub/hub.js";
import type { FrontendDeps, FrontendFactory, HostSnapshot, HubLanConfig } from "../../../src/web-hub/hub/ports.js";
import type { FeishuBotService, FeishuBotServiceDeps } from "../../../src/web-hub/hub/feishu/service.js";
import { createCredentialStore } from "../../../src/web-hub/hub/feishu/credentials.js";
import { systemFeishuClock } from "../../../src/web-hub/hub/feishu/http.js";
import {
  normalizeFeishuBotHubConfig,
  FEISHU_BOT_DEFAULTS,
  FEISHU_SHUTDOWN_BUDGET_MS,
} from "../../../src/web-hub/protocol/feishu.js";
import { FSB_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { encodeFrame } from "../../../src/web-hub/hub/feishu/frame.js";
import { createFakeFeishu } from "../../fixtures/feishu/fake-http.js";
import { createFakeWebSockets } from "../../fixtures/feishu/fake-ws-server.js";
import { messageEnvelope, OWNER, NOW } from "../../fixtures/feishu/f6.js";
import { eventually } from "../../fixtures/feishu/f8.js";
import { config, hello, connectClient, tmpDirs, waitFor, type TestClient, memLog } from "./helpers.js";

const idleObservations = vi.hoisted(() => [] as Array<() => { bot?: number }>);
vi.mock("../../../src/web-hub/hub/idle.js", async (original) => {
  const mod = await original<typeof import("../../../src/web-hub/hub/idle.js")>();
  return {
    ...mod,
    createIdleMonitor: (opts: Parameters<typeof mod.createIdleMonitor>[0]) => {
      idleObservations.push(opts.counts);
      return mod.createIdleMonitor(opts);
    },
  };
});
const tmp = tmpDirs();
const hubs: RunningHub[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) c.sock.destroy();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});
const botConfig = normalizeFeishuBotHubConfig({ ...FEISHU_BOT_DEFAULTS, debounceMs: 0 })!;

async function rig(
  opts: {
    enabled?: boolean;
    lan?: boolean;
    lanConfig?: HubLanConfig;
    hostSnapshot?: () => HostSnapshot;
    credentials?: boolean;
    spawn?: boolean;
    frontend?: FrontendFactory;
    onFrontendClose?: () => void;
    setupFake?: (fake: ReturnType<typeof createFakeFeishu>) => void;
    wrap?: NonNullable<StartHubDeps["feishuSeams"]>["wrapService"];
  } = {},
) {
  const home = tmp.make("wh-fa-");
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
  const start = Date.now();
  const clock = { ...systemFeishuClock, now: () => NOW + Date.now() - start };
  const fake = createFakeFeishu({ appId: "cli_test" });
  const ws = createFakeWebSockets(clock);
  opts.setupFake?.(fake);
  if (opts.credentials) {
    const store = createCredentialStore({ dir: join(paths.stateDir, "feishu-bot"), clock });
    expect(
      (
        await store.commit({
          brand: "feishu",
          appId: fake.appId,
          appSecret: fake.appSecret,
          ownerOpenId: OWNER,
          botOpenId: "ou_bot",
        })
      ).ok,
    ).toBe(true);
  }
  let service!: FeishuBotService;
  let botDeps!: FeishuBotServiceDeps;
  let frontendDeps!: FrontendDeps;
  const order: string[] = [];
  const frontend: FrontendFactory =
    opts.frontend ??
    ((deps) => {
      frontendDeps = deps;
      return {
        ...(opts.hostSnapshot ? { lanHostSnapshot: opts.hostSnapshot } : {}),
        listen: async () => ({ port: 43210 }),
        close: async () => {
          order.push("http.close");
          opts.onFrontendClose?.();
        },
        clientCount: () => 0,
        ui: {
          serve: async () => false,
          refresh: async () => ({ state: "unbuilt", candidates: [] }),
          status: () => ({ state: "unbuilt", candidates: [] }),
        },
      };
    });
  const result = await startHub(
    config({
      home,
      idleExitMinutes: 1,
      ...(opts.lanConfig
        ? { lan: opts.lanConfig }
        : opts.lan
          ? { lan: { port: 0, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }
          : {}),
      ...(opts.enabled === false ? {} : { feishuBot: botConfig }),
      ...(opts.spawn
        ? {
            spawn: {
              roots: [],
              maxProcesses: 2,
              maxPerPrincipal: 1,
              ratePerMinute: 5,
              maxLifetimeMinutes: 60,
              registerTimeoutS: 20,
              lan: "off" as const,
              restore: true,
            },
          }
        : {}),
    }),
    frontend,
    {
      now: clock.now,
      ...(opts.spawn ? { spawnSeams: { probe: { platform: "darwin" as const } } } : {}),
      feishuSeams: {
        clock,
        fetch: fake.fetch,
        webSocket: ws.create,
        wrapService: (created, deps) => {
          botDeps = deps;
          service = opts.wrap?.(created, deps) ?? created;
          return service;
        },
      },
    },
  );
  if ("exists" in result) throw new Error("hub unexpectedly not running");
  hubs.push(result);
  const connect = async (pluginVersion = "1.2.3") => {
    const c = await connectClient(result.paths.socketPath);
    clients.push(c);
    c.send(
      hello({
        agentId: { pid: process.pid, nonce: "fa-agent-nonce-AAAAAAAA" },
        pluginVersion,
        caps: ["ev.v1", "cmd.v1", "dialog.v1"],
      }),
    );
    const ack = await c.waitFrame((f) => f.t === "hello_ack");
    const key = ack.agentKey as string;
    c.send({
      t: "session",
      sessionId: "session-1",
      cwd: home,
      name: "FA",
      reason: "startup",
      leafId: null,
      mode: "tui",
    });
    await waitFor(() => frontendDeps.registry.get(key)?.session?.sessionId === "session-1");
    return { c, ack, key };
  };
  const send = (id: string, text: string) =>
    ws.sockets.at(-1)!.message(
      encodeFrame({
        seqId: 1n,
        logId: 2n,
        service: 33,
        method: 1,
        headers: [
          { key: "type", value: "event" },
          { key: "message_id", value: id },
          { key: "sum", value: "1" },
          { key: "seq", value: "0" },
        ],
        payloadEncoding: "",
        payload: Buffer.from(JSON.stringify(messageEnvelope(id, text))),
      }),
    );
  return { hub: result, home, paths, service, botDeps, frontendDeps, order, clock, fake, ws, connect, send };
}

describe("FA real hub composition + fake Feishu transports", () => {
  it("LAN assembly shares one security bus and wires the live Feishu approval decision sink", async () => {
    const r = await rig({ lan: true, credentials: true });
    const lan = r.frontendDeps.lan!;
    expect(lan.security).toBe(r.botDeps.security);
    expect(lan.security).toBeDefined();
    expect(lan.approval).toBe(r.service.approval);
    const decision = vi.fn();
    lan.onLoginCore!({ onApprovalDecision: decision } as never);
    r.botDeps.onApprovalDecision!("challenge", true, 7);
    expect(decision).toHaveBeenCalledWith("challenge", true, 7);
    lan.onLoginCore!(undefined);
    r.botDeps.onApprovalDecision!("late", true, 7);
    expect(decision).toHaveBeenCalledTimes(1);
  });

  it("all bot deep links share the live LAN-host selection and authenticated-host observation", async () => {
    const snapshot: HostSnapshot = {
      gen: 1,
      computedAt: NOW,
      omitted: [],
      hostKeys: new Set(["127.0.0.1:8787", "192.168.32.10:8787", "10.8.0.1:8787"]),
      externalOrigins: new Set(),
      trustProxyFrom: new Set(),
    };
    const r = await rig({
      lanConfig: { port: 8787, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
      hostSnapshot: () => snapshot,
    });
    expect(r.botDeps.link!("key")).toBe("http://192.168.32.10:8787/#/agent/key");
    r.frontendDeps.lan!.onAuthenticated!({
      kind: "lan",
      peerIp: "10.8.0.3",
      clientIp: "10.8.0.3",
      viaTrustedProxy: false,
      scheme: "http",
      hostKey: "10.8.0.1:8787",
      externalOrigin: "http://10.8.0.1:8787",
      snapshot,
    });
    expect(r.botDeps.link!("key")).toBe("http://10.8.0.1:8787/#/agent/key");
  });
  it("trusted reverse-proxy external origin wins for bot notices and dialog links", async () => {
    const r = await rig({
      lanConfig: {
        port: 8787,
        extraHosts: [],
        trustProxyFrom: ["127.0.0.1"],
        externalOrigins: ["https://phone.example.com"],
      },
    });
    expect(r.botDeps.link!("key")).toBe("https://phone.example.com/#/agent/key");
  });
  it("off: no service, caps, bot disk, transports or admin bus traffic; limiter remains available to HTTP", async () => {
    const wrap = vi.fn((s: FeishuBotService) => s);
    const r = await rig({ enabled: false, wrap });
    expect(wrap).not.toHaveBeenCalled();
    expect(r.hub.info.caps).not.toContain(FSB_HUB_CAP);
    expect(existsSync(join(r.paths.stateDir, "feishu-bot"))).toBe(false);
    expect(r.ws.sockets).toHaveLength(0);
    expect(r.fake.calls).toHaveLength(0);
    const { c, ack } = await r.connect();
    expect(ack.caps).toEqual(r.hub.info.caps);
    const events: string[] = [];
    const off = r.frontendDeps.bus.subscribe((e) => events.push(e.type));
    c.send({ t: "fsb_req", rid: "off-admin", op: "info" });
    const refusal = await c.waitFrame((f) => f.t === "fsb_res" && f.rid === "off-admin");
    expect(refusal).toMatchObject({ ok: false, code: "E_FSB_STATE", message: expect.stringContaining("未启用") });
    expect(events.filter((e) => e !== "hub")).toEqual([]);
    off();
    expect(r.frontendDeps.cmdLimit).toBeDefined();
  });

  it("fsb_req over an agent connection reaches the real service, fsb_res stays off the bus; both cap surfaces agree", async () => {
    let startupLink: string | undefined;
    const r = await rig({
      wrap: (service, deps) => {
        startupLink = deps.link!("boot-key");
        return service;
      },
    });
    expect(startupLink).toBe("");
    const { c, ack } = await r.connect();
    expect(r.botDeps.link!("boot-key")).toBe("http://127.0.0.1:43210/#/agent/boot-key");
    expect(ack.caps).toEqual(r.hub.info.caps);
    expect(ack.caps).toContain(FSB_HUB_CAP);
    const events: string[] = [];
    r.frontendDeps.bus.subscribe((e) => events.push(e.type));
    c.send({ t: "fsb_req", rid: "info", op: "info" });
    const res = await c.waitFrame((f) => f.t === "fsb_res" && f.rid === "info");
    expect(res).toMatchObject({ ok: true, data: { status: "unconfigured", keepalive: false } });
    expect(events.filter((e) => e !== "hub")).toEqual([]);
    expect(r.botDeps.limit).toBe(r.frontendDeps.cmdLimit);
    expect(r.botDeps.uploads).toBe(r.frontendDeps.uploads);
    expect(r.botDeps.preview).toBeDefined(); // safe file admission even with browser preview off
    expect(r.botDeps.spawn).toBeUndefined();
  });

  it("spawn enabled supplies existing F5/supervisor services; platform refusal stays fail-closed", async () => {
    const r = await rig({ spawn: true });
    const spawn = r.botDeps.spawn!;
    expect(spawn).toBeDefined();
    expect(spawn.restore).toBe(true);
    expect(spawn.registerTimeoutS).toBe(20);
    expect(spawn.lookup("unknown")).toBeUndefined();
    expect(spawn.supervisor.records()).toEqual([]);
    expect(spawn.prefs.get()).toBeDefined();
    expect(typeof spawn.dirs.admit).toBe("function");
    expect(typeof spawn.firstPrompt.accept).toBe("function");
    expect(typeof spawn.relaunch).toBe("function");
  });

  it("durable inbound → real command router → ctl/token/ev continuity → one labelled final over the fake API", async () => {
    const r = await rig({ credentials: true });
    await eventually(() => expect(r.service.snapshot().status).toBe("open"));
    const { c } = await r.connect();
    r.send("bind", "/use session-1");
    await eventually(() => expect(r.fake.sent.some((s) => String(s.body.content).includes("已绑定"))).toBe(true));
    const before = r.fake.sent.length;
    r.send("work", "FA task");
    const f: any = await c.waitFrame((f) => f.t === "cmd");
    expect(f.cmd.text).toMatch(/^\[飞书 · .*\nFA task$/);
    c.send({ t: "cmd_result", rid: f.rid, id: f.id, ok: true, data: { op: "prompt", delivery: "observed" } });
    await eventually(() => expect(r.fake.callsTo("POST", /reactions$/)).toHaveLength(1));
    c.send({
      t: "ctl",
      epoch: "epoch-1",
      sessionId: "session-1",
      items: [{ cmdId: f.id, op: "prompt", state: "consumed", at: r.clock.now(), updatedAt: r.clock.now() }],
    });
    c.send({
      t: "ev",
      seq: 1,
      e: { type: "message_start", message: { role: "user", content: [{ type: "text", text: f.cmd.text }] } },
    });
    c.send({
      t: "ev",
      seq: 2,
      e: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "FA result" }], stopReason: "stop" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.fake.sent).toHaveLength(before);
    c.send({ t: "ev", seq: 3, e: { type: "agent_settled" } });
    await eventually(() => expect(r.fake.sent.some((s) => String(s.body.content).includes("FA result"))).toBe(true));
    expect(r.fake.sent.filter((s) => String(s.body.content).includes("FA result"))).toHaveLength(1);
    expect(String(r.fake.sent.at(-1)!.body.content)).toContain("FA · sessio");
    expect(r.fake.callsTo("POST", /reactions$/)).toHaveLength(1);
  });

  it("shared HTTP agent bucket denies Feishu dispatch (not a second bot-local limiter)", async () => {
    const r = await rig({ credentials: true });
    await eventually(() => expect(r.service.snapshot().status).toBe("open"));
    const { c, key } = await r.connect();
    r.send("bind", "/use session-1");
    await eventually(() => expect(r.fake.sent.some((s) => String(s.body.content).includes("已绑定"))).toBe(true));
    // Drain to the same instant: even the last token must be unavailable at bot admission.
    for (let i = 0; i < 31; i++) r.frontendDeps.cmdLimit!.admit(`agent:${key}`, 30, 60_000);
    r.send("rate", "must refuse");
    await eventually(() => expect(r.fake.sent.some((s) => String(s.body.content).includes("E_RATE"))).toBe(true));
    expect(c.frames.filter((f: any) => f.t === "cmd")).toEqual([]);
  });

  it("dialog absence remains absent; received slots and positive fleet/bash evidence are generation-fenced", async () => {
    const r = await rig({ credentials: true });
    await eventually(() => expect(r.service.snapshot().status).toBe("open"));
    const { c, key } = await r.connect();
    expect(r.botDeps.events.dialogs!()).toEqual([]);
    expect(r.botDeps.idleEvidence!(key)).toBeUndefined();
    c.send({ t: "dialogs", epoch: "epoch-1", open: [], closed: [] });
    c.send({
      t: "status",
      leafId: null,
      busy: false,
      pending: false,
      bashJobs: { rows: [], total: 0, running: 0, failed: 0, sampledAt: r.clock.now() },
    });
    c.send({ t: "fleet", runs: [], omitted: { active: 1, terminal: 0 } });
    await waitFor(() => r.botDeps.idleEvidence!(key) !== undefined);
    expect(r.botDeps.events.dialogs!()).toEqual([{ agentKey: key, epoch: "epoch-1", open: [], closed: [] }]);
    expect(r.botDeps.idleEvidence!(key)?.fleet?.complete).toBe(false);
    c.send({ t: "fleet", runs: [] });
    await waitFor(() => r.botDeps.idleEvidence!(key)?.fleet?.complete === true);
    c.sock.destroy();
    await c.closed;
    await waitFor(() => r.botDeps.sessions.views().every((v) => !v.live));
    const second = await r.connect(); // same epoch/caps reclaim, still a proof gap
    expect(second.key).toBe(key);
    expect(r.botDeps.events.dialogs!()).toEqual([]);
    expect(r.botDeps.idleEvidence!(key)).toBeUndefined();
  });

  it.each(["stop", "restart", "crash", "idle", "superseded"])(
    "%s: bot.stop first; HTTP, upload teardown and singleton release wait for its bounded drain",
    async (reason) => {
      const order: string[] = [];
      const r = await rig({
        credentials: true,
        wrap: (s) => ({
          ...s,
          stop: () => {
            order.push("bot.stop");
            return s.stop().then(() => {
              order.push("bot.stopped");
            });
          },
          dispose: () => {
            order.push("bot.dispose");
            return s.dispose();
          },
        }),
      });
      await r.hub.close(reason);
      expect(order).toEqual(["bot.stop", "bot.dispose", "bot.stopped"]);
      expect(r.order).toEqual(["http.close"]);
      expect(existsSync(r.hub.paths.hubJson)).toBe(false);
      expect(r.ws.sockets.every((s) => s.readyState === 3)).toBe(true);
    },
  );

  it("startup failure stops the already-constructed bot before frontend cleanup", async () => {
    const order: string[] = [];
    const frontend: FrontendFactory = () => ({
      listen: async () => {
        throw new Error("FA listen failure");
      },
      close: async () => {
        order.push("http.close");
      },
      clientCount: () => 0,
      ui: {
        serve: async () => false,
        refresh: async () => ({ state: "unbuilt", candidates: [] }),
        status: () => ({ state: "unbuilt", candidates: [] }),
      },
    });
    await expect(
      rig({
        frontend,
        credentials: true,
        wrap: (s) => ({
          ...s,
          stop: () => {
            order.push("bot.stop");
            return s.stop().then(() => {
              order.push("bot.stopped");
            });
          },
        }),
      }),
    ).rejects.toThrow("FA listen failure");
    expect(order).toEqual(["bot.stop", "bot.stopped", "http.close"]);
  });

  it("bot keepalive counts with zero agents, reset removes the count; explicit stop still works", async () => {
    const r = await rig({ credentials: true });
    const counts = idleObservations.at(-1)!;
    expect(counts()).toEqual({ agents: 0, sse: 0, headless: 0, bot: 1 });
    expect((await r.service.admin({ t: "fsb_req", rid: "reset", op: "reset", confirm: true })).ok).toBe(true);
    expect(counts()).toEqual({ agents: 0, sse: 0, headless: 0, bot: 0 });
    await r.hub.close("stop");
    expect(r.order).toEqual(["http.close"]);
  });

  it.each(["auth_failed", "credentials-unsafe"])("%s still contributes bot:1 with no agents", async (reason) => {
    const r = await rig({
      credentials: true,
      ...(reason === "auth_failed"
        ? {
            setupFake: (fake: ReturnType<typeof createFakeFeishu>) => {
              fake.on("POST", "/callback/ws/endpoint", () => ({ json: { code: 514, msg: "bad credentials" } }));
            },
          }
        : {}),
    });
    if (reason === "credentials-unsafe") {
      await r.service.stop();
      const { chmod } = await import("node:fs/promises");
      await chmod(join(r.paths.stateDir, "feishu-bot", "credentials.json"), 0o644);
      await r.service.start();
      expect(r.service.snapshot().degraded).toContain("credentials-unsafe");
    } else await eventually(() => expect(r.service.snapshot().status).toBe("auth_failed"));
    expect(idleObservations.at(-1)!()).toEqual({ agents: 0, sse: 0, headless: 0, bot: 1 });
  });

  it("a pathological stop promise cannot consume more than the reserved 6.5s before other cleanup", async () => {
    const r = await rig({ wrap: (s) => ({ ...s, stop: () => new Promise<void>(() => {}) }) });
    vi.useFakeTimers();
    const close = r.hub.close("stop");
    await vi.advanceTimersByTimeAsync(6_499);
    expect(r.order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.order).toEqual(["http.close"]);
    vi.useRealTimers();
    await close;
    expect(await r.hub.closed).toBe("stop");
  });

  it.each([false, true])(
    "onCrash enabled=%s reserves bot stop before the unchanged legacy hard-exit budget",
    async (enabled) => {
      const r = await rig({ enabled });
      vi.useFakeTimers();
      const close = vi.fn(() => new Promise<void>(() => {}));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const on = vi.spyOn(process, "on");
      const uninstall = installProcessHandlers({ ...r.hub, close }, memLog());
      try {
        const handler = on.mock.calls.find(([event]) => event === "uncaughtException")![1] as (err: Error) => void;
        handler(new Error("FA crash"));
        const budget = 3_000 + (enabled ? FEISHU_STOP_RESERVE_MS : 0);
        expect(close.mock.calls[0]?.[0]).toBe("crash");
        const deadline = (close.mock.calls[0] as unknown as [string, { deadline: { remaining(): number } }])[1]
          .deadline;
        expect(deadline.remaining()).toBe(budget - 500);
        await vi.advanceTimersByTimeAsync(budget - 1);
        expect(exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        uninstall();
        on.mockRestore();
        exit.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["close", "startup-failure"])("synchronous bot.stop throw cannot skip %s cleanup", async (path) => {
    const trace: string[] = [];
    const wrap: NonNullable<StartHubDeps["feishuSeams"]>["wrapService"] = (s) => ({
      ...s,
      stop: () => {
        trace.push("bot.stop");
        throw new Error("FA synchronous stop failure");
      },
      dispose: () => {
        trace.push("bot.dispose");
        return s.dispose().then(() => {
          trace.push("bot.disposed");
        });
      },
    });
    if (path === "startup-failure") {
      const frontend: FrontendFactory = () => ({
        listen: async () => {
          throw new Error("FA startup failure");
        },
        close: async () => {
          trace.push("http.close");
        },
        clientCount: () => 0,
        ui: {
          serve: async () => false,
          refresh: async () => ({ state: "unbuilt", candidates: [] }),
          status: () => ({ state: "unbuilt", candidates: [] }),
        },
      });
      await expect(rig({ credentials: true, frontend, wrap })).rejects.toThrow("FA startup failure");
    } else {
      const r = await rig({ credentials: true, wrap, onFrontendClose: () => trace.push("http.close") });
      await r.hub.close("stop");
      expect(await r.hub.closed).toBe("stop");
    }
    expect(trace).toEqual(["bot.stop", "bot.dispose", "bot.disposed", "http.close"]);
  });

  it("actual idle callback stops the bot before frontend cleanup", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const trace: string[] = [];
    const r = await rig({
      onFrontendClose: () => trace.push("http.close"),
      wrap: (s) => ({
        ...s,
        stop: () => {
          trace.push("bot.stop");
          return s.stop();
        },
        dispose: () => {
          trace.push("bot.dispose");
          return s.dispose();
        },
      }),
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await r.hub.closed).toBe("idle");
    expect(trace).toEqual(["bot.stop", "bot.dispose", "http.close"]);
  });

  it("actual socket-fence loss stops the bot first and preserves the foreign socket path", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const trace: string[] = [];
    const r = await rig({
      onFrontendClose: () => trace.push("http.close"),
      wrap: (s) => ({
        ...s,
        stop: () => {
          trace.push("bot.stop");
          return s.stop();
        },
        dispose: () => {
          trace.push("bot.dispose");
          return s.dispose();
        },
      }),
    });
    unlinkSync(r.hub.paths.socketPath);
    writeFileSync(r.hub.paths.socketPath, "foreign hub");
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    expect(await r.hub.closed).toBe("fence");
    expect(trace).toEqual(["bot.stop", "bot.dispose", "http.close"]);
    expect(readFileSync(r.hub.paths.socketPath, "utf8")).toBe("foreign hub");
  });

  it("actual admin restart request stops the bot before frontend cleanup", async () => {
    const trace: string[] = [];
    const r = await rig({
      onFrontendClose: () => trace.push("http.close"),
      wrap: (s) => ({
        ...s,
        stop: () => {
          trace.push("bot.stop");
          return s.stop();
        },
        dispose: () => {
          trace.push("bot.dispose");
          return s.dispose();
        },
      }),
    });
    const { c } = await r.connect();
    c.send({ t: "hub_ctl", rid: "restart", op: "shutdown", reason: "restart" });
    expect(await r.hub.closed).toBe("restart");
    expect(trace).toEqual(["bot.stop", "bot.dispose", "http.close"]);
  });

  it("actual forced version-supersede restart stops/drains bot BEFORE commandRouter.drain", async () => {
    vi.stubEnv("PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS", "10000");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const trace: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig({
      onFrontendClose: () => trace.push("http.close"),
      wrap: (s) => ({
        ...s,
        stop: () => {
          trace.push("bot.stop");
          return s.stop().then(() => gate);
        },
        dispose: () => {
          trace.push("bot.dispose");
          return s.dispose();
        },
      }),
    });
    try {
      const { c, key } = await r.connect();
      c.send({
        t: "dialogs",
        epoch: "epoch-1",
        open: [
          {
            dialogId: "open-1",
            source: "ask_user",
            toolCallId: "tool",
            questions: [{ question: "Choose?", options: [{ label: "Yes" }] }],
            allowCancel: true,
            openedAt: r.clock.now(),
          },
        ],
        closed: [],
      });
      await waitFor(() => (r.frontendDeps.registry.get(key)?.dialogs as any)?.open.length === 1);
      const drain = vi.spyOn(r.frontendDeps.commands!, "drain").mockImplementation(async () => {
        trace.push("commands.drain");
        return { timedOut: false, inflight: 0 };
      });
      await r.connect("1.2.4"); // real hello observation -> supersede controller
      await vi.advanceTimersByTimeAsync(15_000);
      expect(trace).toEqual(["bot.stop", "bot.dispose"]);
      expect(drain).not.toHaveBeenCalled();
      release();
      expect(await r.hub.closed).toBe("superseded");
      expect(trace).toEqual(["bot.stop", "bot.dispose", "commands.drain", "http.close"]);
      drain.mockRestore();
    } finally {
      release();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("the stop reservation covers F8's shared 6000ms budget, without changing legacy close/crash budgets", () => {
    expect(Object.values(FEISHU_SHUTDOWN_BUDGET_MS).reduce((a, b) => a + b, 0)).toBe(6_000);
    expect(FEISHU_STOP_RESERVE_MS).toBe(6_500);
    const text = readFileSync(new URL("../../../src/web-hub/hub/hub.ts", import.meta.url), "utf8");
    expect(text).toContain("hub.info.caps.includes(FSB_HUB_CAP) ? FEISHU_STOP_RESERVE_MS : 0");
  });
});
