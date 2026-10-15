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

  it("modelsInPool（空名单 ⇒ 目录全量）filters deprecated/router/custom:", () => {
    // 非空 preferred 已是白名单模式（见下方 describe）——旧「偏好序在前+目录序在后」
    // 的追加段不再存在；此处钉空名单（默认）的全量目录行为。
    const port = createCatalogPoolPort({ provider: "droid", catalog: () => catalog(models) });
    expect(port.modelsInPool("core")).toEqual(["glm-5.3", "kimi-k3"]);
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

describe("createCatalogPoolPort allowlist mode (2026-10-16 拍板：非空 externalAgents.droid.models)", () => {
  // 名单外目录模型（会出现在旧版推荐里，测试它们不再出现）。
  const wide: CatalogModelLike[] = [
    { id: "glm-5.3", upstreamProvider: "factory" },
    { id: "kimi-k3", upstreamProvider: "factory" },
    { id: "claude-sonnet-5-5", upstreamProvider: "anthropic" },
    { id: "mistral-large-4", upstreamProvider: "factory" }, // 名单外 core
    { id: "claude-fable-5.1", upstreamProvider: "anthropic" }, // 名单外 standard
    { id: "inkling", upstreamProvider: "factory" }, // 名单外 core
    { id: "old-configured", upstreamProvider: "factory", deprecated: true }, // 名单内但 deprecated
    { id: "auto-configured", kind: "router", upstreamProvider: "factory" }, // 名单内但 router
    { id: "custom:mine", upstreamProvider: "factory" },
  ];
  const portWith = (preferred: readonly string[]) =>
    createCatalogPoolPort({ provider: "droid", catalog: () => ({ models: wide }), preferred: () => preferred });

  it("modelsInPool 只出名单内 id（配置序）；名单外目录模型一律不出现", () => {
    const port = portWith(["kimi-k3", "glm-5.3", "claude-sonnet-5-5", "gpt-6.1-sol"]);
    expect(port.modelsInPool("core")).toEqual(["kimi-k3", "glm-5.3"]); // 配置序，不是目录序
    expect(port.modelsInPool("standard")).toEqual(["claude-sonnet-5-5"]);
    const all = [...port.modelsInPool("core"), ...port.modelsInPool("standard")];
    expect(all).not.toContain("mistral-large-4");
    expect(all).not.toContain("inkling");
    expect(all).not.toContain("claude-fable-5.1");
  });

  it("配置 id 不在目录里 ⇒ 池推导不出 ⇒ 跳过（custom: 恒 none；deprecated/router 名单内同标不推荐）", () => {
    const port = portWith(["gpt-6.1-sol", "old-configured", "auto-configured", "custom:mine"]);
    expect(port.modelsInPool("core")).toEqual([]);
    expect(port.modelsInPool("standard")).toEqual([]);
    expect(port.poolOf("gpt-6.1-sol")).toBeUndefined(); // 池判定本身不变（可被 quota.droidPools 覆盖）
  });

  it("allowlist()：非空 preferred ⇒ 名单；空/缺省 ⇒ undefined；目录不可用 ⇒ modelsInPool 空但名单仍在", () => {
    expect(portWith(["glm-5.3"]).allowlist?.()).toEqual(["glm-5.3"]);
    expect(portWith([]).allowlist?.()).toBeUndefined();
    const port = createCatalogPoolPort({
      provider: "droid",
      catalog: () => {
        throw new Error("store unreadable");
      },
      preferred: () => ["glm-5.3"],
    });
    expect(port.modelsInPool("core")).toEqual([]);
    expect(port.allowlist?.()).toEqual(["glm-5.3"]); // service 层的 droidPools 加法仍能按名单过滤
  });

  it("空 preferred ⇒ 旧行为：目录全量 + 偏好序在前（白名单模式关闭）", () => {
    const port = portWith([]);
    expect(port.modelsInPool("core")).toEqual(["glm-5.3", "kimi-k3", "mistral-large-4", "inkling"]);
    expect(port.modelsInPool("standard")).toEqual(["claude-sonnet-5-5", "claude-fable-5.1"]);
  });
});
