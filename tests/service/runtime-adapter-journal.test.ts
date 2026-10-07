import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunSnapshot, SpawnRequest } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * run-persistence plan §5 P3 (docs/dev/subagent-run-persistence/plan.md):
 * real runtime adapter + fake driver — the `journal_snapshot` effect reaches
 * `deps.journal` exactly once per run (never `store.put`, I4/J1), readonly
 * domains never journal (D10), and `flushJournal` (D5/J3) writes at most one
 * shutdown entry per still-live run.
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 10_000,
    idleMs: 10_000,
    toolMs: 10_000,
    totalMs: 50_000,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}
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

interface Harness {
  clock: FakeClock;
  store: MemoryRunStore;
  journal: RunSnapshot[];
  runner: ReturnType<typeof createRuntimeRunnerAdapter>;
  /** Resolves the pending prompt() of the given run (lets it complete normally). */
  finish(runId: string): void;
}

function harness(opts: { sessionFile?: string | null; journalThrows?: boolean } = {}): Harness {
  const clock = new FakeClock();
  const store = new MemoryRunStore();
  const journal: RunSnapshot[] = [];
  const finishers = new Map<string, () => void>();
  const sessionFile = opts.sessionFile === null ? undefined : (opts.sessionFile ?? "/tmp/journal-sess.jsonl");
  const handleFor = (runId: string): SessionHandle => ({
    sessionId: `s-${runId}`,
    sessionFile,
    prompt: () => new Promise<void>((resolve) => finishers.set(runId, resolve)),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
  });
  let nextRun = "";
  const driver: SessionDriver = {
    create: async () => handleFor(nextRun),
    resume: async () => handleFor(nextRun),
    bind: async (_h, onEvent) => {
      onEvent({ t: "turn_start" });
      onEvent({ t: "message_end", usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } });
    },
    onLateArrival: () => undefined,
  };
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool: new SingleSlotPool(clock, 4),
    store,
    watchdog: new EventWatchdog({ clock, budget: fastBudget(), getState: () => undefined, dispatch: () => undefined }),
    reaper: new EscalatingReaper(clock),
    notifier,
    journal: (snapshot) => {
      if (opts.journalThrows) throw new Error("stale extension context");
      journal.push(JSON.parse(JSON.stringify(snapshot)) as RunSnapshot);
    },
  });
  const wrapped = {
    ...runner,
    run: (spec: RunnerSpec, cb?: Parameters<typeof runner.run>[1]) => {
      nextRun = spec.runId;
      return runner.run(spec, cb);
    },
  };
  return {
    clock,
    store,
    journal,
    runner: wrapped as typeof runner,
    finish: (runId) => finishers.get(runId)?.(),
  };
}

function spec(runId: string, request: Partial<SpawnRequest> = {}): RunnerSpec {
  return { runId, type, request: { type: "worker", prompt: "do it", ...request }, budget: fastBudget() };
}

async function settle(clock: FakeClock, ticks = 20) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(1);
    await Promise.resolve();
  }
}

describe("runtime adapter journal wiring (run-persistence plan D2/D5/D10)", () => {
  it("journals exactly once at session_created with the slim non-terminal shape; store stays empty while running (I4)", async () => {
    const h = harness();
    const p = h.runner.run(spec("r1", { label: "worker-a" }));
    await settle(h.clock);
    expect(h.journal).toHaveLength(1);
    const entry = h.journal[0]!;
    expect(entry.runId).toBe("r1");
    expect(entry.status).toBe("starting");
    expect(entry.journal).toEqual({ kind: "session_created" });
    expect(entry).not.toHaveProperty("outcome");
    expect(entry.diag.sessionFile).toBe("/tmp/journal-sess.jsonl");
    expect(entry.diag.label).toBe("worker-a");
    expect(entry.diag).not.toHaveProperty("text");
    expect(entry.diag).not.toHaveProperty("toolHistory");
    // I4/J1: the in-memory store never sees a non-terminal snapshot.
    expect(h.store.get("r1")).toBeUndefined();
    expect(h.store.list()).toEqual([]);
    h.finish("r1");
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect(h.store.get("r1")?.status).toBe("completed");
    expect(h.journal).toHaveLength(1); // the terminal snapshot goes through store.put, not the journal
  });

  it("no sessionFile ⇒ no journal entry", async () => {
    const h = harness({ sessionFile: null });
    const p = h.runner.run(spec("r1"));
    await settle(h.clock);
    expect(h.journal).toEqual([]);
    h.finish("r1");
    await p;
  });

  it("consult forks and toolDomain:'readonly' runs never journal, not even on flush (D10)", async () => {
    const h = harness();
    const fork = h.runner.run(spec("r_fork", { forkSessionFrom: "/tmp/fork-copy.jsonl" }));
    await settle(h.clock);
    const tidy = h.runner.run(spec("r_tidy", { toolDomain: "readonly" }));
    await settle(h.clock);
    expect(h.journal).toEqual([]);
    expect(h.runner.flushJournal!(["r_fork", "r_tidy"], { kind: "shutdown_flush", shutdownReason: "reload" })).toBe(0);
    expect(h.journal).toEqual([]);
    h.finish("r_fork");
    h.finish("r_tidy");
    await Promise.all([fork, tidy]);
  });

  it("flushJournal writes one shutdown_flush entry per live run, at most once, with live usage", async () => {
    const h = harness();
    const p = h.runner.run(spec("r1"));
    await settle(h.clock);
    expect(h.journal).toHaveLength(1);
    const mark = { kind: "shutdown_flush" as const, shutdownReason: "reload" };
    expect(h.runner.flushJournal!(["r1", "r_unknown"], mark)).toBe(1);
    expect(h.journal).toHaveLength(2);
    const flushed = h.journal[1]!;
    expect(flushed.journal).toEqual(mark);
    expect(flushed.status).not.toBe("completed");
    expect(flushed.diag.usage).toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 });
    expect(flushed).not.toHaveProperty("outcome");
    // J3: a second flush of the same run writes nothing.
    expect(h.runner.flushJournal!(["r1"], mark)).toBe(0);
    expect(h.journal).toHaveLength(2);
    expect(h.store.get("r1")).toBeUndefined();
    h.finish("r1");
    await p;
    // Terminal runs are never flushed.
    const h2 = harness();
    const p2 = h2.runner.run(spec("r2"));
    await settle(h2.clock);
    h2.finish("r2");
    await p2;
    expect(h2.runner.flushJournal!(["r2"], mark)).toBe(0);
    expect(h2.journal).toHaveLength(1);
  });

  it("flushJournal skips a live run without a sessionFile", async () => {
    const h = harness({ sessionFile: null });
    const p = h.runner.run(spec("r1"));
    await settle(h.clock);
    expect(h.runner.flushJournal!(["r1"], { kind: "shutdown_flush", shutdownReason: "quit" })).toBe(0);
    expect(h.journal).toEqual([]);
    h.finish("r1");
    await p;
  });

  it("a throwing journal sink never affects the run's outcome and never reaches effect_failed", async () => {
    const h = harness({ journalThrows: true });
    const p = h.runner.run(spec("r1"));
    await settle(h.clock);
    expect(h.runner.flushJournal!(["r1"], { kind: "shutdown_flush", shutdownReason: "reload" })).toBe(0);
    h.finish("r1");
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.degraded).toEqual([]);
    expect(h.store.get("r1")?.status).toBe("completed");
  });
});
