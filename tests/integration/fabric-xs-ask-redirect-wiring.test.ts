import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadSettingsFromFile } from "../../src/config/settings.js";
import { getXsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { P2_HUB_CAPS, VERSION_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import { XS_HUB_CAP, XS_REPLY_HUB_CAP } from "../../src/web-hub/protocol/xs.js";
import { ackFrame, fakeNet, pathsIn, resetGlobals, SETTINGS } from "../web-hub/agent/helpers.js";
import { makeFakeVault, freezeDomain } from "../secure/helpers.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * #21 B3 wiring gate (plan `docs/dev/xs-ask-redirect/plan.md` §2 包 B3, §3 T2): the assembly
 * anchor for the ONE `src/index.ts` wiring line — a REAL `activate()` × REAL stack × REAL
 * web-hub bridge against a FAKE hub socket (same harness family as `fabric-xs-alias-wiring`).
 * Pins exactly three things:
 *  - default on (`fabric.crossSession.askRedirect.enabled` default true, xs ∧ reply ∧ wake on):
 *    the option IS passed — a real delegated turn (wake + reply dispatch through the real
 *    controller, BAS-bound) makes ask_user consult the redirect port, send the q2 through the
 *    real socket, and return the U-class text WITHOUT ever opening the local dialog;
 *  - leaf off: the option is NOT passed — the SAME delegated turn opens the LOCAL rpc dialog,
 *    no q2 ever hits the socket, and the wake-ledger record carries NO `askOrigin` (the tap is
 *    the only writer and it is gone — I9: off leaves no trace);
 *  - D8/secure: a frozen secure-domain verdict forces `crossSession.enabled=false` through the
 *    REAL settings loader inside activate ⇒ `xsOn` false ⇒ no xs surface at all (no
 *    message_session tool, no member frames) and ask_user keeps its exact pre-#21 local path.
 *
 * Simulation boundary: the pi host is a fake (events fired by hand); the hub is a fake socket
 * answering resolve/send by hand. The full model-driven loop over a REAL AgentSession is T11
 * (`fabric-xs-ask-redirect-session.test.ts`); the real hub subprocess is T12
 * (`fabric-xs-ask-redirect.test.ts`).
 */

const FIXED_NOW = 1_769_000_000_000;
const PEER_SID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const Q1 = "q00000000000000000a";
const ASK = { questions: [{ question: "Redirect wiring gate?", options: [{ label: "Alpha" }, { label: "Beta" }] }] };

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
    "pi-subagent:xs-progress",
    "pi-subagent:xs-activation-park",
    "pi-subagent:xs-membership-handoff",
  ])
    delete g[Symbol.for(key)];
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
  pin.current = undefined;
  vi.useRealTimers();
  resetSecureDomainForTests();
});

type Frame = Record<string, any>;

/** The shared fake-pi host: records tools/commands/events/writes, fires handlers on demand. */
function activateHost(home: string) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: Array<{ message: Record<string, any>; options?: unknown }> = [];
  const pi = {
    on(event: string, fn: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => undefined;
    },
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, c: any) => commands.set(name, c),
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendMessage: (message: any, options?: unknown) => sent.push({ message, ...(options ? { options } : {}) }),
    sendUserMessage() {},
    appendEntry: () => undefined,
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    getCommands: () => [],
    getSessionName: () => undefined,
    events: { on: () => () => undefined, emit() {} },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;
  const sessionDir = join(home, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sm = SessionManager.create("/tmp/wa", sessionDir);
  sm.appendMessage({ role: "user", content: "fixture", timestamp: FIXED_NOW });
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/wa",
    sessionManager: sm,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => undefined,
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { setStatus() {}, notify() {}, setWidget() {}, setEditorComponent() {}, getEditorComponent: () => undefined },
  };
  const emit = async (event: string, payload: unknown = {}): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { pi, ctx, sm, emit, tools, commands, sent };
}

/** The ask_user call context: rpc mode with a recording/answering select (the local dialog). */
function rpcAskCtx() {
  const selects: string[] = [];
  const ctx = {
    mode: "rpc" as const,
    hasUI: true,
    sessionManager: undefined,
    ui: {
      select: (_title: string, options: string[]) => {
        selects.push(options[0]!);
        // answer the first question with its first option, through the real RPC answer protocol
        const payload = JSON.parse(options[0]!) as { questions: Array<{ header?: string; question: string }> };
        const first = payload.questions[0]!;
        return Promise.resolve(JSON.stringify({ [first.header ?? first.question]: "Alpha" }));
      },
    },
  };
  return { ctx, selects };
}

const baseSettings = (leafOff: boolean) => ({
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
      ...(leafOff ? { askRedirect: { enabled: false } } : {}),
    },
  },
});

interface Booted {
  socket: ReturnType<typeof import("../web-hub/agent/helpers.js").fakeNet>["sockets"][number];
  frames(): Frame[];
  reqs(op: string): Frame[];
  host: ReturnType<typeof activateHost>;
  deliverWake(): void;
  bind(): void;
  askUser(): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, any> }>;
  selects: string[];
}

