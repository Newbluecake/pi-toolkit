import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  AgentSessionRuntime,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "@sinclair/typebox";
import { AnthropicStub } from "./fixtures/anthropic-stub.js";
import { FakeClock } from "../../src/core/clock.js";
import { RootWakeController, type RootWakeAudit } from "../../src/fabric/root-wake.js";
import { XsWakeLedger } from "../../src/fabric/xs/wake-ledger.js";
import { XsHostCapability } from "../../src/fabric/xs/host-cap.js";
import { createSessionFence } from "../../src/fabric/xs/fence.js";
import { XsMembership, readXsMembershipEntry, XS_MEMBERSHIP_CUSTOM_TYPE } from "../../src/fabric/xs/membership.js";
import { XsReceiver } from "../../src/fabric/xs/receiver.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { createListSessionsTool } from "../../src/tools/list-sessions-tool.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import { createXsSender } from "../../src/fabric/xs/sender.js";
import { createBackgroundCompletionHub } from "../../src/service/background-completions.js";
import wireAskUser from "../../src/ask-user/index.js";
import { mockTui, stubTheme } from "../ask-user/fixtures.js";

// Real pi runner, real extension event pipeline and real Anthropic HTTP adapter. Only the
// remote provider is a loopback stub. Clock injection advances WATCHDOG deadlines, not pi.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const timer = setTimeout(r, ms);
    timer.unref();
  });
async function until(check: () => boolean, label: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(5);
  expect(check(), label).toBe(true);
}

