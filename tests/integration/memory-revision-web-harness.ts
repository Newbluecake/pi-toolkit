/** I1 full isolated SDK + production memory/scopes/bridge/commands/kernel/E/C.
 * Synthetic provider terminates only the SDK HTTP boundary, never production auth. */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadSettings } from "../../src/config/settings.js";
import { wireMemory } from "../../src/memory/index.js";
import { wireMemoryScopes, type MemoryScopesWiring } from "../../src/memory/scopes/wire.js";
import { createPromptSectionHub } from "../../src/sysprompt/hub.js";
import { memoryDirFor } from "../../src/memory/paths.js";
import { readIndex } from "../../src/memory/jev/index-store.js";
import { createBuiltinBridge } from "../../src/web-hub/agent/builtin-bridge.js";
import { createCommandHandler } from "../../src/web-hub/agent/commands.js";
import { createCommandLedger } from "../../src/web-hub/agent/ledger.js";
import { createQueueMirror } from "../../src/web-hub/agent/queue-mirror.js";
import { createDialogBridge } from "../../src/web-hub/agent/dialogs.js";
import { createCommandRecorder } from "../../src/web-hub/agent/command-record.js";
import type { CmdFrame } from "../../src/web-hub/protocol/messages.js";
import { revisionLabProvider } from "./helpers/memory-revision-provider.js";

