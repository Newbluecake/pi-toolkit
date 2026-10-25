// @vitest-environment happy-dom
/**
 * `logic/headerFold.ts` — issue #41 (detail titlebar narrow-screen overflow): the pure fold
 * decision behind DetailHeader's 「⋯」 overflow menu. Inputs are MEASURED widths (the button set
 * changes with six cap gates and label widths change with i18n / --fs-scale, so fixed
 * breakpoints can never be right); the bar folds buttons into the menu in a fixed priority
 * (privacy → schedule → resume → channels → stop → clear — lowest frequency first), degrades
 * the alias chip to a bare 「@」 glyph and the status pill to a bare dot when even that is not
 * enough, and never lets the title drop below `titleMin` (96px). Hysteresis keeps the boundary
 * from flickering: relaxing to a LESS folded state needs extra slack.
 */
import { describe, expect, it } from "vitest";
import {
  foldTitlebar,
  TITLEBAR_FOLD_ORDER,
  type TitlebarFoldInput,
  type TitlebarFoldState,
} from "../../../src/web-hub/ui/src/logic/headerFold.js";

/** Reference geometry mirroring the 390px phone tier (icon-only buttons, compact gap). */
function base(over: Partial<TitlebarFoldInput> = {}): TitlebarFoldInput {
  return {
    barWidth: 600,
    gap: 4,
    moreSlot: 36, // 32px ⋯ trigger + one gap
    fixedSlots: 78, // back (40+4) + unread chip (30+4)
    aliasFull: 60, // 「@小艾」chip + gap
    aliasGlyphSlot: 26,
    pillFull: 78, // 「● 运行中」+ gap
    pillDotSlot: 24,
    // six foldable buttons à 32px, listed in fold-priority order
    items: TITLEBAR_FOLD_ORDER.map((id) => ({ id, width: 32 })),
    ...over,
  };
}

const ALL: readonly string[] = TITLEBAR_FOLD_ORDER;

function state(folded: readonly string[], aliasGlyph = false, pillDot = false): TitlebarFoldState {
  return { folded, aliasGlyph, pillDot };
}

describe("logic/headerFold.ts — foldTitlebar (issue #41)", () => {
  it("fold priority order is 隐私→定时→恢复→频道→停止→清空 (frozen)", () => {
    expect([...TITLEBAR_FOLD_ORDER]).toEqual(["privacy", "schedule", "resume", "channels", "stop", "clear"]);
  });

  it("everything fits ⇒ no fold, no degradation, no menu", () => {
    // 100 (title+gap) + 78 + 60 + 78 + 6×36 = 532 exactly
    expect(foldTitlebar(base({ barWidth: 532 }))).toEqual(state([]));
    expect(foldTitlebar(base({ barWidth: 900 }))).toEqual(state([]));
  });

  it("folds lowest-priority buttons first; the first fold only breaks even (⋯ replaces it)", () => {
    // 531: folding privacy alone nets 0 (32+4 out, 36 moreSlot in) ⇒ schedule folds too
    expect(foldTitlebar(base({ barWidth: 531 }))).toEqual(state(["privacy", "schedule"]));
    expect(foldTitlebar(base({ barWidth: 497 }))).toEqual(state(["privacy", "schedule"]));
  });

  it("each further 36px step folds exactly one more button, in order", () => {
    expect(foldTitlebar(base({ barWidth: 496 }))).toEqual(state(["privacy", "schedule"]));
    expect(foldTitlebar(base({ barWidth: 495 }))).toEqual(state(["privacy", "schedule", "resume"]));
    expect(foldTitlebar(base({ barWidth: 459 }))).toEqual(state(["privacy", "schedule", "resume", "channels"]));
    expect(foldTitlebar(base({ barWidth: 423 }))).toEqual(state(["privacy", "schedule", "resume", "channels", "stop"]));
    expect(foldTitlebar(base({ barWidth: 387 }))).toEqual(state(ALL));
  });

  it("still overflowing with everything folded ⇒ alias chip degrades to the bare 「@」 glyph", () => {
    // all folded needs 352; alias glyph saves 34 ⇒ 318
    expect(foldTitlebar(base({ barWidth: 352 }))).toEqual(state(ALL));
    expect(foldTitlebar(base({ barWidth: 318 }))).toEqual(state(ALL, true));
    expect(foldTitlebar(base({ barWidth: 319 })).aliasGlyph).toBe(true);
  });

  it("still overflowing after the alias glyph ⇒ status pill degrades to the bare dot (never into the menu)", () => {
    // alias glyph needs 318; pill dot saves 54 ⇒ 264
    const r = foldTitlebar(base({ barWidth: 317 }));
    expect(r).toEqual(state(ALL, true, true));
    expect(foldTitlebar(base({ barWidth: 264 }))).toEqual(state(ALL, true, true));
    expect(foldTitlebar(base({ barWidth: 263 }))).toEqual(state(ALL, true, true)); // clamps, never worse
  });

  it("a cap-gated button absent from `items` is simply never folded (subset works)", () => {
    const items = [
      { id: "schedule" as const, width: 32 },
      { id: "clear" as const, width: 32 },
    ];
    // 100 + 78 + 60 + 78 + 2×36 = 388 fits at 388
    expect(foldTitlebar(base({ barWidth: 388, items }))).toEqual(state([]));
    // 387: fold schedule nets 0, fold clear too ⇒ 388-72+36 = 352
    expect(foldTitlebar(base({ barWidth: 387, items }))).toEqual(state(["schedule", "clear"]));
  });

  it("titleMin is honoured: a custom floor shifts every boundary", () => {
    // titleMin 160: base need 532-96+160 = 596
    expect(foldTitlebar(base({ barWidth: 596, titleMin: 160 }))).toEqual(state([]));
    expect(foldTitlebar(base({ barWidth: 595, titleMin: 160 }))).toEqual(state(["privacy", "schedule"]));
  });

  it("hysteresis: relaxing to a less folded state needs the slack, tightening never does", () => {
    const prev = state(["privacy", "schedule"]);
    // tighten: applies immediately even without slack
    expect(foldTitlebar(base({ barWidth: 460, prev, hysteresis: 24 }))).toEqual(
      state(["privacy", "schedule", "resume"]),
    );
    // relax candidate at 533 (needs 532) but 532+24 > 533 ⇒ keep prev
    expect(foldTitlebar(base({ barWidth: 533, prev, hysteresis: 24 }))).toEqual(prev);
    // 556 = 532+24 ⇒ relax allowed
    expect(foldTitlebar(base({ barWidth: 556, prev, hysteresis: 24 }))).toEqual(state([]));
  });

  it("hysteresis does not resurrect a folded id whose button disappeared (cap toggled off)", () => {
    const prev = state(["privacy", "schedule"]);
    const items = [{ id: "clear" as const, width: 32 }]; // privacy/schedule gone from the bar
    const r = foldTitlebar(base({ barWidth: 533, items, prev, hysteresis: 24 }));
    expect(r.folded).toEqual([]);
  });

  it("zero/negative bar width (hidden, unlaid-out) is a no-op keep of prev / empty", () => {
    expect(foldTitlebar(base({ barWidth: 0 }))).toEqual(state([]));
    const prev = state(["privacy", "schedule"]);
    expect(foldTitlebar(base({ barWidth: 0, prev, hysteresis: 24 }))).toEqual(prev);
  });
});
