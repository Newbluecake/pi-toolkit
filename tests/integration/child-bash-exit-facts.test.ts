import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeliveryPayload, RunExitFacts } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter, type RuntimeAdapterDeps } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import { formatExitFacts } from "../../src/tools/result-text.js";

/**
 * bash-timeout-grace plan §3.2/§3.7/§3.8 (P5, T25-T27): the value chain from
 * a sealed run's `RunExitFacts` all the way to `get_subagent_result`'s
 * rendered text, exercised through `createRuntimeRunnerAdapter` with a fake
 * driver (same harness shape as tests/service/runtime-adapter-x3-x10.test.ts)
 * so this covers the ACTUAL wiring this package added (`RuntimeAdapterDeps.
 * sealSession`/`onSessionSeen`), not just the P0b state-machine mechanics
 * already proven by tests/runtime/runner-session-hooks.test.ts's I-SEAL.
 */
function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "child-session-1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
    ...overrides,
  };
}
function buildAdapter(clock: FakeClock, overrides: Partial<RuntimeAdapterDeps> & { driver: SessionDriver }) {
  const pool = new SingleSlotPool(clock, 1);
  const store = overrides.store ?? new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const notifier = overrides.notifier ?? {
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
  return createRuntimeRunnerAdapter({ clock, pool, store, watchdog, reaper, notifier, ...overrides });
}
function spec(type: AgentTypeConfig, overrides: Partial<RunnerSpec["request"]> = {}): RunnerSpec {
  return { runId: "r1", type, request: { type: type.name, prompt: "hi", ...overrides }, budget: fastBudget() };
}
function plainType(): AgentTypeConfig {
  return { name: "worker", description: "x", systemPrompt: "", promptMode: "append" };
}
function makeFacts(tag: string): RunExitFacts {
  return {
    bashJobs: [
      {
        jobId: `j_${tag}`,
        commandPreview: "sleep 30",
        state: "terminating",
        exitCode: null,
        logPath: `/tmp/${tag}.log`,
        durationMs: 12_000,
        seen: false,
      },
    ],
  };
}
function captureNotifier() {
  const enqueued: DeliveryPayload[] = [];
  return {
    captured: {
      enqueue: (payload: DeliveryPayload) => enqueued.push(payload),
      finalize: () => "missing" as const,
      settleBatch: () => undefined,
      peek: () => undefined,
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    },
    enqueued,
  };
}

describe("exit facts value chain (T25-T27)", () => {
  it("T25: sealSession's facts land in the outcome, the store snapshot, AND get_subagent_result's rendered text", async () => {
    const clock = new FakeClock();
    const facts = makeFacts("t25");
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const store = new MemoryRunStore();
    const runner = buildAdapter(clock, {
      driver,
      store,
      sealSession: (runId, sessionId) => {
        expect(sessionId).toBe("child-session-1");
        return runId === "r1" ? facts : undefined;
      },
    });
    const outcome = await runner.run(spec(plainType()));
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.exitFacts).toEqual(facts);
    // persist_snapshot (state-machine finish()) — the store snapshot mirrors it (P0b, frozen).
    expect(store.get("r1")?.outcome?.diag.exitFacts).toEqual(facts);
    // get_subagent_result's formatOutcome (this package's T25 wiring).
    const rendered = formatExitFacts(outcome.diag.exitFacts);
    expect(rendered).toContain("j_t25");
    expect(rendered).toContain("terminating");
  });

  it("T25: sealSession returning undefined (no bash jobs) leaves diag.exitFacts absent", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, { driver, sealSession: () => undefined });
    const outcome = await runner.run(spec(plainType()));
    expect(outcome.diag.exitFacts).toBeUndefined();
    expect(formatExitFacts(outcome.diag.exitFacts)).toBeUndefined();
  });

  it("T26: enqueue_delivery's payload carries the same exitFacts value — synchronous, no rebuild window", async () => {
    const clock = new FakeClock();
    const facts = makeFacts("t26");
    const capture = captureNotifier();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, {
      driver,
      notifier: capture.captured,
      sealSession: () => facts,
    });
    const outcome = await runner.run(spec(plainType()));
    expect(capture.enqueued).toHaveLength(1);
    expect(capture.enqueued[0]!.exitFacts).toEqual(facts);
    expect(capture.enqueued[0]!.exitFacts).toEqual(outcome.diag.exitFacts);
  });

  it("T27: the same DeliveryPayload shape round-trips through JSON (outbox persistence survives a restart)", () => {
    const facts = makeFacts("t27");
    const payload: DeliveryPayload = {
      runId: "r1",
      generation: 1,
      status: "completed",
      exitFacts: facts,
    } as unknown as DeliveryPayload;
    const roundTripped = JSON.parse(JSON.stringify(payload)) as DeliveryPayload;
    expect(roundTripped.exitFacts).toEqual(facts);
    expect(formatExitFacts(roundTripped.exitFacts)).toBe(formatExitFacts(facts));
  });

  it("onReaped forwards sessionId as a defensive fan-out point (E18 late-arrival call sites)", async () => {
    const clock = new FakeClock();
    const seen: Array<{ runId: string; forkSessionFrom?: string; sessionId?: string }> = [];
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const runner = buildAdapter(clock, {
      driver,
      onReaped: (runId, forkSessionFrom, sessionId) => {
        seen.push({ runId, ...(forkSessionFrom !== undefined ? { forkSessionFrom } : {}), sessionId });
      },
    });
    await runner.run(spec(plainType()));
    // `notifyReaped` (runner.ts) is chained onto reap's own promise via
    // `.then()`, fired-and-forgotten — it can land a tick or two after
    // `run()` itself resolves. Poll briefly instead of asserting instantly.
    await vi.waitFor(() => {
      expect(seen.some((entry) => entry.runId === "r1" && entry.sessionId === "child-session-1")).toBe(true);
    });
  });
});
