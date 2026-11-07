/** #59 B2: real pi 1.5 core binding; no private run/queue mutation, no network/model service.
 * Public subscribe(agent_settled) is AFTER awaited extension handlers; extension on(settled)
 * is not. These tests intentionally preserve unsupported deferred/reload behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Local scripted provider: never dispatches to a provider registry/network, owns every directory.
// Kept here because the shared historical harness has a pre-existing strict AssistantMessage error.
function fakeModel() {
  return {
    id: "todo59-script",
    name: "Todo59 Script",
    api: "anthropic-messages" as const,
    provider: "todo59-local",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}
function assistantTextMsg(model: ReturnType<typeof fakeModel>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
interface ScriptedTurn {
  toolCall: boolean;
  build(model: ReturnType<typeof fakeModel>): AssistantMessage;
}
function fakeRuntime(model: ReturnType<typeof fakeModel>, scripted: ScriptedTurn[]) {
  const requests: unknown[][] = [];
  return {
    streamSimple: (_model: unknown, context: { messages?: unknown[] }) => {
      const index = requests.length;
      requests.push(context.messages ?? []);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: scripted[index % scripted.length]!.build(model) });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => requests.length,
    requestMessages: requests,
  };
}
async function withSession(
  opts: {
    scripted: ScriptedTurn[];
    tools: string[];
    persist?: boolean;
    extensionFactories: ((api: ExtensionAPI) => void)[];
  },
  run: (env: { session: AgentSession; cwd: string; modelRuntime: ReturnType<typeof fakeRuntime> }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "todo59-b2-conformance-"));
  const agentDir = join(cwd, "agent");
  const model = fakeModel();
  const modelRuntime = fakeRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: opts.extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  let session: AgentSession | undefined;
  try {
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd,
      model,
      modelRuntime: modelRuntime as never,
      settingsManager,
      resourceLoader: loader,
      sessionManager: opts.persist ? SessionManager.create(cwd, join(cwd, "sessions")) : SessionManager.inMemory(cwd),
      tools: opts.tools,
    }));
    await run({ session, cwd, modelRuntime });
  } finally {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

import { FakeClock } from "../../src/core/clock.js";
import { createIdleRecoveryHost, RECOVERY_BUSY_SOURCES, type RecoveryBusy } from "../../src/todo/idle-recovery-host.js";
import { createIdleRecoveryStore } from "../../src/todo/idle-recovery-store.js";
import { createIdleRecoveryRunner, IDLE_RECOVERY_DEADLINE_MS } from "../../src/todo/idle-recovery-runner.js";
import type { TodoState } from "../../src/todo/state.js";

const CUSTOM = "subagent:todo-idle-recovery-check";
const details = { v: 1, sid: "test", ownerToken: "owner", attemptId: "attempt" };
const message = { customType: CUSTOM, content: "authorized check only", display: true, details };
const turn: ScriptedTurn = { toolCall: false, build: (m) => assistantTextMsg(m, "done") };
const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("B2 network fence");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("todo idle recovery actual SDK capability matrix", () => {
  it("public pi.sendMessage binds actual current trigger, is synchronously busy and starts once; context tail is not binding", async () => {
    let pi!: ExtensionAPI;
    const bas: unknown[] = [];
    const contexts: unknown[][] = [];
    const settled = gate();
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api: ExtensionAPI) => {
            pi = api;
            api.on("before_agent_start", (event) => {
              bas.push(event);
              return { message: { customType: "extra-bas", content: "extra", display: false } };
            });
            api.on("context", (event) => {
              contexts.push(event.messages);
            });
            api.on("agent_settled", () => {
              settled.resolve();
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        pi.sendMessage({ customType: "next-turn", content: "next", display: false }, { deliverAs: "nextTurn" });
        expect(session.pendingMessageCount).toBe(0); // does not expose nextTurn!
        expect(pi.sendMessage(message, { triggerTurn: true })).toBeUndefined();
        expect(session.isIdle).toBe(false);
        await settled.promise;
        await session.waitForIdle();
        expect(bas).toHaveLength(1);
        expect(bas[0]).toMatchObject({ messageType: "custom", message: { customType: CUSTOM, details } });
        expect(modelRuntime.callCount()).toBe(1);
        expect(JSON.stringify(contexts[0])).toContain(CUSTOM);
        expect(contexts[0]?.at(-1)).toMatchObject({ customType: "extra-bas" });
      },
    );
  });

  it("real BAS abort yields aborted settled and an aborted provider signal; idle abort is not another Stop", async () => {
    let pi!: ExtensionAPI;
    const stops: boolean[] = [];
    const done = gate();
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api: ExtensionAPI) => {
            pi = api;
            api.on("before_agent_start", (_e, ctx) => {
              ctx.abort();
            });
            api.on("agent_settled", (e) => {
              stops.push(e.aborted);
              done.resolve();
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        const signals: boolean[] = [];
        const original = modelRuntime.streamSimple;
        modelRuntime.streamSimple = ((
          m: unknown,
          context: { messages?: unknown[] },
          options: { signal?: AbortSignal },
        ) => {
          signals.push(options.signal?.aborted === true);
          return original(m, context);
        }) as typeof original;
        pi.sendMessage(message, { triggerTurn: true });
        await done.promise;
        await session.abort();
        expect(stops).toEqual([true]);
        expect(signals).toEqual([true]);
        expect(session.isIdle).toBe(true);
      },
    );
  });

  it("unsupported: one immediate from extension settled can enqueue while idle/noPending during a later async handler", async () => {
    const held = gate();
    const attempted = gate();
    let once = false;
    let pi!: ExtensionAPI;
    const observations: boolean[][] = [];
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api: ExtensionAPI) => {
            pi = api;
            api.on("agent_settled", () => {
              if (once) return;
              once = true;
              const handle = setImmediate(() => {
                const ctx = sessionContext();
                observations.push([ctx.isIdle(), ctx.hasPendingMessages()]);
                pi.sendMessage(message, { triggerTurn: true });
                observations.push([ctx.isIdle(), ctx.hasPendingMessages()]);
                attempted.resolve();
              });
              handle.unref();
            });
            let context!: ExtensionContext;
            const sessionContext = () => context;
            api.on("agent_settled", async (_e, ctx) => {
              context = ctx;
              if (observations.length === 0) await held.promise;
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        const running = session.prompt("first");
        try {
          await attempted.promise;
          expect(observations).toEqual([
            [true, false],
            [true, false],
          ]);
          expect(modelRuntime.callCount()).toBe(1);
        } finally {
          held.resolve();
        }
        await running;
        expect(modelRuntime.callCount()).toBe(2);
      },
    );
  });

  it("public session.subscribe settled + one immediate is after async extension handlers; immediate send becomes busy", async () => {
    const held = gate();
    const entered = gate();
    const sent = gate();
    let pi!: ExtensionAPI;
    let extensionSettles = 0;
    const observations: boolean[][] = [];
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api: ExtensionAPI) => {
            pi = api;
            api.on("agent_settled", async () => {
              if (++extensionSettles === 1) {
                entered.resolve();
                await held.promise;
              }
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        let once = false;
        const unsub = session.subscribe((e) => {
          if (e.type !== "agent_settled" || once) return;
          once = true;
          setImmediate(() => {
            observations.push([session.isIdle, session.pendingMessageCount > 0]);
            pi.sendMessage(message, { triggerTurn: true });
            observations.push([session.isIdle, session.pendingMessageCount > 0]);
            sent.resolve();
          }).unref();
        });
        const first = session.prompt("first");
        await entered.promise;
        await immediate();
        expect(observations).toEqual([]);
        held.resolve();
        await first;
        await sent.promise;
        await session.waitForIdle();
        unsub();
        expect(observations).toEqual([
          [true, false],
          [false, false],
        ]);
        expect(modelRuntime.callCount()).toBe(2);
      },
    );
  });

  it("unsupported public reload: a deferred custom survives old extension shutdown and reaches the new runner", async () => {
    const held = gate();
    const queued = gate();
    let pi!: ExtensionAPI;
    let generation = 0;
    let shutdowns = 0;
    const starts: number[] = [];
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api: ExtensionAPI) => {
            pi = api;
            const ownGeneration = ++generation;
            api.on("session_shutdown", () => {
              shutdowns += 1;
            });
            api.on("before_agent_start", (e) => {
              if (e.messageType === "custom") starts.push(ownGeneration);
            });
            api.on("agent_settled", async () => {
              if (ownGeneration !== 1 || starts.length > 0) return;
              pi.sendMessage(message, { triggerTurn: true });
              queued.resolve();
              await held.promise;
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        const first = session.prompt("first");
        await queued.promise;
        expect(session.isIdle).toBe(true);
        await session.reload(); // actual public reload path; NOT manual JS dispose
        expect(shutdowns).toBe(1);
        held.resolve();
        await first;
        expect(starts).toEqual([2]);
        expect(modelRuntime.callCount()).toBe(2);
      },
    );
  });

  it("public Runtime.newSession abort/shutdown/dispose does not erase old deferred custom (unsupported composition)", async () => {
    const held = gate();
    const queued = gate();
    let once = false;
    let shutdowns = 0;
    let oldCustomStarts = 0;
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api: ExtensionAPI) => {
            api.on("session_shutdown", () => {
              shutdowns += 1;
            });
            api.on("before_agent_start", (e) => {
              if (e.messageType === "custom") oldCustomStarts += 1;
            });
            api.on("agent_settled", async () => {
              if (once) return;
              once = true;
              api.sendMessage(message, { triggerTurn: true });
              queued.resolve();
              await held.promise;
            });
          },
        ],
      },
      async ({ session, cwd, modelRuntime }) => {
        const runtime = new AgentSessionRuntime(session, { cwd, agentDir: cwd } as never, async (options) => {
          const next = await createAgentSession({
            cwd,
            model: session.model!,
            modelRuntime: modelRuntime as never,
            settingsManager: session.settingsManager,
            resourceLoader: session.resourceLoader,
            sessionManager: options.sessionManager!,
            tools: [],
          });
          return { ...next, services: { cwd, agentDir: cwd }, diagnostics: [] } as never;
        });
        const first = session.prompt("first");
        await queued.promise;
        const oldSid = session.sessionId;
        await runtime.newSession();
        expect(shutdowns).toBe(1);
        expect(runtime.session.sessionId).not.toBe(oldSid);
        held.resolve();
        await first;
        expect(oldCustomStarts).toBe(1);
        expect(modelRuntime.callCount()).toBe(2);
        await runtime.dispose();
      },
    );
  });
  it.each(["abort", "dispose"])(
    "public %s does not cancel an already deferred custom trigger (unsupported composition)",
    async (action) => {
      const held = gate();
      const queued = gate();
      let once = false;
      let customStarts = 0;
      let shutdowns = 0;
      await withSession(
        {
          scripted: [turn],
          tools: [],
          extensionFactories: [
            (api) => {
              api.on("session_shutdown", () => {
                shutdowns += 1;
              });
              api.on("before_agent_start", (e) => {
                if (e.messageType === "custom") customStarts += 1;
              });
              api.on("agent_settled", async () => {
                if (once) return;
                once = true;
                api.sendMessage(message, { triggerTurn: true });
                queued.resolve();
                await held.promise;
              });
            },
          ],
        },
        async ({ session, cwd, modelRuntime }) => {
          const runtime = new AgentSessionRuntime(session, { cwd, agentDir: cwd } as never, async () => {
            throw Error("unused");
          });
          const first = session.prompt("first");
          await queued.promise;
          if (action === "abort") await session.abort();
          else await runtime.dispose();
          expect(shutdowns).toBe(action === "dispose" ? 1 : 0);
          expect(customStarts).toBe(0);
          held.resolve();
          await first;
          expect(customStarts).toBe(1);
          expect(modelRuntime.callCount()).toBe(2);
        },
      );
    },
  );

  it("pre-BAS preparatory compaction can call the local provider before current trigger ownership exists", async () => {
    let pi!: ExtensionAPI;
    const trace: string[] = [];
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (api) => {
            pi = api;
            api.on("before_agent_start", (e, ctx) => {
              if (e.messageType === "custom") {
                trace.push("BAS");
                ctx.abort();
              }
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        session.settingsManager.applyOverrides({
          compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 16 },
        });
        for (let i = 0; i < 4; i++) {
          session.sessionManager.appendMessage({
            role: "user",
            content: `history ${i} ${"long ".repeat(100)}`,
            timestamp: Date.now(),
          });
          const old = assistantTextMsg(fakeModel(), `answer ${i}`);
          session.sessionManager.appendMessage({
            ...old,
            usage: { ...old.usage, input: 199_000, totalTokens: 199_001 },
          });
        }
        session.refreshContext();
        const original = modelRuntime.streamSimple;
        modelRuntime.streamSimple = (model, context) => {
          trace.push("provider");
          return original(model, context);
        };
        pi.sendMessage(message, { triggerTurn: true });
        await session.waitForIdle();
        expect(trace[0]).toBe("provider");
        expect(trace.indexOf("BAS")).toBeGreaterThan(0);
        expect(session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
      },
    );
  });

  it("SDK-owned integration: actual input arrival, post-settled send, BAS/context ownership, real abort, budget/Stop file replay", async () => {
    let api!: ExtensionAPI;
    let host: ReturnType<typeof createIdleRecoveryHost> | undefined;
    let runner: ReturnType<typeof createIdleRecoveryRunner> | undefined;
    const entered = gate();
    const held = gate();
    const done = gate();
    let customStarts = 0;
    await withSession(
      {
        persist: true,
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (pi) => {
            api = pi;
            pi.on("input", (event, ctx) => {
              host?.onTuiInput(event, { sid: ctx.sessionManager.getSessionId(), owner: "root", mode: ctx.mode });
              return { action: "continue" };
            });
            pi.on("before_agent_start", (event) => {
              runner?.beforeAgentStart(event);
            });
            pi.on("before_agent_start", async (event) => {
              if (event.messageType !== "custom" || event.message.customType !== CUSTOM) return;
              customStarts += 1;
              entered.resolve();
              await held.promise;
              return { message: { customType: "bas-extra", content: "not tail binding", display: false } };
            });
            pi.on("context", () => {
              runner?.context();
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.bindExtensions({ mode: "tui" }); // actual public SDK-owner mode binding, NOT a Root extension API
        const sid = session.sessionId;
        const clock = new FakeClock(100);
        const store = createIdleRecoveryStore({
          sessionId: sid,
          owner: "root",
          now: () => clock.now(),
          getEntries: () => session.sessionManager.getEntries(),
          appendCustomEntry: (type, data) => api.appendEntry(type, data),
        });
        const todo: TodoState = {
          nextId: 2,
          tasks: [
            {
              id: 1,
              subject: "authorized existing work",
              description: "original scope only",
              status: "in_progress",
              blocks: [],
              blockedBy: [],
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        };
        host = createIdleRecoveryHost({
          enabled: true,
          sid,
          owner: "root",
          store,
          currentIdentity: () => ({ sid: session.sessionId, owner: "root" }),
          readSdk: () => ({ mode: "tui", idle: session.isIdle, pending: session.pendingMessageCount > 0 }),
          readTodo: () => todo,
          busy: Object.fromEntries(RECOVERY_BUSY_SOURCES.map((name) => [name, () => "clear" as RecoveryBusy])),
          handover: () => runner?.handover(),
        });
        const abort = vi.fn(() => {
          void session.abort();
        });
        runner = createIdleRecoveryRunner({
          enabled: true,
          sid,
          owner: "root",
          store,
          clock,
          readHostSnapshot: () => host!.readHostSnapshot(),
          getEntries: () => session.sessionManager.getEntries(),
          appendCustomEntry: (type, data) => api.appendEntry(type, data),
          sendMessage: (m, o) => api.sendMessage(m, o),
          abort,
          subscribeSession: (listener) => session.subscribe(listener),
        });
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "agent_settled" && customStarts === 1) done.resolve();
        });
        try {
          api.sendMessage({ customType: "next-turn", content: "next", display: false }, { deliverAs: "nextTurn" });
          await session.prompt("continue original authorized task");
          await entered.promise;
          expect(runner.phase()).toBe("bound");
          expect(store.view().attemptsInWindow).toBe(1);
          clock.advance(IDLE_RECOVERY_DEADLINE_MS);
          expect(abort).toHaveBeenCalledOnce();
          held.resolve();
          await done.promise;
          await session.waitForIdle();
          expect(customStarts).toBe(1);
          expect(clock.pendingTimers).toBe(0);
          expect(store.view().stopped).toBe(true);
          expect(modelRuntime.callCount()).toBe(2); // scripted provider sees an aborted call; not a zero-call guarantee
          const file = session.sessionFile;
          expect(file).toBeDefined();
          const reopened = SessionManager.open(file!);
          const replay = createIdleRecoveryStore({
            sessionId: sid,
            owner: "reloaded-owner",
            getEntries: () => reopened.getEntries(),
            appendCustomEntry: (type, data) => reopened.appendCustomEntry(type, data),
          });
          expect(replay.view()).toMatchObject({ open: false, stopped: true, attemptsInWindow: 1, totalAttempts: 1 });
          expect(replay.view().seen).toHaveLength(1);
          await session.prompt("a distinct new human request");
          await immediate();
          expect(store.view()).toMatchObject({ open: true, stopped: false, attemptsInWindow: 0, totalAttempts: 1 });
          expect(customStarts).toBe(1);
          expect(abort).toHaveBeenCalledOnce();
          expect(modelRuntime.callCount()).toBe(3); // historical marker did not kill the new user run
        } finally {
          held.resolve();
          unsubscribe();
          runner.dispose();
          host.dispose();
        }
      },
    );
  });

  it("post-subscribe alone is NOT universal: deferred user input can await invisibly (host otherRoot must be unknown/busy)", async () => {
    const held = gate();
    const attempted = gate();
    let once = false;
    let api!: ExtensionAPI;
    const observed: boolean[][] = [];
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (pi) => {
            api = pi;
            pi.on("input", async (event) => {
              if (event.source === "extension") await held.promise;
              return { action: "continue" };
            });
            pi.on("agent_settled", () => {
              if (!once) {
                once = true;
                pi.sendUserMessage("deferred input");
              }
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        let posted = false;
        const unsubscribe = session.subscribe((event) => {
          if (event.type !== "agent_settled" || posted) return;
          posted = true;
          setImmediate(() => {
            observed.push([session.isIdle, session.pendingMessageCount > 0]);
            api.sendMessage(message, { triggerTurn: true });
            observed.push([session.isIdle, session.pendingMessageCount > 0]);
            attempted.resolve();
          }).unref();
        });
        const first = session.prompt("initial");
        const result = first.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await attempted.promise;
          expect(observed).toEqual([
            [true, false],
            [false, false],
          ]);
        } finally {
          held.resolve();
          unsubscribe();
        }
        expect(await result).toMatchObject({
          message:
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        });
        await session.waitForIdle();
        expect(modelRuntime.callCount()).toBe(2);
      },
    );
  });

  it("supported immediate SDK-owned start: public Runtime.newSession waits actual abort/settled before shutdown", async () => {
    const entered = gate();
    const held = gate();
    let api!: ExtensionAPI;
    let customStarts = 0;
    let shutdowns = 0;
    const signals: boolean[] = [];
    await withSession(
      {
        scripted: [turn],
        tools: [],
        extensionFactories: [
          (pi) => {
            api = pi;
            pi.on("before_agent_start", async (event) => {
              if (event.messageType !== "custom") return;
              customStarts += 1;
              entered.resolve();
              await held.promise;
            });
            pi.on("session_shutdown", () => {
              shutdowns += 1;
            });
          },
        ],
      },
      async ({ session, cwd, modelRuntime }) => {
        const original = modelRuntime.streamSimple;
        modelRuntime.streamSimple = ((
          m: unknown,
          context: { messages?: unknown[] },
          options: { signal?: AbortSignal },
        ) => {
          signals.push(options.signal?.aborted === true);
          return original(m, context);
        }) as typeof original;
        const runtime = new AgentSessionRuntime(session, { cwd, agentDir: cwd } as never, async (options) => {
          const next = await createAgentSession({
            cwd,
            model: session.model!,
            modelRuntime: modelRuntime as never,
            settingsManager: session.settingsManager,
            resourceLoader: session.resourceLoader,
            sessionManager: options.sessionManager!,
            tools: [],
          });
          return { ...next, services: { cwd, agentDir: cwd }, diagnostics: [] } as never;
        });
        api.sendMessage(message, { triggerTurn: true });
        expect(session.isIdle).toBe(false);
        await entered.promise;
        const replacement = runtime.newSession();
        await immediate();
        expect(shutdowns).toBe(0); // actual runtime boundary waits owned run, not a fake finish flag
        held.resolve();
        await replacement;
        expect(shutdowns).toBe(1);
        expect(customStarts).toBe(1);
        expect(signals).toEqual([true]);
        expect(modelRuntime.callCount()).toBe(1);
        await runtime.dispose();
      },
    );
  });
});
