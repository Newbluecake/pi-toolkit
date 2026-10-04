import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { AgentTypeConfig, DeliveryPayload } from "../../src/core/types.js";
import { buildSessionStack, createBackgroundCompletionEventHook } from "../../src/stack.js";
import {
  resetBackgroundCompletionHealthForTest,
  type BackgroundCompletion,
} from "../../src/service/background-completions.js";
import { WORKFLOW_NOTICE_ENTRY_TYPE } from "../../src/adapters/workflow-notice.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import activate from "../../src/index.js";
import { tuiContext } from "../ask-user/bg-harness.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/**
 * ask-user-async plan §10 P2-2/P2-3: the background-completion hub wired into
 * the REAL session stack — the three true send points (subagent single +
 * digest, workflow settle, bash settle) mint tokens and broadcast, the known
 * non-completion sends (bash grace/extended, workflow re-delivery) do not,
 * and the buildSessionStack top-of-rebuild teardown keeps an old stack's
 * late flushes away from the new session's listeners.
 *
 * P2-5 (验收打回补测) adds, in the last three describe blocks below:
 *  1. ackHold-delayed sends mint only at flush time — driven by a REAL claimed
 *     run (spawn with expectAck against a scripted PiSessionDriver).
 *  2. a child run (parentRunId set ⇒ notificationSuppressedRunIds) completing
 *     never sends/mints/broadcasts — end-to-end spawn driven.
 *  3. the two index.ts teardown paths (session_start without a paired
 *     shutdown; session_shutdown's first-line hub dispose) and the /reload
 *     holder swap — driven through the REAL activate() with a fake pi bus,
 *     observed through the REAL ask_user tool's (non-)interruption.
 */

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
let tmpRoot: string;
beforeEach(() => {
  homeSandbox = sandboxHome();
  resetBackgroundCompletionHealthForTest();
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagent-bgcomp-"));
});
afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
  rmSync(tmpRoot, { recursive: true, force: true });
});

type Sent = { message: { customType: string; content: string; details?: unknown }; options?: unknown };

function fakePi() {
  const sent: Sent[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: (message: Sent["message"], options?: Sent["options"]) => {
      sent.push({ message, ...(options !== undefined ? { options } : {}) });
    },
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, sent };
}

function fakeCtx(branch: readonly unknown[] = []): { ctx: ExtensionContext; setStreaming: (v: boolean) => void } {
  let streaming = true; // tests default to "agent run in flight" (the interrupt-relevant case)
  return {
    ctx: {
      sessionManager: {
        getEntries: () => [],
        getBranch: () => branch,
        getSessionId: () => "bgcomp-test",
        getSessionFile: () => undefined,
      },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: {},
      cwd: process.cwd(),
      isIdle: () => !streaming,
    } as unknown as ExtensionContext,
    setStreaming: (v: boolean) => {
      streaming = v;
    },
  };
}

const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

function settingsWith(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir: join(tmpRoot, "bash-jobs") },
    ...overrides,
  };
}

function payload(runId: string): DeliveryPayload {
  return {
    key: `${runId}:1`,
    runId,
    generation: 1,
    status: "completed",
    textPreview: `done ${runId}`,
    diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
    createdAt: 0,
    reconcileRound: 0,
  };
}

