import { describe, expect, it } from "vitest";
import { createRootWakeBudget } from "../../src/fabric/root-wake-budget.js";
import { createWakeInputHook } from "../../src/fabric/wake-input.js";
import { createCausalLevel } from "../../src/fabric/wake-level.js";

describe("wake input arrival budget (without changing legacy causal classification)", () => {
  it("new TUI/Web arrivals reset even at used=0/root=0; same object dedups; machine inputs do not reset", () => {
    const owner = {};
    const budget = createRootWakeBudget({ owner, sessionId: "test" });
    const level = createCausalLevel({
      maxLevel: 2,
      initialRoot: 0,
      runLevel: () => undefined,
      raiseRun() {},
      persistRoot() {},
    });
    const hook = createWakeInputHook({
      level: () => level,
      rootBudget: () => ({ observeAcceptedUserArrival: (event) => budget.observeAcceptedUserArrival(owner, event) }),
      attributeInput: () => (text) => (text === "verified browser" ? "web_prompt" : undefined),
    });
    const tui = { source: "interactive" as const, text: "hello" };
    expect(hook(tui)).toEqual({ action: "continue" });
    expect(budget.snapshot()).toMatchObject({ window: 1, used: 0 });
    hook(tui);
    expect(budget.snapshot().window).toBe(1);
    hook({ source: "interactive", text: "hello" });
    expect(budget.snapshot()).toMatchObject({ window: 2, used: 0 });
    const first = budget.admit({ owner, messageKey: "key", rootState: "idle" });
    budget.clearReservation(owner, first.reservation!, "delivered");
    expect(budget.snapshot().used).toBe(1);
    for (const text of ["machine continue", "topic replay", "hello"]) hook({ source: "extension", text });
    hook({ source: "rpc", text: "machine" });
    hook({ source: "extension", text: "hello", role: "user" } as never);
    expect(budget.snapshot()).toMatchObject({ window: 2, used: 1 });
    const web = { source: "extension" as const, text: "verified browser" };
    hook(web);
    hook(web);
    expect(budget.snapshot()).toMatchObject({ window: 3, used: 0 });
  });

  it("off and attribution failure never grant a window; legacy RPC still resets causal level only", () => {
    let arrivals = 0;
    const level = createCausalLevel({
      maxLevel: 2,
      initialRoot: 2,
      runLevel: () => undefined,
      raiseRun() {},
      persistRoot() {},
    });
    const port = {
      observeAcceptedUserArrival: () => {
        arrivals++;
        return true;
      },
    };
    const deps = {
      level: () => level,
      rootBudget: () => port,
      attributeInput: () => () => {
        throw Error("missing attribution");
      },
    };
    createWakeInputHook({ ...deps, level: () => undefined })({ source: "interactive", text: "off" });
    createWakeInputHook(deps)({ source: "extension", text: "untrusted" });
    expect(arrivals).toBe(0);
    expect(level.root).toBe(2);
    createWakeInputHook(deps)({ source: "rpc", text: "machine" });
    expect(arrivals).toBe(0);
    expect(level.root).toBe(0);
  });
});
