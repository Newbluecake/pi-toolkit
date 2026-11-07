/**
 * fabric-thread P4 (arch r3 §9.5): END-TO-END acceptance — a REAL hub child process (real
 * H1 feishu service, real requests/runs/outbox/state) × a FAKE Feishu (HTTP + pbbp2 websocket
 * fakes, the F10 seams) × a REAL agent stack in-process (real `buildSessionStack` with the
 * thread surface, real `wireWebHub` over the hub's real unix socket, real ThreadEngine) — only
 * the pi main session and the child-session processes are faked (scripted SessionHandle via the
 * `PiSessionDriver.prototype.create` spy, the ask-user-interrupt precedent).
 *
 * Scenario coverage (S-numbers = arch §9.5):
 *   S1   direct routing: 10 follow-ups ⇒ 0 main-session event turns (HARD), routed receipts,
 *        p95 frame→steer-settle ≤ 500 ms, + S8 state-file parse through the UNMODIFIED parser.
 *   S1′  the OFF control group: same script, threads off ⇒ 10 main-session event turns
 *        (the benefit measurement: turn counts + delivered context bytes).
 *   S2   worker startup failure ⇒ every buffered event auto-returns EXACTLY once (bypass ⇒
 *        main session), each re-delivery is a fresh prompt with the host note line.
 *   S3   steer timeout ⇒ Outcome unknown, NO fallback, NO auto-return, receipt stays routed.
 *   S3b  `handled` disposition + a side-effect marker ⇒ unknown, no fallback, marker ONCE.
 *   S4   explicit handback via the REAL child tool ⇒ ONE main turn, dup on the identical retry.
 *   S4b③ two co-subscribers hand the same event back ⇒ ONE successor, identical requestId.
 *   S5   A queued + B startup-failed ⇒ NO auto-return, exactly one display line.
 *   S6   /main and addressed_other (@other) reach the main session, never the subscriber.
 *   S7   G2b: old-hub × new-agent vs new-hub × old-agent — cmd.prompt frames identical except
 *        the (absent) `thread` field; new × new carries it.
 *   S9   a connection gap BEFORE the routed result ⇒ accepted{thr:routed}, no unattributed.
 *   S11  lane over budget: the hanging steer keeps the lane busy; the queued event goes native
 *        at its own deadlineAt; the hung event settles unknown ⇒ routed.
 *   S12  (stack-level, real engine + real steer port): deadlineMs 1500/1900 ⇒ R6 native with
 *        ZERO steer calls. The real-hub admission hardcodes deadlineMs=8000 (service wiring),
 *        so the frame-level variant is driven through the same ThreadPromptPort the live
 *        command handler calls — the cross-layer seam P4 owns.
 *
 * Hub-internal fault races (S4b①②④ commit-failure/revocation, S9 plain-ok/fallback variants,
 * S10 slow-commit, S2's post-retention GONE) need in-process hub fault injection and stay at
 * tests/web-hub/hub/feishu/thread-*.test.ts (unit) — the E2E covers every CROSS-process seam.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { PiSessionDriver, type SessionHandle } from "../../src/runtime/session-driver.js";
import { wireWebHub, type WebHubControl } from "../../src/web-hub/agent/index.js";
import { currentConnection, releaseConnection } from "../../src/web-hub/agent/connection.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { THREAD_CAP } from "../../src/web-hub/protocol/version.js";
import { createFeishuState } from "../../src/web-hub/hub/feishu/state.js";
import { createThreadChildTool } from "../../src/tools/thread-child-tool.js";
import { messageEnvelope } from "../fixtures/feishu/f6.js";
import { resetGlobals } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const here = dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------- hub child (F10 seams)

const CHILD = String.raw`
const root = process.cwd();
const load = (p) => import(root + "/" + p);
const { startHub } = await load("src/web-hub/hub/hub.ts");
const { createHttpFrontend } = await load("src/web-hub/hub/http.ts");const { createCredentialStore } = await load("src/web-hub/hub/feishu/credentials.ts");
const { resolveHubPaths } = await load("src/web-hub/protocol/paths.ts");
const { normalizeFeishuBotHubConfig } = await load("src/web-hub/protocol/feishu.ts");
const { encodeFrame, decodeFrame, header } = await load("src/web-hub/hub/feishu/frame.ts");
const { createFakeFeishu } = await load("tests/fixtures/feishu/fake-http.ts");
const { createFakeWsServer } = await load("tests/fixtures/feishu/fake-ws-server.ts");
const cfg = JSON.parse(process.env.FT_CONFIG);
const paths = resolveHubPaths({home: cfg.home, uid: process.getuid?.() ?? 0});
const fake = createFakeFeishu({appId: "cli_test"});
fake.on("POST", "/callback/ws/endpoint", () => ({json: {code: 0, data: {
  URL: "wss://msg-frontier.feishu.cn/ws?service_id=33&device_id=ft-device", ClientConfig: {
    PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0
  }
}}}));
const ws = await createFakeWsServer();
if (cfg.feishuBot) {
  cfg.feishuBot = normalizeFeishuBotHubConfig(cfg.feishuBot);
  const store = createCredentialStore({dir: paths.stateDir + "/feishu-bot"});
  await store.load();
  if (!store.current()) {
    const saved = await store.commit({brand: "feishu", appId: fake.appId,
      appSecret: fake.appSecret, ownerOpenId: "ou_owner", botOpenId: "ou_bot"});
    if (!saved.ok) throw new Error("fixture credentials: " + saved.reason);
  }
}
let __registry;
const hub = await startHub(cfg, (deps) => { __registry = deps.registry; return createHttpFrontend(deps); }, {feishuSeams: {
  fetch: fake.fetch,
  webSocket: () => new WebSocket(ws.url)
}});
if ("exists" in hub) throw new Error("unexpected existing hub");
let wireSeq = 0;
const reply = (id, value) => process.send?.({id, value});
process.on("message", async (m) => {
  try {
    if (m.op === "send") {
      const peer = ws.peers.filter(p => !p.closed).at(-1);
      if (!peer) throw new Error("fake ws not connected");
      peer.send(encodeFrame({seqId: BigInt(++wireSeq), logId: 2n, service: 33, method: 1,
        headers: [{key:"type",value:"event"},{key:"message_id",value:"wire-"+wireSeq},
          {key:"sum",value:"1"},{key:"seq",value:"0"}],
        payloadEncoding:"", payload: Buffer.from(JSON.stringify(m.raw))}));
      reply(m.id, true);
    } else if (m.op === "regs") {
      const rows = (__registry?.list?.() ?? []).map((a) => ({
        key: String(a.agentKey).slice(0, 10), connected: __registry.isConnected(a.agentKey),
        sid: a.session?.sessionId?.slice(0, 8), detached: a.detached === true,
      }));
      reply(m.id, rows);
    } else if (m.op === "inspect") {
      reply(m.id, {sent: fake.sent, calls: fake.calls.map(({signal, ...c}) => c),
        livePeers: ws.peers.filter(p => !p.closed).length, caps: hub.info.caps,
        wsIn: ws.peers.reduce((n, p) => n + (p.received?.length ?? 0), 0),
        peers: ws.peers.map(p => ({closed: p.closed, got: p.received?.length ?? 0}))});
    } else if (m.op === "stop") {
      await hub.close("test"); await ws.dispose(); reply(m.id, true); process.disconnect();
    } else throw new Error("unknown fixture op");
  } catch (e) { process.send?.({id: m.id, error: String(e)}); }
});
process.send?.({ready: true, caps: hub.info.caps});
`;

interface Inspection {
  sent: Array<{ messageId: string; kind: string; body: Record<string, unknown> }>;
  calls: Array<{ method: string; path: string; json?: Record<string, unknown> }>;
  livePeers: number;
  caps: string[];
  wsIn: number;
}

const homes = new Set<string>();
const dirs: string[] = [];
const children = new Set<ChildProcess>();
const stacks: Array<() => void> = [];
const driverSpies: Array<() => void> = [];

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(async () => {
  for (const dispose of stacks.splice(0)) dispose();
  for (const restore of driverSpies.splice(0)) restore();
  resetGlobals();
  for (const child of children) {
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
  }
  children.clear();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 30_000);

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, label: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Real hub child × fake Feishu. `threads` ⇔ `feishuBot.threads` (the P2 hub-side gate). */
async function bootHub(options: { threads?: boolean; home?: string } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "pwh-ft-"));
  homes.add(home);
  mkdirSync(join(home, "project"), { recursive: true });
  const cfg = {
    v: 1,
    home,
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "0.0.0-ft",
    buildId: "ft-build",
    feishuBot: {
      allowGroups: true,
      groupRootTopics: true,
      notify: "bound",
      spawnScope: "known",
      debounceMs: 0,
      staleMessageS: 300,
      files: { outbound: "auto", inbound: false, maxInboundMiB: 30 },
      ...(options.threads === false
        ? {}
        : {
            threads: {
              handbackWindowMin: 10,
              startTimeoutMin: 8,
              retainMin: 15,
              replyPerThreadPerMin: 60,
              replyPerThreadPerHour: 600,
            },
          }),
    },
  };
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: "", FT_CONFIG: JSON.stringify(cfg) },
  });
  children.add(child);
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  let rid = 0;
  const rpc = <T>(op: string, arg?: unknown, ms = 15_000): Promise<T> =>
    new Promise<T>((res, rej) => {
      const id = ++rid;
      const timer = setTimeout(() => {
        child.off("message", onMsg);
        rej(new Error(`rpc ${op} timeout`));
      }, ms);
      timer.unref?.();
      const onMsg = (m: { id: number; value?: T; error?: string }) => {
        if (m.id !== id) return;
        clearTimeout(timer);
        child.off("message", onMsg);
        m.error !== undefined ? rej(new Error(m.error)) : res(m.value as T);
      };
      child.on("message", onMsg);
      child.send({ id, op, ...(arg === undefined ? {} : { raw: arg }) }, (e) => {
        if (e) {
          clearTimeout(timer);
          child.off("message", onMsg);
          rej(e);
        }
      });
    });
  // ONE persistent listener flips a flag — never await a per-poll listener promise (it may never
  // resolve) and never leak listeners across polls.
  const readyState = { ready: false, closed: false };
  child.on("message", (m: { ready?: boolean }) => {
    if (m?.ready === true) readyState.ready = true;
  });
  child.once("close", () => (readyState.closed = true));
  await until(
    () => readyState,
    (s) => s.ready || s.closed,
    `hub child ${readyState.closed ? `exited: ${stderr}` : "ready"}`,
    30_000,
  );
  expect(readyState.ready, `hub child failed to start: ${stderr}`).toBe(true);
  const inspect = () => rpc<Inspection>("inspect");
  await until(inspect, (s) => s.livePeers === 1, "feishu websocket open", 20_000);
  const paths = resolveHubPaths({ home, uid: process.getuid() ?? 0, xdgRuntimeDir: undefined });
  const disk = () =>
    JSON.parse(readFileSync(join(paths.stateDir, "feishu-bot/state.json"), "utf8")) as {
      requests: Record<string, { state: string; code?: string; payload?: { body?: string } }>;
      bindings: Record<string, unknown>;
    };
  let mid = 0;
  const runTag = process.hrtime.bigint().toString(36); // unique per boot ⇒ unique fs cmdIds across tests
  const topic = (text: string, threadId = "tt1") =>
    rpc(
      "send",
      messageEnvelope(`${runTag}-${++mid}`, text, {
        chatType: "group",
        threadId,
        mentions: true, // group messages reach the bot only when mentioned (the FB3 fixture posture)
        createdAt: String(Date.now()),
      }),
    );
  const regs = () => rpc<Array<{ key: string; connected: boolean; sid?: string; detached: boolean }>>("regs");
  const stop = async () => {
    if (!child.connected) return;
    await rpc("stop").catch(() => undefined);
  };
  return { home, paths, inspect, disk, topic, stop, regs, stderr: () => stderr };
}

