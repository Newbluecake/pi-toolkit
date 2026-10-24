/**
 * web-hub-cmd-history plan §8.1 I1 / §8.3 — the INTEGRATION half of the I1 package.
 *
 * REAL hub child process (the `startHub` composition root through tsx, exactly the
 * fabric-xs-process/web-hub-feishu-bot harness family) × REAL agent stacks (the full
 * `activate()` from src/index.ts over a real `SessionManager`, real session files on disk,
 * real agent-socket connection, real status/leaf projection) — only the pi host and the model
 * runtime are fake. Pinned end to end:
 *
 *  #1 web dispatch of toolkit commands: the `subagent:cmd` entry lands in the session file
 *     (cmdId = the cmd frame's id), the hub projects it (`history.snapshot` — the browser
 *     refresh path — and the live `append` bus events both carry the open `cmd` field);
 *     sync (`/agent status`) / async (`/webhub status` + `cmd_late`) / confirm → resend /
 *     busy / the agent_settled deferral window in BOTH TTL windows (capture fallback <5 s and
 *     intent ledger >5 s — plan G7) / `/model` auth-rejected `failed` / third-party
 *     terminal-only placeholder / `/webhub` sensitive header-only / `/new` leave-before-write
 *     (done + cancelled-corrective pair);
 *  #2 TUI dispatch: records with source "tui", terminal output byte-parity against a
 *     `cmdHistory:false` agent for the same commands, the >400 ms lazy-start two-entry path
 *     (`/resume-recent` held on a pending `ctx.ui.custom`), and the off-agent's全面不变
 *     (no entries, no `history` field, legacy capture reply, no feature token);
 *  #3 secure LOCKED (bogus PI_SECURE_VAULT): the command still executes, nothing is written,
 *     `/webhub status` reports the growing `skipped` counter;
 *  #4 a brand-new session with no file on disk yet: the hub's §4.10 ENOENT fallback serves the
 *     record live (`append`) and on refresh (`snapshot` from the agent's in-memory branch);
 *  #5 log hygiene (plan §5.3/§8.5 #7): neither hub.log nor the agent child's stderr ever
 *     carries command output bodies (probed with the session file path and unique markers).
 *
 * NOT covered here (their own gates): the unit matrices in tests/web-hub/{protocol,agent,hub},
 * the UI fold in tests/web-hub/ui, and the real-pi premises in tests/conformance/cmd-history.test.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// child fixture — one script, two roles (hub | agent), driven over ipc rpc
// ---------------------------------------------------------------------------

/**
 * The child runs the SAME production composition roots the real processes run:
 *  - hub: `startHub` with a stub HTTP frontend (the fabric-xs-process precedent — the socket
 *    listener, registry, history service and stores are all real; only the browser listener is
 *    replaced by a probe that records `append` bus events and `cmd_late` frames);
 *  - agent: full `activate()` from src/index.ts over a fake pi host (commands/events/appendEntry
 *    are real bookkeeping; `sendUserMessage` reproduces pi's documented command semantics:
 *    `expandPromptTemplates:true` + slash ⇒ run the (capture-wrapped) handler inside the call,
 *    optionally DEFERRED behind an agent_settled-style hold; the default (false) never executes
 *    slash text).
 */
