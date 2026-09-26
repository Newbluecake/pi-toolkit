import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { type ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import { createOrchestratorForTest } from "../../src/workflow/orchestrator.testing.js";
import { buildEntry, CHAIN_SEED, taskKeyOf } from "../../src/workflow/journal.js";
import type { JournalEntry, WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

const BASE_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 100,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: 5_000,
  runawayPolicy: "diagnose_only",
};

const VALID_SCRIPT = 'export const meta = { name: "t", description: "t" };\nlog(\'hi\');\nreturn 1;';

function makeDeps(clock: FakeClock, spawnOpts?: Parameters<typeof fakeSpawnWorkerFactory>[0]) {
  const factory = fakeSpawnWorkerFactory(spawnOpts);
  const deps = {
    clock,
    createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }),
  };
  return { deps, factory };
}

function req(overrides: Partial<OrchestratorRunRequest> = {}): OrchestratorRunRequest {
  return { workflowId: "wf_test", script: VALID_SCRIPT, budget: BASE_BUDGET, ...overrides };
}

describe("orchestrator.ts (M3.1 skeleton: boot -> script -> settle)", () => {
  it("already-aborted signal never boots a worker and returns aborted immediately", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const controller = new AbortController();
    controller.abort();
    const outcome = await orch.run(req({ signal: controller.signal }));
    expect(outcome.status).toBe("aborted");
    expect(outcome.stopCause).toBe("user_stop");
    expect(() => factory.worker()).toThrow(); // spawnWorker was never called
  });

  it("rejects an over-size script within scriptLoadMs, before ever booting a worker", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const huge = "x".repeat(600 * 1024);
    const outcome = await orch.run(req({ script: huge }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/byte limit/);
    expect(() => factory.worker()).toThrow();
  });

  it("HB1 misconfiguration (heartbeatStallMs too small) throws synchronously instead of producing a workflow outcome", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    await expect(orch.run(req({ budget: { ...BASE_BUDGET, heartbeatStallMs: 100 } }))).rejects.toThrow(/HB1 violated/);
  });

  it("W14: worker boot never comes online -> timed_out(worker_boot), bounded by workerBootMs + terminateConfirmMs", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock, { autoOnline: false });
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    // Let the (already-resolved) script_load check's microtask settle before
    // advancing the FakeClock, otherwise its armed withDeadline timer can win
    // the race purely as a FakeClock test artifact (a real Clock's timer
    // never beats an already-resolved promise's microtask).
    await new Promise((r) => setTimeout(r, 0));
    // boot() races workerBootMs; the fake worker's terminate() (called during
    // the boot-failure cleanup path) resolves immediately, so no further
    // advance is needed for S7.
    clock.advance(BASE_BUDGET.workerBootMs);
    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("worker_boot");
    expect(outcome.durationMs).toBeLessThanOrEqual(BASE_BUDGET.workerBootMs + BASE_BUDGET.terminateConfirmMs);
  });

  it("meta_error is reported as failed(script_error)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0)); // let boot's 'online' microtask + boot() resolve
    factory.worker().emit("online"); // no-op if already fired; harmless
    // Simulate the worker reporting a meta parse failure over the port.
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "meta_error", message: "bad meta" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("script_error");
    expect(outcome.error?.message).toBe("bad meta");
  });

  it("script_returned settles as completed with the script's result", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: 42 });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe(42);
    expect(outcome.pendingReconcile).toBe(false);
  });

  it("W04: worker error (e.g. stack overflow) settles bounded as failed(worker_died)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.worker().emit("error", new Error("Maximum call stack size exceeded"));
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("worker_died");
    expect(outcome.error?.message).toMatch(/call stack/);
  });

  it("W05: unexpected worker exit (e.g. OOM kill) settles bounded as failed(worker_died)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.worker().emit("exit", 1);
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("worker_died");
    expect(outcome.error?.message).toMatch(/exited unexpectedly with code 1/);
  });

  it("an EXPECTED exit (host already drove terminate) never produces a failed(worker_died) outcome", async () => {
    // Regression guard for the `expected` flag threaded through onExit:
    // completing normally terminates the worker itself, so a subsequent
    // native 'exit' from that same worker must not be misclassified.
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed"); // not overwritten by the exit event terminate() itself triggers
  });

  it("workflow-agent-queue §5: every stage_error (incl. source 'unhandled') is also emitted on subagent:workflow:stage_error, message capped at 200", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const orch = createOrchestrator({
      ...deps,
      emit: (channel, payload) => emitted.push({ channel, payload: payload as Record<string, unknown> }),
    });
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    const port = factory.workerData().commPort;
    port.postMessage({ kind: "stage_error", source: "pipeline", itemIndex: 2, stageIndex: 1, message: "stage boom" });
    port.postMessage({ kind: "stage_error", source: "unhandled", itemIndex: 0, message: "x".repeat(300) });
    port.postMessage({ kind: "stage_error", source: "bogus", itemIndex: 0, message: "dropped" });
    port.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.diag.stageErrors?.count).toBe(2);
    const stageEvents = emitted.filter((e) => e.channel === "subagent:workflow:stage_error").map((e) => e.payload);
    expect(stageEvents).toEqual([
      {
        workflowId: "wf_test",
        at: expect.any(Number),
        source: "pipeline",
        itemIndex: 2,
        stageIndex: 1,
        message: "stage boom",
      },
      { workflowId: "wf_test", at: expect.any(Number), source: "unhandled", itemIndex: 0, message: expect.any(String) },
    ]);
    const capped = stageEvents[1]!.message as string;
    expect(capped).toHaveLength(200);
    expect(capped.endsWith("\u2026")).toBe(true);
    // The diag sample keeps the full message; only the event is capped.
    expect(outcome.diag.stageErrors?.samples[1]?.message).toHaveLength(300);
  });

  it("stage_error messages from the worker land in diag.stageErrors (count exact, samples capped at 5)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    const port = factory.workerData().commPort;
    for (let i = 0; i < 7; i++) {
      port.postMessage({ kind: "stage_error", source: "pipeline", itemIndex: i, stageIndex: 0, message: `boom ${i}` });
    }
    port.postMessage({ kind: "stage_error", source: "parallel", itemIndex: 3, message: "thunk boom" });
    port.postMessage({ kind: "stage_error", source: "bogus", itemIndex: "x", message: "malformed" }); // dropped silently
    port.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.stageErrors?.count).toBe(8); // malformed one dropped, not counted
    expect(outcome.diag.stageErrors?.samples).toHaveLength(5);
    expect(outcome.diag.stageErrors?.samples[0]).toEqual({
      source: "pipeline",
      itemIndex: 0,
      stageIndex: 0,
      message: "boom 0",
    });
    expect(outcome.diag.stageErrors?.samples[4]).toEqual({
      source: "pipeline",
      itemIndex: 4,
      stageIndex: 0,
      message: "boom 4",
    });
  });

  it("a clean run carries no diag.stageErrors at all", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.diag.stageErrors).toBeUndefined();
  });

  it("WT8: absolute workflowTotalMs deadline fires even though the worker never sends anything (never-resolving script)", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(BASE_BUDGET.workflowTotalMs);
    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("workflow_total");
    expect(outcome.durationMs).toBeLessThanOrEqual(BASE_BUDGET.workflowTotalMs + BASE_BUDGET.terminateConfirmMs);
  });

  it("user_stop via AbortSignal after boot settles as aborted", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const controller = new AbortController();
    const runPromise = orch.run(req({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const outcome = await runPromise;
    expect(outcome.status).toBe("aborted");
    expect(outcome.stopCause).toBe("user_stop");
  });

  it("W35: terminate()'s S7 hangs forever, but the workflow still settles within deadlineAt + terminateConfirmMs (GW1a/GW1b upper bound holds independent of terminate() success)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock, { hangOnTerminate: true });
    const orch = createOrchestrator(deps);
    const start = clock.now();
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "done" });
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(BASE_BUDGET.terminateConfirmMs);
    const outcome = await runPromise;

    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("done");
    expect(outcome.diag.orphanWorker).toBeDefined(); // terminate() never confirmed -> honestly reported, not swept under the rug
    expect(clock.now() - start).toBeLessThanOrEqual(BASE_BUDGET.terminateConfirmMs + 1);
  });

  it("createOrchestratorForTest builds a working orchestrator identical in behavior to the production factory (M3.1 hook skeleton is a pass-through)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestratorForTest(deps, {});
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "via-test-factory" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("via-test-factory");
  });

  it("L3 gate: the production factory throws if a caller smuggles __testHooks past the type system with `as any`", () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const smuggled = { ...deps, __testHooks: {} } as unknown as Parameters<typeof createOrchestrator>[0];
    expect(() => createOrchestrator(smuggled)).toThrow(/test hooks are not permitted in the production factory/);
  });
});

