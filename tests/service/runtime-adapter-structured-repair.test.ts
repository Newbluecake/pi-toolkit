import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { STRUCTURED_REPAIR_PROMPT } from "../../src/core/structured-repair.js";
import { VERDICT_SCHEMA_V1 } from "../../src/core/verdict-schema.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, DriverEvent, RunOutcome, RunSnapshot } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { getInputBudgetRegistry } from "../../src/runtime/input-budget-registry.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { createCapWatcher } from "../../src/runtime/cap-watcher.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { Runner, RunnerSpec } from "../../src/service/ports.js";
import type { SpawnRequest } from "../../src/service/spawn-service.js";
import type { Notifier } from "../../src/delivery/notifier.js";
import type { ExternalAgentsPort } from "../../src/external-agent/types.js";

/**
 * Structured-output repair turn (structured-output-repair-plan.md §3.2): the
 * runner+adapter integration over a fake SessionHandle. The harness follows
 * the plan's requirements: a FakeClock, a REAL late-bound EventWatchdog
 * (getState/dispatch wired to the adapter exactly like stack.ts, budget =
 * DEFAULT_BUDGET unless a case says otherwise — never an inflated budget),
 * and a fake handle whose getActiveTools includes "StructuredOutput".
 */

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

const objSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const validPayload = { answer: "42" };

interface PromptScript {
  /** fired synchronously inside prompt() (bind listener still attached). */
  events?: DriverEvent[];
  /** executed against the injected StructuredOutput tool before settling the prompt. */
  submit?: unknown;
  mode?: "resolve" | "hang" | "reject";
  /** test hook at prompt() time (e.g. queue an abort microtask). */
  onPrompt?: (ctx: { abort: () => void }) => void;
}

const textTurn = (): DriverEvent[] => [{ t: "turn_start" }, { t: "message_end" }, { t: "turn_end", toolResults: 0 }];

interface HarnessOpts {
  first?: PromptScript;
  repair?: PromptScript;
  activeTools?: string[];
  budgetOverride?: Partial<DeadlineBudget>;
  watchdogBudget?: DeadlineBudget;
  request?: Partial<SpawnRequest>;
  deps?: Partial<RuntimeAdapterDeps>;
  model?: { provider: string; id: string };
  sessionId?: string;
  sessionFile?: string;
  turnError?: string;
  /** #16 variant B: getSwitchTail returns an unconsumed tail once the repair prompt has been called. */
  repairSwitchTail?: boolean;
  callbacks?: { onSnapshot?: (snapshot: RunSnapshot) => void };
}

interface StructuredToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: { ok?: boolean; errors?: string[]; code?: "window_closed" };
}

interface Harness {
  clock: FakeClock;
  store: MemoryRunStore;
  runP: Promise<RunOutcome>;
  adapter: Runner;
  runId: string;
  prompts: string[];
  toolResults: StructuredToolResult[];
  repairAborts: () => number;
  requestAbortCalls: () => number;
  disposeCalls: () => number;
  deadlineFired: () => number;
  emit: (e: DriverEvent) => void;
  submit: (value: unknown) => Promise<StructuredToolResult>;
  releasePending: () => void;
  enqueue: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  journal: ReturnType<typeof vi.fn>;
  onLifecycle: ReturnType<typeof vi.fn>;
}

