import { describe, expect, it } from "vitest";
import {
  createRootWakeBudget,
  type RootBudgetState,
  type RootWakeBudgetSnapshot,
} from "../../src/fabric/root-wake-budget.js";

function make(limit = 2, snapshot?: unknown, sessionId = "sid") {
  const owner = {};
  const budget = createRootWakeBudget({ owner, sessionId, limit, snapshot });
  const admit = (messageKey: string, rootState: RootBudgetState = "idle") =>
    budget.admit({ owner, messageKey, rootState });
  const arrival = (event = {}) => budget.observeAcceptedUserArrival(owner, event);
  const wake = (key: string) => {
    const decision = admit(key);
    expect(decision.action).toBe("requestWake");
    expect(decision.reservation).toBeDefined();
    return decision.reservation!;
  };
  return { owner, budget, admit, arrival, wake };
}

describe("root wake budget (pure policy)", () => {
  it("queues running/starting without a window or any charge, even with zero limit", () => {
    const f = make(0);
    for (const state of ["running", "starting"] as const) {
      expect(f.admit("child", state)).toMatchObject({ action: "queue", reason: "busy", state: { used: 0 } });
    }
    expect(f.admit("child").reason).toBe("no_window");
    f.arrival();
    expect(f.admit("child").reason).toBe("limit");
    expect(f.budget.snapshot().used).toBe(0);
  });

  it("reserves synchronously for two-child bursts and consumes exactly the default quota", () => {
    const f = make();
    f.arrival();
    const first = f.wake("child1");
    expect(f.admit("child2")).toMatchObject({ action: "queue", reason: "reserved", state: { used: 1 } });
    expect(f.admit("child2", "starting").action).toBe("queue");
    expect(f.budget.clearReservation(f.owner, first, "agent_start")).toBe(true);
    expect(f.admit("child1").reason).toBe("duplicate");
    const second = f.wake("child2");
    expect(f.budget.clearReservation(f.owner, first, "settled")).toBe(false);
    expect(f.budget.clearReservation(f.owner, second, "settled")).toBe(true);
    expect(f.admit("child3")).toMatchObject({ action: "deliverOnly", reason: "limit", state: { used: 2 } });
    expect(f.admit("child3", "running").action).toBe("queue");
    expect(f.budget.snapshot().dedupCount).toBe(2);
  });

  it("known failure does not refund; unknown does not release or allow a second attempt", () => {
    const f = make();
    f.arrival();
    const first = f.wake("failed");
    expect(f.budget.clearReservation(f.owner, first, "send_failed")).toBe(true);
    expect(f.admit("failed").reason).toBe("duplicate");
    const second = f.wake("uncertain");
    expect(f.budget.clearReservation(f.owner, second, "unknown" as "settled")).toBe(false);
    expect(f.admit("uncertain").action).toBe("queue");
    expect(f.budget.snapshot().used).toBe(2);
    f.budget.clearReservation(f.owner, second, "settled");
    expect(f.admit("uncertain").reason).toBe("duplicate");
    expect(f.admit("other").reason).toBe("limit");
  });

  it("resets at each host user arrival, even used=0, without a consume or root-level event", () => {
    const f = make();
    const event = {};
    expect(f.arrival(event)).toBe(true);
    expect(f.budget.snapshot()).toMatchObject({ window: 1, used: 0 });
    expect(f.arrival()).toBe(true);
    expect(f.budget.snapshot()).toMatchObject({ window: 2, used: 0 });
    const reservation = f.wake("same");
    expect(f.arrival(event)).toBe(false);
    expect(f.budget.snapshot()).toMatchObject({ window: 2, used: 1 });
    expect(f.arrival()).toBe(true);
    expect(f.budget.snapshot()).toMatchObject({ window: 3, used: 0, dedupCount: 0 });
    expect(f.admit("same").reason).toBe("reserved");
    f.budget.clearReservation(f.owner, reservation, "agent_start");
    expect(f.wake("same")).toEqual({ window: 3, used: 1 });
  });

  it("rejects old owner, disposed closure, closed and unknown without consuming/resetting", () => {
    const f = make();
    const old = {};
    expect(f.budget.observeAcceptedUserArrival(old, {})).toBe(false);
    expect(f.budget.dispose(old)).toBe(false);
    expect(f.budget.admit({ owner: old, messageKey: "x", rootState: "idle" }).reason).toBe("owner_mismatch");
    f.arrival();
    for (const state of ["closed", "unknown"] as const) {
      expect(f.admit("x", state)).toMatchObject({ action: "deliverOnly", reason: state, state: { used: 0 } });
    }
    const reservation = f.wake("x");
    expect(f.budget.clearReservation(old, reservation, "settled")).toBe(false);
    expect(f.budget.dispose(f.owner)).toBe(true);
    expect(f.arrival()).toBe(false);
    expect(f.admit("x", "running").reason).toBe("disposed");
    expect(f.budget.clearReservation(f.owner, reservation, "settled")).toBe(false);
    const next = make();
    expect(next.budget.observeAcceptedUserArrival(f.owner, {})).toBe(false);
    expect(next.budget.snapshot().window).toBe(0);
  });

  it("preserves same-SID counts on restore but never reconstructs lost exact-key authority", () => {
    const f = make();
    f.arrival();
    f.wake("secret-key");
    const snapshot = JSON.parse(JSON.stringify(f.budget.snapshot())) as RootWakeBudgetSnapshot;
    expect(snapshot).toEqual({ sessionId: "sid", window: 1, used: 1, dedupCount: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("secret-key");
    const restored = make(2, snapshot);
    expect(restored.budget.snapshot()).toEqual(snapshot);
    expect(restored.admit("secret-key").reason).toBe("restored_window");
    expect(restored.admit("other", "running").action).toBe("queue");
    restored.arrival();
    expect(restored.wake("fresh")).toEqual({ window: 2, used: 1 });
    const fork = make(2, snapshot, "fork");
    expect(fork.admit("x").reason).toBe("no_window");
    expect(fork.budget.snapshot().used).toBe(0);
    fork.arrival();
    expect(fork.wake("x").used).toBe(1);
  });

  it("fails closed for missing/corrupt snapshots and validates all finite integer counts", () => {
    const good = { sessionId: "sid", window: 1, used: 1, dedupCount: 1 };
    const bad: unknown[] = [undefined, null, {}, "snapshot", { ...good, used: 3 }, { ...good, dedupCount: 0 }];
    for (const field of ["window", "used", "dedupCount"]) {
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        bad.push({ ...good, [field]: value });
      }
    }
    for (const snapshot of bad) {
      const f = make(2, snapshot);
      expect(f.admit("x").reason).toBe("no_window");
      expect(f.admit("x", "starting").action).toBe("queue");
      expect(f.arrival()).toBe(true);
      expect(f.wake("x").used).toBe(1);
    }
    for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => make(limit)).toThrow(RangeError);
    }
    const exhausted = make(2, { ...good, window: Number.MAX_SAFE_INTEGER });
    expect(exhausted.arrival()).toBe(false);
    expect(exhausted.admit("x").action).toBe("deliverOnly");
  });

  it("matched delivered confirmation clears only its own reservation without refund or duplicate-key retry", () => {
    const f = make();
    f.arrival();
    const reservation = f.wake("delivered-key");
    expect(f.budget.clearReservation({}, reservation, "delivered")).toBe(false);
    expect(f.budget.clearReservation(f.owner, { ...reservation, used: reservation.used + 1 }, "delivered")).toBe(false);
    expect(f.admit("other").reason).toBe("reserved");
    expect(f.budget.clearReservation(f.owner, reservation, "delivered")).toBe(true);
    expect(f.admit("delivered-key").reason).toBe("duplicate");
    expect(f.budget.snapshot().used).toBe(1);
    expect(f.wake("next-key").used).toBe(2);
    expect(f.budget.clearReservation(f.owner, reservation, "delivered")).toBe(false);
  });

  it("supports over 320 real user windows and keeps current-window storage bounded", () => {
    const f = make();
    for (let i = 1; i <= 400; i++) {
      expect(f.arrival()).toBe(true);
      const reservation = f.wake("same-key");
      f.budget.clearReservation(f.owner, reservation, "settled");
      expect(f.budget.snapshot()).toEqual({ sessionId: "sid", window: i, used: 1, dedupCount: 1 });
    }
    expect(f.admit("").reason).toBe("invalid_key");
    expect(f.admit("x".repeat(513)).reason).toBe("invalid_key");
    expect(f.budget.snapshot().dedupCount).toBe(1);
  });

  it("seeded random sequences never exceed limit or reset on child/completion activity", () => {
    for (const limit of [0, 1, 2, 5]) {
      const f = make(limit);
      let seed = 61;
      let expectedUsed = 0;
      let expectedWindow = 0;
      let reservation: { window: number; used: number } | undefined;
      for (let i = 0; i < 3000; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const op = seed % 9;
        if (op === 0) {
          f.arrival();
          expectedWindow++;
          expectedUsed = 0;
        } else if (op === 1 && reservation !== undefined) {
          f.budget.clearReservation(f.owner, reservation, "settled");
          reservation = undefined;
        } else {
          const state = (["idle", "running", "starting", "closed", "unknown"] as const)[seed % 5]!;
          const decision = f.admit(`child-${seed % 7}`, state);
          if (decision.action === "requestWake") {
            expect(state).toBe("idle");
            expect(reservation).toBeUndefined();
            expectedUsed++;
            reservation = decision.reservation;
          }
        }
        expect(f.budget.snapshot()).toMatchObject({
          window: expectedWindow,
          used: expectedUsed,
          dedupCount: expectedUsed,
        });
        expect(expectedUsed).toBeLessThanOrEqual(limit);
      }
    }
  });
});
