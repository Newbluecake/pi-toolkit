import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_SOURCE_FENCE,
  injectionSentinel,
  memoryFingerprint,
  RenderCache,
  renderMemoryBlock,
  stripDriftHeader,
  truncateAtSection,
  type InjectBudget,
} from "../../src/memory/render.js";
import { memoryDirFor, toSlug, type MemoryPaths } from "../../src/memory/paths.js";
import { DRIFT_HEADER } from "../../src/memory/store.js";

const CWD = "/proj/app";
const SLUG = toSlug(CWD); // "-proj-app"

function fixture(): { paths: MemoryPaths; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "mem-render-"));
  const paths: MemoryPaths = { memoryRoot: join(root, "mem"), ccProjectsRoot: join(root, "cc") };
  return { paths, dir: memoryDirFor(CWD, paths) };
}

function writeMem(dir: string, name: string, body: string, mtimeSec?: number): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
}

function budget(over: Partial<InjectBudget> = {}): InjectBudget {
  return { inlineMax: 3, byteCap: 4000, indexMax: 15, ...over };
}

describe("renderMemoryBlock — empty handling", () => {
  it("returns undefined for a missing dir", () => {
    const { paths } = fixture();
    expect(renderMemoryBlock(CWD, budget(), paths)).toBeUndefined();
  });

  it("returns undefined for an empty dir (no token-burning '(none)' block)", () => {
    const { paths, dir } = fixture();
    mkdirSync(dir, { recursive: true });
    expect(renderMemoryBlock(CWD, budget(), paths)).toBeUndefined();
  });
});

describe("renderMemoryBlock — index", () => {
  it("truncates the index at indexMax with '… +N more'", () => {
    const { paths, dir } = fixture();
    for (let i = 0; i < 4; i++) writeMem(dir, `f${i}.md`, `body ${i}`, 1_000 + i);
    const block = renderMemoryBlock(CWD, budget({ indexMax: 2 }), paths);
    expect(block).toContain(`## Memory (${SLUG}) — 4 file(s)`);
    expect(block).toContain("- f3.md");
    expect(block).toContain("- f2.md");
    expect(block).not.toContain("- f1.md");
    expect(block).toContain("- … +2 more");
  });

  it("formats sizes as B / kB / MB (auto-scaling unit)", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "small.md", "x".repeat(100));
    writeMem(dir, "edge.md", "e".repeat(1024));
    writeMem(dir, "big.md", "y".repeat(2048));
    writeMem(dir, "huge.md", "z".repeat(2 * 1024 * 1024));
    const block = renderMemoryBlock(CWD, budget({ inlineMax: 0 }), paths);
    expect(block).toContain("small.md (100B)");
    expect(block).toContain("edge.md (1.0kB)"); // 1024 归入 kB 档
    expect(block).toContain("big.md (2.0kB)");
    expect(block).toContain("huge.md (2.0MB)");
  });
});

