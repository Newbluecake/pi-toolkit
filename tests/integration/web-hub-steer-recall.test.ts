// web-hub-steer-recall integration tests (plan §9 anchor `tests/integration/web-hub-steer-recall.test.ts`:
// I1–I8 + RB2). Framework: REAL hub (`startHub` + `createHttpFrontend`) + REAL `activate()`
// (src/index.ts, settings from the sandboxed home) driven by a fake pi/ctx, plus real
// `http.request`/SSE "browser" clients — the same shape as `web-hub-control.test.ts`. The hold
// driver's own state machine is P-core's conformance gate; this file proves the full
// hub↔agent↔browser loop: hold → status.held on SSE → recall (full text) → dup windows →
// feature-off rollback → disconnect replay/hand-out.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import activate from "../../src/index.js";
import { currentConnection } from "../../src/web-hub/agent/connection.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import type { FrontendDeps, FrontendFactory, HubConfig, HubLanConfig } from "../../src/web-hub/hub/ports.js";
import { AGENT_ID_KEY, resetGlobals, waitUntil } from "../web-hub/agent/helpers.js";
import { config as hubConfig } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, type SseConn } from "../web-hub/http/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const HOST_KEY = Symbol.for("pi-subagent:host");
const LEDGER_KEY = Symbol.for("pi-subagent:web-hub:cmd-ledger");
const HOLD_BAG_KEY = Symbol.for("pi-subagent:web-hub:hold-buffer");
const NO_NODE_SQLITE = !(await hasNodeSqlite());

// ---------------------------------------------------------------------------
// fake pi / ctx — the control-plane subset of web-hub-control.test.ts's harness
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi(): {
  pi: ExtensionAPI;
  fire: (event: string, payload: unknown, ctx: unknown) => Promise<void>;
  sent: Array<{ text: string; opts: { deliverAs?: "steer" | "followUp" } }>;
} {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ text: string; opts: { deliverAs?: "steer" | "followUp" } }> = [];
  const pi = {
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
    getCommands() {
      return [];
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    sendMessage() {},
    sendUserMessage(text: string, opts: { deliverAs?: "steer" | "followUp" } = {}) {
      sent.push({ text, opts });
    },
    appendEntry() {},
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  };
  const fire = async (event: string, payload: unknown, ctx: unknown): Promise<void> => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, fire, sent };
}

interface CtxState {
  idle: boolean;
  pending: boolean;
}

function makeCtx(cwd: string, sessionFile: string, state: CtxState): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    abort: () => undefined,
    model: { provider: "test", id: "m" },
    thinkingLevel: "low",
    getContextUsage: () => ({ tokens: 10, contextWindow: 200_000, percent: 0.1 }),
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
      input: () => Promise.resolve(undefined),
      custom: () => Promise.reject(new Error("ui.custom not mocked")),
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => "L1",
      getSessionFile: () => sessionFile,
      getSessionId: () => "sr-session",
      getSessionName: () => undefined,
    },
  } as unknown as ExtensionContext;
}

const BASE_SETTINGS = {
  reload: { defer: false },
  webHub: {
    enabled: true,
    autoStart: false,
    port: 0,
    idleExitMinutes: 10,
    control: true,
    remoteAskUser: false,
    webCommands: false,
  },
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
  hub: RunningHub;
  feDeps: FrontendDeps;
  agentKey: string;
  ctxState: CtxState;
  pi: ReturnType<typeof fakePi>;
  ctx: ExtensionContext;
  cookie: string;
  sse: SseConn[];
  restoreHome: () => void;
}

