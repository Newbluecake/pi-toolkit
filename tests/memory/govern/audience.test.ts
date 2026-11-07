// #36 P6b (arch r5 §6.1) — the three-tier effective audience: frontmatter
// wins, the sidecar tag tier (type "rule" ∧ dispatch/model-routing p ≥ 0.7 ∧
// top-scoring) infers `main`, default `all`; the session filter is two-way.

import { describe, expect, test } from "vitest";
import type { EntryTags } from "../../../src/memory/jev/contracts.js";
import {
  AUDIENCE_MAIN_MIN_P,
  AUDIENCE_MAIN_TAGS,
  audienceMatches,
  effectiveAudience,
  tagInferredAudience,
} from "../../../src/memory/govern/audience.js";

function tags(over: Partial<EntryTags> = {}): EntryTags {
  return {
    file: "core.md",
    type: "rule",
    typeP: 0.9,
    importance: 2,
    tags: {},
    guard: 0.1,
    temporal: "permanent",
    userLike: 0.1,
    model: "opencode/jev-1.13",
    at: "2026-11-01T00:00:00.000Z",
    taxonomyRev: "x",
    ...over,
  };
}

describe("tagInferredAudience (tier 2)", () => {
  test("no sidecar / non-rule type ⇒ all even with a top dispatch score", () => {
    expect(tagInferredAudience(undefined)).toBe("all");
    expect(tagInferredAudience(tags({ type: "pitfall", tags: { dispatch: { p: 0.95, rev: 1 } } }))).toBe("all");
    expect(tagInferredAudience(tags({ type: "fact", tags: { "model-routing": { p: 0.95, rev: 1 } } }))).toBe("all");
  });

  test("rule ∧ dispatch p ≥ 0.7 ∧ highest ⇒ main", () => {
    expect(tagInferredAudience(tags({ tags: { dispatch: { p: 0.7, rev: 1 } } }))).toBe("main");
    expect(tagInferredAudience(tags({ tags: { dispatch: { p: 0.9, rev: 1 }, testing: { p: 0.8, rev: 1 } } }))).toBe(
      "main",
    );
  });

  test("model-routing also infers main; max of the two counts", () => {
    expect(tagInferredAudience(tags({ tags: { "model-routing": { p: 0.75, rev: 1 } } }))).toBe("main");
    expect(
      tagInferredAudience(tags({ tags: { dispatch: { p: 0.3, rev: 1 }, "model-routing": { p: 0.88, rev: 1 } } })),
    ).toBe("main");
  });

  test("below the 0.7 floor ⇒ all (AUDIENCE_MAIN_MIN_P is the boundary)", () => {
    const below = Number((AUDIENCE_MAIN_MIN_P - 0.001).toFixed(3));
    expect(tagInferredAudience(tags({ tags: { dispatch: { p: below, rev: 1 } } }))).toBe("all");
  });

  test("not the block's highest-scoring tag ⇒ all (both main tags)", () => {
    expect(
      tagInferredAudience(tags({ tags: { dispatch: { p: 0.75, rev: 1 }, "git-commit": { p: 0.8, rev: 1 } } })),
    ).toBe("all");
    expect(
      tagInferredAudience(tags({ tags: { "model-routing": { p: 0.72, rev: 1 }, release: { p: 0.73, rev: 1 } } })),
    ).toBe("all");
  });

  test("tied for top still counts as 最高分 ⇒ main", () => {
    expect(
      tagInferredAudience(tags({ tags: { dispatch: { p: 0.8, rev: 1 }, "git-commit": { p: 0.8, rev: 1 } } })),
    ).toBe("main");
  });

  test("AUDIENCE_MAIN_TAGS is exactly the two inference tags", () => {
    expect([...AUDIENCE_MAIN_TAGS].sort()).toEqual(["dispatch", "model-routing"]);
  });
});

describe("effectiveAudience (three tiers, arch §6.1)", () => {
  const mainInferred = tags({ tags: { dispatch: { p: 0.9, rev: 1 } } });

  test("tier 1: explicit frontmatter wins in BOTH directions", () => {
    expect(effectiveAudience("main", undefined)).toBe("main");
    expect(effectiveAudience("all", mainInferred)).toBe("all"); // explicit all beats a main inference
    expect(effectiveAudience("child", mainInferred)).toBe("child");
  });

  test("tier 2/3: no frontmatter ⇒ tag inference, else all", () => {
    expect(effectiveAudience(undefined, mainInferred)).toBe("main");
    expect(effectiveAudience(undefined, tags())).toBe("all");
    expect(effectiveAudience(undefined, undefined)).toBe("all");
  });
});

describe("audienceMatches (two-way session filter)", () => {
  test("child drops main; main drops child; all passes everywhere", () => {
    expect(audienceMatches("all", false)).toBe(true);
    expect(audienceMatches("all", true)).toBe(true);
    expect(audienceMatches("main", false)).toBe(true);
    expect(audienceMatches("main", true)).toBe(false);
    expect(audienceMatches("child", false)).toBe(false);
    expect(audienceMatches("child", true)).toBe(true);
  });
});
