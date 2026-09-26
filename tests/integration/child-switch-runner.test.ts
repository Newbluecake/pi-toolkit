/**
 * child-context-switch plan.md §7 P3 — T-S7 (happy path) / T-D2/T-C2-style degrade, against a
 * REAL `AgentSession` (same harness style as tests/conformance/pi-boundary.test.ts, but exercising
 * OUR OWN `src/context-switch/child.ts` wiring as the extension under test, not a stand-in).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { wireChildContextSwitch } from "../../src/context-switch/child.js";
import { getChildSwitchCapability, resetChildSwitchCapabilityForTests } from "../../src/context-switch/capability.js";
import { readSettingsNoMigrate } from "../../src/config/settings.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET, hardDeadlineAtFor } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { PiSessionDriver, PiSessionHandle } from "../../src/runtime/session-driver.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

interface ScriptedTurn {
  toolCall: boolean;
  build: (model: ReturnType<typeof fakeModel>) => unknown;
}

function fakeModel() {
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

function fakeModelRuntime(model: ReturnType<typeof fakeModel>, scripted: ScriptedTurn[]) {
  let call = 0;
  const requestMessages: unknown[][] = [];
  return {
    streamSimple: (_m: unknown, context: { messages?: unknown[] }) => {
      requestMessages.push(context.messages ?? []);
      const turn = scripted[call] ?? scripted[scripted.length - 1]!;
      call += 1;
      const stream = createAssistantMessageEventStream();
      const message = turn.build(model) as { stopReason?: string };
      if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: turn.toolCall ? "toolUse" : "stop", message });
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
    callCount: () => call,
    requestMessages,
  };
}

function assistantTextMsg(model: ReturnType<typeof fakeModel>, text: string) {
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
function assistantToolCallMsg(
  model: ReturnType<typeof fakeModel>,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

const HANDOFF_ARGS = {
  goal: "Ship the child-context-switch P3 package end to end, matching the plan's boundary design.",
  progress: "Wired the turn_end handler, the context self-check observer and the capability gate.",
  next_steps: "Run the full test gate and write up the delivery report for the calling session.",
  keep_recent: false,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => resetChildSwitchCapabilityForTests());

async function withSession(
  opts: {
    scripted: ScriptedTurn[];
    extra?: unknown[];
    model?: ReturnType<typeof fakeModel>;
    settingsOverrides?: Record<string, unknown>;
    cwd?: string;
  },
  run: (env: {
    session: import("@earendil-works/pi-coding-agent").AgentSession;
    modelRuntime: ReturnType<typeof fakeModelRuntime>;
  }) => Promise<void>,
) {
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "pi-child-switch-runner-"));
  if (!opts.cwd) dirs.push(cwd);
  const model = opts.model ?? fakeModel();
  const modelRuntime = fakeModelRuntime(model, opts.scripted);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const settings = readSettingsNoMigrate(join(cwd, "does-not-exist.json"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: [
      (pi: unknown) => wireChildContextSwitch(pi as never, settings),
      ...((opts.extra ?? []) as never[]),
    ] as never,
  });
  await loader.reload();
  // MUST come after reload() — reload() re-reads settings from disk and would silently discard
  // an override applied before it.
  if (opts.settingsOverrides) settingsManager.applyOverrides(opts.settingsOverrides as never);
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    model: model as never,
    modelRuntime: modelRuntime as never,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
  });
  try {
    await run({ session, modelRuntime });
  } finally {
    session.dispose();
  }
}

describe("T-S7-lite: real AgentSession + wireChildContextSwitch, full happy path", () => {
  it("bash turn (L2 probe) -> switch_context turn (commit) -> final turn: capability reaches verified, run completes with the post-switch text", async () => {
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc2", "switch_context", HANDOFF_ARGS) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "post-switch answer") },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("please do the task");

        expect(getChildSwitchCapability().get().state).toBe("verified");
        expect(modelRuntime.callCount()).toBe(3);

        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        const compactionIdx = branch.findIndex((e) => e.type === "compaction");
        expect(compactionIdx).toBeGreaterThan(-1);
        const compaction = branch[compactionIdx]!;
        expect(compaction.fromHook).toBe(true);
        expect((compaction.details as { source?: string })?.source).toBe("pi-toolkit:switch_context");
        expect((compaction.details as { keepRecent?: boolean })?.keepRecent).toBe(false);
        // firstKeptEntryId:null means "drop everything" per the draft, but pi's own appendCompaction
        // substitutes the compaction entry's OWN id for a null firstKeptEntryId (self-retaining —
        // plan.md §0 event 2: "null ⇒ appendCompaction 用自身 id") — the PERSISTED field is never
        // literally null.
        expect(compaction.firstKeptEntryId).toBe(compaction.id);

        const resumeIdx = branch.findIndex(
          (e, i) =>
            i > compactionIdx && e.type === "custom_message" && e.customType === "subagent:switch-context-resume",
        );
        expect(resumeIdx).toBeGreaterThan(compactionIdx);

        // The third request really used the reduced context (handoff summary, not the original ask).
        const thirdRequestText = JSON.stringify(modelRuntime.requestMessages[2]);
        expect(thirdRequestText).not.toContain("please do the task");
        expect(thirdRequestText).toContain("Ship the child-context-switch P3 package");

        const lastMessage = branch[branch.length - 1];
        expect((lastMessage?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe(
          "post-switch answer",
        );
      },
    );
  });
});

describe("T-D2/T-C2-style: a colliding extension poisons the SAME turn's commit", () => {
  it("dangling context_edit from a later handler ⇒ our first switch never committed ⇒ capability disabled, run still completes", async () => {
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc2", "switch_context", HANDOFF_ARGS) },
          { toolCall: false, build: (m) => assistantTextMsg(m, "post text") },
        ],
        extra: [
          (pi: { on: (event: string, handler: (event: Record<string, unknown>) => unknown) => void }) => {
            pi.on("turn_end", (event) => {
              const toolResults = (event.toolResults as { toolCallId?: string }[] | undefined) ?? [];
              // Only poison the turn that actually carries our switch_context call — turn 1's bash
              // call must commit cleanly (it is what lets the L2 probe reach `ready` in the first place).
              if (!toolResults.some((tr) => tr.toolCallId === "tc2")) return undefined;
              return {
                entries: [
                  ...(event.entries as unknown[]),
                  { type: "context_edit", targetId: "does-not-exist", replacement: null },
                ],
              };
            });
          },
        ],
      },
      async ({ session }) => {
        await session.prompt("please do the task");

        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        // Our compaction never landed (poisoned by the colliding extension's dangling edit).
        expect(branch.some((e) => e.type === "compaction")).toBe(false);
        // The capability state machine noticed (L3(a) "uncommitted") and disabled itself —
        // this was the process's FIRST verification window, so a single failure disables.
        const status = getChildSwitchCapability().get();
        expect(status.state).toBe("disabled");
        if (status.state === "disabled") expect(status.reason).toBe("uncommitted");
        // Diagnostic entries are written exactly once per session, even though every later
        // turn_end's L1 check keeps re-observing the (sticky) disabled state.
        const capabilityNotices = branch.filter((e) => e.customType === "subagent:switch-capability");
        expect(capabilityNotices).toHaveLength(1);
        // The run still completed normally with full history intact.
        const lastAssistant = [...branch]
          .reverse()
          .find((e) => e.type === "message" && (e.message as { role?: string })?.role === "assistant");
        expect((lastAssistant?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe("post text");
        const originalUserMessage = branch.find(
          (e) => e.type === "message" && (e.message as { role?: string })?.role === "user",
        );
        expect(originalUserMessage).toBeDefined();
      },
    );
  });
});

describe("T-S10: edge case — our boundary switch commits, but pi's OWN threshold compaction fires again immediately before the next request (plan §2.3.2)", () => {
  it("pi merges our handoff as previousSummary (not lost, but rewritten); exactly one resume message; switch count / capability unaffected by pi's own re-compaction", async () => {
    const smallModel = fakeModel();
    (smallModel as { contextWindow: number }).contextWindow = 500;
    const cwd = mkdtempSync(join(tmpdir(), "pi-child-switch-s10-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    // Written to disk (not just settingsManager.applyOverrides) because `src/compact-hint/pi-
    // settings.ts`'s `readPiCompactionKeepRecentTokens`/`readPiCompactionReserveTokens` (used by
    // OUR OWN cut-point calc, `resolveKeepRecentTokens`) read the SAME on-disk project settings
    // file pi's own `SettingsManager` does — an in-memory-only override would desync the two.
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ compaction: { reserveTokens: 50, keepRecentTokens: 20 } }),
    );
    await withSession(
      {
        model: smallModel,
        cwd,
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          {
            toolCall: true,
            build: (m) => assistantToolCallMsg(m, "tc2", "switch_context", { ...HANDOFF_ARGS, keep_recent: true }),
          },
          // Consumed by pi's OWN post-switch threshold compaction (small window + keep_recent's
          // retained tail together still exceed contextWindow - reserveTokens).
          { toolCall: false, build: (m) => assistantTextMsg(m, "pi's own merged summary text") },
          { toolCall: false, build: (m) => assistantTextMsg(m, "final continuation text") },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("please do the task, this is a somewhat longer initial user message to pad things a bit");

        expect(modelRuntime.callCount()).toBe(4);
        // The THIRD call (index 2) is pi's own summarization request, not a normal agent turn — it
        // carries the summarization system prompt and folds our handoff in as `<previous-summary>`.
        const summarizationRequestText = JSON.stringify(modelRuntime.requestMessages[2]);
        expect(summarizationRequestText).toContain("context summarization assistant");
        expect(summarizationRequestText).toContain("<previous-summary>");
        expect(summarizationRequestText).toContain("Ship the child-context-switch P3 package"); // our handoff's `goal`

        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        // Exactly ONE resume custom_message on the whole branch — pi's own re-compaction does not
        // go through our turn_end handler at all (child sessions have no `session_before_compact`
        // hook, plan §2.1 "为什么不给子会话注册 session_before_compact"), so it can never duplicate ours.
        const resumeMessages = branch.filter(
          (e) => e.type === "custom_message" && e.customType === "subagent:switch-context-resume",
        );
        expect(resumeMessages).toHaveLength(1);
        // TWO compaction entries: ours (fromHook, our nonce) then pi's own natural one right after.
        const compactions = branch.filter((e) => e.type === "compaction");
        expect(compactions).toHaveLength(2);
        expect(compactions[0]?.fromHook).toBe(true);
        expect(compactions[1]?.fromHook).toBeFalsy(); // pi's own automatic compaction, not ours.

        // The run still completes normally with the final continuation's text.
        const lastMessage = branch[branch.length - 1];
        expect((lastMessage?.message as { content?: { text?: string }[] })?.content?.[0]?.text).toBe(
          "final continuation text",
        );

        // Our own switch-count / capability bookkeeping is unaffected by pi's SEPARATE, later
        // re-compaction: still exactly 1 switch, and the self-check correctly re-points at pi's
        // rewritten summary (plan §3.1 L3(a) note) instead of misjudging it as "content dropped".
        expect(getChildSwitchCapability().get().state).toBe("verified");
      },
    );
  });

  it("overflow variant: the FIRST post-switch request genuinely overflows with nothing yet to summarize (pi's `prepareCompaction` finds no completed turn since our switch) — our OWN switch bookkeeping stays intact/unaffected by pi's unrelated, separate failure", async () => {
    // Real pi's `prepareCompaction` can only summarize COMPLETED turns after the latest
    // compaction boundary (agent-session.js / compaction.js, same discovery as T-F3's "no-model"
    // case) — immediately after OUR switch commits, there is by construction no such turn yet (the
    // very next model response IS the overflow), so pi's own recovery legitimately has nothing to
    // compact and gives up silently. This sub-case therefore does not exercise a SUCCESSFUL
    // pi-side recovery (T-S10's main case above already does, via the threshold path, where a
    // completed turn DOES exist by the time pi re-checks) — it instead confirms our switch's own
    // bookkeeping is unaffected by an unrelated, later, ordinary overflow failure.
    await withSession(
      {
        scripted: [
          { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
          {
            toolCall: true,
            build: (m) => assistantToolCallMsg(m, "tc2", "switch_context", { ...HANDOFF_ARGS, keep_recent: true }),
          },
          {
            toolCall: false,
            build: (m) => ({
              role: "assistant",
              content: [],
              api: m.api,
              provider: m.provider,
              model: m.id,
              usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
              stopReason: "error",
              errorMessage: "prompt too long for this model",
              timestamp: Date.now(),
            }),
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("please do the task");
        expect(modelRuntime.callCount()).toBe(3); // no recovery compaction call — nothing to summarize.
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        // Exactly ONE compaction on the branch — ours. pi's own overflow-recovery attempt never
        // got far enough to append a second one.
        expect(branch.filter((e) => e.type === "compaction")).toHaveLength(1);
        // The overflow error IS on the branch (pi never silently drops persisted history)...
        expect(branch.some((e) => (e.message as { stopReason?: string } | undefined)?.stopReason === "error")).toBe(
          true,
        );
        // ...and our own switch bookkeeping is untouched by it: still exactly 1 switch, still
        // `verified` (pi's unrelated, later overflow failure never reaches our capability state
        // machine at all — it has no `session_before_compact`/turn_end hook into pi's own automatic
        // compaction, plan §2.1).
        expect(getChildSwitchCapability().get().state).toBe("verified");
      },
    );
  });
});

describe("T-S8: switching near the total budget does not extend the deadline", () => {
  it("run still times out on the ORIGINAL budget after a successful switch; deadlineAt/hardDeadlineAt are unchanged", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-child-switch-s8-"));
    dirs.push(cwd);
    const model = fakeModel();
    let call = 0;
    const scripted: { toolCall: boolean; build: (m: typeof model) => unknown; delayMs?: number }[] = [
      { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc1", "bash", { command: "echo hi" }) },
      { toolCall: true, build: (m) => assistantToolCallMsg(m, "tc2", "switch_context", HANDOFF_ARGS) },
      // A REAL wall-clock delay (not clock-driven — the FakeClock only advances via this test's
      // own polling loop) far longer than the total budget below: proves the switch did not push
      // the deadline out, only the ORIGINAL total budget's expiry ever gets a chance to fire.
      {
        toolCall: false,
        build: (m) => assistantTextMsg(m, "should never be seen — the run times out first"),
        delayMs: 3000,
      },
    ];
    const modelRuntime = {
      streamSimple: (_m: unknown, _context: { messages?: unknown[] }) => {
        const turn = scripted[call] ?? scripted[scripted.length - 1]!;
        call += 1;
        const stream = createAssistantMessageEventStream();
        const deliver = () =>
          stream.push({ type: "done", reason: turn.toolCall ? "toolUse" : "stop", message: turn.build(model) });
        if (turn.delayMs) setTimeout(deliver, turn.delayMs);
        else queueMicrotask(deliver);
        return stream;
      },
      getAuth: async () => undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ ok: true }),
      isUsingOAuth: () => false,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
    };
    const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
    const settings = readSettingsNoMigrate(join(cwd, "does-not-exist.json"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, ".pi-agent"),
      settingsManager,
      extensionFactories: [(pi: unknown) => wireChildContextSwitch(pi as never, settings)] as never,
    });
    await loader.reload();
    const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
    const { session } = await createAgentSession({
      cwd,
      model: model as never,
      modelRuntime: modelRuntime as never,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
    });

    const handle: SessionHandle = new PiSessionHandle(session);
    const realDriverForBind = new PiSessionDriver();
    const driver: SessionDriver = {
      create: () => Promise.resolve(handle),
      bind: (h, onEvent) => realDriverForBind.bind(h, onEvent),
      onLateArrival: () => undefined,
    };
    const clock = new FakeClock();
    const pool = new SingleSlotPool(clock, 1);
    const store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const budget = {
      ...DEFAULT_BUDGET,
      queueWaitMs: 5_000,
      startupMs: 5_000,
      bindMs: 5_000,
      firstEventMs: 20_000,
      idleMs: 20_000,
      modelTurnMs: 20_000,
      toolMs: 20_000,
      // The ORIGINAL total budget the switch must NOT extend.
      totalMs: 1500,
      abortGraceMs: 50,
      steerMs: 50,
      reapMs: 50,
    };
    const watchdog = new EventWatchdog({
      clock,
      budget,
      tickMs: 5,
      getState: () => undefined,
      dispatch: () => undefined,
    });
    const notifier = {
      enqueue: () => undefined,
      finalize: () => "missing" as const,
      settleBatch: () => undefined,
      peek: () => undefined,
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    };
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier,
      // switch_context is a RESERVED tool name (src/runtime/tool-scope.ts) — deny-by-default; the
      // real stack grants it via `stack.ts`'s live capability read (src/stack.ts). Here we just
      // grant unconditionally so the test can exercise the switch itself, not tool admission.
      childSwitchContextGrant: () => true,
    });
    const type: AgentTypeConfig = { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };
    const spec: RunnerSpec = { runId: "r1", type, request: { type: "worker", prompt: "please do the task" }, budget };
    const expectedDeadlineAt = clock.now() + budget.totalMs;
    const expectedHardDeadlineAt = hardDeadlineAtFor(clock.now(), budget, undefined);
    const runResult = runner.run(spec);

    let settled: { value: RunOutcome } | undefined;
    void runResult.then((value) => {
      settled = { value };
    });
    for (let i = 0; i < 2000 && !settled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.advance(5);
    }
    if (!settled) throw new Error("run did not settle within the tick budget");
    const outcome = settled.value;

    try {
      expect(outcome.status).toBe("timed_out");
      // The switch (verified below to have actually happened) never touched these — they are
      // exactly what the ORIGINAL budget alone would have produced.
      expect(outcome.diag.deadlineAt).toBe(expectedDeadlineAt);
      expect(outcome.diag.hardDeadlineAt).toBe(expectedHardDeadlineAt);
      const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
      // The switch DID commit successfully before the timeout fired — this is not a case where
      // the switch never happened; it happened and simply did not buy any extra time.
      expect(outcome.diag.contextSwitches?.count).toBe(1);
      expect(branch.some((e) => e.type === "compaction" && e.fromHook === true)).toBe(true);
    } finally {
      session.dispose();
    }
  });
});