async function boot(leafOff: boolean): Promise<Booted> {
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
  writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify(baseSettings(leafOff)));

  const net = fakeNet();
  const nodeLoader = join(home.home, "jiti.mjs");
  writeFileSync(nodeLoader, "");
  pin.current = (deps) => ({
    ...deps,
    settings: { ...SETTINGS, autoStart: true, nodeLoader },
    env: { HOME: home.home },
    paths: { ...pathsIn(home.home), stoppedFile: join(home.home, "stopped") },
    buildInfo: async () => ({ pluginVersion: "0.0.0-b3w", buildId: "b3w-build" }),
    argv1: "/nonexistent/pi",
    netConnect: net.netConnect,
    spawnImpl: (() => ({ on: () => undefined, unref: () => undefined })) as never,
    now: () => FIXED_NOW,
  });

  const host = activateHost(home.home);
  activate(host.pi);
  await host.emit("session_start", { type: "session_start", reason: "startup" });
  await vi.advanceTimersByTimeAsync(50);

  net.sockets[0]!.emit("error", Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
  for (let i = 0; i < 40 && net.sockets.length < 2; i++) await vi.advanceTimersByTimeAsync(100);
  const socket = net.sockets[1]!;
  socket.emit("connect");
  socket.hub(ackFrame("b3w-key", 4242, [...P2_HUB_CAPS, VERSION_HUB_CAP, XS_HUB_CAP, XS_REPLY_HUB_CAP]));
  await vi.advanceTimersByTimeAsync(50);

  const frames = (): Frame[] => socket.frames() as Frame[];
  const reqs = (op: string): Frame[] => frames().filter((f) => f.t === "xs_req" && f.op === op);
  const answer = (req: Frame, body: Frame) => socket.hub({ t: "xs_res", rid: String(req.rid), ...body } as never);

  /** Deliver the delegated wake frame (q1 expectReply) from the peer through the live socket. */
  const deliverWake = (): void => {
    const member = [...frames()].reverse().find((f) => f.t === "xs_member")!;
    socket.hub({
      t: "xs_deliver",
      rid: `d${Math.random().toString(16).slice(2, 10)}`,
      xid: "xb3w00000000000001",
      to: { sessionId: member.sessionId, epoch: member.epoch },
      from: { sessionId: PEER_SID, ref: PEER_SID.slice(0, 12), cwdLabel: "~/peer", agentId: "peer-agent" },
      text: "please do the delegated thing",
      wake: true,
      reply: { requestId: Q1, dueAt: FIXED_NOW + 600_000 },
      expiresAt: FIXED_NOW + 60_000,
    } as never);
  };

  /** Fire BAS for the recorded wake trigger: the controller binds the token (D3's askOrigin is live). */
  const bind = (): void => {
    const trigger = host.sent.map((s) => s.message).find((m) => m.customType === "subagent:xs" && m.details?.xsWake);
    expect(trigger).toBeDefined();
    host.emit("before_agent_start", { messageType: "custom", message: trigger }).then(
      () => undefined,
      () => undefined,
    );
  };

  const { ctx: askCtx, selects } = rpcAskCtx();
  const askUser = async () => {
    const tool = host.tools.get("ask_user")!;
    const pending = tool.execute("tc-b3w", ASK, undefined, undefined, askCtx) as Promise<any>;
    // pump the fake clock while answering whatever ops the redirect issues
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(20);
      const resolve = reqs("resolve").find((r) => !r.__answered);
      if (resolve !== undefined) {
        (resolve as any).__answered = true;
        answer(resolve, { ok: true, target: { ref: PEER_SID.slice(0, 12), sessionId: PEER_SID } });
      }
      const send = reqs("send").find((r) => !r.__answered);
      if (send !== undefined) {
        (send as any).__answered = true;
        answer(send, { ok: true, effect: "none", reason: "rejected" });
      }
      if (typeof (pending as any).isFulfilled !== "function") {
        // eslint-disable-next-line no-await-in-loop -- poll until the tool settles
        const settled = await Promise.race([
          pending.then(
            () => true,
            () => true,
          ),
          Promise.resolve(false),
        ]);
        if (settled) break;
      }
    }
    return pending;
  };

  return { socket, frames, reqs, host, deliverWake, bind, askUser, selects };
}

