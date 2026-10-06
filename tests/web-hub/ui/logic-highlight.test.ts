import { describe, expect, it } from "vitest";
import {
  flattenTokens,
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINES,
  HIGHLIGHT_MAX_TOKENS,
  resolveFenceLang,
  resolveFileLang,
  shouldHighlight,
} from "../../../src/web-hub/ui/src/logic/highlight.js";

/**
 * `@logic/highlight.js` (syntax-highlight package, 2026-10) — pure logic, no prismjs import:
 * fence/filename → Prism grammar id mapping, the large-text degradation gates, and the
 * token-tree → flat `[{ cls, text }]` transform the VNode renderer consumes.
 */

describe("resolveFenceLang (markdown fence info string)", () => {
  it("maps the user-ruled language set, incl. aliases", () => {
    const cases: Array<[string, string]> = [
      ["ts", "typescript"],
      ["typescript", "typescript"],
      ["tsx", "tsx"],
      ["js", "javascript"],
      ["javascript", "javascript"],
      ["jsx", "jsx"],
      ["json", "json"],
      ["py", "python"],
      ["python", "python"],
      ["go", "go"],
      ["rs", "rust"],
      ["sh", "bash"],
      ["bash", "bash"],
      ["zsh", "bash"],
      ["shell", "bash"],
      ["yaml", "yaml"],
      ["yml", "yaml"],
      ["toml", "toml"],
      ["md", "markdown"],
      ["markdown", "markdown"],
      ["css", "css"],
      ["scss", "scss"],
      ["html", "markup"],
      ["xml", "markup"],
      ["vue", "markup"], // user ruling: vue 按 markup
      ["sql", "sql"],
      ["diff", "diff"],
      ["java", "java"],
      ["c", "c"],
      ["cpp", "cpp"],
      ["c++", "cpp"],
      ["docker", "docker"],
      ["dockerfile", "docker"],
      ["ini", "ini"],
    ];
    for (const [input, expected] of cases) {
      expect(resolveFenceLang(input), input).toBe(expected);
    }
  });

  it("is case-insensitive and ignores fence attributes", () => {
    expect(resolveFenceLang("TypeScript")).toBe("typescript");
    expect(resolveFenceLang("  JSON  ")).toBe("json");
    expect(resolveFenceLang("js {1,2}")).toBe("javascript");
  });

  it("unknown / empty languages resolve to null (plain text)", () => {
    expect(resolveFenceLang("brainfuck")).toBeNull();
    expect(resolveFenceLang("")).toBeNull();
    expect(resolveFenceLang("   ")).toBeNull();
    expect(resolveFenceLang(undefined)).toBeNull();
    expect(resolveFenceLang(null)).toBeNull();
    expect(resolveFenceLang(42)).toBeNull();
  });
});

describe("resolveFileLang (preview overlay basename)", () => {
  it("maps extensions to the same grammar ids (case-insensitive)", () => {
    const cases: Array<[string, string]> = [
      ["a.ts", "typescript"],
      ["a.TSX", "tsx"],
      ["a.mjs", "javascript"],
      ["a.jsx", "jsx"],
      ["a.json", "json"],
      ["a.py", "python"],
      ["a.go", "go"],
      ["a.rs", "rust"],
      ["a.sh", "bash"],
      ["a.zsh", "bash"],
      ["a.yml", "yaml"],
      ["a.toml", "toml"],
      ["a.md", "markdown"],
      ["a.css", "css"],
      ["a.scss", "scss"],
      ["a.html", "markup"],
      ["a.vue", "markup"],
      ["a.sql", "sql"],
      ["a.diff", "diff"],
      ["a.java", "java"],
      ["a.c", "c"],
      ["a.hpp", "cpp"],
      ["a.ini", "ini"],
    ];
    for (const [input, expected] of cases) {
      expect(resolveFileLang(input), input).toBe(expected);
    }
  });

  it("maps extensionless special filenames (Dockerfile & friends)", () => {
    expect(resolveFileLang("Dockerfile")).toBe("docker");
    expect(resolveFileLang("dockerfile")).toBe("docker");
    expect(resolveFileLang(".gitignore")).toBe("ini");
    expect(resolveFileLang(".env")).toBe("ini");
  });

  it("unknown / extensionless names resolve to null (plain text)", () => {
    expect(resolveFileLang("README")).toBeNull();
    expect(resolveFileLang("a.xyz")).toBeNull();
    expect(resolveFileLang("")).toBeNull();
    expect(resolveFileLang(undefined)).toBeNull();
    expect(resolveFileLang("trailingdot.")).toBeNull();
  });
});

