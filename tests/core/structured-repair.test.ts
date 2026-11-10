import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import {
  STRUCTURED_REPAIR_DEFAULTS,
  STRUCTURED_REPAIR_PROMPT,
  phaseDueAt,
  structuredRepairCloseAt,
  structuredRepairSuffix,
  structuredRepairWindow,
} from "../../src/core/structured-repair.js";
import type { DeadlineBudget, RunDeadlines, RunDiagnostics, RunPhase } from "../../src/core/types.js";

/**
 * Structured-output repair turn (structured-output-repair-plan.md §3.1): the
 * pure window/close/suffix arithmetic of src/core/structured-repair.ts.
 */

function diag(partial: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...partial,
  };
}

function deadlines(partial: Partial<RunDeadlines> = {}): RunDeadlines {
  return { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined, ...partial };
}

describe("core/structured-repair: phaseDueAt", () => {
  it("model_turn takes min(lastEvent+idle, entered+modelTurn) per budget, and the earliest across budgets", () => {
    const d = diag({ phaseEnteredAt: 1_000, lastEventAt: 21_000 });
    const runBudget: DeadlineBudget = { ...DEFAULT_BUDGET, idleMs: 100_000, modelTurnMs: 900_000 };
    // run budget alone: min(21s+100s, 1s+900s) = 121s.
    expect(phaseDueAt("model_turn", d, [runBudget])).toBe(121_000);
    // watchdog with a shorter idle: min(21s+30s, 1s+900s) = 51s wins overall.
    const watchdogBudget: DeadlineBudget = { ...DEFAULT_BUDGET, idleMs: 30_000, modelTurnMs: 900_000 };
    expect(phaseDueAt("model_turn", d, [runBudget, watchdogBudget])).toBe(51_000);
    // and a shorter hard cap wins inside one budget: entered+cap = 1s+40s.
    expect(phaseDueAt("model_turn", d, [{ ...runBudget, modelTurnMs: 40_000 }])).toBe(41_000);
  });

  it("tool_exec / compaction phase dues come from phaseEnteredAt + toolMs / compactionMs", () => {
    const d = diag({ phase: "tool_exec", phaseEnteredAt: 10_000, lastEventAt: 12_000 });
    expect(phaseDueAt("tool_exec", d, [{ ...DEFAULT_BUDGET, toolMs: 10_000 }])).toBe(20_000);
    const c = diag({ phase: "compaction", phaseEnteredAt: 10_000, lastEventAt: 12_000 });
    expect(phaseDueAt("compaction", c, [{ ...DEFAULT_BUDGET, compactionMs: 12_000 }])).toBe(22_000);
  });

  it("retry_backoff uses idleDueAt (idle + retry delay + slack)", () => {
    const d = diag({
      phase: "retry_backoff",
      phaseEnteredAt: 10_000,
      lastEventAt: 20_000,
      retry: { attempt: 1, maxAttempts: 3, delayMs: 4_000, startedAt: 20_000 },
    });
    expect(phaseDueAt("retry_backoff", d, [DEFAULT_BUDGET])).toBe(
      20_000 + DEFAULT_BUDGET.idleMs + 4_000 + DEFAULT_BUDGET.retrySlackMs,
    );
  });

  it.each(["queue_wait", "session_create", "extension_bind", "abort_grace", "reap"] as RunPhase[])(
    "non-OVERTIME phase %s returns undefined",
    (phase) => {
      expect(phaseDueAt(phase, diag({ phase }), [DEFAULT_BUDGET])).toBeUndefined();
    },
  );
});

