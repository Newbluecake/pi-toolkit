/**
 * external-agent port 组装（plan §5.5，P5）：createExternalAgentsPort 的门面行为。
 *
 * 目录数据经真 CatalogStore 磁盘缓存注入（catalogCachePath 落 JSON）——port 内部组装的是
 * 真 droid provider，snapshot() 惰性读缓存，不需要起任何进程。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS, type ExternalAgentsSettings } from "../../src/config/settings.js";
import { createExternalAgentsPort } from "../../src/external-agent/port.js";
import { catalogCachePath } from "../../src/external-agent/paths.js";
import { msgBinaryNotFound, msgProviderNameCollision, msgProtocolDrift } from "../../src/external-agent/messages.js";
import type { ExternalCatalog } from "../../src/external-agent/types.js";
import { createCatalogPoolPort } from "../../src/quota/pools.js";

let tmp = "";
let agentDir = "";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ext-port-"));
  agentDir = join(tmp, "agent");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CATALOG: ExternalCatalog = {
  provider: "droid",
  fetchedAt: 1,
  protocolVersion: "1.264.0",
  models: [
    {
      id: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      upstreamProvider: "openai",
      reasoningEfforts: ["low", "high"],
      defaultEffort: "low",
      deprecated: false,
      tokenMultiplier: 0.04,
    },
    {
      id: "claude-opus-5-5",
      displayName: "Opus 5.5",
      upstreamProvider: "anthropic",
      reasoningEfforts: [],
      deprecated: false,
    },
    {
      id: "glm-5.3",
      displayName: "GLM 5.3",
      upstreamProvider: "factory",
      reasoningEfforts: [],
      deprecated: false,
      tokenMultiplier: 1.2,
    },
    { id: "auto", kind: "router", reasoningEfforts: [], deprecated: false },
    { id: "old-1", reasoningEfforts: [], deprecated: true },
    { id: "custom:mine", reasoningEfforts: [], deprecated: false },
  ],
};

/** 把目录写进真 CatalogStore 的磁盘缓存路径（snapshot 惰性读）。 */
function seedCatalog(catalog: ExternalCatalog = CATALOG): void {
  const p = catalogCachePath(agentDir, "droid");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(catalog), { mode: 0o600 });
}

const settings = (over: Partial<ExternalAgentsSettings["droid"]> = {}): ExternalAgentsSettings => ({
  droid: { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid, enabled: true, ...over },
});

function makePort(
  o: Partial<Parameters<typeof createExternalAgentsPort>[0]> = {},
  s: ExternalAgentsSettings = settings(),
  dir: string = agentDir,
) {
  const warnOnce = vi.fn();
  const registry = o.registry ?? (() => undefined);
  const piProviders = o.piProviders ?? (() => []);
  const r = createExternalAgentsPort({
    settings: s,
    agentDir: dir,
    clock: new FakeClock(1_000),
    registry,
    piProviders,
    warnOnce,
    ...(o.memoryBlock !== undefined ? { memoryBlock: o.memoryBlock } : {}),
  });
  return { r, warnOnce, registry };
}

