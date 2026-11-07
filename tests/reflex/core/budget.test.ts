/**
 * R1 · budget (plan R1 step 1): constants + raceBudget on FakeClock — budget boundary,
 * REFLEX_BUDGET_MS clamp, invalid budgets, timer hygiene, abort, rejection swallowing.
 */
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../../src/core/clock.js";
import {
  CORRECTION_WINDOW_MS,
  DEMOTE_AFTER_STRIKES,
  MAX_ANSWER_BYTES,
  MAX_ANSWER_LINES,
  MAX_INPUT_CHARS,
  PENDING_MAX_AGE_MS,
  REFLEX_BUDGET_MS,
  REPEAT_WINDOW_MS,
  raceBudget,
} from "../../../src/reflex/core/budget.js";

describe("budget constants (U4 / plan R1 step 1)", () => {
  it("pins the frozen values", () => {
    expect(REFLEX_BUDGET_MS).toBe(1200);
    expect(MAX_INPUT_CHARS).toBe(120);
    expect(REPEAT_WINDOW_MS).toBe(600_000);
    expect(CORRECTION_WINDOW_MS).toBe(90_000);
    expect(DEMOTE_AFTER_STRIKES).toBe(2);
    expect(MAX_ANSWER_LINES).toBe(24);
    expect(MAX_ANSWER_BYTES).toBe(2048);
    expect(PENDING_MAX_AGE_MS).toBe(REPEAT_WINDOW_MS);
  });
});

describe("raceBudget", () => {
  it("returns the value when p settles before the timer fires", async () => {
    const clock = new FakeClock(0);
    const p = new Promise<number>((resolve) => clock.setTimer(1199, () => resolve(7)));
    const raced = raceBudget(p, 1200, clock);
    clock.advance(1199); // resolve timer fires, budget timer not yet due
    await expect(raced).resolves.toBe(7);
    expect(clock.pendingTimers).toBe(0);
  });

  it("returns a microtask-settled value without any clock advance", async () => {
    const clock = new FakeClock(0);
    const p = new Promise<number>((resolve) => queueMicrotask(() => resolve(9)));
    const raced = raceBudget(p, 1200, clock);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(raced).resolves.toBe(9);
    expect(clock.pendingTimers).toBe(0);
  });

  it("times out exactly at the budget (U4 1200ms boundary)", async () => {
    const clock = new FakeClock(0);
    const never = new Promise<number>(() => {});
    const raced = raceBudget(never, 1200, clock);
    clock.advance(1199);
    const probe: string[] = [];
    raced.then(() => probe.push("settled"));
    await Promise.resolve();
    expect(probe).toEqual([]); // 1199ms: not yet
    clock.advance(1);
    await expect(raced).resolves.toEqual({ kind: "timeout" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("clamps budgets above REFLEX_BUDGET_MS to 1200", async () => {
    const clock = new FakeClock(0);
    const late = new Promise<number>((resolve) => clock.setTimer(1300, () => resolve(7)));
    const raced = raceBudget(late, 5000, clock);
    clock.advance(5000);
    await expect(raced).resolves.toEqual({ kind: "timeout" });
  });

  it("invalid budgets (0 / negative / NaN) resolve to timeout immediately, no timer armed", async () => {
    const clock = new FakeClock(0);
    const never = new Promise<number>(() => {});
    for (const bad of [0, -5, Number.NaN]) {
      await expect(raceBudget(never, bad, clock)).resolves.toEqual({ kind: "timeout" });
    }
    expect(clock.pendingTimers).toBe(0);
  });

  it("clears the timer on settlement (no dangling timers)", async () => {
    const clock = new FakeClock(0);
    const raced = raceBudget(Promise.resolve("ok"), 1200, clock);
    await expect(raced).resolves.toBe("ok");
    expect(clock.pendingTimers).toBe(0);
  });

  it("a pre-aborted signal resolves to timeout without arming", async () => {
    const clock = new FakeClock(0);
    const never = new Promise<number>(() => {});
    const controller = new AbortController();
    controller.abort();
    await expect(raceBudget(never, 1200, clock, controller.signal)).resolves.toEqual({ kind: "timeout" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("an abort mid-race settles as timeout and clears the timer", async () => {
    const clock = new FakeClock(0);
    const controller = new AbortController();
    const never = new Promise<number>(() => {});
    const raced = raceBudget(never, 1200, clock, controller.signal);
    controller.abort();
    await expect(raced).resolves.toEqual({ kind: "timeout" });
    expect(clock.pendingTimers).toBe(0);
  });

  it("swallows an early rejection into a timeout (never hangs, never throws)", async () => {
    const clock = new FakeClock(0);
    const raced = raceBudget(Promise.reject<number>(new Error("boom")), 1200, clock);
    await expect(raced).resolves.toEqual({ kind: "timeout" });
  });

  it("swallows a LATE rejection after the timeout fired (no unhandled rejection)", async () => {
    const clock = new FakeClock(0);
    const late = new Promise<number>((_, reject) => clock.setTimer(2000, () => reject(new Error("late"))));
    const raced = raceBudget(late, 100, clock);
    clock.advance(100);
    await expect(raced).resolves.toEqual({ kind: "timeout" });
    clock.advance(2000); // fires the rejection into the attached catch
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("a clock whose setTimer throws settles as timeout (broken-clock safety)", async () => {
    const clock = new FakeClock(0);
    const broken = {
      now: clock.now.bind(clock),
      setTimer: (): never => {
        throw new Error("broken clock");
      },
      clearTimer: clock.clearTimer.bind(clock),
    };
    const raced = raceBudget(new Promise<number>(() => {}), 1200, broken);
    await expect(raced).resolves.toEqual({ kind: "timeout" });
  });
});