// ----------------------------------------------------------------- fake pi + real stack

interface SentMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: { source?: string };
}

interface FakePi {
  pi: ExtensionAPI;
  fire(ev: string, event: unknown, ctx: unknown): void;
  emit(ev: string, event: unknown): void;
  sentMessages: SentMessage[];
  sentUserMessages: Array<{ text: string }>;
  registeredTools: string[];
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const eventHandlers = new Map<string, Array<(event: unknown) => void>>();
  const state: FakePi = {
    sentMessages: [],
    sentUserMessages: [],
    registeredTools: [],
    fire(ev, event, ctx) {
      for (const h of handlers.get(ev) ?? []) h(event, ctx);
    },
    emit(ev, event) {
      for (const h of eventHandlers.get(ev) ?? []) h(event);
    },
    pi: {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        return () =>
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((h) => h !== handler),
          );
      },
      registerTool(t: { name: string }) {
        state.registeredTools.push(t.name);
      },
      registerCommand() {},
      registerEntryRenderer() {},
      sendMessage(message: SentMessage) {
        state.sentMessages.push(message);
      },
      // The REAL pi fires the `input` event synchronously from sendUserMessage — mirror that so
      // the native-path HTTP reply settles `observed` immediately (no 3 s timers per prompt).
      sendUserMessage(text: string) {
        state.sentUserMessages.push({ text });
        state.fire("input", { text, source: "extension" }, undefined);
      },
      appendEntry() {},
      getCommands() {
        return [];
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
      events: {
        on(event: string, handler: (event: unknown) => void) {
          eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
          return () =>
            eventHandlers.set(
              event,
              (eventHandlers.get(event) ?? []).filter((h) => h !== handler),
            );
        },
        emit(event: string, payload: unknown) {
          state.emit(event, payload);
        },
      },
    } as unknown as ExtensionAPI,
  };
  return state;
}

const workerType = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" as const };
const types = {
  get: () => workerType,
  list: () => [workerType],
  reload: async () => ({ types: [workerType], errors: [] }),
  configHashOf: () => undefined,
} as unknown as AgentTypeRegistry;

function threadSettings(over: Record<string, unknown> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    fabric: {
      ...DEFAULT_SETTINGS.fabric,
      enabled: true,
      wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: false },
      threads: { ...DEFAULT_SETTINGS.fabric.threads, enabled: true, ...over },
    },
  } as AgentSettings;
}