const CHILD = String.raw`
const root = process.cwd();
const load = (p) => import(root + "/" + p);
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { EventEmitter } = await import("node:events");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const reply = (id, value) => process.send?.({ id, value });
let handle;

if (process.env.CMDH_ROLE === "hub") {
  const { startHub } = await load("src/web-hub/hub/hub.ts");
  const appends = [];
  const lates = new Map();
  let registry, history;
  const hub = await startHub(
    {
      home: process.env.HOME,
      port: 0,
      idleExitMinutes: 10,
      pluginVersion: PACKAGE_VERSION,
      buildId: "cmd-history-i1",
      // xs on so /fabric status's hubInfo() round-trip is a real, answering request
      crossSession: { limits: { hubSendsPerMin: 600 } },
    },
    (deps) => {
      registry = deps.registry;
      history = deps.history;
      // cmd_late never passes registry.onFrame — the registry folds it internally and publishes
      // it on the bus (registry.ts 'cmd_late' case); 'append' rides the same bus.
      deps.bus.subscribe((ev) => {
        if (ev.type === "append") appends.push(ev);
        if (ev.type === "cmd_late")
          lates.set(ev.id, { at: Date.now(), ok: ev.ok, code: ev.code, data: ev.data, op: ev.op });
      });
      return {
        listen: async () => ({ port: 43211 }),
        close: async () => {},
        clientCount: () => 0,
        ui: {
          serve: async () => false,
          refresh: async () => ({ state: "unbuilt", candidates: [] }),
          status: () => ({ state: "unbuilt", candidates: [] }),
        },
      };
    },
  );
  if ("exists" in hub) throw new Error("hub unexpectedly already exists");
  const keyOf = (sessionId) => registry.list().find((a) => a.session?.sessionId === sessionId)?.agentKey;
  handle = async (m) => {
    if (m.op === "webCmd") {
      const agentKey = keyOf(m.sessionId);
      if (agentKey === undefined) throw new Error("agent not registered for " + m.sessionId);
      const id = m.cmdId ?? ("i1-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
      const first = await registry.request(
        agentKey,
        {
          t: "cmd",
          rid: "i1-" + Date.now(),
          id,
          deadlineMs: m.deadlineMs ?? 8000,
          origin: { listener: "loopback", ip: "127.0.0.1", reqId: "i1-web-cmd" },
          cmd: { op: "command", name: m.name, args: m.args ?? "", ...(m.confirm ? { confirm: true } : {}) },
        },
        m.requestMs ?? 10_000,
      );
      return { first, id };
    }
    if (m.op === "late") {
      const end = Date.now() + (m.ms ?? 6000);
      while (Date.now() < end) {
        if (lates.has(m.cmdId)) return lates.get(m.cmdId);
        await new Promise((r) => setTimeout(r, 25));
      }
      return undefined;
    }
    if (m.op === "historySnapshot") {
      const agentKey = keyOf(m.sessionId);
      if (agentKey === undefined) throw new Error("agent not registered for " + m.sessionId);
      const payload = await history.snapshot(agentKey);
      return { entries: payload.entries, source: payload.source, hasMore: payload.hasMore };
    }
    if (m.op === "appends") return appends;
    if (m.op === "lates") return [...lates.keys()];
    if (m.op === "agents") return registry.list();
    if (m.op === "stop") {
      await hub.close("test");
      process.disconnect();
      return true;
    }
    throw new Error("unknown hub op " + m.op);
  };
} else {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { SessionManager } = await load("node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const { default: activate } = await load("src/index.ts");
  const agentDir = join(process.env.HOME, ".pi/agent");
  mkdirSync(agentDir, { recursive: true });
  const config = {
    fleetWidget: false,
    webSearch: { enabled: false },
    date: { enabled: false },
    todo: { enabled: false },
    memory: { enabled: false },
    hud: { enabled: false },
    feishuNotify: { enabled: false },
    sessionNav: { enabled: true }, // /resume-recent + /clear: the slow-command and leave probes
    askUser: { enabled: false },
    title: { enabled: false },
    topicSwitch: { enabled: false },
    quota: { enabled: false },
    load: { enabled: false },
    cacheTtl: { keepalive: false },
    compact: { dynamicThreshold: { mode: "off" } },
    bashJobs: { autoBackgroundMs: 0 },
    systemPrompt: { mode: "legacy" },
    ...(process.env.CMDH_FABRIC === "1"
      ? { fabric: { enabled: true, crossSession: { enabled: true, limits: { pairMinIntervalMs: 0 } } } }
      : {}),
    webHub: {
      enabled: true,
      autoStart: false,
      control: true,
      ...(process.env.CMDH_CMD_HISTORY === "0" ? { cmdHistory: false } : {}),
      ...(process.env.CMDH_POLICY_JSON ? { webCommandPolicy: JSON.parse(process.env.CMDH_POLICY_JSON) } : {}),
      uploads: "off",
      preview: "off",
      avatar: false,
      privacy: false,
      subagentTranscript: "off",
      commandComplete: "off",
      quota: false,
      load: false,
    },
  };
  writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify(config));
  const sessionDir = join(process.env.PI_CODING_AGENT_DIR, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const newSession = () => {
    const session = SessionManager.create(process.cwd(), sessionDir);
    if (process.env.CMDH_FIRST_MESSAGE !== "0")
      session.appendMessage({ role: "user", content: "fixture startup", timestamp: Date.now() });
    return session;
  };
  let sm = newSession();
  let idle = true;
  let settleHoldArmed = 0;
  const deferredActions = [];
  let newSessionMode = process.env.CMDH_NEW_SESSION_MODE ?? "ok"; // ok | cancel
  const pendingSetModels = [];
  let customResolve;
  const bus = new EventEmitter();
  let handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const uiCalls = [];
  const userMessages = [];
  const FAKE_MODEL = {
    id: "fake-model",
    name: "Fake Model",
    api: "anthropic-messages",
    provider: "fake-provider",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    get sessionManager() {
      return sm;
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    abort: () => {},
    modelRegistry: {
      getAvailable: () => [FAKE_MODEL],
      find: (p, id) => (p === "fake-provider" && id === "fake-model" ? FAKE_MODEL : undefined),
    },
    getContextUsage: () => undefined,
    // A REAL replacement (the runtime's teardown → swap → re-bind shape): the leave happens,
    // the recorder's session guard sees the swap, and a second activate() rebuilds the wiring.
    newSession: async () => {
      if (newSessionMode === "cancel") return { cancelled: true };
      await fire("session_shutdown", { reason: "new" });
      sm = newSession();
      idle = true;
      deferredActions.length = 0;
      handlers = new Map();
      tools.clear();
      commands.clear();
      await boot("new");
      return { cancelled: false };
    },
    switchSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    reload: async () => {},
    shutdown: () => {},
    ui: {
      notify: (message, type) => uiCalls.push({ m: "notify", message, type: type ?? "info" }),
      setStatus: (key, text) => uiCalls.push({ m: "setStatus", key, text }),
      setWidget: (key, content) =>
        uiCalls.push({ m: "setWidget", key, content: Array.isArray(content) ? content : "[component]" }),
      // The /resume-recent lazy-start probe: a REAL pending UI interaction this fixture controls.
      custom: (factory) => {
        uiCalls.push({ m: "custom", factory: typeof factory });
        return new Promise((r) => {
          customResolve = r;
        });
      },
      confirm: async (title) => (uiCalls.push({ m: "confirm", title }), true),
      select: async (title) => (uiCalls.push({ m: "select", title }), undefined),
      input: async (title) => (uiCalls.push({ m: "input", title }), undefined),
      editor: async (title) => {
        uiCalls.push({ m: "editor", title });
        return undefined;
      },
      setEditorText: () => uiCalls.push({ m: "setEditorText" }),
      pasteToEditor: () => uiCalls.push({ m: "pasteToEditor" }),
      getEditorComponent: () => undefined,
      setEditorComponent: () => uiCalls.push({ m: "setEditorComponent" }),
      addAutocompleteProvider: () => uiCalls.push({ m: "addAutocompleteProvider" }),
    },
  };
  async function fire(type, extra = {}) {
    for (const h of [...(handlers.get(type) ?? [])]) await h({ type, ...extra }, ctx);
  }
  const pi = {
    on(type, h) {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
    },
    registerTool(t) {
      tools.set(t.name, t);
    },
    registerCommand(n, c) {
      commands.set(n, c);
    },
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry: (kind, data) => sm.appendCustomEntry(kind, data),
    getAllTools: () => [...tools.values()],
    getCommands: () => [...commands].map(([name, c]) => ({ name, description: c.description, source: "extension" })),
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    getSessionName: () => process.env.CMDH_NAME,
    sendMessage() {},
    // pi's documented command semantics (agent-session.js): expandPromptTemplates:true + slash
    // runs the extension command inside the call (immediately, even while streaming); the ONLY
    // deferral source is the agent_settled emission window, reproduced by settleHoldArmed.
    sendUserMessage: async (text, options) => {
      userMessages.push({ text, expand: options?.expandPromptTemplates === true });
      if (options?.expandPromptTemplates === true && text.startsWith("/")) {
        const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
        const command = slash === null ? undefined : commands.get(slash[1]);
        if (command !== undefined) {
          const args = slash[2] ?? "";
          const run = () => Promise.resolve(command.handler(args, ctx)).catch(() => {});
          if (settleHoldArmed > 0) {
            settleHoldArmed -= 1;
            deferredActions.push(run); // prompt() returns BEFORE the command runs (deferral)
            return;
          }
          return run();
        }
      }
    },
    setModel: () => new Promise((r) => pendingSetModels.push(r)),
    setSessionName() {},
    setThinkingLevel() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: { on: (n, f) => (bus.on(n, f), () => bus.off(n, f)), emit: (n, d) => bus.emit(n, d) },
  };
  async function boot(reason) {
    activate(pi);
    await fire("session_start", { reason });
  }
  // A THIRD-PARTY command (registered straight into the host's table — never through the
  // wrapCommandApi proxy, so capture.owns() is false) must exist BEFORE the wiring's first
  // commands-slot flush or the hub's cmd route admission refuses the name.
  if (process.env.CMDH_THIRD_PARTY) {
    const tp = process.env.CMDH_THIRD_PARTY;
    commands.set(tp, {
      description: "third-party probe",
      handler: async (args, c) => {
        c.ui.notify("THIRDPARTY-PROBE " + tp + " " + args, "info");
      },
    });
  }
  await boot("startup");
  const cmdEntries = () =>
    sm
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === "subagent:cmd")
      .map((e) => e.data);
  handle = async (m) => {
    if (m.op === "inspect")
      return {
        sessionId: sm.getSessionId(),
        sessionFile: sm.getSessionFile(),
        secureDomain: (globalThis[Symbol.for("pi-subagent:secure-domain")] ?? { kind: "plain" }).kind,
        conn: (await import(root + "/src/web-hub/agent/connection.ts")).currentConnection()?.status(),
        cmdEntries: cmdEntries(),
        userMessages,
        uiCalls,
      };
    if (m.op === "tuiCmd") {
      const command = commands.get(m.name);
      if (command === undefined) throw new Error("no command " + m.name);
      const before = uiCalls.length;
      const run = Promise.resolve(command.handler(m.args ?? "", ctx)).catch((e) => ({ thrown: String(e) }));
      if (m.awaitDone === false) return { fired: true };
      const outcome = await run;
      return { outcome, uiCalls: uiCalls.slice(before) };
    }
    if (m.op === "settleHold") {
      settleHoldArmed = m.count ?? 1;
      return true;
    }
    if (m.op === "releaseSettle") {
      const actions = deferredActions.splice(0);
      for (const a of actions) await a();
      return actions.length;
    }
    if (m.op === "busy") {
      idle = !m.on;
      return true;
    }
    if (m.op === "registerThirdParty") {
      commands.set(m.name, {
        description: "third-party probe",
        handler: async (args, c) => {
          c.ui.notify("THIRDPARTY-PROBE " + m.name + " " + args, "info");
        },
      });
      return true;
    }
    if (m.op === "resolveCustom") {
      customResolve?.(m.value ?? null);
      return true;
    }
    if (m.op === "resolveSetModel") {
      for (const r of pendingSetModels.splice(0)) r(m.accepted === true);
      return true;
    }
    if (m.op === "setNewSessionMode") {
      newSessionMode = m.mode;
      return true;
    }
    if (m.op === "stop") {
      await fire("session_shutdown", { reason: "quit" });
      (await import(root + "/src/web-hub/agent/connection.ts")).currentConnection()?.close("test");
      return true;
    }
    throw new Error("unknown agent op " + m.op);
  };
}
process.on("message", (m) => {
  void handle(m).then(
    (value) => reply(m.id, value),
    (e) => process.send?.({ id: m.id, error: String(e?.stack ?? e) }),
  );
});
process.send?.({ ready: true });
`;

