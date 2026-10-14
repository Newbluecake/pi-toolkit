/**
 * 池映射（docs/dev/external-agent/quota-plan.md r2 §2.3 / §4，pi-free，P5 消费）：
 * droid 模型 id → Factory 计费池（standard / core）。
 *
 * v1 的池来源（K1：droid 0.241.1 的两条目录来源都不带 `billingPool`，SP1 阴性）：
 * settings 覆盖（service 层 `quota.droidPools` 优先，见 §5）> 目录条目里结构性存在
 * 的 `billingPool`（只为前向兼容，K1 下恒缺席）> D4 启发式（本文件 `derivePool`）。
 *
 * `ExternalCatalog`（src/external-agent/types.ts）在结构上满足
 * `{ models: readonly CatalogModelLike[] }`，quota 不需要 import external-agent。
 */

import type { QuotaPoolId, QuotaPoolPort } from "./types.js";

export interface CatalogModelLike {
  id: string;
  upstreamProvider?: string;
  kind?: string;
  deprecated?: boolean;
  billingPool?: unknown;
}

/**
 * D4 启发式（纯函数）：
 * - `custom:` ⇒ `"none"`（BYOK 不计费）；
 * - 目录条目结构性 `billingPool ∈ {standard,core}` ⇒ 它（前向兼容，K1 下恒缺席）；
 * - `kind === "router"` ⇒ undefined（auto 这类路由模型不知落到哪池）；
 * - `upstreamProvider`：`factory` ⇒ `"core"`；`anthropic|openai|google|xai` ⇒
 *   `"standard"`（K2：二进制注册表里 glm/kimi/deepseek/… 是 core，Anthropic/OpenAI
 *   默认块是 standard）；其余 ⇒ undefined。
 * 启发式可能误判（inkling/qwen/muse-spark 在二进制里没查到池，R1）——靠
 * `quota.droidPools` 覆盖兜底（service 层，覆盖同时作用于判定与替代建议）。
 */
export function derivePool(info: CatalogModelLike | undefined, modelId: string): QuotaPoolId | "none" | undefined {
  if (modelId.startsWith("custom:")) return "none";
  if (info === undefined) return undefined;
  if (info.billingPool === "standard" || info.billingPool === "core") return info.billingPool;
  if (info.kind === "router") return undefined;
  const upstream = info.upstreamProvider;
  if (upstream === "factory") return "core";
  if (upstream === "anthropic" || upstream === "openai" || upstream === "google" || upstream === "xai") {
    return "standard";
  }
  return undefined;
}

export interface CatalogPoolPort extends QuotaPoolPort {
  /** 调一次 catalog()，吞掉一切异常；stack 构建时由 P5 调用（评审 #3：把首次 ≤256KiB
   *  磁盘读挪出 spawn 准入热路径）。幂等——重复调用不再触碰 catalog。 */
  warm(): void;
  /**
   * service 减法过滤用（§5.6：「目录里标 deprecated 或 router 的」要从替代候选里
   * 剔除——含被 `quota.droidPools` 改判进 core 的目录内模型）：返回目录条目原始
   * 信息；目录缺席/查不到 ⇒ undefined（覆盖键查不到时保留，视为用户明确意图）。
   */
  infoOf(modelId: string): CatalogModelLike | undefined;
}

/**
 * 每次调用现读 catalog（同步）；catalog 抛错/缺席 ⇒ `poolOf` 走
 * `derivePool(undefined, id)`（只剩 `custom:` 判定），`modelsInPool` 返回 []。
 * 永不抛。
 */
export function createCatalogPoolPort(o: {
  provider: string; // "droid"
  catalog: () => { readonly models: readonly CatalogModelLike[] } | undefined;
  preferred?: (() => readonly string[]) | undefined; // externalAgents.droid.models
}): CatalogPoolPort {
  const readCatalog = (): { readonly models: readonly CatalogModelLike[] } | undefined => {
    try {
      return o.catalog();
    } catch {
      return undefined; // 端口契约：永不抛
    }
  };
  const readPreferred = (): readonly string[] => {
    try {
      return o.preferred?.() ?? [];
    } catch {
      return [];
    }
  };
  let warmed = false;
  const find = (modelId: string): CatalogModelLike | undefined => {
    const catalog = readCatalog();
    return catalog?.models.find((m) => m.id === modelId);
  };
  return {
    provider: o.provider,
    poolOf(modelId) {
      return derivePool(find(modelId), modelId);
    },
    modelsInPool(pool) {
      const catalog = readCatalog();
      if (catalog === undefined) return [];
      // 推荐面过滤（§2.1）：deprecated / router / custom: 不推荐。
      const recommendable = (m: CatalogModelLike): boolean =>
        m.deprecated !== true && m.kind !== "router" && !m.id.startsWith("custom:") && derivePool(m, m.id) === pool;
      const byId = new Map(catalog.models.map((m) => [m.id, m]));
      const out: string[] = [];
      const seen = new Set<string>();
      // 偏好序在前（externalAgents.droid.models），目录序在后（D7）。
      for (const id of readPreferred()) {
        const m = byId.get(id);
        if (m !== undefined && recommendable(m) && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      for (const m of catalog.models) {
        if (recommendable(m) && !seen.has(m.id)) {
          seen.add(m.id);
          out.push(m.id);
        }
      }
      return out;
    },
    warm() {
      if (warmed) return;
      warmed = true;
      readCatalog(); // 吞掉一切异常；只为触发底层缓存的首次有界读。
    },
    infoOf(modelId) {
      return find(modelId);
    },
  };
}