describe("renderMemoryBlock — inline zone & byte budget", () => {
  it("inlines at most inlineMax files (newest first)", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "old.md", "old body", 1_000);
    writeMem(dir, "new.md", "new body", 2_000);
    const block = renderMemoryBlock(CWD, budget({ inlineMax: 1 }), paths);
    expect(block).toContain("### new.md\nnew body");
    expect(block).not.toContain("### old.md");
    expect(block).toContain("(Older files are in the index only");
  });

  it("byteCap=0 renders the index only", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "a.md", "body a");
    const block = renderMemoryBlock(CWD, budget({ byteCap: 0 }), paths);
    expect(block).toContain("Index:");
    expect(block).not.toContain("Pinned & recent:");
    expect(block).not.toContain("### a.md");
    expect(block).toContain("(Older files are in the index only");
  });

  it("deducts the ACTUAL per-file overhead (### name + fence) across files (R8)", () => {
    const { paths, dir } = fixture();
    // "### a.md\n" = 9B overhead + 4B body = 13B; same for b.md → 26B total.
    writeMem(dir, "a.md", "AAAA", 2_000);
    writeMem(dir, "b.md", "BBBB", 1_000);
    const both = renderMemoryBlock(CWD, budget({ byteCap: 26 }), paths);
    expect(both).toContain("### a.md\nAAAA");
    expect(both).toContain("### b.md\nBBBB");
    // 25B: b.md's body budget shrinks to 3 → truncated body, still present
    const shrunk = renderMemoryBlock(CWD, budget({ byteCap: 25 }), paths);
    expect(shrunk).toContain("### b.md\nBBB\n…(truncated");
    // 13B: exactly file a; nothing left for b's overhead → b not inlined
    const onlyA = renderMemoryBlock(CWD, budget({ byteCap: 13 }), paths);
    expect(onlyA).toContain("### a.md\nAAAA");
    expect(onlyA).not.toContain("### b.md");
  });

  it("counts multi-byte bodies by UTF-8 bytes, not string.length", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "cn.md", "中文测试"); // 12 bytes, length 4
    // overhead "### cn.md\n" = 10B; byteCap 10+12=22 fits fully; 21 truncates
    const full = renderMemoryBlock(CWD, budget({ byteCap: 22 }), paths);
    expect(full).toContain("### cn.md\n中文测试");
    const cut = renderMemoryBlock(CWD, budget({ byteCap: 21 }), paths);
    expect(cut).toContain("…(truncated");
    expect(cut).not.toContain("\uFFFD"); // never half a character
  });
});

describe("renderMemoryBlock — pin", () => {
  it("pulls an older pinned file into the inline zone ahead of newer unpinned ones", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "pinned.md", "---\npin: true\n---\n\npinned body", 1_000); // oldest
    writeMem(dir, "n1.md", "n1 body", 3_000);
    writeMem(dir, "n2.md", "n2 body", 2_000);
    const block = renderMemoryBlock(CWD, budget({ inlineMax: 2 }), paths);
    expect(block).toContain("### pinned.md\npinned body");
    expect(block).toContain("### n1.md\nn1 body");
    expect(block).not.toContain("### n2.md\nn2 body");
  });

  it("orders pinned files among themselves by mtime desc", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "p-old.md", "---\npin: true\n---\n\nold pin", 1_000);
    writeMem(dir, "p-new.md", "---\npin: true\n---\n\nnew pin", 2_000);
    const block = renderMemoryBlock(CWD, budget({ inlineMax: 2 }), paths);
    expect(block!.indexOf("### p-new.md")).toBeLessThan(block!.indexOf("### p-old.md"));
  });

  it("marks pinned files with 📌 in the index and strips fm from the inline body", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "pinned.md", "---\npin: true\n---\n\npinned body", 1_000);
    const block = renderMemoryBlock(CWD, budget(), paths);
    expect(block).toContain("- 📌 pinned.md");
    expect(block).toContain("pinned body");
    expect(block).not.toContain("pin: true"); // frontmatter never leaks into the prompt
  });

  it("ignores 'pin: yes' and non-head frontmatter", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "yes.md", "---\npin: yes\n---\n\nyes body", 1_000);
    writeMem(dir, "nonhead.md", "intro\n---\npin: true\n---\n\nnonhead body", 1_100);
    writeMem(dir, "new.md", "new body", 3_000);
    writeMem(dir, "new2.md", "new2 body", 2_900);
    writeMem(dir, "new3.md", "new3 body", 2_800);
    const block = renderMemoryBlock(CWD, budget({ inlineMax: 3 }), paths);
    expect(block).not.toContain("- 📌 yes.md");
    expect(block).not.toContain("- 📌 nonhead.md");
    expect(block).not.toContain("### yes.md\n"); // unpinned & older than the top-3 → index only
  });
});

