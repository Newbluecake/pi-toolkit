/**
 * `@logic/file-mention.js` pure units (web-hub @文件补全): the search URL builder, the
 * defensive wire parser, send-time token detection (start contexts, terminators, trailing
 * punctuation, `:line` suffixes, cwd segment-alignment, dedup), UTF-8 truncation, and the
 * attachment-style block composition under the shared 48 KiB prompt cap (whole-file inclusion,
 * truncation with the label-delta shave, budget/`floor`/count skips, newline-path defense).
 */

import { describe, expect, it } from "vitest";
import {
  buildFileSearchUrl,
  expandPromptWithFiles,
  FILE_MENTION_MAX_FILES,
  findFileMentionTokens,
  isImagePath,
  parseFileSearchResults,
  utf8Truncate,
} from "../../../src/web-hub/ui/src/logic/file-mention.js";
import { PROMPT_MAX_UTF8_BYTES } from "../../../src/web-hub/ui/src/logic/upload.js";
import { FILE_SEARCH_PATH } from "../../../src/web-hub/hub/file-search.js";

const CWD = "/home/u/repo";

// ---------------------------------------------------------------------------
// completion helpers
// ---------------------------------------------------------------------------

describe("buildFileSearchUrl", () => {
  it("encodes every parameter and clamps limit into 1..50", () => {
    expect(buildFileSearchUrl("/api/files/search", "agent-a", "re ad", 20)).toBe(
      "/api/files/search?agentKey=agent-a&q=re%20ad&limit=20",
    );
    expect(buildFileSearchUrl("/api/files/search", "a", "x", 999).endsWith("limit=50")).toBe(true);
    expect(buildFileSearchUrl("/api/files/search", "a", "x", 0).endsWith("limit=1")).toBe(true);
    expect(buildFileSearchUrl("/api/files/search", "a", "书", 20)).toBe(
      "/api/files/search?agentKey=a&q=%E4%B9%A6&limit=20",
    );
  });

  it("points at the hub's endpoint (mirror pin)", () => {
    expect(buildFileSearchUrl(FILE_SEARCH_PATH, "a", "q", 5).startsWith(FILE_SEARCH_PATH)).toBe(true);
  });
});

