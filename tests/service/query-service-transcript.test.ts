import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, ObserveRunResult, RunObserverListener, RunOutcome } from "../../src/core/types.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createQueryService } from "../../src/service/query-service.js";
import type { Runner, RunRegistry } from "../../src/service/ports.js";

/**
 * fleet-drawer plan §4.1 (F1): the read-port passthrough layer —
 * `QueryService.branchOf/observe` → `Runner.peekBranch/observe` →
 * `RuntimeRunner.peekRunBranch/observeRun`.
 *
 * Part A (unit, fake Runner): the four-state verdict and the branch snapshot
 * pass through untouched; a runner that predates the read port degrades to
 * `{kind:"no_session"}` / `undefined` (never a throw, never a fabricated
 * answer).
 *
 * Part B (end-to-end, real RuntimeRunner behind the adapter): an observer
 * attached through the QueryService receives live session events and exactly
 * one onEnd; branchOf serves the live branch and dries up once the run is
 * terminal; a late observe returns the terminal verdict.
 */

const outcome: RunOutcome = {
  runId: "run-1",
  status: "completed",
  turns: 1,
  durationMs: 1,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 1,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
};
const listener: RunObserverListener = { onEvent: () => undefined, onEnd: () => undefined };
const registry: RunRegistry = { get: () => undefined, list: () => [] };

function queryWith(runner: Partial<Runner>) {
  return createQueryService({ registry, runner: { run: async () => outcome, ...runner } as Runner });
}

describe("QueryService transcript read port (fleet-drawer plan §4.1): fake-runner passthrough", () => {
  it("branchOf passes the runner's branch snapshot through untouched (same reference)", () => {
    const branch = [{ id: "e1" }, { id: "e2" }];
    const q = queryWith({ peekBranch: (id) => (id === "run-1" ? branch : undefined) });
    expect(q.branchOf!("run-1")).toBe(branch);
    expect(q.branchOf!("run-2")).toBeUndefined();
  });

  it("branchOf is undefined when the runner predates the read port (no peekBranch)", () => {
    expect(queryWith({}).branchOf!("run-1")).toBeUndefined();
  });

  it("observe passes every four-state verdict through by reference", () => {
    const verdicts: ObserveRunResult[] = [
      { kind: "attached", detach: () => undefined },
      { kind: "terminal", status: "completed" },
      { kind: "no_session" },
      { kind: "unknown" },
    ];
    for (const verdict of verdicts) {
      const q = queryWith({ observe: () => verdict });
      expect(q.observe!("run-1", listener)).toBe(verdict);
    }
  });

  it("observe threads (runId, listener) to the runner verbatim", () => {
    let seen: { runId: string; l: RunObserverListener } | undefined;
    const q = queryWith({
      observe: (runId, l) => {
        seen = { runId, l };
        return { kind: "unknown" };
      },
    });
    q.observe!("run-1", listener);
    expect(seen).toEqual({ runId: "run-1", l: listener });
  });

  it("observe degrades to no_session when the runner predates the read port (no observe)", () => {
    expect(queryWith({}).observe!("run-1", listener)).toEqual({ kind: "no_session" });
  });
});

