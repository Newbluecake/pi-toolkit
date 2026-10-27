/** XW process fixture: real activate/buildSessionStack + SessionManager and X2 sockets.
 * Only the pi host/provider is fake; no live credentials or provider requests are used. */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import activate from "../../../src/index.js";
import { getXsWakeLedger } from "../../../src/fabric/xs/wake-ledger.js";
import { getXsHostCapability } from "../../../src/fabric/xs/host-cap.js";
import { getXsEpochCounter } from "../../../src/fabric/xs/membership.js";
import { getXsReplyLedger } from "../../../src/fabric/xs/reply-ledger.js";
import { makeMessageKey } from "../../../src/core/message.js";
import { readRootLevel } from "../../../src/fabric/wake-level.js";
import { currentConnection } from "../../../src/web-hub/agent/connection.js";
import { startHub } from "../../../src/web-hub/hub/hub.js";
import type { Registry } from "../../../src/web-hub/hub/registry.js";
import type { XsDeliverFrame } from "../../../src/web-hub/protocol/xs.js";

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

const reply = (id: number, value: unknown) => process.send?.({ id, value });
/**
 * alias-force-default AF6 (mixed fleets): make this process look like a pre-v2 peer ON THE WIRE by removing
 * `xs.alias.v2` from the caps of its own outgoing handshake frame (`hello` for an agent, `hello_ack` for the hub).
 * Test fixture only — production has no such hook. The peers keep running the current code; what changes is
 * exactly what the other side can see, which is what the v2 gates key on.
 */
