// web-hub P2 control-plane integration tests (#32 C7, control-plan.md v2.1 §9.2 scenarios 1-13
// + the C4-remnant concurrent-different-cmdId assertion). Framework: real unix socket
// (`startHub` + `createHttpFrontend`) + real `activate()` (src/index.ts) driven by a fake pi/ctx,
// plus real `http.request`/SSE "browser" clients — same shape as `web-hub-e2e.test.ts`, extended
// with the P2 write surface (`/api/cmd`, `/api/dialog`) and the agent-side command/ask_user/
// admin machinery those requests exercise end to end.
//
// Scoping notes (read before extending): every scenario below drives the REAL socket + REAL HTTP
// stack; a few of the heavier admin/version-replacement scenarios (rotate-intent recovery,
// forced supersede) are deliberately narrowed to the parts that need a real hub+agent pair —
// the exhaustive crash-injection / state-machine edge cases for those subsystems already have
// dedicated, fast unit coverage (`tests/web-hub/hub/admin-rotate.test.ts`,
// `tests/web-hub/hub/supersede.test.ts`, `tests/web-hub/protocol/rotate-intent.test.ts`) that this
// file does not duplicate. The steer_subagent-based "concurrent unknown cmdIds" group uses
// `wireWebHub` directly (still a real socket + real HTTP hub) instead of full `activate()`,
// because a fake `QueryControlPort` cannot be injected through the top-level assembly (it is
// hard-wired to the real per-session `SpawnService`).

import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { currentConnection } from "../../src/web-hub/agent/connection.js";
import { wireWebHub, type WebHubDeps, type QueryControlPort } from "../../src/web-hub/agent/index.js";
import { createAdminCommands } from "../../src/web-hub/agent/admin-cmds.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import type { FrontendDeps, FrontendFactory, HubEvent } from "../../src/web-hub/hub/ports.js";
import type { HubConfig, HubLanConfig } from "../../src/web-hub/hub/ports.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { readRotateIntentSync } from "../../src/web-hub/protocol/rotate-intent.js";
import { AGENT_ID_KEY, resetGlobals, waitUntil } from "../web-hub/agent/helpers.js";
import {
  config as hubConfig,
  connectClient,
  hello,
  waitFor as socketWaitFor,
  type TestClient,
} from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, rawRequest, JSON_HEADERS, type SseConn } from "../web-hub/http/helpers.js";
import { lanPostJson } from "../web-hub/http/lan-helpers.js";
import { mockTui, stubTheme } from "../ask-user/fixtures.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const NO_NODE_SQLITE = !(await hasNodeSqlite());
if (NO_NODE_SQLITE) {
  // eslint-disable-next-line no-console
  console.warn("[web-hub-control.test.ts] this Node build has no node:sqlite ⇒ skipping the LAN-dependent scenarios.");
}

// ---------------------------------------------------------------------------
// fake pi (superset of web-hub-e2e.test.ts's own: registerTool/registerCommand
// actually record definitions, sendUserMessage simulates pi-core's synchronous
// extension-command dispatch, a few extra ExtensionAPI methods the builtin
// bridge calls directly).
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;
type RawCommand = { handler: (args: string, ctx: unknown) => unknown };

interface SentMessage {
  text: string;
  opts: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean };
}

function parseSlash(text: string): { name: string; args: string } | undefined {
  const m = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1]!, args: m[2] ?? "" } : undefined;
}

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  fire: (event: string, payload: unknown, ctx: unknown) => Promise<void>;
  commands: Map<string, RawCommand>;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
  sent: SentMessage[];
  setSessionNameCalls: string[];
  setThinkingLevelCalls: string[];
  setModelCalls: Array<{ provider: string; id: string }>;
  setModelResult: { accepted: boolean | Error };
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, RawCommand>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const sent: SentMessage[] = [];
  const setSessionNameCalls: string[] = [];
  const setThinkingLevelCalls: string[] = [];
  const setModelCalls: Array<{ provider: string; id: string }> = [];
  const setModelResult: { accepted: boolean | Error } = { accepted: true };

  const pi = {
    registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, command: RawCommand) {
      commands.set(name, command);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    getCommands() {
      return [...commands.keys()].map((name) => ({ name, source: "extension" as const }));
    },
    getAllTools() {
      return [...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((h) => h !== handler),
        );
      };
    },
    sendMessage() {},
    sendUserMessage(text: string, opts: SentMessage["opts"] = {}) {
      sent.push({ text, opts });
      if (opts.expandPromptTemplates === true) {
        const parsed = parseSlash(text);
        if (parsed !== undefined) {
          const cmd = commands.get(parsed.name);
          if (cmd !== undefined) {
            // Mirrors pi-core's `_tryExecuteExtensionCommand` (agent-session.js:1336-1350): the
            // handler runs synchronously, in the same call stack as `sendUserMessage`, and any
            // throw is swallowed (pi routes it to `emitError`, never back to the caller).
            try {
              void cmd.handler(parsed.args, currentCtxRef.current);
            } catch {
              /* matches pi's emitError swallow */
            }
          }
        }
      }
    },
    appendEntry() {},
    setSessionName(value: string) {
      setSessionNameCalls.push(value);
    },
    setThinkingLevel(value: string) {
      setThinkingLevelCalls.push(value);
    },
    setModel(model: { provider: string; id: string }) {
      setModelCalls.push(model);
      return setModelResult.accepted instanceof Error
        ? Promise.reject(setModelResult.accepted)
        : Promise.resolve(setModelResult.accepted);
    },
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  const fire = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    fire,
    commands,
    tools,
    sent,
    setSessionNameCalls,
    setThinkingLevelCalls,
    setModelCalls,
    setModelResult,
  };
}

/** `sendUserMessage`'s synchronous command re-entry needs to reach the CURRENT ctx (which is
 * rebuilt on every `/new`-like transition in real pi) without threading it through every call
 * site — a single test-local ref, reassigned by `setup()`/tests, mirrors the module-scope `ctx`
 * variable `agent/index.ts` itself closes over. */
const currentCtxRef: { current: unknown } = {};

interface CtxState {
  leaf: string | null;
  idle: boolean;
  pending: boolean;
  abortCalls: number;
  notifyCalls: Array<[string, string | undefined]>;
  compactCalls: Array<{ customInstructions?: string; onComplete?: () => void; onError?: (e: Error) => void }>;
  uiCustom?: (factory: unknown) => Promise<unknown>;
}

