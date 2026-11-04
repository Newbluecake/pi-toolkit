// rules.ts unit tests (plan.md v3.2 section 3.2): one positive + one negative
// case per rule (R01-R23 minus R04), the negation/readonly/question/cancel
// matrix, and the global-priority (post-merge modifier) property.

import { describe, expect, it } from "vitest";
import { runRules, RULES_VERSION } from "../../../../src/memory/jev/predict/rules.js";
import { tally } from "../../../../src/memory/jev/predict/vote.js";
import type { PredictInput } from "../../../../src/memory/jev/predict/contracts.js";
import { mergeTaxonomy } from "../../../../src/memory/jev/taxonomy.js";

const TAX = mergeTaxonomy(undefined);
if (!TAX.ok) throw new Error("preset taxonomy failed to merge");
const taxonomy = TAX.taxonomy;

function input(overrides: Partial<PredictInput> = {}): PredictInput {
  return {
    prompt: "",
    todo: [],
    recentTools: [],
    bashJobs: [],
    activeSubagents: 0,
    session: "main",
    ...overrides,
  };
}

function tagsOf(prompt: string, overrides: Partial<PredictInput> = {}): ReturnType<typeof tally> {
  const i = input({ prompt, ...overrides });
  const { hits, modifiers } = runRules(i, taxonomy);
  return tally({ hits, modifiers });
}

function score(prompt: string, tag: string, overrides: Partial<PredictInput> = {}): number {
  return tagsOf(prompt, overrides).find((t) => t.tag === tag)?.score ?? 0;
}

describe("RULES_VERSION", () => {
  it("is a stable positive integer", () => {
    expect(Number.isInteger(RULES_VERSION)).toBe(true);
    expect(RULES_VERSION).toBeGreaterThan(0);
  });
});

describe("R01 release", () => {
  it("positive: decisive imperative hits 0.9", () => {
    expect(score("打个 tag 发版吧", "release")).toBeCloseTo(0.9, 5);
  });
  it("negative: unrelated prompt does not hit", () => {
    expect(score("看看这个文件", "release")).toBe(0);
  });
});

describe("R02 git-commit", () => {
  it("positive: decisive", () => {
    expect(score("提交一下", "git-commit")).toBeCloseTo(0.9, 5);
  });
  it("negative: negated", () => {
    expect(score("先别提交", "git-commit")).toBe(0);
  });
});

describe("R03 git-push", () => {
  it("positive: decisive", () => {
    expect(score("推送到 origin", "git-push")).toBeCloseTo(0.9, 5);
  });
  it("negative: unrelated", () => {
    expect(score("看看日志", "git-push")).toBe(0);
  });
});

describe("R05 dispatch + R06 model-routing", () => {
  it("positive: dispatch decisive, model-routing derived at medium", () => {
    const tags = tagsOf("派两个子 agent 并行做");
    expect(tags.find((t) => t.tag === "dispatch")?.score).toBeCloseTo(0.9, 5);
    expect(tags.find((t) => t.tag === "model-routing")?.score).toBeCloseTo(0.8 * 0.6, 5);
  });
  it("negative: unrelated prompt has neither", () => {
    const tags = tagsOf("改一下这个函数");
    expect(tags.some((t) => t.tag === "dispatch")).toBe(false);
    expect(tags.some((t) => t.tag === "model-routing")).toBe(false);
  });
});

describe("R07 frozen-files", () => {
  it("positive", () => {
    expect(score("改一下 tests/fixtures 里的金样本", "frozen-files")).toBeCloseTo(0.9, 5);
  });
  it("negative", () => {
    expect(score("改一下 src 里的代码", "frozen-files")).toBe(0);
  });
});

describe("R08 deletion", () => {
  it("positive", () => {
    expect(score("删除这个文件", "deletion")).toBeCloseTo(0.9, 5);
  });
  it("negative", () => {
    expect(score("先别删除", "deletion")).toBe(0);
  });
});

describe("R09 dependencies", () => {
  it("positive", () => {
    expect(score("安装一个依赖", "dependencies")).toBeCloseTo(0.9, 5);
  });
  it("negative", () => {
    expect(score("看看这个依赖关系图", "dependencies")).toBe(0);
  });
});

