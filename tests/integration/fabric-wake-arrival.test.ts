/** Production fabric + message_agent tool over the real pi 1.5 SDK. Own/tmp only;
 * fake provider only (no sockets, credentials, installs or paid API requests). */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { buildFabric } from "../../src/fabric/stack.js";
import { createWakeInputHook } from "../../src/fabric/wake-input.js";
import { createMessageAgentTool } from "../../src/tools/message-agent-tool.js";
import type { AdmissionResult } from "../../src/fabric/router.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

const sender = "r_SENDER01";
const model = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as const,
  provider: "fake-provider",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};
function assistantTextMsg(_model: unknown, text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function fakeRuntime() {
  const requestMessages: unknown[][] = [];
  return {
    streamSimple: (_model: unknown, context: { messages?: unknown[] }) => {
      requestMessages.push(context.messages ?? []);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistantTextMsg(model, "ok") as never });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => requestMessages.length,
    requestMessages,
  };
}
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function withSession(
  opts: { extensionFactories: Array<(pi: ExtensionAPI) => void>; tools?: string[] },
  run: (env: { session: AgentSession; modelRuntime: ReturnType<typeof fakeRuntime> }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "fabric61-sdk-own-"));
  dirs.push(cwd);
  const agentDir = join(cwd, ".pi-agent");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: opts.extensionFactories,
  });
  await resourceLoader.reload();
  const modelRuntime = fakeRuntime();
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
    tools: opts.tools ?? [],
  });
  try {
    await run({ session, modelRuntime });
  } finally {
    session.dispose();
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withRoot(
  run: (env: {
    session: Parameters<Parameters<typeof withSession>[1]>[0]["session"];
    runtime: Parameters<Parameters<typeof withSession>[1]>[0]["modelRuntime"];
    fabric: () => ReturnType<typeof buildFabric>;
    send: (text: string, wake?: boolean) => Promise<AdmissionResult>;
    rebuild: () => void;
    ctx: () => ExtensionContext;
    events: string[];
    startGate: { current?: ReturnType<typeof deferred> };
  }) => Promise<void>,
) {
  const home = sandboxHome();
  let fabric: ReturnType<typeof buildFabric> | undefined;
  let api!: ExtensionAPI;
  let context!: ExtensionContext;
  let budgetContext!: ExtensionContext;
  const events: string[] = [];
  const startGate: { current?: ReturnType<typeof deferred> } = {};
  const build = () => {
    fabric?.mailbox.dispose();
    budgetContext = context;
    fabric = buildFabric(
      api,
      budgetContext,
      {
        ...DEFAULT_SETTINGS,
        fabric: {
          ...DEFAULT_SETTINGS.fabric,
          enabled: true,
          minIntervalMs: 0,
          rootMinIntervalMs: 0,
          reportQuota: 30,
          wake: { ...DEFAULT_SETTINGS.fabric.wake, enabled: true },
        },
      },
      [],
      false,
      {},
      () => undefined,
      () => undefined,
      { tombstone: () => undefined, agentTypeExists: () => false },
    );
    // The child identity and its live tree edge are host-owned, not tool parameters.
    fabric.tree.append("root", sender);
    fabric.tree.markRunning(sender);
  };
  try {
    await withSession(
      {
        extensionFactories: [
          (pi: ExtensionAPI) => {
            api = pi;
            const input = createWakeInputHook({
              level: () => fabric?.level,
              rootBudget: () => fabric?.rootBudget,
              attributeInput: () => (text) => (text === "verified web user" ? "web_prompt" : undefined),
            });
            pi.on("input", (event, ctx) => {
              context = ctx;
              if (!fabric) build();
              return input(event);
            });
            pi.on("before_agent_start", async () => {
              if (startGate.current) await startGate.current.promise;
            });
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        session.subscribe((e) => events.push(e.type));
        await run({
          session,
          runtime: modelRuntime,
          fabric: () => fabric!,
          rebuild: build,
          ctx: () => budgetContext,
          events,
          startGate,
          send: async (text, wake = true) => {
            const tool = createMessageAgentTool({
              router: fabric!.router,
              from: sender,
              generation: () => 1,
              wakeOn: true,
            });
            const result = await tool.execute(
              "child-call",
              { to: "root", kind: "report", text, wake } as never,
              undefined,
              undefined,
              {} as ExtensionToolContext,
            );
            return result.details as AdmissionResult;
          },
        });
      },
    );
  } finally {
    fabric?.mailbox.dispose();
    home.restore();
  }
}
const idle = async (session: { isIdle: boolean }) => {
  await vi.waitFor(() => expect(session.isIdle).toBe(true), { timeout: 3000, interval: 5 });
};
const count = (events: string[], name: string) => events.filter((e) => e === name).length;
const occurrences = (messages: readonly unknown[], text: string) =>
  messages.filter(
    (m) =>
      typeof m === "object" && m !== null && "role" in m && m.role === "custom" && JSON.stringify(m).includes(text),
  ).length;

describe("#61 real SDK root arrival admission", () => {
  it("idle + two-budget: exactly one root run per request; third is explicit deliver-only, body retained", async () => {
    await withRoot(async ({ session, runtime, fabric, send, events }) => {
      await session.prompt("trusted TUI user");
      expect(fabric().rootBudget!.snapshot()).toMatchObject({ window: 1, used: 0 });
      const before = count(events, "agent_start");
      for (const text of ["wake-first-unique", "wake-second-unique"]) {
        expect(await send(text)).toMatchObject({ ok: true, wake: true });
        await idle(session);
        await vi.waitFor(() =>
          expect(fabric().engine.select((r) => r.state === "delivered" && r.payload.text === text)).toHaveLength(1),
        );
      }
      expect(count(events, "agent_start")).toBe(before + 2);
      expect(runtime.callCount()).toBe(3);
      expect(await send("third-deliver-only")).toMatchObject({ wake: false, wakeDowngraded: "root_limit" });
      await vi.waitFor(() => expect(occurrences(session.messages, "third-deliver-only")).toBe(1));
      fabric().mailbox.pump();
      await Promise.resolve();
      expect(count(events, "agent_start")).toBe(before + 2);
      expect(runtime.callCount()).toBe(3);
      expect(fabric().rootBudget!.snapshot().used).toBe(2);
      expect(occurrences(session.messages, "wake-first-unique")).toBe(1);
    });
  });

  it("a real SDK child executes the registered production message_agent tool and starts one real root run", async () => {
    await withRoot(async ({ session, runtime, fabric, events }) => {
      await session.prompt("root human window");
      const before = count(events, "agent_start");
      await withSession(
        {
          tools: ["message_agent"],
          extensionFactories: [
            (pi) =>
              pi.registerTool(
                createMessageAgentTool({
                  router: fabric().router,
                  from: sender,
                  generation: () => 1,
                  wakeOn: true,
                }),
              ),
          ],
        },
        async ({ session: child, modelRuntime }) => {
          child.setActiveToolsByName(["message_agent"]);
          expect(child.sessionManager.getSessionId()).not.toBe(session.sessionManager.getSessionId());
          let calls = 0;
          const base = modelRuntime.streamSimple;
          modelRuntime.streamSimple = (m, context) => {
            if (calls++ > 0) return base(m, context);
            const stream = createAssistantMessageEventStream();
            stream.push({
              type: "done",
              reason: "toolUse",
              message: {
                ...assistantTextMsg(m, ""),
                stopReason: "toolUse",
                content: [
                  {
                    type: "toolCall",
                    id: "child-report-call",
                    name: "message_agent",
                    arguments: { to: "root", kind: "report", text: "sdk-child-report-unique", wake: true },
                  },
                ],
              } as never,
            });
            return stream;
          };
          await child.prompt("report to root");
          const results = child.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "message_agent",
          );
          expect(results).toHaveLength(1);
          expect(JSON.stringify(results[0])).toContain('"accepted"');
          expect(JSON.stringify(results[0])).not.toContain('"isError":true');
        },
      );
      await idle(session);
      expect(count(events, "agent_start")).toBe(before + 1);
      expect(runtime.callCount()).toBe(2);
      expect(occurrences(session.messages, "sdk-child-report-unique")).toBe(1);
      expect(fabric().rootBudget!.snapshot().used).toBe(1);
    });
  });

  it("running reports inject the current run's next turn, consume zero and never start another run", async () => {
    await withRoot(async ({ session, runtime, fabric, send, events }) => {
      session.setSteeringMode("all");
      const release = deferred();
      const base = runtime.streamSimple;
      let calls = 0;
      runtime.streamSimple = (model, context) => {
        calls++;
        if (calls > 1) return base(model, context);
        const stream = createAssistantMessageEventStream();
        void release.promise.then(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: assistantTextMsg(model as Parameters<typeof assistantTextMsg>[0], "held") as never,
          }),
        );
        return stream;
      };
      const running = session.prompt("long TUI run");
      try {
        await vi.waitFor(() => expect(calls).toBe(1));
        const receipts = await Promise.all([send("busy-one-unique"), send("busy-two-unique")]);
        expect(receipts).toEqual(
          expect.arrayContaining([expect.objectContaining({ wake: false, wakeDowngraded: "root_busy" })]),
        );
        expect(receipts.every((r) => r.ok && r.wake === false)).toBe(true);
        expect(fabric().rootBudget!.snapshot().used).toBe(0);
        expect(count(events, "agent_start")).toBe(1);
      } finally {
        release.resolve();
      }
      await running;
      expect(calls).toBe(2);
      expect(count(events, "agent_start")).toBe(1);
      const request = runtime.requestMessages.at(-1)!;
      expect(request.filter((m) => JSON.stringify(m).includes("busy-one-unique"))).toHaveLength(1);
      expect(occurrences(session.messages, "busy-one-unique")).toBe(1);
      expect(request.filter((m) => JSON.stringify(m).includes("busy-two-unique"))).toHaveLength(1);
      expect(occurrences(session.messages, "busy-two-unique")).toBe(1);
    });
  });

  it("starting root queues reports with zero budget and no second start", async () => {
    await withRoot(async ({ session, fabric, send, events, startGate }) => {
      const gate = deferred();
      startGate.current = gate;
      const starting = session.prompt("starting user");
      try {
        await vi.waitFor(() => expect(fabric()?.rootBudget?.snapshot().window).toBe(1));
        await vi.waitFor(() => expect(session.isIdle).toBe(false));
        expect(await send("starting-report-unique")).toMatchObject({ wake: false, wakeDowngraded: "root_busy" });
        expect(fabric().rootBudget!.snapshot().used).toBe(0);
      } finally {
        delete startGate.current;
        gate.resolve();
      }
      await starting;
      expect(count(events, "agent_start")).toBe(1);
      expect(occurrences(session.messages, "starting-report-unique")).toBe(1);
    });
  });

  it("simultaneous idle requests coalesce to one start and one charged request", async () => {
    await withRoot(async ({ session, fabric, send, events, startGate }) => {
      await session.prompt("user");
      const before = count(events, "agent_start");
      const gate = deferred();
      startGate.current = gate;
      try {
        const receipts = await Promise.all([send("burst-a-unique"), send("burst-b-unique")]);
        expect(receipts.filter((r) => r.ok && r.wake)).toHaveLength(1);
        expect(fabric().rootBudget!.snapshot().used).toBe(1);
      } finally {
        delete startGate.current;
        gate.resolve();
      }
      await idle(session);
      expect(count(events, "agent_start")).toBe(before + 1);
      await vi.waitFor(() => expect(occurrences(session.messages, "burst-b-unique")).toBe(1));
      expect(occurrences(session.messages, "burst-a-unique")).toBe(1);
    });
  });

  it("retrying the same admitted messageKey after missing delivery bookkeeping never resends or wakes twice", async () => {
    await withRoot(async ({ session, fabric, send, events }) => {
      await session.prompt("user");
      const before = count(events, "agent_start");
      const engine = fabric().engine;
      const transition = engine.transition.bind(engine);
      // Inject only a missing delivery bookkeeping result, not a fake host send/run.
      const fault = vi.spyOn(engine, "transition").mockImplementation((...args) => {
        if (args[2] === "delivered") return undefined;
        return transition(...args);
      });
      const receipt = await send("same-key-body-unique");
      if (!receipt.ok) throw Error("expected admission");
      await idle(session);
      await vi.waitFor(() => expect(fabric().mailbox.inFlightCount).toBe(0));
      expect(engine.get(receipt.key)?.state).toBe("claimed");
      fault.mockRestore();
      // Simulate retrying that envelope, with its original key, in the same window.
      expect(engine.transition(receipt.key, "claimed", "pending")).toBeDefined();
      fabric().mailbox.pump();
      await vi.waitFor(() => expect(engine.get(receipt.key)?.state).toBe("delivered"));
      expect(count(events, "agent_start")).toBe(before + 1);
      expect(occurrences(session.messages, "same-key-body-unique")).toBe(1);
      expect(fabric().rootBudget!.snapshot().used).toBe(1);
    });
  });

  it("reload has no window until a new TUI/Web arrival; machine/custom inputs never reset it; unknown host fails closed", async () => {
    await withRoot(async ({ session, fabric, send, rebuild, ctx, events }) => {
      await session.prompt("user");
      const old = fabric().rootBudget!;
      rebuild();
      expect(old.observeAcceptedUserArrival({})).toBe(false);
      expect(await send("reload-no-window")).toMatchObject({ wake: false, wakeDowngraded: "root_no_window" });
      await session.prompt("machine RPC", { source: "rpc" });
      expect(fabric().rootBudget!.snapshot().window).toBe(0);
      await session.sendUserMessage("/goal machine continuation");
      await session.sendCustomMessage({ customType: "machine", content: "role text user", display: false });
      expect(fabric().rootBudget!.snapshot().window).toBe(0);
      await session.sendUserMessage("verified web user");
      expect(fabric().rootBudget!.snapshot()).toMatchObject({ window: 1, used: 0 });
      await session.prompt("new TUI");
      expect(fabric().rootBudget!.snapshot()).toMatchObject({ window: 2, used: 0 });
      const before = count(events, "agent_start");
      ctx().isIdle = () => {
        throw Error("host unknown");
      };
      expect(await send("unknown-state-body")).toMatchObject({ wake: false, wakeDowngraded: "root_unknown" });
      await vi.waitFor(() => expect(occurrences(session.messages, "unknown-state-body")).toBe(1));
      expect(count(events, "agent_start")).toBe(before);
      expect(fabric().rootBudget!.snapshot().used).toBe(0);
    });
  });
});