function makeCtx(cwd: string, sessionFile: string, state: CtxState): ExtensionContext {
  const ctx = {
    mode: "tui" as const,
    hasUI: true,
    cwd,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    abort: () => {
      state.abortCalls += 1;
    },
    compact: (opts: { customInstructions?: string; onComplete?: () => void; onError?: (e: Error) => void }) => {
      state.compactCalls.push(opts);
      if (opts.onComplete !== undefined) {
        const t = setTimeout(() => opts.onComplete?.(), 10);
        t.unref?.();
      }
    },
    model: { provider: "test", id: "m" },
    thinkingLevel: "low",
    getContextUsage: () => ({ tokens: 10, contextWindow: 200_000, percent: 0.1 }),
    modelRegistry: {
      getAvailable: () => [],
      find: (provider: string, id: string) => (provider === "p2" && id === "m2" ? { provider, id } : undefined),
    },
    ui: {
      notify: (message: string, type?: string) => {
        state.notifyCalls.push([message, type]);
      },
      setStatus: () => undefined,
      input: () => Promise.resolve(undefined),
      custom: (factory: unknown) =>
        state.uiCustom !== undefined ? state.uiCustom(factory) : Promise.reject(new Error("ui.custom not mocked")),
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => state.leaf,
      getSessionFile: () => sessionFile,
      getSessionId: () => "ctl-session",
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;
  return ctx;
}

const BASE_SETTINGS = {
  reload: { defer: false },
  webHub: {
    enabled: true,
    autoStart: false,
    port: 0,
    idleExitMinutes: 10,
    control: true,
    remoteAskUser: true,
    webCommands: true,
  },
  hud: { enabled: false },
  sessionNav: { enabled: false },
  feishuNotify: { enabled: false },
  memory: { enabled: false },
  webSearch: { enabled: false },
  todo: { enabled: false },
  askUser: { enabled: true },
  quota: { enabled: false },
  goal: { enabled: false },
  cacheTtl: { mode: "off" },
  fleetWidget: false,
};

interface Env {
  home: string;
  cwd: string;
  sessionFile: string;
  hub: RunningHub;
  feDeps: FrontendDeps;
  busEvents: HubEvent[];
  agentKey: string;
  ctxState: CtxState;
  pi: ReturnType<typeof fakePi>;
  ctx: ExtensionContext;
  cookie: string;
  sse: SseConn[];
  restoreHome: () => void;
}

async function setup(opts: { lan?: HubLanConfig } = {}): Promise<Env> {
  const home = sandboxHome();
  const settingsPath = join(home.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(BASE_SETTINGS) + "\n", "utf8");
  const cwd = mkdtempSync(join(tmpdir(), "wh-ctl-cwd-"));
  const sessionFile = join(cwd, "session.jsonl");
  const ts = "2026-09-27T00:00:00.000Z";
  writeFileSync(
    sessionFile,
    [JSON.stringify({ type: "session", version: 3, id: "sess-ctl", timestamp: ts, cwd })].join("\n") + "\n",
    "utf8",
  );

  let feDeps: FrontendDeps | undefined;
  const frontend: FrontendFactory = (d) => {
    feDeps = d;
    return createHttpFrontend(d);
  };
  const cfg: HubConfig =
    opts.lan !== undefined
      ? hubConfig({ home: home.home, port: 0, lan: opts.lan })
      : hubConfig({ home: home.home, port: 0 });
  const started = await startHub(cfg, frontend, { uid: process.getuid?.() ?? 0 });
  if ("exists" in started) throw new Error("unexpected hub singleton collision");
  const hub = started;
  const busEvents: HubEvent[] = [];
  feDeps!.bus.subscribe((ev) => busEvents.push(ev));

  const pi = fakePi();
  activate(pi.pi);
  const ctxState: CtxState = {
    leaf: null,
    idle: true,
    pending: false,
    abortCalls: 0,
    notifyCalls: [],
    compactCalls: [],
  };
  const ctx = makeCtx(cwd, sessionFile, ctxState);
  currentCtxRef.current = ctx;
  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => feDeps!.registry.list().length === 1, 8_000, "agent registered");
  const agentKey = feDeps!.registry.list()[0]!.agentKey;
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);

  return {
    home: home.home,
    cwd,
    sessionFile,
    hub,
    feDeps: feDeps!,
    busEvents,
    agentKey,
    ctxState,
    pi,
    ctx,
    cookie,
    sse: [],
    restoreHome: home.restore,
  };
}

async function teardown(e: Env): Promise<void> {
  try {
    await e.pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, e.ctx);
  } catch {
    /* best effort */
  }
  for (const s of e.sse.splice(0)) s.close();
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  await e.hub.close("test-teardown").catch(() => undefined);
  e.restoreHome();
  rmSync(e.home, { recursive: true, force: true });
  rmSync(e.cwd, { recursive: true, force: true });
}

async function openBrowser(e: Env): Promise<SseConn> {
  const sse = await openSse(e.hub.httpPort, { cookie: e.cookie });
  e.sse.push(sse);
  await sse.waitFor((ev) => ev.event === "hello", 5_000);
  const helloEv = sse.events.find((ev) => ev.event === "hello")!;
  const res = await postJson(
    e.hub.httpPort,
    "/api/subscribe",
    { clientId: helloEv.data.clientId, agentKey: e.agentKey },
    { Cookie: e.cookie },
  );
  expect(res.status).toBe(202);
  return sse;
}

function cmdId(seed: string): string {
  return seed.padEnd(16, "0").slice(0, 32);
}

/** LAN's host allow-list is canonicalized against `HubLanConfig.port` (the CONFIGURED port), not
 * whatever the OS actually hands back for `port:0` — so a LAN scenario needs a pre-reserved real
 * port (same reason `tests/integration/web-hub-lan.test.ts` never uses `port:0` for `lan`). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function cmdHeaders(e: Env, over: Record<string, string> = {}): Record<string, string> {
  return { Cookie: e.cookie, Origin: `http://127.0.0.1:${e.hub.httpPort}`, ...over };
}

/** First non-loopback IPv4 this machine actually has (same rationale as web-hub-lan.test.ts's
 * own helper: the LAN listener's host allow-list is built from real interfaces, so probing over
 * loopback would exercise a different code path). `undefined` in a sandbox with no such
 * interface — callers degrade to a console.warn + early return, never a false pass. */
function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

async function fireInput(
  e: Env,
  ev: { text: string; source: "extension" | "interactive" | "rpc"; streamingBehavior?: "steer" | "followUp" },
): Promise<void> {
  await e.pi.fire("input", ev, e.ctx);
}

