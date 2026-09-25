import { describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock } from "../../src/core/clock.js";
import { createWorkflowActivityRegistry } from "../../src/workflow/activity.js";
import {
  createBackgroundWorkflows,
  runBoundMs,
  type BackgroundSettlePhase,
  type BackgroundWorkflowView,
  type BackgroundWorkflowsDeps,
} from "../../src/workflow/background.js";
import type { Orchestrator } from "../../src/workflow/orchestrator.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";

/**
 * Background workflow registry (docs/dev/workflow-background/plan.md §2.2/§4):
 * the bounded run → stop → settle → degraded-fallback sequence formerly owned
 * by the blocking tool, plus stop/wait/resolve/retention/shutdown semantics.
 */

const BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 10,
  workflowTotalMs: 50,
  runawayPolicy: "diagnose_only",
  abortGraceMs: 10,
  reconcileMs: 10,
};
const LONG_BUDGET: WorkflowRunBudget = { ...BUDGET, workflowTotalMs: 60_000 };

function outcome(overrides: Partial<WorkflowOutcome> = {}): WorkflowOutcome {
  return {
    workflowId: "wf_x",
    status: "completed",
    pendingReconcile: false,
    durationMs: 1,
    children: [],
    diag: { createdAt: 0, heartbeat: { seq: 0, observedAt: 0, stalledMs: 0 }, logLines: 0 },
    ...overrides,
  };
}

/** An orchestrator whose run() resolves only when released (or when stop() is called, if `settleOnStop`). */
function controllable(opts: { settleOnStop?: boolean; outcomeAt1?: WorkflowOutcome } = {}) {
  let release!: (o: WorkflowOutcome) => void;
  const runP = new Promise<WorkflowOutcome>((resolve) => (release = resolve));
  const stops: string[] = [];
  const orch: Orchestrator = {
    run: () => runP,
    stop: async (_id, cause) => {
      stops.push(cause);
      if (opts.settleOnStop) release(outcome({ status: "aborted", stopCause: cause }));
      return { ok: true };
    },
    outcomeAt1: () => opts.outcomeAt1,
    settled: () => runP,
  };
  return { orch, release, stops };
}

function registry(orchFor: () => Orchestrator, extra: Partial<BackgroundWorkflowsDeps> = {}) {
  const settled: { view: BackgroundWorkflowView & { outcome: WorkflowOutcome }; phase: BackgroundSettlePhase }[] = [];
  const activity = createWorkflowActivityRegistry();
  let n = 0;
  const runs = createBackgroundWorkflows({
    clock: systemClock,
    activity,
    createOrchestrator: () => orchFor(),
    newId: () => `wf_test${++n}`,
    onSettled: (view, phase) => {
      settled.push({ view, phase });
    },
    ...extra,
  });
  return { runs, settled, activity };
}

const start = (runs: ReturnType<typeof registry>["runs"], budget = LONG_BUDGET, name = "demo") =>
  runs.start({ script: "export const meta={name:'demo',description:'d'};\nreturn 1;", name, budget });

describe("background workflows: start returns before the workflow settles", () => {
  it("start() is synchronous and leaves the entry running; activity row registered until terminal", async () => {
    const c = controllable();
    const { runs, settled, activity } = registry(() => c.orch);
    const view = start(runs);
    expect(view.status).toBe("running");
    expect(runs.get(view.workflowId)?.status).toBe("running");
    expect(activity.list().map((a) => a.workflowId)).toEqual([view.workflowId]);
    expect(runs.activeCount()).toBe(1);
    expect(settled).toHaveLength(0);
    c.release(outcome({ result: "done" }));
    const waited = await runs.wait(view.workflowId, { waitMs: 1_000 });
    expect(waited.ok && waited.view.outcome.result).toBe("done");
    expect(activity.list()).toEqual([]);
    expect(runs.activeCount()).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.phase).toBe("live");
  });

  it("start() refuses once shutdown began", () => {
    const { runs } = registry(() => controllable().orch);
    runs.shutdown();
    expect(() => start(runs)).toThrow(/shutting down/);
  });
});