function startRun(opts: HarnessOpts = {}): Harness {
  const clock = new FakeClock(1_000_000);
  const store = new MemoryRunStore();
  const pool = new SingleSlotPool(clock, 4);
  const reaper = new EscalatingReaper(clock);
  const runId = "r-repair";
  const sessionId = opts.sessionId ?? "s-repair";
  const first: PromptScript = { events: textTurn(), ...opts.first };
  const repair: PromptScript = { events: textTurn(), ...opts.repair };
  const prompts: string[] = [];
  const toolResults: StructuredToolResult[] = [];
  const requestAbortMock = vi.fn();
  const disposeMock = vi.fn(
    () => ({ returned: true, killed: 0, unkillable: [] }) as ReturnType<SessionHandle["dispose"]>,
  );
  let repairAbortCount = 0;
  let onEvent: ((e: DriverEvent) => void) | undefined;
  let capturedReq: { customTools?: unknown[] } | undefined;
  let pendingCtl: { resolve: () => void; reject: (e: Error) => void; isRepair: boolean } | undefined;
  let adapterRef: Runner | undefined;

  const structuredTool = ():
    { execute: (id: string, params: unknown) => Promise<StructuredToolResult> } | undefined => {
    const list = capturedReq?.customTools ?? [];
    const found = list.find((t) => (t as { name?: unknown }).name === "StructuredOutput");
    return found as { execute: (id: string, params: unknown) => Promise<StructuredToolResult> } | undefined;
  };
  const submit = async (value: unknown) => {
    const tool = structuredTool();
    if (!tool) throw new Error("StructuredOutput tool not injected");
    const result = await tool.execute(`tc-${toolResults.length + 1}`, value);
    toolResults.push(result);
    return result;
  };

  const handle: SessionHandle = {
    sessionId,
    sessionFile: opts.sessionFile,
    prompt: (text: string) => {
      prompts.push(text);
      const isRepair = text === STRUCTURED_REPAIR_PROMPT;
      const script = isRepair ? repair : first;
      for (const e of script.events ?? []) onEvent?.(e);
      script.onPrompt?.({
        abort: () => {
          void adapterRef?.abort(runId, "user_stop");
        },
      });
      if (script.submit !== undefined) void submit(script.submit);
      const mode = script.mode ?? "resolve";
      if (mode === "reject") return Promise.reject(new Error("pi refused the prompt"));
      if (mode === "hang")
        return new Promise<void>((resolve, reject) => {
          pendingCtl = { resolve, reject, isRepair };
        });
      return Promise.resolve();
    },
    steer: () => Promise.resolve(),
    requestAbort: () => {
      requestAbortMock();
      if (pendingCtl) {
        if (pendingCtl.isRepair) repairAbortCount += 1;
        const rej = pendingCtl.reject;
        pendingCtl = undefined;
        rej(new Error("aborted via requestAbort"));
      }
      return Promise.resolve();
    },
    dispose: disposeMock,
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => opts.activeTools ?? ["read", "edit", "bash", "write", "StructuredOutput"],
    getLastAssistantText: () => "first-turn-final-text",
    getTurnError: () => opts.turnError,
    getSwitchTail: () =>
      opts.repairSwitchTail && prompts.length >= 2 ? { seq: 1, entryId: "e1", assistantAfter: false } : undefined,
    getUsage: () => undefined,
  };
  const driver: SessionDriver = {
    create: async (req) => {
      capturedReq = req as { customTools?: unknown[] };
      return handle;
    },
    bind: async (_h, onE) => {
      onEvent = onE;
    },
    onLateArrival: () => undefined,
  };
  const notifier: Notifier = {
    enqueue: vi.fn(),
    finalize: vi.fn(() => "updated" as const),
    settleBatch: () => undefined,
    ack: () => false,
    peek: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
    ackedSuppressions: 0,
    dispose: () => undefined,
  };
  const journal = vi.fn();
  const onLifecycle = vi.fn();
  let deadlineFiredCount = 0;
  const runnerRef: { current?: Runner } = {};
  const watchdog = new EventWatchdog({
    clock,
    budget: opts.watchdogBudget ?? DEFAULT_BUDGET,
    getState: (id, gen) => runnerRef.current?.getRunState(id, gen),
    dispatch: (id, gen, input) => {
      if (input.kind === "deadline_fired") {
        deadlineFiredCount += 1;
        runnerRef.current?.fireDeadline(id, gen, input);
      }
    },
  });
  const adapter = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    journal,
    onLifecycle,
    ...opts.deps,
  });
  adapterRef = adapter;
  runnerRef.current = adapter;
  const spec: RunnerSpec = {
    runId,
    type,
    request: { type: "worker", prompt: "do the task", ...opts.request } as SpawnRequest,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    budget: { ...DEFAULT_BUDGET, ...opts.budgetOverride },
  };
  const runP = adapter.run(spec, opts.callbacks);
  return {
    clock,
    store,
    runP,
    adapter,
    runId,
    prompts,
    toolResults,
    repairAborts: () => repairAbortCount,
    requestAbortCalls: () => requestAbortMock.mock.calls.length,
    disposeCalls: () => disposeMock.mock.calls.length,
    deadlineFired: () => deadlineFiredCount,
    emit: (e) => onEvent?.(e),
    submit,
    releasePending: () => {
      if (pendingCtl) {
        const res = pendingCtl.resolve;
        pendingCtl = undefined;
        res();
      }
    },
    enqueue: notifier.enqueue as unknown as ReturnType<typeof vi.fn>,
    finalize: notifier.finalize as unknown as ReturnType<typeof vi.fn>,
    journal,
    onLifecycle,
  };
}

async function drain(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function driveToSettle(
  h: { clock: FakeClock; runP: Promise<RunOutcome> },
  stepMs = 500,
  maxMs = 2_000_000,
): Promise<RunOutcome> {
  let out: RunOutcome | undefined;
  void h.runP.then((o) => {
    out = o;
  });
  for (let t = 0; out === undefined && t < maxMs; t += stepMs) {
    await drain(10);
    h.clock.advance(stepMs);
    await drain(10);
  }
  if (out === undefined) throw new Error("run did not settle within the drive budget");
  await drain(40); // let the background reap ladder finish (steer/requestAbort/dispose)
  return out;
}

async function untilPrompts(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < 400 && h.prompts.length < n; i++) await Promise.resolve();
  if (h.prompts.length < n) throw new Error(`expected ${n} prompt call(s), got ${h.prompts.length}`);
}

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);

