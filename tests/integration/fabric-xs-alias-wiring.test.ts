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
  XS_ALIAS_V2_HUB_CAP,
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
    "pi-subagent:xs-alias-auto-noticed",
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

interface BootOpts {
  alias: boolean;
  hubAlias: boolean;
  /** AFW: the fake hub also declares `xs.alias.v2`. */
  hubV2?: boolean;
  /** AFW: `fabric.crossSession.alias.autoFromCwd` (absent ⇒ the default, true). */
  autoFromCwd?: boolean;
  /** AFW: activate as a CHILD session (the host claim is already taken). */
  child?: boolean;
  /** AFW: runs on the session manager before `session_start` (seed history entries). */
  seed?: (sm: SessionManager) => void;
}

async function boot(opts: BootOpts) {
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
        crossSession: {
          enabled: true,
          autoJoin: true,
          alias: { enabled: opts.alias, ...(opts.autoFromCwd !== undefined ? { autoFromCwd: opts.autoFromCwd } : {}) },
        },
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
  const appended: Array<{ customType: string; data: unknown }> = [];
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
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
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
  opts.seed?.(sm);
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

  if (opts.child) (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:host")] = { activatedAt: FIXED_NOW };
  activate(pi);
  for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, ctx);
  await vi.advanceTimersByTimeAsync(50);
  if (opts.child) {
    // A child session is inert: no hub link at all (I6). Nothing else of the return shape is meaningful.
    await vi.advanceTimersByTimeAsync(5_000);
    return { net, tools, commands, handlers, notifies, appended, sm, ctx } as unknown as Awaited<
      ReturnType<typeof bootMain>
    >;
  }
  return bootMain();
  async function bootMain() {
    net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
    for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
    const socket = net.sockets[1]!;
    socket.emit("connect");
    const hubCaps = [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP, XS_REPLY_HUB_CAP, XS_CHANNEL_HUB_CAP];
    socket.hub(
      ackFrame(
        "a1-key",
        4242,
        opts.hubAlias ? [...hubCaps, XS_ALIAS_HUB_CAP, ...(opts.hubV2 === true ? [XS_ALIAS_V2_HUB_CAP] : [])] : hubCaps,
      ),
    );
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
    return {
      socket,
      frames,
      reqs,
      answer,
      deliver,
      tools,
      commands,
      sent,
      notifies,
      ctx,
      config,
      handlers,
      appended,
      sm,
      net,
      sessionDir,
    };
  }
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

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// #72 AFW: alias auto-claim + forced takeover wiring — REAL activate() × REAL stack × fake hub socket.

const DECIDED_TYPE = "subagent:xs-alias-decided";
const AUTO_ALIAS = "前端项目"; // basename of the fixture cwd `/tmp/wa/前端项目`

type Booted = Awaited<ReturnType<typeof boot>>;
const intentFrames = (r: Booted): Frame[] => r.frames().filter((f) => f.t === "xs_req" && f.intent !== undefined);
const autoFrames = (r: Booted): Frame[] => intentFrames(r).filter((f) => f.intent === "auto");
const settle = (ms = 50) => vi.advanceTimersByTimeAsync(ms);

/** Answer the attach reconcile `get` with `state:"none"` and let the auto tail run. */
async function attachNone(r: Booted): Promise<void> {
  const get = r.reqs("alias")[0]!;
  expect(get.alias).toBeUndefined();
  r.answer(get, { ok: true, alias: { state: "none" } });
  await settle();
}

/** Run a `/fabric …` command, answering every alias request the way a hub with no record would. */
async function fabric(r: Booted, args: string, answerWith: (req: Frame) => Frame): Promise<void> {
  const seen = new Set<string>(r.reqs("alias").map((f) => String(f.rid)));
  const other = new Set<string>();
  const run = r.commands.get("fabric").handler(args, r.ctx);
  for (let i = 0; i < 6; i++) {
    await settle(10);
    for (const req of r.reqs("alias")) {
      if (seen.has(String(req.rid))) continue;
      seen.add(String(req.rid));
      r.answer(req, answerWith(req));
    }
    // `/fabric status|join|leave` also ask the hub for limits / channels: refuse them (display only)
    for (const op of ["info", "channels", "list"])
      for (const req of r.reqs(op)) {
        if (other.has(String(req.rid))) continue;
        other.add(String(req.rid));
        r.answer(req, { ok: false, code: "E_XS_BAD_FRAME" });
      }
  }
  await run;
  await settle();
}
const hubNone = (): Frame => ({ ok: true, alias: { state: "none" } });
const hubEcho = (req: Frame): Frame =>
  req.alias === undefined
    ? hubNone()
    : req.clear === true
      ? hubNone()
      : { ok: true, alias: { state: "held", alias: req.alias, ...(req.intent === "auto" ? { origin: "auto" } : {}) } };

describe("#72 AFW: alias auto-claim wiring", () => {
  it("v2 hub: attach ⇒ get(none) ⇒ exactly one intent:auto for the cwd basename, one-shot notice, held (auto) in /fabric status", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    expect(r.frames()[0]!.caps).toContain("xs.alias.v2");
    expect(r.reqs("alias")).toHaveLength(1);
    await attachNone(r);
    const auto = autoFrames(r);
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ op: "alias", alias: AUTO_ALIAS, intent: "auto" });
    // the auto write goes out AFTER the (re)published member slot (the hub requires joined for auto)
    const all = r.frames();
    expect(all.findIndex((f) => f.t === "xs_member")).toBeLessThan(all.findIndex((f) => f.intent === "auto"));
    // joined member ⇒ the auto frame is the ONLY write; no decided marker was written by the machine
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE)).toHaveLength(0);

    r.answer(auto[0]!, { ok: true, alias: { state: "held", alias: AUTO_ALIAS, origin: "auto" } });
    await settle();
    expect(r.notifies.filter((n) => n.text.includes(`已按目录名自动设置别名 @${AUTO_ALIAS}`))).toHaveLength(1);
    const status = [...r.frames()].reverse().find((f) => f.t === "status")!;
    expect(status.xs.alias).toBe(AUTO_ALIAS);

    // /fabric status: the cached origin renders `held (auto)`; its own reconcile never re-fires auto
    await fabric(r, "status", (req) => ({ ok: true, alias: { state: "held", alias: AUTO_ALIAS, origin: "auto" } }));
    expect(r.notifies.some((n) => n.text.includes(`alias @${AUTO_ALIAS} held (auto)`))).toBe(true);
    expect(autoFrames(r)).toHaveLength(1);
  }, 30_000);

  it("a `taken` refusal records `auto skip:taken` for /fabric status and is not retried", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachNone(r);
    r.answer(autoFrames(r)[0]!, { ok: false, code: "E_XS_ALIAS_TAKEN{taken}" });
    await settle(6_000); // well past any BUSY retry window
    expect(autoFrames(r)).toHaveLength(1);
    await fabric(r, "status", hubNone);
    expect(r.notifies.some((n) => n.text.includes("alias - · auto skip:taken"))).toBe(true);
    expect(autoFrames(r)).toHaveLength(1);
  }, 30_000);

  it("/fabric join re-arms exactly one new auto attempt (N1)", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachNone(r);
    r.answer(autoFrames(r)[0]!, { ok: false, code: "E_XS_ALIAS_TAKEN{taken}" });
    await settle();
    await fabric(r, "leave", hubNone); // leave bumps the epoch; leave itself triggers no auto (not joined)
    expect(autoFrames(r)).toHaveLength(1);
    await fabric(r, "join", hubNone); // join ⇒ refreshAlias ⇒ get(none) ⇒ a fresh attempt key
    expect(autoFrames(r)).toHaveLength(2);
    expect(autoFrames(r)[1]).toMatchObject({ alias: AUTO_ALIAS });
  }, 30_000);

  it.each([
    ["set", "alias 后端", "set"],
    ["clear", "alias --clear", "clear"],
  ])(
    "a human `/fabric alias` %s writes the decided marker BEFORE its request and ends auto for good",
    async (_name, command, via) => {
      const r = await boot({ alias: true, hubAlias: true, hubV2: true });
      await attachNone(r);
      r.answer(autoFrames(r)[0]!, { ok: false, code: "E_XS_ALIAS_TAKEN{taken}" });
      await settle();
      expect(autoFrames(r)).toHaveLength(1);

      const framesBefore = r.frames().length;
      const run = r.commands.get("fabric").handler(command, r.ctx);
      await settle(10);
      // mark first (appendEntry), request second — the marker is already there when the write frame exists
      const marks = r.appended.filter((a) => a.customType === DECIDED_TYPE);
      expect(marks).toHaveLength(1);
      expect(marks[0]!.data).toMatchObject({ v: 1, sessionId: r.sm.getSessionId(), via });
      const write = r
        .frames()
        .slice(framesBefore)
        .find((f) => f.t === "xs_req" && f.op === "alias")!;
      expect(write).toBeDefined();
      expect(write.intent).toBeUndefined();
      r.answer(write, hubEcho(write));
      await settle(10);
      for (const req of r
        .reqs("alias")
        .filter((q) => q !== write && q.intent === undefined)
        .slice(-2))
        r.answer(req, hubNone());
      await run;
      await settle();

      // a new membership epoch (leave + join) would re-arm auto for an undecided session — here it must not
      await fabric(r, "leave", hubNone);
      await fabric(r, "join", hubNone);
      await fabric(r, "status", hubNone);
      expect(autoFrames(r)).toHaveLength(1);
      expect(r.notifies.some((n) => n.text.includes("auto skip:decided"))).toBe(true);
    },
    30_000,
  );

  it("a decided marker already in the session file (getEntries) blocks auto; a foreign-sid marker does not", async () => {
    const decided = await boot({
      alias: true,
      hubAlias: true,
      hubV2: true,
      seed: (sm) => {
        sm.appendCustomEntry(DECIDED_TYPE, { v: 1, sessionId: sm.getSessionId(), at: 5, via: "set" });
      },
    });
    await attachNone(decided);
    expect(autoFrames(decided)).toHaveLength(0);
    await fabric(decided, "status", hubNone);
    expect(decided.notifies.some((n) => n.text.includes("auto skip:decided"))).toBe(true);
    for (const f of cleanup.splice(0).reverse()) f();

    const foreign = await boot({
      alias: true,
      hubAlias: true,
      hubV2: true,
      seed: (sm) => {
        sm.appendCustomEntry(DECIDED_TYPE, { v: 1, sessionId: "some-other-session", at: 5, via: "set" });
      },
    });
    await attachNone(foreign);
    expect(autoFrames(foreign)).toHaveLength(1);
  }, 30_000);

  it("autoFromCwd=false ⇒ zero auto frames even on a v2 hub, and /fabric status keeps the pre-auto shape", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true, autoFromCwd: false });
    await attachNone(r);
    await settle(6_000);
    expect(intentFrames(r)).toHaveLength(0);
    await fabric(r, "leave", hubNone);
    await fabric(r, "join", hubNone);
    await fabric(r, "status", hubNone);
    expect(intentFrames(r)).toHaveLength(0);
    expect(r.notifies.some((n) => n.text.includes("auto skip"))).toBe(false);
    expect(r.notifies.some((n) => /\balias -(\n|$)/.test(n.text))).toBe(true);
    // a human write is still allowed and still carries no intent
    await fabric(r, "alias 后端", hubEcho);
    expect(intentFrames(r)).toHaveLength(0);
  }, 30_000);

  it("v1 hub (alias cap, no xs.alias.v2): zero intent frames anywhere, status shows no auto suffix, --force refused locally", async () => {
    const r = await boot({ alias: true, hubAlias: true });
    await attachNone(r);
    await settle(6_000);
    await fabric(r, "leave", hubNone);
    await fabric(r, "join", hubNone);
    await fabric(r, "status", hubNone);
    await fabric(r, "alias 后端", hubEcho);
    await fabric(r, "alias 后端 --force", hubNone);
    expect(intentFrames(r)).toHaveLength(0);
    expect(r.frames().some((f) => f.take === "preview")).toBe(false); // no force preview frame was ever sent
    expect(r.notifies.some((n) => n.text.includes("auto skip"))).toBe(false);
    expect(r.notifies.some((n) => n.text === "hub 不支持强制抢占，需 /webhub restart")).toBe(true);
  }, 30_000);

  it("v2 hub: /fabric alias <名> --force previews with intent:force (v2 port live: hubAliasV2, forcePreview)", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true, autoFromCwd: false });
    await attachNone(r);
    const run = r.commands.get("fabric").handler("alias 后端 --force", r.ctx);
    await settle(10);
    const preview = r.reqs("alias").find((f) => f.intent === "force")!;
    expect(preview).toMatchObject({ alias: "后端", take: "preview", intent: "force" });
    r.answer(preview, {
      ok: true,
      alias: {
        take: {
          cwdLabel: "~/ai/foo",
          offlineForS: 0,
          online: true,
          auto: true,
          token: "k0123456789abcdef",
          expiresAt: FIXED_NOW + 300_000,
        },
      },
    });
    await settle(10);
    await run; // TUI path: ctx.ui.confirm answers false ⇒ cancelled, nothing executed
    expect(r.notifies.some((n) => n.text === "已取消抢占。")).toBe(true);
    expect(r.reqs("alias").some((f) => f.take === "k0123456789abcdef")).toBe(false);
    // cancelled ⇒ not a decision (D6: previews/cancels never mark)
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE)).toHaveLength(0);
  }, 30_000);

  it("alias off: no auto, and a (refused) `/fabric alias` writes no decided marker", async () => {
    const r = await boot({ alias: false, hubAlias: true, hubV2: true });
    await settle(100);
    expect(r.reqs("alias")).toHaveLength(0);
    await fabric(r, "alias 后端", hubEcho);
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE)).toHaveLength(0);
  }, 30_000);

  it("child session: inert — no hub link, no alias frames, no xs tools or command", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true, child: true });
    expect(r.net.sockets).toHaveLength(0);
    expect(r.commands.has("fabric")).toBe(false);
    expect(r.tools.has("list_sessions")).toBe(false);
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE)).toHaveLength(0);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// #72 AF7: `/new` hands the alias to the new session id — REAL activate() × REAL stack × fake hub socket.