describe("R10 testing (todo)", () => {
  it("positive: in_progress todo mentions testing", () => {
    const tags = tagsOf("继续", { todo: [{ id: 1, subject: "修 vitest flake", status: "in_progress" }] });
    expect(tags.find((t) => t.tag === "testing")?.score).toBeCloseTo(1.0 * 0.6, 5);
  });
  it("negative: pending todo does not count", () => {
    const tags = tagsOf("继续", { todo: [{ id: 1, subject: "修 vitest flake", status: "pending" }] });
    expect(tags.some((t) => t.tag === "testing")).toBe(false);
  });
});

describe("R11 testing/build (recentTools)", () => {
  const editsNoTest = Array.from({ length: 3 }, () => ({ tool: "edit", pathClass: "src" as const }));
  it("positive: >=3 src edits with no testing-shaped bash after", () => {
    const tags = tagsOf("继续", { recentTools: editsNoTest });
    expect(tags.find((t) => t.tag === "testing")?.score).toBeCloseTo(0.9 * 0.6, 5);
  });
  it("negative: a testing-shaped bash ran afterwards clears the signal", () => {
    const tools = [...editsNoTest, { tool: "bash", shape: "npm test" }];
    const tags = tagsOf("继续", { recentTools: tools });
    expect(tags.some((t) => t.tag === "testing")).toBe(false);
  });
});

describe("R12 git-commit (dirty)", () => {
  it("positive: dirty alone is below the tally visibility threshold (0.255 < 0.3) but present as a raw hit", () => {
    const i = input({ prompt: "继续", git: { dirty: true } });
    const { hits } = runRules(i, taxonomy);
    const hit = hits.find((h) => h.rule === "R12");
    expect(hit).toBeDefined();
    expect(hit?.source).toBe("W");
    expect(hit?.tag).toBe("git-commit");
    // 单独不达 tally 可见门槛（§4.1第 6 步 score ≥0.3），因此最终没有单独注入。
    expect(score("继续", "git-commit", { git: { dirty: true } })).toBe(0);
  });
  it("negative: clean workspace contributes nothing", () => {
    expect(score("继续", "git-commit", { git: { dirty: false } })).toBe(0);
  });
  it("combines with a decisive R02 hit via noisy-OR (section 4.3 worked example)", () => {
    expect(score("提交一下", "git-commit", { git: { dirty: true } })).toBeCloseTo(1 - (1 - 0.9) * (1 - 0.255), 5);
  });
});

describe("R13 git-push (branch)", () => {
  it("positive: master/main branch raw hit exists (below tally visibility threshold alone)", () => {
    const i = input({ prompt: "继续", git: { branch: "master" } });
    const { hits } = runRules(i, taxonomy);
    expect(hits.find((h) => h.rule === "R13")?.tag).toBe("git-push");
    expect(score("继续", "git-push", { git: { branch: "master" } })).toBe(0);
  });
  it("negative: feature branch", () => {
    expect(score("继续", "git-push", { git: { branch: "feat/x" } })).toBe(0);
  });
});

describe("R14 memory-system", () => {
  it("positive", () => {
    expect(score("写进记忆", "memory-system")).toBeCloseTo(0.8 * 0.9, 5);
  });
  it("negative", () => {
    expect(score("写个函数", "memory-system")).toBe(0);
  });
});

describe("R15 session-context", () => {
  it("positive", () => {
    expect(score("交接一下上下文", "session-context")).toBeCloseTo(0.8 * 0.6, 5);
  });
  it("negative", () => {
    expect(score("写个函数", "session-context")).toBe(0);
  });
});

describe("R16 ci", () => {
  it("positive (worked example: 0.48)", () => {
    expect(score("为什么 CI 挂了", "ci")).toBeCloseTo(0.48, 5);
  });
  it("negative", () => {
    expect(score("写个函数", "ci")).toBe(0);
  });
});

describe("R19 natural-language commands", () => {
  it("positive: decisive code snippet", () => {
    expect(score("跑一下 `git commit -m x`", "git-commit")).toBeCloseTo(0.9, 5);
  });
  it("negated code snippet drops to 0", () => {
    expect(score("先别跑 `git commit -m x`", "git-commit")).toBe(0);
  });
  it("prose-only mention is medium, not decisive", () => {
    expect(score("麻烦 npm publish 一下这个包", "release")).toBeCloseTo(0.8 * 0.6, 5);
  });
});