export interface ScriptedHandle {
  handle: SessionHandle;
  steered: string[];
  steerTimings: Array<{ start: number; settled?: number }>;
  /** Live count — exposed as a getter (a plain spread would snapshot 0). */
  readonly markerCalls: number;
  /** Resolve the OLDEST hanging steer disposition (mode "hang"). */
  settle(value: string): void;
}

/** Set by bootAgent's bind spy; scripted handles emit their lifecycle events through it so
 *  the runner's phase machine advances exactly like a real child session. */
let currentDriverEvents: ((e: { t: string }) => void) | undefined;

/** A scripted child-session handle: `prompt` stays pending (run keeps running), the steer
 *  channels are test-controlled. Created handles queue up in creation order = spawn order. */
function makeScriptedHandle(opts: { disposition?: string | "hang" } = {}): ScriptedHandle {
  const steered: string[] = [];
  const steerTimings: Array<{ start: number; settled?: number }> = [];
  const hanging: Array<(v: string) => void> = [];
  let markerCount = 0;
  const markSettled = () => {
    const last = steerTimings[steerTimings.length - 1];
    if (last !== undefined && last.settled === undefined) last.settled = Date.now();
  };
  const handle: SessionHandle = {
    sessionId: "ft-child",
    sessionFile: undefined,
    prompt: () => {
      // a real child fires input_accepted + turn_start when the prompt lands — into THIS run's
      // driver callback (assigned by bootAgent's bind spy)
      const emit = () => {
        const cb = (handle as { __ftEvents?: (e: { t: string }) => void }).__ftEvents ?? currentDriverEvents;
        cb?.({ t: "input_accepted" });
        cb?.({ t: "turn_start" });
      };
      setTimeout(emit, 0);
      return new Promise<void>(() => undefined); // never settles ⇒ run stays running
    },
    steer: async (text: string) => {
      steered.push(text);
    },
    steerDisposition: (text: string) => {
      steered.push(text);
      steerTimings.push({ start: Date.now() });
      if (opts.disposition === "hang") {
        return new Promise<string>((resolve) => {
          hanging.push((v: string) => {
            markSettled();
            resolve(v);
          });
        });
      }
      markSettled();
      if (opts.disposition === "handled-side-effect") {
        markerCount += 1;
        return Promise.resolve("handled");
      }
      if (opts.disposition === "reject") return Promise.reject(new Error("injection failed"));
      return Promise.resolve(opts.disposition ?? "queued");
    },
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools() {},
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
  } as SessionHandle;
  return {
    handle,
    steered,
    steerTimings,
    get markerCalls() {
      return markerCount;
    },
    settle(value: string) {
      hanging.shift()?.(value);
    },
  };
}

interface AgentHarness {
  pi: FakePi;
  stack: Stack;
  webHub: WebHubControl;
  ctx: ExtensionContext;
  mainTurns(): number;
  mainBytes(): number;
  displays(): SentMessage[];
  reports(): SentMessage[];
  spawnWorker(label?: string, handle?: ScriptedHandle): Promise<{ runId: string; handle: ScriptedHandle }>;
  /** S2/S5: gate the driver so spawned runs stay `starting` (the buffering window). */
  holdSpawns(): void;
  /** Release the gate; with `fail` every pending+future create throws (startup failure). */
  releaseSpawns(fail?: Error): void;
  waitLive(): Promise<void>;
  conn(): { caps: string[]; status(): { state: string } } | undefined;
  sockets: net.Socket[];
  cmdFrames(): Array<Record<string, unknown>>;
  dispose(): void;
}

async function bootAgent(
  hub: Awaited<ReturnType<typeof bootHub>>,
  options: { threadsOn?: boolean; steerTimeoutMs?: number } = {},
): Promise<AgentHarness> {
  const threadsOn = options.threadsOn !== false;
  const sandbox = sandboxHome();
  homes.add(sandbox.home);
  const settings = threadsOn
    ? threadSettings(options.steerTimeoutMs === undefined ? {} : { steerTimeoutMs: options.steerTimeoutMs })
    : ({ ...DEFAULT_SETTINGS, fleetWidget: false } as AgentSettings);
  const piState = fakePi();
  const sm = SessionManager.inMemory(process.cwd());
  // The hub-side binding targets the session id the agent REGISTERS (`sessionInfo` reads
  // `ctx.sessionManager.getSessionId()`), so pin it on the manager view, not just on ctx.
  const sessionManager = Object.create(sm) as typeof sm;
  (sessionManager as unknown as { getSessionId: () => string }).getSessionId = () => "sess-ft-main";
  const ctx = {
    sessionManager,
    getLeafId: () => "e1",
    getBranch: () => [],
    getSessionId: () => "sess-ft-main",
    getSessionFile: () => "/tmp/ft-session.jsonl",
    getSessionName: () => undefined,
    cwd: process.cwd(),
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    mode: "tui",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {},
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
  } as unknown as ExtensionContext;

  // Scripted driver: handles are handed out FIFO (spawn order). A gated create keeps the run
  // in `starting` (the buffering window, §6.5); rejecting it is the S2/S5 startup failure.
  const pending: Array<ScriptedHandle | Error> = [];
  const liveHandles: ScriptedHandle[] = [];
  /** S2/S5 spawn gating: while armed, driver `create` awaits the gate promise (runs stay
   *  `starting` — the §6.5 buffering window); `releaseSpawns(err)` opens it and can arm a
   *  permanent failure for pending+future creates (the startup-failure case). */
  const spawnGate: {
    current?: Promise<void>;
    open?: () => void;
    fail?: Error;
  } = {};
  const spy = vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async () => {
    if (spawnGate.current !== undefined) await spawnGate.current;
    if (spawnGate.fail !== undefined) throw spawnGate.fail;
    const next = pending.shift();
    if (next === undefined) throw new Error("no scripted handle");
    if (next instanceof Error) throw next;
    liveHandles.push(next);
    return next.handle as never;
  });
  vi.spyOn(PiSessionDriver.prototype, "bind").mockImplementation(async (h: unknown, cb: unknown) => {
    // per-run: the handle's own prompt events flow into ITS run's callback (a global "latest"
    // would misroute the first of two concurrent runs — found by S4b③)
    (h as { __ftEvents?: unknown }).__ftEvents = cb;
    currentDriverEvents = cb as (e: { t: string }) => void;
  });
  driverSpies.push(() => spy.mockRestore());

  let stackRef: { current?: Stack } = {};
  const sockets: net.Socket[] = [];
  /** Agent-received NDJSON frames, teed off the real socket (S7's G2b comparison). */
  const frames: Array<Record<string, unknown>> = [];
  let teeBuf = "";
  const realConnect = net.connect;
  const netConnect = ((...args: unknown[]) => {
    const sock = realConnect(...(args as never));
    sockets.push(sock);
    sock.on("data", (chunk: Buffer) => {
      teeBuf += chunk.toString("utf8");
      let nl = teeBuf.indexOf("\n");
      while (nl >= 0) {
        const line = teeBuf.slice(0, nl);
        teeBuf = teeBuf.slice(nl + 1);
        if (line.trim() !== "") {
          try {
            frames.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            /* partial line at chunk boundary — next chunk completes it */
          }
        }
        nl = teeBuf.indexOf("\n");
      }
    });
    return sock;
  }) as typeof net.connect;

  const threadInput = threadsOn
    ? {
        replySink: () => webHubRef.current?.threadSink,
        conn: () => currentConnection(),
      }
    : undefined;
  const stack = buildSessionStack(
    piState.pi,
    ctx,
    settings,
    types,
    [],
    "startup",
    undefined,
    undefined,
    {},
    undefined,
    threadInput,
  );
  stackRef.current = stack;

  const webHubRef: { current?: WebHubControl } = {};
  const webHub = wireWebHub(piState.pi, {
    settings: { enabled: true, autoStart: false, port: 0, idleExitMinutes: 10, nodeLoader: "" },
    fleet: () => stackRef.current?.query.list() ?? [],
    query: () => stackRef.current?.query,
    env: { HOME: sandbox.home },
    paths: hub.paths,
    buildInfo: async () => ({ pluginVersion: "0.0.0-ft", buildId: "ft-build" }),
    argv1: process.argv[1] ?? "pi",
    netConnect,
    now: () => Date.now(),
    mention: () => {
      const s = stackRef.current;
      return s === undefined ? undefined : { registry: s.mention, query: s.query, spawn: s.spawn };
    },
    ...(threadsOn
      ? {
          threads: () => stackRef.current?.threads,
          threadsCapOn: () => true,
          threadsHubConfig: () => ({
            handbackWindowMin: 10,
            startTimeoutMin: 8,
            retainMin: 15,
            replyPerThreadPerMin: 60,
            replyPerThreadPerHour: 600,
          }),
        }
      : {}),
  });
  webHubRef.current = webHub;
  piState.fire("session_start", { reason: "startup" }, ctx);

  const mainTexts = () => piState.sentUserMessages.filter((m) => m.text.startsWith("[飞书"));
  const harness: AgentHarness = {
    pi: piState,
    stack,
    webHub,
    ctx,
    mainTurns: () => mainTexts().length,
    mainBytes: () => mainTexts().reduce((n, m) => n + Buffer.byteLength(m.text, "utf8"), 0),
    displays: () => piState.sentMessages.filter((m) => m.display === true && m.customType === "subagent:thread"),
    reports: () => piState.sentMessages.filter((m) => m.display !== true && m.customType === "subagent:thread"),
    holdSpawns() {
      if (spawnGate.current === undefined) spawnGate.current = new Promise<void>((r) => (spawnGate.open = r));
    },
    releaseSpawns(fail) {
      if (fail !== undefined) spawnGate.fail = fail;
      spawnGate.current = undefined;
      spawnGate.open?.();
    },
    async spawnWorker(label, handle) {
      const scripted = handle ?? makeScriptedHandle();
      pending.push(scripted);
      const out = await stack.spawn.spawn({
        type: "worker",
        prompt: `work ${Date.now()}`,
        ...(label === undefined ? {} : { label }),
      });
      if ("error" in out) throw new Error(out.error.message);
      return { runId: out.runId, handle: scripted };
    },
    async waitLive() {
      await until(
        () => harness.conn()?.status().state,
        (s) => s === "live",
        "agent hub link live",
        20_000,
      );
    },
    conn: () => currentConnection(),
    sockets,
    cmdFrames: () => frames.filter((f) => f.t === "cmd"),
    dispose() {
      try {
        releaseConnection(currentConnection(), "test");
      } catch {
        /* already released */
      }
      stack.threads?.dispose();
      stack.fabric?.dispose();
      stack.bashJobs?.dispose();
      stack.keepalive?.dispose();
      stack.quota?.dispose();
    },
  };
  return harness;
}

