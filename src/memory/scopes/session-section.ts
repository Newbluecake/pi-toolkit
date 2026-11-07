/**
 * #39 P1 session section: a PURE provider factory for the `pi_session_memory` prompt
 * section (arch §6.7). This module never registers anything — registration into the
 * PromptSectionHub is P4 assembly; P1 ships only the content function so P2/P3/P4 consume
 * a stable seam.
 *
 * LOCKED FIRST: when the host reports the secure domain locked, the provider returns SKIP
 * WITHOUT calling `view()` — the store's view() would refuse to read the branch anyway;
 * here the no-read guarantee is structural (the callback is never invoked). An empty view
 * (no items and no dropped entries) never enters the fold (empty text is skipped by the
 * section hub). A section whose full render would overflow the budget degrades to a
 * pointer stub — the body is never truncated.
 *
 * Pi-free; no module-scope state (the factory closure holds only the deps).
 */
import { SKIP } from "../../prompt-sections/stable-section.js";
import type { SessionMemoryView } from "./types.js";
import { SESSION_MEMORY_RENDER_MAX_BYTES } from "./types.js";
import { utf8Bytes } from "./limits.js";
import { fitsRenderBudget, renderSessionSection, sessionSectionPointer } from "./render.js";

export const SESSION_MEMORY_VIEW_HINT = "scoped_memory view";

export interface SessionSectionDeps {
  /** Real-time locked verdict (secure domain); checked BEFORE any view/branch read. */
  readonly isLocked: () => boolean;
  readonly view: () => SessionMemoryView;
  /** Render budget for the full section (default SESSION_MEMORY_RENDER_MAX_BYTES). */
  readonly renderBudgetBytes?: number;
}

export type SessionSectionContent = string | typeof SKIP;

export function createSessionMemorySection(deps: SessionSectionDeps): () => SessionSectionContent {
  const budget = deps.renderBudgetBytes ?? SESSION_MEMORY_RENDER_MAX_BYTES;
  return () => {
    if (deps.isLocked()) return SKIP;
    const view = deps.view();
    if (view.items.length === 0 && view.dropped.length === 0) return SKIP;
    const text = renderSessionSection(view);
    if (fitsRenderBudget(text, budget)) return text;
    const over = utf8Bytes(text) - budget;
    return sessionSectionPointer(view.items.length, over, SESSION_MEMORY_VIEW_HINT);
  };
}