const HANDOFF_ERR_STALE = "E_XS_ALIAS_TAKE{stale}";
const handoffFrames = (r: Booted): Frame[] => intentFrames(r).filter((f) => f.intent === "handoff");

/** The old session holds `alias` (what the attach `get` answered). */
async function attachHeld(r: Booted, alias = AUTO_ALIAS, origin?: "auto"): Promise<void> {
  r.answer(r.reqs("alias")[0]!, { ok: true, alias: { state: "held", alias, ...(origin ? { origin } : {}) } });
  await settle();
}

/** pi's session replacement: shutdown(reason) on the old stack, then a fresh sessionId's session_start(reason). */
async function replaceSession(r: Booted, reason: "new" | "fork" | "resume" = "new"): Promise<string> {
  for (const h of r.handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown", reason }, r.ctx);
  const sm2 = SessionManager.create("/tmp/wa", r.sessionDir);
  sm2.appendMessage({ role: "user", content: "fresh", timestamp: FIXED_NOW });
  r.ctx.sessionManager = sm2;
  for (const h of r.handlers.get("session_start") ?? []) await h({ type: "session_start", reason }, r.ctx);
  await settle(50);
  return sm2.getSessionId();
}
/** The newest reconcile `get` (no alias field) still unanswered. */
const lastGet = (r: Booted): Frame =>
  r
    .reqs("alias")
    .filter((f) => f.alias === undefined && f.clear === undefined)
    .at(-1)!;

describe("#72 AF7: /new alias handoff wiring", () => {
  it("/new: the new sid's first empty get is followed by ONE handoff{alias, prevSessionId=old sid} BEFORE any auto; ok ⇒ no auto, status shows the alias", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    const oldSid = r.sm.getSessionId();
    await attachHeld(r, "front-door");
    const newSid = await replaceSession(r, "new");
    expect(newSid).not.toBe(oldSid);
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    const h = handoffFrames(r);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ op: "alias", alias: "front-door", intent: "handoff", prevSessionId: oldSid });
    expect(h[0]!.origin.sessionId).toBe(newSid);
    expect(autoFrames(r)).toHaveLength(0); // the auto path waits for the handoff outcome
    r.answer(h[0]!, { ok: true, alias: { state: "held", alias: "front-door", origin: "auto" } });
    await settle(6_000);
    expect(autoFrames(r)).toHaveLength(0);
    expect(handoffFrames(r)).toHaveLength(1); // one attempt per /new
    const status = [...r.frames()].reverse().find((f) => f.t === "status")!;
    expect(status.xs.alias).toBe("front-door");
    expect(r.notifies.some((n) => n.text.includes("自动设置别名"))).toBe(false); // handoff is silent
  }, 30_000);

  it("handoff refused (stale: hub restarted / name taken) ⇒ falls back to the auto path exactly once, with no handoff retry", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachHeld(r, "front-door");
    await replaceSession(r, "new");
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    r.answer(handoffFrames(r)[0]!, { ok: false, code: HANDOFF_ERR_STALE });
    await settle();
    expect(autoFrames(r)).toHaveLength(1);
    expect(autoFrames(r)[0]).toMatchObject({ alias: AUTO_ALIAS });
    expect(handoffFrames(r)).toHaveLength(1);
    await settle(6_000);
    expect(handoffFrames(r)).toHaveLength(1);
  }, 30_000);

  it("old hub that answers BAD_FRAME to handoff (before AF7 lands) is treated like any failure ⇒ auto", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachHeld(r, "front-door");
    await replaceSession(r, "new");
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    r.answer(handoffFrames(r)[0]!, { ok: false, code: "E_XS_BAD_FRAME" });
    await settle();
    expect(autoFrames(r)).toHaveLength(1);
  }, 30_000);

  it("fork: no handoff (the parent keeps the name) and nothing is inherited — not even a decided mark", async () => {
    const r = await boot({
      alias: true,
      hubAlias: true,
      hubV2: true,
      seed: (sm) => {
        sm.appendCustomEntry(DECIDED_TYPE, { v: 1, sessionId: sm.getSessionId(), at: 5, via: "set" });
      },
    });
    await attachHeld(r, "front-door");
    await replaceSession(r, "fork");
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle(6_000);
    expect(handoffFrames(r)).toHaveLength(0);
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE)).toHaveLength(0);
  }, 30_000);

  it("resume: no handoff either; and a stash left by a /new that never started a session is not adopted by a later fork", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachHeld(r, "front-door");
    await replaceSession(r, "resume");
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    expect(handoffFrames(r)).toHaveLength(0);
    // a stray stash (shutdown{new} whose session_start never came) is consumed — and dropped — by the next start
    const g = globalThis as Record<symbol, unknown>;
    g[Symbol.for("pi-subagent:xs-alias-handoff")] = {
      fromSessionId: "stray-sid",
      alias: "stray",
      decided: false,
      at: Date.now(),
    };
    await replaceSession(r, "fork");
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    expect(handoffFrames(r)).toHaveLength(0);
    expect(g[Symbol.for("pi-subagent:xs-alias-handoff")]).toBeUndefined();
  }, 30_000);

  it("decided inherits: the new sid gets a via:inherit marker (own sid) and, even after a refused handoff, no auto", async () => {
    const r = await boot({
      alias: true,
      hubAlias: true,
      hubV2: true,
      seed: (sm) => {
        sm.appendCustomEntry(DECIDED_TYPE, { v: 1, sessionId: sm.getSessionId(), at: 5, via: "set" });
      },
    });
    await attachHeld(r, "front-door");
    const newSid = await replaceSession(r, "new");
    const marks = r.appended.filter((a) => a.customType === DECIDED_TYPE);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.data).toMatchObject({ v: 1, sessionId: newSid, via: "inherit" });
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    r.answer(handoffFrames(r)[0]!, { ok: false, code: HANDOFF_ERR_STALE });
    await settle(6_000);
    expect(autoFrames(r)).toHaveLength(0);
  }, 30_000);

  it("a non-decided old session writes NO marker for the new one (inheritance is only of a human decision)", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachHeld(r, "front-door", "auto");
    await replaceSession(r, "new");
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE)).toHaveLength(0);
  }, 30_000);

  it("decided old session WITHOUT an alias (human --clear): marker inherited, nothing to hand off, no auto", async () => {
    const r = await boot({
      alias: true,
      hubAlias: true,
      hubV2: true,
      seed: (sm) => {
        sm.appendCustomEntry(DECIDED_TYPE, { v: 1, sessionId: sm.getSessionId(), at: 5, via: "clear" });
      },
    });
    await attachNone(r);
    const newSid = await replaceSession(r, "new");
    expect(r.appended.filter((a) => a.customType === DECIDED_TYPE).map((a) => a.data)).toEqual([
      expect.objectContaining({ sessionId: newSid, via: "inherit" }),
    ]);
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle(6_000);
    expect(intentFrames(r)).toHaveLength(0);
  }, 30_000);

  it("autoFromCwd=false: the handoff still goes out (a continuation, not an auto-claim)", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true, autoFromCwd: false });
    await attachHeld(r, "front-door");
    const oldSid = r.sm.getSessionId();
    await replaceSession(r, "new");
    r.answer(lastGet(r), { ok: true, alias: { state: "none" } });
    await settle();
    expect(handoffFrames(r)).toHaveLength(1);
    expect(handoffFrames(r)[0]).toMatchObject({ prevSessionId: oldSid });
    r.answer(handoffFrames(r)[0]!, { ok: false, code: HANDOFF_ERR_STALE });
    await settle(6_000);
    expect(autoFrames(r)).toHaveLength(0);
  }, 30_000);

  it("v1 hub: zero intent frames of any kind; alias off: nothing stashed and nothing sent", async () => {
    const v1 = await boot({ alias: true, hubAlias: true });
    await attachHeld(v1, "front-door");
    await replaceSession(v1, "new");
    v1.answer(lastGet(v1), { ok: true, alias: { state: "none" } });
    await settle(6_000);
    expect(intentFrames(v1)).toHaveLength(0);
    for (const f of cleanup.splice(0).reverse()) f();

    const off = await boot({ alias: false, hubAlias: true, hubV2: true });
    await replaceSession(off, "new");
    await settle(6_000);
    expect(off.reqs("alias")).toHaveLength(0);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-alias-handoff")]).toBeUndefined();
  }, 30_000);

  it("a human decision on the NEW session before the hub answers wins: the pending handoff is dropped, nothing is restored", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachHeld(r, "front-door");
    await replaceSession(r, "new");
    const pendingGet = lastGet(r);
    await fabric(r, "alias --clear", hubNone); // human: no alias for this session, please
    r.answer(pendingGet, { ok: true, alias: { state: "none" } });
    await settle(6_000);
    expect(handoffFrames(r)).toHaveLength(0);
    expect(autoFrames(r)).toHaveLength(0); // decided ⇒ no auto either
  }, 30_000);

  it("hub unreachable for longer than the handoff window: the stale intent is NOT sent later; the ordinary auto path decides", async () => {
    const r = await boot({ alias: true, hubAlias: true, hubV2: true });
    await attachHeld(r, "front-door");
    await replaceSession(r, "new");
    vi.setSystemTime(Date.now() + 125_000);
    // the new session's first get never got answered; by the time the link is next reconciled the hub's succession edge
    // (120 s) is long gone — only the wall clock moves here, the link itself stays up
    await fabric(r, "status", hubNone);
    expect(handoffFrames(r)).toHaveLength(0);
    expect(autoFrames(r)).toHaveLength(1);
  }, 30_000);
});
