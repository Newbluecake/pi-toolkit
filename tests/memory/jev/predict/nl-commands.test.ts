// nl-commands.ts unit tests (plan.md v3.2 §3.5).

import { describe, expect, it } from "vitest";
import {
  codeSnippets,
  extractNlCommandHits,
  prosePatterns,
  proseText,
} from "../../../../src/memory/jev/predict/nl-commands.js";
import { mergeTaxonomy } from "../../../../src/memory/jev/taxonomy.js";

const TAX = mergeTaxonomy(undefined);
if (!TAX.ok) throw new Error("preset taxonomy failed to merge");
const taxonomy = TAX.taxonomy;

describe("codeSnippets", () => {
  it("extracts backtick spans and $-prefixed lines with their offsets", () => {
    const text = "跑一下 `git commit -m x`\n$ npm test";
    const hits = codeSnippets(text);
    expect(hits.map((h) => h.code)).toEqual(["git commit -m x", "npm test"]);
    // `at` 是整段匹配的起始偏移（反引号/`$ ` 本身），不是去掉外壳后的内容起始；
    // 只需在其后面不远处能找到完整命令文本。
    for (const h of hits) {
      const idx = text.indexOf(h.code, h.at);
      expect(idx).toBeGreaterThanOrEqual(h.at);
      expect(idx - h.at).toBeLessThanOrEqual(2);
    }
  });

  it("ignores empty spans", () => {
    expect(codeSnippets("``")).toEqual([]);
  });
});

describe("proseText", () => {
  it("blanks out code spans and $ lines without shifting unrelated text", () => {
    const text = "跑一下 `git commit` 好吗";
    expect(proseText(text)).not.toContain("git commit");
    expect(proseText(text)).toContain("跑一下");
  });
});

describe("prosePatterns", () => {
  it("only includes multi-word, wildcard-free command patterns", () => {
    const patterns = prosePatterns(taxonomy);
    const tags = new Set(patterns.map((p) => p.tag));
    expect(tags).toContain("git-commit"); // "git commit" — 2 words, no wildcard
    expect(tags).toContain("testing"); // "npm test" / "npx vitest"
    const releasePatterns = patterns.filter((p) => p.tag === "release");
    // "*release*.sh" 含通配，不进入散文匹配；"npm publish"/"npm version"/"gh release" 可以。
    expect(releasePatterns.some((p) => p.pattern.includes("*"))).toBe(false);
  });

  it("excludes single-word program patterns", () => {
    const patterns = prosePatterns(taxonomy);
    expect(patterns.some((p) => p.tag === "deletion" && p.pattern === "rm")).toBe(false);
  });
});

describe("extractNlCommandHits", () => {
  it("matches code snippets via parseShell + matchTags as 'code' evidence", () => {
    const hits = extractNlCommandHits("跑一下 `git commit -m x`", taxonomy);
    expect(hits.find((h) => h.tag === "git-commit")?.via).toBe("code");
  });

  it("does not misfire on an echoed command (parsed program is echo, not git)", () => {
    const hits = extractNlCommandHits('跑一下 `echo "git push"`', taxonomy);
    expect(hits.some((h) => h.tag === "git-push" && h.via === "code")).toBe(false);
  });

  it("matches multi-word prose phrasing as 'prose' evidence", () => {
    const hits = extractNlCommandHits("麻烦 npm publish 一下这个包", taxonomy);
    expect(hits.find((h) => h.tag === "release")?.via).toBe("prose");
  });

  it("does not double count the same tag from both code and prose", () => {
    const hits = extractNlCommandHits("跑一下 `git commit -m x`，git commit 这件事别忘了", taxonomy);
    const gitCommitHits = hits.filter((h) => h.tag === "git-commit");
    expect(gitCommitHits.length).toBe(2); // 允许 code + prose 并存（不同 via），但同一 via 内去重。
    expect(new Set(gitCommitHits.map((h) => h.via)).size).toBe(2);
  });

  it("returns [] for blank text", () => {
    expect(extractNlCommandHits("   ", taxonomy)).toEqual([]);
  });
});
