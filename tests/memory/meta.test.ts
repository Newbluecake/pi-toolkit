// optimize-plan §5 frontmatter contract + §2.1 section splitting / §10 E
// group (todo #22 P0-b).

import { describe, expect, it } from "vitest";
import {
  descriptionOrHeading,
  firstHeading,
  isMetaLengthOverage,
  MAX_DESCRIPTION_BYTES,
  MAX_READ_WHEN_BYTES,
  parseMemoryMeta,
  splitReadWhen,
  splitSections,
  truncateMetaField,
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

describe("description/read_when byte limits (2026-10-16: 160B → 300B)", () => {
  it("the constants are the single source of truth: description 300B, read_when 240B", () => {
    expect(MAX_DESCRIPTION_BYTES).toBe(300);
    expect(MAX_READ_WHEN_BYTES).toBe(240);
  });

  it("a ~200-byte Chinese description passes validation (was over the old 160B limit)", () => {
    const desc = "配".repeat(66); // 66 × 3B = 198B
    expect(Buffer.byteLength(desc, "utf8")).toBe(198);
    const { errors, meta } = parseMemoryMeta(`---\ndescription: ${desc}\n---\n\n# t\n`, "t");
    expect(errors).toEqual([]);
    expect(meta.description).toBe(desc);
  });

  it("a >300B description still errors, with the NEW number in the message (doctor D07 text)", () => {
    const raw = `---\ndescription: ${"长".repeat(101)}\n---\n\n# t\n`; // 303B
    const { errors } = parseMemoryMeta(raw, "t");
    expect(errors).toEqual(["description exceeds 300B"]);
  });

  it("read_when keeps its 240B limit", () => {
    const { errors } = parseMemoryMeta(`---\nread_when: ${"读".repeat(81)}\n---\n\n# t\n`, "t"); // 243B
    expect(errors).toEqual(["read_when exceeds 240B"]);
  });

  it("truncateMetaField cuts at a code-point boundary and appends … only when it fits", () => {
    // 5 CJK chars = 15B. Cap 12B ⇒ 4 chars fill it exactly — no … fits
    expect(truncateMetaField("啊啊啊啊啊", 12)).toBe("啊啊啊啊");
    // cap 10/11B ⇒ 3 chars (9B); … needs 3B more ⇒ doesn't fit either
    expect(truncateMetaField("啊啊啊啊啊", 10)).toBe("啊啊啊");
    expect(truncateMetaField("啊啊啊啊啊", 11)).toBe("啊啊啊");
    // narrow prefix + wide next codepoint ⇒ 3B slack at the cut ⇒ … fits
    expect(truncateMetaField("abc😀😀", 6)).toBe("abc…");
    // never splits a surrogate pair: 2 emoji = 8B; cap 6B ⇒ first emoji only, no …
    expect(truncateMetaField("😀😀", 6)).toBe("😀");
    // at/under the limit: returned verbatim, no ellipsis
    expect(truncateMetaField("abc", 3)).toBe("abc");
    expect(truncateMetaField("abcd", 10)).toBe("abcd");
  });

  it("isMetaLengthOverage matches exactly the two overage messages", () => {
    expect(isMetaLengthOverage("description exceeds 300B")).toBe(true);
    expect(isMetaLengthOverage("read_when exceeds 240B")).toBe(true);
    expect(isMetaLengthOverage('status "x" is not one of active|stale|archived')).toBe(false);
    expect(isMetaLengthOverage("frontmatter exceeds 40 lines / 2048B — treated as invalid")).toBe(false);
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