describe("renderMemoryBlock — agent-source fence (B1)", () => {
  it("adds the fence line for source: agent files, after ### name, before the body; fm still stripped", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "a.md", "---\nsource: agent\nupdated: 2026-01-01\n---\n\nagent body");
    const block = renderMemoryBlock(CWD, budget(), paths);
    expect(block).toContain(`### a.md\n${AGENT_SOURCE_FENCE}\nagent body`);
    expect(block).not.toContain("source: agent");
  });

  it("adds no fence for missing or non-agent source", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "plain.md", "plain body", 2_000);
    writeMem(dir, "user.md", "---\nsource: user\n---\n\nuser body", 1_000);
    const block = renderMemoryBlock(CWD, budget(), paths);
    expect(block).not.toContain(AGENT_SOURCE_FENCE);
    expect(block).toContain("### plain.md\nplain body");
    expect(block).toContain("### user.md\nuser body");
  });
});

describe("renderMemoryBlock — sentinel & drift header", () => {
  it("ends with the exact tail sentinel", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "a.md", "body");
    const block = renderMemoryBlock(CWD, budget(), paths);
    expect(block).toContain(`\n${injectionSentinel(SLUG)}\n`);
    expect(injectionSentinel(SLUG)).toBe(`<!-- pi-toolkit:memory ${SLUG} -->`);
  });

  it("strips both drift-header vintages from inlined bodies", () => {
    const oldHeader =
      "> **pi copy** — imported from Claude Code memory by `@getpipher/armory-memory` import. " +
      "CC original is canonical until you edit here; mirror changes to CC if you still use both.\n\n";
    const { paths, dir } = fixture();
    writeMem(dir, "old.md", oldHeader + "old body", 2_000);
    writeMem(dir, "new.md", DRIFT_HEADER + "new body", 1_000);
    const block = renderMemoryBlock(CWD, budget(), paths);
    expect(block).toContain("### old.md\nold body");
    expect(block).toContain("### new.md\nnew body");
    expect(block).not.toContain("pi copy");
  });

  it("stripDriftHeader is a pure regex replace (the trailing blank line survives; render trims)", () => {
    expect(stripDriftHeader(`${DRIFT_HEADER}kept`)).toBe("\nkept");
    expect(stripDriftHeader("no header")).toBe("no header");
  });
});

describe("truncateAtSection", () => {
  const MARK = "\n…(truncated — use `read` for full file)";

  it("returns the body unchanged when it fits", () => {
    expect(truncateAtSection("short", 100)).toBe("short");
  });

  it("prefers the last heading boundary at ≥25% of the budget", () => {
    const body = "intro text here\n\n# Section A\ncontent A\n\n# Section B\ncontent B";
    const out = truncateAtSection(body, 55);
    expect(out).toContain("# Section A");
    expect(out).not.toContain("# Section B");
    expect(out.endsWith(MARK)).toBe(true);
  });

  it("falls back to the last paragraph break without headings", () => {
    expect(truncateAtSection("aaa\n\nbbb\n\nccc", 11)).toBe("aaa\n\nbbb" + MARK);
  });

  it("falls back to the last line break without paragraphs", () => {
    expect(truncateAtSection("aaa\nbbb\nccc", 10)).toBe("aaa\nbbb" + MARK);
  });

  it("survives a tiny budget with no boundaries", () => {
    expect(truncateAtSection("abcdef", 2)).toBe("ab" + MARK);
  });

  it("never splits a multi-byte character", () => {
    const out = truncateAtSection("中文测试", 7); // 中(3)+文(3) fit, 测(3) doesn't
    expect(out).toBe("中文" + MARK);
    expect(out).not.toContain("\uFFFD");
  });

  it("REGRESSION (Nit 4): an over-budget file keeps multiple lines — not just the first line (original plugin's /s-flag bug)", () => {
    const body = "l1 aaaa\nl2 bbbb\nl3 cccc\nl4 dddd\nl5 eeee";
    const out = truncateAtSection(body, 25);
    expect(out).toBe("l1 aaaa\nl2 bbbb\nl3 cccc" + MARK);
    expect(out).toContain("l2 bbbb");
    expect(out).toContain("l3 cccc");
  });
});

