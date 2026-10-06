import fc from "fast-check";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { __shrinkStepForTest, projectModels, modelsFingerprint } from "../../../src/web-hub/agent/models.js";
import { SessionModelsSchema } from "../../../src/web-hub/protocol/messages.js";
import { MODELS_WIRE_BUDGET_BYTES, MODELS_WIRE_MAX_ITEMS, utf8Bytes } from "../../../src/web-hub/protocol/models.js";
import type { AvailableModelEntry } from "../../../src/config/available-models.js";

function project(
  available: readonly AvailableModelEntry[],
  scoped: readonly AvailableModelEntry[] = [],
  current: unknown = null,
) {
  return projectModels({
    available: () => available,
    registryError: () => undefined,
    scoped: () => scoped.map((model) => ({ model })),
    current: () => current,
    policy: (name) => (name === "model" ? "allow" : "confirm"),
    shadowed: () => false,
    now: () => 1_700_000_000_000,
  });
}

describe("projectModels", () => {
  it("unpacks, intersects, deduplicates, and preserves scoped order", () => {
    const wire = project(
      [
        { provider: "openai", id: "gpt-4", name: "GPT 4" },
        { provider: "zai", id: "glm-5", reasoning: true, contextWindow: 128_000 },
      ],
      [
        { provider: "zai", id: "glm-5" },
        { provider: "openai", id: "gpt-4" },
        { provider: "missing", id: "nope" },
      ],
    );
    expect(wire.status).toBe("ok");
    expect(wire.items.map((item) => `${item.provider}/${item.id}`)).toEqual(["zai/glm-5", "openai/gpt-4"]);
    expect(wire.items[0]?.scoped).toBe(true);
    expect(wire.items[1]?.scoped).toBe(true);
    expect(wire.items[0]?.ctx).toBe(128_000);
    expect(wire.items[0]?.reasoning).toBe(true);
  });

  it("leaves scoped markers absent when enabledModels is not configured", () => {
    const wire = project([
      { provider: "openai", id: "gpt-5" },
      { provider: "zai", id: "glm-5" },
    ]);
    expect(wire.scoped).toBeUndefined();
    expect(wire.items.every((item) => item.scoped === undefined)).toBe(true);
  });

  it("ignores explicit scoped thinkingLevel when projecting model options", () => {
    const wire = projectModels({
      available: () => [{ provider: "openai", id: "gpt-5" }],
      registryError: () => undefined,
      scoped: () => [{ model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "high" }],
      current: () => null,
      policy: () => "allow",
      shadowed: () => false,
      now: () => 1_700_000_000_000,
    });
    expect(wire.items).toEqual([{ provider: "openai", id: "gpt-5", scoped: true }]);
    expect(wire.items[0]).not.toHaveProperty("thinkingLevel");
  });

  it("reports empty and error states without throwing", () => {
    expect(project([]).status).toBe("empty");
    const wire = projectModels({
      available: () => {
        throw new Error("stale");
      },
      registryError: () => "refresh failed",
      scoped: () => [],
      current: () => null,
      now: () => 1,
    });
    expect(wire.status).toBe("error");
    expect(wire.items).toEqual([]);
  });

  it("keeps every generated wire inside the open bounded schema", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            provider: fc.string({ unit: "binary", maxLength: 40 }),
            id: fc.string({ unit: "binary", maxLength: 80 }),
            name: fc.option(fc.string({ unit: "grapheme", maxLength: 180 }), { nil: undefined }),
            reasoning: fc.boolean(),
            contextWindow: fc.nat({ max: 2_000_000 }),
          }),
          { maxLength: 240 },
        ),
        (available) => {
          const wire = project(available);
          expect(Value.Check(SessionModelsSchema, wire)).toBe(true);
          expect(wire.items.length).toBeLessThanOrEqual(MODELS_WIRE_MAX_ITEMS);
          expect(utf8Bytes(JSON.stringify(wire) ?? "")).toBeLessThanOrEqual(MODELS_WIRE_BUDGET_BYTES);
        },
      ),
      { numRuns: 200 },
    );

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            provider: fc.string({ unit: "binary", maxLength: 160 }),
            id: fc.string({ unit: "binary", maxLength: 180 }),
            name: fc.option(fc.string({ unit: "grapheme", maxLength: 220 }), { nil: undefined }),
            reasoning: fc.boolean(),
            contextWindow: fc.nat({ max: 2_000_000 }),
          }),
          { maxLength: 10_000 },
        ),
        (available) => {
          const wire = project(available);
          expect(Value.Check(SessionModelsSchema, wire)).toBe(true);
          expect(utf8Bytes(JSON.stringify(wire) ?? "")).toBeLessThanOrEqual(MODELS_WIRE_BUDGET_BYTES);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("reduces bytes monotonically at every budget shrink step", () => {
    const wire = projectModels({
      available: () =>
        Array.from({ length: 160 }, (_, index) => ({
          provider: `provider-${index}`,
          id: `model-${index}`,
          name: "高位 Unicode 🚀 ".repeat(80),
        })),
      registryError: () => undefined,
      scoped: () => [],
      current: () => null,
      now: () => 1,
    });
    const trace: number[] = [utf8Bytes(JSON.stringify(wire) ?? "")];
    for (;;) {
      const step = __shrinkStepForTest(wire);
      trace.push(step.bytes);
      if (!step.changed) break;
    }
    expect(trace.every((value, index) => index === 0 || value <= trace[index - 1]!)).toBe(true);
  });

  it("denies and marks commands shadowed by extensions", () => {
    const wire = projectModels({
      available: () => [{ provider: "openai", id: "gpt-5" }],
      registryError: () => undefined,
      scoped: () => [],
      current: () => null,
      policy: (name) => (name === "model" ? "allow" : "confirm"),
      shadowed: (name) => name === "model",
      now: () => 1,
    });
    expect(wire.policy.model).toBe("deny");
    expect(wire.shadowed).toEqual({ model: true });
  });

  it("uses stable fingerprints independent of sampledAt", () => {
    const first = project([{ provider: "openai", id: "gpt-4" }]);
    const second = { ...first, sampledAt: first.sampledAt + 10_000 };
    expect(modelsFingerprint(first)).toBe(modelsFingerprint(second));
  });

  it("matches the checked-in projection fixture", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../fixtures/web-hub-models/v1-session.json", import.meta.url), "utf8"),
    ) as unknown;
    expect(
      project(
        [
          { provider: "openai", id: "gpt-5", name: "GPT 5", reasoning: true, contextWindow: 400_000 },
          { provider: "zai", id: "glm-5", name: "GLM 5" },
        ],
        [{ provider: "zai", id: "glm-5" }],
      ),
    ).toEqual(fixture);
  });
});
