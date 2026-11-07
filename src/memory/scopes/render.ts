/**
 * #39 P1 render: the two injected sections' content and the cross-layer dedup/priority
 * rules (arch §6.7). Pure functions over validated views — no I/O, no model calls.
 *
 * - Priority: REAL authority first (user > agent — the authority field comes from host
 *   judgment, never from a literal), then specificity (session > project > hub). A session
 *   agent entry can never shadow a hub user entry.
 * - Dedup: body normalized (NFKC, whitespace compressed, inline `<!-- … -->` meta stripped)
 *   then sha1'd; duplicates keep the highest-authority copy, ties keep the most specific
 *   layer, the losers render with a `(dup of …)` marker. Semantic dedup does not exist.
 * - Markers are compact English tokens (repo UI-text split); prose stays out of the section.
 * - Render budgets count the FINAL rendered UTF-8 (the formula is only the bound); a section
 *   over budget degrades to a pointer stub via session-section.ts, the full `view` is never
 *   truncated.
 */
import type { FoldedSessionItem, HubItem } from "./types.js";
import { sha1Hex, utf8Bytes } from "./limits.js";

const INLINE_META_RE = /<!--[^>]*?-->/g;

/** Normalized-body dedup key (NFKC + whitespace compression + inline-meta strip). */
export function dedupeKeyOf(text: string): string {
  const normalized = text.normalize("NFKC").replace(INLINE_META_RE, "").replace(/\s+/g, " ").trim();
  return sha1Hex(normalized);
}

export type LayerAuthority = "user" | "agent";
export type LayerSpecificity = "session" | "project" | "hub";

export const authorityRank = (authority: LayerAuthority): number => (authority === "user" ? 1 : 0);
export const specificityRank = (layer: LayerSpecificity): number =>
  layer === "session" ? 2 : layer === "project" ? 1 : 0;

export interface DupMarker {
  readonly layer: LayerSpecificity;
  readonly id: string;
}

/**
 * Cross-layer dedup: for every normalized-body collision, keep ONE copy (highest real
 * authority; ties → most specific layer) and return `(dup of …)` markers for the losers.
 * `hubIds` are hub ids like `general.002` — markers render as `dup of hub general.002`.
 */
export function crossLayerDupMarkers(
  session: readonly FoldedSessionItem[],
  hub: readonly HubItem[],
): { session: (DupMarker | undefined)[]; hub: (DupMarker | undefined)[] } {
  interface Candidate {
    layer: LayerSpecificity;
    id: string;
    authority: LayerAuthority;
    key: string;
  }
  const candidates: Candidate[] = [
    ...session.map((folded) => ({
      layer: "session" as const,
      id: folded.item.id,
      authority: folded.item.authority,
      key: dedupeKeyOf(folded.item.text),
    })),
    ...hub.map((item) => ({
      layer: "hub" as const,
      id: item.id,
      authority: item.authority as LayerAuthority,
      key: dedupeKeyOf(item.text),
    })),
  ];
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byKey.get(candidate.key) ?? [];
    bucket.push(candidate);
    byKey.set(candidate.key, bucket);
  }
  const sessionMarkers: (DupMarker | undefined)[] = new Array(session.length).fill(undefined);
  const hubMarkers: (DupMarker | undefined)[] = new Array(hub.length).fill(undefined);
  for (const bucket of byKey.values()) {
    if (bucket.length < 2) continue;
    const winner = [...bucket].sort(
      (a, b) =>
        authorityRank(b.authority) - authorityRank(a.authority) || specificityRank(b.layer) - specificityRank(a.layer),
    )[0];
    if (winner === undefined) continue;
    for (const loser of bucket) {
      if (loser === winner) continue;
      const marker: DupMarker = { layer: winner.layer, id: winner.id };
      if (loser.layer === "session") {
        const index = session.findIndex((folded, i) => sessionMarkers[i] === undefined && folded.item.id === loser.id);
        if (index >= 0) sessionMarkers[index] = marker;
      } else {
        const index = hub.findIndex((item, i) => hubMarkers[i] === undefined && item.id === loser.id);
        if (index >= 0) hubMarkers[index] = marker;
      }
    }
  }
  return { session: sessionMarkers, hub: hubMarkers };
}

