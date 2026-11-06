// #36 memory-governance arch r5 §6.1 — the three-tier effective audience.
// ONE verdict source shared by every injection outlet (wire.ts threads it
// into govern/eligibility.ts via `ctx.audienceOf` for block entries and
// applies it directly for files-layout entries):
//
//   1. explicit frontmatter `audience:` wins (blocks: BlockMeta.audience —
//      projected onto MemEntry.inline.audience by blockToEntry; files:
//      the `<!-- mem audience=… -->` inline key);
//   2. otherwise the sidecar tag tier: `type === "rule"` and a
//      `dispatch`/`model-routing` tag with p ≥ 0.7 that is the block's
//      highest-scoring tag ⇒ `main` (dispatch/model-routing rules address the
//      MAIN session's orchestrator — child sessions must not act on them);
//   3. otherwise `all`.
//
// Filtering is two-way (arch §6.1): child sessions drop `main`, main
// sessions drop `child`. `view`/`search` are unaffected (they are explicit
// tool reads, not injection).
//
// P4's write-echo (tool-v3.ts `AUDIENCE_MAIN_HINTS`) is a deterministic
// hint table of its own; P5b will rewire that echo onto THIS module's
// verdict — the single source of truth. (P6b itself does not touch
// tool-v3.ts.)
//
// Pi-free by contract (tests/boundary/pi-free.test.ts); no module-scope
// mutable state (I4).

import type { EntryTags } from "../jev/contracts.js";

export type Audience = "all" | "main" | "child";

/** Tier-2 tag ids that mark a rule as main-session-only when they top the
 *  block's tag scores (arch §6.1). */
export const AUDIENCE_MAIN_TAGS: readonly string[] = ["dispatch", "model-routing"];

/** Tier-2 minimum probability (arch §6.1: "p ≥ 0.7 并且是该块最高分的标签"). */
export const AUDIENCE_MAIN_MIN_P = 0.7;

/** Tier 2 alone: sidecar `type === "rule"` ∧ a {@link AUDIENCE_MAIN_TAGS}
 *  tag with p ≥ {@link AUDIENCE_MAIN_MIN_P} ∧ that p is the highest among
 *  the block's stored tags (ties for top count — "最高分" does not mean
 *  strictly unique). Only p ≥ 0.3 judgments are ever stored, so the max is
 *  over stored tags. */
export function tagInferredAudience(tags: EntryTags | undefined): Audience {
  if (tags?.type !== "rule") return "all";
  let best = 0;
  for (const id of AUDIENCE_MAIN_TAGS) best = Math.max(best, tags.tags[id]?.p ?? 0);
  if (best < AUDIENCE_MAIN_MIN_P) return "all";
  let max = 0;
  for (const v of Object.values(tags.tags)) if (v.p > max) max = v.p;
  return best >= max ? "main" : "all";
}

/** The three-tier verdict (arch §6.1). `frontmatter` is the explicit
 *  `audience:` value when present (`undefined` = not written). */
export function effectiveAudience(frontmatter: Audience | undefined, tags: EntryTags | undefined): Audience {
  if (frontmatter !== undefined) return frontmatter;
  return tagInferredAudience(tags);
}

/** Two-way session filter (arch §6.1 过滤): child sessions drop `main`,
 *  main sessions drop `child`; `all` passes everywhere. */
export function audienceMatches(a: Audience, isChild: boolean): boolean {
  return isChild ? a !== "main" : a !== "child";
}