async function fireMessageStart(e: Env, text: string): Promise<void> {
  await e.pi.fire(
    "message_start",
    { type: "message_start", message: { role: "user", timestamp: Date.now(), content: text } },
    e.ctx,
  );
}

// ===========================================================================
// scenario 1 — prompt lifecycle (dispatched -> observed / unobserved)
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — prompt lifecycle", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("idle prompt: observed via the input event ⇒ 200 delivery:observed behavior:idle", async () => {
    env = await setup();
    const id = cmdId("p1");
    const p = postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id, op: "prompt", text: "list the current directory", deliver: "steer" },
      cmdHeaders(env),
    );
    // Real pi fires `input{source:"extension"}` synchronously inside `sendUserMessage` on the
    // idle path (agent-session.js:1230) — simulate that same-tick observation.
    await waitUntil(() => env!.pi.sent.length === 1, 3_000, "sendUserMessage called");
    await fireInput(env, { text: "list the current directory", source: "extension" });
    const res = await p;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      data: { op: "prompt", delivery: "observed", behavior: "idle" },
    });
    expect(env.pi.sent).toHaveLength(1);
    expect(env.pi.sent[0]).toMatchObject({
      text: "list the current directory",
      opts: { deliverAs: "steer", expandPromptTemplates: false },
    });
  }, 15_000);

  it("idle prompt: never observed ⇒ 200 delivery:unobserved after the 3s HTTP wait", async () => {
    env = await setup();
    const id = cmdId("p2");
    const t0 = Date.now();
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id, op: "prompt", text: "an unobserved message", deliver: "steer" },
      cmdHeaders(env),
    );
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { op: "prompt", delivery: "unobserved" } });
    expect(elapsed).toBeGreaterThanOrEqual(2_800); // PROMPT_HTTP_WAIT_MS = 3000
    expect(env.pi.sent).toHaveLength(1);
  }, 15_000);

  it("manual-compaction window ⇒ 409 E_BUSY_COMPACTING; auto-compaction reason never trips BUSY", async () => {
    env = await setup();
    await env.pi.fire("session_before_compact", { type: "session_before_compact", reason: "manual" }, env.ctx);
    const busy = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("p3"), op: "prompt", text: "should be rejected", deliver: "steer" },
      cmdHeaders(env),
    );
    expect(busy.status).toBe(409);
    expect(JSON.parse(busy.body)).toMatchObject({ error: "E_BUSY_COMPACTING", retryable: true });
    expect(env.pi.sent).toHaveLength(0);

    await env.pi.fire("session_compact", { type: "session_compact", reason: "manual" }, env.ctx);
    const ok = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("p4"), op: "prompt", text: "should dispatch now", deliver: "steer" },
      cmdHeaders(env),
    );
    expect(ok.status).toBe(200);
    expect(env.pi.sent).toHaveLength(1);

    // An "auto" reason before_compact never enters the BUSY window at all (D13/A2 negative).
    await env.pi.fire("session_before_compact", { type: "session_before_compact", reason: "auto" }, env.ctx);
    const stillOk = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      {
        agentKey: env.agentKey,
        id: cmdId("p5"),
        op: "prompt",
        text: "auto compaction should not block",
        deliver: "steer",
      },
      cmdHeaders(env),
    );
    expect(stillOk.status).toBe(200);
  }, 15_000);
});

// ===========================================================================
// scenario 2 — streaming followUp + queue mirror over SSE
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — queue mirror", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("busy followUp: SSE status.queue carries the cmdId; message_start consumes it", async () => {
    env = await setup();
    env.ctxState.idle = false;
    const sse = await openBrowser(env);
    const id = cmdId("q1");
    const p = postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id, op: "prompt", text: "queued while busy", deliver: "followUp" },
      cmdHeaders(env),
    );
    // Fire the observation WHILE the request is still in flight — real pi's `input` event lands
    // synchronously inside `sendUserMessage`'s own call stack, well before the HTTP response.
    await waitUntil(() => env!.pi.sent.length === 1, 3_000, "sendUserMessage called");
    await fireInput(env, { text: "queued while busy", source: "extension", streamingBehavior: "followUp" });
    // D6/§4.4 row 3: the 1Hz `hasPendingMessages()` sample clears the mirror as "dropped" whenever
    // pi reports no pending messages at all — simulate pi actually having queued it.
    env.ctxState.pending = true;
    const res = await p;
    expect(res.status).toBe(200);

    const statusEv = await sse.waitFor(
      (ev) =>
        ev.event === "status" &&
        Array.isArray(ev.data.status?.queue) &&
        ev.data.status.queue.some((q: { cmdId?: string }) => q.cmdId === id),
      3_000,
    );
    const item = (statusEv.data.status.queue as Array<{ cmdId?: string; deliver?: string }>).find(
      (q) => q.cmdId === id,
    );
    expect(item?.deliver).toBe("followUp");

    await fireMessageStart(env, "queued while busy");
    const cleared = await sse.waitFor(
      (ev) => ev.event === "status" && !(ev.data.status?.queue ?? []).some((q: { cmdId?: string }) => q.cmdId === id),
      6_000,
    );
    expect(cleared.data.status.queue ?? []).toEqual([]);
  }, 20_000);
});