describe("background workflows: bounded sequence (formerly WT13/WT17 in the tool)", () => {
  it("fast path: a run that settles in time is taken as-is, stop() never called", async () => {
    const stop = vi.fn(async () => ({ ok: true }));
    const orch: Orchestrator = {
      run: async () => outcome({ result: "fast" }),
      stop,
      outcomeAt1: () => undefined,
      settled: async () => outcome({ result: "settled-should-not-win" }),
    };
    const { runs } = registry(() => orch);
    const v = start(runs, BUDGET);
    const w = await runs.wait(v.workflowId, { waitMs: 2_000 });
    expect(w.ok && w.view.outcome.result).toBe("fast");
    expect(stop).not.toHaveBeenCalled();
  });

  it("run() hanging past its bound fires an un-awaited stop('timeout') and takes settled()'s real outcome", async () => {
    let stopCause = "";
    const orch: Orchestrator = {
      run: () => new Promise(() => {}),
      stop: (_id, cause) => {
        stopCause = cause;
        return new Promise(() => {}); // never resolves: must not be awaited
      },
      outcomeAt1: () => outcome({ status: "timed_out", pendingReconcile: true, result: "outcomeAt1-should-not-win" }),
      settled: () => new Promise((resolve) => setTimeout(() => resolve(outcome({ status: "timed_out" })), 30)),
    };
    const { runs } = registry(() => orch);
    const v = start(runs, BUDGET);
    const w = await runs.wait(v.workflowId, { waitMs: 5_000 });
    expect(stopCause).toBe("timeout");
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.view.outcome.status).toBe("timed_out");
    expect(w.view.outcome.result).toBeUndefined();
    expect(w.view.outcome.diag.degraded).toBeUndefined();
  }, 10_000);

  it("a stuck orchestrator (run and settled both hang) still reaches a degraded outcomeAt1 terminal within budget + grace", async () => {
    const orch: Orchestrator = {
      run: () => new Promise(() => {}),
      stop: async () => ({ ok: true }),
      outcomeAt1: () => outcome({ status: "timed_out", pendingReconcile: true, result: "partial" }),
      settled: () => new Promise(() => {}),
    };
    const { runs, settled } = registry(() => orch);
    const t0 = Date.now();
    const v = start(runs, BUDGET);
    const w = await runs.wait(v.workflowId, { waitMs: 8_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.view.outcome.status).toBe("timed_out");
    expect(w.view.outcome.result).toBe("partial");
    expect(w.view.outcome.diag.degraded).toBe("settlement_timeout");
    expect(settled).toHaveLength(1);
  }, 10_000);

  it("EI5 double failure (no outcomeAt1 either): an honest timed_out skeleton, never a hang", async () => {
    const orch: Orchestrator = {
      run: () => new Promise(() => {}),
      stop: async () => ({ ok: true }),
      outcomeAt1: () => undefined,
      settled: () => new Promise(() => {}),
    };
    const { runs } = registry(() => orch);
    const v = start(runs, BUDGET);
    const w = await runs.wait(v.workflowId, { waitMs: 8_000 });
    expect(w.ok && w.view.outcome.status).toBe("timed_out");
    expect(w.ok && w.view.outcome.pendingReconcile).toBe(true);
    expect(w.ok && w.view.outcome.diag.degraded).toBe("settlement_timeout");
  }, 10_000);

  it("a rejecting run() becomes a failed terminal entry (the driver never throws past the registry)", async () => {
    const orch: Orchestrator = {
      run: async () => {
        throw new Error("HB1 violated");
      },
      stop: async () => ({ ok: true }),
      outcomeAt1: () => undefined,
      settled: () => new Promise(() => {}),
    };
    const { runs } = registry(() => orch);
    const v = start(runs, BUDGET);
    const w = await runs.wait(v.workflowId, { waitMs: 2_000 });
    expect(w.ok && w.view.outcome.status).toBe("failed");
    expect(w.ok && w.view.outcome.error?.message).toContain("HB1 violated");
  });
});