async function setup(settings: unknown = BASE_SETTINGS): Promise<Env> {
  const home = sandboxHome();
  const settingsPath = join(home.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings) + "\n", "utf8");
  const cwd = mkdtempSync(join(tmpdir(), "wh-sr-cwd-"));
  const sessionFile = join(cwd, "session.jsonl");
  writeFileSync(
    sessionFile,
    [JSON.stringify({ type: "session", version: 3, id: "sess-sr", timestamp: "2026-10-09T00:00:00.000Z", cwd })].join(
      "\n",
    ) + "\n",
    "utf8",
  );

  let feDeps: FrontendDeps | undefined;
  const frontend: FrontendFactory = (d) => {
    feDeps = d;
    return createHttpFrontend(d);
  };
  const cfg: HubConfig = hubConfig({ home: home.home, port: 0 });
  const started = await startHub(cfg, frontend, { uid: process.getuid?.() ?? 0 });
  if ("exists" in started) throw new Error("unexpected hub singleton collision");
  const hub = started;

  const pi = fakePi();
  activate(pi.pi);
  const ctxState: CtxState = { idle: true, pending: false };
  const ctx = makeCtx(cwd, sessionFile, ctxState);
  await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
  await waitUntil(() => feDeps!.registry.list().length === 1, 8_000, "agent registered");
  const agentKey = feDeps!.registry.list()[0]!.agentKey;
  const cookie = await login(hub.httpPort, hub.paths.tokenFile);
  return {
    home: home.home,
    cwd,
    hub,
    feDeps: feDeps!,
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
  delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
  delete (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY];
  await e.hub.close("test-teardown").catch(() => undefined);
  e.restoreHome();
  rmSync(e.home, { recursive: true, force: true });
  rmSync(e.cwd, { recursive: true, force: true });
}

function cmdHeaders(e: Env): Record<string, string> {
  return { Cookie: e.cookie, Origin: `http://127.0.0.1:${e.hub.httpPort}` };
}

function cmdId(seed: string): string {
  return seed.padEnd(16, "0").slice(0, 32);
}

async function postCmd(e: Env, body: Record<string, unknown>) {
  return postJson(e.hub.httpPort, "/api/cmd", { agentKey: e.agentKey, ...body }, cmdHeaders(e));
}

/** Busy + armed: the minimal preconditions for `canHold` (link already live, hub has hold.v1). */
async function armBusy(e: Env): Promise<void> {
  e.ctxState.idle = false;
  await e.pi.fire("context", { type: "context" }, e.ctx);
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

async function holdOne(e: Env, id: string, text: string): Promise<void> {
  await armBusy(e);
  const res = await postCmd(e, { id, op: "prompt", text, deliver: "steer" });
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { op: "prompt", delivery: "held" } });
  expect(e.pi.sent).toHaveLength(0); // held, NOT dispatched
}

