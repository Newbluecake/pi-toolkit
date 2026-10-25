/**
 * headerFold.ts — issue #41 (detail titlebar narrow-screen overflow), pure decision core.
 *
 * The detail titlebar is a flex row whose right-side action buttons are gated by six
 * independent cap/state computeds and whose label widths shift with i18n and `--fs-scale`, so
 * no fixed breakpoint can decide when the row overflows. Instead `DetailHeader.vue` MEASURES
 * the rendered children (ResizeObserver on the bar) and hands the numbers here; this function
 * answers which buttons fold into the 「⋯」 menu and whether the alias chip / status pill
 * degrade to their minimal forms — while guaranteeing the title keeps `titleMin` px of
 * clickable width.
 *
 * Fold priority (lowest frequency first, user-confirmed in the preview
 * /tmp/detail-header-overflow-preview.html): privacy → schedule → resume → channels → stop →
 * clear. Note the FIRST fold nets zero or negative (the ⋯ trigger takes a slot of its own) —
 * the greedy loop simply continues until the row fits or everything is folded, so a
 * one-button deficit folds two.
 *
 * Degradation ladder after all buttons are folded: ① alias chip → bare 「@」 button, ② status
 * pill → bare dot. Neither ever enters the menu (they are state displays, not actions); the
 * unread chip never degrades either (its width is folded into `fixedSlots` by the caller).
 *
 * Hysteresis: TIGHTENING applies immediately; RELAXING to a less-folded state requires
 * `hysteresis` px of slack beyond the fit point so the boundary doesn't flicker on a 1px
 * resize. A prev state carrying ids that are no longer foldable (cap toggled off) is never
 * resurrected — the fresh computation wins.
 */

export type TitlebarFoldId = "privacy" | "schedule" | "resume" | "channels" | "stop" | "clear";

/** Fold order: the FIRST entry folds first (lowest-frequency action). Frozen by tests. */
export const TITLEBAR_FOLD_ORDER: readonly TitlebarFoldId[] = [
  "privacy",
  "schedule",
  "resume",
  "channels",
  "stop",
  "clear",
];

/**
 * The icon tier's breakpoint — the single source of truth for BOTH the TS measurer
 * (DetailHeader.vue's gap switch) and the tests that pin the CSS copy
 * (`@container detail-titlebar (max-width: 599px)` in styles/detail.css) to the same value.
 */
export const TITLEBAR_ICON_TIER_MAX_PX = 599;

export interface TitlebarFoldItem {
  readonly id: TitlebarFoldId;
  /** Rendered button width in px (gap NOT included — the function adds it). */
  readonly width: number;
}

export interface TitlebarFoldState {
  /** Ids currently folded into the 「⋯」 menu (subset of `items`, in fold order). */
  readonly folded: readonly TitlebarFoldId[];
  /** Alias chip renders as the bare 「@」 glyph button. */
  readonly aliasGlyph: boolean;
  /** Status pill renders as the bare dot (role=img + aria-label carry the state). */
  readonly pillDot: boolean;
}

export interface TitlebarFoldInput {
  /** Content-box width of the titlebar. ≤ 0 (hidden / unlaid-out) ⇒ keep `prev` / empty. */
  readonly barWidth: number;
  /** Minimum clickable title width; default 96 (user-confirmed floor). */
  readonly titleMin?: number;
  /** The bar's CURRENT effective flex gap (the CSS compacts 8 → 4 at ≤599px). */
  readonly gap: number;
  /** Width + one gap of the 「⋯」 trigger, charged whenever ≥1 button is folded. */
  readonly moreSlot: number;
  /** Σ(width+gap) of every non-foldable, non-title, non-alias, non-pill child (back/drawer
   *  buttons, unread chip, restoring chip, the transient stop-armed/busy pill…). */
  readonly fixedSlots: number;
  /** Alias chip slot (width+gap) in FULL form; 0/omitted = no alias chip. */
  readonly aliasFull?: number;
  /** Alias chip slot in degraded 「@」-glyph form; default 26. */
  readonly aliasGlyphSlot?: number;
  /** Status pill slot (width+gap) in full form. */
  readonly pillFull: number;
  /** Status pill slot in degraded dot-only form; default 24. */
  readonly pillDotSlot?: number;
  /** Present foldable buttons, IN FOLD-PRIORITY ORDER (first = first to fold). */
  readonly items: readonly TitlebarFoldItem[];
  /** Slack in px required to RELAX vs `prev`; default 0. */
  readonly hysteresis?: number;
  /** Previous state (for hysteresis); omitted = no stickiness. */
  readonly prev?: TitlebarFoldState;
}

