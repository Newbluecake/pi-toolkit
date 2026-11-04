/**
 * R1 · gate (plan R1 step 4; arch §4.3): the fifteen ordered veto rows, the global veto
 * corpora (SHORT_REPLY_TABLE / anaphora / cancel / IMPERATIVE_VETO), and the root-ruling
 * negation interaction for row 15 (未/没 extension, local to this gate).
 */
import { describe, expect, it } from "vitest";
import { ANAPHORA_CJK, ANAPHORA_EN, SHORT_REPLY_TABLE } from "../../../src/topic-switch/filters.js";
import { CORRECTION_RE, IMPERATIVE_VETO, evaluateGate } from "../../../src/reflex/core/gate.js";
import { normalizeInput } from "../../../src/reflex/core/normalize.js";
import type { GateFacts } from "../../../src/reflex/core/types.js";

const PASS_TEXT = "后台还有几个 job";

function facts(overrides: Partial<GateFacts> = {}): GateFacts {
  return {
    source: "interactive",
    mode: "tui",
    streamingBehavior: undefined,
    idle: true,
    pendingMessages: false,
    imageCount: 0,
    text: PASS_TEXT,
    topicSwitchActive: false,
    goalBusy: false,
    inFlight: false,
    ...overrides,
  };
}

function vetoOf(text: string, overrides: Partial<GateFacts> = {}): string {
  const result = evaluateGate(facts({ text, ...overrides }));
  if (result.pass) throw new Error(`expected a veto for ${JSON.stringify(text)}, got pass`);
  return result.veto;
}

describe("evaluateGate · fifteen rows, first hit wins", () => {
  it("0. the baseline sentence passes and returns the normalized input", () => {
    const result = evaluateGate(facts());
    expect(result).toEqual({ pass: true, norm: normalizeInput(PASS_TEXT) });
  });

  // rows 1–8: runtime facts
  it.each([
    ["source", { source: "rpc" }, "source"],
    ["source (extension)", { source: "extension" }, "source"],
    ["mode", { mode: "rpc" }, "mode"],
    ["mode (print)", { mode: "print" }, "mode"],
    ["mode (json)", { mode: "json" }, "mode"],
    ["streaming (steer)", { streamingBehavior: "steer" }, "streaming"],
    ["streaming (followUp)", { streamingBehavior: "followUp" }, "streaming"],
    ["busy (not idle)", { idle: false }, "busy"],
    ["busy (pending messages)", { pendingMessages: true }, "busy"],
    ["image", { imageCount: 1 }, "image"],
    ["fence-topic", { topicSwitchActive: true }, "fence-topic"],
    ["fence-goal", { goalBusy: true }, "fence-goal"],
    ["in-flight", { inFlight: true }, "in-flight"],
  ])("row %s ⇒ %s", (_name, override, expected) => {
    expect(vetoOf(PASS_TEXT, override as Partial<GateFacts>)).toBe(expected);
  });

  // rows 9–15: text classification
  it.each([
    ["length (1 cp < 2)", "好", "length"],
    ["length (> 120 cp)", "吗".repeat(121), "length"],
    ["multiline (\\n)", "后台还有几个\njob", "multiline"],
    ["multiline (code fence)", "``` 后台还有几个 job", "multiline"],
    ["prefix (/)", "/reflex status", "prefix"],
    ["prefix (!)", "!rebuild", "prefix"],
    ["prefix (@)", "@label 在吗", "prefix"],
    ["prefix (#)", "#123 干什么", "prefix"],
    ["prefix (mid-line @label token)", "看一下 @root 说的", "prefix"],
  ])("row %s ⇒ %s", (_name, text, expected) => {
    expect(vetoOf(text)).toBe(expected);
  });

  it("row 9 boundary: 120 code points pass, 121 veto", () => {
    expect(evaluateGate(facts({ text: "a".repeat(120) })).pass).toBe(true);
    expect(vetoOf("a".repeat(121))).toBe("length");
  });

  it("precedence: source beats mode beats streaming … (arch order)", () => {
    expect(vetoOf("好", { source: "rpc", mode: "json", streamingBehavior: "steer", idle: false, imageCount: 3 })).toBe(
      "source",
    );
    expect(vetoOf("好", { mode: "json", streamingBehavior: "steer", idle: false })).toBe("mode");
    expect(vetoOf("好", { streamingBehavior: "steer", idle: false })).toBe("streaming");
    expect(vetoOf("好", { idle: false, imageCount: 1 })).toBe("busy");
    expect(vetoOf("/x", { imageCount: 1 })).toBe("image");
    expect(vetoOf("继续", { topicSwitchActive: true })).toBe("fence-topic");
    // length (9) beats multiline/prefix/short-reply
    expect(vetoOf("继续\n好", {})).toBe("multiline");
    expect(vetoOf("/" + "x".repeat(150), {})).toBe("length");
    // short-reply (12) beats anaphora/cancel/imperative
    expect(vetoOf("commit", {})).toBe("short-reply");
    expect(vetoOf("push", {})).toBe("short-reply");
    expect(vetoOf("取消 继续", {})).toBe("cancel"); // not a short reply as a whole sentence
  });
});

