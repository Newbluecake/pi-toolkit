// clauses.ts unit tests (plan.md v3.2 §3.1 / §11.1).

import { describe, expect, it } from "vitest";
import {
  cancelIntent,
  negationSpans,
  negationWithinWindow,
  readonlyIntent,
  splitClauses,
  WRITE_ACTION_TAGS,
} from "../../../../src/memory/jev/predict/clauses.js";

describe("splitClauses", () => {
  it("splits on punctuation and connectives, dropping empty clauses", () => {
    const clauses = splitClauses("提交一下，然后推送");
    expect(clauses.map((c) => c.text)).toEqual(["提交一下", "推送"]);
  });

  it("marks question clauses by trailing ? and by leading interrogatives", () => {
    expect(splitClauses("为什么 CI 挂了")[0]?.question).toBe(true);
    expect(splitClauses("这个能跑吗")[0]?.question).toBe(true);
    expect(splitClauses("你能跑吗？")[0]?.question).toBe(true);
    expect(splitClauses("提交一下")[0]?.question).toBe(false);
  });

  it("treats polite imperatives as imperative despite the opener", () => {
    const [clause] = splitClauses("能帮我提交一下吗");
    // "吗" 结尾本应判为疑问，但礼貌祈使例外覆盖为祈使句（§3.1）。
    expect(clause?.question).toBe(false);
    expect(clause?.imperative).toBe(true);
  });

  it("exposes original-prompt offsets for each clause", () => {
    const prompt = "提交一下，然后推送";
    const clauses = splitClauses(prompt);
    for (const c of clauses) {
      expect(prompt.slice(c.start, c.end)).toContain(c.text);
    }
  });

  it("does not catastrophically backtrack on a 10k-codepoint prompt (<50ms, plan §12.3 CI 口径)", () => {
    const prompt = "提交一下，".repeat(2000) + "为什么挂了？".repeat(2000);
    expect(Array.from(prompt).length).toBeGreaterThanOrEqual(10000);
    splitClauses(prompt); // JIT warmup
    const start = performance.now();
    splitClauses(prompt);
    // 本地 p99 <2ms；断言按 plan §12.3 CI 口径取 <50ms，防的是灾难性指数
    // 回溯（无界 regex 回溯会到秒级），不是精确性能基准。
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("negationWithinWindow / negationSpans", () => {
  it("detects negation within 8 codepoints before the action", () => {
    const text = "先别提交";
    const idx = text.indexOf("提交");
    expect(negationWithinWindow(text, idx)).toBe(true);
  });

  it("does not detect negation when it is too far away", () => {
    const text = "先别管那个事情了随便你怎么想都行最后提交";
    const idx = text.indexOf("提交");
    expect(negationWithinWindow(text, idx)).toBe(false);
  });

  it("does not detect negation when the negator is after the action", () => {
    const text = "提交吧不要犹豫";
    const idx = text.indexOf("提交");
    expect(negationWithinWindow(text, idx)).toBe(false);
  });

  it("supports English negators with word boundaries", () => {
    const text = "don't push this";
    const idx = text.indexOf("push");
    expect(negationWithinWindow(text, idx)).toBe(true);
    // "wouldnt" contains no boundary-safe "don't"/"do not"; must not false-positive.
    expect(negationSpans("adontb push").length).toBe(0);
  });

  it("negationSpans reports every negator with position", () => {
    const spans = negationSpans("先别提交，也不要推送");
    expect(spans.map((s) => s.word)).toEqual(["先别", "不要"]);
  });
});

describe("readonlyIntent", () => {
  it.each(["只评审一下这个 PR", "只是看看就行", "review一下就好", "不改代码，只是分析", "dry-run 一下", "dry run"])(
    "detects readonly phrasing: %s",
    (text) => {
      expect(readonlyIntent(text)).toBe(true);
    },
  );

  it.each(["提交一下", "派两个子 agent 并行做", "推送到 origin"])(
    "does not flag normal action phrasing: %s",
    (text) => {
      expect(readonlyIntent(text)).toBe(false);
    },
  );

  it("exposes the write-action tag allowlist it applies to", () => {
    expect(WRITE_ACTION_TAGS).toContain("git-commit");
    expect(WRITE_ACTION_TAGS).toContain("release");
    expect(WRITE_ACTION_TAGS).not.toContain("testing");
  });
});

describe("cancelIntent", () => {
  it.each(["算了", "取消吧", "stop", "cancel this", "换个任务", "先不做了", "不做了"])(
    "detects cancel phrasing: %s",
    (text) => {
      expect(cancelIntent(text)).toBe(true);
    },
  );

  it.each(["继续", "提交一下", "今天天气不错"])("does not flag unrelated phrasing: %s", (text) => {
    expect(cancelIntent(text)).toBe(false);
  });
});
