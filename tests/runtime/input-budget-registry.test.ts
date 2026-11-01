import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createInputBudgetRegistry,
  getInputBudgetRegistry,
  inputTokensForBytes,
  INPUT_BUDGET_REGISTRY_MAX_ENTRIES,
} from "../../src/runtime/input-budget-registry.js";

type BudgetListener = (sessionId: string) => void;

/** Deterministic stand-in for WeakRef: `collect()` simulates GC of the target. */
class FakeWeakRef implements WeakRef<BudgetListener> {
  private target: BudgetListener | undefined;
  constructor(target: BudgetListener) {
    this.target = target;
  }
  deref(): BudgetListener | undefined {
    return this.target;
  }
  collect(): void {
    this.target = undefined;
  }
}

function budgetEntry(overrides: Partial<{ onMeasure: () => void; abort: () => void }> = {}) {
  return {
    maxInputTokens: 1,
    bytesPerToken: 2 as const,
    onMeasure: overrides.onMeasure ?? (() => undefined),
    abort: overrides.abort ?? (() => undefined),
  };
}

describe("input-budget registry", () => {
  it("keeps registrations generation-safe across session reuse", () => {
    const registry = getInputBudgetRegistry();
    const sessionId = randomUUID();
    const first = registry.register(sessionId, {
      maxInputTokens: 10,
      bytesPerToken: 2,
      onMeasure: vi.fn(),
      abort: vi.fn(),
    })!;
    const second = registry.register(sessionId, {
      maxInputTokens: 20,
      bytesPerToken: 2,
      onMeasure: vi.fn(),
      abort: vi.fn(),
    })!;

    first.unregister();
    expect(registry.get(sessionId)?.generation).toBe(second.generation);
    registry.unregister(sessionId, first.generation);
    expect(registry.get(sessionId)?.generation).toBe(second.generation);
    second.unregister();
    expect(registry.get(sessionId)).toBeUndefined();
  });

  it("bounds new session entries and releases every slot", () => {
    const registry = getInputBudgetRegistry();
    const registrations = Array.from({ length: INPUT_BUDGET_REGISTRY_MAX_ENTRIES }, () =>
      registry.register(randomUUID(), {
        maxInputTokens: 1,
        bytesPerToken: 2,
        onMeasure: () => undefined,
        abort: () => undefined,
      }),
    );
    expect(registrations.every((entry) => entry !== undefined)).toBe(true);
    expect(
      registry.register(randomUUID(), {
        maxInputTokens: 1,
        bytesPerToken: 2,
        onMeasure: () => undefined,
        abort: () => undefined,
      }),
    ).toBeUndefined();
    for (const entry of registrations) entry?.unregister();
    expect(registry.size()).toBe(0);
  });

  it("uses the frozen two-byte token estimate", () => {
    expect(inputTokensForBytes(0)).toBe(0);
    expect(inputTokensForBytes(1)).toBe(1);
    expect(inputTokensForBytes(4)).toBe(2);
    expect(inputTokensForBytes(5)).toBe(3);
  });

  it("replays already-registered sessions to a new subscriber and stops after unsubscribe", () => {
    const registry = createInputBudgetRegistry();
    const first = randomUUID();
    registry.register(first, budgetEntry());
    const seen: string[] = [];
    const unsubscribe = registry.subscribe((sessionId) => seen.push(sessionId));
    expect(seen).toEqual([first]);

    const second = randomUUID();
    registry.register(second, budgetEntry());
    expect(seen).toEqual([first, second]);

    unsubscribe();
    registry.register(randomUUID(), budgetEntry());
    expect(seen).toEqual([first, second]);
  });

  it("broadcasts new sessions to live listeners and swallows throwing listeners", () => {
    const registry = createInputBudgetRegistry();
    const stale = vi.fn(() => {
      throw new Error("stale child session");
    });
    const healthy = vi.fn();
    registry.subscribe(stale);
    registry.subscribe(healthy);

    const sessionId = randomUUID();
    expect(registry.register(sessionId, budgetEntry())).toBeDefined();
    expect(stale).toHaveBeenCalledWith(sessionId);
    expect(healthy).toHaveBeenCalledWith(sessionId);
    // Re-registering an existing session id is not a new session → no rebroadcast.
    healthy.mockClear();
    registry.register(sessionId, budgetEntry());
    expect(healthy).not.toHaveBeenCalled();
  });

  it("does not call and prunes listeners whose weak target was collected", () => {
    const refs: FakeWeakRef[] = [];
    const registry = createInputBudgetRegistry({
      createListenerRef: (listener) => {
        const ref = new FakeWeakRef(listener);
        refs.push(ref);
        return ref;
      },
    });
    const healthy = vi.fn();
    registry.subscribe(healthy);
    registry.subscribe(() => undefined); // will be "collected" below
    expect(registry.listenerCount()).toBe(2);

    refs[1]!.collect();
    const sessionId = randomUUID();
    registry.register(sessionId, budgetEntry());
    // The collected listener is skipped (and pruned), the healthy one still fires.
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledWith(sessionId);
    expect(registry.listenerCount()).toBe(1);

    // The pruned weak ref never comes back, even if a stale ref object lingers.
    refs[1]!.collect();
    registry.register(randomUUID(), budgetEntry());
    expect(registry.listenerCount()).toBe(1);
  });

  it("keeps a strongly-referenced listener callable across many broadcasts", () => {
    const registry = createInputBudgetRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    for (let i = 0; i < 5; i++) registry.register(randomUUID(), budgetEntry());
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
    expect(registry.listenerCount()).toBe(0);
  });
});