describe("background workflows: stop (abort_subagent)", () => {
  it("stop() funnels into the orchestrator's stop with the given cause; a second stop reports already_terminal", async () => {
    const c = controllable({ settleOnStop: true });
    const { runs, settled } = registry(() => c.orch);
    const v = start(runs);
    const first = await runs.stop(v.workflowId, "user_stop");
    expect(c.stops).toEqual(["user_stop"]);
    expect(first).toMatchObject({ ok: true, settled: true });
    expect(first.ok && first.view.status).toBe("aborted");
    expect(first.ok && first.view.stopRequested).toBe("user_stop");
    const second = await runs.stop(v.workflowId, "user_stop");
    expect(second).toMatchObject({ ok: false, reason: "already_terminal" });
    expect(c.stops).toEqual(["user_stop"]); // idempotent: no second orchestrator stop
    expect(settled).toHaveLength(1); // exactly one terminal report
  });

  it("stop() on an orchestrator that never settles still yields a degraded aborted terminal within the stop bound", async () => {
    const orch: Orchestrator = {
      run: () => new Promise(() => {}),
      stop: () => new Promise(() => {}),
      outcomeAt1: () => undefined,
      settled: () => new Promise(() => {}),
    };
    const { runs } = registry(() => orch);
    const v = start(runs);
    const t0 = Date.now();
    const r = await runs.stop(v.workflowId, "user_stop");
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(r).toMatchObject({ ok: true, settled: true });
    expect(r.ok && r.view.outcome?.status).toBe("aborted");
    expect(r.ok && r.view.outcome?.stopCause).toBe("user_stop");
    expect(r.ok && r.view.outcome?.diag.degraded).toBe("settlement_timeout");
  }, 10_000);

  it("unknown ids are reported, not thrown", async () => {
    const { runs } = registry(() => controllable().orch);
    expect(await runs.stop("wf_nope", "user_stop")).toEqual({ ok: false, reason: "unknown_workflow" });
    expect(await runs.wait("wf_nope", { waitMs: 10 })).toEqual({ ok: false, reason: "unknown_workflow" });
  });
});

describe("background workflows: bounded wait", () => {
  it("times out while running, returns the outcome once terminal, and honours an aborted signal", async () => {
    const c = controllable();
    const { runs } = registry(() => c.orch);
    const v = start(runs);
    expect(await runs.wait(v.workflowId, { waitMs: 20 })).toEqual({ ok: false, reason: "wait_timeout" });
    const ac = new AbortController();
    const pending = runs.wait(v.workflowId, { waitMs: 5_000, signal: ac.signal });
    ac.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    c.release(outcome());
    const done = await runs.wait(v.workflowId, { waitMs: 1_000 });
    expect(done.ok && done.view.status).toBe("completed");
  });
});

describe("background workflows: resolution", () => {
  it("exact id, unique prefix, ambiguous prefix, and no match", () => {
    const { runs } = registry(() => controllable().orch, {
      newId: (() => {
        const ids = ["wf_aa11", "wf_aa22", "wf_bb33"];
        return () => ids.shift()!;
      })(),
    });
    start(runs);
    start(runs);
    start(runs);
    expect(runs.resolve("wf_aa11")).toEqual({ kind: "workflow", workflowId: "wf_aa11" });
    expect(runs.resolve("wf_bb")).toEqual({ kind: "workflow", workflowId: "wf_bb33" });
    expect(runs.resolve("wf_aa").kind).toBe("ambiguous");
    expect(runs.resolve("r_ABCDEFGH")).toEqual({ kind: "none" });
    expect(runs.resolve("")).toEqual({ kind: "none" });
  });

  it("script name: the single running workflow wins; several running are ambiguous; else the most recent", async () => {
    const orchs = [controllable({ settleOnStop: true }), controllable({ settleOnStop: true })];
    let i = 0;
    const { runs } = registry(() => orchs[i++]!.orch);
    const a = start(runs, LONG_BUDGET, "review");
    const b = start(runs, LONG_BUDGET, "review");
    expect(runs.resolveLabel("review").kind).toBe("ambiguous");
    await runs.stop(a.workflowId, "user_stop");
    expect(runs.resolveLabel("review")).toEqual({ kind: "workflow", workflowId: b.workflowId });
    await runs.stop(b.workflowId, "user_stop");
    expect(runs.resolveLabel("review")).toEqual({ kind: "workflow", workflowId: b.workflowId });
    expect(runs.resolveLabel("other")).toEqual({ kind: "none" });
  });
});

