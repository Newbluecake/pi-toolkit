import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  getInputBudgetRegistry,
  inputTokensForBytes,
  INPUT_BUDGET_REGISTRY_MAX_ENTRIES,
} from "../../src/runtime/input-budget-registry.js";

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
});
