import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DriverEvent, RunSnapshot, SubagentExtensionPoints } from "../../src/core/types.js";
import { aggregateChildUsage } from "../../src/tools/workflow-tool.js";
import type { WorkflowOutcome } from "../../src/workflow/types.js";
import { attachHostCallHandler, type ChildSpawner, type GateRunner } from "../../src/workflow/host.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { fakeSpawnWorkerFactory } from "../workflow/helpers.js";
import { renderCosts } from "../../src/commands/status.js";
import { buildUsageEvent } from "../../src/delivery/usage-broadcast.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §6 D-group, §7): real
 * `SpawnService` + `RuntimeRunner` integration coverage for the pieces this
 * package (`wf-experts`) actually owns end-to-end.
 *
 * **Scope note**: packages B (`src/service/spawn-service.ts`'s `stopping`-set
 * fork-admission guard, §4.7) and C (`src/consult/index.ts`'s
 * `resolveExperts(refs, { completedOnly })`) have both landed on master.
 * Tests #27/#29/#30/#31 below exercise them purely through their already-
 * frozen **public APIs** (`SpawnService.spawn/abort/stopChildrenOf`,
 * `createWorkflowChildSpawner`, `attachHostCallHandler`) — this file still
 * never imports or edits `src/service/spawn-service.ts` or
 * `src/consult/index.ts` themselves (§7's `wf-experts` globs are untouched).
 * None of the four goes through the real `consult` tool / host.ts's §4.4
 * experts-resolution wiring end-to-end (that is package A's own
 * `host.test.ts`/`expert-scope.test.ts`/`spawner-adapter.test.ts` domain);
 * #30/#31 instead hand-construct the exact `DriverEvent` a real consult
 * toolResult would deliver (`{t:"message_end", usage, absorbedRunIds}`,
 * pinned by `tests/runtime/nested-run-usage.test.ts`) so the *usage-
 * absorption accounting itself* (session-driver.ts / state-machine.ts's
 * X9/X12, plus the workflow / HUD / `/agent costs` dedupe consumers) runs
 * for real. Scope confirmed with the workflow-experts-plan-v2 review
 * (consult, 2026-09-26): D#29's "stopOwned finishes within abortGraceMs"
 * targets `HostCallHandler.stopOwned` specifically (not
 * `src/workflow/background.ts`, which this file still never touches).
 */

const type: AgentTypeConfig = {
  name: "worker",
  description: "worker",
  systemPrompt: "",
  promptMode: "append",
  // D#27's last scenario (a non-fork nested spawn, unaffected by the D19
  // `stopping` guard) needs an ordinary nested-delegation whitelist; every
  // OTHER scenario in this file spawns via `forkSessionFrom`, which bypasses
  // canSpawn entirely (spawn-service.ts's own D19 fixtures already pin that
  // down), so adding it here is harmless to every other test.
  canSpawn: ["worker"],
};

function fastBudget(totalMs: number) {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 2_000,
    startupMs: 5_000,
    bindMs: 2_000,
    firstEventMs: 2_000,
    idleMs: 2_000,
    toolMs: 2_000,
    totalMs,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
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
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  };
}

const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

/** Real setTimeout(0) flush — needed alongside `drain()` when a fake worker
 *  thread's own port messaging (real MessageChannel microtasks, not
 *  `FakeClock`-driven) is in the mix (D#29's `attachHostCallHandler`). */
async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildFullStack(clock: FakeClock, driver: SessionDriver, extensions: SubagentExtensionPoints[] = []) {
  const pool = new SingleSlotPool(clock, 1); // maxParallel-equivalent: exactly one global slot (test #28's setup)
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(30_000),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
    extensions,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
    // workflow-experts §6 D#29: `createWorkflowChildSpawner`'s `configHashOf`
    // forwards straight to this registry method (required, not optional, on
    // `AgentTypeRegistry` — host.ts itself treats a missing/undefined result
    // as "fail closed on replay", never a crash).
    configHashOf: (name: string) => (name === "worker" ? "hash-worker" : undefined),
  };
  const svc: SpawnService & { snapshots(): readonly RunSnapshot[] } = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
  });
  return { pool, store, svc, types };
}

/** A driver that hands back a fresh, controllable prompt() per `create()`
 *  call and records each `bind()`'s `onEvent` callback in call order —
 *  D#30/D#31 spawn R then C sequentially (draining between each), so
 *  `sinks[0]`/`resolvers[0]` are R's and `sinks[1]`/`resolvers[1]` are C's. */
