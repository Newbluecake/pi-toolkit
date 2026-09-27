// optimize-plan §4.3 / §10 I6 (todo #22 P2): search.ts's whitespace-tokenized,
// literal, case-insensitive multi-word scoring.

import { describe, expect, test } from "vitest";
import { searchMemory } from "../../src/memory/search.js";

describe("searchMemory", () => {
  test("empty query ⇒ no hits", () => {
    expect(searchMemory([{ name: "a.md", body: "hello world" }], "")).toEqual([]);
    expect(searchMemory([{ name: "a.md", body: "hello world" }], "   ")).toEqual([]);
  });

  test("literal match, case-insensitive; coordinate format", () => {
    const hits = searchMemory([{ name: "a.md", body: "line one\nfind ME here\nline three" }], "find me");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "a.md", line: 2, text: "find ME here", archived: false });
  });

  test("literal matching — a query word is never treated as a regex", () => {
    const hits = searchMemory([{ name: "a.md", body: "a.b.c\nreal .*. text" }], ".*.");
    expect(hits.map((h) => h.text)).toEqual(["real .*. text"]);
  });

  test("multi-word scoring: more distinct matched words rank first", () => {
    const files = [{ name: "a.md", body: "alpha only line\nalpha and beta line\nneither line" }];
    const hits = searchMemory(files, "alpha beta");
    expect(hits.map((h) => h.text)).toEqual(["alpha and beta line", "alpha only line"]);
  });

  test("ties break by filename then line number", () => {
    const files = [
      { name: "b.md", body: "alpha here" },
      { name: "a.md", body: "alpha here too\nalpha again" },
    ];
    const hits = searchMemory(files, "alpha");
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(["a.md:1", "a.md:2", "b.md:1"]);
  });

  test("capped at 20 hits", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `hit number ${i}`);
    const hits = searchMemory([{ name: "a.md", body: lines.join("\n") }], "hit");
    expect(hits).toHaveLength(20);
  });

  test("each hit's text is hard-truncated to 160 UTF-8 bytes TOTAL, including the trailing ellipsis marker", () => {
    const long = "x".repeat(300) + " target";
    const hits = searchMemory([{ name: "a.md", body: long }], "target");
    expect(Buffer.byteLength(hits[0]!.text, "utf8")).toBeLessThanOrEqual(160);
    expect(hits[0]!.text.endsWith("…")).toBe(true);
  });

  test("truncation never splits a multi-byte code point, even right at the 160-byte boundary", () => {
    // each CJK char is 3 UTF-8 bytes; 200 of them guarantees the cut falls
    // mid-character unless the truncation logic is code-point aware.
    const long = "缓".repeat(200);
    const hits = searchMemory([{ name: "a.md", body: long + " target" }], "target");
    const text = hits[0]!.text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(160);
    // round-tripping through Buffer must reproduce the exact same string —
    // a split code point would come back as U+FFFD replacement characters.
    expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
    expect(text).not.toContain("\uFFFD");
    expect(text.endsWith("…")).toBe(true);
  });

  test("CJK content matches literally", () => {
    const hits = searchMemory([{ name: "a.md", body: "第一行\n缓存保活与自适应\n第三行" }], "保活");
    expect(hits.map((h) => h.text)).toEqual(["缓存保活与自适应"]);
  });

  test("description/read_when frontmatter fields are searchable (raw body includes frontmatter)", () => {
    const body = "---\ndescription: quota-aware dispatch\nread_when: quota; ladder\n---\n\n# Quota\nbody text\n";
    const hits = searchMemory([{ name: "quota.md", body }], "ladder");
    expect(hits.some((h) => h.text.includes("read_when"))).toBe(true);
  });

  test("archived files are marked", () => {
    const archived = "---\nstatus: archived\n---\n\nold fact here\n";
    const active = "---\nstatus: active\n---\n\nold fact here too\n";
    const hits = searchMemory(
      [
        { name: "old.md", body: archived },
        { name: "new.md", body: active },
      ],
      "old fact",
    );
    const oldHit = hits.find((h) => h.file === "old.md");
    const newHit = hits.find((h) => h.file === "new.md");
    expect(oldHit?.archived).toBe(true);
    expect(newHit?.archived).toBe(false);
  });

  test("section is reported for hits inside a ## section, undefined for preamble hits", () => {
    const body = "# Title\npreamble target line\n\n## Alpha\ntarget inside alpha\n";
    const hits = searchMemory([{ name: "a.md", body }], "target");
    const preambleHit = hits.find((h) => h.text.includes("preamble"));
    const alphaHit = hits.find((h) => h.text.includes("inside alpha"));
    expect(preambleHit?.section).toBeUndefined();
    expect(alphaHit?.section).toBe("Alpha");
  });

  test("more than 8 query words: only the first 8 are used for scoring", () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const line = words.slice(0, 8).join(" "); // only first 8 present in the line
    const hits = searchMemory([{ name: "a.md", body: line }], words.join(" "));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe(line);
  });

  test("duplicate query words are deduplicated — repeating a term must not out-weigh a genuinely distinct match", () => {
    // query weights "cat" 2x and "dog" 1x by accident (a repeated term).
    // Without dedup, a file matching ONLY the repeated "cat" scores 2 while
    // a file matching ONLY "dog" scores 1 — purely an artifact of the typo,
    // not of relevance. Deduped, both match exactly 1 distinct word and tie
    // (broken by filename, so a.md sorts before b.md).
    const files = [
      { name: "a.md", body: "dog leash" },
      { name: "b.md", body: "cat toy" },
    ];
    const hits = searchMemory(files, "cat cat dog");
    expect(hits.map((h) => h.file)).toEqual(["a.md", "b.md"]);
  });

  test("deduplication is case-insensitive (Alpha / alpha collapse to one word)", () => {
    const hits = searchMemory([{ name: "a.md", body: "alpha line" }], "Alpha alpha ALPHA");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe("alpha line");
  });

  test("the 8-word cap counts DISTINCT words — a duplicate doesn't consume a slot", () => {
    const words = Array.from({ length: 8 }, (_, i) => `w${i}`);
    const line = words.join(" "); // exactly 8 distinct words present
    // query repeats w0 first, then lists w0..w8 (9 distinct + 1 repeat) —
    // deduping the repeat must free a slot so w0..w7 (all 8 in the line) are
    // still scored, rather than the repeat wasting a slot and pushing w7 out.
    const hits = searchMemory([{ name: "a.md", body: line }], `w0 ${words.join(" ")} w8`);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe(line);
  });
});
