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

describe("selectPEntries · 高危 tag 冷却饿死出口 (#36 §6.4 / arch r5 §6.4)", () => {
  const HIGH_RISK = new Set(["deletion"]);
  const starvedInput = (overrides: Partial<Parameters<typeof selectPEntries>[0]> = {}) => ({
    tags: [tag("deletion", 0.9)],
    eligibleTags: new Set(["deletion"]),
    candidates: [candidate({ hash: "cool1", tagP: { deletion: 0.9 }, coolingDown: true })],
    maxEntries: 2,
    maxBytes: 4096,
    highRiskTags: HIGH_RISK,
    ...overrides,
  });

  it("命中：tag 高危且 score ≥0.85、合格候选全部被冷却挡住 ⇒ 绕过冷却追加 1 条（bypass 标记）", () => {
    const picks = selectPEntries(starvedInput());
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ hash: "cool1", bypass: true });
  });

  it("命中：绕过条目按完整公式排序取最高（authority=user 加成参与）", () => {
    const picks = selectPEntries(
      starvedInput({
        candidates: [
          candidate({ hash: "agent", tagP: { deletion: 0.9 }, coolingDown: true, authority: "model" }),
          candidate({ hash: "user", tagP: { deletion: 0.9 }, coolingDown: true, authority: "user" }),
        ],
      }),
    );
    expect(picks).toHaveLength(1);
    expect(picks[0]!.hash).toBe("user"); // 1.25x user 加成 ⇒ 分更高
  });

  it("不命中：候选已在 segment 已注入集合中（isInjected）⇒ 它不算饿死候选，零注入", () => {
    expect(
      selectPEntries(
        starvedInput({
          candidates: [candidate({ hash: "seg", tagP: { deletion: 0.9 }, coolingDown: true, isInjected: true })],
        }),
      ),
    ).toEqual([]);
  });

  it("不命中：候选是 static（isStaticCore）⇒ 常驻块不需要重注，零注入", () => {
    expect(
      selectPEntries(
        starvedInput({
          candidates: [candidate({ hash: "st", tagP: { deletion: 0.9 }, coolingDown: true, isStaticCore: true })],
        }),
      ),
    ).toEqual([]);
  });

  it("不命中：tag score 0.84（未过 eligibleTagsOf 的 0.85 门）⇒ 不触发", () => {
    // fast-path 集合里有该 tag，但 0.84 < 0.85 ⇒ derived eligible 为空。
    expect(selectPEntries(starvedInput({ tags: [tag("deletion", 0.84)] }))).toEqual([]);
  });

  it("不命中：非高危 tag（risk:normal）即使饿死也不触发", () => {
    const picks = selectPEntries(
      starvedInput({
        tags: [tag("docs", 0.9)],
        eligibleTags: new Set(["docs"]),
        candidates: [candidate({ hash: "cool", tagP: { docs: 0.9 }, coolingDown: true })],
      }),
    );
    expect(picks).toEqual([]);
  });

  it("不命中：t 下存在未被冷却的合格候选（未饿死）⇒ 正常路径已覆盖，无 bypass", () => {
    const picks = selectPEntries(
      starvedInput({
        candidates: [
          candidate({ hash: "warm", tagP: { deletion: 0.9 }, coolingDown: false }),
          candidate({ hash: "cool", tagP: { deletion: 0.9 }, coolingDown: true }),
        ],
      }),
    );
    expect(picks.map((p) => p.hash)).toEqual(["warm"]);
    expect(picks.every((p) => p.bypass === undefined)).toBe(true);
  });

  it("每轮最多 1 条：两个高危 tag 同时饿死也只 bypass 排序最高的那一个 tag 的 top-1", () => {
    const picks = selectPEntries(
      starvedInput({
        tags: [tag("deletion", 0.9), tag("git-commit", 0.95)],
        eligibleTags: new Set(["deletion", "git-commit"]),
        highRiskTags: new Set(["deletion", "git-commit"]),
        candidates: [
          candidate({ hash: "del", tagP: { deletion: 0.9 }, coolingDown: true }),
          candidate({ hash: "commit", tagP: { "git-commit": 0.9 }, coolingDown: true }),
        ],
      }),
    );
    const bypassPicks = picks.filter((p) => p.bypass === true);
    expect(bypassPicks).toHaveLength(1);
  });

  it("bypass 仍受 maxEntries/maxBytes 预算约束：预算不够时不追加", () => {
    // 正常路径已有 1 条（另一 tag）且 maxEntries=1 已满 ⇒ 不追加。
    const full = selectPEntries(
      starvedInput({
        tags: [tag("docs", 0.9), tag("deletion", 0.9)],
        eligibleTags: new Set(["docs", "deletion"]),
        candidates: [
          candidate({ hash: "warm-docs", tagP: { docs: 0.9 }, coolingDown: false }),
          candidate({ hash: "cool", tagP: { deletion: 0.9 }, coolingDown: true }),
        ],
        maxEntries: 1,
      }),
    );
    expect(full.map((p) => p.hash)).toEqual(["warm-docs"]);
    expect(full.every((p) => p.bypass === undefined)).toBe(true);
    // 字节预算不够容下 bypass 条目 ⇒ 不追加。
    const noBytes = selectPEntries(starvedInput({ maxBytes: 50 })); // 候选 byteLength=100
    expect(noBytes).toEqual([]);
    // 空位仍在（maxEntries 未满、字节够）⇒ 允许单独追加 bypass。
    const room = selectPEntries(starvedInput({ maxEntries: 1 }));
    expect(room).toHaveLength(1);
    expect(room[0]!.bypass).toBe(true);
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

// ───────────────────── #36 P6b — decay ×m on the sort key (arch §6.2) ─────────────────────

describe("decay multiplier (#36 P6b, arch §6.2)", () => {
  const tags = [tag("git-commit", 0.9)];
  const eligible = new Set(["git-commit"]);

  it("multiplies the score by Candidate.decay", () => {
    expect(scoreCandidate(candidate({ decay: 0.6 }), tags, eligible)).toBeCloseTo(0.9 * 1 * 2 * 0.6, 5);
    expect(scoreCandidate(candidate({ decay: 0.8 }), tags, eligible)).toBeCloseTo(0.9 * 1 * 2 * 0.8, 5);
  });

  it("omitted decay stays 1.0 (existing callers unchanged)", () => {
    expect(scoreCandidate(candidate(), tags, eligible)).toBeCloseTo(0.9 * 1 * 2, 5);
  });

  it("reorders selection when the higher-raw-score candidate is decayed (maxEntries budget)", () => {
    const fresh = candidate({ hash: "fresh", decay: 1, tagP: { "git-commit": 0.85 } }); // raw 1.53
    const stale = candidate({ hash: "stale", decay: 0.6, tagP: { "git-commit": 1 } }); // raw 1.8 → ×0.6 = 1.08
    const picked = selectPEntries({
      tags,
      eligibleTags: eligible,
      candidates: [stale, fresh],
      maxEntries: 1,
      maxBytes: 2048,
    });
    expect(picked.map((p) => p.hash)).toEqual(["fresh"]); // without decay `stale` would win
  });

  it("the §6.4 bypass ranking also decays: the less-stale cooled candidate wins the bypass slot", () => {
    const highRisk = new Set(["git-commit"]);
    const cooledFresh = candidate({ hash: "cf", coolingDown: true, decay: 1 });
    const cooledStale = candidate({ hash: "cs", coolingDown: true, decay: 0.6 });
    // both cooled ⇒ git-commit starved ⇒ exactly one bypass pick, decay applied
    const picked = selectPEntries({
      tags,
      eligibleTags: eligible,
      candidates: [cooledStale, cooledFresh],
      maxEntries: 1,
      maxBytes: 2048,
      highRiskTags: highRisk,
    });
    const bypass = picked.find((p) => p.bypass === true);
    expect(bypass?.hash).toBe("cf"); // equal raw scores; decay breaks the tie toward the fresh one
  });
});