describe("memoryFingerprint", () => {
  it("returns '' for a missing dir and for a readdir failure (Nit 10)", () => {
    const { paths, dir } = fixture();
    expect(memoryFingerprint(CWD, paths)).toBe("");
    // dir path exists as a FILE → readdirSync throws ENOTDIR
    mkdirSync(join(dir, ".."), { recursive: true });
    writeFileSync(dir, "not a dir");
    expect(memoryFingerprint(CWD, paths)).toBe("");
  });

  it("changes on add / remove / modify / touch, ignores non-md, joins with \\n", () => {
    const { paths, dir } = fixture();
    writeMem(dir, "a.md", "body", 1_000);
    const fp1 = memoryFingerprint(CWD, paths);
    expect(fp1).toBe("a.md:4:1000000");

    writeMem(dir, "notes.txt", "ignored", 9_999); // non-md → no change
    expect(memoryFingerprint(CWD, paths)).toBe(fp1);

    writeMem(dir, "b.md", "other", 2_000); // add → change, "\n" separator
    const fp2 = memoryFingerprint(CWD, paths);
    expect(fp2).not.toBe(fp1);
    expect(fp2).toBe("a.md:4:1000000\nb.md:5:2000000");

    writeMem(dir, "a.md", "longer body", 1_000); // modify (size) → change
    expect(memoryFingerprint(CWD, paths)).not.toBe(fp2);

    const fp3 = memoryFingerprint(CWD, paths);
    utimesSync(join(dir, "a.md"), 5_000, 5_000); // touch only → change
    expect(memoryFingerprint(CWD, paths)).not.toBe(fp3);

    writeMem(dir, "a.md", "x", 1_000); // shrink
    const fp4 = memoryFingerprint(CWD, paths);
    expect(fp4).toContain("a.md:1:1000000");
  });
});

describe("RenderCache (B2 discriminated get)", () => {
  const b1 = budget();
  const b2 = budget({ byteCap: 100 });

  it("distinguishes miss (undefined) from a cached empty-dir result ({block: undefined})", () => {
    const cache = new RenderCache();
    expect(cache.get("/a", b1, "fp")).toBeUndefined(); // miss
    cache.set("/a", b1, "fp", undefined); // cached empty-dir render
    expect(cache.get("/a", b1, "fp")).toEqual({ block: undefined });
    expect(cache.get("/a", b1, "other-fp")).toBeUndefined(); // fingerprint mismatch = miss
  });

  it("caches and returns blocks per (cwd, budget, fingerprint)", () => {
    const cache = new RenderCache();
    cache.set("/a", b1, "fp", "BLOCK");
    expect(cache.get("/a", b1, "fp")).toEqual({ block: "BLOCK" });
    expect(cache.get("/a", b2, "fp")).toBeUndefined(); // different budget = different key
  });

  it("delete(cwd) removes ALL budget variants via prefix scan, leaving other cwds alone", () => {
    const cache = new RenderCache();
    cache.set("/a", b1, "fp", "A1");
    cache.set("/a", b2, "fp", "A2");
    cache.set("/ab", b1, "fp", "AB"); // prefix trap: "/ab" must NOT match "/a\0…"
    cache.delete("/a");
    expect(cache.get("/a", b1, "fp")).toBeUndefined();
    expect(cache.get("/a", b2, "fp")).toBeUndefined();
    expect(cache.get("/ab", b1, "fp")).toEqual({ block: "AB" });
  });

  it("peek ignores the fingerprint and returns the last write for (cwd, budget)", () => {
    const cache = new RenderCache();
    cache.set("/a", b1, "fp1", "OLD");
    expect(cache.peek("/a", b1)).toEqual({ block: "OLD" });
    expect(cache.peek("/a", b2)).toBeUndefined();
    expect(cache.peek("/never", b1)).toBeUndefined();
  });

  it("clears and rebuilds when capacity overflows", () => {
    const cache = new RenderCache(2);
    cache.set("/a", b1, "fp", "A");
    cache.set("/b", b1, "fp", "B");
    cache.set("/c", b1, "fp", "C"); // overflow → clear → only /c remains
    expect(cache.get("/a", b1, "fp")).toBeUndefined();
    expect(cache.get("/b", b1, "fp")).toBeUndefined();
    expect(cache.get("/c", b1, "fp")).toEqual({ block: "C" });
  });
});