describe("shouldHighlight (large-text degradation gates)", () => {
  it("accepts ordinary code", () => {
    expect(shouldHighlight("const x = 1;\n")).toBe(true);
  });

  it("rejects text past the byte cap (100 KiB, user-ruled)", () => {
    expect(shouldHighlight("a".repeat(HIGHLIGHT_MAX_BYTES))).toBe(true);
    expect(shouldHighlight("a".repeat(HIGHLIGHT_MAX_BYTES + 1))).toBe(false);
  });

  it("counts UTF-8 BYTES, not UTF-16 units: multibyte text degrades even when length < cap", () => {
    // 汉 = 3 UTF-8 bytes / 1 UTF-16 unit: 40000 units ≪ 100 KiB, but 120000 bytes > cap.
    const over = "汉".repeat(40000);
    expect(over.length).toBeLessThan(HIGHLIGHT_MAX_BYTES);
    expect(shouldHighlight(over)).toBe(false);
    // boundary: 34133 × 3 = 102399 bytes ≤ cap ⇒ still highlighted
    expect(shouldHighlight("汉".repeat(34133))).toBe(true);
    // emoji (astral, surrogate pair) = 4 bytes each: 30000 units → 120000 bytes ⇒ degrade
    const emoji = "\u{1f600}".repeat(30000);
    expect(emoji.length).toBeLessThan(HIGHLIGHT_MAX_BYTES);
    expect(shouldHighlight(emoji)).toBe(false);
    // mixed ASCII + multibyte crosses the cap mid-string
    expect(shouldHighlight("a".repeat(HIGHLIGHT_MAX_BYTES - 2) + "汉")).toBe(false);
    expect(shouldHighlight("a".repeat(HIGHLIGHT_MAX_BYTES - 3) + "汉")).toBe(true);
  });

  it("rejects text past the line cap (3000 lines, user-ruled)", () => {
    expect(shouldHighlight("\n".repeat(HIGHLIGHT_MAX_LINES - 1))).toBe(true);
    expect(shouldHighlight("\n".repeat(HIGHLIGHT_MAX_LINES))).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(shouldHighlight("")).toBe(false);
  });
});

describe("flattenTokens (Prism token tree → flat parts)", () => {
  it("passes plain strings through unclassed", () => {
    expect(flattenTokens(["hello", " ", "world"])).toEqual([{ cls: "", text: "hello world" }]);
  });

  it("classifies tokens as tok-<type> and merges adjacent runs", () => {
    const tree = [
      { type: "keyword", content: "const" },
      " ",
      { type: "keyword", content: "let" },
      { type: "number", content: "1" },
    ];
    expect(flattenTokens(tree)).toEqual([
      { cls: "tok-keyword", text: "const" },
      { cls: "", text: " " },
      { cls: "tok-keyword", text: "let" },
      { cls: "tok-number", text: "1" },
    ]);
  });

  it("stacks nested token types outermost-first", () => {
    const tree = [
      {
        type: "template-string",
        content: ["`", { type: "interpolation", content: [{ type: "number", content: "42" }] }, "`"],
      },
    ];
    expect(flattenTokens(tree)).toEqual([
      { cls: "tok-template-string", text: "`" },
      { cls: "tok-template-string tok-interpolation tok-number", text: "42" },
      { cls: "tok-template-string", text: "`" },
    ]);
  });

  it("keeps hostile content as TEXT parts, never as markup (no v-html anywhere)", () => {
    const hostile = "<script>alert(1)</script>";
    const parts = flattenTokens([{ type: "tag", content: hostile }]);
    expect(parts).toEqual([{ cls: "tok-tag", text: hostile }]);
    // the renderer turns this into a span whose CHILD is a text node — the string never
    // becomes an element name / HTML source.
    expect(JSON.stringify(parts)).not.toContain('"element"');
  });

  it("sanitizes weird token types (no class injection) and lowercases", () => {
    const tree = [
      { type: "KeyWord", content: "a" },
      { type: 'bad" onmouseover="x', content: "b" },
      { type: 42, content: "c" },
    ];
    expect(flattenTokens(tree)).toEqual([
      { cls: "tok-keyword", text: "a" },
      { cls: "", text: "bc" },
    ]);
  });

  it("returns null past the token budget (pathological grammar ⇒ plain text)", () => {
    const tree = Array.from({ length: HIGHLIGHT_MAX_TOKENS + 1 }, () => ({ type: "keyword", content: "x" }));
    expect(flattenTokens(tree)).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(flattenTokens(null)).toBeNull();
    expect(flattenTokens("nope")).toBeNull();
    expect(flattenTokens({})).toBeNull();
  });
});
