import { describe, expect, it } from "vitest";
import { loadSettings, mergeBudget } from "../../src/config/settings.js";
import { DEFAULT_BUDGET, dueAtFor } from "../../src/core/deadline.js";
import type { RunDiagnostics } from "../../src/core/types.js";

const diag: RunDiagnostics = {
  createdAt: 0,
  phase: "model_turn",
  phaseEnteredAt: 1_000,
  lastEventAt: 1_000,
  pendingTools: 0,
  turns: 0,
  escalation: [],
  orphaned: false,
  generation: 1,
  degraded: [],
  staleInputs: 0,
  unkillable: [],
};

describe("model progress defaults", () => {
  it("defaults and normalized settings use 1200 seconds without changing other phase budgets", () => {
    expect(DEFAULT_BUDGET).toMatchObject({
      idleMs: 1_200_000,
      modelTurnMs: 1_200_000,
      toolMs: 600_000,
      totalMs: 1_800_000,
      totalGraceMs: 600_000,
    });
    expect(loadSettings({}).budget).toMatchObject({ idleMs: 1_200_000, modelTurnMs: 1_200_000 });
    expect(loadSettings({ budget: { idleS: -1, modelTurnS: "bad" } }).budget).toMatchObject({
      idleMs: 1_200_000,
      modelTurnMs: 1_200_000,
    });
    expect(loadSettings({ budget: { idleS: 600, modelTurnS: 1800 } }).budget).toMatchObject({
      idleMs: 600_000,
      modelTurnMs: 1_800_000,
    });
    expect(mergeBudget({ idleMs: 600_000 }, { modelTurnMs: 300_000 })).toMatchObject({
      idleMs: 600_000,
      modelTurnMs: 300_000,
    });
  });
  it("uses the earlier silence or model-turn deadline, including explicit values and zero", () => {
    expect(dueAtFor("model_turn", diag, DEFAULT_BUDGET)).toBe(1_201_000);
    expect(dueAtFor("model_turn", { ...diag, lastEventAt: 601_000 }, DEFAULT_BUDGET)).toBe(1_201_000);
    expect(dueAtFor("model_turn", diag, { ...DEFAULT_BUDGET, idleMs: 600_000, modelTurnMs: 1_800_000 })).toBe(601_000);
    expect(dueAtFor("model_turn", diag, { ...DEFAULT_BUDGET, idleMs: 0, modelTurnMs: 0 })).toBeUndefined();
    expect(dueAtFor("tool_exec", diag, DEFAULT_BUDGET)).toBe(601_000);
  });
});