// ===========================================================================
// scenario 3 + §3.5 assertions 2/7 — idempotency (single hub, hub restart, concurrent unknown)
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — idempotency & recovery", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("same id replayed ⇒ dup:true, sendUserMessage called exactly once", async () => {
    env = await setup();
    const id = cmdId("d1");
    const body = { agentKey: env.agentKey, id, op: "prompt", text: "dup me", deliver: "steer" };
    const first = await postJson(env.hub.httpPort, "/api/cmd", body, cmdHeaders(env));
    await fireInput(env, { text: "dup me", source: "extension" });
    expect((await first).status).toBe(200);
    await waitUntil(() => env!.pi.sent.length === 1, 2_000, "first send");

    for (let i = 0; i < 3; i++) {
      const replay = await postJson(env.hub.httpPort, "/api/cmd", body, cmdHeaders(env));
      expect(replay.status).toBe(200);
      expect(JSON.parse(replay.body)).toMatchObject({ ok: true, dup: true });
    }
    expect(env.pi.sent).toHaveLength(1);
  }, 15_000);

  it("hub restart: the agent's process-level ledger still dedupes the retried id against the NEW hub", async () => {
    env = await setup();
    const id = cmdId("d2");
    const body = { agentKey: env.agentKey, id, op: "prompt", text: "survive a hub restart", deliver: "steer" };
    const first = await postJson(env.hub.httpPort, "/api/cmd", body, cmdHeaders(env));
    await fireInput(env, { text: "survive a hub restart", source: "extension" });
    expect((await first).status).toBe(200);
    await waitUntil(() => env!.pi.sent.length === 1, 2_000, "first send");

    // §3.5 assertion: while the agent link is down (mid-backoff), a fresh queryOnly against the
    // OLD hub for a DIFFERENT, never-seen id must resolve definitively rather than hang — the hub
    // itself, not the (now-unreachable) agent, answers E_UNKNOWN_ID for an id its LRU never saw.
    await env.hub.close("test-restart");
    await waitUntil(() => currentConnection()?.status().state === "backoff", 8_000, "backoff after close");

    let feDeps: FrontendDeps | undefined;
    const frontend: FrontendFactory = (d) => {
      feDeps = d;
      return createHttpFrontend(d);
    };
    const newHub = await startHub(hubConfig({ home: env.home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
    if ("exists" in newHub) throw new Error("unexpected singleton collision on restart");
    env.hub = newHub;
    await waitUntil(() => currentConnection()?.status().state === "live", 10_000, "live again on new hub");
    await waitUntil(() => (feDeps?.registry.list().length ?? 0) === 1, 8_000, "agent re-registered");
    env.agentKey = feDeps!.registry.list()[0]!.agentKey;
    env.cookie = await login(newHub.httpPort, newHub.paths.tokenFile);

    const replay = await postJson(newHub.httpPort, "/api/cmd", { ...body, agentKey: env.agentKey }, cmdHeaders(env));
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ ok: true, dup: true });
    expect(env.pi.sent).toHaveLength(1); // sendUserMessage was NOT called a second time
  }, 30_000);

  it.skipIf(NO_NODE_SQLITE)(
    "C4 remnant: several DIFFERENT cmdIds all timing out to `unknown` concurrently resolve independently",
    async () => {
      // steer_subagent needs a QueryControlPort the top-level activate() cannot have injected —
      // wire the agent side directly (still a real socket + real HTTP hub, see file header).
      const home = sandboxHome();
      const cwd = mkdtempSync(join(tmpdir(), "wh-ctl-steer-cwd-"));
      const sessionFile = join(cwd, "session.jsonl");
      writeFileSync(
        sessionFile,
        JSON.stringify({ type: "session", version: 3, id: "sess-steer", timestamp: "2026-09-27T00:00:00.000Z", cwd }) +
          "\n",
        "utf8",
      );
      let feDeps: FrontendDeps | undefined;
      const frontend: FrontendFactory = (d) => {
        feDeps = d;
        return createHttpFrontend(d);
      };
      const hub = await startHub(hubConfig({ home: home.home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
      if ("exists" in hub) throw new Error("unexpected singleton collision");
      const pi = fakePi();
      const ctxState: CtxState = {
        leaf: null,
        idle: true,
        pending: false,
        abortCalls: 0,
        notifyCalls: [],
        compactCalls: [],
      };
      const ctx = makeCtx(cwd, sessionFile, ctxState);
      // try/finally: every cleanup step below MUST run even if an assertion throws mid-test —
      // this test does not use the shared `setup()`/`teardown()` pair, and a leaked `CONN_KEY` /
      // hub singleton lock would poison every later test in this file (a real regression hit
      // while developing this suite: one uncaught throw here cascaded into ~15 unrelated
      // "timeout waiting for agent registered" failures further down the file).
      try {
        const resolvers = new Map<string, (r: { ok: true } | { ok: false; reason: string }) => void>();
        const query: QueryControlPort = {
          get: (_runId) => ({ status: "running" }),
          steer: (runId, _text) =>
            new Promise((resolve) => {
              resolvers.set(runId, resolve);
            }),
          stop: async () => ({ ok: false, reason: "unknown_run" }),
        };
        wireWebHub(pi.pi, {
          settings: {
            enabled: true,
            autoStart: false,
            port: 0,
            idleExitMinutes: 10,
            nodeLoader: "",
            control: true,
            remoteAskUser: false,
            webCommands: false,
          },
          fleet: () => [],
          query: () => query,
          paths: resolveHubPaths({ home: home.home, uid: process.getuid?.() ?? 0 }),
        } as unknown as WebHubDeps);
        await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
        await waitUntil(() => (feDeps?.registry.list().length ?? 0) === 1, 8_000, "agent registered");
        const agentKey = feDeps!.registry.list()[0]!.agentKey;
        const cookie = await login(hub.httpPort, hub.paths.tokenFile);
        const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${hub.httpPort}` };

        const runIds = ["run-a", "run-b", "run-c"];
        const ids = runIds.map((_r, i) => cmdId(`steer-${i}`));
        const posts = runIds.map((runId, i) =>
          rawRequest(hub.httpPort, {
            method: "POST",
            path: "/api/cmd",
            headers: { ...JSON_HEADERS, ...headers },
            body: JSON.stringify({ agentKey, id: ids[i], op: "steer_subagent", runId, text: "steer" }),
            timeoutMs: 9_000, // the server's own steer deadline is ~5s (min(5000, opTotal)); give it headroom
          }),
        );
        const results = await Promise.all(posts);
        for (const res of results) {
          expect(res.status).toBe(504);
          expect(JSON.parse(res.body)).toMatchObject({ error: "E_DEADLINE", retryable: true, effect: "unknown" });
        }

        // Resolve them out of order and confirm each late settlement is independently attributable
        // (no cross-contamination between the three concurrently-unknown cmdIds). Whether the
        // ledger marks the eventual settlement `late:true` (settleLate) or plain (settleAndReply)
        // is a razor-thin race between the agent's own ~5s internal timer and the promise
        // resolution below — already exhaustively covered by the fast, deterministic unit suite
        // `tests/web-hub/agent/steer-late.test.ts` (fake timers, no such race). This test's own,
        // NOT-otherwise-covered claim is the one under assertion: three DIFFERENT concurrently-
        // unknown cmdIds each resolve to their OWN correct final state over the real socket+HTTP
        // stack, with zero cross-contamination between them.
        resolvers.get("run-b")!({ ok: true });
        resolvers.get("run-a")!({ ok: false, reason: "steer_rejected" });
        resolvers.get("run-c")!({ ok: true });

        const queryOnce = (id: string) =>
          postJson(
            hub.httpPort,
            "/api/cmd",
            { agentKey, id, queryOnly: true, op: "steer_subagent", runId: "n/a", text: "" },
            headers,
          );
        const dataOf = (r: { body: string }) =>
          (JSON.parse(r.body) as { data: { state: string; late?: true; result?: { ok: boolean; code?: string } } })
            .data;

        let last: [{ body: string }, { body: string }, { body: string }] | undefined;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [a, b, c] = await Promise.all(ids.map(queryOnce));
          last = [a, b, c];
          if ([a, b, c].every((r) => r.status === 200 && dataOf(r).state !== "running")) break;
          await new Promise((r) => setTimeout(r, 2_000)); // "query" bucket: capacity 20, refill 1/s
        }
        if (last === undefined) throw new Error("test bug: queryOnce never ran");
        const [qa, qb, qc] = last;
        expect(dataOf(qa)).toMatchObject({ state: "failed", result: { ok: false, code: "E_SUBAGENT_REJECTED" } });
        expect(dataOf(qb)).toMatchObject({ state: "ok", result: { ok: true } });
        expect(dataOf(qc)).toMatchObject({ state: "ok", result: { ok: true } });

        await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      } finally {
        resetGlobals();
        delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
        await hub.close("test-teardown").catch(() => undefined);
        home.restore();
        rmSync(home.home, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// ===========================================================================
// scenario 4 — ask_user dual-channel race
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — ask_user dual channel", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  function askUserParams() {
    return { questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] };
  }

  it("two web clients race to answer the same dialog ⇒ one 200, one 409; SSE dialogs.closed records the winner", async () => {
    env = await setup();
    const sseA = await openBrowser(env);
    const sseB = await openSse(env.hub.httpPort, { cookie: env.cookie });
    env.sse.push(sseB);
    await sseB.waitFor((ev) => ev.event === "hello", 5_000);
    await postJson(
      env.hub.httpPort,
      "/api/subscribe",
      {
        clientId: (sseB.events.find((e) => e.event === "hello")!.data as { clientId: string }).clientId,
        agentKey: env.agentKey,
      },
      { Cookie: env.cookie },
    );

    const tool = env.pi.tools.get("ask_user")!;
    let component: { handleInput(s: string): void; cancel(): void } | undefined;
    env.ctxState.uiCustom = (factory: unknown) =>
      new Promise((resolve) => {
        component = (factory as (...a: unknown[]) => unknown)(mockTui, stubTheme, {}, resolve) as typeof component;
      });
    const pending = tool.execute("tc1", askUserParams(), undefined, undefined, env.ctx);
    await waitUntil(() => component !== undefined, 3_000, "ask_user component created");

    const dialogsEv = await sseA.waitFor((ev) => ev.event === "dialogs" && ev.data.open.length === 1, 5_000);
    const dialogId = (dialogsEv.data.open[0] as { dialogId: string }).dialogId;
    const epoch = dialogsEv.data.epoch as string;
    const answerBody = (id: string) => ({
      agentKey: env!.agentKey,
      id,
      dialogId,
      epoch,
      action: "answer" as const,
      answers: [{ selected: ["Postgres"], other: null }],
    });

    const [ra, rb] = await Promise.all([
      postJson(env.hub.httpPort, "/api/dialog", answerBody(cmdId("wa1")), cmdHeaders(env)),
      postJson(env.hub.httpPort, "/api/dialog", answerBody(cmdId("wa2")), cmdHeaders(env)),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(JSON.parse(loser.body)).toMatchObject({ error: "E_DIALOG_CLOSED" });

    const closedEv = await sseA.waitFor((ev) => ev.event === "dialogs" && ev.data.closed.length === 1, 5_000);
    expect(closedEv.data.closed[0]).toMatchObject({ dialogId, by: "web", outcome: "answered" });

    const result = (await pending) as { details: { answers: Record<string, unknown>; cancelled: boolean } };
    expect(result.details.cancelled).toBe(false);
  }, 20_000);

  it("TUI answers first ⇒ the web POST 409s and dialogs.closed records by:tui", async () => {
    env = await setup();
    const sse = await openBrowser(env);

    const tool = env.pi.tools.get("ask_user")!;
    let component: { handleInput(s: string): void } | undefined;
    env.ctxState.uiCustom = (factory: unknown) =>
      new Promise((resolve) => {
        component = (factory as (...a: unknown[]) => unknown)(mockTui, stubTheme, {}, resolve) as typeof component;
      });
    const pending = tool.execute("tc2", askUserParams(), undefined, undefined, env.ctx);
    await waitUntil(() => component !== undefined, 3_000, "component created");

    const dialogsEv = await sse.waitFor((ev) => ev.event === "dialogs" && ev.data.open.length === 1, 5_000);
    const dialogId = (dialogsEv.data.open[0] as { dialogId: string }).dialogId;
    const epoch = dialogsEv.data.epoch as string;

    // TUI answers (Enter selects the first/highlighted option) before the web POST lands.
    component!.handleInput("\r");
    await pending;

    const res = await postJson(
      env.hub.httpPort,
      "/api/dialog",
      {
        agentKey: env.agentKey,
        id: cmdId("wa3"),
        dialogId,
        epoch,
        action: "answer",
        answers: [{ selected: ["Postgres"], other: null }],
      },
      cmdHeaders(env),
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_DIALOG_CLOSED" });
    const closedEv = await sse.waitFor((ev) => ev.event === "dialogs" && ev.data.closed.length === 1, 5_000);
    expect(closedEv.data.closed[0]).toMatchObject({ dialogId, by: "tui" });
  }, 20_000);
});

// ===========================================================================
// scenario 5 — old agent (no cmd.v1 cap) never gets a cmd frame forwarded
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — legacy agent without control caps", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("an agent that only hello'd ev.v1 gets 409 on /api/cmd and never receives a cmd frame", async () => {
    env = await setup();
    const client: TestClient = await connectClient(env.hub.paths.socketPath);
    client.send(
      hello({
        agentId: { pid: process.pid, nonce: "legacyagentnonce1" },
        epoch: "e-legacy",
        cwd: "/tmp/legacy",
        caps: ["ev.v1"],
      }),
    );
    await client.waitFrame((f) => f["t"] === "hello_ack");
    await waitUntil(() => env!.feDeps.registry.list().length === 2, 5_000, "legacy agent registered");
    const legacyKey = env.feDeps.registry.list().find((a) => a.agentKey !== env!.agentKey)!.agentKey;

    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: legacyKey, id: cmdId("legacy1"), op: "abort" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UNSUPPORTED" });
    expect(client.frames.some((f) => (f as { t: string }).t === "cmd")).toBe(false);
    client.sock.destroy();
  }, 15_000);
});

// ===========================================================================
// scenario 6 — LAN listener slim replay (prompt + ask_user) with audit lines
// ===========================================================================

describe.skipIf(NO_NODE_SQLITE)("web-hub control-plane integration (#32 C7) — LAN listener", () => {
  let env: Env | undefined;
  let admin: TestClient | undefined;
  afterEach(async () => {
    admin?.sock.destroy();
    admin = undefined;
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("prompt over the LAN listener dispatches and an audit line records listener:lan", async () => {
    const ip = firstLanIPv4();
    if (ip === undefined) {
      console.warn("[web-hub-control.test.ts] no non-loopback IPv4 interface; skipping this assertion");
      return;
    }
    const lan: HubLanConfig = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
    env = await setup({ lan });
    await waitUntil(() => env!.hub.lanStatus()?.state === "on", 10_000, "lan on");
    const lanPort = env.hub.lanStatus()!.port;
    const host = `${ip}:${lanPort}`;

    admin = await connectClient(env.hub.paths.socketPath);
    admin.send(hello({ agentId: { pid: process.pid, nonce: "lanadminprobenonc" }, epoch: "e-lan-admin" }));
    await admin.waitFrame((f) => f["t"] === "hello_ack");
    const rid = "info-1";
    admin.send({ t: "lan_req", rid, op: "info" });
    const infoFrame = (await admin.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === rid)) as unknown as {
      ok: true;
      info: { username: string; initialPassword: string };
    };
    expect(infoFrame.ok).toBe(true);

    const loginRes = await lanPostJson(
      lanPort,
      "/api/login",
      { username: infoFrame.info.username, password: infoFrame.info.initialPassword },
      { Host: host },
    );
    expect(loginRes.status).toBe(200);
    const lanCookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

    const id = cmdId("lan1");
    const res = await lanPostJson(
      lanPort,
      "/api/cmd",
      { agentKey: env.agentKey, id, op: "prompt", text: "hello from LAN", deliver: "steer" },
      { Cookie: lanCookie, Host: host, Origin: `http://${host}` },
    );
    await fireInput(env, { text: "hello from LAN", source: "extension" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { op: "prompt" } });

    const log = readFileSync(env.hub.paths.logFile, "utf8");
    const auditLines = log.split("\n").filter((l) => l.includes('"audit":"control"') && l.includes('"listener":"lan"'));
    expect(auditLines.length).toBeGreaterThan(0);
    expect(auditLines.some((l) => l.includes(id))).toBe(true);
    // U7: no line anywhere carries the prompt text.
    expect(log).not.toContain("hello from LAN");
  }, 20_000);
});

// ===========================================================================
// scenario 8 — commands (builtin bridge, unknown, confirm two-step, extension dispatch)
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — commands", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("/session (builtin, allow) returns captured output synchronously", async () => {
    env = await setup();
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("c1"), op: "command", name: "session", args: "" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { kind: string; completion: string; output?: { entries: Array<{ text: string }> } };
    };
    expect(body.data).toMatchObject({ kind: "builtin", completion: "sync" });
    expect(body.data.output?.entries[0]?.text).toContain("session:");
  }, 15_000);

  it("/name x (builtin) calls pi.setSessionName", async () => {
    env = await setup();
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("c2"), op: "command", name: "name", args: "demo-name" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(200);
    expect(env.pi.setSessionNameCalls).toEqual(["demo-name"]);
  }, 15_000);

  it("/foo (never registered, not a builtin) ⇒ 404 E_UNKNOWN_COMMAND, zero sendUserMessage calls", async () => {
    env = await setup();
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("c3"), op: "command", name: "foo", args: "" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: "E_UNKNOWN_COMMAND" });
    expect(env.pi.sent).toHaveLength(0);
  }, 15_000);

  it("a real registered extension command dispatches via sendUserMessage(expandPromptTemplates:true)", async () => {
    env = await setup();
    // "task" is registered unconditionally by src/index.ts, kind:"extension", default policy allow.
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("c4"), op: "command", name: "webhub", args: "status" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(200);
    expect(env.pi.sent).toHaveLength(1);
    expect(env.pi.sent[0]).toMatchObject({ text: "/webhub status", opts: { expandPromptTemplates: true } });
  }, 15_000);

  it("/compact while busy requires confirm:true (two-step); confirmed call reaches ctx.compact", async () => {
    env = await setup();
    env.ctxState.idle = false;
    const noConfirm = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("c5"), op: "command", name: "compact", args: "" },
      cmdHeaders(env),
    );
    expect(noConfirm.status).toBe(409);
    expect(JSON.parse(noConfirm.body)).toMatchObject({ error: "E_CONFIRM_REQUIRED" });
    expect(env.ctxState.compactCalls).toHaveLength(0);

    const confirmed = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("c6"), op: "command", name: "compact", args: "", confirm: true },
      cmdHeaders(env),
    );
    expect(confirmed.status).toBe(200);
    expect(JSON.parse(confirmed.body)).toMatchObject({ ok: true, data: { kind: "builtin", completion: "async" } });
    expect(env.ctxState.compactCalls).toHaveLength(1);
  }, 15_000);
});

