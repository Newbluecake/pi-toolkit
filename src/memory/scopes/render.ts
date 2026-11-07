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