describe("ask-user background interrupt: stack wiring (P2-2)", () => {
  it("subagent single completion mints a token + broadcasts; message_start via the real hook confirms it", () => {
    const host = fakePi();
    const { ctx } = fakeCtx();
    const stack = buildSessionStack(host.pi, ctx, settingsWith(), types, []);
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));
    // The real handler index.ts registers in activate() (holder-routed).
    const hook = createBackgroundCompletionEventHook({ current: stack });

    stack.notifier.enqueue(payload("r_single"));
    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]!.message.customType).toBe("subagent:notification");
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);
    const token = events[0]!.token!;
    expect(stack.backgroundCompletions.tokenState(token)).toBe("pending");

    hook.onMessageStart({
      message: { role: "custom", customType: "subagent:notification", content: host.sent[0]!.message.content },
    });
    expect(stack.backgroundCompletions.tokenState(token)).toBe("consumed");
    hook.onAgentEnd();
    hook.onAgentSettled();
    expect(stack.backgroundCompletions.diag.orphaned).toBe(0);
    expect(stack.backgroundCompletions.disabled).toBe(false);
  });

  it("the event hook is a no-op when the holder has no stack (pre-session_start)", () => {
    const hook = createBackgroundCompletionEventHook({});
    expect(() => {
      hook.onMessageStart({ message: { role: "custom", customType: "subagent:notification", content: "x" } });
      hook.onAgentEnd();
      hook.onAgentSettled();
    }).not.toThrow();
  });

  it("digest (coalesced batch) mints ONE token carrying the item count", () => {
    const host = fakePi();
    const { ctx } = fakeCtx();
    const stack = buildSessionStack(
      host.pi,
      ctx,
      settingsWith({ coalesceWindowMs: 100, coalesceMaxBatch: 3 }),
      types,
      [],
    );
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));

    for (const runId of ["one", "two", "three"]) stack.notifier.enqueue(payload(runId));
    expect(host.sent).toHaveLength(1);
    expect((host.sent[0]!.message.details as { kind: string }).kind).toBe("digest");
    expect(events).toEqual([{ kind: "subagent", count: 3, token: 1, at: expect.any(Number) }]);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(1);
  });

  it("a coalescer-delayed (windowed) send mints only when it actually goes out", async () => {
    const host = fakePi();
    const { ctx } = fakeCtx();
    const stack = buildSessionStack(
      host.pi,
      ctx,
      settingsWith({ coalesceWindowMs: 60, coalesceMaxBatch: 8 }),
      types,
      [],
    );
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));

    stack.notifier.enqueue(payload("windowed"));
    expect(host.sent).toHaveLength(0); // still inside the merge window
    expect(events).toHaveLength(0);
    await vi.waitFor(() => expect(host.sent).toHaveLength(1), { timeout: 2_000 });
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);
  });

  it("non-streaming send (agent idle) broadcasts without minting a token", () => {
    const host = fakePi();
    const { ctx, setStreaming } = fakeCtx();
    setStreaming(false);
    const stack = buildSessionStack(host.pi, ctx, settingsWith(), types, []);
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));
    stack.notifier.enqueue(payload("idle"));
    expect(host.sent).toHaveLength(1);
    expect(events).toEqual([{ kind: "subagent", count: 1, token: undefined, at: expect.any(Number) }]);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "bash job settle mints + broadcasts; the grace deadline notice does NOT (用户拍板：宽限不打断)",
    async () => {
      const host = fakePi();
      const { ctx } = fakeCtx();
      const stack = buildSessionStack(
        host.pi,
        ctx,
        settingsWith({
          bashJobs: {
            ...DEFAULT_SETTINGS.bashJobs,
            dir: join(tmpRoot, "bash-jobs"),
            timeoutGraceMs: 400,
            maxExtensions: 2,
            maxTimeoutFactor: 10,
          },
        }),
        types,
        [],
      );
      const events: BackgroundCompletion[] = [];
      stack.backgroundCompletions.subscribe((event) => events.push(event));

      // Negative: a backgrounded job hitting its timeout enters grace — the
      // grace notice goes out on the bash-job:timeout channel and must never
      // mint/broadcast.
      const timed = await stack.bashJobs!.create({ command: "sleep 30", cwd: process.cwd(), timeoutMs: 200 });
      try {
        // Deadline machinery arms only once the job is backgrounded.
        await stack.bashJobs!.markBackgrounded(timed.jobId);
        await vi.waitFor(
          () =>
            expect(
              host.sent.some((m) => m.message.customType === "bash-job:timeout"),
              "grace notice",
            ).toBe(true),
          { timeout: 5_000 },
        );
        expect(events).toHaveLength(0);
        expect(stack.backgroundCompletions.pendingTokens()).toBe(0);
      } finally {
        await stack.bashJobs!.kill(timed.jobId, { graceMs: 0 }).catch(() => undefined);
      }

      // Positive: a clean settle goes through the completion channel and mints.
      const job = await stack.bashJobs!.create({ command: "true", cwd: process.cwd() });
      await job.exit;
      await vi.waitFor(
        () =>
          expect(
            host.sent.some((m) => m.message.customType === "bash-job:notification"),
            "completion",
          ).toBe(true),
        { timeout: 5_000 },
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "bash", count: 1 });
      expect(events[0]!.token).toBeTypeOf("number");
    },
  );

  it("workflow live completion mints + broadcasts; a persisted re-delivery does NOT", async () => {
    const host = fakePi();
    const { ctx } = fakeCtx();
    const stack = buildSessionStack(
      host.pi,
      ctx,
      settingsWith({ workflow: { ...DEFAULT_SETTINGS.workflow, enabled: true } }),
      types,
      [],
    );
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));

    const view = stack.workflow.runs.start({
      script: 'return "ok";',
      name: "bgcomp-wf",
      budget: stack.workflow.defaultBudget,
      noReplay: true,
    });
    await vi.waitFor(
      () =>
        expect(
          host.sent.some((m) => m.message.customType === "subagent:workflow-notification"),
          "live notice",
        ).toBe(true),
      { timeout: 10_000 },
    );
    expect(stack.workflow.runs.get(view.workflowId)?.status).not.toBe("running");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "workflow", count: 1 });
    expect(events[0]!.token).toBeTypeOf("number");

    // Negative: re-delivery of a persisted pending notice keeps raw
    // pi.sendMessage (not a fresh completion; triggerTurn:false) — no mint.
    const branch = [
      {
        type: "custom",
        customType: WORKFLOW_NOTICE_ENTRY_TYPE,
        data: {
          v: 1,
          state: "pending",
          workflowId: "wf_old",
          at: Date.now(),
          content: "old workflow notice",
          name: "old-wf",
          startedAt: Date.now() - 1_000,
          outcome: { status: "completed" },
          details: { kind: "workflow" },
        },
      },
    ];
    const host2 = fakePi();
    const { ctx: ctx2 } = fakeCtx(branch);
    const stack2 = buildSessionStack(
      host2.pi,
      ctx2,
      settingsWith({ workflow: { ...DEFAULT_SETTINGS.workflow, enabled: true } }),
      types,
      [],
    );
    const events2: BackgroundCompletion[] = [];
    stack2.backgroundCompletions.subscribe((event) => events2.push(event));
    const redelivered = stack2.workflow.redeliverPendingNotices();
    expect(redelivered).toBe(1);
    expect(
      host2.sent.some(
        (m) =>
          m.message.customType === "subagent:workflow-notification" &&
          (m.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === false,
      ),
    ).toBe(true);
    expect(events2).toHaveLength(0);
    expect(stack2.backgroundCompletions.pendingTokens()).toBe(0);
  });
});

