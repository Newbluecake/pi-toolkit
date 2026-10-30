// jev/questions.test.ts — token estimation, batching, and the six
// build*Questions shapes (jev-plan J2).

import { describe, expect, it } from "vitest";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
import {
  buildErrorQuestions,
  buildGateQuestions,
  buildRecallQuestion,
  buildRecallQuestions,
  buildReviewQuestions,
  buildTagCoreQuestions,
  buildTagMajorQuestions,
  buildTagQuestions,
  estimateTokens,
  recallLabel,
  splitBatches,
} from "../../../src/memory/jev/questions.js";
import type { JevQuestion } from "../../../src/memory/jev/contracts.js";
import { QUESTION_BATCH_TOKENS } from "../../../src/memory/jev/contracts.js";

/** Computes a bool question's `instructions` length that makes
 *  `estimateTokens` equal exactly `target` (closed-form, O(1) — the earlier
 *  brute-force byte-by-byte growth was O(n²) and too slow for targets near
 *  12,000). For this question shape, `bytes = len(instructions) + 4`
 *  (space + the fixed `"t f"` criteria text) and
 *  `tokens = ceil(bytes/3) + 40`; picking `len` so `bytes` is an exact
 *  multiple of 3 lands precisely on `target` (`ceil(bytes/3)` is
 *  non-decreasing and steps by at most 1 per byte, so it passes through
 *  every integer without skipping — this is simply the inverse, chosen at
 *  the top of its plateau). */
function growToExactTokens(target: number): JevQuestion {
  const len = Math.max(0, 3 * (target - 40) - 4);
  return { type: "bool", instructions: "x".repeat(len), criteria: { true: "t", false: "f" } };
}

function taxonomy() {
  const r = mergeTaxonomy();
  if (!r.ok) throw new Error("bad taxonomy");
  return r.taxonomy;
}

describe("estimateTokens", () => {
  it("counts instructions + criteria bytes over 3, plus 40", () => {
    const q: JevQuestion = { type: "bool", instructions: "abc", criteria: { true: "d", false: "e" } };
    // "abc d e" -> 7 bytes -> ceil(7/3)=3 -> +40 = 43
    expect(estimateTokens(q)).toBe(43);
  });

  it("choice and score variants both account their full criteria text", () => {
    const choice: JevQuestion = { type: "choice", instructions: "x", criteria: { a: "aa", b: "bb" } };
    const score: JevQuestion = { type: "score", instructions: "x", criteria: ["one", "two"] };
    expect(estimateTokens(choice)).toBeGreaterThan(40);
    expect(estimateTokens(score)).toBeGreaterThan(40);
  });
});

