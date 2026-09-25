// web-hub plan §包 I — e2e: real unix socket + real in-process hub
// (startHub + createHttpFrontend) + the REAL assembly (src/index.ts activate
// with webHub.enabled=true) driven by a fake pi, plus a real HTTP/SSE
// "browser" client.
//
// Coverage (plan §包 I 测试表): two agents visible over SSE; message events →
// delta frames; /api/subscribe history == jsonl fixture projection; /reload
// ×3 keeps agentKey + agent count; hub close ⇒ agent backoff with synchronous
// handlers; K4 both paths (same-instance reuse, cross-module handover); idle
// custom_message ⇒ SSE `append`. The sandbox settings pin reload.defer:false
// (本机 defer 会把 /reload 改写成 parked；plan §10 #6).
//
// One process can only host ONE real agent connection (CONN_KEY is a
// process-wide singleton by design — /reload handover depends on it), so the
// second "TUI" is a raw protocol client on the same socket (hub-side tests
// use the same harness); the pi-assembly side (the thing package I owns) is
// exercised fully through activate().

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { currentConnection } from "../../src/web-hub/agent/connection.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import type { FrontendDeps, FrontendFactory, HubEvent } from "../../src/web-hub/hub/ports.js";
import type { HistoryPayload } from "../../src/web-hub/protocol/http-contract.js";
import { projectSessionEntry } from "../../src/web-hub/protocol/keys.js";
import { AGENT_ID_KEY, resetGlobals, waitUntil } from "../web-hub/agent/helpers.js";
import { config as hubConfig, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, type SseConn } from "../web-hub/http/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const HOST_KEY = Symbol.for("pi-subagent:host");

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  const fire = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, fire };
}

interface CtxState {
  leaf: string | null;
}

function makeCtx(cwd: string, sessionFile: string, state: CtxState): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { provider: "test", id: "m" },
    thinkingLevel: "low",
    getContextUsage: () => ({ tokens: 10, contextWindow: 200_000, percent: 0.1 }),
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: () => undefined, setStatus: () => undefined },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => state.leaf,
      getSessionFile: () => sessionFile,
      getSessionId: () => "e2e-session",
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;
}

const SETTINGS = {
  reload: { defer: false },
  webHub: { enabled: true, autoStart: false, port: 0, idleExitMinutes: 10 },
  hud: { enabled: false },
  sessionNav: { enabled: false },
  feishuNotify: { enabled: false },
  memory: { enabled: false },
  webSearch: { enabled: false },
  todo: { enabled: false },
  askUser: { enabled: false },
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
  tuiB?: TestClient;
}

let env: Env | undefined;

async function openBrowser(e: Env): Promise<SseConn> {
  const sse = await openSse(e.hub.httpPort, { cookie: e.cookie });
  e.sse.push(sse);
  await sse.waitFor((ev) => ev.event === "hello", 5_000);
  return sse;
}

async function subscribe(e: Env, sse: SseConn, agentKey: string): Promise<void> {
  const helloEv = sse.events.find((ev) => ev.event === "hello")!;
  const res = await postJson(
    e.hub.httpPort,
    "/api/subscribe",
    { clientId: helloEv.data.clientId, agentKey },
    { Cookie: e.cookie },
  );
  expect(res.status).toBe(202);
}

async function setup(): Promise<Env> {
  const home = sandboxHome();
  const settingsPath = join(home.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(SETTINGS) + "\n", "utf8");
  const cwd = mkdtempSync(join(tmpdir(), "wh-e2e-cwd-"));
  const sessionFile = join(cwd, "session.jsonl");
  const ts = "2026-09-27T00:00:00.000Z";
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "sess-e2e", timestamp: ts, cwd }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: "fixture question", timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: "fixture answer",
          provider: "test",
          model: "m",
          stopReason: "stop",
          timestamp: 2,
          usage: { input: 1, output: 1, cost: { total: 0 } },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  let feDeps: FrontendDeps | undefined;
  const frontend: FrontendFactory = (d) => {
    feDeps = d;
    return createHttpFrontend(d);
  };
  const started = await startHub(hubConfig({ home: home.home, port: 0 }), frontend, { uid: process.getuid?.() ?? 0 });
  if ("exists" in started) throw new Error("unexpected hub singleton collision");
  const hub = started;
  const busEvents: HubEvent[] = [];
  feDeps!.bus.subscribe((ev) => busEvents.push(ev));

  const pi = fakePi();
  activate(pi.pi);
  const ctxState: CtxState = { leaf: "a1" };
  const ctx = makeCtx(cwd, sessionFile, ctxState);
  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => feDeps!.registry.list().length === 1, 8_000, "agent A registered");
  const agentKey = feDeps!.registry.list()[0]!.agentKey;
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);

  env = {
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
    ...({} as Record<never, never>),
  };
  (env as { restoreHome: () => void }).restoreHome = home.restore;
  return env;
}