// ---------------------------------------------------------------------------
// harness (the fabric-xs-harness peer, inlined — the I1 file domain is this one test file)
// ---------------------------------------------------------------------------

interface Peer {
  child: ChildProcess;
  stderr: string;
  ready: Promise<void>;
  rpc<T = any>(op: string, extra?: Record<string, unknown>): Promise<T>;
  kill(): Promise<void>;
}

const homes = new Set<string>();
const peers = new Set<Peer>();

function bounded<T>(p: Promise<T>, label: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean, label: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 30);
      t.unref();
    });
  } while (Date.now() < end);
  throw new Error(`timeout: ${label}`);
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cmdh-i1-"));
  homes.add(home);
  return home;
}

function bootPeer(home: string, role: "hub" | "agent", env: Record<string, string> = {}): Peer {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: "",
      CMDH_ROLE: role,
      ...(role === "agent"
        ? { PI_CODING_AGENT_DIR: join(home, `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`) }
        : {}),
      ...env,
    },
  });
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-16_000);
  });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let ready!: () => void;
  let failReady!: (e: Error) => void;
  const started = new Promise<void>((r, j) => {
    ready = r;
    failReady = j;
  });
  child.on("message", (m: any) => {
    if (m.ready) ready();
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(new Error(m.error)) : p?.resolve(m.value);
    }
  });
  child.on("close", (code) => {
    const error = new Error(`${role} exit ${code}: ${stderr}`);
    failReady(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  const exited = new Promise<void>((r) => child.once("close", () => r()));
  let rid = 0;
  const peer: Peer = {
    child,
    get stderr() {
      return stderr;
    },
    ready: bounded(started, `${role} ready`, 90_000),
    rpc: (op, extra = {}) => {
      const id = ++rid;
      return bounded(
        (async () => {
          await peer.ready;
          return await new Promise<any>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.send({ ...extra, id, op }, (e) => {
              if (e) {
                pending.delete(id);
                reject(e);
              }
            });
          });
        })(),
        `${role}:${op}`,
      ).finally(() => pending.delete(id));
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(exited, `${role} exit`);
    },
  };
  peers.add(peer);
  return peer;
}