describe("core/structured-repair: structuredRepairWindow", () => {
  const limits = STRUCTURED_REPAIR_DEFAULTS;

  it("a run inside its grace window is never repaired (skipped_grace)", () => {
    const r = structuredRepairWindow({
      now: 100,
      deadlines: deadlines({ deadlineAt: 50, graceUntil: 500 }),
      phaseDue: undefined,
      limits,
    });
    expect(r).toEqual({ skip: "skipped_grace" });
  });

  it("19s before the deadline leaves 14s (< minRemaining) — skipped_budget", () => {
    const r = structuredRepairWindow({
      now: 1_000,
      deadlines: deadlines({ deadlineAt: 20_000 }),
      phaseDue: undefined,
      limits,
    });
    expect(r).toEqual({ skip: "skipped_budget" });
  });

  it("default budget, model_turn already consumed 1150s of 1200s → window is exactly the remaining 45s", () => {
    const now = 1_000_000;
    const d = diag({ phaseEnteredAt: now - 1_150_000, lastEventAt: now });
    const r = structuredRepairWindow({
      now,
      deadlines: deadlines({ deadlineAt: now + 600_000 }),
      phaseDue: phaseDueAt("model_turn", d, [DEFAULT_BUDGET]),
      limits,
    });
    // phaseDue = min(now+1200s, entered+1200s = now+50s) = now+50s; 50s − 5s tail = 45s.
    expect(r).toEqual({ dueAt: now + 45_000 });
  });

  it("default budget, model_turn already consumed 1190s → only 5s left (< 15s) — skipped_budget", () => {
    const now = 1_000_000;
    const d = diag({ phaseEnteredAt: now - 1_190_000, lastEventAt: now });
    const r = structuredRepairWindow({
      now,
      deadlines: deadlines({ deadlineAt: now + 600_000 }),
      phaseDue: phaseDueAt("model_turn", d, [DEFAULT_BUDGET]),
      limits,
    });
    expect(r).toEqual({ skip: "skipped_budget" });
  });

  it("idleMs = 20s leaves available = 15s — passes exactly at the threshold", () => {
    const now = 5_000;
    const d = diag({ phaseEnteredAt: now - 1_000, lastEventAt: now });
    const r = structuredRepairWindow({
      now,
      deadlines: deadlines({ deadlineAt: now + 600_000 }),
      phaseDue: phaseDueAt("model_turn", d, [{ ...DEFAULT_BUDGET, idleMs: 20_000 }]),
      limits,
    });
    expect(r).toEqual({ dueAt: now + 15_000 });
  });

  it("an uncapped run (no deadlineAt, no phase due) gets the plain maxMs window", () => {
    const r = structuredRepairWindow({ now: 7_000, deadlines: deadlines(), phaseDue: undefined, limits });
    expect(r).toEqual({ dueAt: 7_000 + limits.maxMs });
  });

  it("NaN inputs fall into skipped_budget (never a NaN window)", () => {
    const r = structuredRepairWindow({
      now: Number.NaN,
      deadlines: deadlines({ deadlineAt: 10_000 }),
      phaseDue: undefined,
      limits,
    });
    expect(r).toEqual({ skip: "skipped_budget" });
    const r2 = structuredRepairWindow({
      now: 0,
      deadlines: deadlines({ deadlineAt: Number.NaN }),
      phaseDue: undefined,
      limits,
    });
    expect(r2).toEqual({ skip: "skipped_budget" });
  });
});

describe("core/structured-repair: structuredRepairCloseAt", () => {
  it("is the min of windowDueAt, effective deadline − tail and phase due − tail", () => {
    const deadlinesWithGrace = deadlines({ deadlineAt: 100_000, graceUntil: 400_000 });
    expect(
      structuredRepairCloseAt({ windowDueAt: 50_000, deadlines: deadlinesWithGrace, phaseDue: 70_000, tailMs: 5_000 }),
    ).toBe(50_000); // window smallest
    expect(
      structuredRepairCloseAt({ windowDueAt: 500_000, deadlines: deadlinesWithGrace, phaseDue: 70_000, tailMs: 5_000 }),
    ).toBe(65_000); // phaseDue − tail smallest; graceUntil wins over deadlineAt as effective
    expect(
      structuredRepairCloseAt({
        windowDueAt: 500_000,
        deadlines: deadlinesWithGrace,
        phaseDue: 900_000,
        tailMs: 5_000,
      }),
    ).toBe(395_000); // effective deadline (grace) − tail smallest
  });

  it("ignores absent bounds (undefined deadline / phase due)", () => {
    expect(
      structuredRepairCloseAt({ windowDueAt: 50_000, deadlines: deadlines(), phaseDue: undefined, tailMs: 5_000 }),
    ).toBe(50_000);
    expect(
      structuredRepairCloseAt({
        windowDueAt: 50_000,
        deadlines: deadlines({ deadlineAt: 20_000 }),
        phaseDue: undefined,
        tailMs: 5_000,
      }),
    ).toBe(15_000);
    expect(
      structuredRepairCloseAt({ windowDueAt: 50_000, deadlines: deadlines(), phaseDue: 12_000, tailMs: 5_000 }),
    ).toBe(7_000);
  });
});

describe("core/structured-repair: prompt + suffix", () => {
  it("REPAIR_PROMPT is pure ASCII, names StructuredOutput, forbids redoing the task", () => {
    expect(STRUCTURED_REPAIR_PROMPT).toMatch(/^[\x00-\x7F]*$/);
    expect(STRUCTURED_REPAIR_PROMPT).toContain("StructuredOutput");
    expect(STRUCTURED_REPAIR_PROMPT).toContain("Do not redo");
    expect(STRUCTURED_REPAIR_PROMPT).not.toMatch(/[§]|architecture/);
  });

  it("suffix mapping matches plan §1j exactly", () => {
    expect(structuredRepairSuffix("attempted")).toBe(" (after one repair turn)");
    expect(structuredRepairSuffix("skipped_budget")).toBe(
      " (repair turn skipped: not enough time left before a deadline)",
    );
    expect(structuredRepairSuffix("skipped_grace")).toBe(" (repair turn skipped: run is past its deadline)");
    expect(structuredRepairSuffix("skipped_tool")).toBe("");
    expect(structuredRepairSuffix("skipped_phase")).toBe("");
    expect(structuredRepairSuffix(undefined)).toBe("");
  });

  it("defaults match plan §1b (15s / 120s / 5s / 3 turns)", () => {
    expect(STRUCTURED_REPAIR_DEFAULTS).toEqual({
      minRemainingMs: 15_000,
      maxMs: 120_000,
      tailMs: 5_000,
      maxTurns: 3,
    });
  });
});
