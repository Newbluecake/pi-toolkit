// vote.ts unit tests (plan.md v3.2 section 4).

import { describe, expect, it } from "vitest";
import { tally } from "../../../../src/memory/jev/predict/vote.js";
import type { ScoredHit } from "../../../../src/memory/jev/predict/contracts.js";

describe("tally", () => {
  it("decisive hit scores flat 0.9 regardless of source weight", () => {
    const hits: ScoredHit[] = [
      { rule: "r", source: "U", tag: "release", conf: "high", baseConf: "high", decisive: true },
    ];
    expect(tally({ hits, modifiers: [] })).toEqual([{ tag: "release", score: 0.9, sources: ["U"], rules: ["r"] }]);
  });

  it("non-decisive hit uses w(source) x c(conf)", () => {
    const hits: ScoredHit[] = [{ rule: "r", source: "H", tag: "testing", conf: "medium", baseConf: "medium" }];
    const tags = tally({ hits, modifiers: [] });
    expect(tags[0]?.score).toBeCloseTo(0.9 * 0.6, 5);
  });

  it("same (source, tag) merges via max, not sum", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "git-commit", conf: "low", baseConf: "low" },
      { rule: "b", source: "U", tag: "git-commit", conf: "high", baseConf: "high" },
    ];
    expect(tally({ hits, modifiers: [] })[0]?.score).toBeCloseTo(0.8 * 0.9, 5);
  });

  it("cross-source combines via noisy-OR", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "git-commit", conf: "high", baseConf: "high", decisive: true },
      { rule: "b", source: "W", tag: "git-commit", conf: "low", baseConf: "low" },
    ];
    expect(tally({ hits, modifiers: [] })[0]?.score).toBeCloseTo(1 - (1 - 0.9) * (1 - 0.3 * 0.85), 5);
  });

  it("C (carry) is merged into the U bucket (same-source rule)", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "release", conf: "medium", baseConf: "medium" }, // 0.8*0.6=0.48
      { rule: "carry", source: "C", tag: "release", conf: "high", baseConf: "high", score: 0.9 },
    ];
    // same-source max(0.48, 0.9) = 0.9, not noisy-OR'd against a separate bucket.
    expect(tally({ hits, modifiers: [] })[0]?.score).toBeCloseTo(0.9, 5);
  });

  it("modelHits participate as source M", () => {
    const tags = tally({ hits: [], modifiers: [], modelHits: [{ tag: "ci", p: 0.8 }] });
    expect(tags[0]?.score).toBeCloseTo(0.85 * 0.8, 5);
    expect(tags[0]?.sources).toEqual(["M"]);
  });

  it("negate modifier zeroes only its listed tags", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "release", conf: "high", baseConf: "high", decisive: true },
      { rule: "b", source: "U", tag: "git-commit", conf: "high", baseConf: "high", decisive: true },
    ];
    const tags = tally({ hits, modifiers: [{ rule: "neg", kind: "negate", tags: ["release"] }] });
    expect(tags.map((t) => t.tag)).toEqual(["git-commit"]);
  });

  it("readonly modifier zeroes every tag it names", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "git-commit", conf: "high", baseConf: "high", decisive: true },
      { rule: "b", source: "U", tag: "git-push", conf: "high", baseConf: "high", decisive: true },
    ];
    const tags = tally({
      hits,
      modifiers: [{ rule: "ro", kind: "readonly", tags: ["git-commit", "git-push"] }],
    });
    expect(tags).toEqual([]);
  });

  it("cancel modifier zeroes all tags via 'all'", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "git-commit", conf: "high", baseConf: "high", decisive: true },
      { rule: "b", source: "T", tag: "testing", conf: "high", baseConf: "high" },
    ];
    expect(tally({ hits, modifiers: [{ rule: "cancel", kind: "cancel", tags: "all" }] })).toEqual([]);
  });

  it("question modifier does not zero anything (handled upstream via decisive cancellation)", () => {
    const hits: ScoredHit[] = [
      { rule: "a", source: "U", tag: "ci", conf: "medium", baseConf: "medium", question: true },
    ];
    const tags = tally({ hits, modifiers: [{ rule: "q", kind: "question", tags: ["ci"] }] });
    expect(tags[0]?.score).toBeCloseTo(0.8 * 0.6, 5);
  });

  it("filters below MIN_SCORE (0.3) and caps at 6, sorted descending then by tag", () => {
    const hits: ScoredHit[] = Array.from({ length: 8 }, (_, i) => ({
      rule: `r${i}`,
      source: "U" as const,
      tag: `tag${i}`,
      conf: "high" as const,
      baseConf: "high" as const,
      decisive: true as const,
    }));
    hits.push({ rule: "low", source: "U", tag: "too-low", conf: "low", baseConf: "low" }); // 0.8*0.3=0.24 < 0.3
    const tags = tally({ hits, modifiers: [] });
    expect(tags).toHaveLength(6);
    expect(tags.every((t) => t.score >= 0.3)).toBe(true);
    expect(tags.some((t) => t.tag === "too-low")).toBe(false);
  });
});