// ===========================================================================
// I1 — hold → recall returns the FULL text
// ===========================================================================
describe("web-hub steer-recall integration", () => {
  let env: Env | undefined;
  afterEach(async () => {
    if (env !== undefined) await teardown(env);
    env = undefined;
  });

  it("I1: busy web steer is held (zero sendUserMessage) and a recall returns the full text", async () => {
    env = await setup();
    const text = "recall me whole — ".repeat(20); // > HELD_CLIP_CHARS (200) on the wire
    await holdOne(env, cmdId("sr1"), text);
    const res = await postCmd(env, { id: cmdId("sr1r"), op: "recall", target: cmdId("sr1") });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", deliver: "steer", text },
    });
    expect(env.pi.sent).toHaveLength(0); // recall means it never reaches pi
  }, 15_000);

  it("I2: recall vs handoff race — turn_end hands #1 (too_late afterwards), #2 still recallable; dup replay is stable", async () => {
    env = await setup();
    await armBusy(env);
    await postCmd(env, { id: cmdId("i2a"), op: "prompt", text: "first out", deliver: "steer" });
    await postCmd(env, { id: cmdId("i2b"), op: "prompt", text: "second still held", deliver: "steer" });
    // The handoff hook: exactly ONE item per hook (I-SERIAL), confirm phase bounded ≤200 ms.
    await env.pi.fire(
      "turn_end",
      {
        type: "turn_end",
        turnIndex: 0,
        message: { role: "assistant", content: [] },
        toolResults: [],
        messageEntryId: "e1",
        toolResultEntryIds: [],
      },
      env.ctx,
    );
    expect(env.pi.sent.map((m) => m.text)).toEqual(["first out"]); // FIFO, one per hook

    const late = await postCmd(env, { id: cmdId("i2ar"), op: "recall", target: cmdId("i2a") });
    expect(JSON.parse(late.body)).toMatchObject({ ok: true, data: { outcome: "too_late" } }); // already handed
    const win = await postCmd(env, { id: cmdId("i2br"), op: "recall", target: cmdId("i2b") });
    expect(JSON.parse(win.body)).toMatchObject({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", text: "second still held" },
    });
    // The same recall id re-posted (dup window) replays the SAME result, including the text
    const dup = await postCmd(env, { id: cmdId("i2br"), op: "recall", target: cmdId("i2b") });
    expect(JSON.parse(dup.body).data).toEqual(JSON.parse(win.body).data); // dup:true rides beside, data identical
    expect(env.pi.sent).toHaveLength(1); // #2 never reached pi either way
  }, 15_000);

  it("I3: a NEW recall id for an already-recalled target is too_late (first verdict is final)", async () => {
    env = await setup();
    await holdOne(env, cmdId("i3"), "only once");
    await postCmd(env, { id: cmdId("i3r1"), op: "recall", target: cmdId("i3") });
    const second = await postCmd(env, { id: cmdId("i3r2"), op: "recall", target: cmdId("i3") });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toMatchObject({ ok: true, data: { outcome: "too_late" } });
  }, 15_000);

  it("I4: the browser's SSE status carries the held row, scoped by heldEpoch === the agent card's epoch (Y2)", async () => {
    env = await setup();
    const sse = await openBrowser(env);
    await holdOne(env, cmdId("i4"), "visible in the browser");
    const statusEv = await sse.waitFor(
      (ev) => ev.event === "status" && Array.isArray(ev.data.status?.held) && ev.data.status.held.length > 0,
      5_000,
    );
    const held = statusEv.data.status.held as Array<{ cmdId: string; state: string; sessionId: string }>;
    expect(held).toEqual([expect.objectContaining({ cmdId: cmdId("i4"), state: "held", sessionId: "sr-session" })]);
    expect(typeof statusEv.data.status.heldRev).toBe("number");
    const card = env.feDeps.registry.list()[0]!;
    expect(statusEv.data.status.heldEpoch).toBe(card.epoch); // MODULE_INSTANCE of the publishing activate()
    // recall via HTTP makes the row disappear from the live status stream
    await postCmd(env, { id: cmdId("i4r"), op: "recall", target: cmdId("i4") });
    // A5: an EMPTY buffer omits the field entirely (never `held: []`)
    await sse.waitFor(
      (ev) => ev.event === "status" && (ev.data.status?.held === undefined || ev.data.status.held.length === 0),
      5_000,
    );
  }, 15_000);

  it("I5: steerRecall:false ⇒ prompts go native, recall degrades to E_UNSUPPORTED, agent caps lack hold.v1", async () => {
    env = await setup({
      ...BASE_SETTINGS,
      webHub: { ...BASE_SETTINGS.webHub, steerRecall: false },
    });
    expect(env.feDeps.registry.getCaps(env.agentKey)).not.toContain("hold.v1"); // raw hello caps
    expect("hold" in env.feDeps.registry.list()[0]!).toBe(false); // AgentCard.hold absent (S3)
    env.ctxState.idle = true;
    const p = postCmd(env, { id: cmdId("i5"), op: "prompt", text: "native while off", deliver: "steer" });
    await waitUntil(() => env!.pi.sent.length === 1, 3_000, "sendUserMessage called");
    await env.pi.fire("input", { text: "native while off", source: "extension", streamingBehavior: "steer" }, env.ctx);
    const res = await p;
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, data: { op: "prompt", delivery: "observed" } });
    const recall = await postCmd(env, { id: cmdId("i5r"), op: "recall", target: cmdId("i5") });
    expect(recall.status).toBe(409);
    expect(JSON.parse(recall.body)).toMatchObject({ error: "E_UNSUPPORTED" });
  }, 15_000);

  it("RB2 shape: queryOnly recall returns the embedded typed result (the ledger is the authority when a reply is lost)", async () => {
    env = await setup();
    await holdOne(env, cmdId("rb2"), "query me again");
    await postCmd(env, { id: cmdId("rb2r"), op: "recall", target: cmdId("rb2") });
    // A browser that never saw the cmd_result (dropped reply / reconnect) re-asks with queryOnly
    const q = await postCmd(env, { id: cmdId("rb2r"), op: "recall", target: cmdId("rb2"), queryOnly: true });
    expect(q.status).toBe(200);
    const body = JSON.parse(q.body) as { ok: boolean; data?: { op: string; state: string; result?: unknown } };
    expect(body.ok).toBe(true);
    expect(body.data?.op).toBe("query");
    expect(body.data?.result).toMatchObject({
      ok: true,
      data: { op: "recall", outcome: "recalled", from: "held", text: "query me again" },
    });
  }, 15_000);

  it("I8: disconnect < 15 s — a freshly refreshed browser still sees the held row via the hub's slot replay (D3)", async () => {
    env = await setup();
    await holdOne(env, cmdId("i8"), "survives a refresh");
    // Drop the agent↔hub link WITHOUT removing the hub-side record: a handover bye keeps the
    // card (claiming) with its slots — exactly the crash/refresh shape D3's replay is for. The
    // agent side is now link-off: holdCap() false, the tick's grace window starts.
    currentConnection()?.close("handover");
    const refreshed = await openBrowser(env);
    // D3's replay channel for a FRESH browser is the `agents` snapshot: the hub keeps the agent's
    // last status slot on the card, so the refreshed tab sees the held row without any live push.
    const agentsEv = await refreshed.waitFor(
      (ev) =>
        ev.event === "agents" &&
        (ev.data.agents as Array<{ agentKey: string; status?: { held?: unknown[] } }>).some(
          (a) => a.agentKey === env!.agentKey && Array.isArray(a.status?.held) && a.status!.held!.length > 0,
        ),
      5_000,
    );
    const card = (agentsEv.data.agents as Array<{ agentKey: string; status?: { held?: unknown[] } }>).find(
      (a) => a.agentKey === env!.agentKey,
    )!;
    expect(card.status!.held).toEqual([expect.objectContaining({ cmdId: cmdId("i8"), state: "held" })]);
    expect(env.pi.sent).toHaveLength(0); // a refresh alone never hands anything out
  }, 15_000);

  it("disconnect ≥ 15 s: the tick hands the held item to pi exactly once; a re-attach publishes a held-less status", async () => {
    env = await setup();
    await holdOne(env, cmdId("i8b"), "handed out after the grace");
    currentConnection()?.close("test-drop");
    // HOLD_CAP_GRACE_MS = 15 s of 1 Hz ticks with a busy ctx ⇒ flush (one item per tick, I-SERIAL)
    await waitUntil(() => env!.pi.sent.length === 1, 25_000, "tick hand-out");
    expect(env.pi.sent.map((m) => m.text)).toEqual(["handed out after the grace"]);
    // Re-attach (same activate, new connection): the republished status carries no held row
    await env.pi.fire("session_start", { type: "session_start", reason: "startup" }, env.ctx);
    const sse = await openBrowser(env);
    const statusEv = await sse.waitFor((ev) => ev.event === "status" && ev.data.status?.leafId !== undefined, 5_000);
    expect(statusEv.data.status.held ?? []).toEqual([]);
  }, 40_000);

  it("prompt during the outage window never holds: 503 while the link is down, native once re-attached (W9 twin)", async () => {
    env = await setup();
    currentConnection()?.close("handover");
    env.ctxState.idle = true; // nothing armed, link down — whatever arrives must never be held
    const down = await postCmd(env, { id: cmdId("i9"), op: "prompt", text: "straight through", deliver: "steer" });
    expect(down.status).toBe(503); // E_AGENT_GONE — the hub cannot forward while the link is down
    expect(env.pi.sent).toHaveLength(0); // nothing was held or dispatched
    // re-attach (same activate): the browser's retry now goes NATIVE — never the hold buffer
    await env.pi.fire("session_start", { type: "session_start", reason: "startup" }, env.ctx);
    const retry = await postCmd(env, { id: cmdId("i9b"), op: "prompt", text: "straight through", deliver: "steer" });
    expect(JSON.parse(retry.body)).toMatchObject({ ok: true, data: { op: "prompt", delivery: "unobserved" } });
    expect(env.pi.sent.map((m) => m.text)).toEqual(["straight through"]);
    // hold is ON here — the retry went NATIVE (dispatched, unconfirmed), so a recall answers
    // too_late (it already reached pi), never "recalled": native messages are not recallable.
    const recall = await postCmd(env, { id: cmdId("i9r"), op: "recall", target: cmdId("i9b") });
    expect(recall.status).toBe(200);
    expect(JSON.parse(recall.body)).toMatchObject({ ok: true, data: { outcome: "too_late" } });
  }, 20_000);
});

