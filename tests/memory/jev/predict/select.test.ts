// select.ts unit tests (plan.md v3.2 section 5.1 selection / section 5.4 priority slots).

import { describe, expect, it } from "vitest";
import {
  eligibleTagsOf,
  fastPathEligibleTags,
  prioritizeCandidates,
  scoreCandidate,
  selectPEntries,
  selectSEntry,
  type Candidate,
  type PriorityCandidate,
  type SCandidate,
} from "../../../../src/memory/jev/predict/select.js";
import type { TagScore } from "../../../../src/memory/jev/predict/contracts.js";

function tag(id: string, score: number): TagScore {
  return { tag: id, score, sources: ["U"], rules: ["x"] };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    hash: "h1",
    isPrivate: false,
    isSecret: false,
    isInjected: false,
    isStaticCore: false,
    coolingDown: false,
    pending: false,
    importance: 2,
    type: "rule",
    tagP: { "git-commit": 1 },
    byteLength: 100,
    ...overrides,
  };
}

describe("fastPathEligibleTags", () => {
  it("includes high-risk tags, plus allow, minus deny", () => {
    const tags = [
      { id: "a", risk: "high" as const },
      { id: "b", risk: "normal" as const },
      { id: "c", risk: "normal" as const },
    ];
    const eligible = fastPathEligibleTags(tags, { allowTags: ["c"], denyTags: ["a"] });
    expect(eligible.has("a")).toBe(false); // denied even though high-risk
    expect(eligible.has("b")).toBe(false);
    expect(eligible.has("c")).toBe(true); // allow-listed despite normal risk
  });
});

describe("eligibleTagsOf", () => {
  it("requires score >= 0.85 AND membership in fastPathEligible", () => {
    const eligible = eligibleTagsOf([tag("a", 0.9), tag("b", 0.5), tag("c", 0.95)], new Set(["a", "c"]));
    expect(eligible).toEqual(new Set(["a", "c"]));
  });
});

describe("scoreCandidate", () => {
  it("excludes private/secret/injected/staticCore/coolingDown", () => {
    const tags = [tag("git-commit", 0.9)];
    const eligible = new Set(["git-commit"]);
    for (const flag of ["isPrivate", "isSecret", "isInjected", "isStaticCore", "coolingDown"] as const) {
      expect(scoreCandidate(candidate({ [flag]: true }), tags, eligible)).toBeUndefined();
    }
  });

  it("returns undefined when there is no shared eligible tag", () => {
    expect(
      scoreCandidate(candidate({ tagP: { ci: 0.9 } }), [tag("git-commit", 0.9)], new Set(["git-commit"])),
    ).toBeUndefined();
  });

  it("pending entries skip the type gate and use importance=2", () => {
    const c = candidate({ pending: true, importance: undefined, type: undefined, tagP: { "git-commit": 1 } });
    expect(scoreCandidate(c, [tag("git-commit", 0.9)], new Set(["git-commit"]))).toBeCloseTo(0.9 * 1 * 2, 5);
  });

  it("non-pending entries must have importance>=2 and an eligible type", () => {
    expect(
      scoreCandidate(candidate({ importance: 1 }), [tag("git-commit", 0.9)], new Set(["git-commit"])),
    ).toBeUndefined();
    expect(
      scoreCandidate(candidate({ type: "preference" }), [tag("git-commit", 0.9)], new Set(["git-commit"])),
    ).toBeUndefined();
    expect(
      scoreCandidate(candidate({ type: "pitfall" }), [tag("git-commit", 0.9)], new Set(["git-commit"])),
    ).toBeDefined();
    expect(
      scoreCandidate(candidate({ type: "procedure" }), [tag("git-commit", 0.9)], new Set(["git-commit"])),
    ).toBeDefined();
  });

  it("applies the 1.25x authority=user bonus", () => {
    const tags = [tag("git-commit", 0.9)];
    const eligible = new Set(["git-commit"]);
    const base = scoreCandidate(candidate({ authority: "none" }), tags, eligible)!;
    const boosted = scoreCandidate(candidate({ authority: "user" }), tags, eligible)!;
    expect(boosted).toBeCloseTo(base * 1.25, 5);
  });

  it("uses max over tag x p(e,t), not sum", () => {
    const c = candidate({ tagP: { "git-commit": 0.3, release: 0.9 } });
    const tags = [tag("git-commit", 0.9), tag("release", 0.9)];
    const eligible = new Set(["git-commit", "release"]);
    expect(scoreCandidate(c, tags, eligible)).toBeCloseTo(Math.max(0.9 * 0.3, 0.9 * 0.9) * 2, 5);
  });
});

