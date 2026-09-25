import { describe, expect, it } from "vitest";
import { composeHintLineTokens, resolveEffectiveHint } from "../../../src/compact-hint/dynamic/threshold.js";
import { effectiveThresholdPercentWithTokens, thresholdLineTokens } from "../../../src/compact-hint/threshold.js";

/** Same seeded PRNG as the other dynamic-threshold property tests (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The hook's inline composition before it moved into resolveEffectiveHint (cd0d209). */
function legacyHookComposition(
  percent: number,
  tokensK: number,
  window: number,
  reserve: number,
  dyn: { hintTokens: number; hintPercent: number } | undefined,
): { percent: number; dynamicWon: boolean } {
  let effective = effectiveThresholdPercentWithTokens(percent, tokensK, window, reserve);
  let won = false;
  if (dyn !== undefined) {
    const composed = composeHintLineTokens({
      staticLines: { percent, tokensK },
      window,
      reserveTokens: reserve,
      mode: "on",
      dynamic: { usable: true, hintTokens: dyn.hintTokens },
    });
    const staticTokens = thresholdLineTokens(percent, tokensK, window);
    if (composed > 0 && composed < staticTokens) {
      effective = Math.min(effective, dyn.hintPercent);
      won = true;
    }
  }
  return { percent: effective, dynamicWon: won };
}

describe("resolveEffectiveHint (shared by the compact-hint hook and /agent status)", () => {
  it("matches the hook's previous inline composition on 500 seeded inputs", () => {
    const next = mulberry32(20260925);
    for (let i = 0; i < 500; i++) {
      const window = Math.round(32_000 + next() * 1_968_000);
      const reserve = Math.round(next() * 40_000);
      const percent = next() < 0.15 ? 0 : Math.round(next() * 95);
      const tokensK = next() < 0.4 ? 0 : Math.round(next() * 2_000);
      const hintTokens = Math.round(next() * window);
      const dyn =
        next() < 0.2 ? undefined : { hintTokens, hintPercent: Math.max(1, Math.floor((hintTokens / window) * 100)) };
      const args = {
        staticEffectivePercent: effectiveThresholdPercentWithTokens(percent, tokensK, window, reserve),
        staticLines: { percent, tokensK },
        window,
        reserveTokens: reserve,
        dynamic: dyn,
      };
      expect(resolveEffectiveHint(args), `case ${i}`).toEqual(
        legacyHookComposition(percent, tokensK, window, reserve, dyn),
      );
    }
  });

  it("the live acceptance case: static 75%/500k on 1M fires at 50%, a 60% dynamic line loses", () => {
    const window = 1_000_000;
    const r = resolveEffectiveHint({
      staticEffectivePercent: effectiveThresholdPercentWithTokens(75, 500, window, 16_384),
      staticLines: { percent: 75, tokensK: 500 },
      window,
      reserveTokens: 16_384,
      dynamic: { hintTokens: 600_000, hintPercent: 60 },
    });
    expect(r).toEqual({ percent: 50, dynamicWon: false });
  });

  it("an earlier dynamic line wins; a disabled static line is never resurrected", () => {
    const window = 1_000_000;
    const base = { staticLines: { percent: 75, tokensK: 500 }, window, reserveTokens: 16_384 };
    expect(
      resolveEffectiveHint({ ...base, staticEffectivePercent: 50, dynamic: { hintTokens: 410_000, hintPercent: 41 } }),
    ).toEqual({ percent: 41, dynamicWon: true });
    expect(
      resolveEffectiveHint({
        staticEffectivePercent: 0,
        staticLines: { percent: 0, tokensK: 2_000 },
        window,
        reserveTokens: 16_384,
        dynamic: { hintTokens: 410_000, hintPercent: 41 },
      }),
    ).toEqual({ percent: 0, dynamicWon: false });
  });
});