// LAN surface: recall + hold over the LAN listener (needs node:sqlite + a reserved port).
describe("web-hub steer-recall LAN (I6)", () => {
  it.skipIf(NO_NODE_SQLITE)(
    "a held row recalls over the LAN auth surface with the same typed result",
    async () => {
      const { createServer: createNetServer } = await import("node:net");
      const freePort = async (): Promise<number> =>
        new Promise((resolve, reject) => {
          const srv = createNetServer();
          srv.once("error", reject);
          srv.listen(0, "0.0.0.0", () => {
            const addr = srv.address();
            const port = addr !== null && typeof addr === "object" ? addr.port : 0;
            srv.close(() => resolve(port));
          });
        });
      const { lanPostJson } = await import("../web-hub/http/lan-helpers.js");
      const { connectClient, hello } = await import("../web-hub/hub/helpers.js");
      const home = sandboxHome();
      const settingsPath = join(home.home, ".pi", "agent", "pi-subagent.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(BASE_SETTINGS) + "\n", "utf8");
      const lan: HubLanConfig = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
      let feDeps: FrontendDeps | undefined;
      const frontend: FrontendFactory = (d) => {
        feDeps = d;
        return createHttpFrontend(d);
      };
      const started = await startHub(hubConfig({ home: home.home, port: 0, lan }), frontend, {
        uid: process.getuid?.() ?? 0,
      });
      if ("exists" in started) throw new Error("unexpected hub singleton collision");
      const hub = started;
      try {
        await waitUntil(() => hub.lanStatus()?.state === "on", 8_000, "lan on");
        const lanPort = hub.lanStatus()!.port!;
        const host = `127.0.0.1:${lanPort}`;

        const pi = fakePi();
        activate(pi.pi);
        const ctxState: CtxState = { idle: false, pending: false };
        const ctx = makeCtx(home.home, join(home.home, "s.jsonl"), ctxState);
        await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
        await waitUntil(() => feDeps!.registry.list().length === 1, 8_000, "agent registered");
        const agentKey = feDeps!.registry.list()[0]!.agentKey; // captured BEFORE the admin client registers

        // admin socket (a second "agent" connection for admin ops): grab the initial LAN credentials
        const admin = await connectClient(hub.paths.socketPath);
        admin.send(
          hello({ agentId: { pid: process.pid, nonce: "srlanadminnonce00" }, epoch: "sr-lan", caps: ["lan.v1"] }),
        );
        await admin.waitFrame((f) => f["t"] === "hello_ack", 5_000);
        const rid = `t-${Math.random().toString(36).slice(2)}`;
        admin.send({ t: "lan_req", rid, op: "info" });
        const info = (await admin.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === rid, 5_000)) as unknown as {
          ok: boolean;
          info?: { username?: string; initialPassword?: string };
        };
        if (info.ok !== true || info.info?.initialPassword === undefined || info.info.username === undefined)
          throw new Error("lan info failed");
        const login = await lanPostJson(
          lanPort,
          "/api/login",
          { username: info.info.username, password: info.info.initialPassword },
          { Host: host },
        );
        expect(login.status).toBe(200);
        const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

        await pi.fire("context", { type: "context" }, ctx);
        const p = lanPostJson(
          lanPort,
          "/api/cmd",
          { agentKey, id: cmdId("i6"), op: "prompt", text: "lan recall", deliver: "steer" },
          { Cookie: cookie, Host: host, Origin: `http://${host}` },
        );
        const prompt = await p;
        expect(JSON.parse(prompt.body)).toMatchObject({ ok: true, data: { delivery: "held" } });
        const res = await lanPostJson(
          lanPort,
          "/api/cmd",
          { agentKey, id: cmdId("i6r"), op: "recall", target: cmdId("i6") },
          { Cookie: cookie, Host: host, Origin: `http://${host}` },
        );
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({
          ok: true,
          data: { op: "recall", outcome: "recalled", from: "held", text: "lan recall" },
        });
        await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      } finally {
        resetGlobals();
        delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
        delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
        delete (globalThis as Record<symbol, unknown>)[LEDGER_KEY];
        delete (globalThis as Record<symbol, unknown>)[HOLD_BAG_KEY];
        await hub.close("test-teardown").catch(() => undefined);
        home.restore();
        rmSync(home.home, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