describe("splitBatches", () => {
  const mkBool = (n: number): JevQuestion => ({
    type: "bool",
    instructions: "x".repeat(n),
    criteria: { true: "t", false: "f" },
  });

  it("fits everything in one batch when under the cap", () => {
    const batches = splitBatches({ a: 1 }, { q1: mkBool(10), q2: mkBool(10) }, 1000);
    expect(batches.length).toBe(1);
    expect(Object.keys(batches[0]!.questions)).toEqual(["q1", "q2"]);
  });

  it("splits once the running total would exceed the cap", () => {
    // Each question ~ ceil(n/3)+40 tokens; pick n so two together exceed a
    // small cap but one alone fits.
    const q = mkBool(300); // ~140 tokens
    const batches = splitBatches({}, { q1: q, q2: q, q3: q }, 150);
    expect(batches.length).toBeGreaterThan(1);
    const allIds = batches.flatMap((b) => Object.keys(b.questions));
    expect(allIds.sort()).toEqual(["q1", "q2", "q3"]);
  });

  it("a single question heavier than the cap still gets its own batch", () => {
    const huge = mkBool(50_000);
    const batches = splitBatches({}, { only: huge }, 100);
    expect(batches.length).toBe(1);
    expect(Object.keys(batches[0]!.questions)).toEqual(["only"]);
  });

  it("every batch carries the same state object", () => {
    const state = { x: 1 };
    const batches = splitBatches(state, { a: mkBool(10) });
    expect(batches[0]!.state).toBe(state);
  });

  it("empty questions still yields one batch with no questions", () => {
    const batches = splitBatches({}, {});
    expect(batches).toEqual([{ state: {}, questions: {} }]);
  });

  it("exact default-cap boundary: a combined total of exactly QUESTION_BATCH_TOKENS (12,000) fits in one batch", () => {
    // state={} costs 1 token (ceil(byteLength('{}')/3)); build two questions
    // whose estimateTokens() sum, together with that 1, lands EXACTLY on
    // QUESTION_BATCH_TOKENS (12,000) using the library's own default cap
    // (no cap argument passed to splitBatches).
    const minimal = mkBool(0); // smallest possible bool question (42 tokens)
    const minimalTokens = estimateTokens(minimal);
    const filler = growToExactTokens(QUESTION_BATCH_TOKENS - 1 - minimalTokens);
    expect(1 + estimateTokens(filler) + minimalTokens).toBe(QUESTION_BATCH_TOKENS);

    const batches = splitBatches({}, { q1: filler, q2: minimal });
    expect(batches.length).toBe(1);
    expect(Object.keys(batches[0]!.questions).sort()).toEqual(["q1", "q2"]);
  });

  it("exact default-cap boundary + 1 (12,001) splits into two batches", () => {
    const minimal = mkBool(0);
    const minimalTokens = estimateTokens(minimal);
    // One token heavier than the previous case: total is now 12,001.
    const filler = growToExactTokens(QUESTION_BATCH_TOKENS - minimalTokens);
    expect(1 + estimateTokens(filler) + minimalTokens).toBe(QUESTION_BATCH_TOKENS + 1);

    const batches = splitBatches({}, { q1: filler, q2: minimal });
    expect(batches.length).toBe(2);
    expect(Object.keys(batches[0]!.questions)).toEqual(["q1"]);
    expect(Object.keys(batches[1]!.questions)).toEqual(["q2"]);
  });
});

describe("recallLabel", () => {
  it("renders type · authority · importance · tags in order (jev-arch example)", () => {
    expect(recallLabel({ type: "rule", authority: "user", importance: 3, tags: ["release"] })).toBe(
      "rule · user rule · critical · tags: release",
    );
  });

  it("omits absent fields", () => {
    expect(recallLabel({ authority: "agent" })).toBe("assistant lesson");
  });
});

describe("buildRecallQuestion / buildRecallQuestions (§6.1.1)", () => {
  it("single-entry wording matches the architecture text verbatim", () => {
    const q = buildRecallQuestion({ label: "rule · user rule", file: "core.md", excerpt: "发版规则" });
    expect(q.instructions).toContain("Project memory entry [rule · user rule] from core.md: 「发版规则」.");
    expect(q.instructions).toContain("Would reminding the assistant of this entry right now help");
    expect(q.type).toBe("bool");
  });

  it("builds state with user_message/previous_user_message/session/today and one e<n> per candidate", () => {
    const batch = buildRecallQuestions({
      userMessage: "那发版呢？",
      previousUserMessage: "帮我把 dev 推到 GitHub",
      session: "main",
      today: "2026-10-30",
      candidates: [{ id: "e17", file: "core.md", excerpt: "发版规则", authority: "user", type: "rule", importance: 3 }],
    });
    expect(batch.state).toEqual({
      user_message: "那发版呢？",
      previous_user_message: "帮我把 dev 推到 GitHub",
      session: "main",
      today: "2026-10-30",
    });
    expect(Object.keys(batch.questions)).toEqual(["e17"]);
  });

  it("omits previous_user_message when absent", () => {
    const batch = buildRecallQuestions({
      userMessage: "x",
      session: "child",
      today: "2026-10-30",
      candidates: [],
    });
    expect(batch.state).not.toHaveProperty("previous_user_message");
  });
});

describe("buildErrorQuestions (§6.1.4)", () => {
  it("builds the failure state and one bool per candidate", () => {
    const batch = buildErrorQuestions({
      tool: "bash",
      command: "npx vitest run",
      exitCode: 1,
      errorExcerpt: "ENOENT",
      candidates: [{ id: "x1", file: "pitfalls.md", excerpt: "run build before test", type: "pitfall" }],
    });
    expect(batch.state).toEqual({ tool: "bash", command: "npx vitest run", exit_code: 1, error_excerpt: "ENOENT" });
    expect(batch.questions["x1"]?.type).toBe("bool");
  });
});

