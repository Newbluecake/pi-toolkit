// optimize-plan §5 frontmatter contract + §2.1 section splitting / §10 E
// group (todo #22 P0-b).

import { describe, expect, it } from "vitest";
import {
  descriptionOrHeading,
  firstHeading,
  parseMemoryMeta,
  splitReadWhen,
  splitSections,
} from "../../src/memory/meta.js";
import { DRIFT_HEADER } from "../../src/memory/store.js";

describe("parseMemoryMeta", () => {
  it("defaults when there is no frontmatter", () => {
    const { meta, errors } = parseMemoryMeta("# Title\n\nbody", "quota");
    expect(errors).toEqual([]);
    expect(meta).toMatchObject({ topic: "quota", status: "active", pin: false, readWhenTerms: [] });
    expect(meta.description).toBeUndefined();
    expect(meta.source).toBeUndefined();
  });

  it("parses every field", () => {
    const raw = [
      "---",
      "description: Quota ladder",
      "read_when: quota; 5h window；week window",
      "topic: quota-plan",
      "status: stale",
      "updated: 2026-09-26T10:29:06.097Z",
      "pin: true",
      "source: agent",
      "---",
      "",
      "body",
    ].join("\n");
    const { meta, errors } = parseMemoryMeta(raw, "fallback");
    expect(errors).toEqual([]);
    expect(meta).toEqual({
      description: "Quota ladder",
      readWhen: "quota; 5h window；week window",
      readWhenTerms: ["quota", "5h window", "week window"],
      topic: "quota-plan",
      status: "stale",
      updated: "2026-09-26T10:29:06.097Z",
      pin: true,
      source: "agent",
    });
  });

  it("strips a matching pair of quotes around a value", () => {
    const raw = '---\ndescription: "Quoted description"\n---\n\nbody';
    expect(parseMemoryMeta(raw, "x").meta.description).toBe("Quoted description");
  });

  it("tolerates CRLF line endings", () => {
    const raw = "---\r\ndescription: CRLF test\r\n---\r\n\r\nbody";
    expect(parseMemoryMeta(raw, "x").meta.description).toBe("CRLF test");
  });

  it("last duplicate key wins (parseFrontmatter's existing rule)", () => {
    const raw = "---\ndescription: first\ndescription: second\n---\n\nbody";
    expect(parseMemoryMeta(raw, "x").meta.description).toBe("second");
  });

  it("`pin: yes` is NOT pinned (only the literal string 'true')", () => {
    const raw = "---\npin: yes\n---\n\nbody";
    expect(parseMemoryMeta(raw, "x").meta.pin).toBe(false);
  });

  it("an unterminated frontmatter block is treated as absent (no crash, falls to defaults)", () => {
    const raw = "---\ndescription: never closes\nbody without a closing fence";
    const { meta, errors } = parseMemoryMeta(raw, "fallback-topic");
    expect(errors).toEqual([]);
    expect(meta.topic).toBe("fallback-topic");
    expect(meta.description).toBeUndefined();
  });

  it("flags frontmatter over 40 lines as an error (D07)", () => {
    const lines = ["---", ...Array.from({ length: 45 }, (_, i) => `k${i}: v`), "---", "", "body"];
    const { errors } = parseMemoryMeta(lines.join("\n"), "x");
    expect(errors.some((e) => e.includes("40 lines"))).toBe(true);
  });

  it("flags frontmatter over 2KB as an error (D07)", () => {
    const raw = `---\ndescription: ${"x".repeat(2100)}\n---\n\nbody`;
    const { errors } = parseMemoryMeta(raw, "x");
    expect(errors.some((e) => e.includes("2048B"))).toBe(true);
  });

  it("flags an invalid status enum value", () => {
    const { errors, meta } = parseMemoryMeta("---\nstatus: deleted\n---\n\nbody", "x");
    expect(meta.status).toBe("active"); // falls back
    expect(errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("flags an unparseable updated value", () => {
    const { errors } = parseMemoryMeta("---\nupdated: not-a-date\n---\n\nbody", "x");
    expect(errors.some((e) => e.includes("updated"))).toBe(true);
  });

  it("accepts a bare date (no time component) as a valid updated value", () => {
    const { errors, meta } = parseMemoryMeta("---\nupdated: 2026-09-26\n---\n\nbody", "x");
    expect(errors).toEqual([]);
    expect(meta.updated).toBe("2026-09-26");
  });

  it("an invalid topic falls back to the filename-derived default", () => {
    const { meta } = parseMemoryMeta("---\ntopic: NOT VALID\n---\n\nbody", "fallback-name");
    expect(meta.topic).toBe("fallback-name");
  });
});

describe("splitReadWhen", () => {
  it("splits on both ASCII and full-width semicolons, trims, drops empties", () => {
    expect(splitReadWhen("a; b ；c;; d")).toEqual(["a", "b", "c", "d"]);
    expect(splitReadWhen("single")).toEqual(["single"]);
    expect(splitReadWhen("")).toEqual([]);
  });
});

describe("firstHeading / descriptionOrHeading", () => {
  it("returns the first H1 heading text", () => {
    expect(firstHeading("# My Title\n\nbody")).toBe("My Title");
    expect(firstHeading("intro\n\n# Later Title\n\nbody")).toBe("Later Title");
  });

  it("returns undefined when there is no H1", () => {
    expect(firstHeading("just a paragraph, no heading")).toBeUndefined();
  });

  it("strips a drift-import header before looking for the H1 (both header vintages)", () => {
    const oldHeader =
      "> **pi copy** — imported from Claude Code memory by `@getpipher/armory-memory` import. " +
      "CC original is canonical until you edit here; mirror changes to CC if you still use both.\n\n";
    expect(firstHeading(`${DRIFT_HEADER}# Real Title\n\nbody`)).toBe("Real Title");
    expect(firstHeading(`${oldHeader}# Real Title\n\nbody`)).toBe("Real Title");
  });

  it("descriptionOrHeading prefers meta.description, then H1, then the literal fallback", () => {
    expect(descriptionOrHeading("# Heading\n\nbody", { description: "explicit" } as never)).toBe("explicit");
    expect(descriptionOrHeading("# Heading\n\nbody", {} as never)).toBe("Heading");
    expect(descriptionOrHeading("no heading here", {} as never)).toBe("(no description)");
  });
});

describe("splitSections", () => {
  it("preamble is everything before the first ## (H1 title included)", () => {
    const { preamble, sections } = splitSections("# Title\n\nintro text\n\n## A\nbody a\n\n## B\nbody b\n");
    expect(preamble).toBe("# Title\n\nintro text\n");
    expect(sections.map((s) => s.heading)).toEqual(["A", "B"]);
  });

  it("### and deeper headings stay inside their ## section", () => {
    const body = "## A\ntext\n### A.1\nnested\n### A.2\nmore nested\n\n## B\nbody b\n";
    const { sections } = splitSections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.text).toContain("### A.1");
    expect(sections[0]?.text).toContain("### A.2");
    expect(sections[0]?.text).not.toContain("## B");
  });

  it("a code-fenced block's ## lines are never treated as headings", () => {
    const body = "## Real\ntext\n```\n## not a heading\n```\nmore text\n\n## Real 2\nend\n";
    const { sections } = splitSections(body);
    expect(sections.map((s) => s.heading)).toEqual(["Real", "Real 2"]);
    expect(sections[0]?.text).toContain("## not a heading");
  });

  it("a file with no ## headings has an empty section list and the whole body as preamble", () => {
    const { preamble, sections } = splitSections("# Title\n\njust prose, no sections\n");
    expect(sections).toEqual([]);
    expect(preamble).toBe("# Title\n\njust prose, no sections\n");
  });

  it("each section's text runs through (not including) the next section's heading line", () => {
    const { sections } = splitSections("## A\nline1\nline2\n## B\nline3\n");
    expect(sections[0]?.text).toBe("## A\nline1\nline2");
    expect(sections[1]?.text).toBe("## B\nline3\n"); // trailing "\n" round-trips the source's own trailing newline
  });
});
