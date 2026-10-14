import type { ExternalMetaPatch, ExternalRunMeta, UsageDelta } from "./types.js";

/**
 * 外部 agent（external-agent plan §2.2，冻结面）：`ExternalRunMeta.degraded` 的合并上限。
 */
export const EXTERNAL_DEGRADED_CAP = 16;

/**
 * external-agent plan §2.2：reducer 的 external_meta 合并规则 ——
 * - 普通字段（provider/sessionId/autonomy/protocolVersion/agentVersion/
 *   nativeSessionFile/reconciled 等）last-wins（patch 未携带的键保留原值）；
 * - credits/thinkingTokens/childTokens/permissionApprovals/unknownNotifications 取 max；
 * - degraded 并集（保序去重、上限 EXTERNAL_DEGRADED_CAP，超出截尾保留最新）；
 * - pricing 只升不降：priced < partial < unpriced（status 取较差者，其余字段随之——
 *   同档时 patch 的整体胜出，即同档 last-wins）。
 * 纯函数；patch 形状不合法的键被忽略（防御，不 throw）。
 */
export function mergeExternalMeta(prev: ExternalRunMeta | undefined, patch: ExternalMetaPatch): ExternalRunMeta {
  const base: ExternalRunMeta = prev ?? { provider: patch.provider };
  const next: ExternalRunMeta = { ...base };
  if (typeof patch.provider === "string") next.provider = patch.provider;
  if (typeof patch.sessionId === "string") next.sessionId = patch.sessionId;
  if (typeof patch.autonomy === "string") next.autonomy = patch.autonomy;
  if (typeof patch.protocolVersion === "string") next.protocolVersion = patch.protocolVersion;
  if (typeof patch.agentVersion === "string") next.agentVersion = patch.agentVersion;
  if (typeof patch.nativeSessionFile === "string") next.nativeSessionFile = patch.nativeSessionFile;
  if (patch.reconciled === true) next.reconciled = true;
  const takeMax = (
    key: "credits" | "thinkingTokens" | "childTokens" | "permissionApprovals" | "unknownNotifications",
  ) => {
    const p = patch[key];
    if (typeof p === "number" && Number.isFinite(p)) {
      const b = base[key];
      if (typeof b === "number" && Number.isFinite(b)) {
        if (p > b) next[key] = p;
      } else {
        next[key] = p;
      }
    }
  };
  takeMax("credits");
  takeMax("thinkingTokens");
  takeMax("childTokens");
  takeMax("permissionApprovals");
  takeMax("unknownNotifications");
  // degraded 并集：保序去重，上限 EXTERNAL_DEGRADED_CAP（超出截尾，丢最早进入的）。
  if (Array.isArray(patch.degraded)) {
    const seen = new Set<string>(base.degraded ?? []);
    const merged = [...(base.degraded ?? [])];
    for (const item of patch.degraded) {
      if (typeof item !== "string" || item === "" || seen.has(item)) continue;
      seen.add(item);
      merged.push(item);
    }
    next.degraded =
      merged.length > EXTERNAL_DEGRADED_CAP ? merged.slice(merged.length - EXTERNAL_DEGRADED_CAP) : merged;
  }
  // pricing 只升不降：rank 越大越差（priced=0 < partial=1 < unpriced=2）；较差者胜出，
  // 其余字段随之；同档时 patch 的整体胜出（last-wins）。形状非法的 patch.pricing 忽略。
  if (patch.pricing !== undefined && typeof patch.pricing === "object") {
    const rank = (p: ExternalRunMeta["pricing"]): number => {
      if (p === undefined || p === null || typeof p !== "object") return -1;
      const s = (p as { status?: unknown }).status;
      if (s === "unpriced") return 2;
      if (s === "partial") return 1;
      if (s === "priced") return 0;
      return -1;
    };
    if (rank(patch.pricing) >= rank(base.pricing)) next.pricing = patch.pricing;
  }
  return next;
}

/**
 * external-agent plan §2.2（review #10）：`UsageDelta.unpriced` 的累加合并 ——
 * prev 为 undefined（首个增量）⇒ 取 delta 的；两者相同 ⇒ 不变；否则 ⇒ "partial"；
 * 两者都无 ⇒ undefined。pi 驱动永不设置 unpriced ⇒ pi run 的 usage 永无此键。
 */
export function mergeUnpriced(prev: UsageDelta | undefined, delta: UsageDelta): UsageDelta["unpriced"] {
  if (prev === undefined) return delta.unpriced;
  if (prev.unpriced === undefined && delta.unpriced === undefined) return undefined;
  if (prev.unpriced === delta.unpriced) return prev.unpriced;
  return "partial";
}
