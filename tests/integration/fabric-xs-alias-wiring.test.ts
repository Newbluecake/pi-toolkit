import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createListSessionsTool } from "../../src/tools/list-sessions-tool.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import type { XsSender } from "../../src/fabric/xs/sender.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import {
  XS_ALIAS_AGENT_CAP,
  XS_ALIAS_HUB_CAP,
  XS_CHANNEL_HUB_CAP,
  XS_HUB_CAP,
  XS_REPLY_HUB_CAP,
} from "../../src/web-hub/protocol/xs.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * alias-plan ALW: the assembly anchor — a REAL `activate()` × REAL stack × REAL web-hub bridge against a fake hub
 * socket. Pins every ALW wiring point: tool instance freeze by the LOCAL setting, agent cap + hub config key, the
 * attach/hello_ack reconcile ordering (after `xs_member`), the one-shot lost notice through `ctx.ui.notify`, the
 * `StatusInfo.xs.alias` projection, the sender's full-sessionId pin (`aliasUsable`), the `/fabric alias` port and
 * the receive-side `from.alias` gate (dropped unless alias-usable).
 */

const FIXED_NOW = 1_769_000_000_000;
const PEER_SID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

const pin = vi.hoisted(() => ({ current: undefined as undefined | ((deps: any) => any) }));
vi.mock("../../src/web-hub/agent/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/web-hub/agent/index.js")>();
  return {
    ...actual,
    wireWebHub: (pi: unknown, deps: any) => actual.wireWebHub(pi as never, pin.current ? pin.current(deps) : deps),
  };
});
// eslint-disable-next-line import/first -- must load after the mock above
const { default: activate } = await import("../../src/index.js");

function clearXsGlobals(): void {
  const g = globalThis as Record<symbol, unknown>;
  for (const key of [
    "pi-subagent:host",
    "pi-subagent:xs-epoch",
    "pi-subagent:xs-unread",
    "pi-subagent:xs-host-cap",
    "pi-subagent:xs-wake-ledger",
    "pi-subagent:xs-reply-ledger",
    "pi-subagent:xs-dedup",
    "pi-subagent:xs-alias-lost",
  ])
    delete g[Symbol.for(key)];
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
  pin.current = undefined;
  vi.useRealTimers();
});

type Frame = Record<string, any>;