describe("runtime-adapter structured repair: happy paths and no-op paths", () => {
  it("#1 first turn submits nothing, repair turn submits — completed with the captured result, first-turn text, one settlement", async () => {
    const h = startRun({
      request: { schema: objSchema },
      repair: { submit: validPayload },
    });
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("completed");
    expect(outcome.structuredResult).toEqual(validPayload);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toBe(STRUCTURED_REPAIR_PROMPT);
    expect(outcome.text).toBe("first-turn-final-text");
    expect(outcome.diag.structuredRepair).toBe("succeeded");
    expect(outcome.runId).toBe(h.runId);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]?.[1]).toEqual({ hold: true });
    expect(h.finalize).toHaveBeenCalledTimes(1);
    const terminalLifecycle = h.onLifecycle.mock.calls.filter((c) => TERMINAL.has((c[0] as { status: string }).status));
    expect(terminalLifecycle).toHaveLength(1);
    const snapshot = h.store.get(h.runId);
    expect(snapshot?.outcome.diag.structuredRepair).toBe("succeeded");
    expect(snapshot?.diag.structuredRepair).toBe("succeeded");
  });

  it("#2 repair turn still submits nothing — failed(schema) with the '(after one repair turn)' suffix, diag failed", async () => {
    const h = startRun({ request: { schema: objSchema } });
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("schema");
    expect(outcome.error?.message).toBe(
      "subagent reached a terminal state without submitting a StructuredOutput result (after one repair turn)",
    );
    expect(h.prompts).toHaveLength(2);
    expect(outcome.diag.structuredRepair).toBe("failed");
  });

  it("#3 no repair without eligibility: already captured / no schema / external path / structuredRepair:false / tool not active", async () => {
    // already captured in the first turn
    const captured = startRun({ request: { schema: objSchema }, first: { submit: validPayload } });
    const outCaptured = await driveToSettle(captured);
    expect(outCaptured.status).toBe("completed");
    expect(outCaptured.structuredResult).toEqual(validPayload);
    expect(captured.prompts).toHaveLength(1);
    expect(outCaptured.diag.structuredRepair).toBeUndefined();

    // no schema at all
    const noSchema = startRun({});
    const outNoSchema = await driveToSettle(noSchema);
    expect(outNoSchema.status).toBe("completed");
    expect(outNoSchema.structuredResult).toBeUndefined();
    expect(noSchema.prompts).toHaveLength(1);

    // external (droid) path: the adapter builds no repair spec (U6), one prompt
    const externalPort = {
      owns: (p: string) => p === "droid",
      exists: () => true,
      unavailableReason: () => undefined,
      unknownModelMessage: () => "unknown",
      advertised: () => [],
      ownerOfSessionFile: () => undefined,
      planRun: () => ({
        provider: "droid",
        modelId: "x",
        roleName: "worker",
        contextBlocks: [],
        persistTranscript: true,
        runId: "r-repair",
        pricing: { status: "unpriced", reason: "zero_price" },
        degraded: [],
      }),
      pricingFor: () => ({ status: "unpriced", reason: "zero_price" }),
      dispose: () => undefined,
    } as unknown as ExternalAgentsPort;
    const external = startRun({
      request: { schema: objSchema },
      model: { provider: "droid", id: "x" },
      deps: { external: externalPort },
    });
    const outExternal = await driveToSettle(external);
    expect(external.prompts).toHaveLength(1);
    expect(outExternal.error?.message).not.toContain("repair turn");

    // structuredRepair: false test seam
    const disabled = startRun({ request: { schema: objSchema }, deps: { structuredRepair: false } });
    const outDisabled = await driveToSettle(disabled);
    expect(outDisabled.status).toBe("failed");
    expect(outDisabled.error?.message).not.toContain("repair turn");
    expect(disabled.prompts).toHaveLength(1);

    // StructuredOutput not in the active tool set — skipped_tool, no suffix
    const noTool = startRun({ request: { schema: objSchema }, activeTools: ["read", "edit"] });
    const outNoTool = await driveToSettle(noTool);
    expect(outNoTool.status).toBe("failed");
    expect(outNoTool.error?.message).not.toContain("repair turn");
    expect(noTool.prompts).toHaveLength(1);
    expect(outNoTool.diag.structuredRepair).toBeUndefined();
  });

  it("#4 first-turn failures never repair: turnError / prompt rejected / first-turn abort / first-turn timeout", async () => {
    // turnError on the first (completed-looking) turn
    const turnErr = startRun({ request: { schema: objSchema }, turnError: "provider crashed" });
    const outTurnErr = await driveToSettle(turnErr);
    expect(outTurnErr.status).toBe("failed");
    expect(outTurnErr.error?.kind).toBe("model");
    expect(turnErr.prompts).toHaveLength(1);

    // pi rejected the first prompt outright
    const rejected = startRun({ request: { schema: objSchema }, first: { mode: "reject" } });
    const outRejected = await driveToSettle(rejected);
    expect(outRejected.status).toBe("failed");
    expect(outRejected.error?.message).toContain("pi refused the prompt");
    expect(rejected.prompts).toHaveLength(1);

    // user abort while the first prompt hangs
    const aborted = startRun({ request: { schema: objSchema }, first: { mode: "hang" } });
    await untilPrompts(aborted, 1);
    void aborted.adapter.abort(aborted.runId, "user_stop");
    const outAborted = await driveToSettle(aborted);
    expect(outAborted.status).toBe("aborted");
    expect(aborted.prompts).toHaveLength(1);

    // total-budget timeout on the first prompt (5s budget, hang). extendStepMs:0
    // keeps the hard ceiling at 2×total (the default step cap would lift it to
    // T+3×1h and the run could not die inside the drive budget — same note as
    // tests/integration/child-switch-runner.test.ts T-S8).
    const timedOut = startRun({
      request: { schema: objSchema },
      first: { mode: "hang" },
      budgetOverride: { totalMs: 5_000, extendStepMs: 0 },
    });
    const outTimeout = await driveToSettle(timedOut, 500, 60_000);
    expect(outTimeout.status).toBe("timed_out");
    expect(timedOut.prompts).toHaveLength(1);
    expect(outTimeout.error?.message).not.toContain("repair turn");
  });
});