export async function createRevisionWebHost(
  options: { session?: boolean; hub?: boolean; history?: boolean; recordFailure?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "memory-i1-sdk-")),
    cwd = join(root, "project"),
    agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const oldRoot = process.env.ARMORY_MEMORY_ROOT;
  process.env.ARMORY_MEMORY_ROOT = join(root, "memory");
  const lab = await revisionLabProvider(agentDir);
  const settings = loadSettings({
    memory: {
      enabled: true,
      scopes: { session: options.session ?? true, hub: options.hub ?? false },
      migrate: { auto: false },
      doctor: { notifyOnStart: false },
      incremental: {
        enabled: true,
        auto: false,
        changeThreshold: 2,
        quietSec: 1,
        idleSec: 0,
        cooldownSec: 1,
        jobCostCapUsd: 0.2,
      },
      jev: {
        enabled: true,
        classifiers: [`${lab.provider}/relation`],
        maxCalls: 10000,
        maxCostUsd: 10,
        predict: { enabled: false },
      },
    },
  }).memory;
  const manager = SessionManager.inMemory(cwd),
    epoch = randomUUID(),
    agentKey = `i1-${epoch}`;
  const listeners = new Set<(event: string, data: unknown) => void>();
  const publish = (event: string, data: unknown) => {
    for (const fn of listeners) fn(event, data);
  };
  let now = Date.now(),
    ctx!: ExtensionContext,
    pi!: ExtensionAPI,
    scopes: MemoryScopesWiring | undefined;
  let memory!: ReturnType<typeof wireMemory>,
    native = 0,
    sent = 0,
    starts = 0,
    recordAttempts = 0;
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const trace: { event: string; [key: string]: unknown }[] = [];
  const timers = new Set<{ due: number; fn(): void }>();
  const lifecycle = new AbortController();
  let completionBarrier: Promise<void> | undefined,
    completionRelease: (() => void) | undefined,
    completionObserved = false;
  const dialog = createDialogBridge({
    enabled: true,
    epoch,
    isAttached: () => true,
    now: () => now,
    setSlot: (_kind, frame) => publish("dialogs", frame),
  });
  function instrumentPort() {
    const port = memory.webWrite;
    if (port) {
      const start = port.start.bind(port);
      port.start = (...args) => {
        starts++;
        const result = start(...args);
        trace.push({ event: "start", accepted: result.accepted, id: args[0].cmdId });
        if (!result.accepted) return result;
        const task = result.task;
        return {
          accepted: true,
          task: {
            done: task.done.then(async (outcome) => {
              completionObserved = true;
              if (completionBarrier) await completionBarrier;
              return outcome;
            }),
            cancel(reason) {
              const outcome = task.cancel(reason);
              trace.push({ event: "cancel-observed", reason, outcome });
              return outcome;
            },
            release() {
              trace.push({ event: "release", ledger: ledger.frame(manager.getSessionId(), epoch, now) });
              task.release();
            },
          },
        };
      };
    }
  }
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
          registerTool(definition) {
            tools.set(definition.name, definition);
            return api.registerTool(definition);
          },
          registerCommand(name, definition) {
            api.registerCommand(
              name,
              name === "mem"
                ? {
                    ...definition,
                    handler: async (args, actual) => {
                      native++;
                      return definition.handler(args, actual);
                    },
                  }
                : definition,
            );
          },
          sendUserMessage(content, opts) {
            if (typeof content === "string" && content.startsWith("/mem")) sent++;
            return api.sendUserMessage(content, opts);
          },
        };
        scopes = wireMemoryScopes(pi, {
          settings,
          domain: "plain",
          child: false,
          gate: { check: () => ({ ok: true }) },
          locked: () => false,
          remote: () => dialog,
          hubPaths: () => ({ stateDir: join(root, "absent-hub") }),
        });
        memory = wireMemory(pi, {
          settings,
          ...(scopes ? { scopes } : {}),
          isChildSession: false,
          secureDomainKind: "plain",
          sessionSignal: () => lifecycle.signal,
          p50BindingResolver: lab.resolve,
          sections: createPromptSectionHub(pi, {
            mode: () => "stable",
            wakeReplay: false,
            adoptForeignForcedPrompt: false,
          }),
        });
        instrumentPort();
        api.on("session_start", (_event, actual) => {
          ctx = actual;
        });
        api.on("session_tree", (_event, actual) => {
          ctx = actual;
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: manager,
    settingsManager,
    resourceLoader: loader,
    modelRuntime: lab.runtime,
    model: lab.runtime.getModel(lab.provider, "generation")!,
    tools: [],
  });
  await session.bindExtensions({ mode: "rpc" });
  if (!ctx) throw Error("actual SDK session_start unavailable");
  const recorder = options.history
    ? createCommandRecorder({
        appendEntry(type, data) {
          recordAttempts++;
          if (options.recordFailure) throw Error("owned record I/O fault");
          pi.appendEntry(type, data);
        },
        sessionId: () => manager.getSessionId(),
        now: () => now,
        onChange() {},
        setTimer(ms, fn) {
          const t = setTimeout(fn, ms);
          t.unref();
          return { cancel: () => clearTimeout(t) };
        },
      })
    : undefined;
  const ledger = createCommandLedger(),
    pending = new Map<string, (body: unknown) => void>();
  const handler = createCommandHandler({
    pi,
    getCtx: () => ctx,
    getSessionId: () => manager.getSessionId(),
    ledger,
    queueMirror: createQueueMirror(),
    compactionState: { manualCompacting: false, deferAfterManualCompaction: () => false, dispose() {} },
    originEntry: {
      appendOrigin() {
        throw Error("mem entered generic origin path");
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
      ...(recorder ? { recorder: () => recorder } : {}),
    }),
    memoryOwner: epoch,
    controlEnabled: () => true,
    now: () => now,
    setTimer(ms, fn) {
      const timer = { due: now + ms, fn };
      timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    },
    onChanged: () => publish("ctl", { ...ledger.frame(manager.getSessionId(), epoch, now), agentKey }),
    send(frame) {
      trace.push({ event: frame.t, frame });
      if (frame.t === "cmd_result") {
        const fn = pending.get(frame.rid);
        pending.delete(frame.rid);
        fn?.(frame);
      } else publish("cmd_late", { ...frame, agentKey });
    },
  });
  const origin = { listener: "loopback" as const, ip: "127.0.0.1", reqId: "i1-owned-offline-probe" };
  const dir = memoryDirFor(cwd);
  const request = (req: Record<string, unknown>): Promise<any> => {
    const { id, agentKey: _key, queryOnly, ...cmd } = req;
    const rid = randomUUID();
    return new Promise((resolve) => {
      pending.set(rid, resolve);
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
  };
  return {
    root,
    cwd,
    dir,
    get ctx() {
      return ctx;
    },
    manager,
    session,
    get scopes() {
      return scopes;
    },
    get memory() {
      return memory;
    },
    dialog,
    ledger,
    handler,
    trace,
    lab,
    recorder,
    get owner() {
      return { agentKey, sessionId: manager.getSessionId(), epoch };
    },
    async tree() {
      const anchor = manager.appendCustomEntry("i1-owned-tree", { position: 1 });
      manager.appendCustomEntry("i1-owned-tree", { position: 2 });
      const old = scopes?.current();
      const result = await session.navigateTree(anchor, { summarize: false });
      if (result.cancelled) throw Error("actual SDK tree cancelled");
      return old;
    },
    async reload() {
      const old = scopes?.current();
      await session.reload();
      // A UI-less SDK host has no persisted UI/action bindings, so reload()
      // deliberately does not auto-bind/start the new runner. Bind through its
      // PUBLIC API, obtaining the new actual context (never reuse the stale one).
      await session.bindExtensions({ mode: "rpc" });
      return old;
    },
    async newSession() {
      const old = scopes?.current();
      manager.newSession();
      await session.extensionRunner.emit({ type: "session_start", reason: "new" });
      return old;
    },
    request,
    publish,
    listen(fn: (event: string, data: unknown) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async seed() {
      for (const [topic, text] of [
        ["alpha", "Budget directory lock constraint"],
        ["alpha", "Budget directory lock boundary"],
        ["beta", "Calendar weekly report schedule"],
        ["beta", "Calendar weekly report reminder"],
      ]) {
        const result = await tools
          .get("memory")!
          .execute("i1-seed", { command: "create", topic, text }, undefined, undefined, ctx as never);
        if (result.isError) throw Error(`real memory create refused: ${JSON.stringify(result)}`);
      }
      const deadline = Date.now() + 8000;
      while (
        Date.now() < deadline &&
        (readIndex(dir).index.review?.suggestions.filter((s) => s.revision).length ?? 0) < 2
      )
        await new Promise<void>((r) => setTimeout(r, 20));
      const rows = readIndex(dir).index.review?.suggestions.filter((s) => s.revision) ?? [];
      if (rows.length !== 2)
        throw Error(`expected two original LIVE publications, got ${rows.length}; calls=${JSON.stringify(lab.calls)}`);
      return rows;
    },
    rows: () => readIndex(dir).index.review?.suggestions.filter((s) => s.revision) ?? [],
    raw: (id: string) => readFileSync(join(dir, "blocks", `${id}.md`)),
    answer(value: string, originOverride = origin) {
      const d = dialog.frame().open[0];
      if (!d) throw Error("no actual remote dialog");
      return dialog.answer(d.dialogId, [{ selected: [value], other: null }], originOverride, randomUUID(), epoch);
    },
    recordFaultProbe() {
      return recorder?.recordImmediate({
        cmdId: "i1-observation-only",
        name: "name",
        args: "local probe",
        source: "web",
        startedAt: now,
        state: "done",
      });
    },
    holdCompletion() {
      completionObserved = false;
      completionBarrier = new Promise<void>((r) => {
        completionRelease = r;
      });
    },
    completionObserved: () => completionObserved,
    releaseCompletion() {
      completionRelease?.();
      completionBarrier = undefined;
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers])
        if (t.due <= now) {
          timers.delete(t);
          t.fn();
        }
    },
    evidence: () => ({ starts, native, sent, recordAttempts, calls: [...lab.calls], trace: [...trace] }),
    revoke() {
      lifecycle.abort();
    },
    async dispose() {
      completionRelease?.();
      handler.dispose();
      // SDK dispose alone does NOT emit session_shutdown. Run the real isolated
      // extension lifecycle before restoring the HTTP boundary or removing tmp.
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      scopes?.dispose();
      lifecycle.abort();
      dialog.dispose();
      recorder?.dispose();
      session.dispose();
      lab.dispose();
      if (oldRoot === undefined) delete process.env.ARMORY_MEMORY_ROOT;
      else process.env.ARMORY_MEMORY_ROOT = oldRoot;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
