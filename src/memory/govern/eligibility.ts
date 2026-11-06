// #36 memory-governance arch r5 §3.3.6 — the ONE eligibility verdict every
// injection outlet shares (review M11). Selection time AND final-commit time
// each call it; the layers that wait on a classifier additionally re-check
// the block `rev` (wire.ts, not here — this file is pure).
//
// Pi-free by contract (tests/boundary/pi-free.test.ts). The Jev-derived half
// of `effectiveAudience` (arch §6.1 tag inference) is P6b's; P3 reads the
// frontmatter only, injected through `ctx.audienceOf`.

import { isExpired, isResident, type ParsedBlock } from "../blocks/format.js";
import { looksSecret } from "../secret-patterns.js";
import type { EntryTags } from "../jev/contracts.js";

/** Every injection outlet: the four recall layers, the compaction re-inject,
 *  predict + its release-state constraint, the resident-change notices, and
 *  the external renderer (arch §3.3.6 接入清单). */
export type EligibilityLayer = "U" | "A" | "E" | "B" | "P" | "S" | "R" | "external";

export interface EligibilityCtx {
  /** `YYYY-MM-DD` local date — agent-block expiry (rule 3) and nothing else. */
  readonly today: string;
  /** True ⇒ audience must be `all`/`child`; false ⇒ `all`/`main` (rule 4). */
  readonly isChild: boolean;
  /** §3.3.5 ledger ids — the resident blocks the model has already been told
   *  about. Rule 6 excludes them from every message layer. */
  readonly ledger: ReadonlySet<string>;
  readonly layer: EligibilityLayer;
  /** P6b extends this with tag-derived audiences; P3's default reads the
   *  frontmatter only (`meta.audience ?? "all"`). */
  readonly audienceOf?: (b: ParsedBlock) => "all" | "main" | "child";
  /** Final-commit re-check: the block file must still exist in `blocks/`.
   *  Selection time (corpus-derived ParsedBlock) omits it — a parsed block
   *  existed by construction; commit time passes a fresh probe. */
  readonly exists?: (id: string) => boolean;
}

export type EligibilityVerdict = { ok: true } | { ok: false; why: string };

/** `effectiveAudience` frontmatter half (arch §6.1): explicit `audience:`
 *  wins, default is `all`. The Jev tag-inference tier (≥0.7 top tag) lands
 *  in P6b via `ctx.audienceOf`. */
export function frontmatterAudience(b: ParsedBlock): "all" | "main" | "child" {
  return b.meta.audience ?? "all";
}

function audienceOf(b: ParsedBlock, ctx: EligibilityCtx): "all" | "main" | "child" {
  return ctx.audienceOf?.(b) ?? frontmatterAudience(b);
}

/** The one verdict, rules in arch order 1–6:
 *  1. active and not superseded;
 *  2. still present in `blocks/` (when `ctx.exists` is supplied);
 *  3. agent blocks never past their `expires` (user rules stay, annotated);
 *  4. audience matches main-vs-child;
 *  5. not private/secret (external + egress-relevant layers included);
 *  6. message layers (U/A/E/B/P/S): id ∉ ledger; R delivers global user
 *     rules only; external renders the resident section + index only. */
export function eligible(b: ParsedBlock, _tags: EntryTags | undefined, ctx: EligibilityCtx): EligibilityVerdict {
  if (b.meta.status !== "active" || b.meta.supersededBy !== undefined) return { ok: false, why: "superseded" };
  if (ctx.exists !== undefined && !ctx.exists(b.id)) return { ok: false, why: "deleted" };
  if (b.meta.authority === "agent" && isExpired(b.meta, ctx.today)) return { ok: false, why: "expired" };
  const audience = audienceOf(b, ctx);
  if (ctx.isChild ? audience === "main" : audience === "child") return { ok: false, why: "audience" };
  if (b.meta.private === true || looksSecret(b.body)) return { ok: false, why: "private" };
  if (ctx.layer === "R") return isResident(b.meta) ? { ok: true } : { ok: false, why: "not-resident" };
  if (ctx.layer === "external") return { ok: true };
  if (ctx.ledger.has(b.id)) return { ok: false, why: "ledger" };
  return { ok: true };
}