describe("R20 credentials (verb+object decisive / noun-only medium-ish)", () => {
  it("positive: verb+object is decisive", () => {
    expect(score("轮换 token", "credentials")).toBeCloseTo(0.9, 5);
  });
  it("positive: bare noun mention is high-but-not-decisive", () => {
    expect(score("这个 token 要注意", "credentials")).toBeCloseTo(0.8 * 0.9, 5);
  });
  it("negative", () => {
    expect(score("写个函数", "credentials")).toBe(0);
  });
});

describe("R21 credentials (recentTools)", () => {
  it("positive: prior read/edit/write on a credentials path", () => {
    expect(score("继续", "credentials", { recentTools: [{ tool: "read", pathClass: "credentials" }] })).toBeCloseTo(
      0.9 * 0.6,
      5,
    );
  });
  it("negative: prior tool on a non-credentials path", () => {
    expect(score("继续", "credentials", { recentTools: [{ tool: "read", pathClass: "src" }] })).toBe(0);
  });
});

describe("R22 git-history", () => {
  it("positive", () => {
    expect(score("rebase 一下这几个提交", "git-history")).toBeCloseTo(0.9, 5);
  });
  it("negative", () => {
    expect(score("写个函数", "git-history")).toBe(0);
  });
});

describe("R23 git-history (recentTools error)", () => {
  it("positive: a prior failed git-history-shaped bash", () => {
    expect(
      score("继续", "git-history", {
        recentTools: [{ tool: "bash", shape: "git rebase", isError: true }],
      }),
    ).toBeCloseTo(0.9 * 0.6, 5);
  });
  it("negative: same shape but no error", () => {
    expect(
      score("继续", "git-history", {
        recentTools: [{ tool: "bash", shape: "git rebase", isError: false }],
      }),
    ).toBe(0);
  });
});

describe("negation / readonly / question / cancel matrix (section 3.1)", () => {
  it("polite imperative still counts as decisive", () => {
    expect(score("能帮我提交一下吗", "git-commit")).toBeCloseTo(0.9, 5);
  });
  it("a genuine question downgrades decisive to medium, does not zero", () => {
    // 不用 不要 子串（若用要不要 会被否定窗口误判为含有 不要 子串），改用前导译问词触发疑问判定。
    expect(score("是不是应该提交", "git-commit")).toBeCloseTo(0.8 * 0.6, 5);
  });
  it("readonly intent zeroes every write-action tag regardless of source", () => {
    const tags = tagsOf("只评审一下，不要提交", { todo: [{ id: 1, subject: "提交 PR", status: "in_progress" }] });
    expect(tags.some((t) => t.tag === "git-commit")).toBe(false);
  });
  it("cancel intent zeroes every tag", () => {
    const tags = tagsOf("算了，提交一下吧");
    expect(tags).toEqual([]);
  });
});

describe("global-priority property: negate/readonly/cancel override every source, including todo/workspace", () => {
  it("a tag with T+W+U support is still zeroed by a negate modifier on that tag", () => {
    // 合成场景：直接驱动 tally，证明修饰的全局最高优先级与具体规则表无关。
    const tags = tally({
      hits: [
        { rule: "x", source: "T", tag: "release", conf: "high", baseConf: "high" },
        { rule: "y", source: "W", tag: "release", conf: "low", baseConf: "low" },
        { rule: "z", source: "U", tag: "release", conf: "high", baseConf: "high", decisive: true },
      ],
      modifiers: [{ rule: "neg", kind: "negate", tags: ["release"] }],
    });
    expect(tags.some((t) => t.tag === "release")).toBe(false);
  });
});

describe("same-source dedup (R02 clause + R19 code snippet, same tag)", () => {
  it("multiple hits for the same tag from the same effective source still cap via max, not sum", () => {
    const tags = tagsOf("提交一下，`git commit -m x`");
    const commit = tags.find((t) => t.tag === "git-commit");
    expect(commit?.score).toBeLessThanOrEqual(0.9 + 1e-9);
  });
});