describe("ask-user background interrupt: teardown (P2-3, 评审 #7)", () => {
  it("top-of-rebuild dispose: the old hub stops broadcasting while its late flushes still deliver", () => {
    const hostA = fakePi();
    const { ctx: ctxA } = fakeCtx();
    const stackA = buildSessionStack(hostA.pi, ctxA, settingsWith(), types, []);
    const eventsA: BackgroundCompletion[] = [];
    stackA.backgroundCompletions.subscribe((event) => eventsA.push(event));

    stackA.notifier.enqueue(payload("before-rebuild"));
    expect(eventsA).toHaveLength(1);

    // Same-module rebuild (/new, /resume): buildSessionStack's FIRST disposal
    // is the previous hub.
    const hostB = fakePi();
    const { ctx: ctxB } = fakeCtx();
    const stackB = buildSessionStack(hostB.pi, ctxB, settingsWith(), types, []);
    expect(stackB.backgroundCompletions).not.toBe(stackA.backgroundCompletions);

    // The old stack's late flush still DELIVERS (pi.sendMessage semantics
    // preserved) but broadcasts nothing and mints nothing.
    stackA.notifier.enqueue(payload("after-rebuild"));
    expect(hostA.sent).toHaveLength(2);
    expect(eventsA).toHaveLength(1);
    expect(stackA.backgroundCompletions.pendingTokens()).toBe(0);
    expect(stackA.backgroundCompletions.tokenState(1)).toBeUndefined();

    // The new stack's hub works independently.
    const eventsB: BackgroundCompletion[] = [];
    stackB.backgroundCompletions.subscribe((event) => eventsB.push(event));
    stackB.notifier.enqueue(payload("new-session"));
    expect(eventsB).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);

    // All three teardown paths call the same idempotent dispose().
    expect(() => stackA.backgroundCompletions.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P2-5 gap 1+2: ackHold-delayed sends and suppressed child runs, both driven by
// REAL spawns (scripted PiSessionDriver — the run really settles, so the
// notification path really fires; only the child-session process is faked).
// ---------------------------------------------------------------------------

const workerType: AgentTypeConfig = {
  name: "worker",
  description: "worker",
  systemPrompt: "",
  promptMode: "append",
};
const typesWithWorker = {
  get: (name: string) => (name === "worker" ? workerType : undefined),
  list: () => [workerType],
  reload: async () => ({ types: [workerType], errors: [] }),
} as unknown as AgentTypeRegistry;

function fakeHandle() {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(), // resolves ⇒ prompt_settled ⇒ completed
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
  };
}

function spyOnDriver(): void {
  vi.spyOn(PiSessionDriver.prototype, "create").mockImplementation(async () => fakeHandle() as never);
  vi.spyOn(PiSessionDriver.prototype, "bind").mockResolvedValue(undefined);
}

describe("ask-user background interrupt: ackHold + suppressed runs (P2-5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ackHold: a claimed run's completion mints the token only when the ack window flushes", async () => {
    spyOnDriver();
    const host = fakePi();
    const { ctx } = fakeCtx();
    const stack = buildSessionStack(host.pi, ctx, settingsWith({ ackWindowMs: 500 }), typesWithWorker, []);
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));

    const spawned = await stack.spawn.spawn({ type: "worker", prompt: "finish fast", expectAck: true });
    if ("error" in spawned) throw new Error(spawned.error.message);
    // The run REALLY settles (scripted driver's prompt resolves) — but its
    // payload is ackHoldable (expectsAck ⇒ claimed), so it is buffered:
    // no send, no broadcast, no mint while the window is open.
    await vi.waitFor(() => expect(stack.query.get(spawned.runId)?.status).toBe("completed"), { timeout: 5_000 });
    expect(host.sent).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(0);

    // The window flushes → the SAME sendFormatted as the direct path →
    // sendCompletion → mint + broadcast exactly once.
    await vi.waitFor(() => expect(host.sent).toHaveLength(1), { timeout: 3_000 });
    expect(host.sent[0]!.message.customType).toBe("subagent:notification");
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);
    expect(stack.backgroundCompletions.tokenState(1)).toBe("pending");
  });

  it("a child run (parentRunId) completing never sends, mints, or broadcasts — parent control does", async () => {
    spyOnDriver();
    const host = fakePi();
    const { ctx } = fakeCtx();
    const stack = buildSessionStack(host.pi, ctx, settingsWith(), typesWithWorker, []);
    const events: BackgroundCompletion[] = [];
    stack.backgroundCompletions.subscribe((event) => events.push(event));

    // Control: the top-level parent completes → notification + mint + broadcast.
    const parent = await stack.spawn.spawn({ type: "worker", prompt: "parent" });
    if ("error" in parent) throw new Error(parent.error.message);
    await vi.waitFor(() => expect(host.sent).toHaveLength(1), { timeout: 5_000 });
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: expect.any(Number) }]);

    // The child run REALLY settles too (assert its terminal snapshot so a
    // never-finishing run cannot masquerade as suppression) — but
    // runtime-adapter's enqueue_delivery drops it before the outbox
    // (notificationSuppressedRunIds: child runs report to their owner only).
    const child = await stack.spawn.spawn({ type: "worker", prompt: "child", parentRunId: parent.runId });
    if ("error" in child) throw new Error(child.error.message);
    await vi.waitFor(() => expect(stack.query.get(child.runId)?.status).toBe("completed"), { timeout: 5_000 });
    // Settle-invariant: still exactly the parent's single send/broadcast.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(host.sent).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(stack.backgroundCompletions.pendingTokens()).toBe(1); // only the parent's unconfirmed token
  });
});