/** Bind the group topic and push ONE (native) event through — the origin bookkeeping then
 *  knows the thread handle. `withOrigin:false` for cap-less agents (no thread meta at all). */
async function bindTopic(hub: Awaited<ReturnType<typeof bootHub>>, agent: AgentHarness) {
  const before = (await hub.inspect()).sent.length;
  await hub.topic("/use sess-ft-main");
  await until(
    async () => (await hub.inspect()).sent.slice(before),
    (s) => s.some((m) => String(m.body.content).includes("已绑定")),
    "topic bound",
  ).catch(async (e) => {
    const s = await hub.inspect();
    // eslint-disable-next-line no-console
    console.log(
      `[bind] wsIn=${s.wsIn} receipts=${s.sent
        .slice(before)
        .map((m) => String(m.body.content))
        .join(";;")}`,
    );
    throw e;
  });
  const turns0 = agent.mainTurns();
  await hub.topic("prime the thread");
  await until(
    () => agent.mainTurns(),
    (n) => n === turns0 + 1,
    "prime event hit the main session",
  ).catch(async (e) => {
    // eslint-disable-next-line no-console
    console.log(
      `[prime] turns=${agent.mainTurns()} cmdFrames=${agent.cmdFrames().length} conn=${agent.conn()?.status().state} reqs=${JSON.stringify(Object.values(hub.disk().requests).map((r) => ({ s: r.state, c: r.code })))}`,
    );
    throw e;
  });
}

async function primeTopic(hub: Awaited<ReturnType<typeof bootHub>>, agent: AgentHarness) {
  await bindTopic(hub, agent);
  const origins = agent.stack.threads!.origins();
  expect(origins).toHaveLength(1);
  return origins[0]!;
}

// ----------------------------------------------------------------- scenarios

