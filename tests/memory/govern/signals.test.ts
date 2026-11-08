import { describe, expect, test } from "vitest";
import {
  budgetObservationKey,
  canMark,
  createGovernanceSignals,
  type BudgetObservation,
} from "../../../src/memory/govern/signals.js";

const allowed = { success: true, readOnly: false } as const;

function observation(over: boolean, overflow: boolean, budget = 2048): BudgetObservation {
  return {
    identity: { realpath: "/tmp/memory", dev: 1, ino: 2, migration: { gen: 3, runId: "run" } },
    stats: {
      corpusFingerprint: "corpus",
      localToday: "2026-11-08",
      policyVersion: "blocks-render-v1",
      resident: { inputFingerprint: "resident-input", usedBytes: over ? 4096 : 1024, budgetBytes: budget, over },
      index: { inputFingerprint: "index-input", limitBytes: 2048, omittedCount: overflow ? 1 : 0, over: overflow },
    },
  };
}

describe("session governance signals (unwired)", () => {
  test("deduplicates budget observations by signal kind and clears on a normal value", () => {
    const signals = createGovernanceSignals();
    const first = observation(true, true);
    signals.observeBudget(first);
    signals.observeBudget(first);
    const candidates = signals.consumeBudgets(first.identity, { external: false });
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["resident-over-budget", "index-overflow"]);
    expect(signals.consumeBudgets(first.identity, { external: false })).toEqual([]);
    expect(budgetObservationKey(first, "resident-over-budget")).not.toBe(
      budgetObservationKey(observation(true, true, 4096), "resident-over-budget"),
    );
    signals.observeBudget(observation(false, false));
    expect(signals.consumeBudgets(first.identity, { external: false })).toEqual([]);
  });

  test("sweep-origin observations stay dormant until an external opportunity", () => {
    const signals = createGovernanceSignals();
    const current = observation(true, true);
    signals.observeBudget(current, "sweep");
    expect(signals.consumeBudgets(current.identity, { external: false })).toEqual([]);
    expect(signals.consumeBudgets(current.identity, { external: true }).map((candidate) => candidate.kind)).toEqual([
      "resident-over-budget",
      "index-overflow",
    ]);
  });

  test("unknown observations do not clear the last known over-budget state", () => {
    const signals = createGovernanceSignals();
    const current = observation(true, false);
    signals.observeBudget(current);
    signals.observeBudget(undefined);
    expect(signals.consumeBudgets(current.identity, { external: false }).map((candidate) => candidate.kind)).toEqual([
      "resident-over-budget",
    ]);
  });
  test("coalesces all three kinds and duplicate marks into one consumption", () => {
    const signals = createGovernanceSignals();
    signals.markSignal("task-done", allowed);
    signals.markSignal("push", allowed);
    signals.markSignal("release", allowed);
    signals.markSignal("push", allowed);
    const consumed = [signals.consumeSignals({}), signals.consumeSignals({})].filter((value) => value !== undefined);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toEqual(["task-done", "push", "release"]);
  });

  test("failed and read-only events never mark pending signals", () => {
    const signals = createGovernanceSignals();
    for (const admission of [
      { success: false, readOnly: false },
      { success: true, readOnly: true },
      { success: false, readOnly: true },
    ]) {
      expect(canMark(admission)).toBe(false);
      signals.markSignal("push", admission);
    }
    expect(canMark(allowed)).toBe(true);
    expect(signals.consumeSignals({})).toBeUndefined();
  });

  test("abort clears pending but permits a subsequent turn", () => {
    const signals = createGovernanceSignals();
    signals.markSignal("push", allowed);
    signals.abort();
    expect(signals.consumeSignals({})).toBeUndefined();
    signals.markSignal("release", allowed);
    expect(signals.consumeSignals({})).toEqual(["release"]);
  });

  test("aborted turn_end clears pending without consumption", () => {
    const signals = createGovernanceSignals();
    const controller = new AbortController();
    signals.markSignal("push", allowed);
    controller.abort();
    expect(signals.consumeSignals({ signal: controller.signal })).toBeUndefined();
    expect(signals.consumeSignals({})).toBeUndefined();
  });

  test("repeated turn_end does not consume twice", () => {
    const signals = createGovernanceSignals();
    signals.markSignal("task-done", allowed);
    expect(signals.consumeSignals({})).toEqual(["task-done"]);
    expect(signals.consumeSignals({})).toBeUndefined();
    expect(signals.consumeSignals({})).toBeUndefined();
  });

  test("sessions have independent pending and lifecycle state", () => {
    const a = createGovernanceSignals();
    const b = createGovernanceSignals();
    a.markSignal("push", allowed);
    b.markSignal("release", allowed);
    a.abort();
    expect(a.consumeSignals({})).toBeUndefined();
    expect(b.consumeSignals({})).toEqual(["release"]);
    b.markSignal("task-done", allowed);
    a.dispose();
    expect(b.consumeSignals({})).toEqual(["task-done"]);
  });

  test.each(["session end", "reload"])("dispose on %s clears and permanently closes the instance", () => {
    const signals = createGovernanceSignals();
    signals.markSignal("push", allowed);
    signals.dispose();
    signals.markSignal("release", allowed);
    expect(signals.consumeSignals({})).toBeUndefined();
    signals.dispose();
    expect(signals.consumeSignals({})).toBeUndefined();
  });
});
