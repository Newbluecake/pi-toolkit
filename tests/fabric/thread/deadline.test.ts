import { describe, expect, it } from "vitest";
import {
  computeEventDeadline,
  remainingBudgetMs,
  steerSpanMs,
  THREAD_MIN_STEER_SPAN_MS,
  THREAD_STEER_DEADLINE_RESERVE_MS,
} from "../../../src/fabric/thread/deadline.js";

describe("absolute steer deadline (§6.5, r3-4)", () => {
  it("reserves 1500 ms against the frame deadline and takes the min with steerTimeoutMs", () => {
    expect(THREAD_STEER_DEADLINE_RESERVE_MS).toBe(1500);
    // Feishu default deadlineMs=8000, default steerTimeoutMs=4000 ⇒ span 4000 (§6.5)
    expect(steerSpanMs(4000, 8000)).toBe(4000);
    expect(steerSpanMs(1000, 8000)).toBe(1000);
    expect(steerSpanMs(60_000, 8000)).toBe(6500);
  });

  it("R6 boundaries (S12): budget ≤ 0 or span < 500 ms ⇒ undefined", () => {
    expect(THREAD_MIN_STEER_SPAN_MS).toBe(500);
    expect(steerSpanMs(4000, 1500)).toBeUndefined(); // budget = min(4000, 0) = 0 ⇒ clampSpanMs undefined
    expect(steerSpanMs(4000, 1900)).toBeUndefined(); // span 400 < 500
    expect(steerSpanMs(4000, 1999)).toBeUndefined(); // span 499
    expect(steerSpanMs(4000, 2000)).toBe(500); // span exactly 500 — usable
    expect(steerSpanMs(400, 8000)).toBeUndefined(); // steerTimeoutMs floor itself under 500
    expect(steerSpanMs(500, 8000)).toBe(500);
  });

  it("degenerate inputs ⇒ undefined (clampSpanMs contract)", () => {
    expect(steerSpanMs(4000, Number.NaN)).toBeUndefined();
    expect(steerSpanMs(Number.NaN, 8000)).toBeUndefined();
    expect(steerSpanMs(4000, 0)).toBeUndefined();
    expect(steerSpanMs(4000, -100)).toBeUndefined();
  });

  it("huge budgets clamp to MAX_DEADLINE_SPAN_MS via the shared primitive", () => {
    expect(steerSpanMs(60_000, 1e15)).toBe(60_000);
  });

  it("computeEventDeadline anchors deadlineAt at receivedAt + span", () => {
    expect(computeEventDeadline(1_000, 4000, 8000)).toEqual({ span: 4000, deadlineAt: 5_000 });
    expect(computeEventDeadline(0, 1000, 2000)).toEqual({ span: 500, deadlineAt: 500 });
    expect(computeEventDeadline(1_000, 4000, 1900)).toBeUndefined();
  });

  it("remaining budget: ≤ 0 means do not call (§6.5 “剩余 ≤ 0 时不再发起调用”)", () => {
    expect(remainingBudgetMs(5000, 5000)).toBe(0);
    expect(remainingBudgetMs(5000, 4999)).toBe(1);
    expect(remainingBudgetMs(5000, 6000)).toBe(-1000);
  });
});
