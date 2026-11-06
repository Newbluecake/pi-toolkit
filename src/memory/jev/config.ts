// `resolveJevWiring` — the single "is Jev wired?" verdict (jev-plan §1.1,
// jev-arch §9.2). Pure, synchronous, pi-free.
//
// on ⇔ memory.jev.enabled ∧ layout = tiered ∧ toolSurface = v2 ∧ domain =
// plain ∧ classifiers non-empty. Every other combination is one of the four
// settings-period off reasons; `wireMemory` then never calls `wireJev` and
// passes no jev port to any existing module (I9 — proven by the off golden).
// The runtime-only `off(pi-api)` reason is NOT decided here: it needs a ctx
// (jev/wire.ts decides it per handler call).
//
// Precedence when several hold at once (first match wins): secure → legacy →
// disabled → empty-list. secure first so a vault session always reports the
// I11 reason; legacy before disabled because a legacy layout/tool surface is
// a hard incompatibility while `enabled` is a preference.

import type { MemorySettings } from "../settings.js";
import type { JevConfig } from "./contracts.js";

export type JevDomainKind = "plain" | "secure" | "locked";

export type JevOffReason = "disabled" | "legacy" | "secure" | "empty-list";

export type JevWiring =
  { readonly on: true; readonly config: JevConfig } | { readonly on: false; readonly reason: JevOffReason };

/** #36 P4 修复轮（root 2026-11-06）：jev 允许的布局×工具面组合。v3 块工具
 *  由 `layout:"blocks"` 驱动注册（settings 的 `toolSurface` 键保持 `"v2"`，
 *  `toolSurfaceFor` 只叠加目录判定），故 blocks+v2 与 tiered+v2 同为合法
 *  jev 载体；`layout:"legacy"` 与 `toolSurface:"legacy"`（旧工具）维持互斥。 */
export function jevLayoutAllowed(memory: MemorySettings): boolean {
  return memory.toolSurface === "v2" && (memory.layout === "tiered" || memory.layout === "blocks");
}

/** Map `MemorySettings.jev` (J3) onto the frozen pure `JevConfig` (J1). */
export function jevConfigOf(memory: MemorySettings): JevConfig {
  const jev = memory.jev;
  const seen = new Set<string>();
  const classifiers: string[] = [];
  for (const id of jev.classifiers) {
    if (seen.has(id)) continue;
    seen.add(id);
    classifiers.push(id);
  }
  return {
    classifiers,
    proxy: jev.proxy,
    childSessions: jev.childSessions,
    recall: {
      threshold: jev.recall.threshold,
      maxEntries: jev.recall.maxEntries,
      maxBytes: jev.recall.maxBytes,
      waitMs: jev.recall.waitMs,
    },
    reviewIntervalDays: jev.review.intervalDays,
    maxCostUsd: jev.maxCostUsd,
    maxCalls: jev.maxCalls,
    fastPath: {
      allowTags: jev.fastPathAllowTags,
      denyTags: jev.fastPathDenyTags,
      cooldownMs: jev.fastPathCooldownH * 3_600_000,
    },
    predict: predictConfigOf(memory),
  };
}

/** `memory.jev.predict.*` → `PredictJevConfig` (memory-predict plan §10). */
export function predictConfigOf(memory: MemorySettings): JevConfig["predict"] {
  const p = memory.jev.predict;
  return {
    enabled: p.enabled,
    childSessions: p.childSessions,
    maxEntries: p.maxEntries,
    maxBytes: p.maxBytes,
    cooldownMs: p.cooldownH * 3_600_000,
    hintU: p.hintU,
    model: {
      enabled: p.model.enabled,
      models: p.model.models,
      threshold: p.model.threshold,
      waitMs: p.model.waitMs,
      requestBudgetMs: p.model.requestBudgetMs,
      maxCallsPerDay: p.model.maxCallsPerDay,
      maxUsdPerDay: p.model.maxUsdPerDay,
    },
    cacheTtlMin: p.cacheTtlMin,
  };
}

export function resolveJevWiring(memory: MemorySettings, domainKind: JevDomainKind): JevWiring {
  if (domainKind !== "plain") return { on: false, reason: "secure" };
  if (!jevLayoutAllowed(memory)) return { on: false, reason: "legacy" };
  if (!memory.jev.enabled) return { on: false, reason: "disabled" };
  if (memory.jev.classifiers.length === 0) return { on: false, reason: "empty-list" };
  return { on: true, config: jevConfigOf(memory) };
}