function createOrderedDriver(): {
  driver: SessionDriver;
  sinks: Array<(e: DriverEvent) => void>;
  resolvers: Array<() => void>;
} {
  const sinks: Array<(e: DriverEvent) => void> = [];
  const resolvers: Array<() => void> = [];
  const makeControllableHandle = (overrides: Partial<SessionHandle> = {}): SessionHandle => {
    let resolvePrompt!: () => void;
    const promptP = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    resolvers.push(resolvePrompt);
    return handle({ prompt: () => promptP, ...overrides });
  };
  const driver: SessionDriver = {
    create: async () => makeControllableHandle(),
    // C (the fork-shaped consult child) goes through `resume`, never
    // `create` (X2 resume path) — same controllable-prompt shape so its own
    // message_end/resolve can be driven independently of R's.
    resume: async (file) => makeControllableHandle({ sessionFile: file }),
    bind: async (_h, cb) => {
      sinks.push(cb);
    },
    onLateArrival: () => undefined,
  };
  return { driver, sinks, resolvers };
}

describe("workflow-experts §6 D#28: consult spawn admission alongside a full workflow slot", () => {
  it("with the single global slot held by the workflow's own child R, a slotless fork-shaped consult spawn is admitted immediately; a second, non-slotless workflow agent() spawn still queues on the slot", async () => {
    const clock = new FakeClock();
    // R's own prompt() never resolves -- it must stay "running" (holding the
    // sole global slot) for the whole test, until explicitly aborted below.
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => new Promise(() => {}) }),
      // Every fork-shaped ("consult") spawn in this file goes through
      // `driver.resume`, never `driver.create` (X2 resume path) — a driver
      // without it fails every such run with "session driver does not
      // support resume" the instant it actually starts.
      resume: async (file) => handle({ sessionFile: file, prompt: () => new Promise(() => {}) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, pool } = buildFullStack(clock, driver);

    // R: the workflow's own first child, occupying the sole global slot.
    const r = await svc.spawn({ type: "worker", prompt: "R", budgetOverride: { totalMs: 60_000 } });
    if ("error" in r) throw new Error(r.error.message);
    await drain(clock, 3);
    expect(pool.stats.inUse).toBe(1); // R holds the one global slot

    // A consult-shaped spawn (forkSessionFrom + slotless: true, exactly how
    // the real consult tool dispatches -- forkSessionFrom skips the canSpawn
    // gate and the SlotPool entirely) must be admitted immediately, never
    // queued behind R.
    const forkDir = mkdtempSync(join(tmpdir(), "wf-experts-fork-"));
    const forkFile = join(forkDir, "expert-fork.jsonl");
    writeFileSync(forkFile, "");
    const consultSpawn = await svc.spawn({
      type: "worker",
      prompt: "consult-C",
      slotless: true,
      parentRunId: r.runId,
      forkSessionFrom: forkFile,
      budgetOverride: { totalMs: 10_000 },
    });
    expect("error" in consultSpawn).toBe(false);

    // The slotless consult call above must not have touched the SlotPool at
    // all -- R still alone holds the one global slot.
    expect(pool.stats.inUse).toBe(1);
    expect(pool.stats.slotless).toBe(1);

    // A second, ordinary (non-slotless) workflow agent() call still queues
    // behind R on the one global slot -- confirms the slotless consult call
    // above did not "steal" R's slot or otherwise perturb FIFO ordering.
    // (spawn() itself always resolves quickly with a runId regardless of
    // slot availability -- admission is synchronous, the real slot wait
    // happens inside the runner's own async start(), so `pool.stats` is the
    // only reliable signal here, not spawn()'s own resolution.)
    const second = await svc.spawn({ type: "worker", prompt: "second-child", budgetOverride: { totalMs: 60_000 } });
    if ("error" in second) throw new Error(second.error.message);
    await drain(clock, 3);
    expect(pool.stats.inUse).toBe(1); // still just R -- the second child is queued, not running
    expect(pool.stats.queued).toBe(1);

    await svc.abort(r.runId, "user_stop");
    await drain(clock, 5);
    expect(pool.stats.inUse).toBe(1); // the queued second child has now taken the freed slot
    expect(pool.stats.queued).toBe(0);
  });
});

