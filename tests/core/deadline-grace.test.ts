import { describe, expect, it } from "vitest";
import {
  applyBudgetPolicy,
  clampSpanMs,
  DEFAULT_BUDGET,
  describeTimeout,
  effectiveDeadlineAt,
  extendability,
  graceWindow,
  hardDeadlineAtFor,
  MAX_DEADLINE_SPAN_MS,
  OVERTIME_PHASES,
} from "../../src/core/deadline.js";
import { isTerminalStatus, TERMINAL_STATUSES } from "../../src/core/status.js";
import type { DeadlineBudget, RunDiagnostics, RunState } from "../../src/core/types.js";

const budget: DeadlineBudget = { ...DEFAULT_BUDGET };

/** 最小 RunState fixture：extendability/graceWindow 只读 status/phase/deadlines/diag.overtime。 */
function state(overrides: {
  status?: RunState["status"];
  phase?: RunState["phase"];
  deadlines?: Partial<RunState["deadlines"]>;
  extensions?: number;
}): RunState {
  return {
    runId: "r1",
    generation: 1,
    status: overrides.status ?? "running",
    phase: overrides.phase ?? "model_turn",
    deadlines: {
      enqueuedAt: 0,
      deadlineAt: 100_000,
      queueDeadlineAt: undefined,
      hardDeadlineAt: 200_000,
      ...overrides.deadlines,
    },
    diag: {
      createdAt: 0,
      phase: overrides.phase ?? "model_turn",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(overrides.extensions === undefined
        ? {}
        : { overtime: { graces: 0, extensions: overrides.extensions, grantedMs: 0 } }),
    },
    armedTimers: [],
    slotHeld: true,
    effectSeq: 0,
    persistRetryCount: 0,
  };
}

describe("core/status: terminal status single source (D-15)", () => {
  it("classifies exactly the four terminal statuses", () => {
    for (const s of ["completed", "failed", "timed_out", "aborted"] as const) expect(isTerminalStatus(s)).toBe(true);
    for (const s of ["queued", "starting", "running", "stopping"] as const)
      expect(TERMINAL_STATUSES.has(s as never)).toBe(false);
  });
});

describe("core/deadline: hardDeadlineAtFor", () => {
  it("is enqueuedAt + ceil(totalMs * factor) without a cap", () => {
    expect(hardDeadlineAtFor(1_000, { ...budget, totalMs: 100, maxTotalFactor: 2 }, undefined)).toBe(1_200);
  });
  it("treats factor < 1 as 1", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: 0.5 }, undefined)).toBe(100);
  });
  it("a tighter SpawnRequest.deadlineAt cap wins", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: 3 }, 150)).toBe(150);
  });
  it("a looser cap does not loosen the factor ceiling", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: 2 }, 999_999)).toBe(200);
  });
  it("totalMs <= 0 is a defensive undefined (config layer forbids it, D-11)", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 0 }, undefined)).toBeUndefined();
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: -5 }, undefined)).toBeUndefined();
  });

  // F1（§3.3 G1）：跨度钳位与非有限 factor 降级——core 层安全降级，不拒绝。
  it("F1: spans clamp to MAX_DEADLINE_SPAN_MS; non-finite factor degrades to 1; NaN/−1/0 totalMs are undefined", () => {
    // 1e308 × 2 溢出为 Infinity ⇒ 钳到 365 天
    const huge = hardDeadlineAtFor(1_000, { ...budget, totalMs: 1e308, maxTotalFactor: 2 }, undefined);
    expect(huge).toBe(1_000 + MAX_DEADLINE_SPAN_MS);
    // 恰好超限的有限值同样被钳
    const over = hardDeadlineAtFor(0, { ...budget, totalMs: MAX_DEADLINE_SPAN_MS + 1, maxTotalFactor: 1 }, undefined);
    expect(over).toBe(MAX_DEADLINE_SPAN_MS);
    // 非有限 factor ⇒ 降级 1（更紧），不是 NaN/Infinity
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: Infinity }, undefined)).toBe(100);
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: NaN }, undefined)).toBe(100);
    // totalMs 非法 ⇒ undefined（防御语义保留）
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: NaN }, undefined)).toBeUndefined();
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: -1 }, undefined)).toBeUndefined();
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 0 }, undefined)).toBeUndefined();
    // +Infinity 的 totalMs 是「无界」信号 ⇒ 钳到上限（不产出 Infinity 截止）
    expect(hardDeadlineAtFor(5, { ...budget, totalMs: Infinity, maxTotalFactor: 2 }, undefined)).toBe(
      5 + MAX_DEADLINE_SPAN_MS,
    );
  });

  it("F1: clampSpanMs boundary table (NaN/0/negative → undefined; finite → min(ms, MAX); +Infinity → MAX)", () => {
    expect(clampSpanMs(NaN)).toBeUndefined();
    expect(clampSpanMs(0)).toBeUndefined();
    expect(clampSpanMs(-1)).toBeUndefined();
    expect(clampSpanMs(-Infinity)).toBeUndefined();
    expect(clampSpanMs(1)).toBe(1);
    expect(clampSpanMs(MAX_DEADLINE_SPAN_MS)).toBe(MAX_DEADLINE_SPAN_MS);
    expect(clampSpanMs(MAX_DEADLINE_SPAN_MS + 1)).toBe(MAX_DEADLINE_SPAN_MS);
    expect(clampSpanMs(1e308)).toBe(MAX_DEADLINE_SPAN_MS);
    expect(clampSpanMs(Infinity)).toBe(MAX_DEADLINE_SPAN_MS);
  });
});