describe("fabric-thread P4 E2E (arch §9.5)", () => {
  it(
    "S1: 10 follow-ups on one subscribed worker ⇒ 0 main-session event turns, routed receipts, p95 ≤ 500 ms (+S8 parse)",
    { timeout: 90_000 },
    async () => {
      const hub = await bootHub();
      const agent = await bootAgent(hub);
      await agent.waitLive();
      expect(agent.conn()!.caps).toContain(THREAD_CAP);
      const origin = await primeTopic(hub, agent);
      const { runId, handle } = await agent.spawnWorker("w1");
      await until(
        () => agent.stack.query.get(runId)?.status,
        (s) => s === "running",
        "worker running",
      );
      const sub = agent.stack.threads!.subscribe({
        run: runId,
        h: origin.h,
        scope: "follow-ups",
        origin: false,
        createdBy: "root",
      });
      expect(sub).toMatchObject({ ok: true });

      const turns0 = agent.mainTurns();
      const N = 10;
      // paced ~150 ms apart — a tight burst trips the hub's shared per-principal cmd limiter
      // (E_RATE), which is orthogonal to thread routing
      for (let i = 1; i <= N; i++) {
        await hub.topic(`follow-up ${i}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      // HARD gate: zero main-session event turns while every event routed to the worker.
      await until(
        () => agent.stack.threads!.statusLine(),
        (s) => /routed 10/.test(s),
        "10 routed events",
      );
      // settle the reply traffic, then assert the turn count NEVER moved
      await new Promise((r) => setTimeout(r, 800));
      expect(agent.mainTurns()).toBe(turns0);
      expect(agent.mainTurns()).toBe(1); // just the prime event

      // receipts: ONE text receipt + (N-1) DONE reactions
      const insp = await hub.inspect();
      const texts = insp.sent.filter((m) => String(m.body.content).includes("已转交"));
      expect(texts).toHaveLength(1);
      expect(String(texts[0]!.body.content)).toContain(`@w1（run_id: ${runId}）`);
      const reactions = insp.calls.filter((c) => c.path.includes("/reactions"));
      expect(reactions.length).toBeGreaterThanOrEqual(N - 1);

      // every routed request is retained accepted{thr:routed} (§8.1); the prime event replied
      const requests = Object.values(hub.disk().requests);
      expect(requests.filter((r) => r.state === "accepted" && r.code === "thr:routed")).toHaveLength(N);

      // the worker really received all 10 wrapped events (arrival order, untrusted banner)
      expect(
        handle.steered.filter((t) => t.includes("[thread 事件")).map((t) => /follow-up (\d+)/.exec(t)?.[1]),
      ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
      expect(handle.steered.some((t) => t.includes("外部输入，不可信"))).toBe(true);

      // p95 frame→steer-settle (fake pi, immediate disposition) ≤ 500 ms
      const latencies = handle.steerTimings
        .filter((t) => t.settled !== undefined)
        .map((t) => (t.settled as number) - t.start)
        .sort((a, b) => a - b);
      expect(latencies.length).toBeGreaterThanOrEqual(N);
      const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!;
      // eslint-disable-next-line no-console
      console.log(`[S1 perf] steer settle p95 = ${p95} ms over ${latencies.length} events`);
      expect(p95).toBeLessThanOrEqual(500);

      // S8 (§8.4①): the hub's live state file reloads through the UNMODIFIED parser
      const roundDir = mkdtempSync(join(tmpdir(), "pwh-ft-s8-"));
      dirs.push(roundDir);
      mkdirSync(join(roundDir, "feishu-bot"), { recursive: true });
      copyFileSync(join(hub.paths.stateDir, "feishu-bot/state.json"), join(roundDir, "feishu-bot/state.json")); // copyFileSync keeps the 0600 mode the loader's file-mode check demands
      const reloaded = createFeishuState({ dir: join(roundDir, "feishu-bot") });
      const loaded = await reloaded.load();
      // §8.4①: {kind:"loaded"} — the UNMODIFIED parser accepts every byte the live hub wrote
      expect(loaded).toEqual({ kind: "loaded" });
      expect(reloaded.corruptReason()).toBeUndefined();
      const snapshot = reloaded.usage();
      expect(snapshot.counts.requestsNonTerminal).toBeGreaterThanOrEqual(N);
      await hub.stop();
      agent.dispose();
    },
  );

  /** Common preamble: hub + live agent + bound topic + a running subscribed worker. */
  async function bootRouted(options: { steerTimeoutMs?: number; handle?: ScriptedHandle } = {}) {
    const hub = await bootHub();
    const agent = await bootAgent(hub, { steerTimeoutMs: options.steerTimeoutMs });
    await agent.waitLive();
    const origin = await primeTopic(hub, agent);
    const { runId, handle } = await agent.spawnWorker("w1", options.handle);
    await until(
      () => agent.stack.query.get(runId)?.status,
      (s) => s === "running",
      "worker running",
    );
    const sub = agent.stack.threads!.subscribe({
      run: runId,
      h: origin.h,
      scope: "follow-ups",
      origin: false,
      createdBy: "root",
    });
    expect(sub).toMatchObject({ ok: true });
    return { hub, agent, origin, runId, handle };
  }

  const waitRouted = (agent: AgentHarness, n: number) =>
    until(
      () => agent.stack.threads!.statusLine(),
      (s) => new RegExp(`routed ${n}\\b`).test(s),
      `${n} routed events`,
    );

  it(
    "S1′ (OFF control + benefit measurement): the same script with threads off ⇒ one main-session turn per event",
    { timeout: 90_000 },
    async () => {
      const hub = await bootHub(); // hub still threads-on (it must not matter while the agent is off)
      const agent = await bootAgent(hub, { threadsOn: false });
      await agent.waitLive();
      // the HUB still advertises thr.v1 (its feishuBot.threads exists) — the G2b point is that
      // the CAP-less agent's business frames carry no thread field at all (asserted below)
      // no thread surface at all while off (G2a)
      expect(agent.stack.threads).toBeUndefined();
      const before = (await hub.inspect()).sent.length;
      await hub.topic("/use sess-ft-main");
      await until(
        async () => (await hub.inspect()).sent.slice(before),
        (s) => s.some((m) => String(m.body.content).includes("已绑定")),
        "topic bound",
      );
      const N = 5;
      for (let i = 1; i <= N; i++) {
        await hub.topic(`follow-up ${i}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      await until(
        () => agent.mainTurns(),
        (n) => n === N,
        `${N} main-session event turns`,
      );
      const bytes = agent.mainBytes();
      // the benefit line for the acceptance report: turns + delivered context bytes vs S1's 0/0
      // eslint-disable-next-line no-console
      console.log(
        `[benefit] off: turns=${agent.mainTurns()} bytes=${bytes} | on (S1): turns=0 bytes=0 — every routed event's wrapper goes to the worker instead`,
      );
      expect(agent.mainTurns()).toBe(N);
      expect(bytes).toBeGreaterThan(0);
      // and every request settles the ordinary slow-path way (no thr:routed retention)
      const routed = Object.values(hub.disk().requests).filter((r) => r.code === "thr:routed");
      expect(routed).toHaveLength(0);
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S2: worker startup failure ⇒ every buffered event auto-returns EXACTLY once via bypass re-delivery",
    { timeout: 90_000 },
    async () => {
      const hub = await bootHub();
      const agent = await bootAgent(hub);
      await agent.waitLive();
      const origin = await primeTopic(hub, agent);
      // gated spawn: the run stays `starting` while the subscription buffers (§6.5)
      agent.holdSpawns();
      const handle = makeScriptedHandle();
      const spawnP = agent.spawnWorker("w1", handle);
      const { runId } = await spawnP;
      const N = 3;
      await until(
        () => agent.stack.query.get(runId)?.status,
        (s) => s === "starting",
        "run starting",
      );
      const sub = agent.stack.threads!.subscribe({
        run: runId,
        h: origin.h,
        scope: "follow-ups",
        origin: false,
        createdBy: "root",
      });
      expect(sub).toMatchObject({ ok: true });
      for (let i = 1; i <= N; i++) {
        await hub.topic(`buffered ${i}`);
        await new Promise((r) => setTimeout(r, 150));
      }
      // §6.7: the routed first-reply for buffered outcomes leaves at each event's own
      // deadlineAt (≈ steerTimeoutMs 4 s). Only AFTER that does the hub hold the payloads as
      // accepted{thr:routed} — failing the run earlier would make the all-none aggregate fall
      // back NATIVE instead (also correct, but S2 pins the auto-return path). Wait past it:
      await new Promise((r) => setTimeout(r, 4_600));
      // events are buffered (no steer yet) — now the startup fails
      agent.releaseSpawns(new Error("startup failed"));
      await until(
        () => agent.stack.query.get(runId)?.status,
        (s) => ["failed", "aborted", "timed_out"].includes(s as string),
        "run terminal after startup failure",
      );
      // §6.7: all subscribers none ⇒ system auto-return per event ⇒ bypass re-delivery to main
      await until(
        () => agent.mainTurns(),
        (n) => n >= 1 + N,
        `${N} re-delivered events hit the main session`,
      );
      const texts = agent.pi.sentUserMessages.filter((m) => m.text.includes("[thread handback"));
      expect(texts.map((t) => /buffered (\d+)/.exec(t.text)?.[1])).toEqual(["1", "2", "3"]);
      // exactly once per event
      expect(texts).toHaveLength(N);
      expect(agent.mainTurns()).toBe(1 + N);
      // each auto-return finalized its source as replied{thread-handback} at the hub
      const handbacks = Object.values(hub.disk().requests).filter((r) => r.code === "thread-handback");
      expect(handbacks).toHaveLength(N);
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S3: steer injection timeout/reject ⇒ Outcome unknown, NO fallback, NO auto-return, receipt stays routed",
    { timeout: 60_000 },
    async () => {
      const { hub, agent, origin, handle } = await bootRouted({
        handle: makeScriptedHandle({ disposition: "reject" }),
        steerTimeoutMs: 800,
      });
      const turns0 = agent.mainTurns();
      await hub.topic("inject me");
      await waitRouted(agent, 1);
      await new Promise((r) => setTimeout(r, 500));
      // §6.4: post-call failure ⇒ unknown — never the safe-fallback set, never auto-return
      expect(handle.steered.length).toBe(1);
      expect(agent.mainTurns()).toBe(turns0);
      expect(agent.stack.threads!.statusLine()).toMatch(/unknown 1/);
      expect(agent.reports()).toHaveLength(0);
      expect(agent.displays().length).toBe(0);
      const routed = Object.values(hub.disk().requests).filter((r) => r.code === "thr:routed");
      expect(routed).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 1_000));
      expect(agent.mainTurns()).toBe(turns0); // still no re-delivery
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S3b: an input handler consumes the steer with a side effect (handled) ⇒ unknown, no fallback, marker ONCE",
    { timeout: 60_000 },
    async () => {
      const { hub, agent, handle } = await bootRouted({
        handle: makeScriptedHandle({ disposition: "handled-side-effect" }),
      });
      const turns0 = agent.mainTurns();
      await hub.topic("consumed by handler");
      await waitRouted(agent, 1);
      await new Promise((r) => setTimeout(r, 500));
      expect(handle.markerCalls).toBe(1); // the side effect ran EXACTLY once
      expect(handle.steered.length).toBe(1);
      expect(agent.mainTurns()).toBe(turns0); // no fallback, no re-delivery
      expect(agent.stack.threads!.statusLine()).toMatch(/unknown 1/);
      expect(agent.reports()).toHaveLength(0);
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S4: explicit handback through the REAL child tool ⇒ ONE main turn; identical retry ⇒ dup",
    { timeout: 60_000 },
    async () => {
      const { hub, agent, origin, runId } = await bootRouted({});
      await hub.topic("hand me back");
      await waitRouted(agent, 1);
      await until(
        () => agent.stack.threads!.childOps(runId, "w1").lastEventOf(origin.h),
        (e) => e !== undefined,
        "event recorded",
      );
      const eventId = agent.stack.threads!.childOps(runId, "w1").lastEventOf(origin.h)!;
      const tool = createThreadChildTool({ runId, label: "w1", ops: agent.stack.threads!.childOps(runId, "w1") });
      const turns0 = agent.mainTurns();
      const out = await tool.execute(
        "tc1",
        { action: "handback", h: origin.h, reason: "not my scope" },
        undefined,
        undefined,
        {} as never,
      );
      const text = (out as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;
      expect(text).toContain("handback ok");
      const requestId = /as (fs[A-Za-z0-9_-]+)/.exec(text)?.[1];
      expect(requestId).toMatch(/^fs/);
      // exactly ONE main turn: the bypass re-delivery with the host note line
      await until(
        () => agent.mainTurns(),
        (n) => n === turns0 + 1,
        "handback re-delivered",
      );
      const delivered = agent.pi.sentUserMessages.filter((m) => m.text.includes("hand me back")).at(-1)!;
      expect(delivered.text).toContain(`[thread handback · @w1（run_id: ${runId}）`);
      // the identical wire retry (§7.3 retry law) ⇒ dup with the SAME requestId, no new successor
      const retry = await import("../../src/tools/thread-child-tool.js").then((m) =>
        m.thrHandbackWithRetry(() => agent.conn(), {
          eventId,
          sessionId: "sess-ft-main",
          by: { runId, label: "w1" },
          note: "not my scope",
        }),
      );
      expect(retry).toMatchObject({ ok: true, requestId, dup: true });
      await new Promise((r) => setTimeout(r, 800));
      expect(agent.mainTurns()).toBe(turns0 + 1); // still exactly one successor
      const sources = Object.values(hub.disk().requests).filter((r) => r.code === "thread-handback");
      expect(sources).toHaveLength(1);
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S4b③: two co-subscribers hand the same event back ⇒ ONE successor, identical requestId (dup)",
    { timeout: 90_000 },
    async () => {
      const hub = await bootHub();
      const agent = await bootAgent(hub);
      await agent.waitLive();
      const origin = await primeTopic(hub, agent);
      const a = await agent.spawnWorker("wa");
      const b = await agent.spawnWorker("wb");
      await until(
        () => agent.stack.query.get(b.runId)?.status,
        (s) => s === "running",
        "both running",
      );
      expect(
        agent.stack.threads!.subscribe({ run: a.runId, h: origin.h, scope: "s", origin: false, createdBy: "root" }),
      ).toMatchObject({ ok: true });
      expect(
        agent.stack.threads!.subscribe({ run: b.runId, h: origin.h, scope: "s", origin: false, createdBy: "root" }),
      ).toMatchObject({ ok: true });
      await hub.topic("shared event");
      await waitRouted(agent, 1);
      const opsA = agent.stack.threads!.childOps(a.runId, "wa");
      const opsB = agent.stack.threads!.childOps(b.runId, "wb");
      await until(
        () => opsA.lastEventOf(origin.h),
        (e) => e !== undefined,
        "event recorded",
      );
      const eventId = opsA.lastEventOf(origin.h)!;
      const toolA = createThreadChildTool({ runId: a.runId, label: "wa", ops: opsA });
      const toolB = createThreadChildTool({ runId: b.runId, label: "wb", ops: opsB });
      const [outA, outB] = await Promise.all([
        toolA.execute("t1", { action: "handback", h: origin.h, reason: "a" }, undefined, undefined, {} as never),
        toolB.execute("t2", { action: "handback", h: origin.h, reason: "b" }, undefined, undefined, {} as never),
      ]);
      const textA = (outA as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;
      const textB = (outB as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;
      const ids = [textA, textB].map((t) => /as (fs[A-Za-z0-9_-]+)/.exec(t)?.[1]);
      if (ids[0] === undefined || ids[1] === undefined)
        // eslint-disable-next-line no-console
        console.log(`[S4b3] A="${textA}" B="${textB}"`);
      expect(ids[0]).toMatch(/^fs/);
      expect(ids[0]).toBe(ids[1]); // ONE successor — the later caller got the same id
      expect(textA.includes("dup") || textB.includes("dup")).toBe(true);
      // only ONE re-delivered prompt hit the main session
      await until(
        () => agent.mainTurns(),
        (n) => n === 2,
        "one shared re-delivery",
      );
      const sources = Object.values(hub.disk().requests).filter((r) => r.code === "thread-handback");
      expect(sources).toHaveLength(1);
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S5: A queued + B startup-failed ⇒ NO auto-return, exactly one display line, zero main turns",
    { timeout: 90_000 },
    async () => {
      const hub = await bootHub();
      const agent = await bootAgent(hub);
      await agent.waitLive();
      const origin = await primeTopic(hub, agent);
      const a = await agent.spawnWorker("wa");
      await until(
        () => agent.stack.query.get(a.runId)?.status,
        (s) => s === "running",
        "A running",
      );
      expect(
        agent.stack.threads!.subscribe({ run: a.runId, h: origin.h, scope: "s", origin: false, createdBy: "root" }),
      ).toMatchObject({ ok: true });
      agent.holdSpawns();
      const b = await agent.spawnWorker("wb");
      await until(
        () => agent.stack.query.get(b.runId)?.status,
        (s) => s === "starting" || s === "queued",
        "B pending",
      );
      expect(
        agent.stack.threads!.subscribe({ run: b.runId, h: origin.h, scope: "s", origin: false, createdBy: "root" }),
      ).toMatchObject({ ok: true });
      const turns0 = agent.mainTurns();
      await hub.topic("shared event");
      await waitRouted(agent, 1);
      agent.releaseSpawns(new Error("B startup failed"));
      await until(
        () => agent.stack.query.get(b.runId)?.status,
        (s) => ["failed", "aborted", "timed_out"].includes(s as string),
        "B terminal",
      );
      await new Promise((r) => setTimeout(r, 2_000));
      // A holds a queued outcome ⇒ §6.7 forbids the auto-return; only a display line
      expect(agent.mainTurns()).toBe(turns0);
      expect(agent.reports()).toHaveLength(0);
      const lines = agent.displays().filter((m) => m.content.includes("shared event") || m.content.includes("wb"));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(Object.values(hub.disk().requests).filter((r) => r.code === "thread-handback")).toHaveLength(0);
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S6: /main and addressed_other (@other) reach the MAIN session, never the subscriber",
    { timeout: 60_000 },
    async () => {
      const { hub, agent, origin, handle } = await bootRouted({});
      const other = await agent.spawnWorker("other");
      await until(
        () => agent.stack.query.get(other.runId)?.status,
        (s) => s === "running",
        "other running",
      );
      const turns0 = agent.mainTurns();
      await hub.topic("/main direct to main"); // §6.2 — the bypass command
      await until(
        () => agent.mainTurns(),
        (n) => n === turns0 + 1,
        "/main hit the main session",
      );
      expect(agent.pi.sentUserMessages.at(-1)!.text).toContain("direct to main");
      await hub.topic("@other please verify"); // §6.2 addressing guard — names a NON-subscriber
      await until(
        () => agent.mainTurns(),
        (n) => n === turns0 + 2,
        "@other hit the main session",
      );
      expect(agent.pi.sentUserMessages.at(-1)!.text).toContain("@other please verify");
      await new Promise((r) => setTimeout(r, 800));
      // the subscriber never saw either event
      expect(handle.steered.filter((t) => t.includes("direct to main") || t.includes("please verify"))).toHaveLength(0);
      await hub.stop();
      agent.dispose();
    },
  );

  /** §7.2 G2b frame shapes, stashed by S7a/S7b and cross-compared by S7c (each leg runs in its
   *  OWN test so every hub is that test's first child — a second hub child within one test
   *  stops ingesting feishu prompts, a harness limitation isolated here, not a product bug). */
  const s7 = {
    a: undefined as undefined | Record<string, unknown>,
    b: undefined as undefined | Record<string, unknown>,
  };
  const frameShape = (frame: Record<string, unknown>) => {
    const cmd = frame.cmd as Record<string, unknown>;
    return {
      // keys WITHOUT `thread` — the G2b comparison isolates exactly that field
      keys: Object.keys(cmd)
        .filter((k) => k !== "thread")
        .sort(),
      op: cmd.op,
      deliver: cmd.deliver,
      hasThread: "thread" in cmd,
    };
  };
  const promptShape = (frames: Array<Record<string, unknown>>) => {
    const prompt = frames.find(
      (f) => (f.cmd as Record<string, unknown> | undefined)?.op === "prompt" && f.queryOnly !== true,
    );
    expect(prompt).toBeDefined();
    return frameShape(prompt!);
  };

  it("S7a (G2b): OLD hub × NEW agent — the business frame carries NO thread field", { timeout: 60_000 }, async () => {
    const hub = await bootHub({ threads: false });
    const agent = await bootAgent(hub); // threads ON — thr.v1 advertised (the allowed hello diff)
    await agent.waitLive();
    await bindTopic(hub, agent); // no cmd.thread ever arrives — origins stay empty (G2b)
    expect(agent.stack.threads!.origins()).toHaveLength(0);
    await until(
      () => agent.cmdFrames().length,
      (n) => n >= 1,
      "old-hub cmd frame",
    );
    const a = promptShape(agent.cmdFrames());
    expect(a.hasThread).toBe(false);
    s7.a = a;
    await hub.stop();
    agent.dispose();
  });

  it(
    "S7b (G2b): NEW hub × OLD agent — the business frame is byte-for-byte the same shape",
    { timeout: 60_000 },
    async () => {
      const hub = await bootHub(); // threads on — the hub advertises thr.v1 regardless
      const agent = await bootAgent(hub, { threadsOn: false }); // no threads deps at all
      await agent.waitLive();
      await bindTopic(hub, agent);
      await until(
        () => agent.cmdFrames().length,
        (n) => n >= 1,
        "new-hub cmd frame (old agent)",
      );
      const b = promptShape(agent.cmdFrames());
      expect(b.hasThread).toBe(false);
      s7.b = b;
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S7c (G2b): old×new ≡ new×old on business frames; new×new carries a well-formed cmd.thread",
    { timeout: 60_000 },
    async () => {
      expect(s7.a).toBeDefined();
      expect(s7.b).toBeDefined();
      // (a) ≡ (b): identical business-frame shape — the ONLY allowed difference never appears
      expect(s7.a).toEqual(s7.b);
      // new × new — the thread field is present and well-formed (§7.2)
      const { hub, agent } = await bootRouted({});
      await hub.topic("thread meta check");
      await waitRouted(agent, 1);
      const c = promptShape(agent.cmdFrames());
      expect(c.hasThread).toBe(true);
      const cmd = agent
        .cmdFrames()
        .find((f) => (f.cmd as Record<string, unknown> | undefined)?.op === "prompt" && f.queryOnly !== true)!.cmd as {
        thread?: { h?: string; label?: string; sentAt?: number };
      };
      expect(cmd.thread!.h).toMatch(/^fs:[A-Za-z0-9_-]{12}$/);
      expect(typeof cmd.thread!.label).toBe("string");
      expect(typeof cmd.thread!.sentAt).toBe("number");
      // everything EXCEPT the thread field is the same shape as the mixed pairs
      expect({ ...c, hasThread: undefined }).toEqual({ ...s7.a, hasThread: undefined });
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S9 (real-wire scope): a connection gap before the result ⇒ candidate stays uncertain, session view recovers, the next event routes",
    { timeout: 90_000 },
    async () => {
      const { hub, agent, handle } = await bootRouted({
        handle: makeScriptedHandle({ disposition: "hang" }),
        steerTimeoutMs: 8_000,
      });
      await hub.topic("gap before result");
      await until(
        () => handle.steered.length,
        (n) => n === 1,
        "steer called (hanging)",
      );
      // GAP: destroy the agent's link while the hub still awaits the result. On the real wire
      // this also kills the hub's in-flight dispatch promise (⇒ uncertain) — the routed-result
      // recovery race itself (routed/plain-ok/fallback × gap) needs the in-process hub seam and
      // is pinned unit-side in tests/web-hub/hub/feishu/thread-runs.test.ts (S9 variants).
      agent.sockets.at(-1)!.destroy();
      await agent.waitLive(); // the agent wiring reconnects on its own (zero-hang property)
      // the thread-candidate request must NOT be finalized unattributed while recovery is open
      const candidate = () =>
        Object.values(hub.disk().requests).find((r) => r.payload?.body?.includes("gap before result"));
      // the gap must land the candidate in `uncertain` (router promise killed with the socket)
      // — NOT a premature unattributed finalization
      await until(
        candidate,
        (r) => r?.state === "uncertain",
        "candidate uncertain (not prematurely unattributed)",
        5_000,
      );
      // Recovery of the session VIEW is the hub-side race this test pins: the reconnect replays
      // the session slot (hello_ack replay), but the binding sits `offline` for a window and
      // the hub TERMINALLY rejects prompts resolved in that window. Poll the hub's own agent
      // registry — the exact source `sessions.views()` reads (`registry.isConnected`) — until
      // the reconnected agent holds the session live again, THEN send the next event.
      await until(
        async () => (await hub.regs()).some((r) => r.sid === "sess-ft-" && r.connected && !r.detached),
        (live) => live,
        "session live again at the hub registry",
        20_000,
      );
      handle.settle("queued"); // e1's disposition (its late reply may be dropped by the hub)
      // zero-hang recovery: a NEW event routes end-to-end on the reconnected link
      await hub.topic("after reconnect");
      await until(
        () => handle.steered.length,
        (n) => n === 2,
        "e2 steered after reconnect",
      );
      handle.settle("queued");
      await waitRouted(agent, 2);
      const e2 = () => Object.values(hub.disk().requests).find((r) => r.payload?.body?.includes("after reconnect"));
      await until(e2, (r) => r?.state === "accepted" && r?.code === "thr:routed", "e2 routed after reconnect");
      expect(e2()?.state).toBe("accepted");
      expect(e2()?.code).toBe("thr:routed");
      expect(agent.mainTurns()).toBe(1); // the prime event only — neither event hit the main session
      await hub.stop();
      agent.dispose();
    },
  );

  it(
    "S11: lane over budget — a hanging FLUSH steer holds the run gate; the queued event falls back native at its own deadlineAt",
    { timeout: 90_000 },
    async () => {
      const hub = await bootHub();
      // flush steers are capped at steerTimeoutMs (8000) while a LIVE event's absolute budget
      // is min(steerTimeoutMs, frameDeadlineMs−1500) = 6500 — so a >1.5 s arrival gap makes the
      // queued event's OWN deadline expire while it still waits behind the hanging flush steer
      const agent = await bootAgent(hub, { steerTimeoutMs: 8_000 });
      await agent.waitLive();
      const origin = await primeTopic(hub, agent);
      agent.holdSpawns();
      const handle = makeScriptedHandle({ disposition: "hang" });
      const spawnP = agent.spawnWorker("w1", handle);
      const { runId } = await spawnP;
      await until(
        () => agent.stack.query.get(runId)?.status,
        (s) => s === "starting",
        "run starting",
      );
      expect(
        agent.stack.threads!.subscribe({ run: runId, h: origin.h, scope: "s", origin: false, createdBy: "root" }),
      ).toMatchObject({ ok: true });
      const turns0 = agent.mainTurns();
      await hub.topic("lane first");
      await new Promise((r) => setTimeout(r, 300));
      agent.releaseSpawns(); // running ⇒ flush starts ⇒ e1's steer hangs in-flight on the run gate
      await until(
        () => handle.steered.length,
        (n) => n === 1,
        "e1 flush steer called",
      );
      await new Promise((r) => setTimeout(r, 800)); // arrival gap — must be < steerTimeoutMs − (deadlineMs−1500) = 1.5 s
      const sentAt = Date.now();
      await hub.topic("lane second");
      // e2 queues behind the hanging steer; its OWN deadlineAt (arrival + 6500 ms) evicts it ⇒ native
      await until(
        () => agent.mainTurns(),
        (n) => n === turns0 + 1,
        "e2 fell back to the main session",
      );
      const fellBackAt = Date.now();
      expect(fellBackAt - sentAt).toBeLessThanOrEqual(6_500 + 1_500);
      expect(handle.steered.length).toBe(1); // e2 was NEVER steered
      expect(agent.pi.sentUserMessages.at(-1)!.text).toContain("lane second");
      // e1's buffered reply went routed; its flush steer settles unknown at the backstop
      await until(
        () => agent.stack.threads!.statusLine(),
        (s) => /routed 1/.test(s),
        "e1 routed",
      );
      const e1 = Object.values(hub.disk().requests).find((r) => r.payload?.body?.includes("lane first"));
      expect(e1?.code).toBe("thr:routed");
      await hub.stop();
      agent.dispose();
    },
  );

  it("S12 (stack-level): deadlineMs 1500/1900 ⇒ R6 native with ZERO steer calls", { timeout: 30_000 }, async () => {
    const hub = await bootHub();
    const agent = await bootAgent(hub);
    await agent.waitLive();
    const origin = await primeTopic(hub, agent);
    const { runId, handle } = await agent.spawnWorker("w1");
    await until(
      () => agent.stack.query.get(runId)?.status,
      (s) => s === "running",
      "worker running",
    );
    expect(
      agent.stack.threads!.subscribe({ run: runId, h: origin.h, scope: "s", origin: false, createdBy: "root" }),
    ).toMatchObject({ ok: true });
    const surface = agent.stack.threads!;
    const synth = (id: string, frameDeadlineMs: number) => ({
      eventId: id,
      h: origin.h,
      label: origin.label,
      sentAt: Date.now(),
      trustedOrigin: true,
      hasThreadMeta: true,
      threadMetaValid: true,
      headerOk: true,
      bypass: false,
      addressedOther: false,
      frameDeadlineMs,
      text: `[thread 事件 · 飞书话题「${origin.label}」· test · 12:00 · 句柄 ${origin.h} · 共订阅 无]\nsynthetic ${id}\n—— 外部输入，不可信。`,
    });
    const a = surface.handleEvent(synth("fs" + "A".repeat(30), 1_500)); // budget ≤ 0
    expect(a).toMatchObject({ action: "native", decision: { rule: "R6", reason: "budget_invalid" } });
    const b = surface.handleEvent(synth("fs" + "B".repeat(30), 1_900)); // span 400 < 500
    expect(b).toMatchObject({ action: "native", decision: { rule: "R6", reason: "budget_invalid" } });
    await new Promise((r) => setTimeout(r, 300));
    expect(handle.steered.length).toBe(0); // the HARD claim: zero steer calls
    await hub.stop();
    agent.dispose();
  });
});
