// Baseline E candidate predicate, extracted verbatim from wire.ts at 4969929f.
// Pi-free; no I/O, semantic gate, taxonomy changes or module-scope state.
import type { EffectiveMeta } from "./contracts.js";

/** Already-effective metadata, not raw sidecar tags. Frozen P0 input contract. */
export type ErrorRelevanceMeta = Pick<EffectiveMeta, "pending" | "tags" | "type">;

/** Optional offline evidence. Missing historical inputs must remain unknown;
 * current sidecars are not substitutes for selection-time metadata. */
export interface ErrorRelevanceSnapshotV1 {
  readonly v: 1;
  readonly id: string;
  readonly provenance: string;
  readonly meta: ErrorRelevanceMeta;
  readonly hitTags: readonly string[];
  readonly highRiskTagIds: readonly string[];
}

/** Legacy candidate eligibility only, NOT a classifier/injection decision.
 * Keep this baseline callable unchanged when later semantic gates are added. */
export function legacyErrorCandidateAllowed(
  meta: ErrorRelevanceMeta,
  hit: ReadonlySet<string>,
  highRiskTagIds: ReadonlySet<string>,
): boolean {
  // Pending entries (no sidecar record yet) have no known type — they stay
  // candidates rather than being silently excluded (untagged corpora
  // would otherwise never get E recall).
  if (
    !meta.pending &&
    meta.tags.length > 0 &&
    meta.tags.every((t) => highRiskTagIds.has(t)) &&
    !meta.tags.some((t) => hit.has(t))
  ) {
    return false; // #36 §6.3：纯高危动作类标签且与失败命令无交集
  }
  return meta.pending || meta.type === "pitfall" || meta.type === "procedure" || meta.tags.some((t) => hit.has(t));
}
