import { afterEach, describe, expect, it, vi } from "vitest";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { memLog } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Scope (plan §3)", () => {
  it("timer() schedules an unref'd timeout that fires normally", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    let fired = false;
    scope.timer(() => {
      fired = true;
    }, 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(true);
    await scope.dispose();
  });

  it("timer() handles are unref'd (never keep the event loop alive)", () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    const realSetTimeout = globalThis.setTimeout;
    let captured: ReturnType<typeof setTimeout> | undefined;
    vi.stubGlobal("setTimeout", ((fn: () => void, ms: number) => {
      captured = realSetTimeout(fn, ms);
      return captured;
    }) as typeof setTimeout);
    try {
      scope.timer(() => {}, 1_000);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(captured?.hasRef?.()).toBe(false);
    void scope.dispose();
  });

  it("dispose() clears pending timers before they fire", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    let fired = false;
    scope.timer(() => {
      fired = true;
    }, 50);
    await scope.dispose();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(false);
  });

  it("timer() after dispose is a no-op", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    await scope.dispose();
    let fired = false;
    scope.timer(() => {
      fired = true;
    }, 5);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false);
  });

  it("dispose() aborts the signal", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    expect(scope.signal.aborted).toBe(false);
    await scope.dispose();
    expect(scope.signal.aborted).toBe(true);
  });

  it("defer() runs in reverse registration order", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    const order: number[] = [];
    scope.defer(() => {
      order.push(1);
    });
    scope.defer(() => {
      order.push(2);
    });
    scope.defer(() => {
      order.push(3);
    });
    await scope.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it("a defer that throws is logged and does not stop the remaining defers", async () => {
    const log = memLog();
    const scope = createScope({ log, now: () => 0 });
    const order: string[] = [];
    scope.defer(() => {
      order.push("a");
    });
    scope.defer(() => {
      throw new Error("boom");
    });
    scope.defer(() => {
      order.push("c");
    });
    await scope.dispose();
    expect(order).toEqual(["c", "a"]);
    expect(log.lines.some((l) => l.level === "error" && l.msg.includes("deferred cleanup failed"))).toBe(true);
  });

  it("a defer that never resolves is bounded (does not hang dispose)", async () => {
    vi.useFakeTimers();
    const log = memLog();
    const scope = createScope({ log, now: () => 0 });
    scope.defer(() => new Promise<void>(() => {})); // never settles
    const disposed = scope.dispose();
    await vi.advanceTimersByTimeAsync(2_100);
    await disposed;
    expect(log.lines.some((l) => l.level === "error")).toBe(true);
  });

  it("dispose() is idempotent (defers run exactly once across concurrent/sequential calls)", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    let runs = 0;
    scope.defer(() => {
      runs++;
    });
    const [a, b] = [scope.dispose(), scope.dispose()];
    await Promise.all([a, b]);
    await scope.dispose();
    expect(runs).toBe(1);
  });

  it("child() scopes are disposed before this scope's own defers run", async () => {
    const scope = createScope({ log: memLog(), now: () => 0 });
    const order: string[] = [];
    const child = scope.child();
    child.defer(() => {
      order.push("child");
    });
    scope.defer(() => {
      order.push("parent");
    });
    await scope.dispose();
    expect(order).toEqual(["child", "parent"]);
    expect(child.signal.aborted).toBe(true);
  });
});
