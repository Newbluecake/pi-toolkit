/**
 * #39 P1 session section: a PURE provider factory for the `pi_session_memory` prompt
 * section (arch §6.7). This module never registers anything — registration into the
 * PromptSectionHub is P4 assembly; P1 ships only the content function so P2/P3/P4 consume
 * a stable seam.
 *
 * LOCKED FIRST: when the host reports the secure domain locked, the provider returns SKIP
 * WITHOUT calling `view()` — the store's view() would refuse to read the branch anyway;
 * here the no-read guarantee is structural (the callback is never invoked). An empty view
 * (no items and no dropped entries) returns "" (successful removal); empty text is skipped
 * by the section hub. A section whose full render would overflow the budget degrades to a
 * pointer stub — the body is never truncated.
 *
 * Pi-free; no module-scope state (the factory closure holds only the deps).
 */
import { SKIP } from "../../prompt-sections/stable-section.js";
import type { SessionMemoryView } from "./types.js";
import { SESSION_MEMORY_RENDER_MAX_BYTES } from "./types.js";
import { utf8Bytes } from "./limits.js";
import {
  fitsRenderBudget,
  renderSessionSection,
  sessionSectionPointer,
  projectedDuplicateMarkers,
  renderSessionItems,
  sessionSectionParts,
  type ThreeLayerDuplicatePlan,
  PRIORITY_NOTE,
} from "./render.js";

export const SESSION_MEMORY_VIEW_HINT = "scoped_memory view";

export interface SessionSectionDeps {
  /** Real-time locked verdict (secure domain); checked BEFORE any view/branch read. */
  readonly isLocked: () => boolean;
  readonly view: () => SessionMemoryView;
  /** Render budget for the full section (default SESSION_MEMORY_RENDER_MAX_BYTES). */
  readonly renderBudgetBytes?: number;
  /** Optional same-turn plan, using this exact view; no project visibility is inferred. */
  readonly projection?: (view: SessionMemoryView) => ThreeLayerDuplicatePlan | undefined;
}

export type SessionSectionContent = string | typeof SKIP;

export function createSessionMemorySection(deps: SessionSectionDeps): () => SessionSectionContent {
  const budget = deps.renderBudgetBytes ?? SESSION_MEMORY_RENDER_MAX_BYTES;
  return () => {
    if (deps.isLocked()) return SKIP;
    const view = deps.view();
    if (view.items.length === 0 && view.dropped.length === 0) return "";
    const plan = deps.projection?.(view);
    let text = renderSessionSection(view);
    if (plan !== undefined) {
      const parts = sessionSectionParts(view);
      const markers = projectedDuplicateMarkers(
        plan,
        "session",
        view.items.map((v) => v.item),
      );
      const body = renderSessionItems(view.items, markers);
      // A mere external full body is not a conflict. Also cover session winners:
      // their marker lives on the other layer, not on the session entry itself.
      const hasConflict =
        markers.some((marker) => marker !== undefined) ||
        plan.candidates.some((candidate, index) => {
          const marker = plan.markers[index];
          return (
            candidate.layer !== "session" &&
            marker?.layer === "session" &&
            plan.candidates.some(
              (winner) =>
                winner.layer === "session" &&
                winner.visibility === "full" &&
                winner.id === marker.id &&
                view.items.some(
                  ({ item }) =>
                    item.id === winner.id && item.text === winner.text && item.authority === winner.authority,
                ),
            )
          );
        });
      text = [parts.header, ...(hasConflict ? [PRIORITY_NOTE] : []), body].filter((line) => line !== "").join("\n");
    }
    if (fitsRenderBudget(text, budget)) return text;
    const over = utf8Bytes(text) - budget;
    return sessionSectionPointer(view.items.length, over, SESSION_MEMORY_VIEW_HINT);
  };
}
