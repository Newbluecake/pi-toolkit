// index.ts unit tests (plan.md v3.2 section 1 / section 4.4): the zero-call
// orchestration of rules + state + carry + vote, pure-function E2E only.

import { describe, expect, it } from "vitest";
import { runPredict, RULES_VERSION } from "../../../../src/memory/jev/predict/index.js";
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

describe("runPredict re-exports RULES_VERSION", () => {
  it("matches rules.ts", () => {
    expect(RULES_VERSION).toBeGreaterThan(0);
  });
});

describe("runPredict (section 4.3 worked examples)", () => {
  it("E1: dispatch decisive, no state", () => {
    const r = runPredict(input({ prompt: "派两个子 agent 并行做" }), taxonomy);
    expect(r.tags.find((t) => t.tag === "dispatch")?.score).toBeCloseTo(0.9, 5);
    expect(r.state).toEqual([]);
    expect(r.uncertain).toBe(false); // has a decisive tag
  });

  it("E2: 'continue' while release.sh is running surfaces the S constraint", () => {
    const r = runPredict(
      input({ prompt: "继续", bashJobs: [{ status: "running", command: "bash release.sh" }] }),
      taxonomy,
    );
    expect(r.state).toEqual([{ kind: "release-in-progress", evidence: "release.sh" }]);
  });

  it("E3: negated release + decisive commit + S, release never surfaces", () => {
    const r = runPredict(
      input({
        prompt: "先别发版，把这个 fix 提交了",
        bashJobs: [{ status: "running", command: "bash release.sh" }],
        todo: [{ id: 1, subject: "发布 v0.10.6", status: "in_progress" }],
      }),
      taxonomy,
    );
    expect(r.tags.some((t) => t.tag === "release")).toBe(false);
    expect(r.tags.find((t) => t.tag === "git-commit")?.score).toBeCloseTo(0.9, 5);
    expect(r.state).toHaveLength(1);
  });

  it("E4: a pure question about CI surfaces no write-action tag", () => {
    const r = runPredict(input({ prompt: "为什么 CI 挂了" }), taxonomy);
    expect(r.tags.find((t) => t.tag === "ci")?.score).toBeCloseTo(0.48, 5);
    expect(r.tags.some((t) => t.tag === "git-commit")).toBe(false);
  });

  it("E5: readonly + todo override property - 'only review, do not commit' zeroes git-commit despite a todo", () => {
    const r = runPredict(
      input({ prompt: "只评审一下，不要提交", todo: [{ id: 1, subject: "提交 PR", status: "in_progress" }] }),
      taxonomy,
    );
    expect(r.tags.some((t) => t.tag === "git-commit")).toBe(false);
  });
});

describe("runPredict uncertain gate (section 4.4 conditions 3-5 only)", () => {
  it("is false when a decisive (>=0.85) tag exists", () => {
    expect(runPredict(input({ prompt: "提交一下" }), taxonomy).uncertain).toBe(false);
  });

  it("is false when a medium (>=0.5) tag exists and the prompt is short", () => {
    // 通过承接注入一个确定的 >=0.5 tag，固定行为（规则表天然命中值都偏离 0.5 边界）。
    const withCarry = runPredict(
      input({
        prompt: "改一下这个函数",
        carry: {
          carries: 0,
          tags: [
            {
              tag: "testing",
              score: 0.6,
              sources: ["U"],
              rules: ["x"],
              evidence: { todoIds: [], jobShapes: [] },
            },
          ],
        },
      }),
      taxonomy,
    );
    expect(withCarry.tags.find((t) => t.tag === "testing")?.score).toBeGreaterThanOrEqual(0.5);
    expect(withCarry.uncertain).toBe(false); // medium tag present, prompt short (<40 codepoints)
  });

  it("is true when no tag reaches 0.5 and prompt is short", () => {
    const r = runPredict(input({ prompt: "今天天气不错" }), taxonomy);
    expect(r.tags).toEqual([]);
    expect(r.uncertain).toBe(true);
  });

  it("is true when only a medium tag exists but the prompt is long (>=40 codepoints)", () => {
    const longPrompt = "为什么 CI 挂了，".padEnd(45, "测");
    const r = runPredict(input({ prompt: longPrompt }), taxonomy);
    expect(r.uncertain).toBe(true);
  });

  it("is false when a cancel modifier fired, even with no decisive tag", () => {
    const r = runPredict(input({ prompt: "算了，先不管了" }), taxonomy);
    expect(r.uncertain).toBe(false);
  });
});

describe("runPredict carries revalidated carry state into the vote (section 3.3)", () => {
  it("a U/M-only carried tag survives with 0.95 decay when the prompt is an ack phrase", () => {
    const r = runPredict(
      input({
        prompt: "继续",
        carry: {
          carries: 0,
          tags: [
            {
              tag: "dispatch",
              score: 0.9,
              sources: ["U"],
              rules: ["R05"],
              evidence: { todoIds: [], jobShapes: [] },
            },
          ],
        },
      }),
      taxonomy,
    );
    expect(r.tags.find((t) => t.tag === "dispatch")?.score).toBeCloseTo(0.9 * 0.95, 5);
  });
});