describe("workflow-experts §6 D#27: fork admission vs. abort race (real SpawnService + RuntimeRunner)", () => {
  it("a same-tick abort(R) rejects a racing fork-shaped consult spawn; a fork spawned BEFORE abort ends up cascade-aborted alongside R", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => new Promise(() => {}) }),
      // Every fork-shaped ("consult") spawn in this file goes through
      // `driver.resume`, never `driver.create` (X2 resume path) — a driver
      // without it fails every such run with "session driver does not
      // support resume" the instant it actually starts.
      resume: async (file) => handle({ sessionFile: file, prompt: () => new Promise(() => {}) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver);
    const forkDir = mkdtempSync(join(tmpdir(), "wf-experts-fork27-"));
    const forkFile = (name: string): string => {
      const f = join(forkDir, name);
      writeFileSync(f, "");
      return f;
    };

    // --- Phase A: same-tick race. `abort()`'s synchronous prefix
    // (`stopping.add(runId)`, spawn-service.ts D19/N3) has already run by
    // the time this statement hands back a pending promise, so the very
    // next statement's fork spawn races the SAME tick.
    const r1 = await svc.spawn({ type: "worker", prompt: "R1", budgetOverride: { totalMs: 60_000 } });
    if ("error" in r1) throw new Error(r1.error.message);
    await drain(clock, 3);

    const abort1P = svc.abort(r1.runId, "user_stop");
    const raced = await svc.spawn({
      type: "worker",
      prompt: "consult-vs-abort",
      slotless: true,
      parentRunId: r1.runId,
      forkSessionFrom: forkFile("racer.jsonl"),
      budgetOverride: { totalMs: 10_000 },
    });
    expect(raced).toEqual({
      error: { kind: "config", message: "parent run is stopping or gone", retryable: false },
    });
    await abort1P;
    await drain(clock, 5);

    // --- Phase B: a fork spawned BEFORE abort is on R's `childrenOf` set by
    // the time abort() cascades, so it ends up aborted alongside R.
    const r2 = await svc.spawn({ type: "worker", prompt: "R2", budgetOverride: { totalMs: 60_000 } });
    if ("error" in r2) throw new Error(r2.error.message);
    await drain(clock, 3);
    const c2 = await svc.spawn({
      type: "worker",
      prompt: "consult-before-abort",
      slotless: true,
      parentRunId: r2.runId,
      forkSessionFrom: forkFile("prior.jsonl"),
      budgetOverride: { totalMs: 10_000 },
    });
    if ("error" in c2) throw new Error(c2.error.message);
    await drain(clock, 3);

    await svc.abort(r2.runId, "user_stop");
    await drain(clock, 5);

    const r2Snap = svc.snapshots().find((s) => s.runId === r2.runId);
    const c2Snap = svc.snapshots().find((s) => s.runId === c2.runId);
    expect(r2Snap?.status).toBe("aborted");
    expect(c2Snap?.status).toBe("aborted");
  });
});