describe("background workflows: retention (bounded, no timers)", () => {
  it("keeps at most maxTerminal settled entries, evicting the oldest", async () => {
    const orch: Orchestrator = {
      run: async () => outcome(),
      stop: async () => ({ ok: true }),
      outcomeAt1: () => undefined,
      settled: async () => outcome(),
    };
    const { runs } = registry(() => orch, { maxTerminal: 2 });
    const ids: string[] = [];
    for (let k = 0; k < 3; k++) {
      const v = start(runs, BUDGET);
      await runs.wait(v.workflowId, { waitMs: 1_000 });
      ids.push(v.workflowId);
    }
    expect(runs.get(ids[0]!)).toBeUndefined();
    expect(runs.get(ids[1]!)?.status).toBe("completed");
    expect(runs.get(ids[2]!)?.status).toBe("completed");
  });

  it("drops settled entries past their TTL (pruned lazily on access)", async () => {
    const clock = new FakeClock(1_000);
    const orch: Orchestrator = {
      run: async () => outcome(),
      stop: async () => ({ ok: true }),
      outcomeAt1: () => undefined,
      settled: async () => outcome(),
    };
    const runs = createBackgroundWorkflows({
      clock,
      activity: createWorkflowActivityRegistry(),
      createOrchestrator: () => orch,
      terminalTtlMs: 10_000,
    });
    const v = runs.start({ script: "x", name: "n", budget: BUDGET });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(runs.get(v.workflowId)?.status).toBe("completed");
    clock.advance(9_000);
    expect(runs.get(v.workflowId)?.status).toBe("completed");
    clock.advance(2_000);
    expect(runs.get(v.workflowId)).toBeUndefined();
  });
});

describe("background workflows: session shutdown", () => {
  it("shutdown() stops every running workflow; the settle reports phase 'shutdown'", async () => {
    const c = controllable({ settleOnStop: true });
    const { runs, settled } = registry(() => c.orch);
    const v = start(runs);
    runs.shutdown();
    await runs.drain(2_000);
    expect(c.stops).toEqual(["shutdown"]);
    expect(runs.get(v.workflowId)?.status).toBe("aborted");
    expect(settled.map((s) => s.phase)).toEqual(["shutdown"]);
  });

  it("seal() finalizes a workflow that did not settle within the drain (degraded snapshot) and suppresses its late settle", async () => {
    const c = controllable({
      outcomeAt1: outcome({ status: "aborted", stopCause: "shutdown", pendingReconcile: true, result: "snap" }),
    });
    const { runs, settled } = registry(() => c.orch);
    const v = start(runs);
    runs.shutdown();
    await runs.drain(20);
    expect(runs.get(v.workflowId)?.status).toBe("running");
    runs.seal();
    const after = runs.get(v.workflowId);
    expect(after?.status).toBe("aborted");
    expect(after?.outcome?.diag.degraded).toBe("settlement_timeout");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.phase).toBe("shutdown");
    c.release(outcome({ status: "completed" })); // late real settle
    await new Promise((r) => setTimeout(r, 10));
    expect(runs.get(v.workflowId)?.status).toBe("aborted"); // first terminal wins
    expect(settled).toHaveLength(1);
  });

  it("abandon() stops running workflows (no orphans) but reports nothing", async () => {
    const c = controllable({ settleOnStop: true });
    const { runs, settled } = registry(() => c.orch);
    const v = start(runs);
    runs.abandon();
    await runs.wait(v.workflowId, { waitMs: 2_000 });
    expect(c.stops).toEqual(["shutdown"]);
    expect(runs.get(v.workflowId)?.status).toBe("aborted");
    expect(settled).toEqual([]);
  });

  it("seedTerminal() inserts a readable terminal entry and never overrides an existing one", async () => {
    const { runs } = registry(() => controllable().orch);
    runs.seedTerminal({
      workflowId: "wf_seed",
      name: "old",
      startedAt: 1,
      status: "aborted",
      outcome: outcome({ workflowId: "wf_seed", status: "aborted" }),
    });
    expect(runs.get("wf_seed")?.status).toBe("aborted");
    const w = await runs.wait("wf_seed", { waitMs: 10 });
    expect(w.ok).toBe(true);
    runs.seedTerminal({
      workflowId: "wf_seed",
      name: "other",
      startedAt: 2,
      status: "completed",
      outcome: outcome({ workflowId: "wf_seed" }),
    });
    expect(runs.get("wf_seed")?.name).toBe("old");
    expect(runs.activeCount()).toBe(0);
  });
});

