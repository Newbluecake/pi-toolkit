import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSlot,
  armPoison,
  armRetryGrace,
  attachAttempt,
  currentSlot,
  drainGate,
  gateStats,
  releaseSlot,
  resetGate,
  setGateWarningHandler,
  type GateSettings,
} from "../../src/traffic/serialize.js";
import { resetState, state } from "../../src/traffic/state.js";

const settings: GateSettings = {
  handoffMs: 10,
  retryGraceMs: 20,
  maxHoldMs: 30,
  queueWaitMs: 40,
};

function meta(id: string, overrides: Partial<Parameters<typeof acquireSlot>[0]> = {}) {
  return {
    sessionId: id,
    baseUrl: "https://api.example.test/v1",
    model: "model",
    modelApi: "api",
    rules: [],
    settings,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  resetGate();
});

afterEach(() => {
  resetGate();
  vi.useRealTimers();
});

describe("serialization gate", () => {
  it("releases acquirers in FIFO order and ignores repeated release", async () => {
    const first = await acquireSlot(meta("first"), "hook");
    const secondPromise = acquireSlot(meta("second"), "hook");
    const thirdPromise = acquireSlot(meta("third"), "hook");

    releaseSlot(first, "settled");
    const second = await secondPromise;
    expect(second.sessionId).toBe("second");
    expect(currentSlot()).toBe(second);
    releaseSlot(first, "settled");
    releaseSlot(second, "settled");
    const third = await thirdPromise;
    expect(third.sessionId).toBe("third");
    expect(currentSlot()).toBe(third);
    releaseSlot(third, "settled");
    expect(currentSlot()).toBeNull();
    expect(gateStats().gateAcquired).toBe(3);
    expect(gateStats().gateMaxQueueDepth).toBe(2);
  });

  it("releases the holder from an exception finally block and wakes the successor", async () => {
    const first = await acquireSlot(meta("first"), "hook");
    const secondPromise = acquireSlot(meta("second"), "hook");
    expect(() => {
      try {
        throw new Error("provider failed");
      } finally {
        releaseSlot(first, "failed");
      }
    }).toThrow("provider failed");
    const second = await secondPromise;
    expect(currentSlot()).toBe(second);
    releaseSlot(second, "settled");
  });

  it("uses the handoff watchdog when a hook never attaches a fetch", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    setGateWarningHandler((event) => warnings.push(event));
    const slot = await acquireSlot(meta("hook"), "hook");
    vi.advanceTimersByTime(settings.handoffMs!);
    expect(currentSlot()).toBeNull();
    expect(slot.state).toBe("released");
    expect(state.gateNoFetch).toBe(1);
    expect(warnings[0]).toMatchObject({ type: "gate_warn", reason: "no-fetch", slot_id: slot.id });
  });

  it("releases an attached holder at max hold and emits gate_warn", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    setGateWarningHandler((event) => warnings.push(event));
    const slot = await acquireSlot(meta("long"), "hook");
    attachAttempt(slot);
    vi.advanceTimersByTime(settings.maxHoldMs!);
    expect(currentSlot()).toBeNull();
    expect(state.gateTimeouts).toBe(1);
    expect(warnings[0]).toMatchObject({ type: "gate_warn", reason: "max-hold", slot_id: slot.id });
  });

  it("bypasses a waiter after queue wait without throwing or taking the holder", async () => {
    const holder = await acquireSlot(meta("holder", { maxHoldMs: 100 }), "hook");
    attachAttempt(holder);
    const waiterPromise = acquireSlot(meta("waiter", { maxHoldMs: 100 }), "hook");
    vi.advanceTimersByTime(settings.queueWaitMs!);
    const waiter = await waiterPromise;
    expect(waiter.degraded).toBe(true);
    expect(currentSlot()).toBe(holder);
    expect(state.gateBypassed).toBe(1);
    releaseSlot(holder, "settled");
    releaseSlot(waiter, "settled");
  });

  it("keeps a retry slot as holder, allows another attach, then releases on grace expiry", async () => {
    const slot = await acquireSlot(meta("retry"), "hook");
    attachAttempt(slot);
    armRetryGrace(slot);
    vi.advanceTimersByTime(settings.retryGraceMs! - 1);
    expect(currentSlot()).toBe(slot);
    attachAttempt(slot);
    expect(slot.attempts).toBe(2);
    vi.advanceTimersByTime(1);
    expect(currentSlot()).toBeNull();
    expect(slot.state).toBe("released");
  });

  it("reuses a poisoned error without repeating work until the poison window expires", async () => {
    const slot = await acquireSlot(meta("blocked"), "hook");
    const error = new Error("cached rewrite failure");
    armPoison(slot, error);
    expect(() => attachAttempt(slot)).toThrow(error);
    expect(() => attachAttempt(slot)).toThrow(error);
    expect(currentSlot()).toBe(slot);
    vi.advanceTimersByTime(settings.retryGraceMs!);
    expect(currentSlot()).toBeNull();
  });

  it("drains the holder and releases every waiter as degraded", async () => {
    const holder = await acquireSlot(meta("holder"), "hook");
    const secondPromise = acquireSlot(meta("second"), "hook");
    const thirdPromise = acquireSlot(meta("third"), "hook");
    drainGate("drain");
    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    expect(currentSlot()).toBeNull();
    expect(holder.state).toBe("released");
    expect(second.degraded).toBe(true);
    expect(third.degraded).toBe(true);
    expect(gateStats().active).toBe(false);
  });

  it("resetGate clears holder, queue, timers, and counters", async () => {
    const holder = await acquireSlot(meta("holder"), "hook");
    const waiterPromise = acquireSlot(meta("waiter"), "hook");
    resetGate();
    const waiter = await waiterPromise;
    expect(holder.state).toBe("released");
    expect(waiter.degraded).toBe(true);
    expect(gateStats()).toMatchObject({ active: false, queueDepth: 0, holderId: null, gateAcquired: 0 });
  });

  it("does not create timers on the inactive zero-acquire path", () => {
    expect(gateStats().active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