describe("workflow-experts §6 D#29: HostCallHandler.stopOwned cascades R → a fork-spawned consult child C", () => {
  it("stopOwned settles R and cascade-aborts C within the grace window, with no orphaned children and no leftover timers", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => new Promise(() => {}) }),
      // Every fork-shaped ("consult") spawn in this file goes through
      // `driver.resume`, never `driver.create` (X2 resume path) — a driver
      // without it fails every such run with "session driver does not
      // support resume" the instant it actually starts.
      resume: async (file) => handle({ sessionFile: file, prompt: () => new Promise(() => {}) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, types } = buildFullStack(clock, driver);
    const spawner: ChildSpawner = createWorkflowChildSpawner(svc, types);
    const gateRunner: GateRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

    const { spawnWorker, workerData } = fakeSpawnWorkerFactory();
    const workerHost = createWorkerHost({ clock, spawnWorker });
    await workerHost.boot({
      scriptSource: 'export const meta = { name: "t", description: "t" };',
      scriptSliceMs: 1_000,
      heartbeatMs: 0,
      workerBootMs: 1_000,
      terminateConfirmMs: 500,
    });
    const sent: unknown[] = [];
    workerData().commPort.on("message", (m) => sent.push(m));

    let spawnedRunId: string | undefined;
    const handler = attachHostCallHandler({
      clock,
      workerHost,
      spawner,
      gateRunner,
      budget: {},
      // The workflow's own (never-a-tracked-run) owner id — `stopOwned`
      // funnels into `spawner.stopChildrenOf(parentRunId, cause)` with this.
      parentRunId: "wf-1",
      onChildEvent: (e) => {
        if (e.kind === "spawned") spawnedRunId = e.runId;
      },
    });

    // R: the workflow script's own `agent("R")` call, dispatched through the
    // real host_call protocol so it genuinely lands as `parentRunId: "wf-1"`.
    workerData().commPort.postMessage({
      kind: "host_call",
      id: "1",
      op: "agent",
      args: { prompt: "R", opts: { agentType: "worker" } },
    });
    await flush();
    await drain(clock, 3);
    if (spawnedRunId === undefined) throw new Error("R never spawned (bad harness assumption)");

    // C: a fork-shaped consult child of R, spawned directly on `svc` (the
    // real consult tool's own dispatch shape — bypassing host.ts's experts
    // wiring entirely, per this file's Scope note above).
    const forkDir = mkdtempSync(join(tmpdir(), "wf-experts-fork29-"));
    const forkFile = join(forkDir, "fork.jsonl");
    writeFileSync(forkFile, "");
    const c = await svc.spawn({
      type: "worker",
      prompt: "consult-C",
      slotless: true,
      parentRunId: spawnedRunId,
      forkSessionFrom: forkFile,
      budgetOverride: { totalMs: 10_000 },
    });
    if ("error" in c) throw new Error(c.error.message);
    await drain(clock, 3);

    const stopP = handler.stopOwned("user_stop", 500);
    await drain(clock, 10);
    await flush();
    const result = await stopP;

    expect(result.orphanChildren).toEqual([]); // R settled for real, well inside the 500ms grace
    const rSnap = svc.snapshots().find((s) => s.runId === spawnedRunId);
    const cSnap = svc.snapshots().find((s) => s.runId === c.runId);
    expect(rSnap?.status).toBe("aborted");
    expect(cSnap?.status).toBe("aborted"); // cascaded via stopChildrenOf("wf-1") -> abort(R) -> abort(C)

    await workerHost.terminate("test done");
    await flush();
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("workflow-experts §6 D#30: normal completion — R absorbs C's usage exactly once", () => {
  it("R's diag.usage/absorbedRunIds fold in C's cost once; workflow aggregation and the /agent-costs + usage-broadcast dedupe consumers do not double count", async () => {
    const clock = new FakeClock();
    const { driver, sinks, resolvers } = createOrderedDriver();
    const { svc } = buildFullStack(clock, driver);

    const r = await svc.spawn({ type: "worker", prompt: "R", budgetOverride: { totalMs: 60_000 } });
    if ("error" in r) throw new Error(r.error.message);
    await drain(clock, 3);
    if (sinks.length < 1) throw new Error("R never bound (bad harness assumption)");

    const forkDir = mkdtempSync(join(tmpdir(), "wf-experts-fork30-"));
    const forkFile = join(forkDir, "fork.jsonl");
    writeFileSync(forkFile, "");
    const c = await svc.spawn({
      type: "worker",
      prompt: "consult-C",
      slotless: true,
      parentRunId: r.runId,
      forkSessionFrom: forkFile,
      budgetOverride: { totalMs: 10_000 },
    });
    if ("error" in c) throw new Error(c.error.message);
    await drain(clock, 3);
    if (sinks.length < 2) throw new Error("C never bound (bad harness assumption)");

    // C runs its own turn (its own accrued cost) and completes normally.
    sinks[1]!({ t: "message_end", usage: { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.12 } });
    resolvers[1]!();
    await drain(clock, 5);
    const cSnap = svc.snapshots().find((s) => s.runId === c.runId);
    expect(cSnap?.status).toBe("completed");
    expect(cSnap?.diag.usage?.costUsd).toBeCloseTo(0.12, 10);

    // The (simulated) real consult tool delivers C's lifetime spend on R's
    // OWN toolResult message_end — exactly the shape
    // tests/runtime/nested-run-usage.test.ts pins for a `consultRunId`-
    // bearing toolResult (X9/X12: the session driver already extracted
    // `absorbedRunIds` before this reaches the state machine).
    sinks[0]!({
      t: "message_end",
      usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.12 },
      absorbedRunIds: [c.runId],
    });
    resolvers[0]!();
    await drain(clock, 5);
    const rSnap = svc.snapshots().find((s) => s.runId === r.runId);
    expect(rSnap?.status).toBe("completed");
    expect(rSnap?.diag.usage?.costUsd).toBeCloseTo(0.12, 10);
    expect(rSnap?.diag.absorbedRunIds).toContain(c.runId);

    // Workflow-level aggregation: only R is the workflow's own direct child
    // (host.ts only ever records direct `agent()` calls into
    // `WorkflowChildSummary[]` — C is a grandchild reached via consult, never
    // a workflow "child" in that sense).
    const outcome = {
      children: [{ callId: "1", runId: r.runId, source: "live", status: "completed", durationMs: 1 }],
    } as unknown as WorkflowOutcome;
    const usageOf = (id: string) => svc.snapshots().find((s) => s.runId === id)?.diag.usage;
    const aggregated = aggregateChildUsage(outcome, usageOf);
    expect(aggregated?.costUsd).toBeCloseTo(0.12, 10); // counted exactly once, not 0.24

    // Consumer-level dedupe: src/commands/status.ts's own doc says the grand
    // total "skips any run whose id shows up in another tracked run's
    // absorbedRunIds" — same rule the HUD footer's `+agents` and the usage
    // broadcast's `absorbed` flag use.
    const costsText = renderCosts({ list: () => svc.snapshots() } as never);
    expect(costsText).toContain("(absorbed)");
    expect(costsText).toMatch(/Total: \$0\.1200/);

    const usageEvent = buildUsageEvent(svc.snapshots(), clock.now());
    const cRow = usageEvent.runs.find((row) => row.runId === c.runId);
    expect(cRow?.absorbed).toBe(true);
    expect(usageEvent.activeCostUsd).toBe(0); // both runs are terminal by now
  });
});

describe("workflow-experts §6 D#31: consult in progress when R is aborted — known D20 undercount", () => {
  it("workflow aggregation excludes C's already-accrued cost, but the global usage-broadcast/costs consumers still track it independently", async () => {
    const clock = new FakeClock();
    const { driver, sinks } = createOrderedDriver();
    const { svc } = buildFullStack(clock, driver);

    const r = await svc.spawn({ type: "worker", prompt: "R", budgetOverride: { totalMs: 60_000 } });
    if ("error" in r) throw new Error(r.error.message);
    await drain(clock, 3);
    if (sinks.length < 1) throw new Error("R never bound (bad harness assumption)");

    const forkDir = mkdtempSync(join(tmpdir(), "wf-experts-fork31-"));
    const forkFile = join(forkDir, "fork.jsonl");
    writeFileSync(forkFile, "");
    const c = await svc.spawn({
      type: "worker",
      prompt: "consult-C",
      slotless: true,
      parentRunId: r.runId,
      forkSessionFrom: forkFile,
      budgetOverride: { totalMs: 10_000 },
    });
    if ("error" in c) throw new Error(c.error.message);
    await drain(clock, 3);
    if (sinks.length < 2) throw new Error("C never bound (bad harness assumption)");

    // C is "in progress": it has already burned some of its own tokens (its
    // own message_end, no absorption — the consult never got far enough to
    // deliver a toolResult back to R) when R gets aborted.
    sinks[1]!({ t: "message_end", usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 } });
    await drain(clock, 2);

    await svc.abort(r.runId, "user_stop");
    await drain(clock, 5);

    const rSnap = svc.snapshots().find((s) => s.runId === r.runId);
    const cSnap = svc.snapshots().find((s) => s.runId === c.runId);
    expect(rSnap?.status).toBe("aborted");
    expect(cSnap?.status).toBe("aborted"); // cascaded alongside R
    expect(rSnap?.diag.usage?.costUsd ?? 0).toBe(0); // R never absorbed anything from C
    expect(rSnap?.diag.absorbedRunIds ?? []).toEqual([]);
    expect(cSnap?.diag.usage?.costUsd).toBeCloseTo(0.05, 10); // C's own accrued spend, untouched by the abort

    // D20's known gap: workflow-level aggregation only ever sees R (its one
    // direct child) — C's cost silently disappears from the workflow total.
    const outcome = {
      children: [{ callId: "1", runId: r.runId, source: "live", status: "aborted", durationMs: 1 }],
    } as unknown as WorkflowOutcome;
    const usageOf = (id: string) => svc.snapshots().find((s) => s.runId === id)?.diag.usage;
    const aggregated = aggregateChildUsage(outcome, usageOf);
    expect(aggregated?.costUsd ?? 0).toBe(0); // C's $0.05 is nowhere in the workflow's own total

    // But the global tracked-run consumers (HUD usage broadcast / `/agent
    // costs`) still see C as an independent, non-absorbed run — its spend is
    // not lost, only missing from THIS workflow's own aggregate (D20; fix
    // this assertion, not delete it, once the v2 compensation lands).
    const usageEvent = buildUsageEvent(svc.snapshots(), clock.now());
    const cRow = usageEvent.runs.find((row) => row.runId === c.runId);
    expect(cRow).toBeDefined();
    expect(cRow?.absorbed).toBeUndefined();
    expect(cRow?.costUsd).toBeCloseTo(0.05, 10);

    const costsText = renderCosts({ list: () => svc.snapshots() } as never);
    expect(costsText).not.toContain("(absorbed)");
    expect(costsText).toMatch(/Total: \$0\.0500/);
  });
});
