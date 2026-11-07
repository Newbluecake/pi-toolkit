/** FTR process fixture (rebind-plan r3 A18): REAL hub child (startHub × fake Feishu HTTP+ws,
 *  threads.rebind gated by env, crossSession relay on) × REAL agent children (full `activate()`,
 *  per-peer settings, scripted PiSessionDriver — only the pi host/provider and the child-session
 *  processes are faked). Sibling of fabric-xs-process.ts; the feishu half mirrors the CHILD script
 *  of tests/integration/fabric-thread-e2e.test.ts.
 *
 *  Roles (process.argv[2]):
 *   - "hub":   ops `send {raw}` (inject a feishu ws event), `inspect` (sent receipts, caps, ws),
 *              `regs` (registry: sid/caps/connected per agent), `stop`.
 *   - "agent": ops `tool {name, params}` (execute a REAL registered tool), `cmd {name, args}`
 *              (run a REAL command), `inspect` (sid, conn, caps, userMessages, xs messages, teed
 *              inbound cmd frames, scripted-run steer logs), `stop`.
 *
 *  Env: HOME (shared — the hub socket lives under it), PI_CODING_AGENT_DIR (per agent — the
 *  settings file `pi-toolkit.json` is written there), FT_REBIND ("0" ⇒ fabric.threads.rebind off
 *  for THIS agent only — the A10 mixed-caps leg), FT_HUB_REBIND ("0" ⇒ hub threads.rebind off).
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import activate from "../../../src/index.js";
import { PiSessionDriver } from "../../../src/runtime/session-driver.js";
import { currentConnection } from "../../../src/web-hub/agent/connection.js";
import { startHub } from "../../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createCredentialStore } from "../../../src/web-hub/hub/feishu/credentials.js";
import { encodeFrame } from "../../../src/web-hub/hub/feishu/frame.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import { normalizeFeishuBotHubConfig } from "../../../src/web-hub/protocol/feishu.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { createFakeFeishu } from "../../fixtures/feishu/fake-http.js";
import { createFakeWsServer } from "../../fixtures/feishu/fake-ws-server.js";

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

const reply = (id: number, value: unknown) => process.send?.({ id, value });
let handle: (m: Record<string, unknown>) => Promise<unknown>;

if (process.argv[2] === "hub") {
  // ------------------------------------------------------------------ hub role
  const home = process.env.HOME!;
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
  const fake = createFakeFeishu({ appId: "cli_test" });
  fake.on("POST", "/callback/ws/endpoint", () => ({
    json: {
      code: 0,
      data: {
        URL: "wss://msg-frontier.feishu.cn/ws?service_id=33&device_id=ftr-device",
        ClientConfig: { PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 },
      },
    },
  }));
  const ws = await createFakeWsServer();
  const feishuBot = normalizeFeishuBotHubConfig({
    allowGroups: true,
    groupRootTopics: true,
    notify: "bound",
    spawnScope: "known",
    debounceMs: 0,
    staleMessageS: 300,
    files: { outbound: "auto", inbound: false, maxInboundMiB: 30 },
    threads: {
      handbackWindowMin: 10,
      startTimeoutMin: 8,
      retainMin: 15,
      replyPerThreadPerMin: 60,
      replyPerThreadPerHour: 600,
      // rebind-plan r3 §4.1: the hub-side gate (drives hello caps + the rebind/acquire ops).
      ...(process.env.FT_HUB_REBIND === "0" ? {} : { rebind: true }),
    },
  });
  const store = createCredentialStore({ dir: paths.stateDir + "/feishu-bot" });
  await store.load();
  if (!store.current()) {
    const saved = await store.commit({
      brand: "feishu",
      appId: fake.appId,
      appSecret: fake.appSecret,
      ownerOpenId: "ou_owner",
      botOpenId: "ou_bot",
    });
    if (!saved.ok) throw new Error("fixture credentials: " + saved.reason);
  }
  let registry!: Registry;
  const hub = await startHub(
    {
      home,
      port: 0,
      idleExitMinutes: 10,
      // Must equal the agent's own package version or the hub supersedes the agent (xw precedent).
      pluginVersion: PACKAGE_VERSION,
      buildId: "ftr-test",
      feishuBot,
      // xs relay for the A18 `message_session{to:sid}` dispatch leg.
      crossSession: { limits: { hubSendsPerMin: 600 } },
    },
    (deps) => {
      registry = deps.registry as Registry;
      return createHttpFrontend(deps);
    },
    { feishuSeams: { fetch: fake.fetch, webSocket: () => new WebSocket(ws.url) } },
  );
  if ("exists" in hub) throw new Error("unexpected existing hub");
  let wireSeq = 0;
  handle = async (m) => {
    if (m.op === "send") {
      const peer = ws.peers.filter((p) => !p.closed).at(-1);
      if (!peer) throw new Error("fake ws not connected");
      peer.send(
        encodeFrame({
          seqId: BigInt(++wireSeq),
          logId: 2n,
          service: 33,
          method: 1,
          headers: [
            { key: "type", value: "event" },
            { key: "message_id", value: "wire-" + wireSeq },
            { key: "sum", value: "1" },
            { key: "seq", value: "0" },
          ],
          payloadEncoding: "",
          payload: Buffer.from(JSON.stringify(m.raw)),
        }),
      );
      return true;
    }
    if (m.op === "inspect")
      return {
        sent: fake.sent,
        livePeers: ws.peers.filter((p) => !p.closed).length,
        caps: hub.info.caps,
        wsIn: ws.peers.reduce((n, p) => n + (p.received?.length ?? 0), 0),
      };
    if (m.op === "regs")
      return registry.list().map((a) => ({
        sid: a.session?.sessionId,
        caps: registry.xsView(a.agentKey)?.caps ?? [],
        connected: registry.isConnected(a.agentKey),
        detached: a.detached === true,
      }));
    if (m.op === "stop") {
      await hub.close("test");
      await ws.dispose();
      process.disconnect();
      return true;
    }
    throw new Error(`unknown hub op ${String(m.op)}`);
  };
} else {
  // ------------------------------------------------------------------ agent role
  const rebindOn = process.env.FT_REBIND !== "0";
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(agentDir, { recursive: true });
  // Per-peer settings (PI_CODING_AGENT_DIR is the primary settings location): threads ON, the
  // rebind gate per-peer, xs on (the message_session leg), every other feature off (xw posture).
  const config = {
    fleetWidget: false,
    webSearch: { enabled: false },
    date: { enabled: false },
    todo: { enabled: false },
    memory: { enabled: false },
    hud: { enabled: false },
    feishuNotify: { enabled: false },
    sessionNav: { enabled: false },
    askUser: { enabled: false },
    title: { enabled: false },
    topicSwitch: { enabled: false },
    quota: { enabled: false },
    load: { enabled: false },
    cacheTtl: { keepalive: false },
    compact: { dynamicThreshold: { mode: "off" } },
    bashJobs: { autoBackgroundMs: 0 },
    systemPrompt: { mode: "legacy" },
    webHub: {
      enabled: true,
      autoStart: false,
      control: true,
      uploads: "off",
      preview: "off",
      avatar: false,
      privacy: false,
      subagentTranscript: "off",
      commandComplete: "off",
      quota: false,
      load: false,
    },
    fabric: {
      enabled: true,
      minIntervalMs: 0,
      rootMinIntervalMs: 0,
      wake: { enabled: true, maxLevel: 5, rootRunMaxS: 60 },
      crossSession: {
        enabled: true,
        autoJoin: false,
        limits: { listPerMin: 60, pairMinIntervalMs: 5000, pairWakesPerHour: 20, wakesOutPerHour: 60 },
      },
      threads: { enabled: true, ...(rebindOn ? { rebind: true } : {}) },
    },
  };
  writeFileSync(join(agentDir, "pi-toolkit.json"), JSON.stringify(config));
  const sessionDir = join(agentDir, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sm = SessionManager.create(process.cwd(), sessionDir);
  sm.appendMessage({ role: "user", content: "fixture startup", timestamp: Date.now() });

  // Scripted child-session driver (the fabric-thread-e2e precedent, vitest-free): `prompt` stays
  // pending so the run keeps running; steer channels are recorded for the parent's assertions.
  const scriptedRuns: Array<{ prompted: boolean; steered: string[] }> = [];
  (PiSessionDriver.prototype as unknown as { create: unknown }).create = async () => {
    const rec = { prompted: false, steered: [] as string[] };
    scriptedRuns.push(rec);
    const handle: Record<string, unknown> = {
      sessionId: "ftr-child-" + scriptedRuns.length,
      sessionFile: undefined,
      prompt: () => {
        const emit = () => {
          const cb = (handle as { __ftrEvents?: (e: { t: string }) => void }).__ftrEvents;
          cb?.({ t: "input_accepted" });
          cb?.({ t: "turn_start" });
        };
        setTimeout(emit, 0);
        rec.prompted = true;
        return new Promise<void>(() => undefined); // never settles ⇒ run stays running
      },
      steer: async (text: string) => {
        rec.steered.push(text);
      },
      steerDisposition: async (text: string) => {
        rec.steered.push(text);
        return "queued";
      },
      requestAbort: async () => undefined,
      dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
      killableHandles: new Set(),
      setActiveTools() {},
      getActiveTools: () => [],
      getLastAssistantText: () => "done",
      getUsage: () => undefined,
    };
    return handle;
  };
  (PiSessionDriver.prototype as unknown as { bind: unknown }).bind = async (h: unknown, cb: unknown) => {
    (h as { __ftrEvents?: unknown }).__ftrEvents = cb;
  };

  // Inbound wire tee (A10's byte-shape assertions): every hub→agent NDJSON line, parsed.
  const cmdFrames: Array<Record<string, unknown>> = [];
  let teeBuf = "";
  const origEmit = Socket.prototype.emit;
  Socket.prototype.emit = function (this: Socket, ev: string | symbol, ...args: unknown[]) {
    if (ev === "data" && args[0] !== undefined) {
      teeBuf += (args[0] as Buffer).toString("utf8");
      let nl = teeBuf.indexOf("\n");
      while (nl >= 0) {
        const line = teeBuf.slice(0, nl);
        teeBuf = teeBuf.slice(nl + 1);
        if (line.trim() !== "") {
          try {
            const frame = JSON.parse(line) as Record<string, unknown>;
            if (frame.t === "cmd") cmdFrames.push(frame);
            if (cmdFrames.length > 200) cmdFrames.shift();
          } catch {
            /* partial line at a chunk boundary — the next chunk completes it */
          }
        }
        nl = teeBuf.indexOf("\n");
      }
    }
    return origEmit.call(this, ev, ...args);
  } as typeof Socket.prototype.emit;

  const bus = new EventEmitter();
  const handlers = new Map<string, Array<Function>>();
  const tools = new Map<string, { execute: Function }>();
  const commands = new Map<string, { description?: string; handler: Function }>();
  const userMessages: string[] = [];
  const xsMessages: Array<Record<string, unknown>> = [];
  const notifications: string[] = [];
  const queued: Array<unknown> = [];
  let idle = true;
  const ctx: Record<string, unknown> = {
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: false,
    sessionManager: sm,
    isIdle: () => idle,
    hasPendingMessages: () => queued.length > 0,
    abort: () => {
      idle = true;
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    getContextUsage: () => undefined,
    ui: {
      notify: (text: string) => notifications.push(text),
      confirm: async () => true,
      setStatus() {},
      setWidget() {},
      getEditorComponent: () => undefined,
      setEditorComponent() {},
      addAutocompleteProvider() {},
    },
  };
  async function fire(type: string, extra: object = {}) {
    for (const h of [...(handlers.get(type) ?? [])]) await h({ type, ...extra }, ctx);
  }
  const append = (m: { customType: string; content: string; display?: boolean; details?: unknown }) =>
    sm.appendCustomMessageEntry(m.customType, m.content, m.display ?? false, m.details);
  const pi = {
    on(type: string, h: Function) {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
    },
    registerTool(t: { name: string; execute: Function }) {
      tools.set(t.name, t);
    },
    registerCommand(n: string, c: { description?: string; handler: Function }) {
      commands.set(n, c);
    },
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry: (kind: string, data: unknown) => sm.appendCustomEntry(kind, data),
    getAllTools: () => [...tools.values()],
    getCommands: () => [...commands].map(([name, c]) => ({ name, description: c.description, source: "extension" })),
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    getSessionName: () => process.env.FT_NAME,
    sendMessage(m: { customType: string }, options?: { triggerTurn?: boolean }) {
      if (m.customType === "subagent:xs") xsMessages.push({ ...m, triggerTurn: options?.triggerTurn === true });
      if (idle || options?.triggerTurn === true) append(m as never);
      else queued.push(m);
      if (options?.triggerTurn === true) {
        idle = false;
        void fire("before_agent_start", { messageType: "custom", message: m, systemPrompt: "host" });
      }
    },
    sendUserMessage(text: string) {
      userMessages.push(text);
      // The REAL pi fires `input` synchronously from sendUserMessage (fabric-thread-e2e precedent)
      // — mirror it so the native-path feishu reply settles `observed` immediately.
      for (const h of [...(handlers.get("input") ?? [])]) h({ type: "input", source: "extension", text }, ctx);
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: {
      on(name: string, fn: (data: unknown) => void) {
        bus.on(name, fn);
        return () => bus.off(name, fn);
      },
      emit: (name: string, data: unknown) => bus.emit(name, data),
    },
  };
  activate(pi as never);
  await fire("session_start", { reason: "startup" });

  handle = async (m) => {
    if (m.op === "tool") {
      const tool = tools.get(m.name as string);
      if (tool === undefined) throw new Error(`tool ${String(m.name)} not registered`);
      const out = (await tool.execute("ftr-call", m.params ?? {}, undefined, undefined, ctx)) as {
        content?: Array<{ type: string; text: string }>;
        details?: unknown;
      };
      return { text: out.content?.[0]?.text ?? "", details: out.details };
    }
    if (m.op === "cmd") {
      const cmd = commands.get((m.name as string) ?? "fabric");
      if (cmd === undefined) throw new Error(`command ${String(m.name)} not registered`);
      await cmd.handler((m.args as string) ?? "", ctx);
      return notifications.at(-1);
    }
    if (m.op === "inspect")
      return {
        sessionId: sm.getSessionId(),
        conn: currentConnection()?.status(),
        caps: currentConnection()?.caps,
        toolNames: [...tools.keys()],
        // the REGISTERED tool schemas (A10: the legacy/rebind thread-surface split is a schema-level gate)
        toolSchemas: Object.fromEntries(
          [...tools.entries()].map(([name, t]) => [name, (t as { parameters?: unknown }).parameters]),
        ),
        userMessages,
        xsMessages,
        notifications,
        queued: queued.length,
        runs: scriptedRuns.map((r) => ({ prompted: r.prompted, steered: r.steered })),
        frames: cmdFrames,
      };
    if (m.op === "stop") {
      await fire("session_shutdown", { reason: "quit" });
      currentConnection()?.close("test");
      return true;
    }
    throw new Error(`unknown agent op ${String(m.op)}`);
  };
}

process.on("message", (m: { id: number }) => {
  void handle(m).then(
    (value) => reply(m.id, value),
    (e) => process.send?.({ id: m.id, error: String((e as Error)?.stack ?? e) }),
  );
});
process.send?.({ ready: true });