describe("core/deadline: applyBudgetPolicy (D-10/D-16, §2.2)", () => {
  it("fixedDeadline clamps maxTotalFactor to 1", () => {
    const out = applyBudgetPolicy(budget, { fixedDeadline: true, extensionsEnabled: true });
    expect(out.maxTotalFactor).toBe(1);
    expect(out.maxExtensions).toBe(budget.maxExtensions);
  });
  it("extensionsEnabled=false clamps maxExtensions to 0", () => {
    const out = applyBudgetPolicy(budget, { fixedDeadline: false, extensionsEnabled: false });
    expect(out.maxExtensions).toBe(0);
    expect(out.maxTotalFactor).toBe(budget.maxTotalFactor);
  });
  it("both flags combine", () => {
    const out = applyBudgetPolicy(budget, { fixedDeadline: true, extensionsEnabled: false });
    expect(out).toMatchObject({ maxTotalFactor: 1, maxExtensions: 0 });
  });
  it("neither flag returns the budget untouched", () => {
    expect(applyBudgetPolicy(budget, { fixedDeadline: false, extensionsEnabled: true })).toBe(budget);
  });
});

describe("core/deadline: effectiveDeadlineAt", () => {
  it("prefers graceUntil over deadlineAt", () => {
    expect(effectiveDeadlineAt({ enqueuedAt: 0, deadlineAt: 100, queueDeadlineAt: undefined, graceUntil: 150 })).toBe(
      150,
    );
    expect(effectiveDeadlineAt({ enqueuedAt: 0, deadlineAt: 100, queueDeadlineAt: undefined })).toBe(100);
    expect(effectiveDeadlineAt({ enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined })).toBeUndefined();
  });
});