interface Booted {
  home: string;
  hub: Peer;
  agents: Peer[];
  close(): Promise<void>;
}

async function boot(home: string, agentEnvs: Array<Record<string, string>>): Promise<Booted> {
  mkdirSync(join(home, "project"), { recursive: true });
  const hub = bootPeer(home, "hub");
  await hub.ready;
  const agents: Peer[] = [];
  for (const env of agentEnvs) {
    const agent = bootPeer(home, "agent", env);
    agents.push(agent);
    await agent.ready;
    await until(
      () => agent.rpc("inspect"),
      (s) => s.conn?.state === "live",
      "agent socket live",
      45_000,
    );
  }
  return {
    home,
    hub,
    agents,
    close: async () => {
      for (const a of agents) await a.rpc("stop").catch(() => {});
      await hub.rpc("stop").catch(() => {});
      await Promise.all([...agents, hub].map((p) => p.kill()));
    },
  };
}

/** The subagent:cmd entries of one agent's LIVE session file, read straight off disk. */
function readCmdEntries(sessionFile: string): any[] {
  if (sessionFile === undefined || !existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === "subagent:cmd")
    .map((e) => e.data);
}

const appendHasCmd = (hub: Peer, cmdId: string): Promise<boolean> =>
  hub
    .rpc("appends")
    .then((appends: any[]) => appends.some((a) => (a.entries ?? []).some((e: any) => e.cmd?.cmdId === cmdId)));

afterEach(async () => {
  for (const p of peers) await p.kill().catch(() => {});
  peers.clear();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  homes.clear();
}, 30_000);

// ---------------------------------------------------------------------------
// #1 web dispatch — the full §5.2 builtin/extension matrix over one real stack
// ---------------------------------------------------------------------------