async function boot(opts: { alias: boolean; hubAlias: boolean }) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(FIXED_NOW);
  clearXsGlobals();
  resetGlobals();
  const home = sandboxHome();
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = "";
  cleanup.push(() => {
    resetGlobals();
    clearXsGlobals();
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    home.restore();
  });
  const agentDir = join(home.home, ".pi/agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "pi-subagent.json"),
    JSON.stringify({
      fleetWidget: false,
      webSearch: { enabled: false },
      date: { enabled: false },
      memory: { enabled: false },
      todo: { enabled: false },
      hud: { enabled: false },
      feishuNotify: { enabled: false },
      sessionNav: { enabled: false },
      askUser: { enabled: true },
      title: { enabled: false },
      topicSwitch: { enabled: false },
      quota: { enabled: false },
      load: { enabled: false },
      cacheTtl: { keepalive: false },
      compact: { dynamicThreshold: { mode: "off" } },
      bashJobs: { autoBackgroundS: 0 },
      reload: { defer: false },
      systemPrompt: { mode: "legacy" },
      webHub: { enabled: true, autoStart: false, control: true },
      fabric: {
        enabled: true,
        wake: { enabled: true },
        crossSession: { enabled: true, autoJoin: true, alias: { enabled: opts.alias } },
      },
    }),
  );
  const net = fakeNet();
  const spawnEnv: NodeJS.ProcessEnv[] = [];
  const nodeLoader = join(home.home, "jiti.mjs");
  writeFileSync(nodeLoader, "");
  pin.current = (deps) => ({
    ...deps,
    settings: { ...SETTINGS, autoStart: true, nodeLoader },
    env: { HOME: home.home },
    paths: { ...pathsIn(home.home), stoppedFile: join(home.home, "stopped") },
    buildInfo: async () => ({ pluginVersion: "0.0.0-alw", buildId: "alw-build" }),
    argv1: "/nonexistent/pi",
    netConnect: net.netConnect,
    spawnImpl: ((_exe: string, _argv: string[], o: { env: NodeJS.ProcessEnv }) => {
      spawnEnv.push(o.env);
      return { on: () => undefined, unref: () => undefined } as never;
    }) as never,
    now: () => FIXED_NOW,
  });

  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: Array<{ content?: unknown; customType?: string }> = [];
  const pi = {
    on: (event: string, fn: Function) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => undefined;
    },
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, c: any) => commands.set(name, c),
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendMessage: (m: any) => sent.push(m),
    sendUserMessage() {},
    appendEntry() {},
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    getCommands: () => [],
    getSessionName: () => undefined,
    events: { on: () => () => undefined, emit() {} },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;

  const sessionDir = join(home.home, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sm = SessionManager.create("/tmp/wa", sessionDir);
  sm.appendMessage({ role: "user", content: "fixture", timestamp: FIXED_NOW });
  const notifies: Array<{ text: string; level?: string }> = [];
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/wa/前端项目",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
    sessionManager: sm,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => undefined,
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
    ui: {
      setStatus() {},
      notify: (text: string, level?: string) => notifies.push({ text, ...(level ? { level } : {}) }),
      setWidget() {},
      setFooter() {},
      setEditorComponent() {},
      getEditorComponent: () => undefined,
      addAutocompleteProvider() {},
      custom: () => Promise.reject(new Error("no ui")),
      input: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
    },
  };

  activate(pi);
  for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, ctx);
  await vi.advanceTimersByTimeAsync(50);
  net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
  for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
  const socket = net.sockets[1]!;
  socket.emit("connect");
  const hubCaps = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP, XS_REPLY_HUB_CAP, XS_CHANNEL_HUB_CAP];
  socket.hub(ackFrame("a1-key", 4242, opts.hubAlias ? [...hubCaps, XS_ALIAS_HUB_CAP] : hubCaps));
  await vi.advanceTimersByTimeAsync(50);
  const frames = (): Frame[] => socket.frames() as Frame[];
  const reqs = (op: string): Frame[] => frames().filter((f) => f.t === "xs_req" && f.op === op);
  const answer = (req: Frame, body: Frame) => socket.hub({ t: "xs_res", rid: String(req.rid), ...body } as never);
  const member = () => [...frames()].reverse().find((f) => f.t === "xs_member")!;
  const deliver = (from: Frame) => {
    const m = member();
    socket.hub({
      t: "xs_deliver",
      rid: `d${Math.random().toString(16).slice(2, 10)}`,
      xid: `x${"0".repeat(17)}${sent.length}`,
      to: { sessionId: m.sessionId, epoch: m.epoch },
      from: { sessionId: PEER_SID, ref: PEER_SID.slice(0, 12), cwdLabel: "~/peer", agentId: "peer-agent", ...from },
      text: "hello",
      wake: false,
      expiresAt: FIXED_NOW + 60_000,
    } as never);
  };
  const config = JSON.parse(String(spawnEnv[0]?.PI_WEBHUB_CONFIG ?? "{}")) as Frame;
  return { socket, frames, reqs, answer, deliver, tools, commands, sent, notifies, ctx, config, handlers };
}

const stubSender = {} as XsSender;

