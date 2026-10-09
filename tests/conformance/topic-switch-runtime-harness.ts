/**
 * S0 conformance harness (topic-switch plan.md §1 "Step 0 — conformance 探针"): drives the REAL
 * `AgentSessionRuntime` through real `/new` session replacement, real extension (re-)activation,
 * and the real `input`/`session_*` event pipeline — against a fake model runtime (no network).
 *
 * This is NOT the tui-harness pattern (`tests/conformance/tui-harness.ts`): that harness's
 * `AgentSessionRuntime` factory deliberately throws ("session replacement is not supported") because
 * it only needs `InteractiveMode.init()`. Here session replacement IS the thing under test, so the
 * factory really calls `createAgentSessionServices` + `createAgentSessionFromServices` (the same two
 * calls `main.js`'s own `createRuntime` closure makes for every `/new`/`/resume`/`/fork`), with a
 * fresh `DefaultResourceLoader` (and therefore a fresh extension activation — real pi re-activates
 * extensions on every session replacement, not just on `/reload`; confirmed by reading
 * `PI/main.js`'s `createRuntime` closure, which calls `createAgentSessionServices` unconditionally
 * on every invocation, and `resource-loader.js`'s `reload()` → `loadExtensionFactories()`, which
 * re-invokes every factory function). The probe extension below is injected via `extensionFactories`
 * (never loads this package itself) and stamps every activation with an auto-incrementing `gen`
 * counter, so S1's expected event order (`gen1 session_shutdown(new), gen2 session_start(new),
 * withSession`) is directly observable.
 *
 * `rebindSession` mirrors `PI/modes/rpc/rpc-mode.js:225-262` byte-for-byte (same
 * `commandContextActions` shape, same `uiContext` role, `mode:"rpc"`) because that is the mode
 * topic-switch's own wiring binds against in production (RPC + TUI both route through
 * `ExtensionCommandContextActions`; only the `uiContext` implementation differs, and none of S1-S9
 * depend on TUI-specific UI behavior).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  type InputEvent,
  type InputEventResult,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionBeforeSwitchEvent,
  type SessionBeforeSwitchResult,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Scripted fake model (pattern copied from tests/conformance/tui-harness.ts:117-213, itself
// copied from pi-boundary.test.ts:15-60 per plan.md §1).
// ---------------------------------------------------------------------------

export interface ScriptedTurn {
  toolCall: boolean;
  build: (model: FakeModel) => unknown;
  /** Hold this model call open until the promise resolves (deterministic ordering probes, e.g. S8). */
  gate?: Promise<void>;
}

export interface FakeModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number };
  contextWindow: number;
  maxTokens: number;
  baseUrl: string;
}

export function fakeModel(): FakeModel {
  return {
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
}

export interface FakeModelRuntime {
  streamSimple: (model: unknown, context: { messages?: unknown[] }) => unknown;
  requestMessages: unknown[][];
  requestSizes: number[];
  callCount: () => number;
}

export function fakeModelRuntime(
  model: FakeModel,
  scripted: ScriptedTurn[],
): FakeModelRuntime & Record<string, unknown> {
  let call = 0;
  const requestSizes: number[] = [];
  const requestMessages: unknown[][] = [];
  return {
    // S9 conformance note: real pi invokes `before_provider_request` (`transformProviderPayload`)
    // from deep inside the real per-provider HTTP-building code in `@earendil-works/pi-ai`'s
    // `compat.js` dispatch (e.g. `api/anthropic-messages.js`), which this fake `streamSimple`
    // replaces wholesale — so the real event is structurally unreachable here. `requestOptions`
    // (the 3rd arg) carries the SAME `onPayload` callback the real provider code would call
    // (`buildRequestOptions()` spreads the agent loop's `onPayload: transformProviderPayload`
    // straight through, confirmed by reading `core/sdk.js`'s `streamFn` — see
    // topic-switch-hop.test.ts's S9 for the full chain), so invoking it here at the same
    // call-time point reproduces the one timing property S9 cares about (is the branch state at
    // payload-build time) without needing a real HTTP layer.
    streamSimple: (
      _m: unknown,
      context: { messages?: unknown[] },
      requestOptions?: { onPayload?: (p: unknown) => unknown },
    ) => {
      requestSizes.push(context.messages?.length ?? 0);
      requestMessages.push(context.messages ?? []);
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const run = async () => {
        await requestOptions?.onPayload?.({});
        if (turn.gate) await turn.gate;
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: turn.toolCall ? "toolUse" : "stop",
          message: turn.build(model),
        } as never);
        return stream;
      };
      return run();
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getError: () => undefined,
    refresh: async () => undefined,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
    registerProvider: () => {},
    registerNativeProvider: () => {},
    registerVirtualModel: () => {},
    requestSizes,
    requestMessages,
  };
}

