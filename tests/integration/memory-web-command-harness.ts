/** Isolated real SDK host shared by #65 integration/conformance and the browser probe.
 * No fabricated ExtensionContext: session_start supplies the actual SDK context.
 * Observers delegate to real methods; barriers are outside the synchronous consumer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEFAULT_MEMORY_SETTINGS } from "../../src/memory/settings.js";
import { wireMemory } from "../../src/memory/index.js";
import { wireMemoryScopes, type MemoryScopesWiring } from "../../src/memory/scopes/wire.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { createBuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import { createCommandHandler } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createDialogBridge } from "../../src/web-hub/agent/dialogs.js";
import { canonicalJson, sha256Hex } from "../../src/memory/scopes/limits.js";
import type { FrozenPlan } from "../../src/memory/scopes/session-store.js";
import type { CmdFrame } from "../../src/web-hub/protocol/messages.js";

export async function createMemoryWebHost(mode: "memory" | "buffered" | "persisted" = "memory") {
  const cwd = mkdtempSync(join(tmpdir(), "memory-web-sdk-"));
  const agentDir = join(cwd, "agent");
  const manager = mode === "memory" ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(cwd, "sessions"));
  const trace: Array<{ event: string; [key: string]: unknown }> = [];
  const listeners = new Set<(event: string, data: unknown) => void>();
  const publish = (event: string, data: unknown) => {
    for (const fn of listeners) fn(event, data);
  };
  const epoch = randomUUID();
  const agentKey = `memory-${epoch}`;
  let ctx!: ExtensionContext;
  let pi!: ExtensionAPI;
  let scopes!: MemoryScopesWiring;
  let memory!: ReturnType<typeof wireMemory>;
  let nativeCalls = 0,
    modelCalls = 0,
    appendCount = 0,
    memSendUserMessage = 0;
  let settledBarrier: Promise<void> | undefined;
  let settledRelease: (() => void) | undefined;
  let settledEntered = false;
  let observedHook: (() => void) | undefined;
  let modelBarrier: Promise<void> | undefined;
  let modelRelease: (() => void) | undefined;
  let now = Date.now();
  let controlEnabled = true;
  const timers = new Set<{ due: number; fn(): void }>();
  const dialog = createDialogBridge({
    enabled: true,
    epoch,
    isAttached: () => true,
    setSlot: (_kind, frame) => publish("dialogs", frame),
    now: () => now,
  });
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    scopes: { session: true, hub: false },
    jev: { ...DEFAULT_MEMORY_SETTINGS.jev, enabled: false },
    doctor: { ...DEFAULT_MEMORY_SETTINGS.doctor, notifyOnStart: false },
  };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (api) => {
        pi = {
          ...api,
          registerCommand(name, definition) {
            api.registerCommand(
              name,
              name === "mem"
                ? {
                    ...definition,
                    handler: async (args, actual) => {
                      nativeCalls++;
                      return definition.handler(args, actual);
                    },
                  }
                : definition,
            );
          },
          sendUserMessage(content, options) {
            if (typeof content === "string" && content.startsWith("/mem")) memSendUserMessage++;
            return api.sendUserMessage(content, options);
          },
        };
        scopes = wireMemoryScopes(api, {
          settings,
          child: false,
          domain: "plain",
          gate: { check: () => ({ ok: true }) },
          locked: () => false,
          remote: () => dialog,
          hubPaths: () => undefined,
        })!;
        const sections = createPromptSectionHub(api, {
          mode: () => "stable",
          wakeReplay: false,
          adoptForeignForcedPrompt: false,
        });
        memory = wireMemory(pi, { settings, scopes, isChildSession: false, secureDomainKind: "plain", sections });
        api.on("session_start", (_event, actual) => {
          ctx = actual;
        });
        api.on("agent_settled", () => {
          settledEntered = true;
          return settledBarrier;
        });
      },
    ],
  });
  await loader.reload();
  const model = {
    id: "offline",
    name: "offline",
    api: "anthropic-messages",
    provider: "offline",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200000,
    maxTokens: 1000,
  };
  const runtime = {
    streamSimple: () => {
      modelCalls++;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "offline" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      } as never);
      return modelBarrier ? modelBarrier.then(() => stream) : stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: manager,
    settingsManager,
    resourceLoader: loader,
    model: model as never,
    modelRuntime: runtime as never,
    tools: [],
  });
  await session.bindExtensions({ mode: "rpc" });
  if (!ctx || !memory.webWrite || !scopes.current()?.session) throw Error("real SDK assembly unavailable");
  if (mode === "persisted") await session.prompt("offline flush baseline");
  const store = scopes.current()!.session!;
  const actualAbort = session.abort.bind(session);
  session.abort = (...args) => {
    trace.push({ event: "sdk-abort" });
    return actualAbort(...args);
  };
  const actualStart = memory.webWrite.start.bind(memory.webWrite);
  memory.webWrite.start = (...args) => {
    const result = actualStart(...args);
    if (!result.accepted) return result;
    const task = result.task;
    return {
      accepted: true,
      task: {
        done: task.done,
        cancel(reason) {
          trace.push({ event: "task-cancel", reason });
          return task.cancel(reason);
        },
        release() {
          trace.push({ event: "task-release" });
          task.release();
        },
      },
    };
  };
  let plan: FrozenPlan | undefined;
  let commitRelease: (() => void) | undefined;
  let commitBarrier: Promise<void> | undefined;
  let appendHook: (() => void) | undefined;
  const prepare = store.prepareWebAdd;
  store.prepareWebAdd = async (...args) => {
    const result = await prepare(...args);
    if (result.ok) {
      plan = result.plan;
      trace.push({ event: "prepared", hash: plan.expectedNewContentHash });
    }
    return result;
  };
  const commit = store.enqueueConfirmedCommand;
  store.enqueueConfirmedCommand = async (...args) => {
    trace.push({ event: "commit-enqueued" });
    if (commitBarrier) await commitBarrier;
    const result = await commit(...args);
    trace.push({ event: "commit-observed", result });
    observedHook?.();
    return result;
  };
  const append = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = (type, data) => {
    if (type === "subagent:memory-session") {
      appendCount++;
      trace.push({ event: "sdk-append" });
      appendHook?.();
    }
    return append(type, data);
  };
  const cancel = store.cancelWeb;
  store.cancelWeb = (...args) => {
    const outcome = cancel(...args);
    trace.push({ event: "cancel-observed", reason: args[1], outcome });
    return outcome;
  };
  const release = store.releaseWeb;
  store.releaseWeb = (call) => {
    trace.push({ event: "release", ledger: ledger.frame(manager.getSessionId(), epoch, now) });
    release(call);
  };
  const ledger = createCommandLedger();
  const pending = new Map<string, (body: unknown) => void>();
  const handler = createCommandHandler({
    pi,
    getCtx: () => ctx,
    getSessionId: () => manager.getSessionId(),
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, deferAfterManualCompaction: () => false, dispose() {} },
    originEntry: {
      appendOrigin() {
        throw Error("memory must not record origin");
      },
      notify() {},
      dispose() {},
    },
    builtinBridge: createBuiltinBridge({
      pi,
      memoryRead: memory.webRead,
      memoryWrite: () => memory.webWrite,
      memoryScopes: true,
      getCtx: () => ctx,
      getSessionId: () => manager.getSessionId(),
      now: () => now,
    }),
    memoryOwner: epoch,
    controlEnabled: () => controlEnabled,
    now: () => now,
    setTimer: (ms, fn) => {
      const t = { due: now + ms, fn };
      timers.add(t);
      return { cancel: () => timers.delete(t) };
    },
    onChanged: () => publish("ctl", { ...ledger.frame(manager.getSessionId(), epoch, now), agentKey }),
    send: (frame) => {
      trace.push({ event: frame.t, frame });
      if (frame.t === "cmd_result") {
        const resolve = pending.get(frame.rid);
        pending.delete(frame.rid);
        resolve?.(frame);
      } else publish("cmd_late", { ...frame, agentKey });
    },
  });
  const origin = { listener: "loopback" as const, ip: "127.0.0.1", reqId: "isolated-browser-probe" };
  function request(req: Record<string, unknown>): Promise<any> {
    const rid = randomUUID();
    const { id, agentKey: _key, queryOnly, ...cmd } = req;
    return new Promise((resolve) => {
      pending.set(rid, resolve);
      trace.push({ event: queryOnly ? "query" : cmd.op === "abort" ? "handleAbort-enter" : "dispatch", id });
      handler.handle({
        t: "cmd",
        rid,
        id,
        deadlineMs: 8000,
        origin,
        cmd,
        ...(queryOnly ? { queryOnly: true } : {}),
      } as CmdFrame);
    });
  }
  return {
    cwd,
    manager,
    session,
    ctx,
    scopes,
    memory,
    store,
    ledger,
    handler,
    dialog,
    trace,
    request,
    owner: { agentKey, sessionId: manager.getSessionId(), epoch },
    setControl(enabled: boolean) {
      controlEnabled = enabled;
    },
    publish,
    listen(fn: (event: string, data: unknown) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    holdCommit() {
      commitBarrier = new Promise<void>((resolve) => {
        commitRelease = resolve;
      });
    },
    releaseCommit() {
      commitRelease?.();
      commitBarrier = undefined;
    },
    onAppend(fn?: () => void) {
      appendHook = fn;
    },
    onObserved(fn?: () => void) {
      observedHook = fn;
    },
    holdModel() {
      modelBarrier = new Promise<void>((r) => {
        modelRelease = r;
      });
    },
    releaseModel() {
      modelRelease?.();
      modelBarrier = undefined;
    },
    holdSettled() {
      settledEntered = false;
      settledBarrier = new Promise<void>((r) => {
        settledRelease = r;
      });
    },
    settledEntered: () => settledEntered,
    releaseSettled() {
      settledRelease?.();
      settledBarrier = undefined;
    },
    approve() {
      const d = dialog.frame().open[0];
      if (!d) throw Error("no actual remote dialog");
      return dialog.answer(
        d.dialogId,
        [{ selected: [d.questions[0]!.options[1]!.label], other: null }],
        origin,
        randomUUID(),
        epoch,
      );
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers])
        if (timer.due <= now) {
          timers.delete(timer);
          timer.fn();
        }
    },
    evidence() {
      const fold = store.fold();
      const observedHash = sha256Hex(
        canonicalJson({
          items: fold.items.map(({ item, rev }) => ({ item, rev })),
          nextN: fold.nextN,
          opsSinceSnap: fold.opsSinceSnap,
          dropped: fold.dropped,
        }),
      );
      return {
        appendCount,
        nativeCalls,
        memSendUserMessage,
        modelCalls,
        poisoned: store.poisonedNow(),
        plannedHash: plan?.expectedNewContentHash,
        observedHash,
        fold,
        trace: [...trace],
      };
    },
    dispose() {
      handler.dispose();
      scopes.dispose();
      dialog.dispose();
      session.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}