type Env = Awaited<ReturnType<typeof host>>;
async function host(
  options: {
    stub?: AnthropicStub;
    extensions?: Array<(pi: ExtensionAPI) => void>;
    ui?: unknown;
    autoCompact?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "fabric-xs-conformance-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  const stub = options.stub ?? (await AnthropicStub.start());
  const model = {
    id: "claude-xs",
    name: "XS local stub",
    provider: "xs-local",
    api: "anthropic-messages" as const,
    baseUrl: `${stub.baseUrl}/v1`,
    reasoning: false,
    input: ["text" as const],
    contextWindow: 1000,
    maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
      retry: { enabled: false },
      cacheWarmer: { enabled: false },
    }),
  );
  const settings = SettingsManager.create(dir, agentDir);
  const clock = new FakeClock();
  const ledger = new XsWakeLedger();
  const cap = new XsHostCapability();
  const fence = createSessionFence();
  const audit: RootWakeAudit[] = [];
  const triggers: unknown[] = [];
  const settled: boolean[] = [];
  const errors: unknown[] = [];
  let pi!: ExtensionAPI, ctx!: ExtensionContext, controller!: RootWakeController;
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      (api) => {
        pi = api;
        api.on("session_start", (_e, context) => {
          ctx = context;
        });
        api.on("before_agent_start", (event) => {
          triggers.push(event);
          controller.beforeAgentStart(event);
        });
        api.on("input", (event) => {
          controller.input(event);
        });
        api.on("agent_settled", (event) => {
          settled.push(event.aborted);
          controller.settled();
        });
        api.on("session_before_compact", () => {
          fence.onEvent({ type: "session_before_compact" });
        });
        api.on("session_compact", () => {
          fence.onEvent({ type: "session_compact" });
        });
        api.on("session_compact_failed", () => {
          fence.onEvent({ type: "session_compact_failed" });
        });
        api.on("session_before_tree", () => {
          fence.onEvent({ type: "session_before_tree" });
        });
        api.on("session_tree", () => {
          fence.onEvent({ type: "session_tree" });
        });
        api.on("session_before_switch", () => {
          fence.onEvent({ type: "session_before_switch" });
        });
        api.on("session_start", () => {
          fence.onEvent({ type: "session_start" });
        });
        const sender = createXsSender({
          origin: { current: () => undefined },
          port: {
            list: async () => ({ kind: "off" }),
            resolve: async () => ({ kind: "off" }),
            send: async () => ({ kind: "off" }),
          },
        });
        api.registerTool(createListSessionsTool({ sender }));
        api.registerTool(createMessageSessionTool({ sender }));
      },
      ...(options.extensions ?? []),
    ],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    sessionManager: manager,
    model,
    modelRuntime: {
      streamSimple: (m: typeof model, c: Parameters<typeof streamSimple>[1], o: Parameters<typeof streamSimple>[2]) =>
        streamSimple(m, c, { ...o, apiKey: "local-stub-only" }),
      getModel: () => model,
      checkAuth: async () => ({ ok: true }),
      hasConfiguredAuth: () => true,
      getAuth: async () => ({ apiKey: "local-stub-only" }),
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [model],
    } as never,
    settingsManager: settings,
    resourceLoader: loader,
  });
  controller = new RootWakeController({
    sessionId: manager.getSessionId(),
    rootRunMaxS: 20,
    wakeEnabled: true,
    receive: () => "wake",
    clock,
    ledger,
    capability: cap,
    audit: (event) => audit.push(event),
    host: {
      isIdle: () => session.isIdle,
      hasPendingMessages: () => session.pendingMessageCount > 0,
      sendMessage: (m, o) => pi.sendMessage(m, o),
      abort: () => ctx.abort(),
    },
  });
  await session.bindExtensions({
    mode: options.ui ? "tui" : "rpc",
    ...(options.ui ? { uiContext: options.ui as never } : {}),
    onError: (e) => errors.push(e),
  });
  cleanups.push(async () => {
    controller.dispose();
    fence.dispose();
    await session.abort();
    session.dispose();
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  if (options.autoCompact) settings.setCompactionEnabled(true);
  const wake = (xid = `x-${triggers.length}`) =>
    controller.dispatch({ xid, content: "untrusted xs body", from: { ref: "source" }, expiresAt: clock.now() + 5000 });
  return {
    session,
    stub,
    manager,
    settings,
    clock,
    ledger,
    cap,
    fence,
    audit,
    triggers,
    settled,
    errors,
    pi,
    ctx,
    controller,
    wake,
    dir,
    agentDir,
  };
}
async function prime(h: Env) {
  await h.session.prompt("human first turn");
  expect(h.cap.state).toBe("observed");
}
function receiver(h: Env) {
  const membership = new XsMembership({
    sessionId: h.manager.getSessionId(),
    persist: (data) => h.pi.appendEntry(XS_MEMBERSHIP_CUSTOM_TYPE, data),
  });
  membership.attach();
  membership.join();
  const r = new XsReceiver({
    sessionId: h.manager.getSessionId(),
    membership,
    fence: h.fence,
    inbox: new XsInbox(8),
    recvPerHour: 100,
    wakesInPerHour: 100,
    host: {
      isIdle: () => h.session.isIdle,
      hasPendingMessages: () => h.session.pendingMessageCount > 0,
      sendMessage: (m, o) => h.pi.sendMessage(m, o),
      getLeafEntry: () => h.manager.getLeafEntry() ?? undefined,
    },
  });
  let n = 0;
  return () =>
    r.deliver({
      xid: `cx-fence-${h.manager.getSessionId()}-${++n}`,
      to: { sessionId: h.manager.getSessionId(), epoch: membership.epoch },
      from: { sessionId: "source-session", ref: "source", cwdLabel: "/tmp", agentId: "source-agent" },
      text: "fence probe",
      wake: false,
      expiresAt: Date.now() + 5000,
    });
}
async function prepareCompaction(h: Env) {
  await prime(h);
  await h.session.prompt("second turn with enough history for compaction");
  // Real pi's context estimator reads the last REAL response usage. All stub traffic stays local.
  h.settings.setCompactionEnabled(true);
}

describe("fabric phase-2 real pi contracts", () => {
  it("C-X1: custom token shape, synchronous !isIdle after send, ctx.abort emits settled", async () => {
    const stub = await AnthropicStub.start({ respond: (_r, i) => (i > 0 ? { kind: "hang" } : undefined) });
    const h = await host({ stub });
    await prime(h);
    const result = h.wake();
    expect(result).toMatchObject({ dispatched: true, effect: "applied" });
    expect(h.ctx.isIdle()).toBe(false);
    await stub.waitForRequests(2);
    expect(h.triggers.at(-1)).toMatchObject({
      messageType: "custom",
      message: { customType: "subagent:xs", details: { xsWake: true, wakeToken: h.controller.activeToken } },
    });
    expect(h.cap.state).toBe("verified");
    await h.ctx.abort();
    await until(() => h.settled.length === 2, "aborted settled");
    expect(h.settled.at(-1)).toBe(true);
    expect(h.controller.state).toBe("idle");
    expect(h.errors).toEqual([]);
  });

  it("C-X1b: pre-start compaction >10s remains owned, starts with token and deadline aborts the slow provider", async () => {
    const compact = deferred();
    let compactStarted = false;
    let customStarted = false;
    const stub = await AnthropicStub.start({
      reply: (_r, i) => ({ kind: "text", text: `answer ${i}`, usage: { input_tokens: 950 } }),
      respond: (_r, i) =>
        i === 2
          ? ((compactStarted = true), compact.promise.then(() => undefined))
          : customStarted
            ? { kind: "hang" }
            : undefined,
    });
    const h = await host({
      stub,
      extensions: [
        (pi) => {
          pi.on("before_agent_start", (e) => {
            if (e.messageType === "custom") customStarted = true;
          });
        },
      ],
    });
    await prepareCompaction(h);
    expect(h.wake()).toMatchObject({ effect: "applied" });
    await until(() => compactStarted, "pre-start compaction reached local stub");
    expect(h.controller.state).toBe("starting");
    expect(h.ledger.hasOwner(h.manager.getSessionId())).toBe(true);
    await sleep(10_050);
    h.clock.advance(10_050);
    expect(h.audit).toContain("wake_slow_start");
    expect(h.controller.state).toBe("starting");
    compact.resolve();
    await until(() => h.controller.state === "bound", "late token bound");
    await until(() => customStarted && h.stub.requests.length >= 4, "custom run reached provider");
    h.clock.advance(9950);
    await until(() => h.settled.length === 3, "deadline abort settled");
    expect(h.settled.at(-1)).toBe(true);
    expect(h.controller.state).toBe("idle");
  }, 25_000);

  it("C-X1b: abort during pre-start compaction sends zero requests for the triggered run", async () => {
    let entered = false;
    const h = await host({
      extensions: [
        (pi) =>
          pi.on("session_before_compact", async (e) => {
            entered = true;
            await new Promise<void>((r) => e.signal.addEventListener("abort", () => r(), { once: true }));
            return { cancel: true };
          }),
      ],
    });
    await prime(h);
    await h.session.prompt("history");
    h.settings.setCompactionEnabled(true);
    // Last real response below threshold: make the model's context small enough for pre-start compaction.
    h.session.agent.state.model = { ...h.session.model!, contextWindow: 110 };
    const before = h.stub.requests.length;
    h.wake();
    await until(() => entered, "compaction hook entered before trigger provider");
    h.clock.advance(20_000);
    await until(() => h.settled.length === 3, "aborted before provider");
    expect(h.stub.requests).toHaveLength(before);
    expect(h.settled.at(-1)).toBe(true);
    expect(h.ledger.hasOwner(h.manager.getSessionId())).toBe(false);
    expect(h.session.isIdle).toBe(true);
  });

  it("C-X1b: dispatch inside agent_settled defers with token; human input during startup hands over without abort", async () => {
    let h!: Env;
    let dispatched: unknown;
    let once = false;
    const starting = deferred();
    const release = deferred();
    let hold = false;
    h = await host({
      extensions: [
        (pi) => {
          pi.on("agent_settled", () => {
            if (!once) {
              once = true;
              dispatched = h.wake();
            }
          });
          pi.on("before_agent_start", async (e) => {
            if (e.messageType === "custom" && hold) {
              starting.resolve();
              await release.promise;
            }
          });
        },
      ],
    });
    // Observe the user shape before the settled hook requests the deferred wake.
    hold = true;
    const run = h.session.prompt("human");
    await starting.promise;
    expect(dispatched).toMatchObject({ effect: "unknown", reason: "start_deferred" });
    expect(h.triggers.at(-1)).toMatchObject({
      messageType: "custom",
      message: { details: { wakeToken: h.controller.activeToken } },
    });
    expect(h.controller.state).toBe("bound");
    await h.session.extensionRunner!.emitInput("human takes over", undefined, "rpc");
    expect(h.controller.state).toBe("handedOver");
    h.clock.advance(100_000);
    expect(h.ledger.entries()[0]?.abortIssuedAt).toBeUndefined();
    release.resolve();
    await run;
    expect(h.settled.at(-1)).toBe(false);
  });

  it("C-X2: compaction >30s rejects throughout; cancellation emits compact_failed and opens only that window", async () => {
    const entered = deferred();
    const release = deferred();
    let failed = 0;
    const h = await host({
      extensions: [
        (pi) => {
          pi.on("session_before_compact", async () => {
            entered.resolve();
            await release.promise;
            return { cancel: true };
          });
          pi.on("session_compact_failed", () => {
            failed++;
          });
        },
      ],
    });
    await prime(h);
    await h.session.prompt("more history");
    const receive = receiver(h);
    const compacting = h.session.compact().catch((e: Error) => e.message);
    await entered.promise;
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:compaction" });
    await sleep(30_050);
    expect(h.fence.status().stuck).toEqual(["compaction"]);
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:compaction" });
    release.resolve();
    expect(await compacting).toMatch(/cancel/i);
    expect(failed).toBe(1);
    expect(receive()).toMatchObject({ effect: "applied" });
  }, 40_000);

  it("C-X2: cancelled tree and slow/cancelled switch stay fenced across human input (r3 M1)", async () => {
    const switchEntered = deferred();
    const switchRelease = deferred();
    const h = await host({
      extensions: [
        (pi) => {
          pi.on("session_before_tree", () => ({ cancel: true }));
          pi.on("session_before_switch", async () => {
            switchEntered.resolve();
            await switchRelease.promise;
            return { cancel: true };
          });
        },
      ],
    });
    await prime(h);
    const target = h.manager.getLeafId()!;
    await h.session.prompt("second branch");
    const receive = receiver(h);
    expect(await h.session.navigateTree(target)).toMatchObject({ cancelled: true });
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:tree" });
    await h.session.extensionRunner!.emitInput("human input", undefined, "rpc");
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:tree" });
    h.fence.reset();
    const runtime = new AgentSessionRuntime(h.session, { cwd: h.dir, agentDir: h.agentDir } as never, async () => {
      throw new Error("cancelled switch must not build replacement");
    });
    const switching = runtime.newSession();
    await switchEntered.promise;
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:switch" });
    await h.session.extensionRunner!.emitInput("human during async before_switch", undefined, "rpc");
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:switch" });
    switchRelease.resolve();
    expect(await switching).toMatchObject({ cancelled: true });
    expect(receive()).toMatchObject({ effect: "none", reason: "fenced:switch" });
    h.fence.reset();
    expect(receive()).toMatchObject({ effect: "applied" });
  });

  it("C-X3: quiet notice neither interrupts nor closes a real ask_user dialog", async () => {
    const completion = createBackgroundCompletionHub({ isStreaming: () => true, now: Date.now });
    const mounted = deferred();
    let component: { handleInput(data: string): void } | undefined;
    const stub = await AnthropicStub.start({
      reply: (_r, i) =>
        i === 0
          ? {
              kind: "tool",
              calls: [
                {
                  name: "ask_user",
                  input: { questions: [{ question: "Choose", options: [{ label: "A" }, { label: "B" }] }] },
                },
              ],
            }
          : { kind: "text", text: "answered" },
    });
    let closed = 0;
    const ui = {
      theme: stubTheme,
      setStatus() {},
      notify() {},
      setWidget() {},
      custom: (factory: Function) =>
        new Promise((resolve) => {
          component = factory(mockTui, stubTheme, {}, (result: unknown) => {
            closed++;
            resolve(result);
          });
          mounted.resolve();
        }),
    };
    const h = await host({
      stub,
      ui,
      extensions: [
        (pi) =>
          wireAskUser(pi, {
            background: () => completion,
            interrupt: () => ({
              enabled: true,
              delayMs: 0,
              quietMs: 0,
              maxDeferMs: 0,
              reaskDwellMs: 0,
              maxPerQuestion: 3,
              rpc: false,
            }),
          } as never),
      ],
    });
    const run = h.session.prompt("ask me");
    await mounted.promise;
    let broadcasts = 0;
    const off = completion.subscribe(() => broadcasts++);
    h.pi.sendMessage(
      { customType: "subagent:notification", content: "quiet xs completion", display: true, details: { quiet: true } },
      { triggerTurn: false },
    );
    await sleep(50);
    expect(closed).toBe(0);
    expect(broadcasts).toBe(0);
    expect(completion.pendingTokens()).toBe(0);
    expect(stub.requests).toHaveLength(1);
    component!.handleInput("\r");
    await run;
    expect(closed).toBe(1);
    expect(stub.requests).toHaveLength(2);
    expect(
      h.manager.getBranch().filter((e) => e.type === "custom_message" && e.content === "quiet xs completion"),
    ).toHaveLength(1);
    off();
    completion.dispose();
  });

  it("C-X1b/B1: an orphan marked trigger is aborted before the first provider request", async () => {
    const h = await host();
    await prime(h);
    const before = h.stub.requests.length;
    h.pi.sendMessage(
      {
        customType: "subagent:xs",
        content: "orphan body",
        display: false,
        details: { xsWake: true, wakeToken: "unowned-token" },
      },
      { triggerTurn: true },
    );
    await until(() => h.settled.length === 2, "orphan settled");
    expect(h.audit).toContain("wake_orphan_aborted");
    expect(h.settled.at(-1)).toBe(true);
    expect(h.stub.requests).toHaveLength(before);
  });

  it("C-X4: in-memory pi membership survives rebuild, has no disk durability, fork id does not inherit", async () => {
    const h = await host();
    expect(h.manager.getSessionFile()).toBeUndefined();
    const make = (sessionId: string) =>
      new XsMembership({ sessionId, persist: (data) => h.pi.appendEntry(XS_MEMBERSHIP_CUSTOM_TYPE, data) });
    const membership = make(h.manager.getSessionId());
    membership.attach();
    membership.join();
    membership.setReceive("deliver");
    const restored = make(h.manager.getSessionId());
    restored.attach();
    restored.restore(readXsMembershipEntry(h.manager.getBranch()));
    expect(restored.joined).toBe(true);
    expect(restored.receive).toBe("deliver");
    expect(h.manager.getSessionFile()).toBeUndefined();
    const fork = make(SessionManager.inMemory(h.dir).getSessionId());
    fork.attach();
    fork.restore(readXsMembershipEntry(h.manager.getBranch()));
    expect(fork.joined).toBe(false);
  });

  it("C-X5: details/token/xid/source never enter provider payload; enabled tools/system are stable across requests", async () => {
    const h = await host();
    await prime(h);
    const result = h.wake("SECRET-XID-PAYLOAD");
    expect(result).toMatchObject({ effect: "applied" });
    const token = h.controller.activeToken!;
    await until(() => h.settled.length === 2, "wake settled");
    h.pi.sendMessage(
      {
        customType: "subagent:xs",
        content: "public body only",
        display: false,
        details: { xid: "SECRET-XID-DELIVER", from: { sessionId: "SECRET-SOURCE" } },
      },
      { triggerTurn: false },
    );
    await h.session.prompt("next human");
    expect(h.stub.requests).toHaveLength(3);
    const bodies = h.stub.requests.map((r) => r.body).join("\n");
    for (const secret of [token, "SECRET-XID-PAYLOAD", "SECRET-XID-DELIVER", "SECRET-SOURCE", "wakeToken", "xsWake"])
      expect(bodies).not.toContain(secret);
    for (const r of h.stub.requests) {
      expect(r.json.system).toEqual(h.stub.requests[0]!.json.system);
      expect(r.json.tools).toEqual(h.stub.requests[0]!.json.tools);
    }
    expect((h.stub.requests[0]!.json.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_sessions", "message_session"]),
    );
    expect(bodies).toContain("public body only");
  });

  it("C-X6: phase-1 C-P1–C-P5 and consult-preserve C1–C7 remain green", async () => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.config.ts",
        "--maxWorkers",
        "2",
        "tests/conformance/fabric-wake.test.ts",
        "tests/conformance/consult-preserve.test.ts",
      ],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    );
    console.info("C-X6 delegated real-pi gates:\n" + result.stdout);
    expect(result.stdout).toMatch(/2 passed/);
    expect(result.stdout).not.toMatch(/Test Files\s+\d+ failed/);
  }, 190_000);

  it("C-X7: record pi's duplicate-tool arbitration without depending on the winner", async () => {
    const calls: string[] = [];
    const stub = await AnthropicStub.start({
      reply: (_r, i) =>
        i === 0
          ? {
              kind: "tool",
              calls: [{ name: "message_session", input: { to: "target123456", text: "arbitration probe" } }],
            }
          : { kind: "text", text: "recorded" },
    });
    const duplicate = (label: string) => (pi: ExtensionAPI) =>
      pi.registerTool({
        name: "message_session",
        label,
        description: `duplicate ${label}`,
        parameters: Type.Object({}),
        execute: async () => {
          calls.push(label);
          return { content: [{ type: "text", text: label }], details: {} };
        },
      });
    const h = await host({ stub, extensions: [duplicate("first"), duplicate("second")] });
    await h.session.prompt("duplicate probe");
    console.info(
      "C-X7 observed arbitration (record-only):",
      JSON.stringify({
        visible: h.session
          .getAllTools()
          .filter((t) => t.name === "message_session")
          .map((t) => t.description),
        executed: calls,
        toolResults: h.manager.getBranch().filter((e) => e.type === "message" && e.message.role === "toolResult"),
        errors: h.errors,
      }),
    );
  });
});
