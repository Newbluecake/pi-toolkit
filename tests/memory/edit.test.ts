// optimize-plan §4.3 / §10 I group (todo #22 P2): edit.ts's str_replace
// match-finding, insert-target resolution, and the line-indexed section
// splitter shared with search.ts / tool-v2.ts.

import { describe, expect, test } from "vitest";
import {
  findStrReplaceMatches,
  frontmatterCloseLine,
  frontmatterEndOffset,
  resolveInsertTarget,
  resolveSectionMatch,
  sectionAtLine,
  splitSectionsWithLines,
} from "../../src/memory/edit.js";
import { MemoryError } from "../../src/memory/paths.js";

describe("findStrReplaceMatches", () => {
  test("zero matches ⇒ empty array", () => {
    expect(findStrReplaceMatches("hello world", "xyz")).toEqual([]);
  });
  test("exactly one match ⇒ its 1-indexed starting line", () => {
    expect(findStrReplaceMatches("a\nb\nfind me\nc", "find me")).toEqual([{ line: 3 }]);
  });
  test("multiple matches ⇒ one entry per occurrence, with line numbers", () => {
    expect(findStrReplaceMatches("dup\nother\ndup\n", "dup")).toEqual([{ line: 1 }, { line: 3 }]);
  });
  test("a multi-line old_str is matched by its FIRST line", () => {
    expect(findStrReplaceMatches("a\nb\nc\nd", "b\nc")).toEqual([{ line: 2 }]);
  });
});

describe("frontmatterCloseLine / frontmatterEndOffset", () => {
  test("no frontmatter ⇒ 0 / 0", () => {
    expect(frontmatterCloseLine("hello")).toBe(0);
    expect(frontmatterEndOffset("hello")).toBe(0);
  });
  test("frontmatter present ⇒ closing fence's line number and byte offset", () => {
    const body = "---\na: 1\n---\nHello\n";
    expect(frontmatterCloseLine(body)).toBe(3);
    expect(frontmatterEndOffset(body)).toBe(body.indexOf("Hello"));
  });
});

describe("resolveInsertTarget", () => {
  test("requires exactly one of insert_line/section", () => {
    expect(() => resolveInsertTarget("a\nb", {})).toThrow(/exactly one/);
    expect(() => resolveInsertTarget("a\nb", { insertLine: 1, section: "S" })).toThrow(/exactly one/);
  });
  test("insert_line within a plain body targets that line", () => {
    expect(resolveInsertTarget("a\nb\nc", { insertLine: 2 })).toEqual({ afterLine: 2 });
  });
  test("insert_line landing inside frontmatter (1..closeLine-1) errors", () => {
    const body = "---\na: 1\nb: 2\n---\nHello\n";
    expect(frontmatterCloseLine(body)).toBe(4);
    expect(() => resolveInsertTarget(body, { insertLine: 1 })).toThrow(MemoryError);
    expect(() => resolveInsertTarget(body, { insertLine: 3 })).toThrow(/frontmatter/);
    expect(resolveInsertTarget(body, { insertLine: 4 })).toEqual({ afterLine: 4 });
  });
  test("insert_line:0 with frontmatter normalizes to right after the closing fence, with a note", () => {
    const body = "---\na: 1\n---\nHello\n";
    const target = resolveInsertTarget(body, { insertLine: 0 });
    expect(target.afterLine).toBe(3);
    expect(target.note).toContain("inserted after frontmatter (line 3)");
  });
  test("insert_line:0 without frontmatter inserts at the very top", () => {
    expect(resolveInsertTarget("a\nb", { insertLine: 0 })).toEqual({ afterLine: 0 });
  });
  test("out-of-range insert_line errors", () => {
    expect(() => resolveInsertTarget("a\nb", { insertLine: 99 })).toThrow(/invalid insert_line/);
    expect(() => resolveInsertTarget("a\nb", { insertLine: -1 })).toThrow(/invalid insert_line/);
  });
  test("section targets the end of the matched section", () => {
    const body = "# Title\n\n## First\nx\n\n## Second\ny\nz\n";
    const target = resolveInsertTarget(body, { section: "Second" });
    const { sections } = splitSectionsWithLines(body);
    const second = sections.find((s) => s.heading === "Second")!;
    expect(target.afterLine).toBe(second.endLine);
  });
});

describe("splitSectionsWithLines / sectionAtLine / resolveSectionMatch", () => {
  const body = "# Title\npreamble text\n\n## Alpha\nline a1\nline a2\n\n## Alpha Beta\nline b1\n\n## Gamma\nline g1\n";

  test("preamble covers everything before the first ## heading", () => {
    const { preamble, sections } = splitSectionsWithLines(body);
    expect(preamble).toContain("# Title");
    expect(sections.map((s) => s.heading)).toEqual(["Alpha", "Alpha Beta", "Gamma"]);
  });

  test("section line ranges are correct and non-overlapping", () => {
    const { sections } = splitSectionsWithLines(body);
    const alpha = sections.find((s) => s.heading === "Alpha")!;
    const gamma = sections.find((s) => s.heading === "Gamma")!;
    expect(alpha.startLine).toBeLessThan(alpha.endLine);
    expect(gamma.endLine).toBe(body.split("\n").length);
  });

  test("code-fenced ## is not treated as a heading", () => {
    const fenced = "## Real\n```\n## not a heading\n```\nmore\n";
    const { sections } = splitSectionsWithLines(fenced);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBe("Real");
  });

  test("resolveSectionMatch: exact match (case-insensitive, # stripped)", () => {
    const { sections } = splitSectionsWithLines(body);
    expect(resolveSectionMatch(sections, "alpha").heading).toBe("Alpha");
    expect(resolveSectionMatch(sections, "## Gamma").heading).toBe("Gamma");
  });

  test("resolveSectionMatch: unique prefix match", () => {
    const { sections } = splitSectionsWithLines(body);
    expect(resolveSectionMatch(sections, "gam").heading).toBe("Gamma");
  });

  test("resolveSectionMatch: ambiguous prefix lists candidates + line numbers", () => {
    const { sections } = splitSectionsWithLines(body);
    expect(() => resolveSectionMatch(sections, "alpha")).not.toThrow(); // exact match wins over ambiguity
    const noExact = "## Foo Bar\nx\n\n## Foo Baz\ny\n";
    const { sections: s2 } = splitSectionsWithLines(noExact);
    expect(() => resolveSectionMatch(s2, "foo")).toThrow(/ambiguous/);
  });

  test("resolveSectionMatch: no match throws listing available sections", () => {
    const { sections } = splitSectionsWithLines(body);
    expect(() => resolveSectionMatch(sections, "nope")).toThrow(/no section matching/);
  });

  test("sectionAtLine: preamble line has no section; body lines resolve to their section", () => {
    const { sections } = splitSectionsWithLines(body);
    expect(sectionAtLine(sections, 1)).toBeUndefined();
    const alphaLine = sections.find((s) => s.heading === "Alpha")!.startLine + 1;
    expect(sectionAtLine(sections, alphaLine)?.heading).toBe("Alpha");
  });
});
