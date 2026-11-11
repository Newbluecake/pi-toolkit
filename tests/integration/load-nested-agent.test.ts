import { expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import { parseLoadSettings } from "../../src/sysload/settings.js";
import type { AgentTypeConfig, RunDiagnostics, SessionSpec } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { evaluateLoadGate } from "../../src/sysload/gate.js";
import type { LoadVerdict } from "../../src/sysload/types.js";
import type { RunnerSpec } from "../../src/service/ports.js";

const type: AgentTypeConfig = {
  name: "planner",
  description: "planner",
  systemPrompt: "",
  promptMode: "append",
  canSpawn: ["worker"],
};
const worker: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const verdict: LoadVerdict = {
  level: "crit",
  gating: true,
  metrics: { cpu: { level: "crit", busyPct: 97 }, mem: { level: "ok", availPct: 40 }, disk: [] },
  mono: 1,
  at: 1,
};

function budget() {
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
function handle(): SessionHandle {
  return {
    sessionId: "s1",
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
  };
}
function diagnostics(): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  };
}

it("uses the real runtime-adapter nested Agent and real load-gate renderer", async () => {
  const clock = new FakeClock();
  const notifier = {
    enqueue: () => undefined,
    finalize: () => "missing" as const,
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
  const driver: SessionDriver = {
    create: async (spec: SessionSpec) => {
      captured = spec.customTools?.find((tool) => (tool as { name?: string }).name === "Agent") as typeof captured;
      return handle();
    },
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  let captured:
    | { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }> }
    | undefined;
  const pool = new SingleSlotPool(clock, 2);
  const acquire = vi.spyOn(pool, "acquire");
  const fakeRun = vi.fn(
    async () => ({ runId: "fake", status: "completed", turns: 0, durationMs: 0, diag: diagnostics() }) as never,
  );
  const loadGate = vi.fn(({ nested }: { nested: boolean }) => {
    const decision = evaluateLoadGate(verdict, parseLoadSettings({}), { nested });
    return decision.blocked ? { message: decision.message! } : undefined;
  });
  const service = createSpawnService({
    types: {
      get: (name: string) => (name === "worker" ? worker : name === "planner" ? type : undefined),
      list: () => [worker, type],
      reload: async () => ({ types: [worker, type], errors: [] }),
      configHashOf: () => undefined,
    },
    pool,
    runner: { run: fakeRun } as never,
    now: () => 0,
    loadGate,
  });
  const parent = await service.spawn({ type: "planner", prompt: "parent" });
  if (!("runId" in parent)) throw new Error("parent admission failed");
  // Use the production blocking port: the former hand-written spawnAndWait
  // threw only error.message and lost the authoritative admission reason/effect.
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({ clock, budget: budget(), getState: () => undefined, dispatch: () => undefined });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store: new MemoryRunStore(),
    watchdog,
    reaper,
    notifier,
    nestedSpawn: () => service,
    loadGate: () => true,
  });
  const spec: RunnerSpec = {
    runId: parent.runId,
    type,
    request: { type: "planner", prompt: "parent" },
    budget: budget(),
  };
  const run = runner.run(spec);
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    clock.advance(1);
  }
  await run;
  if (!captured) throw new Error("runtime adapter did not inject nested Agent");
  const before = service.snapshots();
  const runningBefore = service.runningIds();
  const runCalls = fakeRun.mock.calls.length;
  const acquireCalls = acquire.mock.calls.length;
  try {
    await expect(
      captured.execute("call", { description: "nested", prompt: "delegate", subagent_type: "worker" }),
    ).rejects.toThrow(
      /^Agent admission rejected \[code=agent_admission_rejected kind=config reason=load retryable=true effect=none\]\. Check the admission policy, model\/type configuration and current capacity before another dispatch\. Retryable is not proof that a prior attempt had no effects; do not automatically resubmit the prompt\.$/,
    );
    expect(loadGate).toHaveBeenCalledTimes(1);
    expect(loadGate).toHaveBeenCalledWith({ nested: true });
    expect(service.snapshots()).toEqual(before);
    expect(service.runningIds()).toEqual(runningBefore);
    expect(service.getLabel?.("nested")).toBeUndefined();
    expect(fakeRun).toHaveBeenCalledTimes(runCalls);
    expect(acquire).toHaveBeenCalledTimes(acquireCalls);
  } finally {
    acquire.mockRestore();
  }
});
