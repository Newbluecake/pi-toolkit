// jev/questions-eval-parity.test.ts — pins scripts/dev/jev-eval.mjs's hand-
// duplicated question templates to src/memory/jev/questions.ts's real
// implementation (jev-plan §4 J0 "一致性对照" / J2 acceptance criteria).
// Both sides are built from the same literal wording; any future edit to one
// without the other breaks this test.

import { describe, expect, it } from "vitest";
import {
  buildGateQuestions as realBuildGateQuestions,
  buildRecallQuestion as realBuildRecallQuestion,
  buildReviewQuestions as realBuildReviewQuestions,
  buildTagCoreQuestions as realBuildTagCoreQuestions,
} from "../../../src/memory/jev/questions.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import * as evalScript from "../../../scripts/dev/jev-eval.mjs";

function taxonomy() {
  const r = mergeTaxonomy();
  if (!r.ok) throw new Error("bad taxonomy");
  return r.taxonomy;
}

describe("questions-eval-parity: recall (e<n> bool template)", () => {
  it.each([
    { label: "rule · user rule · critical · tags: release", file: "core.md", excerpt: "发版规则：默认 patch" },
    { label: "assistant lesson", file: "pitfalls-git.md", excerpt: "GitHub 走代理" },
  ])("matches for %j", (entry) => {
    expect(evalScript.buildRecallQuestion(entry, {})).toEqual(realBuildRecallQuestion(entry));
  });
});

describe("questions-eval-parity: tag core m_* questions", () => {
  it("buildTagCoreQuestions() (no-arg eval script) matches buildTagCoreQuestions(taxonomy) (real)", () => {
    expect(evalScript.buildTagCoreQuestions()).toEqual(realBuildTagCoreQuestions(taxonomy()));
  });
});

describe("questions-eval-parity: gate g<n> choice questions", () => {
  it("buildGateQuestions(state, guardEntries) matches for the same inputs", () => {
    const state = { tool: "bash", command: "git push --force", programs: [], running: [], session: "main" };
    const guardEntries = [
      { id: "g1", file: "pitfalls.md", heading: "发版规则", authority: "user", excerpt: "禁止强推 dev" },
      { id: "g2", file: "core.md", authority: "agent", excerpt: "发版脚本运行期间不要动 git 状态" },
    ];
    expect(evalScript.buildGateQuestions(state, guardEntries)).toEqual(
      realBuildGateQuestions(state, guardEntries).questions,
    );
  });
});

describe("questions-eval-parity: review p<n>/o<n> questions", () => {
  it("buildReviewQuestions(project, today, pairs, staleCands) matches for the same inputs", () => {
    const pairs = [
      {
        id: "p1",
        a: { file: "core.md", updatedAt: "2026-10-12", excerpt: "GPT 禁用" },
        b: { file: "core.md", updatedAt: "2026-10-21", excerpt: "GPT 已解禁" },
      },
    ];
    const staleCands = [{ id: "o1", updatedAt: "2026-10-02", temporal: "event", excerpt: "v0.10 发版前冻结" }];
    const evalResult = evalScript.buildReviewQuestions("pi-toolkit", "2026-10-30", pairs, staleCands);
    const realResult = realBuildReviewQuestions("pi-toolkit", "2026-10-30", pairs, staleCands);
    expect(evalResult).toEqual(realResult.questions);
  });
});
