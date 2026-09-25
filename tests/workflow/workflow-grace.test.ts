import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { WorkflowDeadlineNotice } from "../../src/workflow/deadline.js";
import type { ChildSpawner, GateRunner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import { createOrchestratorForTest } from "../../src/workflow/orchestrator.testing.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * workflow-agent-queue plan §4.3 / §7 stage B: the orchestrator's WT8 driven
 * by the deadline controller (grace window, extensions, hard ceiling) and the
 * host bounding its own activity by the mutable `killAt` while children stay
 * pinned to the static `W.hardAt` (§0′ #1).
 */

const TOTAL = 60_000;
const GRACE = 10_000;
const HARD = 2 * TOTAL;

const BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: TOTAL,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 600_000,
  maxParallel: 1,
  maxChildren: 50,
  maxBatchItems: 100,
  childBudgetPolicy: "inherit_remaining",
  abortGraceMs: 1_000,
  totalGraceMs: GRACE,
  maxExtensions: 2,
  maxTotalFactor: 2,
};

const SCRIPT = 'export const meta = { name: "g", description: "g" };\nreturn 1;';

async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

interface SpawnCall {
  readonly prompt: string;
  readonly deadlineAt?: number;
  readonly totalMs?: number;
  readonly at: number;
}

function harness(opts: { budget?: Partial<WorkflowRunBudget>; testHooks?: boolean; holdTeardown?: boolean } = {}) {
  const clock = new FakeClock();
  const factory = fakeSpawnWorkerFactory();
  const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const notices: WorkflowDeadlineNotice[] = [];
  const spawnCalls: SpawnCall[] = [];
  const aborted: string[] = [];
  const waiters = new Map<string, (status: "completed" | "failed") => void>();
  const gateTimeouts: number[] = [];
  let seq = 0;
  const spawner: ChildSpawner = {
    spawn: async (r) => {
      spawnCalls.push({
        prompt: r.prompt,
        ...(r.deadlineAt !== undefined ? { deadlineAt: r.deadlineAt } : {}),
        ...(r.budgetOverride?.totalMs !== undefined ? { totalMs: r.budgetOverride.totalMs } : {}),
        at: clock.now(),
      });
      return { runId: `run-${++seq}` };
    },
    abort: async (runId) => {
      aborted.push(runId);
      waiters.get(runId)?.("failed");
      return true;
    },
    waitAll: ({ runIds }) =>
      new Promise((resolve) => {
        const runId = runIds[0]!;
        waiters.set(runId, (status) => {
          waiters.delete(runId);
          resolve({ settled: [{ runId, status, text: status }], pending: [] });
        });
      }),
  };
  const gateRunner: GateRunner = async (_cmd, o) => {
    gateTimeouts.push(o.timeoutMs);
    return { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const deps = {
    clock,
    createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }),
    spawner,
    gateRunner,
    emit: (channel: string, payload: unknown) => emitted.push({ channel, payload: payload as Record<string, unknown> }),
    onDeadlineNotice: (n: WorkflowDeadlineNotice) => notices.push(n),
  };
  const orch = opts.holdTeardown
    ? createOrchestratorForTest(deps, {
        beforeEffect: (kind) => (kind === "stop_owned" ? { delayMs: 5_000 } : "proceed"),
      })
    : createOrchestrator(deps);
  const req: OrchestratorRunRequest = {
    workflowId: "wf_grace",
    script: SCRIPT,
    budget: { ...BUDGET, ...opts.budget },
  };
  const toWorker: Array<Record<string, unknown>> = [];
  let port: MessagePort | undefined;
  return {
    clock,
    orch,
    req,
    emitted,
    notices,
    spawnCalls,
    aborted,
    waiters,
    gateTimeouts,
    toWorker,
    deadlineEvents: () => emitted.filter((e) => e.channel === "subagent:workflow:deadline").map((e) => e.payload),
    /** Start the run and attach the worker side of the port. */
    async start() {
      const run = orch.run(req);
      await flush();
      port = factory.workerData().commPort;
      port.on("message", (m: Record<string, unknown>) => toWorker.push(m));
      return { run }; // wrapped: an async function returning the bare promise would await it
    },
    call(id: string, op: "agent" | "gate", args: unknown) {
      port!.postMessage({ kind: "host_call", id, op, args });
    },
    returnScript(result: unknown) {
      port!.postMessage({ kind: "script_returned", result });
    },
    ackOf(id: string) {
      return toWorker.find((m) => m.kind === "host_ack" && m.id === id);
    },
  };
}

describe("workflow grace window (orchestrator WT8 driven by the deadline controller)", () => {
  it("soft deadline with extension budget left → grace (event + notice), keeps running, then timed_out(workflow_total) at graceUntil", async () => {
    const h = harness();
    const { run } = await h.start();
    h.clock.advance(TOTAL);
    await flush();
    const events = h.deadlineEvents();
    expect(events).toEqual([
      {
        workflowId: "wf_grace",
        at: TOTAL,
        kind: "grace",
        deadlineAt: TOTAL,
        graceUntil: TOTAL + GRACE,
        hardDeadlineAt: HARD,
        extensionsUsed: 0,
        maxExtensions: 2,
      },
    ]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({
      kind: "grace",
      workflowId: "wf_grace",
      graceUntil: TOTAL + GRACE,
      totalMs: TOTAL,
      suggestedExtendMs: TOTAL, // min(total, headroom = HARD - TOTAL)
      live: { running: 0, queued: 0, settled: 0 },
    });
    // Still running inside the grace window.
    expect(h.orch.outcomeAt1("wf_grace")).toBeUndefined();
    expect(h.orch.deadline?.("wf_grace")).toMatchObject({ graceUntil: TOTAL + GRACE, graces: 1 });
    h.clock.advance(GRACE);
    const outcome = await run;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("workflow_total");
    expect(outcome.durationMs).toBe(TOTAL + GRACE);
    expect(outcome.diag.overtime).toEqual({ graces: 1, extensions: 0, grantedMs: 0 });
    expect(outcome.diag.deadlineAt).toBe(TOTAL);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("extend inside grace rescues it: WT8 re-armed to the new soft deadline, extended notice, re-enters grace later", async () => {
    const h = harness();
    const { run } = await h.start();
    h.clock.advance(TOTAL + 3_000);
    await flush();
    const r = h.orch.extend!("wf_grace", 20_000, { reason: "almost done" });
    expect(r).toMatchObject({
      ok: true,
      workflowId: "wf_grace",
      previousDeadlineAt: TOTAL,
      deadlineAt: TOTAL + 3_000 + 20_000,
      grantedMs: 20_000,
      rescuedFromGrace: true,
      extensionsUsed: 1,
      extensionsRemaining: 1,
      hardDeadlineAt: HARD,
    });
    expect(h.notices.map((n) => n.kind)).toEqual(["grace", "extended"]);
    expect(h.notices[1]).toMatchObject({ requestedMs: 20_000, grantedMs: 20_000, reason: "almost done" });
    expect(h.deadlineEvents()[1]).toMatchObject({ kind: "extended", deadlineAt: TOTAL + 23_000, extensionsUsed: 1 });
    expect(h.deadlineEvents()[1]!.graceUntil).toBeUndefined();
    // The old graceUntil passes without killing the run (WT8 was re-armed).
    h.clock.advance(GRACE);
    await flush();
    expect(h.orch.outcomeAt1("wf_grace")).toBeUndefined();
    // Reaching the extended soft deadline opens a second grace window (one extension left).
    h.clock.advance(TOTAL + 23_000 - h.clock.now());
    await flush();
    expect(h.deadlineEvents().map((e) => e.kind)).toEqual(["grace", "extended", "grace"]);
    h.returnScript("ok");
    const outcome = await run;
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.deadlineAt).toBe(TOTAL + 23_000);
    expect(outcome.diag.overtime).toEqual({ graces: 2, extensions: 1, grantedMs: 20_000 });
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("extensions exhausted → the soft deadline expires without grace (D-6); deadline events ≤ 2 × maxExtensions", async () => {
    const h = harness();
    const { run } = await h.start();
    expect(h.orch.extend!("wf_grace", 5_000).ok).toBe(true);
    expect(h.orch.extend!("wf_grace", 5_000).ok).toBe(true);
    expect(h.orch.extend!("wf_grace", 5_000)).toEqual({ ok: false, reason: "limit_reached" });
    h.clock.advance(TOTAL + 10_000);
    const outcome = await run;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.durationMs).toBe(TOTAL + 10_000);
    expect(outcome.diag.overtime).toEqual({ graces: 0, extensions: 2, grantedMs: 10_000 });
    expect(h.deadlineEvents().length).toBeLessThanOrEqual(2 * 2);
    expect(h.notices.every((n) => n.kind === "extended")).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("explicit timeout_s (maxTotalFactor 1) is a hard cap: no grace, extend → no_headroom, timed_out at the soft deadline", async () => {
    const h = harness({ budget: { maxTotalFactor: 1 } });
    const { run } = await h.start();
    expect(h.orch.extend!("wf_grace", 30_000)).toEqual({ ok: false, reason: "no_headroom" });
    h.clock.advance(TOTAL);
    const outcome = await run;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.durationMs).toBe(TOTAL);
    expect(outcome.diag.overtime).toBeUndefined();
    expect(h.deadlineEvents()).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("a budget without grace fields keeps the pre-stage-B hard WT8 (backward compatible)", async () => {
    const h = harness({ budget: { totalGraceMs: undefined, maxExtensions: undefined, maxTotalFactor: undefined } });
    const { run } = await h.start();
    expect(h.orch.extend!("wf_grace", 1_000)).toEqual({ ok: false, reason: "limit_reached" });
    h.clock.advance(TOTAL);
    expect((await run).status).toBe("timed_out");
    expect(h.deadlineEvents()).toEqual([]);
  });

  it("review v2 #5: once finish() decided, extend is refused (already_terminal) while the teardown is still running; unknown after reap", async () => {
    const h = harness({ holdTeardown: true });
    const { run } = await h.start();
    h.returnScript("done");
    await flush();
    // Decision made (outcomeAt1 exists), stop_owned held for 5s: the run is still registered.
    expect(h.orch.outcomeAt1("wf_grace")?.status).toBe("completed");
    expect(h.orch.extend!("wf_grace", 10_000)).toEqual({ ok: false, reason: "already_terminal" });
    h.clock.advance(5_000);
    await run;
    expect(h.orch.extend!("wf_grace", 10_000)).toEqual({ ok: false, reason: "unknown_workflow" });
    expect(h.notices).toEqual([]);
  });

  it("stop() racing an extension: stopping, never a late grant", async () => {
    const h = harness();
    const { run } = await h.start();
    const stopping = h.orch.stop("wf_grace", "user_stop");
    expect(h.orch.extend!("wf_grace", 10_000).ok).toBe(false);
    await stopping;
    expect((await run).status).toBe("aborted");
  });
});

describe("host bounds its own activity by killAt; children pinned to W.hardAt (§0′ #1)", () => {
  it("agent() inside the grace window still dispatches; child deadlineAt = hardAt, totalMs = hardAt − now, ack.deadlineAt = hardAt", async () => {
    const h = harness();
    const { run } = await h.start();
    h.call("c1", "agent", { prompt: "early" });
    await flush();
    expect(h.spawnCalls[0]).toEqual({ prompt: "early", deadlineAt: HARD, totalMs: HARD, at: 0 });
    expect(h.ackOf("c1")).toMatchObject({ ok: true, value: { callId: "c1", deadlineAt: HARD } });
    // A second call queues behind the single slot.
    h.call("c2", "agent", { prompt: "queued" });
    await flush();
    expect(h.ackOf("c2")).toMatchObject({ ok: true, value: { deadlineAt: HARD, queued: true } });
    h.clock.advance(TOTAL + 2_000); // inside grace
    await flush();
    expect(h.deadlineEvents().map((e) => e.kind)).toEqual(["grace"]);
    // A fresh agent() inside grace is admitted (no BW2 rejection), and queues.
    h.call("c3", "agent", { prompt: "in-grace" });
    await flush();
    expect(h.ackOf("c3")).toMatchObject({ ok: true, value: { queued: true } });
    // The first child finishes: the queued call dispatches during grace, still pinned to hardAt.
    h.waiters.get("run-1")!("completed");
    await flush();
    expect(h.spawnCalls[1]).toEqual({
      prompt: "queued",
      deadlineAt: HARD,
      totalMs: HARD - (TOTAL + 2_000),
      at: TOTAL + 2_000,
    });
    // gate() inside grace is bounded by killAt (graceUntil), not by the static hard ceiling.
    h.call("g1", "gate", { cmd: "true" });
    await flush();
    expect(h.gateTimeouts).toEqual([TOTAL + GRACE - (TOTAL + 2_000)]);
    // No extension: at graceUntil the workflow times out and its running child is aborted structurally.
    h.clock.advance(TOTAL + GRACE - h.clock.now());
    await flush();
    h.clock.advance(1_000); // abortGraceMs window, if anything is left
    const outcome = await run;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(TOTAL + GRACE);
    expect(h.aborted).toContain("run-2");
    const byId = new Map(outcome.children.map((c) => [c.callId, c.status]));
    expect(byId.get("c1")).toBe("completed");
    expect(byId.get("c3")).toBe("withheld"); // still queued at the kill point
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("before the soft deadline, HR2/gate bounds preview the grace window (killAt), BW2 only after killAt", async () => {
    const h = harness();
    const { run } = await h.start();
    h.call("g1", "gate", { cmd: "true" });
    await flush();
    expect(h.gateTimeouts).toEqual([TOTAL + GRACE]); // min(gateMs 600s, killAt − now)
    h.returnScript("ok");
    expect((await run).status).toBe("completed");
  });

  it("explicit hard cap: killAt = soft deadline, gate bound = soft deadline", async () => {
    const h = harness({ budget: { maxTotalFactor: 1 } });
    const { run } = await h.start();
    h.call("g1", "gate", { cmd: "true" });
    h.call("c1", "agent", { prompt: "x" });
    await flush();
    expect(h.gateTimeouts).toEqual([TOTAL]);
    expect(h.spawnCalls[0]).toMatchObject({ deadlineAt: TOTAL, totalMs: TOTAL });
    h.returnScript("ok");
    h.clock.advance(1_000);
    await run;
  });
});