describe("core/deadline: extendability", () => {
  it("ok with headroom for an overtime phase under the ceiling", () => {
    const verdict = extendability(state({}), budget, 50_000);
    expect(verdict).toEqual({ ok: true, headroomMs: 100_000 });
  });
  it("already_terminal for each terminal status", () => {
    for (const status of ["completed", "failed", "timed_out", "aborted"] as const) {
      expect(extendability(state({ status }), budget, 0)).toEqual({ ok: false, reason: "already_terminal" });
    }
  });
  it("stopping in abort_grace / reap", () => {
    expect(extendability(state({ phase: "abort_grace" }), budget, 0)).toEqual({ ok: false, reason: "stopping" });
    expect(extendability(state({ phase: "reap" }), budget, 0)).toEqual({ ok: false, reason: "stopping" });
  });
  it("not_started for the four startup phases (D-14)", () => {
    for (const phase of ["queue_wait", "resolve_config", "session_create", "extension_bind"] as const) {
      expect(extendability(state({ phase }), budget, 0)).toEqual({ ok: false, reason: "not_started" });
    }
    for (const phase of OVERTIME_PHASES) {
      expect(extendability(state({ phase }), budget, 0).ok).toBe(true);
    }
  });
  it("uncapped when deadlineAt/hardDeadlineAt is missing (defensive)", () => {
    expect(extendability(state({ deadlines: { deadlineAt: undefined } }), budget, 0)).toEqual({
      ok: false,
      reason: "uncapped",
    });
    expect(extendability(state({ deadlines: { hardDeadlineAt: undefined } }), budget, 0)).toEqual({
      ok: false,
      reason: "uncapped",
    });
  });
  it("limit_reached once extensions are exhausted", () => {
    expect(extendability(state({ extensions: budget.maxExtensions }), budget, 0)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
  });
  it("no_headroom at/past the ceiling — including explicit-budget runs (H = deadlineAt, D-10)", () => {
    expect(extendability(state({}), budget, 200_000)).toEqual({ ok: false, reason: "no_headroom" });
    expect(extendability(state({ deadlines: { deadlineAt: 100_000, hardDeadlineAt: 100_000 } }), budget, 0)).toEqual({
      ok: false,
      reason: "no_headroom",
    });
  });
});

describe("core/deadline: graceWindow", () => {
  it("is at + totalGraceMs clamped to the hard ceiling (D-7)", () => {
    const b = { ...budget, totalGraceMs: 90_000 };
    expect(graceWindow(state({}), b, 100_000)).toBe(190_000);
    expect(graceWindow(state({}), b, 150_000)).toBe(200_000);
  });
  it("undefined when totalGraceMs = 0 (grace off)", () => {
    expect(graceWindow(state({}), { ...budget, totalGraceMs: 0 }, 100_000)).toBeUndefined();
  });
  it("undefined when extensions are already exhausted (D-6)", () => {
    expect(graceWindow(state({ extensions: 3 }), budget, 100_000)).toBeUndefined();
  });
  it("undefined when maxExtensions = 0", () => {
    expect(graceWindow(state({}), { ...budget, maxExtensions: 0 }, 100_000)).toBeUndefined();
  });
  it("undefined at the hard ceiling (until must be > at)", () => {
    expect(graceWindow(state({}), budget, 200_000)).toBeUndefined();
  });
  it("undefined for explicit-budget runs (maxTotalFactor = 1 ⇒ H = deadlineAt, D-10)", () => {
    // 显式预算 run：deadlineAt 与 hardDeadlineAt 同为 enqueuedAt + totalMs ⇒ 无宽限窗口
    const s = state({ deadlines: { deadlineAt: 100_000, hardDeadlineAt: 100_000 } });
    expect(graceWindow(s, budget, 100_000)).toBeUndefined();
  });
  it("undefined outside overtime phases (D-14)", () => {
    expect(graceWindow(state({ phase: "queue_wait" }), budget, 100_000)).toBeUndefined();
  });
});

describe("describeTimeout", () => {
  const diag = (patch: Partial<RunDiagnostics>): RunDiagnostics =>
    ({
      ...state({}).diag,
      phaseEnteredAt: 0,
      deadlineAt: 100_000,
      hardDeadlineAt: 200_000,
      ...patch,
    }) as RunDiagnostics;
  it("tool watchdog: names the stuck tool and how long it ran", () => {
    const d = diag({ timeoutReason: "idle", currentTool: { name: "bash", toolCallId: "c", startedAt: 1_000 } });
    expect(describeTimeout(d, 601_000)).toBe('tool "bash" still running after 10m00s (budget.toolS)');
  });
  it("idle without a tool: silence measured from the last event", () => {
    expect(describeTimeout(diag({ timeoutReason: "idle", lastEventAt: 5_000 }), 605_000)).toBe(
      "no model progress for 10m00s (budget.idleS / budget.modelTurnS)",
    );
  });
  it("total: reads diag.timeoutPolicy — fixed / extendable-at-ceiling / after-grace / absent", () => {
    // fixed 策略 ⇒ fixed-deadline 变体（不再看 H === D0 形状）
    expect(describeTimeout(diag({ timeoutReason: "total", timeoutPolicy: "fixed" }), 100_000)).toBe(
      "total budget exceeded (fixed deadline: no grace window)",
    );
    // extendable 但无 headroom（factor 1 / 绝对截止触顶）⇒ no-headroom 变体
    expect(
      describeTimeout(diag({ timeoutReason: "total", timeoutPolicy: "extendable", hardDeadlineAt: 100_000 }), 100_000),
    ).toBe("total budget exceeded (no headroom above the deadline: no grace window)");
    // extendable 且 H > D0 ⇒ 普通文案；旧条目缺字段（升级前）⇒ 中性文案
    expect(describeTimeout(diag({ timeoutReason: "total", timeoutPolicy: "extendable" }), 100_000)).toBe(
      "total budget exceeded",
    );
    expect(describeTimeout(diag({ timeoutReason: "total" }), 100_000)).toBe("total budget exceeded");
    const overtime = { graces: 1, extensions: 0, grantedMs: 0 };
    expect(describeTimeout(diag({ timeoutReason: "total", overtime }), 190_000)).toBe(
      "total budget exceeded after grace",
    );
  });

  it("U1 regression lock: H === D0 with policy extendable never yields the fixed-deadline text (no shape inference)", () => {
    const d = diag({
      timeoutReason: "total",
      timeoutPolicy: "extendable",
      deadlineAt: 100_000,
      hardDeadlineAt: 100_000, // H === D0 — the shape the old heuristic keyed on
    });
    expect(describeTimeout(d, 100_000)).not.toContain("fixed deadline");
    expect(describeTimeout(d, 100_000)).not.toContain("hard cap");
    expect(describeTimeout(d, 100_000)).toBe("total budget exceeded (no headroom above the deadline: no grace window)");
    // 字段缺席时同一形状也回到中性文案（旧 run 不做任何成因声称）
    const legacy = diag({ timeoutReason: "total", deadlineAt: 100_000, hardDeadlineAt: 100_000 });
    expect(legacy).not.toHaveProperty("timeoutPolicy");
    expect(describeTimeout(legacy, 100_000)).toBe("total budget exceeded");
  });
  it("other reasons and the unknown fallback", () => {
    expect(describeTimeout(diag({ timeoutReason: "compaction" }), 1)).toBe("compaction exceeded budget.compactionS");
    expect(describeTimeout(diag({ timeoutReason: "no_first_event" }), 1)).toBe(
      "no first model event (budget.firstEventS)",
    );
    expect(describeTimeout(diag({}), 1)).toBe("deadline exceeded");
  });
});