async function addTuiB(e: Env): Promise<TestClient> {
  const client = await connectClient(e.hub.paths.socketPath);
  client.send(hello({ agentId: { pid: process.pid, nonce: "bbbbbbbbbbbbbbbb" }, epoch: "eB", cwd: "/tmp/wb" }));
  await client.waitFrame((f) => f["t"] === "hello_ack");
  await waitUntil(() => e.feDeps.registry.list().length === 2, 5_000, "agent B registered");
  e.tuiB = client;
  return client;
}

afterEach(async () => {
  const e = env;
  env = undefined;
  if (e === undefined) return;
  try {
    await e.pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, e.ctx);
  } catch {
    /* best effort */
  }
  for (const s of e.sse.splice(0)) s.close();
  e.tuiB?.sock.destroy();
  resetGlobals();
  delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  await e.hub.close("test-teardown").catch(() => undefined);
  const restore = (e as { restoreHome?: () => void }).restoreHome;
  restore?.();
  rmSync(e.home, { recursive: true, force: true });
  rmSync(e.cwd, { recursive: true, force: true });
});

describe("web-hub e2e (real hub + real assembly)", () => {
  it("two agents on SSE; message flow ⇒ delta frames; subscribe history == fixture projection", async () => {
    const e = await setup();
    await addTuiB(e);

    const sse = await openBrowser(e);
    const agentsEv = await sse.waitFor(
      (ev) => ev.event === "agents" && Array.isArray(ev.data.agents) && ev.data.agents.length === 2,
      5_000,
    );
    expect(agentsEv.data.agents.map((a: { agentKey: string }) => a.agentKey)).toContain(e.agentKey);

    // subscribe ⇒ history snapshot equals the fixture file projection
    await subscribe(e, sse, e.agentKey);
    const historyEv = await sse.waitFor((ev) => ev.event === "history", 8_000);
    const payload = historyEv.data as HistoryPayload;
    expect(payload.agentKey).toBe(e.agentKey);
    const expected = readFileSync(e.sessionFile, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => projectSessionEntry(JSON.parse(l)))
      .filter((x) => x !== undefined);
    expect(payload.entries).toEqual(expected);
    expect(payload.entries.map((x) => x.id)).toEqual(["u1", "a1"]);

    // message flow ⇒ live delta frames on the wire
    fireStream(e);
    await sse.waitFor(
      (ev) =>
        ev.event === "ev" &&
        ev.data.agentKey === e.agentKey &&
        ev.data.e.type === "message_update" &&
        JSON.stringify(ev.data.e).includes("Hello"),
      5_000,
    );
    await sse.waitFor(
      (ev) => ev.event === "ev" && ev.data.agentKey === e.agentKey && ev.data.e.type === "message_end",
      5_000,
    );
  }, 30_000);

  it("/reload ×3 (resetModules + re-activate): handover, agentKey stable, still 2 agents", async () => {
    const e = await setup();
    await addTuiB(e);
    const keyBefore = e.agentKey;

    for (let i = 0; i < 3; i++) {
      const prevConn = currentConnection();
      await e.pi.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, e.ctx);
      vi.resetModules();
      const fresh = (await import("../../src/index.js")).default;
      const next = fakePi();
      fresh(next.pi);
      const ctxState: CtxState = { leaf: "a1" };
      const ctx = makeCtx(e.cwd, e.sessionFile, ctxState);
      await next.fire("session_start", { type: "session_start", reason: "reload" }, ctx);
      // The registry agent stays "live" through the detach grace, so poll the
      // CONNECTION instead: a real handover swaps the global object (new
      // module instance, same agentId) before it goes live again.
      await waitUntil(
        () => {
          const c = currentConnection();
          return c !== undefined && c !== prevConn && c.status().state === "live";
        },
        8_000,
        `new connection live after reload ${i + 1}`,
      );
      await waitUntil(
        () => {
          const a = e.feDeps.registry.get(keyBefore);
          return a !== undefined && a.state === "live";
        },
        8_000,
        `agent live after reload ${i + 1}`,
      );
      e.pi = next;
      e.ctx = ctx;
      e.ctxState = ctxState;
      expect(e.feDeps.registry.list()).toHaveLength(2);
    }
    expect(e.feDeps.registry.get(keyBefore)).toBeDefined();
    // hub log records the claim-window reclaim (same agentId, new epoch), not a down/up flap
    const log = readFileSync(e.hub.paths.logFile, "utf8");
    expect(log).toContain("agent reclaimed");
    expect(log).toContain('"epochChanged":true');
    const flaps = e.busEvents.filter(
      (ev) => (ev.type === "agent_down" || ev.type === "agent_up") && "agentKey" in ev && ev.agentKey === keyBefore,
    );
    expect(flaps).toEqual([]);
  }, 60_000);

  it("K4 path 1: session_shutdown(new) + same-instance re-activate reuses the connection, zero down/up", async () => {
    const e = await setup();
    const before = currentConnection();
    expect(before).toBeDefined();
    const marker = e.busEvents.length;

    await e.pi.fire("session_shutdown", { type: "session_shutdown", reason: "new" }, e.ctx);
    delete (globalThis as Record<symbol, unknown>)[HOST_KEY]; // pi releases it via the shutdown handler; assert-free double tap
    const next = fakePi();
    activate(next.pi); // SAME module instance (no resetModules)
    const ctxState: CtxState = { leaf: "a1" };
    const ctx = makeCtx(e.cwd, e.sessionFile, ctxState);
    await next.fire("session_start", { type: "session_start", reason: "new" }, ctx);
    expect(currentConnection()).toBe(before); // reused synchronously
    await waitUntil(() => currentConnection()?.status().state === "live", 8_000, "live again");
    e.pi = next;
    e.ctx = ctx;
    e.ctxState = ctxState;

    const flaps = e.busEvents
      .slice(marker)
      .filter(
        (ev) => (ev.type === "agent_down" || ev.type === "agent_up") && "agentKey" in ev && ev.agentKey === e.agentKey,
      );
    expect(flaps).toEqual([]);
  }, 30_000);

  it("hub close ⇒ agent state backoff and event handlers still return synchronously", async () => {
    const e = await setup();
    await e.hub.close("test");
    await waitUntil(() => currentConnection()?.status().state === "backoff", 10_000, "backoff after hub close");

    const t0 = performance.now();
    await e.pi.fire(
      "message_start",
      { type: "message_start", message: { role: "user", timestamp: 3, content: "while hub is down" } },
      e.ctx,
    );
    await e.pi.fire("turn_end", { type: "turn_end", turnIndex: 1 }, e.ctx);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1_000); // handlers enqueue synchronously; no network on the pi main loop
  }, 30_000);

  it("idle custom_message (no extension events) ⇒ SSE append within ~2s of the leaf probe", async () => {
    const e = await setup();
    const sse = await openBrowser(e);
    await subscribe(e, sse, e.agentKey);
    await sse.waitFor((ev) => ev.event === "history", 8_000);

    // spike K7④: an idle sendMessage(triggerTurn:false) lands on disk only —
    // append it to the session file and move the leaf; the 1Hz leaf probe +
    // hub tail-fill must surface it as `append`.
    appendFileSync(
      e.sessionFile,
      JSON.stringify({
        type: "custom_message",
        customType: "subagent:task-started",
        content: "idle hello",
        display: true,
        id: "c1",
        parentId: "a1",
        timestamp: "2026-09-27T00:01:00.000Z",
      }) + "\n",
      "utf8",
    );
    e.ctxState.leaf = "c1";
    const appendEv = await sse.waitFor(
      (ev) =>
        ev.event === "append" &&
        ev.data.agentKey === e.agentKey &&
        (ev.data.entries as Array<{ id: string }>).some((x) => x.id === "c1"),
      6_000,
    );
    const entry = (appendEv.data.entries as Array<{ id: string; content?: unknown }>).find((x) => x.id === "c1")!;
    expect(entry.content).toBe("idle hello");
  }, 30_000);
});

/** Fire a small assistant streaming round through the event tap. */
function fireStream(e: Env): void {
  const msg = { role: "assistant", content: "Hello stream", provider: "test", model: "m", timestamp: 3 };
  void e.pi.fire("message_start", { type: "message_start", message: msg }, e.ctx);
  void e.pi.fire(
    "message_update",
    {
      type: "message_update",
      message: msg,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    },
    e.ctx,
  );
  void e.pi.fire(
    "message_update",
    {
      type: "message_update",
      message: msg,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " stream" },
    },
    e.ctx,
  );
  void e.pi.fire("message_end", { type: "message_end", message: msg }, e.ctx);
}
