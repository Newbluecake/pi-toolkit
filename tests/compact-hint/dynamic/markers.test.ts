import { describe, expect, it } from "vitest";
import {
  MARKER_CJK_PATTERN,
  hintNote,
  tickMarker,
  type HintNoteContext,
  type MarkerBasis,
} from "../../../src/compact-hint/dynamic/markers.js";
import type { ThresholdBasis } from "../../../src/compact-hint/dynamic/types.js";

describe("dynamic markers §10.1/§10.2 (D1)", () => {
  it("T-D1-MARKERS: P2-3 — 标记不含 CJK（正则）；允许 `·`（U+00B7）；取值与 §10.1 逐字对齐", () => {
    const cases: Array<[MarkerBasis, number, number | undefined, string]> = [
      ["cost", 41, undefined, "hint 41% · cost"],
      ["floor", 35, undefined, "hint 35% · floor"],
      ["quality-cap", 60, undefined, "hint 60% · quality"],
      ["tier", 72, 272_000, "hint 72% · tier 272k"],
      ["quota", 38, undefined, "hint 38% · quota"],
      ["static", 75, undefined, "hint 75% · static"],
      // §10.1 未列出取值的两类 basis：同构短 token（reserve / force）
      ["reserve-cap", 50, undefined, "hint 50% · reserve"],
      ["force-gap", 52, undefined, "hint 52% · force"],
    ];
    for (const [basis, percent, nextTier, expected] of cases) {
      const marker = tickMarker(basis, percent, nextTier);
      expect(marker).toBe(expected);
      expect(MARKER_CJK_PATTERN.test(marker)).toBe(false); // 不含 CJK（P2-3）
      expect(marker).toContain("·"); // 仓库既有分隔符合法
    }
    // tier 无边界值时退化为不带数字的短标记（仍非 CJK）
    expect(tickMarker("tier", 72)).toBe("hint 72% · tier");
    expect(MARKER_CJK_PATTERN.test(tickMarker("tier", 72))).toBe(false);
  });

  it("T-D1-MARKERS: note 为中文整句，且仅 cost/tier/quota 三种 basis 产出（§10.2 逐字对齐）", () => {
    const costCtx: HintNoteContext = { hintPercent: 41, usedTokens: 380_000, window: 1_000_000 };
    expect(hintNote("cost", costCtx)).toBe(
      "- 本次阈值由价格模型给出 [hint 41% · cost]：继续下去每轮都要为这段长前缀付 cache-read。",
    );
    expect(MARKER_CJK_PATTERN.test(hintNote("cost", costCtx) ?? "")).toBe(true); // note 是中文整句

    const tierCtx: HintNoteContext = {
      hintPercent: 72,
      usedTokens: 266_000,
      window: 372_000,
      nextTierTokens: 272_000,
    };
    expect(hintNote("tier", tierCtx)).toBe(
      "- 再涨约 6k token 就会跨进高价档 [tier 272k]，跨档后单价翻倍；在此之前切换最划算。",
    );
    expect(MARKER_CJK_PATTERN.test(hintNote("tier", tierCtx) ?? "")).toBe(true);

    const quotaCtx: HintNoteContext = { hintPercent: 38, usedTokens: 380_000, window: 1_000_000, usedPct: 88 };
    expect(hintNote("quota", quotaCtx)).toBe("- 订阅额度已用 88% [quota]，提前切换可以少烧一些额度。");

    // 其余 basis 不加 note（省略时文案与今天逐字节相同）
    for (const basis of ["floor", "quality-cap", "reserve-cap", "force-gap"] as ThresholdBasis[]) {
      expect(hintNote(basis, { ...costCtx, nextTierTokens: 272_000, usedPct: 90 })).toBeUndefined();
    }
  });

  it("T-D1-MARKERS: tier/quota note 的参数不足时返回 undefined（不编造文案）", () => {
    // tier：取不到 nextTier / usedTokens / 距离非正
    expect(
      hintNote("tier", { hintPercent: 72, usedTokens: null, window: 372_000, nextTierTokens: 272_000 }),
    ).toBeUndefined();
    expect(hintNote("tier", { hintPercent: 72, usedTokens: 380_000, window: 372_000 })).toBeUndefined();
    expect(
      hintNote("tier", { hintPercent: 72, usedTokens: 380_000, window: 372_000, nextTierTokens: 272_000 }),
    ).toBeUndefined(); // 已越过 B（距离 <= 0）
    // quota：取不到 usedPct
    expect(hintNote("quota", { hintPercent: 38, usedTokens: 380_000, window: 1_000_000 })).toBeUndefined();
  });
});