// ===========================================================================
// scenario 11 — pi-toolkit command output capture (D22/§4.9) + third-party opt-out
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — command output capture", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("/agent status: real registration wrapped by wrapCommandApi ⇒ captured:true + terminal notify origin line", async () => {
    env = await setup();
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("cap1"), op: "command", name: "agent", args: "status" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { kind: string; captured?: boolean; output?: { entries: Array<{ text: string }> } };
    };
    expect(body.data.kind).toBe("extension");
    expect(body.data.captured).toBe(true);
    expect(body.data.output?.entries.length ?? 0).toBeGreaterThan(0);
    // D12/§4.7: the non-prompt write also leaves a terminal origin notify.
    expect(env.ctxState.notifyCalls.some(([msg]) => msg.includes("web ▸ /agent"))).toBe(true);
  }, 15_000);

  it("a third-party command registered on the RAW (unwrapped) pi reference is never captured, and both its own terminal notify and our origin-attribution notify are visible, in order (acc32-B5 revised per verifier r_29729WTC)", async () => {
    env = await setup();
    env.pi.pi.registerCommand("thirdparty", {
      handler: (_args: string, ctx: ExtensionCommandContext) => {
        ctx.ui.notify("third party output", "info");
      },
    } as never);
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id: cmdId("cap2"), op: "command", name: "thirdparty", args: "", confirm: true },
      cmdHeaders(env),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { data: { captured?: boolean } };
    expect(body.data.captured).toBe(false);
    // Plan §0.2/U6 requires a terminal notify for every successful non-prompt write op, third-
    // party commands included, so both calls must fire, in order: the third-party handler's own
    // notify first (run synchronously inside builtinBridge.execute()), then our attribution
    // notify. Pitfall (see OriginEntryPort.notify's doc comment): pi's real `showStatus()` merges
    // back-to-back status lines added with nothing else in between — our attribution notify is
    // therefore sent as `ctx.ui.notify(msg, "warning")`, the one type pi routes to `showWarning`
    // (always appends, never merges) instead of the merging `showStatus` path, so it cannot
    // silently overwrite the command's own line in a real TUI.
    const thirdPartyIdx = env.ctxState.notifyCalls.findIndex(([msg]) => msg === "third party output");
    const originIdx = env.ctxState.notifyCalls.findIndex(([msg]) => msg.includes("web ▸ /thirdparty"));
    expect(thirdPartyIdx).toBeGreaterThanOrEqual(0);
    expect(originIdx).toBeGreaterThan(thirdPartyIdx);
    expect(env.ctxState.notifyCalls[originIdx]?.[1]).toBe("warning");
  }, 15_000);
});

