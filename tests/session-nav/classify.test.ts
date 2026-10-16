// web-resume plan §4 P1: the §2.1 sub rule and the §2.2 displayTitle normalizer
// (name/first/none, skill-envelope strip, C0→space, ≤120 UTF-16, surrogate-safe).

import { describe, expect, test } from "vitest";
import { displayTitle, isSubagentSession } from "../../src/session-nav/classify.js";
import type { ProvenanceIndex } from "../../src/session-nav/provenance.js";
import type { SessionHead } from "../../src/session-nav/session-head.js";

function fakeIndex(hits: string[]): ProvenanceIndex {
  const set = new Set(hits);
  return { has: (p: string) => set.has(p), complete: true };
}

function fakeHead(overrides: Partial<SessionHead>): SessionHead {
  return { id: "s", cwd: "/p", forked: false, child: false, ...overrides };
}

describe("isSubagentSession", () => {
  test("self-marker alone ⇒ sub", () => {
    expect(isSubagentSession("/x/child.jsonl", { child: true }, fakeIndex([]))).toBe(true);
  });

  test("index hit alone ⇒ sub (pre-v0.4.0 children without the marker)", () => {
    expect(isSubagentSession("/x/child.jsonl", { child: false }, fakeIndex(["/x/child.jsonl"]))).toBe(true);
    expect(isSubagentSession("/x/child.jsonl", undefined, fakeIndex(["/x/child.jsonl"]))).toBe(true);
  });

  test("neither ⇒ not sub; head undefined without index hit is not sub", () => {
    expect(isSubagentSession("/x/main.jsonl", { child: false }, fakeIndex([]))).toBe(false);
    expect(isSubagentSession("/x/main.jsonl", undefined, fakeIndex([]))).toBe(false);
  });

  test("both signals agree", () => {
    expect(isSubagentSession("/x/child.jsonl", { child: true }, fakeIndex(["/x/child.jsonl"]))).toBe(true);
  });
});

describe("displayTitle", () => {
  test("user rename wins (source name)", () => {
    expect(displayTitle(fakeHead({ name: "用户改名", firstMessage: "第一条" }))).toEqual({
      title: "用户改名",
      source: "name",
    });
  });

  test("blank name falls through to firstMessage", () => {
    expect(displayTitle(fakeHead({ name: "   ", firstMessage: "hello" }))).toEqual({
      title: "hello",
      source: "first",
    });
  });

  test("skill envelope is stripped to `[skill名] 真实输入`", () => {
    const envelope = `<skill name="dev-flow">${"SKILL 正文".repeat(40)}</skill>帮我修复构建`;
    expect(displayTitle(fakeHead({ firstMessage: envelope }))).toEqual({
      title: "[dev-flow] 帮我修复构建",
      source: "first",
    });
  });

  test("envelope without rest ⇒ bare `[skill名]`", () => {
    const envelope = `<skill name="dev-flow">${"SKILL 正文".repeat(40)}</skill>`;
    expect(displayTitle(fakeHead({ firstMessage: envelope }))).toEqual({
      title: "[dev-flow]",
      source: "first",
    });
  });

  test("no name and no firstMessage ⇒ none with empty title", () => {
    expect(displayTitle(fakeHead({}))).toEqual({ title: "", source: "none" });
    expect(displayTitle(fakeHead({ firstMessage: "   " }))).toEqual({ title: "", source: "none" });
    expect(displayTitle(fakeHead({ firstMessage: undefined }))).toEqual({ title: "", source: "none" });
  });

  test("C0 control characters become spaces", () => {
    expect(displayTitle(fakeHead({ firstMessage: "a\u0000b\u0007c\nd" }))).toEqual({
      title: "a b c d",
      source: "first",
    });
  });

  test("title capped at 120 UTF-16 units", () => {
    const long = "x".repeat(300);
    const { title } = displayTitle(fakeHead({ firstMessage: long }));
    expect(title.length).toBe(120);
  });

  test("cap never splits a surrogate pair", () => {
    // 119 ASCII chars + a 2-unit emoji: cutting at 120 would orphan the high surrogate.
    const text = "a".repeat(119) + "😀";
    const { title } = displayTitle(fakeHead({ firstMessage: text }));
    expect(title.length).toBe(119);
    expect(title).toBe("a".repeat(119));
  });

  test("a title that fits is not capped and not padded", () => {
    expect(displayTitle(fakeHead({ firstMessage: "短标题" }))).toEqual({ title: "短标题", source: "first" });
  });

  test("the skill name is included before the cap applies", () => {
    const envelope = `<skill name="dev-flow">正文</skill>${"y".repeat(200)}`;
    const { title, source } = displayTitle(fakeHead({ firstMessage: envelope }));
    expect(source).toBe("first");
    expect(title.startsWith("[dev-flow] y")).toBe(true);
    expect(title.length).toBe(120);
  });
});