describe("runtime-adapter structured repair: cancellation races (review #1)", () => {
  it("#5 abort queued between first-prompt resolve and planning — aborted, one prompt, no schema-failed", async () => {
    const h = startRun({
      request: { schema: objSchema },
      first: {
        onPrompt: ({ abort }) => {
          queueMicrotask(abort);
        },
      },
    });
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("aborted");
    expect(h.prompts).toHaveLength(1);
    expect(outcome.error?.message).not.toContain("repair");
  });

  it("#6 repair prompt resolve and runner.abort in the same microtask batch — aborted", async () => {
    const h = startRun({
      request: { schema: objSchema },
      repair: {
        onPrompt: ({ abort }) => {
          queueMicrotask(abort);
        },
      },
    });
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("aborted");
    expect(h.prompts).toHaveLength(2);
  });

  it("#7 abort right after the repair resolved — a captured valid submission does not rescue the run (R9)", async () => {
    const h = startRun({
      request: { schema: objSchema },
      repair: {
        submit: validPayload,
        onPrompt: ({ abort }) => {
          queueMicrotask(abort);
        },
      },
    });
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("aborted");
    expect(outcome.structuredResult).toBeUndefined();
    expect(h.prompts).toHaveLength(2);
    // the capture window is closed: any later submission is rejected
    const late = await h.submit(validPayload);
    expect(late.details?.ok).toBe(false);
  });

  it("#8 parent signal abort during the repair — aborted(parent_abort), run promise resolves, session disposed", async () => {
    const controller = new AbortController();
    const h = startRun({ request: { schema: objSchema, signal: controller.signal }, repair: { mode: "hang" } });
    await untilPrompts(h, 2);
    controller.abort();
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("aborted");
    expect(outcome.diag.stopCause).toBe("parent_abort");
    expect(h.prompts).toHaveLength(2);
    expect(h.disposeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("#9 input-budget abort during the repair — failed(config, input-budget)", async () => {
    const h = startRun({
      sessionId: "s-budget",
      request: { schema: objSchema, inputBudget: { maxInputTokens: 50_000 } },
      repair: { mode: "hang" },
    });
    await untilPrompts(h, 2);
    const registration = getInputBudgetRegistry().get("s-budget");
    expect(registration).toBeDefined();
    registration!.abort("input-budget: measured 60000 tokens > 50000");
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toContain("input-budget: measured 60000 tokens > 50000");
    expect(h.prompts).toHaveLength(2);
    expect(getInputBudgetRegistry().get("s-budget")).toBeUndefined();
  });
});

describe("runtime-adapter structured repair: sub-phase clocks (review #2)", () => {
  async function consumeModelTurn(h: Harness, ms: number, step = 200_000): Promise<void> {
    let consumed = 0;
    while (consumed < ms) {
      const stepNow = Math.min(step, ms - consumed);
      h.clock.advance(stepNow);
      h.emit({ t: "message_end" }); // keep the idle clock fresh; phaseEnteredAt stays
      consumed += stepNow;
      await drain(4);
    }
  }

  it("#10 default modelTurnMs nearly exhausted (1150s of 1200s): local close at +45s — failed(schema), NOT timed_out, watchdog silent", async () => {
    const h = startRun({
      request: { schema: objSchema },
      first: { mode: "hang" },
      repair: { mode: "hang" },
    });
    await untilPrompts(h, 1);
    const start = h.clock.now();
    await consumeModelTurn(h, 1_150_000);
    expect(h.clock.now()).toBe(start + 1_150_000);
    h.releasePending();
    await untilPrompts(h, 2); // planning ran, repair prompt pending
    h.clock.advance(45_000); // exactly the 45s window: local close fires
    await drain(30);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(after one repair turn)");
    expect(outcome.status).not.toBe("timed_out");
    expect(h.repairAborts()).toBe(1);
    expect(h.deadlineFired()).toBe(0);
  });

  it("#11 not enough left (1190s consumed): skipped_budget suffix, one prompt", async () => {
    const h = startRun({
      request: { schema: objSchema },
      first: { mode: "hang" },
    });
    await untilPrompts(h, 1);
    const start = h.clock.now();
    await consumeModelTurn(h, 1_190_000);
    expect(h.clock.now()).toBe(start + 1_190_000);
    h.releasePending();
    const outcome = await driveToSettle(h, 500, 30_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(repair turn skipped: not enough time left before a deadline)");
    expect(h.prompts).toHaveLength(1);
  });

  it("#12 short idle (20s): close at lastEvent+15s — schema failed, not timed_out(idle)", async () => {
    const h = startRun({
      request: { schema: objSchema },
      budgetOverride: { idleMs: 20_000 },
      repair: { mode: "hang", events: [{ t: "turn_start" }] },
    });
    await untilPrompts(h, 2);
    const start = h.clock.now();
    h.clock.advance(15_000);
    await drain(30);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(after one repair turn)");
    expect(outcome.status).not.toBe("timed_out");
    expect(h.clock.now()).toBeLessThan(start + 20_000); // closed strictly before the idle due
  });

  it("#13 short tool (10s): a non-StructuredOutput tool_start during the repair pulls the close in to +5s (dynamic early close)", async () => {
    const h = startRun({
      request: { schema: objSchema },
      budgetOverride: { toolMs: 10_000 },
      repair: { mode: "hang", events: [{ t: "turn_start" }, { t: "tool_start", toolCallId: "tc1", toolName: "bash" }] },
    });
    await untilPrompts(h, 2);
    const start = h.clock.now();
    h.clock.advance(5_000);
    await drain(30);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(after one repair turn)");
    expect(outcome.status).not.toBe("timed_out");
    expect(h.clock.now()).toBeLessThan(start + 10_000); // closed strictly before the tool due
  });

  it("#14 short compaction (12s): compaction_start during the repair closes at +7s", async () => {
    const h = startRun({
      request: { schema: objSchema },
      budgetOverride: { compactionMs: 12_000 },
      repair: { mode: "hang", events: [{ t: "turn_start" }, { t: "compaction_start", reason: "threshold" }] },
    });
    await untilPrompts(h, 2);
    const start = h.clock.now();
    h.clock.advance(7_000);
    await drain(30);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(after one repair turn)");
    expect(outcome.status).not.toBe("timed_out");
    expect(h.clock.now()).toBeLessThan(start + 12_000);
  });

  it("#15 watchdog budget shorter than the run budget: the close follows the earlier (watchdog) idle due", async () => {
    const h = startRun({
      request: { schema: objSchema },
      watchdogBudget: { ...DEFAULT_BUDGET, idleMs: 30_000 },
      repair: { mode: "hang", events: [{ t: "turn_start" }] },
    });
    await untilPrompts(h, 2);
    const start = h.clock.now();
    h.clock.advance(25_000); // 30s watchdog idle − 5s tail
    await drain(30);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(after one repair turn)");
    expect(h.deadlineFired()).toBe(0); // the local close beat the watchdog's own idle tick
    expect(h.clock.now()).toBeLessThan(start + 30_000);
  });
});

describe("runtime-adapter structured repair: self-check, late submissions, caps", () => {
  it("#16 a switch during the repair turn fails the run as failed(model) self-check — even with a valid submission", async () => {
    // variant A: the extension-reported switch_selfcheck_failed event during the repair
    const viaEvent = startRun({
      request: { schema: objSchema },
      repair: {
        submit: validPayload,
        events: [
          ...textTurn(),
          {
            t: "switch_selfcheck_failed",
            reason: "run ended right after switch_context (pi runtime semantics changed)",
          },
        ],
      },
    });
    const outEvent = await driveToSettle(viaEvent);
    expect(outEvent.status).toBe("failed");
    expect(outEvent.error?.kind).toBe("model");
    expect(outEvent.error?.message).toContain("context switch self-check failed");
    expect(outEvent.structuredResult).toBeUndefined();

    // variant B: getSwitchTail fallback — an unconsumed switch tail once the repair ran
    const viaTail = startRun({
      request: { schema: objSchema },
      repairSwitchTail: true,
      repair: { submit: validPayload },
    });
    const outTail = await driveToSettle(viaTail);
    expect(outTail.status).toBe("failed");
    expect(outTail.error?.kind).toBe("model");
    expect(outTail.error?.message).toContain("context switch self-check failed");
    expect(outTail.structuredResult).toBeUndefined();
  });

  it("#17 late submissions: submit-then-close accepted; close-then-submit rejected (tool ok:false) and the run fails", async () => {
    // (a)+(b) submit while the repair hangs, then the window closes — accepted value survives
    const accepted = startRun({ request: { schema: objSchema }, repair: { mode: "hang" } });
    await untilPrompts(accepted, 2);
    const ok = await accepted.submit(validPayload);
    expect(ok.details?.ok).toBe(true);
    accepted.clock.advance(120_000); // past windowDue: local close fires
    const lateReplacement = await accepted.submit({ answer: "must not replace 42" });
    expect(lateReplacement.details).toMatchObject({ ok: false, code: "window_closed" });
    expect(lateReplacement.content[0]?.text).toContain("Stop submitting");
    const outAccepted = await driveToSettle(accepted, 100, 5_000);
    expect(outAccepted.status).toBe("completed");
    expect(outAccepted.structuredResult).toEqual(validPayload);

    // (c)+(d) close first, submit in the same tick — tool ok:false, run failed(schema)
    const rejected = startRun({ request: { schema: objSchema }, repair: { mode: "hang" } });
    await untilPrompts(rejected, 2);
    rejected.clock.advance(120_000); // local close fired
    const result = await rejected.submit(validPayload);
    expect(result.details?.ok).toBe(false);
    const outRejected = await driveToSettle(rejected, 100, 5_000);
    expect(outRejected.status).toBe("failed");
    expect(outRejected.error?.message).toContain("(after one repair turn)");
  });

  it("#17e abort closes the capture window synchronously — a submission in the SAME synchronous stack is rejected (review r2 #4)", async () => {
    const h = startRun({ request: { schema: objSchema }, repair: { mode: "hang" } });
    await untilPrompts(h, 2);
    void h.adapter.abort(h.runId, "user_stop"); // synchronous: listener closes capture before any microtask
    const result = await h.submit(validPayload); // no microtask yielded between abort and submit
    expect(result.details?.ok).toBe(false);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("aborted");
    expect(outcome.structuredResult).toBeUndefined();
  });

  it("#18 turn cap: a 3rd turn_end without a submission closes the repair (one requestAbort); a submission defuses the cap", async () => {
    const capped = startRun({
      request: { schema: objSchema },
      repair: { mode: "hang", events: [{ t: "turn_start" }] },
    });
    await untilPrompts(capped, 2);
    capped.emit({ t: "turn_end", toolResults: 0 });
    capped.emit({ t: "turn_start" });
    capped.emit({ t: "turn_end", toolResults: 0 });
    expect(capped.repairAborts()).toBe(0);
    capped.emit({ t: "turn_start" });
    capped.emit({ t: "turn_end", toolResults: 0 }); // 3rd turn_end, still pending → close
    expect(capped.repairAborts()).toBeLessThanOrEqual(1);
    const outCapped = await driveToSettle(capped, 100, 5_000);
    expect(outCapped.status).toBe("failed");
    expect(outCapped.error?.message).toContain("(after one repair turn)");
    expect(capped.repairAborts()).toBe(1);

    const defused = startRun({
      request: { schema: objSchema },
      repair: { mode: "hang", events: [{ t: "turn_start" }] },
    });
    await untilPrompts(defused, 2);
    defused.emit({ t: "turn_end", toolResults: 0 });
    defused.emit({ t: "turn_start" });
    defused.emit({ t: "turn_end", toolResults: 0 });
    await defused.submit(validPayload); // captured: pending() now false
    defused.emit({ t: "turn_start" });
    defused.emit({ t: "turn_end", toolResults: 0 }); // 3rd turn_end, but no longer pending → no close
    defused.releasePending();
    const outDefused = await driveToSettle(defused, 100, 30_000);
    expect(outDefused.status).toBe("completed");
    expect(outDefused.structuredResult).toEqual(validPayload);
    expect(defused.repairAborts()).toBe(0);
  });

  it("#19 adapter dispose during the repair — the repair still completes and the policy/store write happen", async () => {
    const h = startRun({ request: { schema: objSchema }, repair: { mode: "hang" } });
    await untilPrompts(h, 2);
    h.adapter.dispose();
    await h.submit(validPayload);
    h.releasePending();
    const outcome = await driveToSettle(h, 100, 30_000);
    expect(outcome.status).toBe("completed");
    expect(outcome.structuredResult).toEqual(validPayload);
    expect(h.store.get(h.runId)?.outcome.status).toBe("completed");
    expect(outcome.diag.structuredRepair).toBe("succeeded");
  });

  it("#20 a real capWatcher counts the repair turn: maxTurns=1 aborts on the repair's turn_start; maxTurns=4 lets it finish", async () => {
    let capReason: string | undefined;
    let cappedHarness: Harness | undefined;
    const watcher = createCapWatcher({
      maxTurns: 1,
      maxCostUsd: 0,
      onCap: (reason) => {
        capReason = reason;
        const h = cappedHarness;
        if (h) queueMicrotask(() => void h.adapter.abort(h.runId, "user_stop"));
      },
    });
    const capped = (cappedHarness = startRun({
      request: { schema: objSchema },
      repair: { mode: "hang" },
      callbacks: { onSnapshot: (s) => watcher.onSnapshot(s) },
    }));
    const outCapped = await driveToSettle(capped, 100, 30_000);
    expect(outCapped.status).toBe("aborted");
    expect(capReason).toBe("turn_cap");
    expect(capped.prompts).toHaveLength(2);

    const watcher4 = createCapWatcher({ maxTurns: 4, maxCostUsd: 0, onCap: () => undefined });
    const finished = startRun({
      request: { schema: objSchema },
      repair: { submit: validPayload },
      callbacks: { onSnapshot: (s) => watcher4.onSnapshot(s) },
    });
    const outFinished = await driveToSettle(finished);
    expect(outFinished.status).toBe("completed");
    expect(watcher4.capReason).toBeUndefined();
  });

  it("#21 readonly domain (tidy shape): repair works, journal suppressed, nothing enqueued", async () => {
    const h = startRun({
      sessionId: "s-readonly",
      sessionFile: "readonly-sess.json",
      request: { schema: objSchema, toolDomain: "readonly", suppressDelivery: true },
      repair: { submit: validPayload },
    });
    const outcome = await driveToSettle(h);
    expect(outcome.status).toBe("completed");
    expect(outcome.structuredResult).toEqual(validPayload);
    expect(h.prompts).toHaveLength(2);
    expect(h.journal).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it("#22 trackInput run whose repair prompt is rejected: no prompt_rejected dispatch, first-turn acceptance markers kept", async () => {
    const h = startRun({
      request: { schema: objSchema, trackInput: true },
      repair: { mode: "reject" },
    });
    const outcome = await driveToSettle(h);
    expect(h.prompts).toHaveLength(2);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("(after one repair turn)");
    expect(outcome.diag.promptOutcome).toBeUndefined(); // prompt_rejected never dispatched
  });

  it("#23 verdict/v1: semantic-invalid submissions are rejected by the tool; a valid one completes with the rendered preview", async () => {
    const verdictRequest = {
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["pass", "conditional_pass", "reject"] },
          blockers: { type: "integer", minimum: 0 },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
                summary: { type: "string" },
              },
              required: ["severity", "summary"],
            },
          },
          report: { type: "string" },
        },
        required: ["verdict", "blockers", "findings", "report"],
      },
      schemaPreset: "verdict/v1" as const,
    };
    const semanticBad = {
      verdict: "reject",
      blockers: 2,
      findings: [{ severity: "blocker", summary: "one" }],
      report: "r",
    };
    const rejected = startRun({ request: verdictRequest, repair: { submit: semanticBad } });
    const outRejected = await driveToSettle(rejected);
    expect(outRejected.status).toBe("failed");
    expect(outRejected.error?.message).toContain("(after one repair turn)");
    expect(rejected.toolResults[0]?.details?.ok).toBe(false);

    const semanticGood = {
      verdict: "reject",
      blockers: 1,
      findings: [{ severity: "blocker", summary: "one" }],
      report: "looks bad",
    };
    const accepted = startRun({ request: verdictRequest, repair: { submit: semanticGood } });
    const outAccepted = await driveToSettle(accepted);
    expect(outAccepted.status).toBe("completed");
    expect(accepted.finalize).toHaveBeenCalledTimes(1);
    const patch = accepted.finalize.mock.calls[0]?.[2] as { textPreview?: string };
    expect(patch.textPreview).toContain("verdict: reject");
    expect(patch.textPreview).toContain("looks bad");
  });
});