describe("#21 B3 wiring: real activate() × fake hub socket", () => {
  it("default on: a delegated turn redirects ask_user — q2 on the wire, U-class text back, NO local dialog", async () => {
    const r = await boot(false);
    r.deliverWake();
    await vi.advanceTimersByTimeAsync(50);
    r.bind();
    await vi.advanceTimersByTimeAsync(10);
    // the delegated dispatch captured the origin on the REAL process-level wake ledger (D3)
    const token = r.host.sent.map((s) => s.message).find((m) => m.details?.wakeToken)?.details.wakeToken;
    expect(getXsWakeLedger().get(token)?.askOrigin).toEqual({
      requesterSessionId: PEER_SID,
      requestId: Q1,
      dueAt: FIXED_NOW + 600_000,
    });

    const result = await r.askUser();
    // the redirect port was consulted: no local rpc dialog ever opened
    expect(r.selects).toEqual([]);
    expect(result.content[0]!.text).toContain("Do not assume an answer.");
    expect(result.content[0]!.text).toContain("send_none:rejected");
    expect(result.details.cancelled).toBe(true);
    expect(result.details.redirected).toMatchObject({ state: "unavailable", reason: "send_none:rejected" });
    // the q2 went out as a wake + expect send through the real socket (never a plain message_session shape)
    const send = r.reqs("send").find((f) => f.expect !== undefined);
    expect(send).toBeDefined();
    expect(send!.to).toBe(PEER_SID);
    expect(send!.wake).toBe(true);
    expect(typeof send!.expect!.requestId).toBe("string");
    // a provable `none` refunded the admission: the ledger record is back to askUsed 0
    expect(getXsWakeLedger().get(token)?.askUsed).toBe(0);
  }, 30_000);

  it("leaf off: the option is absent — the SAME delegated turn opens the LOCAL dialog, no q2, no askOrigin", async () => {
    const r = await boot(true);
    r.deliverWake();
    await vi.advanceTimersByTimeAsync(50);
    r.bind();
    await vi.advanceTimersByTimeAsync(10);

    const result = await r.askUser();
    expect(r.selects).toHaveLength(1); // the local rpc dialog opened and was answered
    expect(result.details.cancelled).toBe(false);
    expect(result.details.redirected).toBeUndefined();
    expect(result.details.answers?.["Redirect wiring gate?"]).toMatchObject({ selected: ["Alpha"] });
    // no redirect frame ever hit the socket…
    expect(r.reqs("send").filter((f) => f.expect !== undefined)).toEqual([]);
    // …and the off stack left NO origin trace (I9: the tap is the only writer and it is gone)
    const token = r.host.sent.map((s) => s.message).find((m) => m.details?.wakeToken)?.details.wakeToken;
    expect(token).toBeDefined();
    const rec = getXsWakeLedger().get(token);
    expect(rec?.askOrigin).toBeUndefined();
    expect(rec?.askUsed).toBeUndefined();
  }, 30_000);

  it("D8/secure: a frozen secure verdict forces crossSession off — no xs surface, ask_user keeps the local path", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(FIXED_NOW);
    clearXsGlobals();
    resetGlobals();
    const vault = makeFakeVault();
    // merge the vault's own secure section (dir/mnt of its generated layout) with the #21 settings
    const rawSettings = JSON.parse(readFileSync(vault.settingsPath, "utf8")) as { secure: unknown };
    writeFileSync(vault.settingsPath, JSON.stringify({ ...baseSettings(false), secure: rawSettings.secure }));
    cleanup.push(() => {
      vault.cleanup();
      resetGlobals();
      clearXsGlobals();
    });
    const frozen = freezeDomain(vault, { cwd: vault.work });
    expect(frozen.domain.kind).toBe("secure");

    // the REAL loader inside activate applies the D8 override to the same file
    const loaded = loadSettingsFromFile(vault.settingsPath);
    expect(loaded.fabric.crossSession.enabled).toBe(false);
    expect(loaded.fabric.crossSession.askRedirect.enabled).toBe(true); // the leaf itself parses on; xsOn is the gate

    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_RUNTIME_DIR;
    process.env.HOME = vault.home;
    process.env.XDG_RUNTIME_DIR = "";
    const net = fakeNet(); // keep the hub link fake: no real socket I/O even on retry
    pin.current = (deps) => ({
      ...deps,
      settings: { ...SETTINGS, autoStart: false },
      env: { HOME: vault.home },
      paths: { ...pathsIn(vault.home), stoppedFile: join(vault.home, "stopped") },
      buildInfo: async () => ({ pluginVersion: "0.0.0-b3w", buildId: "b3w-build" }),
      argv1: "/nonexistent/pi",
      netConnect: net.netConnect,
      now: () => FIXED_NOW,
    });
    try {
      const host = activateHost(vault.home);
      activate(host.pi);
      await host.emit("session_start", { type: "session_start", reason: "startup" });
      await vi.advanceTimersByTimeAsync(50);
      // secure ⇒ xsOn false ⇒ no cross-session surface at all
      expect(host.tools.has("ask_user")).toBe(true);
      expect(host.tools.has("message_session")).toBe(false);
      expect(net.sockets.every((s) => s.frames().every((f) => f.t !== "xs_member"))).toBe(true);
      // and ask_user is exactly the pre-#21 local path: the dialog opens and resolves
      const { ctx: askCtx, selects } = rpcAskCtx();
      const tool = host.tools.get("ask_user")!;
      const pending = tool.execute("tc-b3w-sec", ASK, undefined, undefined, askCtx) as Promise<any>;
      await vi.advanceTimersByTimeAsync(50);
      const result = await pending;
      expect(selects).toHaveLength(1);
      expect(result.details.cancelled).toBe(false);
      expect(result.details.redirected).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = prevXdg;
    }
  }, 30_000);
});
