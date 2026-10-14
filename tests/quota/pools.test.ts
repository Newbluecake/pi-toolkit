// quota-plan r2 §11：池映射（§2.3）——derivePool 全表、modelsInPool 过滤与
// 偏好序、catalog 抛错/缺席退化、warm() 幂等吞异常。

import { describe, expect, it } from "vitest";
import { createCatalogPoolPort, derivePool, type CatalogModelLike } from "../../src/quota/pools.js";

const catalog = (models: readonly CatalogModelLike[]) => ({ models });

describe("derivePool (D4 heuristic table)", () => {
  it("custom: ⇒ none (BYOK), even without catalog info", () => {
    expect(derivePool(undefined, "custom:my-model")).toBe("none");
    expect(derivePool({ id: "custom:x", upstreamProvider: "factory" }, "custom:x")).toBe("none");
  });

  it("structural billingPool wins (forward-compat, absent under K1)", () => {
    expect(derivePool({ id: "m", upstreamProvider: "factory", billingPool: "standard" }, "m")).toBe("standard");
  });

  it("router kind ⇒ unknown", () => {
    expect(derivePool({ id: "auto", kind: "router", upstreamProvider: "factory" }, "auto")).toBeUndefined();
  });

  it("upstreamProvider mapping: factory ⇒ core; anthropic/openai/google/xai ⇒ standard; others ⇒ unknown", () => {
    expect(derivePool({ id: "glm-5.3", upstreamProvider: "factory" }, "glm-5.3")).toBe("core");
    for (const up of ["anthropic", "openai", "google", "xai"]) {
      expect(derivePool({ id: "m", upstreamProvider: up }, "m")).toBe("standard");
    }
    expect(derivePool({ id: "m", upstreamProvider: "minimax" }, "m")).toBeUndefined();
    expect(derivePool(undefined, "mystery")).toBeUndefined();
  });
});

describe("createCatalogPoolPort", () => {
  const models: CatalogModelLike[] = [
    { id: "glm-5.3", upstreamProvider: "factory" },
    { id: "kimi-k3", upstreamProvider: "factory" },
    { id: "claude-opus-5-5", upstreamProvider: "anthropic" },
    { id: "auto", kind: "router", upstreamProvider: "factory" },
    { id: "old-model", upstreamProvider: "factory", deprecated: true },
    { id: "custom:byok", upstreamProvider: "factory" },
  ];

  it("poolOf reads the catalog live; unknown ids fall back to the bare heuristic", () => {
    const port = createCatalogPoolPort({ provider: "droid", catalog: () => catalog(models) });
    expect(port.poolOf("glm-5.3")).toBe("core");
    expect(port.poolOf("claude-opus-5-5")).toBe("standard");
    expect(port.poolOf("auto")).toBeUndefined();
    expect(port.poolOf("not-in-catalog")).toBeUndefined();
    expect(port.poolOf("custom:byok")).toBe("none");
  });

  it("modelsInPool filters deprecated/router/custom: and puts preferred ids first", () => {
    const port = createCatalogPoolPort({
      provider: "droid",
      catalog: () => catalog(models),
      preferred: () => ["kimi-k3"],
    });
    expect(port.modelsInPool("core")).toEqual(["kimi-k3", "glm-5.3"]); // 偏好序在前
    expect(port.modelsInPool("standard")).toEqual(["claude-opus-5-5"]);
  });

  it("degrades when the catalog throws or is absent (never throws)", () => {
    const throwing = createCatalogPoolPort({
      provider: "droid",
      catalog: () => {
        throw new Error("store unreadable");
      },
    });
    expect(throwing.poolOf("glm-5.3")).toBeUndefined();
    expect(throwing.modelsInPool("core")).toEqual([]);
    expect(() => throwing.warm()).not.toThrow();
  });

  it("warm() calls catalog exactly once (idempotent) and swallows errors", () => {
    let calls = 0;
    const port = createCatalogPoolPort({
      provider: "droid",
      catalog: () => {
        calls += 1;
        if (calls === 1) throw new Error("first read fails");
        return catalog(models);
      },
    });
    port.warm();
    port.warm();
    expect(calls).toBe(1);
  });

  it("matches the ExternalCatalog structural shape (P5 接线口径)", () => {
    // 与 ExternalCatalog { models: [...] } 结构兼容：直接喂同样的形状。
    const externalCatalogLike = {
      models: [
        { id: "glm-5.3", upstreamProvider: "factory", displayName: "GLM" },
        { id: "claude-opus-5-5", upstreamProvider: "anthropic" },
      ],
      extraField: "tolerated",
    };
    const port = createCatalogPoolPort({ provider: "droid", catalog: () => externalCatalogLike });
    expect(port.poolOf("glm-5.3")).toBe("core");
    expect(port.poolOf("claude-opus-5-5")).toBe("standard");
  });
});