describe("cmd-history I1 integration — web dispatch over a real hub × real stack", () => {
  it("records, projects and refreshes web commands; sync/async/confirm/busy/deferred/model-failed/third-party/sensitive/new-leave; log hygiene", async () => {
    const home = newHome();
    const b = await boot(home, [
      { CMDH_POLICY_JSON: JSON.stringify({ goal: "confirm" }), CMDH_FABRIC: "1", CMDH_THIRD_PARTY: "zzthird" },
    ]);
    const agent = b.agents[0]!;
    const hub = b.hub;
    const inspect0 = await agent.rpc("inspect");
    const sessionId: string = inspect0.sessionId;
    const sessionFile: string = inspect0.sessionFile;
    expect(inspect0.secureDomain).toBe("plain");
    // The browser has the session open (initial snapshot also arms the hub's tail diffing).
    await hub.rpc("historySnapshot", { sessionId });

    // ---- sync extension command: one self-contained end entry, live + refresh projection ----
    const sync = await hub.rpc("webCmd", { sessionId, name: "agent", args: "status" });
    expect(sync.first.ok).toBe(true);
    expect(sync.first.data.completion).toBe("sync");
    expect(sync.first.data.history).toBe("recorded");
    expect(sync.first.data.output?.entries?.length).toBeGreaterThan(0);
    await until(
      () => Promise.resolve(readCmdEntries(sessionFile)),
      (entries) => entries.some((e) => e.cmdId === sync.id),
      "sync record lands in the session file",
    );
    const syncEntry = readCmdEntries(sessionFile).find((e: any) => e.cmdId === sync.id)!;
    expect(syncEntry.phase).toBe("end");
    expect(syncEntry.name).toBe("agent");
    expect(syncEntry.args).toBe("status");
    expect(syncEntry.source).toBe("web");
    expect(syncEntry.state).toBe("done");
    expect(syncEntry.output?.entries?.length).toBeGreaterThan(0);
    await until(
      () => appendHasCmd(hub, sync.id),
      (ok) => ok,
      `append carries ${sync.id}`,
    );
    const snap1 = await hub.rpc("historySnapshot", { sessionId });
    const projected = snap1.entries.find((e: any) => e.cmd?.cmdId === sync.id);
    expect(projected).toBeDefined();
    expect(projected.type).toBe("custom");
    expect(projected.customType).toBe("subagent:cmd");
    expect(projected.display).toBe(false);
    expect(projected.cmd.state).toBe("done");
    expect(projected.cmd.name).toBe("agent");
    // "刷新后仍在": a second (fresh) snapshot still serves the card.
    const snap2 = await hub.rpc("historySnapshot", { sessionId });
    expect(snap2.entries.some((e: any) => e.cmd?.cmdId === sync.id)).toBe(true);

    // ---- async extension command (/fabric status awaits hubInfo() before its first notify)
    //      + the late channel carrying the full output ----
    const asy = await hub.rpc("webCmd", { sessionId, name: "fabric", args: "status" });
    expect(asy.first.ok).toBe(true);
    expect(asy.first.data.completion).toBe("async");
    expect(asy.first.data.captured).toBe(true);
    expect(asy.first.data.history).toBe("recorded");
    const late = await hub.rpc("late", { cmdId: asy.id, ms: 8000 });
    expect(late).toBeDefined();
    expect(late.ok).toBe(true);
    expect(late.data.history).toBe("recorded");
    expect(late.data.output?.entries?.length).toBeGreaterThan(0);
    const asyncEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === asy.id && e.phase === "end")),
      (e) => e !== undefined,
      "async record lands",
    );
    expect(asyncEntry.state).toBe("done");
    expect(asyncEntry.output?.entries?.length).toBeGreaterThan(0);

    // ---- /webhub status (sync prefix): the record carries the status body incl. the
    //      cmd-history counter line (its own view of this feature) ----
    const wh = await hub.rpc("webCmd", { sessionId, name: "webhub", args: "status" });
    expect(wh.first.data.completion).toBe("sync");
    const whEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === wh.id && e.phase === "end")),
      (e) => e !== undefined,
      "/webhub status record lands",
    );
    expect(whEntry.output?.entries?.some((e: any) => e.text?.includes("cmd-history: on"))).toBe(true);
    expect(whEntry.output?.entries?.some((e: any) => e.text?.includes("hub-cap on"))).toBe(true);

    // ---- confirm → effect-none refusal records NOTHING; the confirmed resend records ----
    const refused = await hub.rpc("webCmd", { sessionId, name: "goal", args: "" });
    expect(refused.first.ok).toBe(false);
    expect(refused.first.code).toBe("E_CONFIRM_REQUIRED");
    expect(refused.first.effect).toBe("none");
    expect(refused.first.data).toBeUndefined();
    expect(readCmdEntries(sessionFile).some((e: any) => e.name === "goal")).toBe(false);
    const confirmed = await hub.rpc("webCmd", { sessionId, name: "goal", args: "", confirm: true });
    expect(confirmed.first.ok).toBe(true);
    expect(confirmed.first.data.history).toBe("recorded");
    await until(
      () => Promise.resolve(readCmdEntries(sessionFile)),
      (entries) => entries.some((e) => e.cmdId === confirmed.id),
      "confirmed /goal record lands",
    );
    const goalEntry = readCmdEntries(sessionFile).find((e: any) => e.cmdId === confirmed.id)!;
    expect(goalEntry.name).toBe("goal");
    expect(goalEntry.state).toBe("done");

    // ---- busy: an allow-policy command still executes (commands bypass the busy queue) ----
    await agent.rpc("busy", { on: true });
    const busy = await hub.rpc("webCmd", { sessionId, name: "agent", args: "status" });
    await agent.rpc("busy", { on: false });
    expect(busy.first.ok).toBe(true);
    expect(busy.first.data.history).toBe("recorded");
    await until(
      () => Promise.resolve(readCmdEntries(sessionFile)),
      (entries) => entries.some((e) => e.cmdId === busy.id),
      "busy record lands",
    );

    // ---- agent_settled deferral, <5 s: bridge answers unknown, claim path recovers the frame id ----
    await agent.rpc("settleHold", { count: 1 });
    const held = await hub.rpc("webCmd", { sessionId, name: "agent", args: "status", deadlineMs: 9000 });
    expect(held.first.data.completion).toBe("unknown");
    expect(held.first.data.history).toBe("recorded");
    expect(readCmdEntries(sessionFile).some((e: any) => e.cmdId === held.id)).toBe(false); // not executed yet
    await agent.rpc("releaseSettle");
    const heldEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === held.id)),
      (e) => e !== undefined,
      "deferred (<5 s) record lands",
    );
    expect(heldEntry.source).toBe("web");
    expect(heldEntry.state).toBe("done");
    expect(heldEntry.output?.entries?.length).toBeGreaterThan(0);

    // ---- agent_settled deferral, >5 s: the capture fallback TTL expired — the intent ledger
    //      (plan D7/G7) is the only thing that can still pin the frame id ----
    await agent.rpc("settleHold", { count: 1 });
    const longHeld = await hub.rpc("webCmd", { sessionId, name: "agent", args: "status", deadlineMs: 9000 });
    expect(longHeld.first.data.completion).toBe("unknown");
    await new Promise((r) => setTimeout(r, 5400)); // > FALLBACK_TTL_MS (5 s)
    await agent.rpc("releaseSettle");
    const longEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === longHeld.id)),
      (e) => e !== undefined,
      "deferred (>5 s) record lands via the intent ledger",
    );
    expect(longEntry.source).toBe("web");
    expect(longEntry.output?.entries?.length).toBeGreaterThan(0);

    // ---- /model auth rejection: the record settles at the REAL settlement point as failed ----
    const model = await hub.rpc("webCmd", { sessionId, name: "model", args: "fake-provider/fake-model" });
    expect(model.first.ok).toBe(true);
    expect(model.first.data.history).toBe("recorded");
    await new Promise((r) => setTimeout(r, 200));
    await agent.rpc("resolveSetModel", { accepted: false });
    const modelEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === model.id && e.phase === "end")),
      (e) => e !== undefined,
      "model record lands",
    );
    expect(modelEntry.state).toBe("failed");
    expect(modelEntry.error).toBe("authentication not configured for that model");
    const modelLate = await hub.rpc("late", { cmdId: model.id, ms: 6000 });
    expect(modelLate?.ok).toBe(false);
    expect(modelLate?.code).toBe("E_SUBAGENT_REJECTED");

    // ---- third-party extension: dispatched, output terminal-only, placeholder card ----
    const third = await hub.rpc("webCmd", { sessionId, name: "zzthird", args: "hi", confirm: true });
    expect(third.first.ok).toBe(true);
    expect(third.first.data.completion).toBe("unknown");
    expect(third.first.data.captured).toBe(false);
    expect(third.first.data.history).toBe("recorded");
    const thirdEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === third.id)),
      (e) => e !== undefined,
      "third-party placeholder lands",
    );
    expect(thirdEntry.notice).toBe("terminal-only");
    expect(thirdEntry.output).toBeUndefined();
    const uiAfter = await agent.rpc("inspect");
    expect(JSON.stringify(uiAfter.uiCalls)).toContain("THIRDPARTY-PROBE zzthird hi"); // it DID run

    // ---- Q5 sensitive /webhub subcommands cannot even be dispatched from the web (the
    //      command-policy table denies every non-status sub) — the header-only record is
    //      covered TUI-side in the next describe; here we pin the web refusal itself: an
    //      effect-none denial leaves NO record. ----
    const sens = await hub.rpc("webCmd", { sessionId, name: "webhub", args: "token", confirm: true });
    expect(sens.first.ok).toBe(false);
    expect(sens.first.effect).toBe("none");
    const beforeSens = readCmdEntries(sessionFile).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(readCmdEntries(sessionFile).length).toBe(beforeSens);

    // ---- /new: the card is committed in the OLD session BEFORE the switch happens ----
    const newCmd = await hub.rpc("webCmd", { sessionId, name: "new", confirm: true });
    expect(newCmd.first.ok).toBe(true);
    expect(newCmd.first.data.history).toBe("recorded");
    const newEntry = await until(
      () => Promise.resolve(readCmdEntries(sessionFile).find((e: any) => e.cmdId === newCmd.id)),
      (e) => e !== undefined,
      "/new record lands in the OLD session",
    );
    expect(newEntry.name).toBe("new");
    expect(newEntry.notice).toBe("left-session");
    expect(newEntry.state).toBe("done");
    // NOTE: no live-append assertion for the /new card — the switch resets the hub's tail
    // baseline by design ("new session: browsers re-snapshot"), so the card is proven through
    // the old session FILE above plus the fresh-session cleanliness below.
    const inspectNew = await agent.rpc("inspect");
    expect(inspectNew.sessionId).not.toBe(sessionId); // the session really switched
    expect(inspectNew.sessionFile).toBeDefined();
    expect(readCmdEntries(inspectNew.sessionFile)).toHaveLength(0); // fresh session stays clean
    // No record for the internal trampoline itself (skip policy: args start with __).
    expect(readCmdEntries(sessionFile).filter((e: any) => e.args?.startsWith("__exec"))).toHaveLength(0);
    const newSessionId = inspectNew.sessionId as string;
    // The hub learns the new session id from the re-attach's session frame — wait for it.
    await until(
      async () => (await hub.rpc("agents")).some((a: any) => a.session?.sessionId === newSessionId),
      (ok) => ok,
      "hub sees the new session",
    );

    // ---- /new cancelled: a corrective second end{failed} under the same cmdId ----
    await agent.rpc("setNewSessionMode", { mode: "cancel" });
    const cancelled = await hub.rpc("webCmd", { sessionId: newSessionId, name: "new", confirm: true });
    const cancelEntries = await until(
      () => Promise.resolve(readCmdEntries(inspectNew.sessionFile).filter((e: any) => e.cmdId === cancelled.id)),
      (entries) => entries.length >= 2,
      "cancelled /new writes both ends",
    );
    expect(cancelEntries.map((e: any) => e.state)).toEqual(["done", "failed"]);
    expect(cancelEntries[0].notice).toBe("left-session");
    expect(cancelEntries[1].error).toBe("新建会话被取消");
    const stillSame = await agent.rpc("inspect");
    expect(stillSame.sessionId).toBe(newSessionId); // never left

    // ---- log hygiene (§5.3/§8.5 #7): no command output bodies in hub.log or agent stderr ----
    const hubLog = readFileSync(join(home, ".pi/agent/web-hub/hub.log"), "utf8");
    for (const probe of [sessionFile, "THIRDPARTY-PROBE", "cmd-history: on", "新建会话被取消"]) {
      expect(hubLog.includes(probe), `hub.log leaks ${probe}`).toBe(false);
      expect(agent.stderr.includes(probe), `agent stderr leaks ${probe}`).toBe(false);
    }

    await b.close();
  }, 240_000);
});