describe("buildTagCoreQuestions / buildTagQuestions (§6.2.2)", () => {
  it("the 5 m_* questions are present with criteria sourced from the taxonomy types", () => {
    const qs = buildTagCoreQuestions(taxonomy());
    expect(Object.keys(qs).sort()).toEqual(["m_guard", "m_importance", "m_temporal", "m_type", "m_userlike"]);
    expect(qs.m_type).toEqual({
      type: "choice",
      instructions: "What kind of project-memory entry is this?",
      criteria: Object.fromEntries(taxonomy().types.map((t) => [t.id, t.description])),
    });
  });

  it("full tag call adds one t_<id> per enabled tag and up to 20 c<n> comparisons", () => {
    const tax = taxonomy();
    const compare = Array.from({ length: 25 }, (_, i) => ({ id: `c${i + 1}`, file: "a.md", excerpt: `x${i}` }));
    const batch = buildTagQuestions({ body: "entry body", file: "a.md", today: "2026-10-30" }, tax, compare);
    const tIds = Object.keys(batch.questions).filter((k) => k.startsWith("t_"));
    expect(tIds.length).toBe(tax.tags.length);
    const cIds = Object.keys(batch.questions).filter((k) => k.startsWith("c"));
    expect(cIds.length).toBe(20);
    expect(batch.state).toEqual({ entry: "entry body", file: "a.md", heading: "", today: "2026-10-30" });
  });
});

describe("buildTagMajorQuestions (§6.2.3)", () => {
  it("state carries only the tag; one bool per entry", () => {
    const tax = taxonomy();
    const tag = tax.tags[0]!;
    const batch = buildTagMajorQuestions(tag, [
      { id: "k1", excerpt: "entry 1" },
      { id: "k2", excerpt: "entry 2" },
    ]);
    expect(batch.state).toEqual({ tag: `${tag.id}: ${tag.description}` });
    expect(Object.keys(batch.questions)).toEqual(["k1", "k2"]);
  });
});

describe("buildReviewQuestions (§6.3.3)", () => {
  it("builds p<n> relation questions and o<n> obsolescence questions", () => {
    const batch = buildReviewQuestions(
      "pi-toolkit",
      "2026-10-30",
      [
        {
          id: "p41",
          a: { file: "core.md", updatedAt: "2026-10-12", excerpt: "GPT 禁用" },
          b: { file: "core.md", updatedAt: "2026-10-21", excerpt: "GPT 已解禁" },
        },
      ],
      [{ id: "o7", updatedAt: "2026-10-02", temporal: "event", excerpt: "v0.10 发版前冻结" }],
    );
    expect(batch.state).toEqual({ project: "pi-toolkit", today: "2026-10-30" });
    expect(batch.questions.p41?.type).toBe("choice");
    expect(Object.keys((batch.questions.p41 as { criteria: Record<string, string> }).criteria).sort()).toEqual(
      ["a_supersedes_b", "b_supersedes_a", "complementary", "conflict", "duplicate", "unrelated"].sort(),
    );
    expect(batch.questions.o7?.type).toBe("bool");
  });
});

describe("buildGateQuestions (§6.4.3)", () => {
  it("builds one choice question per guarding entry, state passed through unchanged", () => {
    const state = { tool: "bash", command: "git commit -m x" };
    const batch = buildGateQuestions(state, [
      {
        id: "g1",
        file: "pitfalls.md",
        heading: "发版进行中禁止动 git 状态",
        authority: "user",
        excerpt: "release.sh 运行期间禁止 commit",
      },
    ]);
    expect(batch.state).toBe(state);
    expect(batch.questions.g1).toEqual({
      type: "choice",
      instructions:
        "Project rule (user rule) from pitfalls.md › 发版进行中禁止动 git 状态: 「release.sh 运行期间禁止 commit」 How does this rule relate to the pending tool call described in state?",
      criteria: {
        unrelated: "The rule does not cover this tool call",
        applies: "The rule covers this kind of action; the assistant must review the rule before running it",
        violates_now:
          "The rule covers this action AND its condition holds right now according to state, so running it now would break the rule",
      },
    });
  });
});
