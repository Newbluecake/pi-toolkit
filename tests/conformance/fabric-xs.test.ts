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
import { XsReplyLedger, createXsReplyInboxPort } from "../../src/fabric/xs/reply-ledger.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { createListSessionsTool } from "../../src/tools/list-sessions-tool.js";
import { createMessageSessionTool } from "../../src/tools/message-session-tool.js";
import * as unread from "../../src/fabric/xs/unread.js";
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
    /** C-X11: register the alias-description instances (`alias:true`, activate-frozen in production). */
    aliasTools?: boolean;
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
        api.registerTool(createListSessionsTool({ sender, ...(options.aliasTools ? { alias: true } : {}) }));
        api.registerTool(createMessageSessionTool({ sender, ...(options.aliasTools ? { alias: true } : {}) }));
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

/** C-X8: a real receiver + REAL reply ledger over the host's real Controller / pi session. */
function replyStack(h: Env, receive: "wake" | "replies" = "wake") {
  const sessionId = h.manager.getSessionId();
  const membership = new XsMembership({
    sessionId,
    persist: (data) => h.pi.appendEntry(XS_MEMBERSHIP_CUSTOM_TYPE, data),
    replyEnabled: true,
  });
  membership.attach();
  membership.join();
  membership.setReceive(receive);
  const ledger = new XsReplyLedger();
  ledger.bindSession({ sessionId, inbox: createXsReplyInboxPort(new XsInbox(4)) });
  const r = new XsReceiver({
    sessionId,
    membership,
    fence: h.fence,
    inbox: new XsInbox(8),
    replyLedger: ledger,
    controller: h.controller,
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
  const input = (over: Record<string, unknown> = {}) => ({
    xid: `cx8-${sessionId}-${++n}`,
    to: { sessionId, epoch: membership.epoch },
    from: { sessionId: "replier-session", ref: "replier0001", cwdLabel: "/tmp", agentId: "replier-agent" },
    text: "reply body",
    wake: false,
    expiresAt: Date.now() + 5000,
    ...over,
  });
  const issue = (human: boolean) => {
    const res = ledger.issue({
      requesterSessionId: sessionId,
      replierSessionId: "replier-session",
      replierRef: "replier0001",
      origin: human ? "human" : "model",
      wakeOnReply: !human,
      requesterLevel: 1,
      timeoutMs: 600_000,
      lateGraceMs: 600_000,
      maxPending: 4,
      maxPendingPerTarget: 4,
    });
    if (!res.ok) throw new Error("issue failed");
    return res.ticket.requestId;
  };
  return { r, input, issue, ledger };
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

  it("C-X8: reply association on real pi — solicited run binds its token; reply/token details stay out of the provider payload; quiet replies stay quiet; replies mode refuses unsolicited", async () => {
    const h = await host();
    await prime(h);
    const { r, input, issue } = replyStack(h);

    // ① a solicited (model-origin) reply starts a Controller run that binds its token.
    const q1 = issue(false);
    const before1 = h.stub.requests.length;
    const v1 = r.deliver(input({ inReplyTo: q1, text: "WAKE-REPLY-BODY" }) as never);
    expect(v1).toMatchObject({ woke: true });
    expect(h.ctx.isIdle()).toBe(false);
    const token = h.controller.activeToken!;
    expect(token).toBeTruthy();
    await until(() => h.settled.length === 2, "solicited run settled");
    expect(h.stub.requests.length).toBe(before1 + 1);
    expect(h.triggers.at(-1)).toMatchObject({
      messageType: "custom",
      message: { details: { xsWake: true, wakeToken: token, inReplyTo: q1 } },
    });

    // ③ a human-origin reply is quiet: no run while idle, visible to the NEXT human prompt only.
    const q2 = issue(true);
    const before2 = h.stub.requests.length;
    const settled2 = h.settled.length;
    expect(r.deliver(input({ inReplyTo: q2, text: "QUIET-REPLY-BODY" }) as never)).toMatchObject({ woke: false });
    await sleep(100);
    expect(h.stub.requests.length).toBe(before2);
    expect(h.settled.length).toBe(settled2);
    await h.session.prompt("next human after quiet reply");
    const quietBody = h.stub.requests.at(-1)!.body;
    expect(quietBody).toContain("QUIET-REPLY-BODY");

    // B-side header rendering: an expectReply request carries reply_to into the model context.
    const dueAt = 987654321012;
    expect(
      r.deliver(
        input({
          xid: "cx8-request",
          text: "REQUEST-BODY",
          reply: { requestId: "qabcabcabcabcabcabc", dueAt },
        }) as never,
      ),
    ).toMatchObject({ effect: expect.stringMatching(/applied|unknown/) });
    await h.session.prompt("after request");

    // ② provider payload hygiene across ALL requests so far.
    const bodies = h.stub.requests.map((x) => x.body).join("\n");
    for (const secret of [token, "wakeToken", "xsWake", "inReplyTo", String(dueAt), "cx8-request", "replier-session"])
      expect(bodies).not.toContain(secret);
    expect(bodies).toContain("WAKE-REPLY-BODY");
    expect(bodies).toContain("reply_to");
    expect(bodies).toContain("qabcabcabcabcabcabc"); // the header intentionally shows the id to the model
    for (const x of h.stub.requests) {
      expect(x.json.system).toEqual(h.stub.requests[0]!.json.system);
      expect(x.json.tools).toEqual(h.stub.requests[0]!.json.tools);
    }

    // replies mode: unsolicited traffic never reaches the model; a valid reply still does.
    const h2 = await host();
    await prime(h2);
    const s2 = replyStack(h2, "replies");
    const n2 = h2.stub.requests.length;
    expect(s2.r.deliver(s2.input({ text: "UNSOLICITED-BODY", wake: true }) as never)).toMatchObject({
      effect: "none",
      reason: "rejected",
    });
    expect(h2.stub.requests.length).toBe(n2);
    expect(h2.session.pendingMessageCount).toBe(0);
    const q3 = s2.issue(true);
    expect(s2.r.deliver(s2.input({ inReplyTo: q3, text: "VALID-IN-REPLIES" }) as never).effect).not.toBe("none");
    await h2.session.prompt("after valid reply");
    const b2 = h2.stub.requests.map((x) => x.body).join("\n");
    expect(b2).not.toContain("UNSOLICITED-BODY");
    expect(b2).toContain("VALID-IN-REPLIES");
    expect(h.errors).toEqual([]);
    expect(h2.errors).toEqual([]);
  }, 30_000);

  it("C-X6: phase-1 C-P1–C-P5 remain green", async () => {
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
      ],
      {
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
        // CI exports FORCE_COLOR/CI; the child vitest then paints its summary with ANSI escapes
        // ("Test Files \x1b[1m\x1b[32m1 passed…"), which breaks the regexes below. Ask for plain output…
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );
    // …and strip any residual SGR sequences anyway (a runner that forces colour regardless).
    // eslint-disable-next-line no-control-regex
    const out = result.stdout.replace(/\u001b\[[0-9;]*m/g, "");
    console.info("C-X6 delegated real-pi gates:\n" + out);
    expect(out).toMatch(/Test Files\s+1 passed \(1\)/);
    expect(out).not.toMatch(/Test Files\s+\d+ failed/);
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

  /**
   * C-X9 (channel-plan §9.3): a REAL receiver + real Controller over real pi, driven with hub-stamped
   * `bc`/`via` broadcast frames. `details.bc`/`via`/token/xid never reach the provider payload; the
   * model-visible text carries the broadcast header on the first line; a quiet broadcast starts no run.
   */
  it("C-X9: broadcast metadata (bc/via/token/xid/details) stays out of the provider payload; header format is correct", async () => {
    const h = await host();
    await prime(h);
    const sessionId = h.manager.getSessionId();
    const membership = new XsMembership({
      sessionId,
      persist: (data) => h.pi.appendEntry(XS_MEMBERSHIP_CUSTOM_TYPE, data),
      replyEnabled: true,
      channelsEnabled: true,
    });
    membership.attach();
    expect(membership.join(["team"])).toMatchObject({ ok: true });
    membership.setReceive("wake");
    const r = new XsReceiver({
      sessionId,
      membership,
      fence: h.fence,
      inbox: new XsInbox(8),
      controller: h.controller,
      recvPerHour: 100,
      wakesInPerHour: 100,
      hubChannelCap: () => true,
      host: {
        isIdle: () => h.session.isIdle,
        hasPendingMessages: () => h.session.pendingMessageCount > 0,
        sendMessage: (m, o) => h.pi.sendMessage(m, o),
        getLeafEntry: () => h.manager.getLeafEntry() ?? undefined,
      },
    });
    let n = 0;
    const input = (over: Record<string, unknown> = {}) => ({
      xid: `cx9-xid-${++n}`,
      to: { sessionId, epoch: membership.epoch },
      from: { sessionId: "SECRET-BC-SENDER", ref: "bcsender0001", cwdLabel: "/tmp", agentId: "bc-agent" },
      text: "BC-BODY",
      wake: false,
      expiresAt: Date.now() + 5000,
      via: ["team"],
      bc: { channel: "team" },
      ...over,
    });

    // ① quiet (deliver-only) broadcast while idle: no run, visible to the NEXT human prompt only.
    const before = h.stub.requests.length;
    const settled0 = h.settled.length;
    expect(r.deliver(input({ text: "QUIET-BC-BODY" }) as never)).toMatchObject({ woke: false });
    await sleep(100);
    expect(h.stub.requests.length).toBe(before);
    expect(h.settled.length).toBe(settled0);
    await h.session.prompt("next human after quiet broadcast");
    const quiet = h.stub.requests.at(-1)!.body;
    expect(quiet).toContain("QUIET-BC-BODY");

    // ② a waking broadcast starts a Controller run that binds its token; the trigger carries details.bc.
    const v = r.deliver(input({ text: "WAKE-BC-BODY", wake: true, level: 0 }) as never);
    expect(v).toMatchObject({ woke: true });
    const token = h.controller.activeToken!;
    expect(token).toBeTruthy();
    await until(() => h.settled.length === settled0 + 2, "waking broadcast run settled");
    expect(h.triggers.at(-1)).toMatchObject({
      messageType: "custom",
      message: { details: { xsWake: true, wakeToken: token, bc: { channel: "team" } } },
    });

    // ③ header format: first line of the model-visible text; the host note follows; no hub metadata.
    const bcRequests = h.stub.requests.slice(before);
    const bodies = bcRequests.map((x) => x.body).join("\n");
    const header = /\[fabric xs from=[^\]]*channel=\\"#team\\" kind=\\"broadcast\\"\]/;
    expect(bodies).toMatch(header);
    expect(bodies).toContain("WAKE-BC-BODY");
    expect(bodies).toContain(
      "这是频道广播；若需回应请用 message_session 发给 from.ref，不要用 message_channel 回应全频道。",
    );

    // ④ provider payload hygiene across ALL requests.
    const all = h.stub.requests.map((x) => x.body).join("\n");
    for (const secret of [token, "wakeToken", "xsWake", "cx9-xid-1", "cx9-xid-2", "SECRET-BC-SENDER", '"bc"', '"via"'])
      expect(all.includes(secret) ? secret : "").toBe("");
    for (const x of h.stub.requests) {
      expect(x.json.system).toEqual(h.stub.requests[0]!.json.system);
      expect(x.json.tools).toEqual(h.stub.requests[0]!.json.tools);
    }
    expect(h.errors).toEqual([]);
  }, 30_000);

  /**
   * C-X11 (alias-plan §9): real pi + local Anthropic stub. The alias-flavoured tool instances (description
   * suffix only; same parameter schema) are byte-stable across requests; a hub-stamped `from.alias` reaches the
   * model ONLY as the independent ` alias="…"` header field (never inside `from=` and never as JSON metadata);
   * details / token / xid / the full sessionId never enter the provider payload.
   */
  it("C-X11: alias tool schema is stable across requests; alias rides only as an independent header field; details/token stay out of the provider payload", async () => {
    const h = await host({ aliasTools: true });
    await prime(h);
    const sessionId = h.manager.getSessionId();
    const membership = new XsMembership({
      sessionId,
      persist: (data) => h.pi.appendEntry(XS_MEMBERSHIP_CUSTOM_TYPE, data),
      replyEnabled: true,
    });
    membership.attach();
    membership.join();
    membership.setReceive("wake");
    const r = new XsReceiver({
      sessionId,
      membership,
      fence: h.fence,
      inbox: new XsInbox(8),
      controller: h.controller,
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
    const input = (over: Record<string, unknown> = {}) => ({
      xid: `cx11-xid-${++n}`,
      to: { sessionId, epoch: membership.epoch },
      from: {
        sessionId: "SECRET-ALIAS-SENDER-SESSION",
        ref: "aliassender1",
        name: "peer-name",
        cwdLabel: "/tmp",
        agentId: "alias-agent",
        alias: "前端",
      },
      text: "ALIAS-BODY",
      wake: false,
      expiresAt: Date.now() + 5000,
      ...over,
    });
    // ① a quiet message from an alias-holding sender, then a waking one (both reach later requests).
    const settled0 = h.settled.length;
    expect(r.deliver(input({ text: "QUIET-ALIAS-BODY" }) as never)).toMatchObject({ woke: false });
    await h.session.prompt("next human after alias message");
    expect(r.deliver(input({ text: "WAKE-ALIAS-BODY", wake: true, level: 0 }) as never)).toMatchObject({ woke: true });
    const token = h.controller.activeToken!;
    await until(() => h.settled.length === settled0 + 2, "alias wake run settled");

    // ② the alias is an INDEPENDENT header field: after from=…, JSON-encoded, never inside the from object.
    const bodies = h.stub.requests.map((x) => x.body).join("\n");
    expect(bodies).toContain("ALIAS-BODY");
    const header = /\[fabric xs from=([^\]]*?) alias=\\"前端\\" cwd=/;
    const m = header.exec(bodies);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain("前端"); // the self-reported part of `from` never carries the hub alias
    expect(bodies).toContain("alias 由 hub 核验唯一，name 由对方自报");
    // the first line of the model-visible text is where the web regex reads it; one occurrence per message.
    expect(bodies.match(/alias=\\"前端\\"/g)!.length).toBeGreaterThanOrEqual(2);

    // ③ tool declarations: alias descriptions present and byte-identical in EVERY request (cache prefix).
    const tools0 = h.stub.requests[0]!.json.tools as Array<{ name: string; description: string }>;
    const byName = (t: Array<{ name: string; description: string }>, name: string) => t.find((x) => x.name === name)!;
    expect(byName(tools0, "message_session").description).toContain("short word");
    expect(byName(tools0, "list_sessions").description).toContain("hub-unique short name");
    for (const x of h.stub.requests) {
      expect(x.json.tools).toEqual(h.stub.requests[0]!.json.tools);
      expect(x.json.system).toEqual(h.stub.requests[0]!.json.system);
    }

    // ④ hygiene: no details/token/xid/full sessionId anywhere in any provider payload.
    const all = h.stub.requests.map((x) => x.body).join("\n");
    for (const secret of [token, "wakeToken", "xsWake", "cx11-xid-1", "cx11-xid-2", "SECRET-ALIAS-SENDER-SESSION"])
      expect(all.includes(secret) ? secret : "").toBe("");
    expect(h.errors).toEqual([]);
  }, 30_000);

  /**
   * C-X10 (channel-plan §12.7): ONLY pi's ordering facts that the unread counter relies on. The real
   * IB1 core is driven from a real pi extension's turn events; the writes are real `pi.sendMessage`s.
   */
  describe("C-X10: unread-inbox ordering facts", () => {
    interface TurnLog {
      kind: "start" | "end";
      count: number;
      entryResolved?: boolean;
      role?: string;
    }
    function unreadProbe() {
      const log: TurnLog[] = [];
      const agentEnds: number[] = [];
      let sid = "";
      const tap = unread.createUnreadTap(() => sid);
      const probe = {
        log,
        agentEnds,
        count: () => unread.count(sid),
        write: (api: ExtensionAPI, id: string) => {
          api.sendMessage(
            { customType: "subagent:xs", content: `quiet ${id}`, display: true, details: { xid: id } },
            { triggerTurn: false },
          );
          tap.written(id);
        },
        extension: (api: ExtensionAPI) => {
          api.on("session_start", (_e, ctx) => {
            sid = ctx.sessionManager.getSessionId();
          });
          api.on("turn_start", () => {
            unread.turnStart(sid);
            log.push({ kind: "start", count: unread.count(sid) });
          });
          api.on("turn_end", (event, ctx) => {
            const entry = ctx.sessionManager.getEntry(event.messageEntryId);
            unread.turnEnd(sid);
            log.push({
              kind: "end",
              count: unread.count(sid),
              entryResolved: entry !== undefined,
              ...(entry?.type === "message" ? { role: entry.message.role } : {}),
            });
          });
          api.on("agent_end", () => {
            unread.agentEnd(sid);
            agentEnds.push(unread.count(sid));
          });
        },
      };
      return probe;
    }
    const ends = (p: ReturnType<typeof unreadProbe>) => p.log.filter((l) => l.kind === "end");

    it("1+2: turn_end sees the persisted assistant; a write before the first turn clears at the first turn_end", async () => {
      unread.resetUnreadForTests();
      const p = unreadProbe();
      const h = await host({ extensions: [p.extension] });
      p.write(h.pi, "idle-1");
      expect(p.count()).toBe(1);
      await h.session.prompt("first human turn");
      expect(p.log[0]?.kind).toBe("start");
      const end = ends(p)[0]!;
      expect(end.entryResolved).toBe(true);
      expect(end.role).toBe("assistant");
      expect(end.count).toBe(0);
      expect(p.agentEnds.at(-1)).toBe(0);
    });

    it("3: a write during an async before_agent_start is cleared by that run's first turn_end", async () => {
      unread.resetUnreadForTests();
      const p = unreadProbe();
      const h = await host({
        extensions: [
          p.extension,
          (api) =>
            api.on("before_agent_start", async () => {
              await sleep(20);
              p.write(api, "during-bas");
            }),
        ],
      });
      await h.session.prompt("go");
      expect(ends(p)[0]?.count).toBe(0);
    });

    it("4: a write during turn k survives turn k's turn_end and clears at turn k+1's", async () => {
      unread.resetUnreadForTests();
      const p = unreadProbe();
      const gate = deferred();
      const stub = await AnthropicStub.start({
        reply: async (_r, i) => {
          if (i === 0) await gate.promise;
          return { kind: "text", text: `a${i}` };
        },
      });
      const h = await host({ stub, extensions: [p.extension] });
      const run = h.session.prompt("turn k");
      await until(() => stub.requests.length === 1, "request in flight");
      p.write(h.pi, "busy-1");
      expect(p.count()).toBe(1);
      gate.resolve();
      await run;
      expect(ends(p)[0]?.count).toBe(1);
      await h.session.prompt("turn k+1");
      expect(ends(p)[1]?.count).toBe(0);
    });

    it("5: an error turn still fires turn_end (and clears what the turn started after)", async () => {
      unread.resetUnreadForTests();
      const p = unreadProbe();
      const stub = await AnthropicStub.start({
        respond: () => ({ kind: "error", status: 400, message: "boom" }),
      });
      const h = await host({ stub, extensions: [p.extension] });
      p.write(h.pi, "before-error");
      await h.session.prompt("will fail").catch(() => undefined);
      await sleep(50);
      expect(ends(p)).toHaveLength(1);
      expect(ends(p)[0]?.count).toBe(0);
    });

    it("6: session.reload() mid-stream keeps the count; a later completed turn clears it", async () => {
      unread.resetUnreadForTests();
      const p = unreadProbe();
      const gate = deferred();
      const stub = await AnthropicStub.start({
        reply: async (_r, i) => {
          if (i === 0) await gate.promise;
          return { kind: "text", text: `a${i}` };
        },
      });
      const h = await host({ stub, extensions: [p.extension] });
      const run = h.session.prompt("stream");
      await until(() => stub.requests.length === 1, "request in flight");
      p.write(h.pi, "pre-reload");
      await h.session.reload();
      expect(p.count()).toBe(1);
      gate.resolve();
      await run.catch(() => undefined);
      await h.session.prompt("after reload").catch(() => undefined);
      await sleep(50);
      expect(p.count()).toBe(0);
    });
  });
});