describe("parseFileSearchResults", () => {
  it("accepts a well-formed body and drops dup/non-absolute/newline paths", () => {
    const rows = parseFileSearchResults({
      ok: true,
      results: [
        { path: "/a/b.ts", rel: "b.ts" },
        { path: "/a/b.ts", rel: "b.ts" },
        { path: "relative.ts", rel: "relative.ts" },
        { path: "/a/nl\n.ts", rel: "nl" },
        { path: "/c/d.ts", rel: "d.ts" },
        "junk",
        null,
      ],
    });
    expect(rows).toEqual([
      { path: "/a/b.ts", rel: "b.ts" },
      { path: "/c/d.ts", rel: "d.ts" },
    ]);
  });

  it("anything malformed ⇒ [] (silent degrade, never throws)", () => {
    for (const bad of [undefined, null, {}, { ok: false }, { ok: true }, { ok: true, results: {} }, "x", 42]) {
      expect(parseFileSearchResults(bad)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// token detection
// ---------------------------------------------------------------------------

describe("findFileMentionTokens", () => {
  it("line-start and after-whitespace tokens; mid-word @ is not a token", () => {
    const text = `@/home/u/repo/a.ts mid @/home/u/repo/b.ts x@/home/u/repo/c.ts`;
    expect(findFileMentionTokens(text, CWD).map((t) => t.path)).toEqual(["/home/u/repo/a.ts", "/home/u/repo/b.ts"]);
  });

  it("terminators end the token; trailing punctuation and :line[:col] are stripped", () => {
    expect(findFileMentionTokens(`see @/home/u/repo/a.ts, ok`, CWD).map((t) => t.path)).toEqual(["/home/u/repo/a.ts"]);
    expect(findFileMentionTokens(`see @/home/u/repo/a.ts.`, CWD)[0]!.path).toBe("/home/u/repo/a.ts");
    expect(findFileMentionTokens(`@/home/u/repo/a.ts:12`, CWD)[0]!.path).toBe("/home/u/repo/a.ts");
    expect(findFileMentionTokens(`@/home/u/repo/a.ts:12:34.`, CWD)[0]!.path).toBe("/home/u/repo/a.ts");
    expect(findFileMentionTokens(`@/home/u/repo/a.ts)`, CWD)[0]!.path).toBe("/home/u/repo/a.ts");
  });

  it("requires the token to sit inside cwd (segment-aligned); sibling/home paths are ignored", () => {
    expect(findFileMentionTokens(`@/home/u/other/a.ts`, CWD)).toEqual([]);
    expect(findFileMentionTokens(`@/home/u/repo2/a.ts`, CWD)).toEqual([]); // segment alignment
    expect(findFileMentionTokens(`@/home/u/repo/a.ts`, "/")).toEqual([]); // never /
    expect(findFileMentionTokens(`@/home/u/repo/a.ts`, `${CWD}/`)[0]!.path).toBe("/home/u/repo/a.ts");
  });

  it("relative @label mentions and bare @ never match (task #11 stays orthogonal)", () => {
    expect(findFileMentionTokens(`@bot run it`, CWD)).toEqual([]);
    expect(findFileMentionTokens(`@ hello`, CWD)).toEqual([]);
    expect(findFileMentionTokens(``, CWD)).toEqual([]);
    expect(findFileMentionTokens(undefined, CWD)).toEqual([]);
  });

  it("duplicates collapse to the first occurrence; positions cover the raw slice", () => {
    const text = `@/home/u/repo/a.ts and again @/home/u/repo/a.ts`;
    const tokens = findFileMentionTokens(text, CWD);
    expect(tokens).toHaveLength(1);
    expect(text.slice(tokens[0]!.start, tokens[0]!.end)).toBe("/home/u/repo/a.ts");
  });

  it("multi-line text: line starts after \\n count as start contexts", () => {
    const text = `intro\n@/home/u/repo/a.ts\ntail @/home/u/repo/b.ts`;
    expect(findFileMentionTokens(text, CWD).map((t) => t.path)).toEqual(["/home/u/repo/a.ts", "/home/u/repo/b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// truncation + expansion
// ---------------------------------------------------------------------------

describe("utf8Truncate", () => {
  it("byte-accurate and code-point safe (CJK + emoji)", () => {
    expect(utf8Truncate("abc", 5)).toBe("abc");
    expect(utf8Truncate("abcdef", 3)).toBe("abc");
    expect(new TextEncoder().encode(utf8Truncate("汉字汉字", 5)).length).toBeLessThanOrEqual(5);
    expect(utf8Truncate("汉字汉字", 5)).toBe("汉"); // 3+3 > 5 ⇒ first char only
    expect(utf8Truncate("a😀b", 3)).toBe("a"); // emoji is 4 bytes — cut before it, no U+FFFD
    expect(utf8Truncate("汉字", 100)).toBe("汉字");
  });
});

describe("isImagePath", () => {
  it("covers common image extensions, case-insensitive", () => {
    expect(isImagePath("/a/b.png")).toBe(true);
    expect(isImagePath("/a/b.JPG")).toBe(true);
    expect(isImagePath("/a/b.webp")).toBe(true);
    expect(isImagePath("/a/b.ts")).toBe(false);
    expect(isImagePath("/a/png")).toBe(false);
  });
});

describe("expandPromptWithFiles", () => {
  const body = (t: string) => `look at @${t} please`;

  it("appends the fixed-English block with verbatim content; body stays untouched", () => {
    const out = expandPromptWithFiles(body("/home/u/repo/a.ts"), CWD, [
      { path: "/home/u/repo/a.ts", text: "CONTENT-A" },
    ]);
    expect(out.attached).toEqual(["/home/u/repo/a.ts"]);
    expect(out.skipped).toEqual([]);
    expect(out.text.startsWith(body("/home/u/repo/a.ts") + "\n\n[web-hub file references] ")).toBe(true);
    expect(out.text).toContain("The user referenced 1 local file(s)");
    expect(out.text).toContain("--- /home/u/repo/a.ts (9 B) ---\nCONTENT-A");
    expect(out.text).toContain("paths are readable as-is");
  });

  it("the header is DISTINCT from the upload attachment block (transcript parser never misreads)", () => {
    const out = expandPromptWithFiles(body("/home/u/repo/a.ts"), CWD, [{ path: "/home/u/repo/a.ts", text: "x" }]);
    expect(out.text).not.toContain("[web-hub attachments]");
  });

  it("multiple files: first-occurrence order, one section each, blank line between", () => {
    const out = expandPromptWithFiles(`@/home/u/repo/b.ts and @/home/u/repo/a.ts`, CWD, [
      { path: "/home/u/repo/a.ts", text: "A" },
      { path: "/home/u/repo/b.ts", text: "B" },
    ]);
    expect(out.attached).toEqual(["/home/u/repo/b.ts", "/home/u/repo/a.ts"]); // occurrence order
    const bIdx = out.text.indexOf("--- /home/u/repo/b.ts");
    const aIdx = out.text.indexOf("--- /home/u/repo/a.ts");
    expect(bIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeLessThan(aIdx);
    expect(out.text).toContain("The user referenced 2 local file(s)");
  });

  it("unfetched tokens (failed/image/binary) are skipped, never block, no hint text in prompt", () => {
    const out = expandPromptWithFiles(`@/home/u/repo/gone.ts @/home/u/repo/ok.ts`, CWD, [
      { path: "/home/u/repo/ok.ts", text: "OK" },
    ]);
    expect(out.attached).toEqual(["/home/u/repo/ok.ts"]);
    expect(out.skipped).toEqual(["/home/u/repo/gone.ts"]);
    expect(out.text).toContain("@/home/u/repo/gone.ts"); // token stays verbatim
    expect(out.text).not.toContain("not inlined");
  });

  it("no tokens ⇒ text unchanged; no fetched match ⇒ unchanged (all skipped)", () => {
    expect(expandPromptWithFiles("plain text", CWD, [{ path: "/x", text: "y" }]).text).toBe("plain text");
    const out = expandPromptWithFiles(`@/home/u/repo/gone.ts`, CWD, []);
    expect(out.text).toBe(`@/home/u/repo/gone.ts`);
    expect(out.skipped).toEqual(["/home/u/repo/gone.ts"]);
  });

  it("whole file fits ⇒ included regardless of the truncation floor", () => {
    const small = "x".repeat(50);
    const out = expandPromptWithFiles(body("/home/u/repo/a.ts"), CWD, [{ path: "/home/u/repo/a.ts", text: small }]);
    expect(out.attached).toHaveLength(1);
    expect(out.text).toContain(small);
    expect(out.text).toContain("(50 B)"); // full size label, no "of"
  });

  it("oversized file is truncated to the remaining budget and labeled X of Y", () => {
    const big = "y".repeat(100_000); // 100000 B = "98 KB" in the 1024-based label
    const out = expandPromptWithFiles(body("/home/u/repo/big.ts"), CWD, [{ path: "/home/u/repo/big.ts", text: big }]);
    expect(out.attached).toHaveLength(1);
    const m = /--- \/home\/u\/repo\/big.ts \((.+?) of 98 KB\) ---\n(y+)$/.exec(out.text);
    expect(m).not.toBeNull();
    expect(new TextEncoder().encode(m![2]!).length).toBeGreaterThan(256); // above the floor
    expect(m![2]!.length).toBeLessThan(100_000);
    // the composed total respects the shared 48 KiB prompt cap
    expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(PROMPT_MAX_UTF8_BYTES);
  });

  it("budget overflow: later files degrade to skipped (token stays), earlier ones stay whole", () => {
    // first is over the cap itself ⇒ truncated to eat the whole budget; second then has less
    // than separator+floor left and is skipped outright.
    const first = "z".repeat(PROMPT_MAX_UTF8_BYTES);
    const out = expandPromptWithFiles(`@/home/u/repo/first.ts @/home/u/repo/second.ts`, CWD, [
      { path: "/home/u/repo/first.ts", text: first },
      { path: "/home/u/repo/second.ts", text: "SECOND" },
    ]);
    expect(out.attached).toEqual(["/home/u/repo/first.ts"]);
    expect(out.skipped).toEqual(["/home/u/repo/second.ts"]);
    expect(out.text).toContain("@/home/u/repo/second.ts"); // token survived in the body
    expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(PROMPT_MAX_UTF8_BYTES);
  });

  it("a remaining budget below separator+floor ⇒ the file is skipped outright", () => {
    // A huge body leaves only ~200B: below sep(38)+floor(256) — the single file cannot be
    // inlined at all, so the prompt goes out unchanged.
    const bodyText = `${"x".repeat(PROMPT_MAX_UTF8_BYTES - 400)} @/home/u/repo/big.ts`;
    const big = "w".repeat(100_000);
    const out = expandPromptWithFiles(bodyText, CWD, [{ path: "/home/u/repo/big.ts", text: big }]);
    expect(out.attached).toEqual([]);
    expect(out.skipped).toEqual(["/home/u/repo/big.ts"]);
    expect(out.text).toBe(bodyText);
  });

  it("caps inlined files at FILE_MENTION_MAX_FILES; the rest skip", () => {
    const text = Array.from({ length: FILE_MENTION_MAX_FILES + 2 }, (_, i) => `@/home/u/repo/f${i}.ts`).join(" ");
    const fetched = Array.from({ length: FILE_MENTION_MAX_FILES + 2 }, (_, i) => ({
      path: `/home/u/repo/f${i}.ts`,
      text: `T${i}`,
    }));
    const out = expandPromptWithFiles(text, CWD, fetched);
    expect(out.attached).toHaveLength(FILE_MENTION_MAX_FILES);
    expect(out.skipped).toHaveLength(2);
  });

  it("a path containing a newline is never inlined (block-shape defense)", () => {
    const out = expandPromptWithFiles(`@/home/u/repo/a.ts`, CWD, [
      { path: "/home/u/repo/a\nts", text: "X" }, // fetched entry for a DIFFERENT (hostile) path
    ]);
    // the token's own path is /home/u/repo/a.ts (terminator \n ends it) — no fetch matches ⇒ skipped
    expect(out.attached).toEqual([]);
  });

  it("duplicate tokens inline once", () => {
    const out = expandPromptWithFiles(`@/home/u/repo/a.ts again @/home/u/repo/a.ts`, CWD, [
      { path: "/home/u/repo/a.ts", text: "A" },
    ]);
    expect(out.attached).toEqual(["/home/u/repo/a.ts"]);
    expect(out.text.match(/--- \/home\/u\/repo\/a\.ts /g)).toHaveLength(1);
  });
});