describe("HB2 (§2.3): heartbeat stall alone never terminates under the default diagnose_only policy", () => {
  it("W02c analogue: a fake worker reporting a stalled heartbeat for far longer than heartbeatStallMs still lets the script complete normally", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(
      req({ budget: { ...BASE_BUDGET, runawayPolicy: "diagnose_only", workflowTotalMs: 60_000 } }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Advance well past heartbeatStallMs without ever completing — diagnose_only must not react.
    clock.advance(BASE_BUDGET.heartbeatStallMs * 3);
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "still-fine" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("still-fine");
  });

  it("terminate_on_stall does escalate to failed(runaway) once the heartbeat SAB genuinely stops advancing", async () => {
    const clock = new FakeClock();
    const factory = fakeSpawnWorkerFactory();
    const deps = { clock, createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }) };
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req({ budget: { ...BASE_BUDGET, runawayPolicy: "terminate_on_stall" } }));
    await new Promise((r) => setTimeout(r, 0));
    // Never write to the heartbeat SAB (the fake worker doesn't run the real
    // scaffold), so readHeartbeat()'s stalledMs grows monotonically with the clock.
    clock.advance(BASE_BUDGET.heartbeatStallMs + BASE_BUDGET.heartbeatMs);
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("runaway");
  });
});