/* ------------------------------------------------------------------------- *
 * Part B: real RuntimeRunner behind the runtime adapter.
 * ------------------------------------------------------------------------- */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 20,
  startupMs: 20,
  bindMs: 20,
  firstEventMs: 20,
  idleMs: 20,
  toolMs: 20,
  totalMs: 100,
  abortGraceMs: 5,
  steerMs: 10,
  reapMs: 10,
};
const runType: AgentTypeConfig = {
  name: "worker" as AgentTypeConfig["name"],
  description: "worker",
  systemPrompt: "",
  promptMode: "append",
};
const notifier = {
  enqueue: vi.fn(),
  finalize: vi.fn(),
  settleBatch: vi.fn(),
  peek: vi.fn(),
  consume: vi.fn(),
  reconcile: vi.fn(),
  verifyPersisted: vi.fn(),
  stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

const pump = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

interface LiveSession {
  driver: SessionDriver;
  push(e: unknown): void;
}

/** A driver whose handle is observable and never settles on its own (aborted by the test). */
function liveSession(branch: readonly unknown[]): LiveSession {
  let pushFn: ((e: unknown) => void) | undefined;
  const handle: SessionHandle = {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => new Promise<void>(() => undefined),
    steer: async () => undefined,
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "",
    getUsage: () => undefined,
    getBranchEntries: () => branch,
    observe: (l) => {
      pushFn = l;
      return () => {
        pushFn = undefined;
      };
    },
  };
  return {
    driver: { create: async () => handle, bind: async () => undefined, onLateArrival: () => undefined },
    push: (e) => pushFn?.(e),
  };
}

describe("runtime-adapter transcript read port (fleet-drawer plan §4.1): real RuntimeRunner end-to-end", () => {
  it("branchOf/observe through adapter + QueryService: live events, exactly-one onEnd, terminal verdict after abort", async () => {
    const branch = [{ id: "e1" }, { id: "e2" }];
    const session = liveSession(branch);
    const clock = new FakeClock();
    const store = new MemoryRunStore();
    const adapter = createRuntimeRunnerAdapter({
      clock,
      pool: new SingleSlotPool(clock, 1),
      store,
      watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
      reaper: new EscalatingReaper(clock),
      notifier,
      driver: session.driver,
    });
    const q = createQueryService({ registry, runner: adapter });

    // Before the run exists: unknown / undefined.
    expect(q.observe!("r_TX", listener)).toEqual({ kind: "unknown" });
    expect(q.branchOf!("r_TX")).toBeUndefined();

    const promise = adapter.run({ runId: "r_TX", type: runType, request: { type: "worker", prompt: "hi" }, budget });
    await pump();

    // Live: branch snapshot is the handle's own array; observer attaches and
    // receives the session stream.
    expect(q.branchOf!("r_TX")).toBe(branch);
    const events: unknown[] = [];
    const ends: string[] = [];
    const verdict = q.observe!("r_TX", { onEvent: (e) => events.push(e), onEnd: (s) => ends.push(s) });
    expect(verdict.kind).toBe("attached");
    session.push({ type: "turn_start" });
    session.push({ type: "message_update", delta: "a" });
    expect(events).toEqual([{ type: "turn_start" }, { type: "message_update", delta: "a" }]);

    // Abort: exactly one onEnd; afterwards the verdict is terminal and the
    // branch dries up (callers take the file path).
    await adapter.abort!("r_TX", "user_stop");
    const settled = await promise;
    await pump();
    expect(settled.status).toBe("aborted");
    expect(ends).toEqual(["aborted"]);
    expect(q.observe!("r_TX", listener)).toEqual({ kind: "terminal", status: "aborted" });
    expect(q.branchOf!("r_TX")).toBeUndefined();
  });

  it("detach through the QueryService-attached handle stops events and never fires onEnd", async () => {
    const session = liveSession([{ id: "e1" }]);
    const clock = new FakeClock();
    const adapter = createRuntimeRunnerAdapter({
      clock,
      pool: new SingleSlotPool(clock, 1),
      store: new MemoryRunStore(),
      watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
      reaper: new EscalatingReaper(clock),
      notifier,
      driver: session.driver,
    });
    const q = createQueryService({ registry, runner: adapter });
    const promise = adapter.run({ runId: "r_DT", type: runType, request: { type: "worker", prompt: "hi" }, budget });
    await pump();
    const events: unknown[] = [];
    const ends: string[] = [];
    const verdict = q.observe!("r_DT", { onEvent: (e) => events.push(e), onEnd: (s) => ends.push(s) });
    expect(verdict.kind).toBe("attached");
    session.push({ type: "turn_start" });
    expect(events).toHaveLength(1);
    (verdict as { kind: "attached"; detach(): void }).detach();
    session.push({ type: "turn_end" });
    expect(events).toHaveLength(1);
    await adapter.abort!("r_DT", "user_stop");
    await promise;
    await pump();
    expect(ends).toEqual([]);
  });
});