// ===========================================================================
// scenario 9 — token rotate revokes both loopback and LAN sessions
// ===========================================================================

describe.skipIf(NO_NODE_SQLITE)("web-hub control-plane integration (#32 C7) — token rotate", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("/webhub token rotate (online) revokes the loopback SSE session and the LAN session", async () => {
    const ip = firstLanIPv4();
    if (ip === undefined) {
      console.warn("[web-hub-control.test.ts] no non-loopback IPv4 interface; skipping this assertion");
      return;
    }
    const lan: HubLanConfig = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
    env = await setup({ lan });
    await waitUntil(() => env!.hub.lanStatus()?.state === "on", 10_000, "lan on");
    const lanPort = env.hub.lanStatus()!.port;
    const host = `${ip}:${lanPort}`;

    const admin = await connectClient(env.hub.paths.socketPath);
    admin.send(hello({ agentId: { pid: process.pid, nonce: "rotateadminnonce01" }, epoch: "e-rotate-admin" }));
    await admin.waitFrame((f) => f["t"] === "hello_ack");
    const rid = "info-rot";
    admin.send({ t: "lan_req", rid, op: "info" });
    const infoFrame = (await admin.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === rid)) as unknown as {
      ok: true;
      info: { username: string; initialPassword: string };
    };
    const loginRes = await lanPostJson(
      lanPort,
      "/api/login",
      { username: infoFrame.info.username, password: infoFrame.info.initialPassword },
      { Host: host },
    );
    const lanCookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    const lanSse = await openSse(lanPort, { cookie: lanCookie, host, destHost: ip });
    await lanSse.waitFor((ev) => ev.event === "hello", 5_000);

    const sseLoopback = await openBrowser(env);

    const webhub = env.pi.commands.get("webhub")!;
    await webhub.handler("token rotate", env.ctx);
    // §6.7.1: rotate revokes every session (loopback + LAN); both SSE streams end.
    await waitUntil(() => sseLoopback.ended, 5_000, "loopback SSE revoked");
    await waitUntil(() => lanSse.ended, 5_000, "LAN SSE revoked");

    admin.sock.destroy();
    lanSse.close();
  }, 25_000);
});