void vi; // (imported for consistency with other test files even where unused directly)

/**
 * replay-verify-plan v2.1 §6 P2 test 18 (+ orchestrator-side slice of test
 * 13): `buildJournalConfig`'s probe wiring and `isolationCwd` pinning, and
 * `recheckReplayedIsolation`'s parallel-with-flush, diagnostic-only
 * contract — all driven through the REAL `createOrchestrator`, with a
 * FakeClock so the probe's bounded-return guarantee (D4.3: `timeoutMs+500`)
 * is asserted exactly, not just "eventually".
 */
describe("orchestrator.ts: replay-verify plan D4 probe wiring + isolationCwd pinning + D4.4 terminal recheck", () => {
  const ISO_BUDGET: WorkflowRunBudget = {
    scriptLoadMs: 1_000,
    scriptSliceMs: 1_000,
    workerBootMs: 2_000,
    heartbeatMs: 0,
    heartbeatStallMs: 60_000,
    terminateConfirmMs: 500,
    workflowTotalMs: 30_000,
    runawayPolicy: "diagnose_only",
    hostCallMs: 5_000,
    gateMs: 5_000,
    maxParallel: 8,
    maxChildren: 50,
    maxBatchItems: 50,
    childBudgetPolicy: "inherit_remaining",
  };

  let journalRootDir: string;
  beforeEach(async () => {
    journalRootDir = await mkdtemp(join(tmpdir(), "wf-orch-iso-"));
  });
  afterEach(async () => {
    await rm(journalRootDir, { recursive: true, force: true });
  });

  /** Real setImmediate ticks — fs I/O (journal load/write) is real even though the workflow's own timers are faked. */
  async function flushIo(n = 10): Promise<void> {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  }

  /** Polls (via real `setTimeout` ticks, not just `setImmediate`, so real fs latency under heavy parallel-suite CPU contention actually gets to elapse) until `pred()` is true or the wall-clock budget is exhausted. */
  async function waitUntil(pred: () => boolean, maxWaitMs = 10_000, stepMs = 5): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (!pred() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  /** Waits until boot has actually spawned the worker — journal load / probe / cwd pinning do real async work first, so a fixed `flushIo()` is not enough under full-suite CPU contention. */
  async function waitForWorker(factory: { worker: () => unknown }): Promise<void> {
    await waitUntil(() => {
      try {
        factory.worker();
        return true;
      } catch {
        return false;
      }
    });
  }

  function makeIsoDeps(
    clock: FakeClock,
    spawnerExtra: Partial<ChildSpawner>,
    opts: { isolationVerifyTimeoutMs?: number } = {},
  ) {
    const factory = fakeSpawnWorkerFactory();
    const spawnedReqs: Array<Parameters<ChildSpawner["spawn"]>[0]> = [];
    const spawner: ChildSpawner = {
      spawn: async (r) => {
        spawnedReqs.push(r);
        return { runId: `r${spawnedReqs.length}` };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: runId })),
        pending: [],
      }),
      configHashOf: () => "hash",
      worktreeAvailable: () => true,
      ...spawnerExtra,
    };
    const deps = {
      clock,
      createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }),
      spawner,
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      journalRootDir,
      ...(opts.isolationVerifyTimeoutMs !== undefined
        ? { isolationVerifyTimeoutMs: opts.isolationVerifyTimeoutMs }
        : {}),
    };
    return { deps, factory, spawnedReqs };
  }

  /** Seeds `<journalRootDir>/<name>/journal.jsonl` with one `committed` isolated candidate. `prompt` must match the script's own `agent(prompt, {isolation:"worktree"})` call for it to actually replay-hit (the key is content-addressed — `taskKeyOf`). */
  async function seedIsolatedEntry(
    name: string,
    prompt: string,
    worktreeOverrides: { commit?: string; branch?: string } = {},
  ) {
    const dir = join(journalRootDir, name);
    await mkdir(dir, { recursive: true });
    const key = taskKeyOf({ agentType: "general-purpose", agentTypeConfigHash: "hash", prompt, isolation: "worktree" });
    const entry = buildEntry({
      scope: "chain",
      key,
      chainDigestBefore: CHAIN_SEED,
      occurrence: 0,
      agentType: "general-purpose",
      isolation: "worktree",
      worktree: {
        state: "committed",
        branch: worktreeOverrides.branch ?? "pi-agent-r1",
        commit: worktreeOverrides.commit ?? "a".repeat(40),
        isoId: "b".repeat(32),
      },
      value: "iso-out",
      completedAt: 0,
      durationMs: 1,
    });
    await writeFile(join(dir, "journal.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  }

  it("zero probe calls when the journal has no isolated committed candidates", async () => {
    const clock = new FakeClock();
    const probeAgentBranches = vi.fn(async () => ({ ok: true as const, tips: new Map() }));
    const { deps, factory } = makeIsoDeps(clock, {
      isolationReplayMode: () => "verify",
      isolationCwd: () => "/repo",
      probeAgentBranches,
    });
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req({ budget: ISO_BUDGET, journal: "empty" }));
    await waitForWorker(factory);
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(probeAgentBranches).not.toHaveBeenCalled();
    expect(outcome.replay?.isolation).toMatchObject({ probed: 0, verified: 0, unverified: 0, freshFolds: 0, stale: 0 });
  }, 20_000);

  it("a probe that never resolves still lets boot start once runBoundedProbe's outer deadline (timeoutMs+500) fires — D4.3's bounded-return, not bounded-process-lifetime, guarantee", async () => {
    const clock = new FakeClock();
    await seedIsolatedEntry("j-hang", "iso task");
    const probeAgentBranches = vi.fn(() => new Promise<never>(() => {})); // never resolves, ignores the AbortSignal
    const { deps, factory } = makeIsoDeps(
      clock,
      { isolationReplayMode: () => "verify", isolationCwd: () => "/repo", probeAgentBranches },
      { isolationVerifyTimeoutMs: 1_000 },
    );
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req({ budget: ISO_BUDGET, journal: "j-hang" }));
    await waitUntil(() => probeAgentBranches.mock.calls.length >= 1);
    expect(probeAgentBranches).toHaveBeenCalledTimes(1); // D4.2: probed once, with the one committed candidate's branch
    expect(() => factory.worker()).toThrow(); // boot has NOT started — buildJournalConfig is still awaiting the probe
    clock.advance(1_000); // reaches timeoutMs: the AbortController fires; the fake probe ignores it (single settlement)
    await flushIo();
    expect(() => factory.worker()).toThrow(); // still not started — the OUTER withDeadline needs +500 more
    clock.advance(500); // reaches timeoutMs + 500: the outer deadline settles regardless of the probe's own state
    await waitUntil(() => {
      try {
        factory.worker();
        return true;
      } catch {
        return false;
      }
    });
    expect(() => factory.worker()).not.toThrow(); // boot has now started — the probe's hang never blocked it beyond the bound
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed"); // a hung/failed probe degrades to live, it never fails the run (D4.3)
    expect(outcome.replay?.isolation?.probeError).toBe("isolation verify probe timed out");
    expect(outcome.replay?.isolation).toMatchObject({ probed: 1, verified: 0, unverified: 1 });
  }, 20_000);

  it("isolationCwd is read exactly once per run — mutating the getter's return value mid-run never changes an already-pinned run's spawn requests", async () => {
    const clock = new FakeClock();
    let currentCwd = "/repo-v1";
    const isolationCwd = vi.fn(() => currentCwd);
    const { deps, factory, spawnedReqs } = makeIsoDeps(clock, {
      isolationReplayMode: () => "verify",
      isolationCwd,
      probeAgentBranches: async () => ({ ok: true, tips: new Map() }), // no candidates this run (fresh journal) — resolves instantly
    });
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req({ budget: ISO_BUDGET, journal: "j-cwd" }));
    await waitUntil(() => isolationCwd.mock.calls.length >= 1);
    expect(isolationCwd).toHaveBeenCalledTimes(1); // pinned once, before boot
    // Mutate the live getter's answer AFTER the run has pinned its own cwd —
    // this must never leak into this run's OWN spawn requests.
    currentCwd = "/repo-v2";
    await waitForWorker(factory);
    factory.workerData().commPort.postMessage({
      kind: "host_call",
      id: "1",
      op: "agent",
      args: { prompt: "iso-a", opts: { isolation: "worktree" } },
    });
    await flushIo();
    currentCwd = "/repo-v3"; // mutate again, between the two isolated calls
    factory.workerData().commPort.postMessage({
      kind: "host_call",
      id: "2",
      op: "agent",
      args: { prompt: "iso-b", opts: { isolation: "worktree" } },
    });
    await flushIo();
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(isolationCwd).toHaveBeenCalledTimes(1); // still exactly once for the whole run
    expect(spawnedReqs).toHaveLength(2);
    // Both isolated calls' spawn requests carry the FIRST (pinned) cwd, never the mutated ones.
    expect(spawnedReqs.map((r) => (r as { cwd?: string }).cwd)).toEqual(["/repo-v1", "/repo-v1"]);
  }, 20_000);

  it("the terminal recheck runs CONCURRENTLY with flushJournal (never sequenced after it), degrades a hung probe to 'not annotated' (never fails the run), and never delays the terminal decision beyond its own bound", async () => {
    const clock = new FakeClock();
    const COMMIT = "a".repeat(40);
    await seedIsolatedEntry("j-recheck", "iso task", { commit: COMMIT });
    let probeCallCount = 0;
    const probeAgentBranches = vi.fn(async (branches: readonly string[]) => {
      probeCallCount += 1;
      if (probeCallCount === 1) {
        // The load-time snapshot probe: resolves quickly, verifying the seeded entry.
        return { ok: true as const, tips: new Map(branches.map((b) => [`refs/heads/${b}`, COMMIT] as const)) };
      }
      // The terminal recheck's own probe call: hangs forever.
      return new Promise<never>(() => {});
    });
    const { deps, factory, spawnedReqs } = makeIsoDeps(clock, {
      isolationReplayMode: () => "verify",
      isolationCwd: () => "/repo",
      probeAgentBranches,
    });
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req({ budget: { ...ISO_BUDGET, journalFlushMs: 2_000 }, journal: "j-recheck" }));
    await waitUntil(() => probeCallCount >= 1);
    expect(probeCallCount).toBe(1); // load-time snapshot probe only, so far
    await waitForWorker(factory);
    factory.workerData().commPort.postMessage({
      kind: "host_call",
      id: "1",
      op: "agent",
      args: { prompt: "iso task", opts: { isolation: "worktree" } },
    });
    await flushIo();
    expect(spawnedReqs).toHaveLength(0); // genuine replay hit — never spawned
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    // Let the terminal Promise.all([flushJournal, recheckReplayedIsolation])
    // actually start and arm its bounded-probe timer before advancing the clock.
    await waitUntil(() => probeCallCount >= 2);
    expect(probeCallCount).toBe(2); // the terminal recheck fired its own probe call
    clock.advance(2_500); // recheckBranches' own runBoundedProbe: min(2_000, journalFlushMs)+500
    await flushIo();
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed"); // a hung recheck never fails the workflow (D4.4)
    const isoChild = outcome.children.find((c) => c.callId === "1");
    expect(isoChild?.source).toBe("replay"); // still the genuine hit from the load-time snapshot
    expect(isoChild?.replayStale).toBeUndefined(); // hung/unknown → never annotated (D4.4: "不标注（未知），也不 hang")
    expect(outcome.replay?.isolation?.stale).toBe(0);
  }, 20_000);
});