describe("selectPEntries", () => {
  it("returns [] when there is no eligible tag", () => {
    expect(
      selectPEntries({
        tags: [tag("git-commit", 0.5)],
        eligibleTags: new Set(["git-commit"]),
        candidates: [candidate()],
        maxEntries: 2,
        maxBytes: 2048,
      }),
    ).toEqual([]);
  });

  it("fits highest-score-first within maxEntries and maxBytes (greedy, not truncation)", () => {
    const high = candidate({ hash: "high", importance: 3, byteLength: 1500 });
    const mid = candidate({ hash: "mid", importance: 2, byteLength: 1500 });
    const small = candidate({ hash: "small", importance: 2, byteLength: 100 });
    const picks = selectPEntries({
      tags: [tag("git-commit", 0.9)],
      eligibleTags: new Set(["git-commit"]),
      candidates: [high, mid, small],
      maxEntries: 2,
      maxBytes: 2048,
    });
    // high (1500B) fits; mid (1500B) would overflow 2048 so it's skipped in favor of small (100B).
    expect(picks.map((p) => p.hash)).toEqual(["high", "small"]);
  });
});

describe("selectSEntry", () => {
  function sCandidate(overrides: Partial<SCandidate> = {}): SCandidate {
    return {
      hash: "s1",
      isPrivate: false,
      isSecret: false,
      hasReleaseTag: true,
      authority: "user",
      byteLength: 50,
      ...overrides,
    };
  }

  it("returns undefined when state is empty", () => {
    expect(selectSEntry([], [sCandidate()], 2048)).toBeUndefined();
  });

  it("requires a release tag and (authority=user or type=rule)", () => {
    const state = [{ kind: "release-in-progress" as const, evidence: "release.sh" }];
    expect(selectSEntry(state, [sCandidate({ hasReleaseTag: false })], 2048)).toBeUndefined();
    expect(selectSEntry(state, [sCandidate({ authority: "none", type: "fact" })], 2048)).toBeUndefined();
    expect(selectSEntry(state, [sCandidate({ authority: "none", type: "rule" })], 2048)).toBeDefined();
  });

  it("picks at most one, preferring user authority", () => {
    const state = [{ kind: "release-in-progress" as const, evidence: "release.sh" }];
    const picked = selectSEntry(
      state,
      [sCandidate({ hash: "a", authority: "none", type: "rule" }), sCandidate({ hash: "b", authority: "user" })],
      2048,
    );
    expect(picked?.hash).toBe("b");
  });

  it("respects the remaining byte budget", () => {
    const state = [{ kind: "release-in-progress" as const, evidence: "release.sh" }];
    expect(selectSEntry(state, [sCandidate({ byteLength: 5000 })], 2048)).toBeUndefined();
  });
});

describe("prioritizeCandidates (section 5.4, 40-slot quota)", () => {
  it("sorts user-authority first, then by p*importance descending, then file ascending", () => {
    const candidates: PriorityCandidate[] = [
      { hash: "a", file: "z.md", p: 0.9, importance: 2, isUserAuthority: false },
      { hash: "b", file: "a.md", p: 0.9, importance: 2, isUserAuthority: false },
      { hash: "c", file: "m.md", p: 0.5, importance: 1, isUserAuthority: true },
    ];
    const out = prioritizeCandidates(candidates);
    expect(out.map((c) => c.hash)).toEqual(["c", "b", "a"]);
  });

  it("caps at 40 slots", () => {
    const candidates: PriorityCandidate[] = Array.from({ length: 100 }, (_, i) => ({
      hash: `h${i}`,
      file: `f${i}.md`,
      p: Math.random(),
      importance: 2,
      isUserAuthority: false,
    }));
    expect(prioritizeCandidates(candidates)).toHaveLength(40);
  });
});