const sid8 = (sid: string): string => sid.slice(0, 8);

const inheritedSuffix = (folded: FoldedSessionItem): string => {
  if (folded.inherited === undefined) return "";
  if (folded.inherited.kind === "spawn") {
    const at = folded.inherited.frozenAt !== undefined ? folded.inherited.frozenAt.slice(11, 16) : "";
    return ` (inherited · parent ${sid8(folded.inherited.fromSid)}${at !== "" ? ` @ ${at}` : ""})`;
  }
  return ` (inherited · fork ${sid8(folded.inherited.fromSid)})`;
};

/** Session section body (without the header line). */
export function renderSessionItems(
  items: readonly FoldedSessionItem[],
  dupMarkers?: readonly (DupMarker | undefined)[],
): string {
  return items
    .map((folded, index) => {
      const dup = dupMarkers?.[index];
      const dupSuffix = dup !== undefined ? ` (dup of ${dup.layer} ${dup.id})` : "";
      return `- ${folded.item.id} ${folded.item.authority}${inheritedSuffix(folded)}${dupSuffix}: ${folded.item.text}`;
    })
    .join("\n");
}

/** Hub section body — hub items are always `user` authority with a source marker. */
export function renderHubItems(items: readonly HubItem[], dupMarkers?: readonly (DupMarker | undefined)[]): string {
  return items
    .map((item, index) => {
      const dup = dupMarkers?.[index];
      const dupSuffix = dup !== undefined ? ` (dup of ${dup.layer} ${dup.id})` : "";
      const source = item.src.project === "" ? "src=this-project" : `src=other#${item.src.project.slice(0, 6)}`;
      return `- ${item.id} user ${source}${dupSuffix}: ${item.text}`;
    })
    .join("\n");
}

/** One-line priority note for when both layers are non-empty (arch §6.7). */
export const PRIORITY_NOTE = "priority: user entries outrank agent entries; at equal authority session > project > hub";

export interface SessionSectionParts {
  readonly header: string;
  readonly priorityNote?: string;
  readonly body: string;
}

export function sessionSectionParts(
  view: { items: readonly FoldedSessionItem[]; dropped: readonly { entryId: string; reason: string }[] },
  hubItems: readonly HubItem[] = [],
): SessionSectionParts {
  const droppedSuffix = view.dropped.length > 0 ? ` · dropped ${view.dropped.length}` : "";
  const header = `Session memory${droppedSuffix}`;
  const dup = crossLayerDupMarkers(view.items, hubItems);
  const body = renderSessionItems(view.items, dup.session);
  const priorityNote = view.items.length > 0 && hubItems.length > 0 ? PRIORITY_NOTE : undefined;
  return { header, ...(priorityNote !== undefined ? { priorityNote } : {}), body };
}

export const renderSessionSection = (
  view: Parameters<typeof sessionSectionParts>[0],
  hubItems?: readonly HubItem[],
): string => {
  const parts = sessionSectionParts(view, hubItems);
  return [parts.header, ...(parts.priorityNote !== undefined ? [parts.priorityNote] : []), parts.body]
    .filter((line) => line !== "")
    .join("\n");
};

export const fitsRenderBudget = (text: string, capBytes: number): boolean => utf8Bytes(text) <= capBytes;

/** Pointer stub when the full section would overflow the render budget (never truncate). */
export function sessionSectionPointer(count: number, overBytes: number, hint: string): string {
  return `Session memory: ${count} entries · render ${overBytes}B over budget — use ${hint}`;
}
/** Pure visible-input DTO. Hosts MUST omit private/hidden entries before construction.
 * `full` means actually admitted body text, not a file/index pointer. In particular,
 * this kernel does not invent a project visibility manifest (P4a2 owns projection).
 */
export interface ThreeLayerDuplicateCandidate {
  readonly layer: LayerSpecificity;
  readonly id: string;
  readonly authority: LayerAuthority;
  readonly text: string;
  readonly visibility: "full" | "index";
}

