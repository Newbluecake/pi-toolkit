/**
 * web-hub session-history plan §4.5.2 (`title.ts`, PD19): `stripSkillEnvelope` parity with
 * `src/session-nav/skill-titles.ts` (same fixture corpus, ported not imported — see the module
 * doc comment for why), `resolveTitle`'s priority order, truncation without splitting a
 * surrogate pair, and `buildSearchBlob`.
 */
import { describe, expect, it } from "vitest";
import { stripSkillEnvelope as realStripSkillEnvelope } from "../../../../../src/session-nav/skill-titles.js";
import {
  buildSearchBlob,
  resolveTitle,
  stripSkillEnvelope,
} from "../../../../../src/web-hub/hub/spawn/history/title.js";
import { HISTORY_TITLE_MAX } from "../../../../../src/web-hub/protocol/session-history.js";

const CORPUS: string[] = [
  '<skill name="dev-flow" version="3">整篇 SKILL.md 正文\n第二行</skill>帮我做这个任务',
  '<skill name="dev-flow">\nReferences are relative to /home/u/.agents/skills/dev-flow.\n',
  "just a normal message",
  '<other name="x">body</other>',
  '<skill name="a">body</skill>',
  '<skill name="a">body</skill>   trailing with spaces  ',
  '<skill name="multi-word name">x</skill>tail',
  '<skill name="x" attr="y" attr2="z">body with "quotes"</skill>rest',
  "",
  "<skill",
  '<skill name="x">unterminated no close tag',
  '<skill name="x">\nReferences are relative to foo.bar.\nmore text after',
];

describe("stripSkillEnvelope — byte-for-byte parity with src/session-nav/skill-titles.ts", () => {
  for (const text of CORPUS) {
    it(`matches for: ${JSON.stringify(text).slice(0, 60)}`, () => {
      expect(stripSkillEnvelope(text)).toEqual(realStripSkillEnvelope(text));
    });
  }
});

describe("resolveTitle", () => {
  it("priority: card name > header name > first message > none", () => {
    expect(resolveTitle({ cardName: "Card", headerName: "Header", firstMessage: "First msg" })).toEqual({
      title: "Card",
      titleSource: "name",
    });
    expect(resolveTitle({ headerName: "Header", firstMessage: "First msg" })).toEqual({
      title: "Header",
      titleSource: "name",
    });
    expect(resolveTitle({ firstMessage: "First msg" })).toEqual({ title: "First msg", titleSource: "first" });
    expect(resolveTitle({})).toEqual({ titleSource: "none" });
  });

  it("blank card/header names fall through to the next priority instead of winning empty", () => {
    expect(resolveTitle({ cardName: "   ", headerName: "Header" })).toEqual({ title: "Header", titleSource: "name" });
    expect(resolveTitle({ cardName: "  ", headerName: "  ", firstMessage: "msg" })).toEqual({
      title: "msg",
      titleSource: "first",
    });
  });

  it("folds internal whitespace/newlines into single spaces and trims", () => {
    expect(resolveTitle({ firstMessage: "line one\n\n  line  two\t\tthree " })).toEqual({
      title: "line one line two three",
      titleSource: "first",
    });
  });

  it("strips a skill envelope from the first-message fallback only", () => {
    const r = resolveTitle({ firstMessage: '<skill name="dev-flow">正文</skill>真实输入' });
    expect(r).toEqual({ title: "[dev-flow] 真实输入", titleSource: "first" });
  });

  it("truncates to HISTORY_TITLE_MAX units without splitting a surrogate pair", () => {
    const emoji = "\u{1F600}"; // single codepoint, 2 UTF-16 units
    const long = "a".repeat(HISTORY_TITLE_MAX - 1) + emoji; // pair would straddle the cut
    const r = resolveTitle({ firstMessage: long });
    expect(r.title?.length).toBeLessThanOrEqual(HISTORY_TITLE_MAX);
    // the trailing surrogate half must never appear alone
    const lastUnit = r.title?.charCodeAt((r.title?.length ?? 1) - 1) ?? 0;
    expect(lastUnit < 0xd800 || lastUnit > 0xdbff).toBe(true);
  });
});

describe("buildSearchBlob", () => {
  it("joins cwd/display/firstMessage, NFKC-normalizes, lowercases, and truncates to 1 KiB", () => {
    const blob = buildSearchBlob("/W/Path", "Title", "Some MESSAGE");
    expect(blob).toContain("/w/path");
    expect(blob).toContain("title");
    expect(blob).toContain("some message");
  });

  it("truncates to at most 1024 UTF-16 units", () => {
    const blob = buildSearchBlob("/w", undefined, "x".repeat(5000));
    expect(blob.length).toBeLessThanOrEqual(1024);
  });
});
