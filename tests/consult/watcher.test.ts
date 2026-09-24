import { describe, expect, it, vi } from "vitest";
import type { RunDiagnostics, RunSnapshot } from "../../src/core/types.js";
import { createCapWatcher } from "../../src/consult/watcher.js";

/**
 * T-11 (consult plan §9): the cap watcher judges ONLY at turn boundaries —
 * `diag.lastTurnStartAt` changed and the run is not terminal. Costs crossing
 * the cap mid-turn (message_end) never abort, so a final answer that itself
 * crosses the cap survives as a complete outcome.
 */

function snap(opts: {
  runId?: string;
  status?: RunSnapshot["status"];
  lastTurnStartAt?: number;
  turns: number;
  costUsd?: number;
}): RunSnapshot {
  const diag: RunDiagnostics = {
    createdAt: 0,
    phase: "running",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: opts.turns,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...(opts.lastTurnStartAt !== undefined ? { lastTurnStartAt: opts.lastTurnStartAt } : {}),
    ...(opts.costUsd !== undefined
      ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: opts.costUsd } }
      : {}),
  };
  return {
    runId: opts.runId ?? "r_C",
    generation: 1,
    status: opts.status ?? "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag,
    updatedAt: 0,
  };
}

describe("consult/watcher: turn cap at turn boundaries only (T-11)", () => {
  it("fires turn_cap exactly once, on the maxTurns+1-th turn_start snapshot", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 3, maxCostUsd: 4, onCap });
    // turn1 start/end, turn2, turn3 end, then turn4 start.
    w.onSnapshot(snap({ lastTurnStartAt: 100, turns: 0 }));
    expect(onCap).not.toHaveBeenCalled();
    w.onSnapshot(snap({ lastTurnStartAt: 100, turns: 0, costUsd: 0.1 }));
    expect(onCap).not.toHaveBeenCalled();
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1 }));
    expect(onCap).not.toHaveBeenCalled();
    w.onSnapshot(snap({ lastTurnStartAt: 300, turns: 2 }));
    expect(onCap).not.toHaveBeenCalled();
    w.onSnapshot(snap({ lastTurnStartAt: 300, turns: 2, costUsd: 0.2 }));
    expect(onCap).not.toHaveBeenCalled();
    w.onSnapshot(snap({ lastTurnStartAt: 400, turns: 3 }));
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap).toHaveBeenCalledWith("turn_cap");
    expect(w.capReason).toBe("turn_cap");
    // Later snapshots never re-fire (idempotent).
    w.onSnapshot(snap({ lastTurnStartAt: 500, turns: 4 }));
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it("does not judge before the first observed turn_start", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 1, maxCostUsd: 0, onCap });
    w.onSnapshot(snap({ turns: 99, costUsd: 99 })); // no lastTurnStartAt yet
    expect(onCap).not.toHaveBeenCalled();
  });

  it("turn cap wins over cost cap when both would trip on the same boundary", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 1, maxCostUsd: 1, onCap });
    w.onSnapshot(snap({ lastTurnStartAt: 1, turns: 1, costUsd: 99 }));
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap).toHaveBeenCalledWith("turn_cap");
  });
});

describe("consult/watcher: cost cap only at the NEXT turn boundary (T-11)", () => {
  it("cost crossing during a turn (message_end) does not fire; the next turn_start does", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 3, maxCostUsd: 2, onCap });
    w.onSnapshot(snap({ lastTurnStartAt: 100, turns: 0, costUsd: 1.0 }));
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1, costUsd: 1.0 })); // turn 2 starts, cost still under
    expect(onCap).not.toHaveBeenCalled();
    // message_end inside turn 2 pushes cumulative cost over the cap — same
    // lastTurnStartAt ⇒ no judgment here.
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1, costUsd: 2.5 }));
    expect(onCap).not.toHaveBeenCalled();
    // turn 3 starting: turns=2 < 3, but 2.5 > 2 ⇒ cost_cap.
    w.onSnapshot(snap({ lastTurnStartAt: 300, turns: 2, costUsd: 2.5 }));
    expect(onCap).toHaveBeenCalledTimes(1);
    expect(onCap).toHaveBeenCalledWith("cost_cap");
    expect(w.capReason).toBe("cost_cap");
  });

  it("the final answer message crossing the cap never aborts: no further turn_start ⇒ no onCap", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 3, maxCostUsd: 2, onCap });
    w.onSnapshot(snap({ lastTurnStartAt: 100, turns: 0, costUsd: 1.0 }));
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1, costUsd: 1.0 })); // final turn starts under the cap
    // message_end crosses the cap, turn ends, run completes — no new turn_start.
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1, costUsd: 3.0 }));
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1, costUsd: 3.0, status: "completed" }));
    expect(onCap).not.toHaveBeenCalled();
    expect(w.capReason).toBeUndefined();
  });

  it("maxCostUsd = 0 disables the cost cap entirely", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 9, maxCostUsd: 0, onCap });
    for (let turn = 1; turn <= 5; turn++)
      w.onSnapshot(snap({ lastTurnStartAt: turn * 100, turns: turn - 1, costUsd: 999 }));
    expect(onCap).not.toHaveBeenCalled();
  });

  it("terminal snapshots never judge, even with a fresh lastTurnStartAt", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 1, maxCostUsd: 1, onCap });
    w.onSnapshot(snap({ status: "aborted", lastTurnStartAt: 100, turns: 5, costUsd: 99 }));
    expect(onCap).not.toHaveBeenCalled();
  });

  it("cost exactly at the cap does not trip (strictly greater than)", () => {
    const onCap = vi.fn();
    const w = createCapWatcher({ maxTurns: 5, maxCostUsd: 2, onCap });
    w.onSnapshot(snap({ lastTurnStartAt: 200, turns: 1, costUsd: 2 }));
    expect(onCap).not.toHaveBeenCalled();
  });
});
