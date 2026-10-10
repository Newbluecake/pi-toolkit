import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { getInputBudgetRegistry, INPUT_BUDGET_REGISTRY_MAX_ENTRIES } from "../../src/runtime/input-budget-registry.js";

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: `budget-${Math.random()}`,
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "ok",
    getUsage: () => undefined,
    ...overrides,
  };
}

function runnerFor(driver: SessionDriver): RuntimeRunner {
  const clock = new FakeClock();
  const deps: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 1),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  };
  return new RuntimeRunner(deps);
}

const budget = { ...DEFAULT_BUDGET, queueWaitMs: 10, startupMs: 10, bindMs: 10, totalMs: 100, reapMs: 10 };
const baseRequest = {
  runId: "budget-run",
  prompt: "hello",
  inputBudget: { maxInputTokens: 10, bytesPerToken: 2 as const },
} satisfies ResolvedSpawnRequest;

describe("runtime input-budget two-stage measurement", () => {
  it("coarse-fails before prompt when the session driver preflight is over budget", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    const h = handle({ measureInputBudget: () => ({ preBytes: 22, preTokens: 11 }), prompt });
    const outcome = await runnerFor({ create: async () => h, bind: async () => undefined, onLateArrival() {} }).run(
      baseRequest,
      budget,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toContain("input-budget:");
    expect(prompt).not.toHaveBeenCalled();
    expect(outcome.usage).toBeUndefined();
    expect(outcome.diag.dispatchMeasure?.preBytes).toBe(22);
  });

  it("records the provider payload and aborts the pi session before prompt settles", async () => {
    const sessionId = `budget-${Math.random()}`;
    const requestAbort = vi.fn();
    let providerRequests = 0;
    const h = handle({
      sessionId,
      measureInputBudget: () => ({ preBytes: 2, preTokens: 1 }),
      requestAbort: () => {
        requestAbort();
        return Promise.resolve();
      },
      prompt: () => {
        const registration = getInputBudgetRegistry().get(sessionId);
        registration?.onMeasure(22);
        if (registration && 11 > registration.maxInputTokens) {
          registration.abort("input-budget: measured 11 tokens > 10");
        }
        if (!requestAbort.mock.calls.length) providerRequests++;
        return Promise.resolve();
      },
    });
    const outcome = await runnerFor({ create: async () => h, bind: async () => undefined, onLateArrival() {} }).run(
      baseRequest,
      budget,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toContain("input-budget: measured");
    expect(outcome.usage).toBeUndefined();
    expect(outcome.diag.dispatchMeasure?.payloadBytes).toBe(22);
    expect(requestAbort).toHaveBeenCalledTimes(1);
    expect(providerRequests).toBe(0);
  });

  it("fails closed when the measurement registry is full before prompt", async () => {
    const registry = getInputBudgetRegistry();
    const held: Array<{ unregister: () => void }> = [];
    for (let i = 0; i <= INPUT_BUDGET_REGISTRY_MAX_ENTRIES; i++) {
      const registration = registry.register(randomUUID(), {
        maxInputTokens: 100,
        bytesPerToken: 2,
        onMeasure: () => undefined,
        abort: () => undefined,
      });
      if (!registration) break;
      held.push(registration);
    }
    const prompt = vi.fn(() => Promise.resolve());
    try {
      const outcome = await runnerFor({
        create: async () => handle({ prompt, measureInputBudget: () => ({ preBytes: 2, preTokens: 1 }) }),
        bind: async () => undefined,
        onLateArrival() {},
      }).run(baseRequest, budget);
      expect(outcome.status).toBe("failed");
      expect(outcome.error?.kind).toBe("config");
      expect(outcome.error?.message).toBe("input-budget: measurement registry full");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      for (const registration of held) registration.unregister();
    }
  });

  it("fails closed when the child extension was not observed", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    const outcome = await runnerFor({
      create: async () => handle({ childExtensionMissing: true, prompt }),
      bind: async () => undefined,
      onLateArrival() {},
    }).run(baseRequest, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("input-budget: child extension missing — measurement unavailable");
    expect(prompt).not.toHaveBeenCalled();
  });
});