const windowVerdict = { verdict: "pass", blockers: 0, findings: [], report: "done" };
const windowVerdictRequest = { schema: VERDICT_SCHEMA_V1, schemaPreset: "verdict/v1" as const };

function expectWindowClosed(result: StructuredToolResult): void {
  expect(result.details).toEqual({
    ok: false,
    code: "window_closed",
    errors: ["the result window for this run has closed; this submission was not accepted"],
  });
  expect(result.content[0]?.text).toContain("Stop submitting StructuredOutput for this run");
  expect(result.content[0]?.text).not.toContain("Fix the payload");
  expect(result.content[0]?.text).not.toContain("call StructuredOutput again");
}

describe("runtime-adapter structured repair: host-only closed-window preflight (#84 C)", () => {
  it.each([
    ["legal", windowVerdict],
    ["semantic-invalid", { ...windowVerdict, blockers: 1 }],
    ["schema-invalid (direct execute only)", { report: 42 }],
  ])("local close rejects %s payload with stop guidance, not a payload retry", async (_label, payload) => {
    const h = startRun({ request: windowVerdictRequest, repair: { mode: "hang" } });
    await untilPrompts(h, 2);
    h.clock.advance(120_000);
    // The direct tool harness does not exercise SDK pre-execute schema
    // rejection. Only calls reaching execute can receive window_closed.
    const result = await h.submit(payload);
    expectWindowClosed(result);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("schema");
    expect(outcome.structuredResult).toBeUndefined();
    expect(h.prompts).toHaveLength(2);
    expect(h.deadlineFired()).toBe(0);
  });

  it("onSubmit rejects a window closed synchronously after the open preflight", async () => {
    const h = startRun({
      request: windowVerdictRequest,
      repair: { mode: "hang", events: [{ t: "turn_start" }] },
    });
    await untilPrompts(h, 2);
    let semanticReads = 0;
    // A deterministic re-entry seam, not a model JSON payload: semantics runs
    // after the open preflight; its getter closes the actual capture window
    // through the existing turn cap before onSubmit gets the valid payload.
    const payload = {
      ...windowVerdict,
      get blockers() {
        semanticReads++;
        for (let n = 0; n < 3; n++) h.emit({ t: "turn_end", toolResults: 0 });
        return 0;
      },
    };
    const result = await h.submit(payload);
    expect(semanticReads).toBe(1);
    expectWindowClosed(result);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("failed");
    expect(outcome.structuredResult).toBeUndefined();
    expect(h.repairAborts()).toBe(1);
    expect(h.deadlineFired()).toBe(0);
  });

  it("open repair window permits correcting real semantic and schema errors on the same run", async () => {
    const h = startRun({ request: windowVerdictRequest, repair: { mode: "hang" } });
    await untilPrompts(h, 2);
    const semanticBad = await h.submit({ ...windowVerdict, blockers: 1 });
    expect(semanticBad.details?.ok).toBe(false);
    expect(semanticBad.details?.code).toBeUndefined();
    expect(semanticBad.content[0]?.text).toContain("fix the blockers count");
    expect(semanticBad.content[0]?.text).toContain("Fix the payload and call StructuredOutput again");
    const schemaBad = await h.submit({ ...windowVerdict, report: 42 });
    expect(schemaBad.details?.ok).toBe(false);
    expect(schemaBad.details?.code).toBeUndefined();
    expect(schemaBad.content[0]?.text).toContain('expected type "string"');
    expect(schemaBad.content[0]?.text).toContain("Fix the payload and call StructuredOutput again");
    expect((await h.submit(windowVerdict)).details).toEqual({ ok: true });
    h.releasePending();
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("completed");
    expect(outcome.structuredResult).toEqual(windowVerdict);
    expect(h.prompts).toHaveLength(2);
    expect(outcome.diag.structuredRepair).toBe("succeeded");
  });

  it.each([
    ["legal", windowVerdict],
    ["semantic-invalid", { ...windowVerdict, blockers: 1 }],
  ])("cancellation synchronously rejects a %s payload before any microtask", async (_label, payload) => {
    const h = startRun({ request: windowVerdictRequest, repair: { mode: "hang" } });
    await untilPrompts(h, 2);
    if (!h.adapter.abort) throw new Error("adapter abort is required");
    void h.adapter.abort(h.runId, "user_stop");
    const submission = h.submit(payload); // execute runs before yielding to abort cleanup
    expectWindowClosed(await submission);
    const outcome = await driveToSettle(h, 100, 5_000);
    expect(outcome.status).toBe("aborted");
    expect(outcome.structuredResult).toBeUndefined();
    expect(h.prompts).toHaveLength(2);
  });
});
