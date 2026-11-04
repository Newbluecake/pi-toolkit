import { describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock } from "../../../src/core/clock.js";
import * as budget from "../../../src/reflex/core/budget.js";
import { executePort } from "../../../src/reflex/ports/index.js";
import type { ReflexPort } from "../../../src/reflex/ports/index.js";
import type { PortOutcome } from "../../../src/reflex/core/types.js";
import { env } from "./helpers.js";
const ok: PortOutcome = { kind: "ok", lines: [], facts: {}, truncated: false };
const port = (run: ReflexPort["run"]): ReflexPort => ({ id: "jobs.list", version: 1, run });

describe("executePort", () => {
  it("returns real synchronous/asynchronous outcomes and clears timers", async () => {
    for (const outcome of [
      ok,
      { kind: "uncertain", reason: "missing" },
      { kind: "unavailable", reason: "off" },
      { kind: "error", reason: "parse" },
    ] as PortOutcome[]) {
      const clock = new FakeClock();
      expect(
        await executePort(
          port(() => outcome),
          env(),
          clock,
        ),
      ).toEqual(outcome);
      expect(clock.pendingTimers).toBe(0);
      expect(
        await executePort(
          port(async () => outcome),
          env(),
          clock,
        ),
      ).toEqual(outcome);
      expect(clock.pendingTimers).toBe(0);
    }
  });
  it.each([
    () => {
      throw new Error("secret failure");
    },
    () => Promise.reject(new Error("secret failure")),
  ])("contains exceptions without leaking messages", async (run) => {
    const clock = new FakeClock();
    expect(await executePort(port(run), env(), clock)).toEqual({ kind: "error", reason: "exception" });
    expect(clock.pendingTimers).toBe(0);
  });
  it("times out at 1200 and consumes late rejection", async () => {
    const clock = new FakeClock();
    let reject!: (reason: unknown) => void;
    const p = executePort(
      port(
        () =>
          new Promise((_, r) => {
            reject = r;
          }),
      ),
      env({ budgetMs: 99999 }),
      clock,
    );
    await Promise.resolve();
    clock.advance(1199);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(1);
    expect(await p).toEqual({ kind: "timeout", reason: "budget" });
    expect(clock.pendingTimers).toBe(0);
    reject(new Error("late"));
    await Promise.resolve();
  });
  it.each([0, -1, NaN, -Infinity])("does not invoke a port for invalid budget %s", async (budgetMs) => {
    const run = vi.fn(() => ok);
    expect(await executePort(port(run), env({ budgetMs }), new FakeClock())).toEqual({
      kind: "timeout",
      reason: "budget",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("uses a smaller budget and caps Infinity", async () => {
    for (const [budgetMs, expiry] of [
      [12, 12],
      [Infinity, 1200],
    ]) {
      const clock = new FakeClock();
      const p = executePort(
        port(() => new Promise(() => {})),
        env({ budgetMs }),
        clock,
      );
      clock.advance(expiry!);
      expect(await p).toEqual({ kind: "timeout", reason: "budget" });
      expect(clock.pendingTimers).toBe(0);
    }
  });
  it("pre-abort does not run, in-flight abort passes the signal and cleans up", async () => {
    const controller = new AbortController();
    const clock = new FakeClock();
    const e = env({ signal: controller.signal });
    const run = vi.fn(() => new Promise<PortOutcome>(() => {}));
    const remove = vi.spyOn(e.signal, "removeEventListener");
    const p = executePort(port(run), e, clock);
    await Promise.resolve();
    expect(run).toHaveBeenCalledWith(e);
    controller.abort();
    expect(await p).toEqual({ kind: "error", reason: "aborted" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(clock.pendingTimers).toBe(0);
    run.mockClear();
    expect(await executePort(port(run), e, clock)).toEqual({ kind: "error", reason: "aborted" });
    expect(run).not.toHaveBeenCalled();
  });
  it("removes abort listeners on success and timeout", async () => {
    const e = env();
    const remove = vi.spyOn(e.signal, "removeEventListener");
    const clock = new FakeClock();
    await executePort(
      port(() => ok),
      e,
      clock,
    );
    const p = executePort(
      port(() => new Promise(() => {})),
      e,
      clock,
    );
    clock.advance(1200);
    await p;
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it("uses unified clock-failure semantics and still removes abort listeners", async () => {
    for (const stage of ["setup", "cleanup"]) {
      const e = env();
      const remove = vi.spyOn(e.signal, "removeEventListener");
      const clock = new FakeClock();
      if (stage === "setup")
        vi.spyOn(clock, "setTimer").mockImplementation(() => {
          throw new Error("clock");
        });
      else
        vi.spyOn(clock, "clearTimer").mockImplementation(() => {
          throw new Error("clock");
        });
      expect(
        await executePort(
          port(() => ok),
          e,
          clock,
        ),
      ).toEqual(stage === "setup" ? { kind: "timeout", reason: "budget" } : ok);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    }
  });
  it("delegates to the unified race with the original budget, clock and signal", async () => {
    const race = vi.spyOn(budget, "raceBudget");
    try {
      const clock = new FakeClock();
      const e = env({ budgetMs: Infinity });
      expect(
        await executePort(
          port(() => ok),
          e,
          clock,
        ),
      ).toEqual(ok);
      expect(race).toHaveBeenCalledTimes(1);
      expect(race).toHaveBeenCalledWith(expect.any(Promise), Infinity, clock, e.signal);
    } finally {
      race.mockRestore();
    }
  });
  it.each(["timeout", "abort"])("ignores late success after %s", async (kind) => {
    const controller = new AbortController();
    const clock = new FakeClock();
    let resolve!: (outcome: PortOutcome) => void;
    const result = executePort(
      port(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
      env({ signal: controller.signal }),
      clock,
    );
    await Promise.resolve();
    if (kind === "timeout") clock.advance(budget.REFLEX_BUDGET_MS);
    else controller.abort();
    const expected = kind === "timeout" ? { kind: "timeout", reason: "budget" } : { kind: "error", reason: "aborted" };
    expect(await result).toEqual(expected);
    resolve(ok);
    await Promise.resolve();
    expect(await result).toEqual(expected);
    expect(clock.pendingTimers).toBe(0);
  });
  it("production budget timer is unref'd", async () => {
    const unref = vi.spyOn(globalThis, "setTimeout");
    await executePort(
      port(() => ok),
      env(),
      systemClock,
    );
    const timer = unref.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    unref.mockRestore();
  });
});