describe("alias-plan ALW: activate assembly", () => {
  it("alias on × hub cap: cap/config, reconcile after xs_member, status projection, one-shot lost notice", async () => {
    const r = await boot({ alias: true, hubAlias: true });
    const hello = r.frames()[0]!;
    expect(hello.caps).toContain(XS_ALIAS_AGENT_CAP);
    expect(r.config.crossSession.alias).toEqual({ offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 });
    // hello_ack reconcile: exactly one read-only get, emitted AFTER the (re)published xs_member slot.
    const gets = r.reqs("alias");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.alias).toBeUndefined();
    expect(gets[0]!.clear).toBeUndefined();
    const all = r.frames();
    const memberIdx = all.findIndex((f) => f.t === "xs_member");
    expect(memberIdx).toBeGreaterThan(-1);
    expect(all.findIndex((f) => f.t === "xs_req" && f.op === "alias")).toBeGreaterThan(memberIdx);
    r.answer(gets[0]!, { ok: true, alias: { state: "held", alias: "前端" } });
    await vi.advanceTimersByTimeAsync(50);
    const lastStatus = [...r.frames()].reverse().find((f) => f.t === "status")!;
    expect(lastStatus.xs.alias).toBe("前端");
    expect(r.notifies.filter((n) => n.text.includes("别名"))).toHaveLength(0);

    // /fabric alias (bare get) → second get; the hub reports it was taken ⇒ ONE notice; a repeat is de-duplicated.
    const fabric = r.commands.get("fabric");
    const run = fabric.handler("alias", r.ctx);
    await vi.advanceTimersByTimeAsync(10);
    const lost = { state: "none", lost: { alias: "前端", reason: "taken", at: FIXED_NOW - 1000 } };
    r.answer(r.reqs("alias")[1]!, { ok: true, alias: lost });
    await vi.advanceTimersByTimeAsync(10);
    await run;
    await vi.advanceTimersByTimeAsync(10);
    // the command's own non-blocking reconcile
    for (const req of r.reqs("alias").slice(2)) r.answer(req, { ok: true, alias: lost });
    await vi.advanceTimersByTimeAsync(50);
    expect(r.reqs("alias").length).toBeGreaterThanOrEqual(3); // the repeat really happened
    const lostNotices = r.notifies.filter((n) => n.text.includes("已被其他会话抢占"));
    expect(lostNotices).toHaveLength(1);
    const afterLost = [...r.frames()].reverse().find((f) => f.t === "status")!;
    expect(afterLost.xs.alias).toBeUndefined();

    // completion hints come from the live ctx (cwd tail / CJK runs), normalized by the command
    const items = (fabric.getArgumentCompletions?.("alias ") ?? []) as Array<{ label: string }>;
    expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["--clear", "前端项目"]));
  }, 30_000);

  it("alias on × hub cap: message_session pins the resolved FULL sessionId; inbound from.alias reaches the header", async () => {
    const r = await boot({ alias: true, hubAlias: true });
    r.answer(r.reqs("alias")[0]!, { ok: true, alias: { state: "none" } });
    await vi.advanceTimersByTimeAsync(20);
    expect(r.tools.get("message_session").description).toContain("aliases are unique on this hub");
    expect(r.tools.get("list_sessions").description).toContain("alias is a human-assigned");

    const call = r.tools.get("message_session").execute("t1", { to: "前端", text: "hi" }, undefined);
    await vi.advanceTimersByTimeAsync(10);
    const resolve = r.reqs("resolve")[0]!;
    expect(resolve.query).toBe("前端");
    r.answer(resolve, { ok: true, target: { ref: PEER_SID.slice(0, 12), sessionId: PEER_SID, alias: "前端" } });
    await vi.advanceTimersByTimeAsync(10);
    const send = r.reqs("send")[0]!;
    expect(send.to).toBe(PEER_SID);
    r.answer(send, { ok: true, effect: "applied" });
    await vi.advanceTimersByTimeAsync(10);
    const out = await call;
    const text = JSON.stringify(out);
    expect(text).toContain("前端");
    expect(text).not.toContain(PEER_SID); // the full id never reaches the model-visible result

    r.deliver({ alias: "后端" });
    await vi.advanceTimersByTimeAsync(10);
    const msg = r.sent.find((m) => m.customType === "subagent:xs")!;
    expect(String(msg.content)).toContain(' alias="后端"');
  }, 30_000);

  it("alias on × hub cap: `@前端` — a miss warms the directory, the next attempt routes by alias to the full id", async () => {
    const r = await boot({ alias: true, hubAlias: true });
    r.answer(r.reqs("alias")[0]!, { ok: true, alias: { state: "none" } });
    await vi.advanceTimersByTimeAsync(20);
    const input = async (text: string) => {
      const results: unknown[] = [];
      for (const h of r.handlers.get("input") ?? [])
        results.push(await h({ type: "input", text, source: "interactive" }, r.ctx));
      return results;
    };
    expect(r.reqs("list")).toHaveLength(0);
    const first = await input("@前端 帮我看下接口");
    expect(first.some((x) => (x as { action?: string })?.action === "handled")).toBe(false); // cache empty ⇒ pass through
    const lists = r.reqs("list");
    expect(lists.length).toBeGreaterThanOrEqual(1); // the miss triggered the (single-flight) refresh
    r.answer(lists[lists.length - 1]!, {
      ok: true,
      rows: [
        {
          ref: PEER_SID.slice(0, 12),
          alias: "前端",
          cwdLabel: "~/peer",
          kind: "tui",
          receive: "wake",
          busy: false,
          lastActiveAgoS: 1,
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(20);
    const pending = input("@前端 帮我看下接口");
    await vi.advanceTimersByTimeAsync(10);
    const resolve = r.reqs("resolve")[0]!;
    expect(resolve.query).toBe("前端");
    r.answer(resolve, { ok: true, target: { ref: PEER_SID.slice(0, 12), sessionId: PEER_SID, alias: "前端" } });
    await vi.advanceTimersByTimeAsync(10);
    const send = r.reqs("send")[0]!;
    expect(send.to).toBe(PEER_SID);
    r.answer(send, { ok: true, effect: "applied" });
    await vi.advanceTimersByTimeAsync(10);
    const second = await pending;
    expect(second.some((x) => (x as { action?: string })?.action === "handled")).toBe(true);
  }, 30_000);

  it("alias on × hub WITHOUT the cap: zero alias frames, raw `to`, and a stray from.alias is dropped", async () => {
    const r = await boot({ alias: true, hubAlias: false });
    expect(r.reqs("alias")).toHaveLength(0);
    const call = r.tools.get("message_session").execute("t1", { to: "前端", text: "hi" }, undefined);
    await vi.advanceTimersByTimeAsync(10);
    r.answer(r.reqs("resolve")[0]!, { ok: true, target: { ref: PEER_SID.slice(0, 12) } });
    await vi.advanceTimersByTimeAsync(10);
    const send = r.reqs("send")[0]!;
    expect(send.to).toBe("前端"); // legacy: the hub re-resolves the raw address
    r.answer(send, { ok: true, effect: "applied" });
    await vi.advanceTimersByTimeAsync(10);
    await call;
    r.deliver({ alias: "后端" });
    await vi.advanceTimersByTimeAsync(10);
    const msg = r.sent.find((m) => m.customType === "subagent:xs")!;
    expect(String(msg.content)).not.toContain("alias=");
    // /fabric status renders the hub-cap-off alias line (port wired, cache not usable)
    const fabric = r.commands.get("fabric");
    const run = fabric.handler("status", r.ctx);
    await vi.advanceTimersByTimeAsync(10);
    for (const req of r.reqs("info")) r.answer(req, { ok: false, code: "E_XS_BAD_FRAME" });
    await vi.advanceTimersByTimeAsync(10);
    await run;
    expect(r.notifies.some((n) => n.text.includes("alias n/a (hub-cap off)"))).toBe(true);
  }, 30_000);

  it("alias off: legacy tool instances/descriptions, no cap/config key, no alias frames even if the hub has the cap", async () => {
    const r = await boot({ alias: false, hubAlias: true });
    const hello = r.frames()[0]!;
    expect(hello.caps).not.toContain(XS_ALIAS_AGENT_CAP);
    expect(r.config.crossSession.alias).toBeUndefined();
    expect(r.reqs("alias")).toHaveLength(0);
    const legacyList = createListSessionsTool({ sender: stubSender, channels: true });
    const legacyMsg = createMessageSessionTool({ sender: stubSender, reply: true });
    expect(r.tools.get("list_sessions").description).toBe(legacyList.description);
    expect(r.tools.get("list_sessions").parameters).toBe(legacyList.parameters);
    expect(r.tools.get("message_session").description).toBe(legacyMsg.description);
    expect(r.tools.get("message_session").parameters).toBe(legacyMsg.parameters);
    r.deliver({ alias: "后端" });
    await vi.advanceTimersByTimeAsync(10);
    const msg = r.sent.find((m) => m.customType === "subagent:xs")!;
    expect(String(msg.content)).not.toContain("alias=");
    const status = [...r.frames()].reverse().find((f) => f.t === "status")!;
    expect("alias" in (status.xs ?? {})).toBe(false);
    const fabric = r.commands.get("fabric");
    const run = fabric.handler("status", r.ctx);
    await vi.advanceTimersByTimeAsync(10);
    for (const req of r.reqs("info")) r.answer(req, { ok: false, code: "E_XS_BAD_FRAME" });
    await vi.advanceTimersByTimeAsync(10);
    await run;
    expect(r.notifies.some((n) => n.text.includes("alias n/a (alias.enabled=false)"))).toBe(true);
  }, 30_000);
});