// ---------------------------------------------------------------------------
// #2 TUI dispatch — records with source "tui", terminal parity, lazy start, off-agent
// ---------------------------------------------------------------------------

describe("cmd-history I1 integration — TUI dispatch and the cmdHistory:false control", () => {
  it("records TUI commands without touching terminal output; >400 ms writes start+end; off-agent stays byte-identical", async () => {
    const home = newHome();
    const b = await boot(home, [{ CMDH_NAME: "on-agent" }, { CMDH_NAME: "off-agent", CMDH_CMD_HISTORY: "0" }]);
    const on = b.agents[0]!;
    const off = b.agents[1]!;
    const hub = b.hub;
    const onInspect = await on.rpc("inspect");
    const offInspect = await off.rpc("inspect");
    const onFile: string = onInspect.sessionFile;
    const offFile: string = offInspect.sessionFile;
    await hub.rpc("historySnapshot", { sessionId: onInspect.sessionId });
    await hub.rpc("historySnapshot", { sessionId: offInspect.sessionId });

    // TUI /goal: identical terminal output on both agents (the observe proxy is a pure tee).
    const onGoal = await on.rpc("tuiCmd", { name: "goal", args: "" });
    const offGoal = await off.rpc("tuiCmd", { name: "goal", args: "" });
    expect(onGoal.uiCalls).toEqual(offGoal.uiCalls); // terminal parity (same notify args)
    expect(onGoal.uiCalls.some((c: any) => c.m === "notify")).toBe(true);
    const onGoalEntry = await until(
      () => Promise.resolve(readCmdEntries(onFile).find((e: any) => e.name === "goal")),
      (e) => e !== undefined,
      "TUI /goal record lands",
    );
    expect(onGoalEntry.source).toBe("tui");
    expect(onGoalEntry.state).toBe("done");
    expect(onGoalEntry.phase).toBe("end"); // fast command: single self-contained end
    expect(readCmdEntries(offFile)).toHaveLength(0); // off-agent writes nothing

    // TUI /webhub token: terminal still shows the refusal; the record is header-only.
    const onTok = await on.rpc("tuiCmd", { name: "webhub", args: "token" });
    const offTok = await off.rpc("tuiCmd", { name: "webhub", args: "token" });
    expect(onTok.uiCalls).toEqual(offTok.uiCalls);
    const tokEntry = await until(
      () => Promise.resolve(readCmdEntries(onFile).find((e: any) => e.name === "webhub" && e.args === "token")),
      (e) => e !== undefined,
      "TUI sensitive record lands",
    );
    expect(tokEntry.notice).toBe("sensitive");
    expect(tokEntry.output).toBeUndefined();
    expect(readCmdEntries(offFile)).toHaveLength(0);

    // >400 ms command (/resume-recent held on a pending ctx.ui.custom): start THEN end.
    const beforeCount = readCmdEntries(onFile).length;
    await on.rpc("tuiCmd", { name: "resume-recent", args: "", awaitDone: false });
    const startEntry = await until(
      () =>
        Promise.resolve(
          readCmdEntries(onFile)
            .slice(beforeCount)
            .find((e: any) => e.phase === "start"),
        ),
      (e) => e !== undefined,
      "lazy start entry written at 400 ms",
    );
    expect(startEntry.source).toBe("tui");
    expect(startEntry.name).toBe("resume-recent");
    await on.rpc("resolveCustom", { value: null });
    const endEntry = await until(
      () =>
        Promise.resolve(
          readCmdEntries(onFile)
            .slice(beforeCount)
            .find((e: any) => e.phase === "end"),
        ),
      (e) => e !== undefined,
      "end entry after the interaction resolved",
    );
    expect(endEntry.cmdId).toBe(startEntry.cmdId);
    expect(endEntry.state).toBe("done");
    expect(endEntry.output?.entries?.some((e: any) => e.kind === "interactive")).toBe(true);
    expect(endEntry.output?.needsTerminal).toBe(true);

    // Off-agent: the web path keeps the legacy shape — no history field, capture intact.
    const offWeb = await hub.rpc("webCmd", { sessionId: offInspect.sessionId, name: "agent", args: "status" });
    expect(offWeb.first.ok).toBe(true);
    expect(offWeb.first.data.completion).toBe("sync");
    expect(offWeb.first.data.output?.entries?.length).toBeGreaterThan(0);
    expect("history" in offWeb.first.data).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(readCmdEntries(offFile)).toHaveLength(0);

    // Feature token: the on-agent advertises cmd.history.v1 in its status; the off-agent does not.
    const agents = (await hub.rpc("agents")) as any[];
    const onCard = agents.find((a: any) => a.session?.sessionId === onInspect.sessionId);
    const offCard = agents.find((a: any) => a.session?.sessionId === offInspect.sessionId);
    expect(onCard?.status?.features ?? []).toContain("cmd.history.v1");
    expect(offCard?.status?.features ?? []).not.toContain("cmd.history.v1");

    await b.close();
  }, 180_000);
});

