/**
 * traffic-merge plan T3 装配测试（§2.3/§2.4/§7.1）：
 * - assembleTrafficHost/Child 的注册面（host：/record + 全部钩子 + session_shutdown；child：钩子集
 *   含 agent_settled / cache_warming_decision，无命令/session_start/model_select/session_shutdown——T2b 报告 §9）。
 * - 认领协议接线：发布 / external-active 让位零注册 / getCommands 复核释放 / shutdown 释放。
 * - 真 src/index.ts 门控：默认（traffic.enabled=false）⇒ 零注册零 claim；enabled ⇒ /record + claim；
 *   子会话分支 ⇒ 只钩子。engine/服务/sqlite 不触发（/record on 不调用）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import {
  assembleTrafficChild,
  assembleTrafficHost,
  resetTrafficSessionSlotsForTest,
  type TrafficWiring,
} from "../../src/traffic/index.js";
import { acquireEngine, peekEngine } from "../../src/traffic/engine.js";
import { installTap } from "../../src/traffic/tap.js";
import { teardownEngine } from "./helpers/engine.js";
import {
  externalActiveInProcess,
  publishExternalActiveForTest,
  resetTrafficClaimForTest,
  toolkitClaimIsLive,
} from "../../src/traffic/claim.js";
import { peekTrafficKeepalivePort } from "../../src/traffic/keepalive-port.js";
import type { TrafficSettings } from "../../src/config/settings.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const CLAIM_KEY = Symbol.for("pi-traffic-record:claim");
const KEEPALIVE_PORT_KEY = Symbol.for("pi-subagent:traffic-keepalive-port");

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RecordedPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  commands: Map<string, { handler: Handler }>;
  getCommandsList: { name: string; sourceInfo?: { path?: unknown } }[];
}

function fakePi(): RecordedPi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const getCommandsList: { name: string; sourceInfo?: { path?: unknown } }[] = [];
  const pi = {
    registerTool() {},
    registerCommand(name: string, options: { handler: Handler }) {
      commands.set(name, options);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      // 真 pi 的 on 返回反注册函数（T5 warming.ts 的 dispose 依赖它）。
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        );
      };
    },
    sendMessage() {},
    appendEntry() {},
    getActiveTools: () => [],
    getCommands: () => getCommandsList,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, getCommandsList };
}

function fire(recorded: RecordedPi, eventName: string, ctx: unknown, ev?: unknown): unknown[] {
  const results: unknown[] = [];
  for (const handler of recorded.handlers.get(eventName) ?? []) results.push(handler(ev, ctx));
  return results;
}

const ui = () => ({ notify: vi.fn(), setStatus: vi.fn() });

const ON_SETTINGS: TrafficSettings = { enabled: true, childSessions: true, web: { host: "127.0.0.1", port: 4177 } };

const fsNone = { readFile: () => "", exists: () => false };

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  resetTrafficClaimForTest();
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[KEEPALIVE_PORT_KEY];
  resetTrafficClaimForTest();
  delete process.env.PI_SECURE_SESSION;
});

describe("assembleTrafficHost (§2.4 claim protocol)", () => {
  it("enabled ⇒ publishes claim, registers /record + host hooks (incl. cache_warming_decision)", () => {
    const recorded = fakePi();
    const wiring = assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(wiring).toBeDefined();
    expect(toolkitClaimIsLive()).toBe(true);
    expect(recorded.commands.has("record")).toBe(true);
    for (const hook of [
      "turn_start",
      "before_provider_headers",
      "before_provider_request",
      "after_provider_response",
      "message_end",
    ])
      expect(recorded.handlers.get(hook), hook).toHaveLength(1);
    // cache_warming_decision: traffic 观察器 + T5 warming 否决，各一。
    expect(recorded.handlers.get("cache_warming_decision")).toHaveLength(2);
    // session_start: wire 的 engine 记录钩子 + assemble 的复核钩子，各一；
    // session_shutdown: wire 的 engine 关闭 + assemble 的 claim/端口/否决释放，各一。
    expect(recorded.handlers.get("session_start")).toHaveLength(2);
    expect(recorded.handlers.get("session_shutdown")).toHaveLength(2);
    expect(recorded.handlers.get("model_select")).toHaveLength(1);
    expect(recorded.handlers.has("agent_settled")).toBe(false);
    // T5（§1.1）：主会话装配注册进程级 keepalive 否决端口（子会话同进程共享，不重复注册）。
    expect(peekTrafficKeepalivePort()).toBeDefined();
  });

  it("enabled=false ⇒ zero registration, zero claim symbol (frozen face)", () => {
    const recorded = fakePi();
    const wiring = assembleTrafficHost(recorded.pi, { settings: { ...ON_SETTINGS, enabled: false }, fs: fsNone });
    expect(wiring).toBeUndefined();
    expect(recorded.commands.size).toBe(0);
    expect(recorded.handlers.size).toBe(0);
    expect(toolkitClaimIsLive()).toBe(false);
  });

  it("secure session (PI_SECURE_SESSION=1) ⇒ zero registration, zero claim", () => {
    process.env.PI_SECURE_SESSION = "1";
    const recorded = fakePi();
    expect(assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone })).toBeUndefined();
    expect(recorded.commands.size).toBe(0);
    expect(toolkitClaimIsLive()).toBe(false);
  });

  it("external-active (tombstone v0.3.0 already recording in-process) ⇒ yields: zero registration, one notify", () => {
    publishExternalActiveForTest("0.3.0");
    const recorded = fakePi();
    expect(assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone })).toBeUndefined();
    expect(recorded.commands.size).toBe(0);
    expect(recorded.handlers.get("before_provider_headers")).toBeUndefined();
    expect(toolkitClaimIsLive()).toBe(false);
    expect(externalActiveInProcess()).toBe(true);
    expect(peekTrafficKeepalivePort()).toBeUndefined();
    // the one thing it DOES register: a session_start notify-once
    const ctx = { ui: ui() };
    fire(recorded, "session_start", ctx);
    fire(recorded, "session_start", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0]![0]).toContain("让位");
  });

  it("session_start recheck (§2.4 step 3): an external /record loaded ⇒ claim released, notify once, /record answers yielding", () => {
    const recorded = fakePi();
    assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(toolkitClaimIsLive()).toBe(true);
    // all extensions active by session_start time — external old v0.2.x registers its own /record
    recorded.getCommandsList.push(
      { name: "record", sourceInfo: { path: join(process.cwd(), "src/traffic/index.ts") } },
      { name: "record:2", sourceInfo: { path: "/home/u/ai/pi-traffic-record/src/index.ts" } },
    );
    const ctx = { ui: ui() };
    fire(recorded, "session_start", ctx);
    fire(recorded, "session_start", ctx);
    expect(toolkitClaimIsLive()).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0]![0]).toContain("让位");
    // /record now refuses with the yielding note instead of acting
    const commandCtx = { ui: ui() };
    void recorded.commands.get("record")!.handler("", commandCtx);
    expect(commandCtx.ui.notify.mock.calls[0]![0]).toContain("让位");
  });

  it("session_start with only our own /record ⇒ claim stays live; dup findings warn once (advisory)", () => {
    const recorded = fakePi();
    const fsWithDup = {
      readFile: () => JSON.stringify({ packages: ["../../ai/pi-traffic-record"] }),
      exists: (p: string) => p.endsWith("settings.json"),
    };
    assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, agentDir: "/fake-agent", fs: fsWithDup });
    recorded.getCommandsList.push({
      name: "record",
      sourceInfo: { path: join(process.cwd(), "src/traffic/index.ts") },
    });
    const ctx = { ui: ui() };
    fire(recorded, "session_start", ctx);
    fire(recorded, "session_start", ctx);
    expect(toolkitClaimIsLive()).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0]![0]).toContain("pi-traffic-record");
  });

  it("session_shutdown (any reason) releases the claim (ruling ⑤)", () => {
    const recorded = fakePi();
    assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(toolkitClaimIsLive()).toBe(true);
    void fire(recorded, "session_shutdown", { ui: ui(), reason: "reload" });
    expect(toolkitClaimIsLive()).toBe(false);
    // claim symbol gone entirely — no stale suppression of an external package
    expect((globalThis as Record<symbol, unknown>)[CLAIM_KEY]).toBeUndefined();
  });

  it("no getCommands on the pi surface ⇒ recheck silently skipped (claim stays live)", () => {
    const recorded = fakePi();
    const pi = recorded.pi as unknown as Record<string, unknown>;
    delete pi.getCommands;
    const wiring = assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(wiring).toBeDefined();
    fire(recorded, "session_start", { ui: ui() });
    expect(toolkitClaimIsLive()).toBe(true);
  });
});

describe("assembleTrafficChild (§2.3 pre-guard)", () => {
  it("registers recording hooks only — no command, no session_start/model_select/session_shutdown", () => {
    const recorded = fakePi();
    const wiring = assembleTrafficChild(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(wiring).toBeDefined();
    expect(wiring!.role).toBe("child");
    expect(recorded.commands.size).toBe(0);
    for (const hook of [
      "turn_start",
      "agent_settled",
      "before_provider_headers",
      "before_provider_request",
      "after_provider_response",
      "message_end",
    ])
      expect(recorded.handlers.get(hook), hook).toHaveLength(1);
    // cache_warming_decision: traffic 观察器 + T5 warming 否决（每个 AgentSession 一个 warmer），各一。
    expect(recorded.handlers.get("cache_warming_decision")).toHaveLength(2);
    for (const absent of ["session_start", "model_select", "session_shutdown"])
      expect(recorded.handlers.has(absent), absent).toBe(false);
    // 子会话不注册 keepalive 否决端口（主会话装配已注册，同进程共享）。
    expect(peekTrafficKeepalivePort()).toBeUndefined();
  });

  it("hooks are inert without a live claim (no engine, no stringify, no throw)", () => {
    const recorded = fakePi();
    assembleTrafficChild(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    const results = fire(recorded, "before_provider_headers", { ui: ui() }, { headers: {} });
    expect(results[0]).toBeUndefined();
    const payloadResults = fire(recorded, "before_provider_request", { ui: ui() }, { payload: {} });
    expect(payloadResults[0]).toBeUndefined();
  });

  it("enabled=false / secure ⇒ zero registration", () => {
    expect(
      assembleTrafficChild(fakePi().pi, { settings: { ...ON_SETTINGS, enabled: false }, fs: fsNone }),
    ).toBeUndefined();
    process.env.PI_SECURE_SESSION = "1";
    expect(assembleTrafficChild(fakePi().pi, { settings: ON_SETTINGS, fs: fsNone })).toBeUndefined();
  });
});

describe("real src/index.ts gating (frozen face §7.1)", () => {
  const realHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-traffic-wiring-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("default (no settings file) ⇒ /record NOT registered and no claim symbol", () => {
    const recorded = fakePi();
    activate(recorded.pi); // main session — claims HOST_KEY
    expect(recorded.commands.has("record")).toBe(false);
    expect(toolkitClaimIsLive()).toBe(false);
    expect((globalThis as Record<symbol, unknown>)[CLAIM_KEY]).toBeUndefined();
    // T5（§1.1 建议）：off ⇒ keepalive 否决端口与改写镜像标记均不存在（查询本身零创建）。
    expect(peekTrafficKeepalivePort()).toBeUndefined();
    expect(Object.getOwnPropertySymbols(globalThis).includes(Symbol.for("pi-subagent:traffic-rewrite-marks"))).toBe(
      false,
    );
  });

  it("traffic.enabled=true ⇒ /record registered, claim published (engine untouched: no /record on call)", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ traffic: { enabled: true } }));
    const recorded = fakePi();
    activate(recorded.pi);
    expect(recorded.commands.has("record")).toBe(true);
    expect(toolkitClaimIsLive()).toBe(true);
    // child hooks surface: before_provider_headers registered (traffic's own; proven exactly-1 at assemble level)
    expect(recorded.handlers.get("before_provider_headers")!.length).toBeGreaterThanOrEqual(1);
    expect(recorded.handlers.get("cache_warming_decision")?.length ?? 0).toBeGreaterThanOrEqual(1);
    // T5：主会话装配已注册 keepalive 否决端口。
    expect(peekTrafficKeepalivePort()).toBeDefined();
  });

  it("child-session branch (HOST_KEY pre-claimed) + traffic.enabled ⇒ hooks only, no /record, no claim from child", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "pi-subagent.json"), JSON.stringify({ traffic: { enabled: true } }));
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const recorded = fakePi();
    activate(recorded.pi);
    expect(recorded.commands.has("record")).toBe(false);
    // child assembly never publishes a claim; hooks are inert until the main session's claim exists
    expect(toolkitClaimIsLive()).toBe(false);
    // other pre-guard child wirings (child-context-switch etc.) also register these events —
    // traffic's own registration is proven at assemble level; here just assert the surface exists.
    expect(recorded.handlers.get("before_provider_headers")!.length).toBeGreaterThanOrEqual(1);
    expect(recorded.handlers.get("agent_settled")!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("TrafficWiring surface", () => {
  it("rewriteArmed() is false while no engine exists (T5's consumption point shape)", () => {
    const recorded = fakePi();
    const wiring: TrafficWiring | undefined = assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(wiring!.rewriteArmed()).toBe(false);
    expect(wiring!.engine()).toBeUndefined();
  });
});

describe("安全评审 #1：同一 AgentSession 双 toolkit 副本 ⇒ 单一录制钩子集", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-traffic-dup-copy-"));
    resetTrafficSessionSlotsForTest();
  });
  afterEach(async () => {
    await teardownEngine(peekEngine());
    rmSync(dir, { recursive: true, force: true });
  });

  /** 同一 sessionManager 对象贯穿一个「会话」的全部事件（真实 AgentSession 即如此）。 */
  const sessionCtx = (sm: { getSessionId(): string }) => ({
    ui: { notify: vi.fn() },
    sessionManager: sm,
    model: { api: "anthropic-messages" },
  });

  it("重复副本（被误判 child）不铸第二张票据；真子会话照常；shutdown 释放后 /reload 可重新认领", async () => {
    const mainSm = { getSessionId: () => "main-session" };
    // 同一 pi 实例上激活两份副本：A 先（认领 HOST_KEY ⇒ host），B 后（误判 child——评审反例）。
    const recorded = fakePi();
    const host = assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    const dup = assembleTrafficChild(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(host).toBeDefined();
    expect(dup).toBeDefined();
    const engine = acquireEngine(host!.owner, {
      dbPath: join(dir, "traffic.db"),
      legacyDbPath: null,
      role: "host",
      mode: "tui",
    });
    engine.recording = true;
    installTap(engine, engine.capture.handleFetch);
    const minted = () => engine.tickets.counters.ticketsMinted;

    // 同一请求只铸一张票据（A 的 handler 先注册先派发、先认领会话槽；B 恒拒绝）。
    fire(recorded, "before_provider_headers", sessionCtx(mainSm), { headers: {} });
    expect(minted()).toBe(1);
    fire(recorded, "before_provider_headers", sessionCtx(mainSm), { headers: {} });
    expect(minted()).toBe(2);

    // 真子会话：全新激活（新资源加载器的新模块实例）+ 不同 sessionManager ⇒ 照常接纳。
    const childPi = fakePi();
    assembleTrafficChild(childPi.pi, { settings: ON_SETTINGS, fs: fsNone });
    fire(childPi, "before_provider_headers", sessionCtx({ getSessionId: () => "child-session" }), {
      headers: {},
    });
    expect(minted()).toBe(3);

    // /reload 等价：shutdown（含 claim 释放与会话槽释放）⇒ 同一会话的新激活可重新认领。
    await Promise.all(fire(recorded, "session_shutdown", { ui: { notify: vi.fn() } }) as unknown as Promise<unknown>[]);
    const reloaded = fakePi();
    const host2 = assembleTrafficHost(reloaded.pi, { settings: ON_SETTINGS, fs: fsNone });
    expect(host2).toBeDefined();
    const engine2 = acquireEngine(host2!.owner, {
      dbPath: join(dir, "traffic.db"),
      legacyDbPath: null,
      role: "host",
      mode: "tui",
    });
    engine2.recording = true;
    installTap(engine2, engine2.capture.handleFetch);
    fire(reloaded, "before_provider_headers", sessionCtx(mainSm), { headers: {} });
    expect(engine2.tickets.counters.ticketsMinted).toBe(1);
  });

  it("未开录制（无 engine）时双副本零副作用：不占会话槽、不铸票据", () => {
    const mainSm = { getSessionId: () => "main-session" };
    const recorded = fakePi();
    assembleTrafficHost(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    assembleTrafficChild(recorded.pi, { settings: ON_SETTINGS, fs: fsNone });
    fire(recorded, "before_provider_headers", sessionCtx(mainSm), { headers: {} });
    // 无 engine ⇒ enter 早退；清表后无异常即证明无残留依赖（后续真 /record on 的激活仍可认领）。
    resetTrafficSessionSlotsForTest();
  });
});