describe("background workflows: deadline extension (workflow-agent-queue §4.3, stage B)", () => {
  function extendable() {
    const c = controllable({ settleOnStop: true });
    const calls: Array<{ id: string; ms: number; reason?: string }> = [];
    let state = {
      startedAt: 0,
      softAt: 60_000,
      hardAt: 120_000,
      extensions: 0,
      grantedMs: 0,
      graces: 1,
      closed: false,
      stopping: false,
      graceUntil: 70_000,
    } as ReturnType<NonNullable<Orchestrator["deadline"]>> & object;
    const orch: Orchestrator = {
      ...c.orch,
      extend: (id, ms, opts) => {
        calls.push({ id, ms, ...(opts?.reason !== undefined ? { reason: opts.reason } : {}) });
        const { graceUntil: _g, ...rest } = state;
        state = { ...rest, softAt: 90_000, extensions: 1, grantedMs: 30_000 };
        return {
          ok: true,
          workflowId: id,
          previousDeadlineAt: 60_000,
          deadlineAt: 90_000,
          requestedMs: ms,
          grantedMs: 30_000,
          clamped: false,
          extensionsUsed: 1,
          extensionsRemaining: 1,
          hardDeadlineAt: 120_000,
          rescuedFromGrace: true,
        };
      },
      deadline: () => state,
    };
    return { c, orch, calls };
  }

  it("unknown → unknown_workflow; running → forwarded to the orchestrator; view reads the live deadline", async () => {
    const e = extendable();
    const { runs } = registry(() => e.orch);
    expect(runs.extend("wf_nope", 1_000)).toEqual({ ok: false, reason: "unknown_workflow" });
    const v = start(runs);
    const before = runs.get(v.workflowId)!;
    expect(before).toMatchObject({ deadlineAt: 60_000, graceUntil: 70_000, hardDeadlineAt: 120_000 });
    expect(before.extensions).toBeUndefined();
    const r = runs.extend(v.workflowId, 30_000, { reason: "why" });
    expect(r).toMatchObject({ ok: true, deadlineAt: 90_000, rescuedFromGrace: true });
    expect(e.calls).toEqual([{ id: v.workflowId, ms: 30_000, reason: "why" }]);
    const after = runs.get(v.workflowId)!;
    expect(after).toMatchObject({ deadlineAt: 90_000, hardDeadlineAt: 120_000, extensions: 1 });
    expect(after.graceUntil).toBeUndefined();
    e.c.release(
      outcome({
        diag: { ...outcome().diag, deadlineAt: 90_000, overtime: { graces: 1, extensions: 1, grantedMs: 30_000 } },
      }),
    );
    await runs.wait(v.workflowId, { waitMs: 1_000 });
    // Terminal: the outcome's (extended) deadline is frozen on the entry; extend refused.
    expect(runs.get(v.workflowId)).toMatchObject({ status: "completed", deadlineAt: 90_000, extensions: 1 });
    expect(runs.extend(v.workflowId, 1_000)).toEqual({ ok: false, reason: "already_terminal" });
    expect(e.calls).toHaveLength(1);
  });

  it("a requested stop → stopping (the orchestrator is not asked)", async () => {
    const e = extendable();
    const { runs } = registry(() => e.orch);
    const v = start(runs);
    const stopping = runs.stop(v.workflowId, "user_stop");
    expect(runs.extend(v.workflowId, 1_000)).toEqual({ ok: false, reason: "stopping" });
    await stopping;
    expect(e.calls).toEqual([]);
  });

  it("an orchestrator without extend() → unsupported; a throwing one degrades to unsupported", async () => {
    const plain = controllable({ settleOnStop: true });
    const { runs } = registry(() => plain.orch);
    const v = start(runs);
    expect(runs.extend(v.workflowId, 1_000)).toEqual({ ok: false, reason: "unsupported" });
    await runs.stop(v.workflowId, "user_stop");

    const throwing = controllable({ settleOnStop: true });
    const { runs: runs2 } = registry(() => ({
      ...throwing.orch,
      extend: () => {
        throw new Error("boom");
      },
    }));
    const v2 = start(runs2);
    expect(runs2.extend(v2.workflowId, 1_000)).toEqual({ ok: false, reason: "unsupported", detail: "boom" });
    await runs2.stop(v2.workflowId, "user_stop");
  });

  it("runBoundMs is measured from the static hard ceiling ceil(total × max(1, factor))", () => {
    const base = runBoundMs(LONG_BUDGET);
    expect(runBoundMs({ ...LONG_BUDGET, maxTotalFactor: 1 })).toBe(base);
    expect(runBoundMs({ ...LONG_BUDGET, maxTotalFactor: 0.5 })).toBe(base);
    expect(runBoundMs({ ...LONG_BUDGET, maxTotalFactor: 2 })).toBe(base + 60_000);
    expect(runBoundMs({ ...LONG_BUDGET, workflowTotalMs: 1_001, maxTotalFactor: 1.5 })).toBe(
      base - 60_000 + Math.ceil(1_001 * 1.5),
    );
  });
});