function stripAliasV2OnWire(frameType: "hello" | "hello_ack"): void {
  const original = Socket.prototype.write;
  const prefix = `{"t":"${frameType}"`;
  Socket.prototype.write = function (this: Socket, chunk: unknown, ...rest: unknown[]) {
    if (typeof chunk === "string" && chunk.startsWith(prefix)) {
      const frame = JSON.parse(chunk) as { caps?: string[] };
      frame.caps = (frame.caps ?? []).filter((c) => c !== "xs.alias.v2");
      chunk = `${JSON.stringify(frame)}\n`;
    }
    return (original as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof Socket.prototype.write;
}
let handle: (m: any) => Promise<unknown>;
if (process.argv[2] === "hub") {
  if (process.env.XW_HUB_STRIP_V2 === "1") stripAliasV2OnWire("hello_ack");
  let registry!: Registry;
  const slotFrames: Array<{ key: string; t: string; sessionId?: string; joined?: boolean }> = [];
  // channel-plan §12 (IBW): every agent status frame's `xsInbox` (undefined ⇒ key absent).
  const statusInbox: Array<{ key: string; xsInbox: unknown }> = [];
  const deliveries: Array<{ key: string; frame: XsDeliverFrame }> = [];
  let hold: "before" | "after" | undefined;
  let release: (() => void) | undefined;
  let barrier: Promise<void> = Promise.resolve();
  let request!: Registry["request"];
  // alias-plan AL6: the hub clock is injected through `StartHubDeps.now` (no production hook) so the
  // 10-minute take threshold can be crossed without sleeping. Only moves forward, only via the `skew` op.
  let hubSkew = 0;
  const lates = new Map<string, unknown>(); // cmd_late frames by cmdId (web command output arrives here)
  const hub = await startHub(
    {
      home: process.env.HOME!,
      port: 0,
      idleExitMinutes: 10,
      // Must equal the agent's own package version, or the hub supersedes the agent and the
      // socket never goes live — never hard-code it (a release bump broke every xs suite).
      pluginVersion: PACKAGE_VERSION,
      buildId: "xw-test",
      ...(process.env.XW_XS_OFF === "1"
        ? {}
        : {
            crossSession: {
              limits: { hubSendsPerMin: 600 },
              ...(process.env.XW_HUB_REPLY_OFF === "1" ? { reply: false } : {}),
              // channel-plan §3.1 (CHW): hub-global broadcast params (absent ⇒ hub defaults 16/4).
              ...(process.env.XW_HUB_CHANNELS_JSON ? { channels: JSON.parse(process.env.XW_HUB_CHANNELS_JSON) } : {}),
              // alias-plan AL6: `crossSession.alias` present ⇒ binding table on (key absent ⇒ legacy hub).
              ...(process.env.XW_HUB_ALIAS_JSON ? { alias: JSON.parse(process.env.XW_HUB_ALIAS_JSON) } : {}),
            },
          }),
    },
    (deps) => {
      registry = deps.registry as Registry;
      const onFrame = registry.onFrame.bind(registry);
      registry.onFrame = (key, frame) => {
        if (frame.t === "session" || frame.t === "xs_member")
          slotFrames.push({
            key,
            t: frame.t,
            sessionId: frame.sessionId,
            ...(frame.t === "xs_member" ? { joined: frame.joined } : {}),
          });
        if (frame.t === "cmd_late") lates.set((frame as any).id, frame);
        if (frame.t === "status") statusInbox.push({ key, xsInbox: (frame as any).xsInbox });
        return onFrame(key, frame);
      };
      request = registry.request.bind(registry);
      registry.request = (async (key: string, frame: any, ms: number, signal?: AbortSignal) => {
        if (frame.t !== "xs_deliver") return request(key, frame, ms, signal);
        deliveries.push({ key, frame });
        process.send?.({ event: "deliver", frame });
        const mode = hold;
        if (mode === "before") await barrier;
        const res = await request(key, frame, ms, signal);
        if (mode === "after") {
          process.send?.({ event: "acked" });
          await barrier;
        }
        return res;
      }) as Registry["request"];
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
    { now: () => Date.now() + hubSkew },
  );
  if ("exists" in hub) throw new Error("hub unexpectedly already exists");
  handle = async (m) => {
    if (m.op === "inspect") return { deliveries, slotFrames, statusInbox, agents: registry.list() };
    if (m.op === "hold") {
      hold = m.mode;
      barrier = new Promise<void>((r) => {
        release = r;
      });
      return true;
    }
    if (m.op === "release") {
      hold = undefined;
      release?.();
      return true;
    }
    if (m.op === "replay") {
      const old = deliveries[m.index ?? 0]!;
      const key = registry.list().find((a) => a.session?.sessionId === old.frame.to.sessionId)!.agentKey;
      return request(key, { ...old.frame, rid: `replay-${Date.now()}` }, 5_000);
    }
    if (m.op === "inject") {
      // Bypass the hub's early checks: hand a (modified) recorded deliver frame straight to an agent.
      const old = deliveries[m.index ?? 0]!;
      const to = m.to ?? old.frame.to;
      const key = registry.list().find((a) => a.session?.sessionId === to.sessionId)!.agentKey;
      const frame = { ...old.frame, ...(m.patch ?? {}), to, rid: `inject-${Date.now()}`, xid: m.xid };
      return request(key, frame, 5_000);
    }
    if (m.op === "webNew") {
      const agent = registry.list().find((a) => a.session?.sessionId === m.sessionId)!;
      return request(
        agent.agentKey,
        {
          t: "cmd",
          rid: `new-${Date.now()}`,
          id: `web-new-${Date.now()}`,
          deadlineMs: 4000,
          origin: { listener: "loopback", ip: "127.0.0.1", reqId: "xs-web-exec" },
          cmd: { op: "command", name: "new", args: "", confirm: true },
        },
        5000,
      );
    }
    if (m.op === "skew") {
      hubSkew += m.ms;
      return hubSkew;
    }
    if (m.op === "webCmd") {
      // alias-plan AL6: a web-origin `command` op (captured extension command) addressed to one agent, exactly
      // the shape the browser's useTrackedCommand sends. A captured command settles through the late channel:
      // like the UI we wait for the `cmd_late` frame of this cmdId and return `{first, final}` — the immediate
      // cmd_result and the late frame carrying the captured output (undefined when nothing was captured).
      const agent = registry.list().find((a) => a.session?.sessionId === m.sessionId)!;
      const id = m.cmdId ?? `web-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const mk = (extra: object) => ({
        t: "cmd",
        rid: `wc-${Date.now()}-${Math.random()}`,
        id,
        deadlineMs: 4000,
        origin: { listener: "loopback", ip: "127.0.0.1", reqId: "xs-web-cmd" },
        cmd: { op: "command", name: m.name ?? "fabric", args: m.args ?? "", ...(m.confirm ? { confirm: true } : {}) },
        ...extra,
      });
      const first: any = await request(agent.agentKey, mk({}) as any, 5000);
      let final: any;
      if (first.ok === true && first.data?.captured === true) {
        const end = Date.now() + 4000;
        while (Date.now() < end && !lates.has(id)) await new Promise((r) => setTimeout(r, 30));
        final = lates.get(id);
      }
      return { first, final };
    }
    if (m.op === "webPrompt") {
      // MW: a web composer prompt (op:prompt) addressed to one agent — exercises the web mention path.
      const agent = registry.list().find((a) => a.session?.sessionId === m.sessionId)!;
      return request(
        agent.agentKey,
        {
          t: "cmd",
          rid: `wp-${Date.now()}`,
          id: `web-prompt-${Date.now()}`,
          deadlineMs: 4000,
          origin: { listener: "loopback", ip: "127.0.0.1", reqId: "xs-web-prompt" },
          cmd: { op: "prompt", text: m.text, deliver: "steer" },
        },
        5000,
      );
    }
    if (m.op === "stop") {
      await hub.close("test");
      process.disconnect();
      return true;
    }
    throw new Error(`unknown hub op ${m.op}`);
  };
} else {
  if (process.env.XW_STRIP_V2 === "1") stripAliasV2OnWire("hello");
  // alias-force-default AF6: per-peer working directory (the cwd basename is what auto-claim derives the alias from).
  const peerCwd = process.env.XW_CWD ?? process.cwd();
  const agentDir = join(process.env.HOME!, ".pi/agent");
  mkdirSync(agentDir, { recursive: true });
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
      ...(process.env.XW_WEB_POLICY_JSON ? { webCommandPolicy: JSON.parse(process.env.XW_WEB_POLICY_JSON) } : {}),
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
      wake: {
        enabled: true,
        maxLevel: process.env.XW_WAKE_MAX_LEVEL ? Number(process.env.XW_WAKE_MAX_LEVEL) : 5,
        rootRunMaxS: 60,
      },
      crossSession: {
        enabled: process.env.XW_XS_OFF !== "1",
        autoJoin: process.env.XW_AUTO_JOIN === "1",
        ...(process.env.XW_REPLY_OFF === "1" ? { reply: { enabled: false } } : {}),
        ...(process.env.XW_RECEIVE ? { receive: process.env.XW_RECEIVE } : {}),
        ...(process.env.XW_REPLY_JSON ? { reply: JSON.parse(process.env.XW_REPLY_JSON) } : {}),
        // channel-plan §6.4 (CHW): `fabric.crossSession.channels` overrides.
        ...(process.env.XW_CHANNELS_JSON ? { channels: JSON.parse(process.env.XW_CHANNELS_JSON) } : {}),
        // alias-plan AL6: `fabric.crossSession.alias` overrides (e.g. {"enabled":false} = a pre-alias agent).
        ...(process.env.XW_ALIAS_JSON ? { alias: JSON.parse(process.env.XW_ALIAS_JSON) } : {}),
        limits: { listPerMin: 60, pairMinIntervalMs: 5000, pairWakesPerHour: 20, wakesOutPerHour: 60 },
      },
    },
  };
  writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify(config));
  const sessionDir = join(process.env.PI_CODING_AGENT_DIR!, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const newSession = () => {
    const session = SessionManager.create(peerCwd, sessionDir);
    session.appendMessage({ role: "user", content: "fixture startup", timestamp: Date.now() });
    // MW: published session name (bare `@name` needs a row `name`); opt-in so older suites stay unnamed.
    if (process.env.XW_SESSION_NAME === "1") session.appendSessionInfo(process.env.XW_NAME!);
    return session;
  };
  let sm = process.env.XW_SESSION_FILE ? SessionManager.open(process.env.XW_SESSION_FILE, sessionDir) : newSession();
  let idle = true,
    deferred = false,
    aborts = 0;
  let holdResolve = false;
  // AF7: hold bare alias `get`s (the reconcile) so a test can freeze the agent's alias cache while the hub moves on.
  let holdAliasGets = false;
  let aliasGateWaiters: Array<() => void> = [];
  let aliasGatePatched = false;
  let releaseResolve: (() => void) | undefined;
  const bus = new EventEmitter();
  let handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>(),
    commands = new Map<string, any>();
  // Wall-clock skew (reply tests): ledger/gate/receiver all read Date.now, timers stay real.
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  const replyNotices: any[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  // MW: @mention surface — user messages that fell through to the native path, mention notices,
  // and the autocomplete provider factories registered through ctx.ui (XW_UI=1).
  const userMessages: string[] = [];
  const mentionNotices: any[] = [];
  let turns = 0; // sendMessage calls that asked for a model turn
  const autocompleteFactories: Function[] = [];
  const messages: any[] = [],
    queued: any[] = [],
    notifications: string[] = [];
  // alias-force-default AF6: XW_TUI_CONFIRM=1 ⇒ a TUI-mode peer whose `ui.confirm` is recorded and answered by the
  // `confirmAnswer` op (default yes) — the interactive force/take confirmation path. Absent ⇒ rpc mode, unchanged.
  const tuiConfirm = process.env.XW_TUI_CONFIRM === "1";
  let confirmAnswer = true;
  const confirms: Array<{ title: string; detail: string }> = [];
  const ctx: any = {
    cwd: peerCwd,
    mode: tuiConfirm ? "tui" : "rpc",
    hasUI: process.env.XW_UI === "1",
    get sessionManager() {
      return sm;
    },
    isIdle: () => idle,
    hasPendingMessages: () => queued.length > 0,
    abort: () => {
      aborts++;
      idle = true;
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    getContextUsage: () => undefined,
    ui: {
      notify: (text: string) => notifications.push(text),
      confirm: async (title: string, detail: string) => {
        confirms.push({ title, detail });
        return confirmAnswer;
      },
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      setWidget() {},
      // a TUI-mode peer (XW_TUI_CONFIRM=1) reaches the TUI-only session_start hooks
      getEditorComponent: () => undefined,
      setEditorComponent() {},
      addAutocompleteProvider: (factory: Function) => autocompleteFactories.push(factory),
    },
  };
  async function fire(type: string, extra: object = {}) {
    for (const h of [...(handlers.get(type) ?? [])]) await h({ type, ...extra }, ctx);
  }
  const append = (m: any) => sm.appendCustomMessageEntry(m.customType, m.content, m.display ?? false, m.details);
  const pi: any = {
    on(type: string, h: Function) {
      handlers.set(type, [...(handlers.get(type) ?? []), h]);
    },
    registerTool(t: any) {
      tools.set(t.name, t);
    },
    registerCommand(n: string, c: any) {
      commands.set(n, c);
    },
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry: (kind: string, data: unknown) => sm.appendCustomEntry(kind, data),
    getAllTools: () => [...tools.values()],
    getCommands: () => [...commands].map(([name, c]) => ({ name, description: c.description, source: "extension" })),
    getActiveTools: () => [...tools.keys()],
    setActiveTools() {},
    getSessionName: () => process.env.XW_NAME,
    sendMessage(m: any, options: any) {
      if (m.customType === "subagent:xs-reply") replyNotices.push({ ...m, triggerTurn: options?.triggerTurn === true });
      if (m.customType === "subagent:mention-session" || m.customType === "subagent:mention-error")
        mentionNotices.push({ ...m, triggerTurn: options?.triggerTurn === true });
      if (m.customType === "subagent:xs") messages.push({ ...m, triggerTurn: options?.triggerTurn === true });
      if (options?.triggerTurn) turns++;
      if (idle || options?.triggerTurn) append(m);
      else queued.push(m);
      if (options?.triggerTurn && !deferred) {
        idle = false;
        void fire("before_agent_start", { messageType: "custom", message: m, systemPrompt: "host" });
      }
    },
    sendUserMessage(text: string) {
      userMessages.push(text);
      // alias-plan AL6 (opt-in XW_RUN_SLASH=1): like pi, a slash command sent as a user message runs its (capture-wrapped) handler
      // inside this call stack — this is how a web `command` op reaches an extension command.
      const slash = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
      const handler = slash === null || process.env.XW_RUN_SLASH !== "1" ? undefined : commands.get(slash[1]!)?.handler;
      if (handler !== undefined) void Promise.resolve(handler(slash![2] ?? "", ctx)).catch(() => {});
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: {
      on(name: string, fn: any) {
        bus.on(name, fn);
        return () => bus.off(name, fn);
      },
      emit: (name: string, data: unknown) => bus.emit(name, data),
    },
  };
  async function boot(reason: string) {
    activate(pi);
    await fire("session_start", { reason });
  }
  await boot("startup");
  handle = async (m) => {
    if (m.op === "tool")
      return (await tools.get(m.name).execute("xw-call", m.params ?? {}, undefined, undefined, ctx)).details;
    if (m.op === "cmd") {
      await commands.get(m.name ?? "fabric").handler(m.args ?? "status", ctx);
      return notifications.at(-1);
    }
    if (m.op === "prime") {
      await fire("before_agent_start", { messageType: "user", prompt: "human", systemPrompt: "host" });
      return true;
    }
    if (m.op === "event") {
      await fire(m.type, m.extra);
      return true;
    }
    if (m.op === "busy") {
      idle = !m.busy;
      deferred = m.deferred === true;
      return true;
    }
    if (m.op === "settle") {
      idle = true;
      while (queued.length) append(queued.shift());
      await fire("agent_settled");
      return true;
    }
    if (m.op === "input") {
      await fire("input", { source: m.source ?? "rpc", text: "human" });
      return true;
    }
    if (m.op === "mention") {
      // TUI input path: run every `input` handler in order, stop at the first `handled`.
      const results: any[] = [];
      for (const h of [...(handlers.get("input") ?? [])]) {
        const r = await h({ type: "input", source: "interactive", text: m.text }, ctx);
        results.push(r ?? null);
        if (r?.action === "handled") break;
      }
      return results;
    }
    if (m.op === "complete") {
      // Autocomplete: stack every registered factory over an empty base provider.
      let provider: any = { getSuggestions: async () => null, applyCompletion: () => ({}) };
      for (const factory of autocompleteFactories) provider = factory(provider);
      return provider.getSuggestions([m.text], 0, m.text.length, { signal: new AbortController().signal });
    }
    if (m.op === "holdResolve") {
      holdResolve = true;
      const conn = currentConnection()!;
      const original = conn.request.bind(conn);
      conn.request = (async (frame: any, cap: any) => {
        const result = await original(frame, cap);
        if (holdResolve && frame.t === "xs_req" && frame.op === "resolve") {
          process.send?.({ event: "resolved" });
          await new Promise<void>((r) => {
            releaseResolve = r;
          });
        }
        return result;
      }) as typeof conn.request;
      return true;
    }
    if (m.op === "holdAlias") {
      holdAliasGets = true;
      const conn = currentConnection()!;
      if (!aliasGatePatched) {
        aliasGatePatched = true;
        const original = conn.request.bind(conn);
        conn.request = (async (frame: any, cap: any) => {
          if (
            holdAliasGets &&
            frame.t === "xs_req" &&
            frame.op === "alias" &&
            frame.alias === undefined &&
            frame.clear === undefined &&
            frame.intent === undefined
          )
            await new Promise<void>((r) => aliasGateWaiters.push(r));
          return original(frame, cap);
        }) as typeof conn.request;
      }
      return true;
    }
    if (m.op === "releaseAlias") {
      holdAliasGets = false;
      for (const r of aliasGateWaiters.splice(0)) r();
      return true;
    }
    // AF7: an arbitrary `op:"alias"` request as THIS peer (origin = its current sid/epoch) — used to forge handoffs.
    if (m.op === "rawAlias") {
      const conn = currentConnection()!;
      const frame = {
        t: "xs_req",
        rid: `raw-${Math.random().toString(16).slice(2, 12)}`,
        op: "alias",
        origin: { sessionId: sm.getSessionId(), epoch: getXsEpochCounter().value },
        ...(m.fields ?? {}),
      };
      return conn.request(frame as any, "xs.v1");
    }
    if (m.op === "releaseResolve") {
      holdResolve = false;
      releaseResolve?.();
      return true;
    }
    if (m.op === "reload" || m.op === "replace") {
      const reason = m.op === "reload" ? "reload" : (m.reason ?? "new");
      if (reason !== "reload")
        await fire(reason === "fork" ? "session_before_fork" : "session_before_switch", { reason });
      await fire("session_shutdown", { reason });
      if (reason === "reload") currentConnection()?.close("test-reload");
      if (reason !== "reload") {
        const old = sm;
        sm = reason === "resume" ? SessionManager.open(m.file ?? old.getSessionFile()!, sessionDir) : newSession();
        idle = true;
        queued.length = 0;
        if (reason === "fork")
          for (const e of old.getBranch()) if (e.type === "custom") sm.appendCustomEntry(e.customType, e.data);
      }
      handlers = new Map();
      tools.clear();
      commands.clear();
      await boot(reason);
      return { sessionId: sm.getSessionId(), ledger: getXsWakeLedger().size };
    }
    if (m.op === "seedTree") {
      const run = "r_ABCDEFGH",
        now = Date.now();
      sm.appendCustomEntry("subagent:run", { runId: run, parentRunId: "root", status: "running" });
      sm.appendCustomEntry("subagent:fabric", {
        key: makeMessageKey(run, "root", 1, now),
        from: run,
        to: "root",
        kind: "finding",
        seq: 1,
        generation: now,
        payload: { text: "tree finding" },
        ttlMs: 100_000,
        createdAt: now,
        updatedAt: now,
        state: "pending",
        attempts: 0,
        level: m.level,
        wake: m.wake,
      });
      return true;
    }
    if (m.op === "seedLedger") {
      for (let i = 0; i < (m.count ?? 1); i++) {
        const token = `seed-${Date.now()}-${i}`;
        getXsWakeLedger().put({
          token,
          xid: token,
          sessionId: sm.getSessionId(),
          dispatchedAt: Date.now() - 30_000,
          deadlineAt: Date.now() - 1000,
        });
        if (m.stuck)
          getXsWakeLedger().update(token, {
            started: true,
            executionPending: true,
            abortIssuedAt: Date.now() - 20_000,
          });
        else getXsWakeLedger().tombstone(token);
      }
      return getXsWakeLedger().size;
    }
    if (m.op === "skew") {
      skew += m.ms;
      return skew;
    }
    if (m.op === "confirmAnswer") {
      confirmAnswer = m.answer === true;
      return true;
    }
    if (m.op === "clearReplyLedger") {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-reply-ledger")];
      return true;
    }
    if (m.op === "settingsChannels") {
      (config.fabric.crossSession as Record<string, unknown>).channels = m.channels;
      writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify(config));
      return true;
    }
    if (m.op === "settingsOff") {
      if (m.wakeOnly) config.fabric.wake.enabled = false;
      else config.fabric.crossSession.enabled = false;
      writeFileSync(join(agentDir, "pi-subagent.json"), JSON.stringify(config));
      return true;
    }
    if (m.op === "inspect")
      return {
        sessionId: sm.getSessionId(),
        sessionFile: sm.getSessionFile(),
        conn: currentConnection()?.status(),
        messages,
        queued: queued.length,
        ledger: getXsWakeLedger().entries(),
        owned: getXsWakeLedger().hasOwner(sm.getSessionId()),
        capability: getXsHostCapability().state,
        toolNames: [...tools.keys()],
        level: readRootLevel(sm.getBranch()),
        aborts,
        members: sm.getBranch().filter((e) => e.type === "custom" && e.customType === "subagent:xs-membership"),
        notifications,
        confirms,
        userMessages,
        mentionNotices,
        turns,
        epoch: getXsEpochCounter().value,
        dropped: getXsReplyLedger().droppedNoticeCount(sm.getSessionId()),
        replyTickets: getXsReplyLedger().entries(),
        replyNotices,
        statuses,
        replyEntries: sm
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === "subagent:xs-reply")
          .map((e: any) => e.data),
        busListeners: bus.eventNames().reduce((n, k) => n + bus.listenerCount(k), 0),
      };
    if (m.op === "stop") {
      await fire("session_shutdown", { reason: "quit" });
      currentConnection()?.close("test");
      return {
        listeners: bus.eventNames().reduce((n, k) => n + bus.listenerCount(k), 0),
        ledger: getXsWakeLedger().size,
      };
    }
    throw new Error(`unknown agent op ${m.op}`);
  };
}
process.on("message", (m: any) => {
  void handle(m).then(
    (value) => reply(m.id, value),
    (e) => process.send?.({ id: m.id, error: String(e?.stack ?? e) }),
  );
});
process.send?.({ ready: true });