// ---------------------------------------------------------------------------
// P2-5 gap 3+4: the index.ts-level lifecycle — driven through the REAL
// activate() with a fake pi bus. Completions come from the REAL Agent tool →
// stack spawn chain (scripted driver); (non-)interruption is observed through
// the REAL ask_user tool's execute result, delivery through pi.sendMessage.
// ---------------------------------------------------------------------------

const ACTIVATE_HOST_KEY = Symbol.for("pi-subagent:host");
const LIFECYCLE_ASK = {
  questions: [{ question: "Lifecycle gate?", options: [{ label: "A" }, { label: "B" }] }],
};
/** 0-second interrupt timings so a broadcast interrupts on the next macrotask. */
const LIFECYCLE_SETTINGS = {
  askUser: { backgroundInterrupt: { delayS: 0, quietS: 0, maxDeferS: 0, reaskDwellS: 0 } },
};

type ActivateHost = ReturnType<typeof activatePi>;

function activatePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
  const sent: { message: { customType: string; content: unknown }; options?: unknown }[] = [];
  const pi = {
    registerTool: (tool: { name: string } & (typeof tools extends Map<string, infer T> ? T : never)) => {
      if (!tools.has(tool.name)) tools.set(tool.name, tool);
    },
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: (message: { customType: string; content: unknown }, options?: unknown) => {
      sent.push({ message, ...(options !== undefined ? { options } : {}) });
    },
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
    getAllTools: () => [...tools.values()],
    setActiveTools: () => undefined,
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, emit, sent, tools };
}