const EMPTY: TitlebarFoldState = { folded: [], aliasGlyph: false, pillDot: false };

/** Content width the row needs under the given fold state (title kept at its floor). */
function needed(input: TitlebarFoldInput, titleMin: number, s: TitlebarFoldState): number {
  const folded = new Set(s.folded);
  let sum = titleMin + input.gap + input.fixedSlots;
  sum += s.aliasGlyph ? (input.aliasGlyphSlot ?? 26) : (input.aliasFull ?? 0);
  sum += s.pillDot ? (input.pillDotSlot ?? 24) : input.pillFull;
  for (const item of input.items) if (!folded.has(item.id)) sum += item.width + input.gap;
  if (s.folded.length > 0) sum += input.moreSlot;
  return sum;
}

function compute(input: TitlebarFoldInput, titleMin: number): TitlebarFoldState {
  const folded: TitlebarFoldId[] = [];
  const fits = (aliasGlyph: boolean, pillDot: boolean): boolean =>
    needed(input, titleMin, { folded, aliasGlyph, pillDot }) <= input.barWidth;
  for (const item of input.items) {
    if (fits(false, false)) break;
    folded.push(item.id);
  }
  const aliasGlyph = !fits(false, false) && (input.aliasFull ?? 0) > (input.aliasGlyphSlot ?? 26);
  const pillDot = !fits(aliasGlyph, false) && input.pillFull > (input.pillDotSlot ?? 24);
  return { folded, aliasGlyph, pillDot };
}

function sameState(a: TitlebarFoldState, b: TitlebarFoldState): boolean {
  return (
    a.aliasGlyph === b.aliasGlyph &&
    a.pillDot === b.pillDot &&
    a.folded.length === b.folded.length &&
    a.folded.every((id, i) => id === b.folded[i])
  );
}

/** `next` is LESS compressed than `prev` (fewer folds or fewer degradations)? */
function isRelaxation(prev: TitlebarFoldState, next: TitlebarFoldState): boolean {
  return (
    next.folded.length < prev.folded.length ||
    (next.folded.length === prev.folded.length && Number(next.aliasGlyph) < Number(prev.aliasGlyph)) ||
    (next.folded.length === prev.folded.length &&
      next.aliasGlyph === prev.aliasGlyph &&
      Number(next.pillDot) < Number(prev.pillDot))
  );
}

export function foldTitlebar(input: TitlebarFoldInput): TitlebarFoldState {
  const prev = input.prev;
  if (!(input.barWidth > 0)) return prev ?? EMPTY; // hidden / no layout: keep as-was
  const titleMin = input.titleMin ?? 96;
  const next = compute(input, titleMin);
  const hysteresis = input.hysteresis ?? 0;
  if (prev !== undefined && hysteresis > 0 && !sameState(prev, next) && isRelaxation(prev, next)) {
    // Never resurrect a fold whose button left the bar (cap toggled off).
    const present = new Set(input.items.map((i) => i.id));
    if (prev.folded.every((id) => present.has(id))) {
      if (needed(input, titleMin, next) + hysteresis > input.barWidth) return prev;
    }
  }
  return next;
}