describe("evaluateGate · global veto corpora (never pass)", () => {
  it("SHORT_REPLY_TABLE: every entry vetoes, with or without trailing punctuation", () => {
    expect(SHORT_REPLY_TABLE.length).toBeGreaterThanOrEqual(14);
    for (const entry of SHORT_REPLY_TABLE) {
      expect(evaluateGate(facts({ text: entry })).pass, entry).toBe(false);
      expect(evaluateGate(facts({ text: `${entry}。！~` })).pass, entry).toBe(false);
      expect(evaluateGate(facts({ text: `  ${entry}  ` })).pass, entry).toBe(false);
    }
  });

  it("ANAPHORA_CJK: each word spliced into a hit sentence head vetoes", () => {
    for (const word of ANAPHORA_CJK) {
      const text = `这个${word}后台还有几个 job`;
      const result = evaluateGate(facts({ text }));
      expect(result.pass, word).toBe(false);
      if (!result.pass) expect(result.veto, word).toBe("anaphora");
    }
  });

  it("ANAPHORA_EN: each word among the first 3 words vetoes", () => {
    for (const word of ANAPHORA_EN) {
      const result = evaluateGate(facts({ text: `${word} about the quota 还剩多少` }));
      expect(result.pass, word).toBe(false);
      if (!result.pass) expect(result.veto, word).toBe("anaphora");
    }
  });

  it("cancel sentences veto with code cancel", () => {
    for (const text of [
      "算了",
      "取消任务吧",
      "停下",
      "停止",
      "先不做了",
      "换个话题",
      "换任务",
      "stop",
      "cancel",
      "cancel the run",
    ]) {
      const result = evaluateGate(facts({ text }));
      expect(result.pass, text).toBe(false);
      if (!result.pass) expect(result.veto, text).toBe("cancel");
    }
  });

  it("IMPERATIVE_VETO: every word prepended to a hit sentence vetoes (never high)", () => {
    expect(IMPERATIVE_VETO.length).toBeGreaterThanOrEqual(26);
    for (const word of IMPERATIVE_VETO) {
      const result = evaluateGate(facts({ text: `${word}后台还有几个 job` }));
      expect(result.pass, word).toBe(false);
      if (!result.pass) {
        // 停 alone is also CANCEL_SRC (row 14 fires first); everything else is row 15.
        // Either way the composite can never reach high — the plan's requirement.
        expect(["imperative", "cancel"], word).toContain(result.veto);
      }
    }
    // Exact-code sanity: a word with no cancel overlap lands on row 15.
    expect(vetoOf("提交后台还有几个 job")).toBe("imperative");
    expect(vetoOf("kill后台还有几个 job")).toBe("imperative");
  });
});

describe("evaluateGate · row 15 negation interaction (root ruling 2026-11-05)", () => {
  it("PASSES the binding arch hit example 有未提交的改动吗 (未 negates 提交/改)", () => {
    expect(evaluateGate(facts({ text: "有未提交的改动吗" })).pass).toBe(true);
  });

  it("PASSES 没提交的有哪些 (没 negates 提交)", () => {
    expect(evaluateGate(facts({ text: "没提交的有哪些" })).pass).toBe(true);
  });

  it("VETOES 把改动提交了 / 帮我提交 (no negation before the action word)", () => {
    expect(vetoOf("把改动提交了")).toBe("imperative");
    expect(vetoOf("帮我提交")).toBe("imperative");
  });

  it("VETOES when the negation word is OUTSIDE the 8-code-point window", () => {
    // 未(0)…提(10): gap 9 > 8 ⇒ the 提交 occurrence is un-negated (改 at 6 IS exempt, gap 5).
    expect(vetoOf("未来会有很多改动等着提交吗")).toBe("imperative");
    // 别(0)…改(12): gap 11 > 8 ⇒ 改/提交 both un-negated ⇒ row 15 fires.
    expect(vetoOf("别一直在这里磨磨蹭蹭，赶紧把改动提交了吧")).toBe("imperative");
  });

  it("negation Within the window exempts via clauses.ts words too (不用/先别)", () => {
    expect(evaluateGate(facts({ text: "不用提交的文件有哪些" })).pass).toBe(true); // 不用 + 提交 adjacent
    expect(evaluateGate(facts({ text: "先别改了，只看状态" })).pass).toBe(true); // 先别 + 改 adjacent
  });

  it("CORRECTION_RE is exported for R2b/R3b and is flag-free stateless", () => {
    expect(CORRECTION_RE.test("不对")).toBe(true);
    expect(CORRECTION_RE.test("是不是这里")).toBe(true);
    expect(CORRECTION_RE.test("错了")).toBe(true);
    expect(CORRECTION_RE.test("重新跑")).toBe(true);
    expect(CORRECTION_RE.test("wrong answer")).toBe(true);
    expect(CORRECTION_RE.test("好的")).toBe(false);
    expect(CORRECTION_RE.test("好的")).toBe(false); // repeat call ⇒ same result (no /g lastIndex)
  });

  it('the reserved code "negation" is never returned by evaluateGate', () => {
    const corpus = [
      ...SHORT_REPLY_TABLE,
      "不用提交的文件有哪些",
      "别磨蹭了赶紧提交",
      "未来会有很多改动等着提交吗",
      "把改动提交了",
      PASS_TEXT,
      "工作区干净吗",
    ];
    for (const text of corpus) {
      const result = evaluateGate(facts({ text }));
      if (!result.pass) expect(result.veto, text).not.toBe("negation");
    }
  });
});