const FAKE_USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantTextMsg(model: FakeModel, text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...FAKE_USAGE, cost: { ...FAKE_USAGE.cost } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function textTurn(text: string): ScriptedTurn {
  return { toolCall: false, build: (m) => assistantTextMsg(m, text) };
}

// ---------------------------------------------------------------------------
// Probe events + hooks
// ---------------------------------------------------------------------------

/** One tagged lifecycle observation. `gen` identifies which activation produced it (§1's "gen"). */
export interface ProbeEvent {
  gen: number;
  t: string;
  [key: string]: unknown;
}

export interface ProbeHooks {
  onSessionStart?: (ev: SessionStartEvent, ctx: ExtensionContext, gen: number, pi: ExtensionAPI) => void;
  onSessionShutdown?: (ev: SessionShutdownEvent, ctx: ExtensionContext, gen: number, pi: ExtensionAPI) => void;
  onBeforeSwitch?: (
    ev: SessionBeforeSwitchEvent,
    ctx: ExtensionContext,
    gen: number,
    pi: ExtensionAPI,
  ) => SessionBeforeSwitchResult | undefined;
  onBeforeCompact?: (
    ev: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    gen: number,
    pi: ExtensionAPI,
  ) => SessionBeforeCompactResult | Promise<SessionBeforeCompactResult | undefined> | undefined;
  onInput?: (ev: InputEvent, ctx: ExtensionContext, gen: number, pi: ExtensionAPI) => InputEventResult | undefined;
  onAgentStart?: (ctx: ExtensionContext, gen: number, pi: ExtensionAPI) => void;
  /** Registered fresh on every activation (gen-tagged in the event log, same handler body). */
  commands?: Record<
    string,
    (args: string, ctx: ExtensionCommandContext, gen: number, pi: ExtensionAPI) => void | Promise<void>
  >;
}

/** Shared call log across every re-created `ExtensionUIContext` for one harness (mirrors
 *  `PI/modes/rpc/rpc-mode.js`'s outer `runRpcMode` scope: a fresh `uiContext` object is wired on
 *  every `rebindSession`, `createExtensionUIContext()` there too, but it all routes through the
 *  SAME outer `output()`/`pendingExtensionRequests` closure — the log here is that shared scope). */
export interface UiCallLog {
  notifications: { message: string; type?: string | undefined }[];
  statuses: Map<string, string | undefined>;
  /** Every `setEditorText`/`pasteToEditor` call, in order. NOT a live "current editor text" model:
   *  real rpc-mode.js's `getEditorText()` is a hardcoded stub ("Synchronous method can't wait for
   *  RPC response") that never reflects a prior `setEditorText` call — see S6, which asserts that
   *  exact non-readback property instead of pretending the host editor is observable here. */
  editorTextCalls: string[];
}

export function createUiCallLog(): UiCallLog {
  return { notifications: [], statuses: new Map(), editorTextCalls: [] };
}

/** One `ExtensionUIContext`, faithfully mirroring `PI/modes/rpc/rpc-mode.js`'s
 *  `createExtensionUIContext()` body for every method S1-S9 can reach (dialogs auto-decline/no-op,
 *  `getEditorText()` is pi's own hardcoded `""` stub, `pasteToEditor` delegates to `setEditorText`
 *  exactly as rpc-mode.js does) — everything else is an inert no-op stub, same as rpc-mode.js's own
 *  "not supported in RPC mode" methods. */
export function createFakeUiContext(log: UiCallLog): ExtensionUIContext {
  const ui: ExtensionUIContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type) => {
      log.notifications.push({ message, type });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      log.statuses.set(key, text);
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: (text) => {
      ui.setEditorText(text);
    },
    setEditorText: (text) => {
      log.editorTextCalls.push(text);
    },
    getEditorText: () => "", // real rpc-mode.js: "Synchronous method can't wait for RPC response"
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return {} as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "not supported in harness" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  return ui;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface ProbeHarness {
  runtime: AgentSessionRuntime;
  events: ProbeEvent[];
  hooks: ProbeHooks;
  cwd: string;
  modelRuntime: FakeModelRuntime;
  ui: UiCallLog;
  /** `ExtensionAPI` handed to the most recent activation (for timer-driven test code that is not
   *  inside any command/event handler, e.g. S3-S5's "from a timer" probes). */
  currentPi(): ExtensionAPI;
  currentGen(): number;
  session(): AgentSession;
  dispose(): Promise<void>;
}

export async function createProbeHarness(opts: {
  scripted: ScriptedTurn[];
  hooks?: ProbeHooks;
  /** Written to `<agentDir>/settings.json` before the first activation (e.g. S5 needs a tiny
   *  `compaction.keepRecentTokens` so a couple of fake turns are already eligible to compact). */
  settingsJson?: Record<string, unknown>;
}): Promise<ProbeHarness> {
  const cwd = mkdtempSync(join(tmpdir(), "topic-switch-conformance-"));
  const agentDir = join(cwd, ".pi-agent");
  if (opts.settingsJson) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(opts.settingsJson), "utf-8");
  }
  const model = fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const hooks: ProbeHooks = opts.hooks ?? {};
  const events: ProbeEvent[] = [];
  const genCounter = { n: 0 };
  const piByGen = new Map<number, ExtensionAPI>();

  const prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  const prevOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() reads env per call (config.js:421)
  process.env.PI_OFFLINE = "1"; // ensureTool("fd"/"rg") must never touch the network

  const restoreEnv = () => {
    if (prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
    if (prevOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prevOffline;
  };

  const probeFactory: ExtensionFactory = (pi) => {
    genCounter.n += 1;
    const gen = genCounter.n;
    piByGen.set(gen, pi);
    const push = (t: string, extra: Record<string, unknown> = {}) => {
      events.push({ gen, t, ...extra });
    };

    pi.on("session_start", (ev, ctx) => {
      push("session_start", { reason: ev.reason, previousSessionFile: ev.previousSessionFile });
      hooks.onSessionStart?.(ev, ctx, gen, pi);
    });
    pi.on("session_shutdown", (ev, ctx) => {
      push("session_shutdown", { reason: ev.reason, targetSessionFile: ev.targetSessionFile });
      hooks.onSessionShutdown?.(ev, ctx, gen, pi);
    });
    pi.on("session_before_switch", (ev, ctx) => {
      push("session_before_switch", { reason: ev.reason });
      return hooks.onBeforeSwitch?.(ev, ctx, gen, pi);
    });
    pi.on("session_before_compact", (ev, ctx) => {
      push("session_before_compact");
      return hooks.onBeforeCompact?.(ev, ctx, gen, pi);
    });
    pi.on("session_compact", () => push("session_compact"));
    pi.on("session_compact_failed", () => push("session_compact_failed"));
    pi.on("agent_start", (_ev, ctx) => {
      push("agent_start");
      hooks.onAgentStart?.(ctx, gen, pi);
    });
    pi.on("input", (ev, ctx) => {
      push("input", {
        text: ev.text,
        images: (ev.images ?? []).length,
        source: ev.source,
        streamingBehavior: ev.streamingBehavior,
      });
      return hooks.onInput?.(ev, ctx, gen, pi);
    });
    for (const [name, handler] of Object.entries(hooks.commands ?? {})) {
      pi.registerCommand(name, {
        description: `probe:${name}`,
        handler: async (args, ctx) => {
          push("command", { name, args });
          await handler(args, ctx, gen, pi);
        },
      });
    }
  };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: rCwd,
    agentDir: rAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const settingsManager = SettingsManager.create(rCwd, rAgentDir);
    const services = await createAgentSessionServices({
      cwd: rCwd,
      agentDir: rAgentDir,
      settingsManager,
      modelRuntime: modelRuntime as never,
      resourceLoaderOptions: { extensionFactories: [probeFactory] as never },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
      model: model as never,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  let runtime: AgentSessionRuntime;
  const uiLog = createUiCallLog();
  try {
    const sessionManager = SessionManager.inMemory(cwd);
    runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });

    const rebindSession = async (session: AgentSession) => {
      await session.bindExtensions({
        uiContext: createFakeUiContext(uiLog), // fresh object per rebind, same as rpc-mode.js
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: (o) => runtime.newSession(o),
          fork: async () => {
            throw new Error("topic-switch-runtime-harness: fork() is not wired (unused by S1-S9)");
          },
          navigateTree: async () => ({ cancelled: false }),
          switchSession: async () => {
            throw new Error("topic-switch-runtime-harness: switchSession() is not wired (unused by S1-S9)");
          },
          reload: () => session.reload(),
        },
        shutdownHandler: () => {},
        onError: (err) => {
          events.push({ gen: genCounter.n, t: "extension_error", ...err });
        },
      });
    };
    runtime.setRebindSession(rebindSession);
    await rebindSession(runtime.session);
  } catch (error) {
    restoreEnv();
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }

  return {
    runtime,
    events,
    hooks,
    cwd,
    modelRuntime,
    ui: uiLog,
    currentPi: () => {
      const pi = piByGen.get(genCounter.n);
      if (!pi) throw new Error("topic-switch-runtime-harness: no active extension API (never activated?)");
      return pi;
    },
    currentGen: () => genCounter.n,
    session: () => runtime.session,
    dispose: async () => {
      try {
        await runtime.dispose();
      } catch {
        /* best effort: some probes already tore the session down */
      } finally {
        restoreEnv();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** Small sleep helper for timer-driven probes (S3-S5, S8). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