// ---------------------------------------------------------------------------
// #3 secure LOCKED — commands still run, the recorder refuses to write
// ---------------------------------------------------------------------------

describe("cmd-history I1 integration — secure LOCKED skips every write", () => {
  it("executes the command, writes no entry, counts skipped in /webhub status", async () => {
    const home = newHome();
    const b = await boot(home, [{ PI_SECURE_VAULT: "cmd-history-i1-unregistered-vault" }]);
    const agent = b.agents[0]!;
    const inspect0 = await agent.rpc("inspect");
    expect(inspect0.secureDomain).toBe("locked");
    const sessionFile: string = inspect0.sessionFile;

    const ran = await agent.rpc("tuiCmd", { name: "goal", args: "" });
    expect(ran.uiCalls.some((c: any) => c.m === "notify")).toBe(true); // the command executed
    await new Promise((r) => setTimeout(r, 500));
    expect(readCmdEntries(sessionFile)).toHaveLength(0); // LOCKED ⇒ appendEntry never called

    const status = await agent.rpc("tuiCmd", { name: "webhub", args: "status" });
    const cmdHistoryLine = status.uiCalls.map((c: any) => c.message).find((t: string) => t.startsWith("cmd-history:"));
    expect(cmdHistoryLine).toMatch(/^cmd-history: on · hub-cap (on|n\/a) · appended 0 · skipped [1-9]\d* · failed 0$/);

    await b.close();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// #4 brand-new session — hub §4.10 ENOENT fallback (records live before the first message)
// ---------------------------------------------------------------------------

describe("cmd-history I1 integration — pre-first-message sessions are served via the ENOENT fallback", () => {
  it("a session with a path but no file yet gets live appends and an agent-source snapshot", async () => {
    const home = newHome();
    const b = await boot(home, [{ CMDH_FIRST_MESSAGE: "0" }]);
    const agent = b.agents[0]!;
    const hub = b.hub;
    const inspect0 = await agent.rpc("inspect");
    const sessionId: string = inspect0.sessionId;
    const sessionFile: string = inspect0.sessionFile;
    expect(sessionFile).toBeDefined();
    expect(existsSync(sessionFile)).toBe(false); // pi creates the file only at the first message
    await hub.rpc("historySnapshot", { sessionId }); // browser opens the (empty) session

    const web = await hub.rpc("webCmd", { sessionId, name: "agent", args: "status" });
    expect(web.first.data.history).toBe("recorded");
    // In-memory record visible to the agent's own branch, while the file is still absent.
    const branchEntries = await until(
      () => agent.rpc("inspect"),
      (s) => s.cmdEntries.some((e: any) => e.cmdId === web.id),
      "record in the in-memory branch",
    );
    expect(branchEntries.cmdEntries.find((e: any) => e.cmdId === web.id).phase).toBe("end");
    // The hub served it LIVE (append) despite the ENOENT — the §4.10 branch_req fallback.
    await until(
      () => appendHasCmd(hub, web.id),
      (ok) => ok,
      `append carries ${web.id}`,
    );
    expect(existsSync(sessionFile)).toBe(false); // still no file — nothing forced a flush
    // And on "refresh": the snapshot falls back to the agent branch (source: "agent").
    const snap = await until(
      () => hub.rpc("historySnapshot", { sessionId }),
      (s) => s.entries.some((e: any) => e.cmd?.cmdId === web.id),
      "snapshot serves the record",
    );
    expect(snap.source).toBe("agent");
    expect(snap.entries.find((e: any) => e.cmd?.cmdId === web.id).cmd.state).toBe("done");

    await b.close();
  }, 120_000);
});