export interface ThreeLayerDuplicatePlan {
  readonly candidates: readonly ThreeLayerDuplicateCandidate[];
  /** Parallel to candidates; markers annotate, never replace/truncate raw bodies. */
  readonly markers: readonly (DupMarker | undefined)[];
  /**
   * For THIS plan's same-key candidates, the maximum UTF-8 suffix bytes this entry
   * could carry AS A LOSER, considering other full candidates (never itself).
   * A single full entry therefore has bound 0; a current winner's bound may be
   * nonzero, but its actual marker costs 0. This is not a global reservation for
   * future/new candidates or another plan. P4a2 cached prepared projections MUST
   * independently reserve future markers using legal anchor size limits.
   * Sum EVERY admitted entry's bound, not one marker per layer. Includes the
   * leading space/parentheses; final UTF-8 admission also counts bodies/headers/newlines.
   */
  readonly markerMaxBytes: readonly number[];
}

const duplicateSuffix = (marker: DupMarker): string => ` (dup of ${marker.layer} ${marker.id})`;

/** Exact UTF-8 upper bound for one marker suffix, including its separator. */
export const duplicateMarkerUtf8Bytes = (marker: DupMarker): number => utf8Bytes(duplicateSuffix(marker));

/**
 * Append-only three-layer planner. Only actual full bodies can win. Authority first,
 * then specificity, then code-unit id order (locale independent), then input position
 * for otherwise identical DTOs. Output is aligned with input, without mutating it.
 * No I/O, store view conversion, registration or project visibility inference.
 */
export function planThreeLayerDuplicates(candidates: readonly ThreeLayerDuplicateCandidate[]): ThreeLayerDuplicatePlan {
  const keys = candidates.map((candidate) => dedupeKeyOf(candidate.text));
  const markers: (DupMarker | undefined)[] = candidates.map(() => undefined);
  const markerMaxBytes: number[] = candidates.map(() => 0);
  const buckets = new Map<string, number[]>();
  for (const [index, key] of keys.entries()) {
    const bucket = buckets.get(key) ?? [];
    bucket.push(index);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) {
    const full = bucket.filter((index) => candidates[index]?.visibility === "full");
    full.sort((a, b) => {
      const left = candidates[a]!;
      const right = candidates[b]!;
      return (
        authorityRank(right.authority) - authorityRank(left.authority) ||
        specificityRank(right.layer) - specificityRank(left.layer) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) ||
        a - b
      );
    });
    const winnerIndex = full[0];
    if (winnerIndex === undefined) continue;
    const winner = candidates[winnerIndex]!;
    for (const index of bucket) {
      markerMaxBytes[index] = full.reduce((max, other) => {
        if (other === index) return max;
        return Math.max(max, duplicateMarkerUtf8Bytes(candidates[other]!));
      }, 0);
      if (index !== winnerIndex) markers[index] = { layer: winner.layer, id: winner.id };
    }
  }
  return {
    candidates: candidates.map(({ layer, id, authority, text, visibility }) => ({
      layer,
      id,
      authority,
      text,
      visibility,
    })),
    markers,
    markerMaxBytes,
  };
}

/**
 * Optional same-turn consumer seam. The host supplies a plan built from the SAME
 * views and actual visibility used for this turn. Unknown other layers are omitted,
 * not fabricated as full. Exact body/authority matching avoids annotating stale DTOs.
 * This never changes the underlying view or removes its raw text.
 */
export function projectedDuplicateMarkers(
  plan: ThreeLayerDuplicatePlan,
  layer: LayerSpecificity,
  items: readonly { readonly id: string; readonly text: string; readonly authority: LayerAuthority }[],
): readonly (DupMarker | undefined)[] {
  return items.map((item) => {
    const index = plan.candidates.findIndex(
      (candidate) =>
        candidate.layer === layer &&
        candidate.id === item.id &&
        candidate.text === item.text &&
        candidate.authority === item.authority &&
        candidate.visibility === "full",
    );
    return index < 0 ? undefined : plan.markers[index];
  });
}
