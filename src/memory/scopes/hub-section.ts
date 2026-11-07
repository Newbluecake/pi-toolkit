/**
 * #39 P3a hub section: a PURE provider factory for the `pi_hub_memory` prompt section
 * (arch §6.7). Mirrors session-section.ts: registration into the PromptSectionHub is P4
 * assembly — this module ships only the content function. Snapshot refresh per agent
 * start is P4; here `view()` is consulted immediately per call (no poll timer, I5).
 *
 * LOCKED / disabled / inert / absent first: SKIP WITHOUT calling `view()` when locked
 * (no disk touch), SKIP for a non-ok view (nothing to inject, no partial provenance).
 * The full view is never truncated: an over-budget section degrades to a pointer stub.
 * Cross-layer dedup reuses P1's authority-first `crossLayerDupMarkers` — a hub user entry
 * can never be shadowed by a session agent entry and vice-versa per §6.7.
 *
 * Pi-free; no module-scope mutable state (I4); default-off byte identity is untouched
 * (nothing here is registered anywhere by P3a).
 */
import { SKIP } from "../../prompt-sections/stable-section.js";
import type { FoldedSessionItem, HubItem, HubMemoryView } from "./types.js";
import { HUB_MEMORY_RENDER_MAX_BYTES } from "./types.js";
import { utf8Bytes } from "./limits.js";
import { crossLayerDupMarkers, renderHubItems } from "./render.js";

export const HUB_MEMORY_VIEW_HINT = "scoped_memory view";

export interface HubSectionDeps {
  /** Real-time locked verdict (secure domain); checked BEFORE any view/disk read. */
  readonly isLocked: () => boolean;
  readonly view: () => HubMemoryView;
  /** Session items for cross-layer dedup markers (optional: absent ⇒ plain hub body). */
  readonly sessionItems?: () => readonly FoldedSessionItem[];
  /** Marks hub items whose `src.project` equals this slug as `src=this-project`. */
  readonly currentProjectSlug?: () => string;
  /** Render budget for the full section (default HUB_MEMORY_RENDER_MAX_BYTES). */
  readonly renderBudgetBytes?: number;
}

export type HubSectionContent = string | typeof SKIP;

function hubSectionPointer(count: number, overBytes: number): string {
  return `Hub memory: ${count} entries · render ${overBytes}B over budget — use ${HUB_MEMORY_VIEW_HINT}`;
}

export function createHubMemorySection(deps: HubSectionDeps): () => HubSectionContent {
  const budget = deps.renderBudgetBytes ?? HUB_MEMORY_RENDER_MAX_BYTES;
  return () => {
    if (deps.isLocked()) return SKIP;
    const view = deps.view();
    if (view.state !== "ok" || view.items.length === 0) return SKIP;
    const slug = deps.currentProjectSlug?.() ?? "";
    const items: readonly HubItem[] = view.items.map((item) =>
      item.src.project === slug ? { ...item, src: { ...item.src, project: "" } } : item,
    );
    const session = deps.sessionItems?.() ?? [];
    const dup = session.length > 0 ? crossLayerDupMarkers(session, items) : undefined;
    const header = "Hub memory (shared by all projects of this hub)";
    const body = renderHubItems(items, dup?.hub);
    const text = body === "" ? header : `${header}\n${body}`;
    if (utf8Bytes(text) <= budget) return text;
    return hubSectionPointer(items.length, utf8Bytes(text) - budget);
  };
}