// ===========================================================================
// scenario 12 — offline rotate-intent recovery at hub startup (B2/D23, scoped)
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — offline token rotate recovery", () => {
  it("a leftover rotate.intent from an offline rotate is completed by the NEXT hub startup", async () => {
    const home = sandboxHome();
    try {
      const paths = resolveHubPaths({ home: home.home, uid: process.getuid?.() ?? 0 });
      mkdirSync(paths.stateDir, { recursive: true });

      // 1. hub is up once just to mint the initial on-disk token, then goes away (agent offline).
      let feDeps: FrontendDeps | undefined;
      const frontend: FrontendFactory = (d) => {
        feDeps = d;
        return createHttpFrontend(d);
      };
      const hub1 = await startHub(hubConfig({ home: home.home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
      if ("exists" in hub1) throw new Error("unexpected collision");
      void feDeps;
      const oldCookie = await login(hub1.httpPort, hub1.paths.tokenFile);
      const oldToken = readFileSync(hub1.paths.tokenFile, "utf8").trim();
      await hub1.close("offline-for-rotate");

      // 2. offline rotate: no live connection() ⇒ admin-cmds.ts does ①②③ itself.
      const outcome = await createAdminCommands().rotateToken();
      expect(outcome.kind).toBe("offline");
      const newToken = readFileSync(paths.tokenFile, "utf8").trim();
      expect(newToken).not.toBe(oldToken);
      const intentAfterOffline = readRotateIntentSync(paths.rotateIntentFile);
      expect(intentAfterOffline.state).toBe("present");
      if (intentAfterOffline.state === "present") expect(intentAfterOffline.intent.phase).toBe("token-written");

      // 3. next hub startup recovers the intent (④⑤: revoke + delete) before serving requests.
      const hub2 = await startHub(hubConfig({ home: home.home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
      if ("exists" in hub2) throw new Error("unexpected collision");
      try {
        await waitUntil(
          () => readRotateIntentSync(paths.rotateIntentFile).state === "absent",
          8_000,
          "rotate intent recovered on startup",
        );
        // the OLD cookie (minted against the pre-rotation token) no longer authenticates.
        const staleRes = await postJson(
          hub2.httpPort,
          "/api/cmd",
          { agentKey: "none", id: "a".repeat(16), op: "abort" },
          { Cookie: oldCookie, Origin: `http://127.0.0.1:${hub2.httpPort}` },
        );
        expect(staleRes.status).toBe(401);
        // the NEW on-disk token still logs in fine.
        const freshCookie = await login(hub2.httpPort, hub2.paths.tokenFile);
        expect(freshCookie).toMatch(/^pwh_sid=/);
      } finally {
        await hub2.close("test-teardown").catch(() => undefined);
      }
    } finally {
      home.restore();
      rmSync(home.home, { recursive: true, force: true });
    }
  }, 20_000);
});

// ===========================================================================
// scenario 13 — forced version replacement (B1/D25, scoped: trigger + ask_user survival)
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — forced supersede", () => {
  let env: Env | undefined;
  const prevEnv = process.env["PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS"];
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env["PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS"];
    else process.env["PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS"] = prevEnv;
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("a higher-version agent + an open ask_user dialog ⇒ forced replace after the (shortened) deadline; the dialog is never force-closed", async () => {
    process.env["PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS"] = "10000"; // SUPERSEDE_MIN_WAIT_MS floor
    env = await setup();

    const tool = env.pi.tools.get("ask_user")!;
    let component: unknown;
    env.ctxState.uiCustom = (factory: unknown) =>
      new Promise(() => {
        // never resolved by the test — this ask_user call stays open through the whole scenario.
        component = (factory as (...a: unknown[]) => unknown)(mockTui, stubTheme, {}, () => undefined);
      });
    void tool.execute(
      "tc-supersede",
      { questions: [{ question: "Q", options: [{ label: "A" }] }] },
      undefined,
      undefined,
      env.ctx,
    );
    await waitUntil(() => component !== undefined, 3_000, "ask_user component created");

    const higher = await connectClient(env.hub.paths.socketPath);
    higher.send(
      hello({
        agentId: { pid: process.pid + 1, nonce: "highversionagentnonc" },
        epoch: "e-higher",
        pluginVersion: "999.0.0",
        buildId: "999.0.0@higher",
      }),
    );
    await higher.waitFrame((f) => f["t"] === "hello_ack");

    const closedReason = await env.hub.closed;
    expect(closedReason).toMatch(/restart|supersede/i);
    await waitUntil(
      () => env!.ctxState.notifyCalls.some(([msg]) => /upgrading to v999\.0\.0/.test(msg) && /forced/i.test(msg)),
      5_000,
      "forced supersede notify observed",
    );
    // The ask_user dialog itself was never force-closed by the replacement (D25: TUI stays
    // answerable) — the tool call is still pending, never settled by the supersede path.
    higher.sock.destroy();
  }, 25_000);
});

// ===========================================================================
// C7 P2 leftover — SSE live forwarding for the ctl / commands / cmd_late slots.
// The C7 http.ts `onHubEvent` fix added these three forwarding arms, but until
// now only `dialogs` had a registry→bus→SSE live-push regression assertion
// (the ask_user dual-channel scenarios above); every test below waits on a
// REAL SSE stream for the live event, never on a ledger/snapshot read.
// ===========================================================================

describe("web-hub control-plane integration (#32 C7) — SSE live forwarding of ctl/commands/cmd_late", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("an observed prompt settle ⇒ the ctl slot is pushed live over SSE with the ledger item shape", async () => {
    env = await setup();
    const sse = await openBrowser(env);
    const id = cmdId("ctl1");
    const p = postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id, op: "prompt", text: "ctl live forward", deliver: "steer" },
      cmdHeaders(env),
    );
    await waitUntil(() => env!.pi.sent.length === 1, 3_000, "sendUserMessage called");
    await fireInput(env, { text: "ctl live forward", source: "extension" });
    expect((await p).status).toBe(200);

    // The observation settle republishes the ctl slot (commands.ts onChanged → publishCtl →
    // setSlot → ctl frame → registry publish → http.ts onHubEvent) — the browser must see it
    // as a live `ctl` event carrying this cmdId at promptState "observed".
    const ctlEv = await sse.waitFor(
      (ev) =>
        ev.event === "ctl" &&
        Array.isArray(ev.data.items) &&
        (ev.data.items as Array<{ cmdId?: string; state?: string }>).some(
          (i) => i.cmdId === id && i.state === "observed",
        ),
      5_000,
    );
    expect(ctlEv.data).toMatchObject({ agentKey: env.agentKey, sessionId: "ctl-session" });
    expect(typeof ctlEv.data.epoch).toBe("string");
    const item = (ctlEv.data.items as Array<Record<string, unknown>>).find((i) => i.cmdId === id)!;
    expect(item).toMatchObject({ cmdId: id, op: "prompt", state: "observed", behavior: "idle" });
    expect(typeof item.at).toBe("number");
    expect(typeof item.updatedAt).toBe("number");
  }, 15_000);

  it("resources_discover ⇒ the refreshed commands slot is pushed live over SSE", async () => {
    env = await setup();
    const sse = await openBrowser(env);
    // The initial commands slot was published at attach time, before this browser connected —
    // `resources_discover` is the mid-session republish trigger (agent/index.ts's own handler),
    // so the event below can only have arrived as a live push.
    await env.pi.fire("resources_discover", { type: "resources_discover" }, env.ctx);
    const cmdEv = await sse.waitFor(
      (ev) => ev.event === "commands" && Array.isArray(ev.data.items) && ev.data.items.length > 0,
      5_000,
    );
    expect(cmdEv.data).toMatchObject({ agentKey: env.agentKey });
    expect(typeof cmdEv.data.epoch).toBe("string");
    const webhub = (cmdEv.data.items as Array<Record<string, unknown>>).find((i) => i.name === "webhub");
    expect(webhub).toMatchObject({ name: "webhub", kind: "extension" });
    expect(["allow", "confirm", "deny"]).toContain(webhub?.policy);
  }, 15_000);

  it("/compact's async completion ⇒ the late settle is pushed live over SSE as cmd_late", async () => {
    env = await setup();
    const sse = await openBrowser(env);
    const id = cmdId("late1");
    const res = await postJson(
      env.hub.httpPort,
      "/api/cmd",
      { agentKey: env.agentKey, id, op: "command", name: "compact", args: "" },
      cmdHeaders(env),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { kind: "builtin", completion: "async" } });

    // The fake ctx.compact fires onComplete ~10ms later → builtin-bridge sendLate →
    // commandHandler.handleBridgeLate → settleLate → cmd_late wire frame → registry publish →
    // http.ts onHubEvent. The synchronous cmd_result already answered the POST above, so this
    // SSE event is the deterministic late-settlement path (no steer-timer race involved).
    const lateEv = await sse.waitFor((ev) => ev.event === "cmd_late" && ev.data.id === id, 5_000);
    expect(lateEv.data).toMatchObject({
      agentKey: env.agentKey,
      id,
      op: "command",
      ok: true,
      data: { op: "command", kind: "builtin", completion: "sync" },
    });
  }, 15_000);
});