describe("createExternalAgentsPort", () => {
  it("enabled=false ⇒ undefined（零构造）", () => {
    const { r } = makePort({}, settings({ enabled: false }));
    expect(r).toBeUndefined();
  });

  it("providers map 携带 droid；owns/ownerOfSessionFile 委托 provider", () => {
    seedCatalog();
    const { r } = makePort();
    expect(r!.providers.get("droid")!.id).toBe("droid");
    expect(r!.port.owns("droid")).toBe(true);
    expect(r!.port.owns("anthropic")).toBe(false);
  });

  it("provider 名冲突 ⇒ unavailableReason = msgProviderNameCollision + warnOnce（fail closed）", () => {
    const { r, warnOnce } = makePort({ piProviders: () => ["anthropic", "droid"] });
    expect(r!.port.unavailableReason("droid")).toBe(msgProviderNameCollision("droid"));
    expect(warnOnce).toHaveBeenCalledTimes(1);
    expect(String(warnOnce.mock.calls[0]?.[0])).toContain("collision");
  });

  it("二进制缺失 ⇒ unavailableReason = msgBinaryNotFound", () => {
    const { r } = makePort({}, settings({ binary: "/nonexistent/droid-bin-xyz" }));
    expect(r!.port.unavailableReason("droid")).toBe(msgBinaryNotFound("/nonexistent/droid-bin-xyz"));
  });

  it("strict 目录漂移 ⇒ msgProtocolDrift；warn ⇒ 放行", () => {
    seedCatalog({ ...CATALOG, drift: { expected: "1.264.0", actual: "9.9.9" } });
    const strict = makePort({}, settings());
    expect(strict.r!.port.unavailableReason("droid")).toBe(msgProtocolDrift("9.9.9", "1.264.0"));
    const warn = makePort({}, settings({ protocolCheck: "warn" }));
    expect(warn.r!.port.unavailableReason("droid")).toBeUndefined();
  });

  it("exists：目录缺席 ⇒ undefined（fail-open）；在场 ⇒ true/false", () => {
    const fresh = join(tmp, "no-catalog", String(Math.random()).slice(2));
    const none = makePort({}, settings(), fresh);
    expect(none.r!.port.exists({ provider: "droid", id: "gpt-6-luna" })).toBeUndefined();
    seedCatalog();
    const { r } = makePort();
    expect(r!.port.exists({ provider: "droid", id: "gpt-6-luna" })).toBe(true);
    expect(r!.port.exists({ provider: "droid", id: "nope" })).toBe(false);
    expect(r!.port.exists({ provider: "other", id: "gpt-6-luna" })).toBe(false);
  });

  it("unknownModelMessage 带目录候选", () => {
    seedCatalog();
    const { r } = makePort();
    expect(r!.port.unknownModelMessage({ provider: "droid", id: "nope" })).toContain("known droid models");
  });

  describe("advertised（§15 跟踪项 4：multiplier→note；截断在 index.ts 投影）", () => {
    it("目录过滤：非 deprecated、非 router、非 custom:，droid 原序；tokenMultiplier≠1 折进 note", () => {
      seedCatalog();
      const { r } = makePort();
      expect(r!.port.advertised()).toEqual([
        { provider: "droid", id: "gpt-6-luna", name: "GPT-6 Luna", note: "×0.04" },
        { provider: "droid", id: "claude-opus-5-5", name: "Opus 5.5" }, // ×1/缺省 ⇒ 无 note
        { provider: "droid", id: "glm-5.3", name: "GLM 5.3", note: "×1.2" },
      ]);
    });
    it("models 设置 ⇒ 只列它们（目录缺席的 id 也列出，仅无 name/note）", () => {
      seedCatalog();
      const { r } = makePort({}, settings({ models: ["glm-5.3", "ghost-model"] }));
      expect(r!.port.advertised()).toEqual([
        { provider: "droid", id: "glm-5.3", name: "GLM 5.3", note: "×1.2" },
        { provider: "droid", id: "ghost-model" },
      ]);
    });
  });

  describe("planRun", () => {
    it("fresh：memory + capabilities 块；resume：空；degraded 齐全；persist 透传", () => {
      seedCatalog();
      const { r } = makePort({
        memoryBlock: (cwd) => (cwd === "/wt" ? "MEMO" : undefined),
      });
      const spec = r!.port.planRun({
        runId: "r_1",
        model: { provider: "droid", id: "gpt-6-luna" },
        typeName: "worker",
        rolePrompt: "ROLE",
        canSpawn: true,
        canMessage: true,
        declaresTools: true,
        schema: { type: "object" },
        resume: false,
        cwd: "/wt",
        persist: false,
      });
      expect(spec.contextBlocks).toEqual([
        { kind: "memory", text: "MEMO" },
        { kind: "capabilities", text: expect.stringContaining("consulting experts") },
      ]);
      expect(spec.degraded).toEqual(["schema_text", "message_agent", "nested_agent", "type_tools_ignored"]);
      expect(spec.persistTranscript).toBe(false);
      expect(spec.modelId).toBe("gpt-6-luna");
      expect(spec.rolePrompt).toBe("ROLE");
      const resumed = r!.port.planRun({
        runId: "r_2",
        model: { provider: "droid", id: "gpt-6-luna" },
        typeName: "worker",
        canSpawn: false,
        canMessage: false,
        declaresTools: false,
        resume: true,
        cwd: "/wt",
        persist: true,
      });
      expect(resumed.contextBlocks).toEqual([]);
      expect(resumed.degraded).toEqual([]);
    });
    it("injectMemory=false 或 memoryBlock 缺席 ⇒ 无 memory 块", () => {
      seedCatalog();
      const { r } = makePort({}, settings({ injectMemory: false }));
      const spec = r!.port.planRun({
        runId: "r",
        model: { provider: "droid", id: "m" },
        typeName: "w",
        canSpawn: false,
        canMessage: false,
        declaresTools: false,
        resume: false,
        cwd: "/x",
        persist: true,
      });
      expect(spec.contextBlocks).toEqual([{ kind: "capabilities", text: expect.any(String) }]);
    });
    it("memoryBlock 抛错 ⇒ 静默跳过", () => {
      seedCatalog();
      const { r } = makePort({
        memoryBlock: () => {
          throw new Error("boom");
        },
      });
      const spec = r!.port.planRun({
        runId: "r",
        model: { provider: "droid", id: "m" },
        typeName: "w",
        canSpawn: false,
        canMessage: false,
        declaresTools: false,
        resume: false,
        cwd: "/x",
        persist: true,
      });
      expect(spec.contextBlocks.map((b) => b.kind)).toEqual(["capabilities"]);
    });
  });

  describe("pricingFor（60s memo）", () => {
    it("registry 命中 upstream ⇒ priced；override unpriced ⇒ unpriced；memo 冻结 registry 读数", () => {
      seedCatalog();
      let calls = 0;
      const { r } = makePort({
        registry: () => {
          calls++;
          return [{ provider: "openai", id: "gpt-6-luna", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }];
        },
      });
      const p1 = r!.port.pricingFor({ provider: "droid", id: "gpt-6-luna" });
      expect(p1).toMatchObject({ status: "priced", source: "openai/gpt-6-luna", basis: "upstream" });
      r!.port.pricingFor({ provider: "droid", id: "gpt-6-luna" });
      expect(calls).toBe(1); // 60s 内 memo
      const none = makePort({}, settings({ pricing: { "gpt-6-luna": "unpriced" } }));
      expect(none.r!.port.pricingFor({ provider: "droid", id: "gpt-6-luna" })).toMatchObject({
        status: "unpriced",
        reason: "override_unpriced",
      });
    });
  });

  it("dispose 委托 provider（幂等）", () => {
    seedCatalog();
    const { r } = makePort();
    expect(() => {
      r!.port.dispose();
      r!.port.dispose();
    }).not.toThrow();
  });

  // ── quota-plan r2 §4 接线清单 3（15.x P7 转入项 4）──
  describe("createCatalogPoolPort 接真实 ExternalCatalog 形状（15.x-4）", () => {
    it("poolOf：factory⇒core、anthropic⇒standard；modelsInPool 过滤；warm() 吞掉 catalog 抛错", () => {
      seedCatalog();
      let threw = false;
      const port = createCatalogPoolPort({
        provider: "droid",
        catalog: () => {
          // 真 ExternalCatalog（经 store 读回的对象在结构上即 CatalogModelLike[]）。
          const cat = CATALOG;
          return { models: cat.models };
        },
        preferred: () => ["glm-5.3"],
      });
      expect(port.poolOf("glm-5.3")).toBe("core");
      expect(port.poolOf("claude-opus-5-5")).toBe("standard");
      expect(port.poolOf("unknown-model")).toBeUndefined();
      expect(port.modelsInPool("core")).toEqual(["glm-5.3"]); // preferred 优先；deprecated/router/custom 已滤
      const boom = createCatalogPoolPort({
        provider: "droid",
        catalog: () => {
          threw = true;
          throw new Error("catalog blew up");
        },
      });
      expect(() => boom.warm()).not.toThrow();
      expect(threw).toBe(true);
    });
  });
});