function writeLifecycleSettings(): void {
  const path = join(homeSandbox!.home, ".pi", "agent", "pi-subagent.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(LIFECYCLE_SETTINGS, null, 2) + "\n", "utf8");
}

function toolOf(host: ActivateHost, name: string): { execute: (...args: never[]) => Promise<unknown> } {
  const tool = host.tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} not registered`);
  return tool;
}

/** Dispatch one background subagent through the REAL Agent tool and wait for its
 *  completion notification to hit pi.sendMessage. */
async function runAgentOnce(host: ActivateHost, tag: string): Promise<void> {
  const before = host.sent.length;
  await toolOf(host, "Agent").execute(
    `a-${tag}`,
    { description: `bg ${tag}`, prompt: "do nothing and finish", subagent_type: "general-purpose" },
    undefined,
  );
  await vi.waitFor(
    () =>
      expect(
        host.sent.length > before && host.sent.some((m) => m.message.customType === "subagent:notification"),
        `completion ${tag}`,
      ).toBe(true),
    { timeout: 5_000 },
  );
}

/** Mimic pi's boundary delivery so the hub's minted token gets confirmed
 *  (message_start) and the run judged clean (agent_end/agent_settled) — without
 *  this a later ask_user would (correctly!) defer on the unconfirmed token. */
async function confirmLatestCompletion(host: ActivateHost): Promise<void> {
  const last = [...host.sent].reverse().find((m) => m.message.customType === "subagent:notification");
  if (last === undefined) throw new Error("no completion to confirm");
  await host.emit("message_start", {
    message: { role: "custom", customType: last.message.customType, content: last.message.content },
  });
  // goal/hook.ts's agent_end handler iterates event.messages — carry an empty list.
  await host.emit("agent_end", { messages: [] });
  await host.emit("agent_settled", {});
}

interface PendingAsk {
  promise: Promise<{ content: Array<{ type: string; text?: string }> }>;
  settled: () => boolean;
  cancel: () => void;
}

/** Execute the REAL ask_user tool against a stub ui.custom (component captured so the test
 *  can settle the dialog at cleanup); the dialog hangs until interrupted or cancelled. */
function hangAsk(host: ActivateHost, tag: string): PendingAsk {
  const tui = tuiContext();
  let done = false;
  const promise = toolOf(host, "ask_user").execute(
    `c-${tag}`,
    LIFECYCLE_ASK,
    undefined,
    undefined,
    tui.ctx,
  ) as PendingAsk["promise"];
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return {
    promise,
    settled: () => done,
    cancel: () => {
      for (const component of tui.created) component.cancel();
    },
  };
}

async function expectStillHanging(ask: PendingAsk, what: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(ask.settled(), `${what}: ask_user must NOT have settled`).toBe(false);
}

describe("ask-user background interrupt: activate-level lifecycle (P2-5)", () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[ACTIVATE_HOST_KEY];
    writeLifecycleSettings();
    spyOnDriver();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<symbol, unknown>)[ACTIVATE_HOST_KEY];
  });

  it("session_start without a paired shutdown: the defensive hub dispose keeps the OLD dialog from being interrupted while NEW-stack completions still deliver", async () => {
    const host = activatePi();
    activate(host.pi);
    const { ctx: ctxA } = fakeCtx();
    await host.emit("session_start", {}, ctxA);

    // Control: the activate-level chain works — a real completion interrupts dialog 1.
    const ask1 = hangAsk(host, "one");
    await runAgentOnce(host, "one");
    await confirmLatestCompletion(host);
    const res1 = await ask1.promise;
    expect(res1.content[0]?.text).toContain("ask_user was interrupted before the user answered");

    // Dialog 2 hangs, subscribed to stack A's hub. Then session_start fires
    // WITHOUT a paired shutdown — index.ts's defensive block disposes hub A first.
    const ask2 = hangAsk(host, "two");
    const { ctx: ctxB } = fakeCtx();
    await host.emit("session_start", {}, ctxB);

    // A completion on the NEW stack still DELIVERS (sendMessage semantics intact)…
    const sentBefore = host.sent.length;
    await runAgentOnce(host, "two");
    expect(host.sent.length).toBeGreaterThan(sentBefore);
    // …but dialog 2 (listening on the disposed hub A) is never interrupted.
    await expectStillHanging(ask2, "old-stack dialog after defensive dispose");

    ask2.cancel();
    const res2 = await ask2.promise;
    expect(res2.content[0]?.text).toContain("User cancelled");
    await host.emit("session_shutdown", {}, ctxB);
  });

  it("session_shutdown's first-line hub dispose: a late flush from the OLD stack still delivers but never interrupts — neither a straddling dialog nor one opened after shutdown", async () => {
    const host = activatePi();
    activate(host.pi);
    const { ctx } = fakeCtx();
    await host.emit("session_start", {}, ctx);

    // Dialog 1 straddles the shutdown.
    const ask1 = hangAsk(host, "straddle");
    await host.emit("session_shutdown", {}, ctx);

    // The OLD stack keeps flushing after shutdown (holder still points at it):
    // the completion is DELIVERED via pi.sendMessage…
    const sentBefore = host.sent.length;
    await runAgentOnce(host, "post-shutdown");
    expect(host.sent.length).toBeGreaterThan(sentBefore);
    // …but broadcast nothing: dialog 1 is not interrupted (hub disposed first
    // line of the shutdown handler; wireAskUser's own coordinator is disposed too).
    await expectStillHanging(ask1, "straddling dialog");
    // Settle dialog 1 BEFORE opening dialog 2: the ask queue is a per-activate FIFO
    // mutex, so a second ask would queue behind the straddling one and could never
    // be cancelled (its component is only created once it acquires).
    ask1.cancel();
    await ask1.promise;

    // A dialog opened AFTER shutdown reads the same disposed hub (holder unchanged)
    // and is equally immune to old-stack flushes.
    const ask2 = hangAsk(host, "after-shutdown");
    await runAgentOnce(host, "post-shutdown-2");
    await expectStillHanging(ask2, "post-shutdown dialog");

    ask2.cancel();
    await ask2.promise;
  });

  it("/reload (new activate + new holder): the old holder's chain delivers-but-never-interrupts; the new holder works end to end", async () => {
    const hostA = activatePi();
    activate(hostA.pi);
    const { ctx: ctxA } = fakeCtx();
    await hostA.emit("session_start", {}, ctxA);
    const askOld = hangAsk(hostA, "old");

    // pi's /reload: session_shutdown on the old runner (releases the claim,
    // disposes the old hub), then a FRESH activate with its own holder.
    await hostA.emit("session_shutdown", {}, ctxA);
    const hostB = activatePi();
    activate(hostB.pi);
    const { ctx: ctxB } = fakeCtx();
    await hostB.emit("session_start", {}, ctxB);

    // Stale events on the OLD bus route to the OLD holder's (disposed) hub: no-op.
    await hostA.emit("message_start", {
      message: { role: "custom", customType: "subagent:notification", content: "stale" },
    });
    await hostA.emit("agent_settled", {});

    // A completion driven through the OLD activation (old holder → old stack →
    // old hub) still DELIVERS on the old bus but cannot interrupt its dialog.
    const sentABefore = hostA.sent.length;
    await runAgentOnce(hostA, "old-late");
    expect(hostA.sent.length).toBeGreaterThan(sentABefore);
    await expectStillHanging(askOld, "old holder after reload");

    // The NEW holder works end to end: real completion → broadcast → interrupt.
    const askNew = hangAsk(hostB, "new");
    await runAgentOnce(hostB, "new");
    await confirmLatestCompletion(hostB);
    const resNew = await askNew.promise;
    expect(resNew.content[0]?.text).toContain("ask_user was interrupted before the user answered");

    askOld.cancel();
    await askOld.promise;
    await hostB.emit("session_shutdown", {}, ctxB);
  });
});
