// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";
import { parseMarkdown as parseMarkdownRef } from "./fixtures/markdown-ref.js";

/**
 * dir-plan v3.1 §4.2 (PM package) — the inline parser's failed-close searches are memoized
 * (amortized linear). Two hard gates live here:
 *
 * 1. **Output equivalence**: the live `parseMarkdown` deep-equals the FROZEN pre-change copy
 *    (`./fixtures/markdown-ref.js`) on a fixed-seed random corpus (2 000 fragments) and on
 *    every pathological shape at a small size (the ref is still O(n²) on those — diffing at
 *    the full 256 KiB would take minutes by design; 8 KiB already pins the shape).
 * 2. **Performance**: each pathological 256 KiB input parses within 200 ms (median of 3
 *    samples) and grows at most 8× from 64 KiB to 256 KiB (linear ≈ 4×, quadratic ≈ 16×).
 *    Each sample times a batch of iterations (scaled so one sample ≈ tens of ms) to keep the
 *    ratio measurement out of timer noise.
 */

/** mulberry32 — deterministic PRNG (same discipline as logic-preview.test.ts). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One timed sample = `iters` consecutive parses; returns the per-parse median of 3 samples. */
function medianPerParse(fn: () => void, iters: number): number {
  const samples: number[] = [];
  for (let s = 0; s < 3; s++) {
    const t0 = performance.now();
    for (let k = 0; k < iters; k++) fn();
    samples.push((performance.now() - t0) / iters);
  }
  samples.sort((x, y) => x - y);
  return samples[1]!;
}

/**
 * The growth criterion's estimator: the two sizes are measured in INTERLEAVED rounds with the
 * per-size MINIMUM as the answer. Rationale (measured, not theorized): the vitest worker's
 * heap phase drifts the SAME 256 KiB parse between ~27 ms (fresh worker) and ~44 ms (late in
 * the suite) while the 64 KiB one wobbles the other way, so two sequential median blocks can
 * cross the 8× line for a perfectly linear parser. Interleaving makes any monotone phase
 * shift hit both sizes in the same round, and the minimum never picks up a stray GC pause —
 * the pair is stable run-to-run (observed ratios: 4.9–6.1 across the corpus).
 */
function interleavedMinPair(
  small: () => void,
  big: () => void,
  itersSmall: number,
  itersBig: number,
): { t64: number; t256: number } {
  const smalls: number[] = [];
  const bigs: number[] = [];
  for (let round = 0; round < 4; round++) {
    let t0 = performance.now();
    for (let k = 0; k < itersSmall; k++) small();
    smalls.push((performance.now() - t0) / itersSmall);
    t0 = performance.now();
    for (let k = 0; k < itersBig; k++) big();
    bigs.push((performance.now() - t0) / itersBig);
  }
  return { t64: Math.min(...smalls), t256: Math.min(...bigs) };
}

const KIB = 1024;

/** §4.2's pathological corpus: display name → builder at a target char size. */
const PATHOLOGICAL: Array<[string, (chars: number) => string]> = [
  ['"*a ".repeat', (n) => "*a ".repeat(Math.floor(n / 3))],
  ['"_a ".repeat', (n) => "_a ".repeat(Math.floor(n / 3))],
  ['"~~a ".repeat', (n) => "~~a ".repeat(Math.floor(n / 4))],
  ['"`a ".repeat', (n) => "`a ".repeat(Math.floor(n / 3))],
  ['"**a ".repeat', (n) => "**a ".repeat(Math.floor(n / 4))],
  ['"[a](".repeat', (n) => "[a](".repeat(Math.floor(n / 4))],
  ['"[a]([a](".repeat', (n) => "[a]([a](".repeat(Math.floor(n / 8))],
  ['"> ".repeat + x', (n) => "> ".repeat(Math.floor((n - 1) / 2)) + "x"],
  ['"| a |\\n".repeat', (n) => "| a |\n".repeat(Math.floor(n / 6))],
  ['"- [ ] x\\n".repeat', (n) => "- [ ] x\n".repeat(Math.floor(n / 8))],
];

describe("logic/markdown.js — §4.2 differential (live ≡ frozen reference)", () => {
  it("fixed-seed random markdown corpus (2000 fragments) deep-equals the pre-change parser", () => {
    const pieces = [
      "*",
      "**",
      "***",
      "_",
      "__",
      "~~",
      "`",
      "``",
      "```",
      "`code`",
      "~~del~~",
      "**bold**",
      "*em*",
      "_it_",
      "[a]",
      "[a](https://e.d/q)",
      "[a](javascript:x)",
      "[a](",
      "(",
      ")",
      "[",
      "]",
      "# ",
      "## ",
      "> ",
      "- ",
      "- [ ] ",
      "- [x] ",
      "1. ",
      "| a |",
      "|---|---|",
      "\\*",
      "\\\\",
      "a",
      "b ",
      "word",
      "word\n",
      "\n",
      "\n\n",
      " ",
      "  indent\n",
      "!",
      ":",
      ".",
      ",",
      '"',
      "'",
      "é",
      "😀",
      "<script>",
      "<b>html</b>",
      "```\nfenced\n```",
      "~~~\ntilde\n~~~",
    ];
    const rand = rng(0x4d4421); // "MD!" — fixed seed, never change without re-blessing both sides
    for (let c = 0; c < 2000; c++) {
      const len = Math.floor(rand() * 40);
      let s = "";
      for (let k = 0; k < len; k++) s += pieces[Math.floor(rand() * pieces.length)];
      const actual = parseMarkdown(s);
      const expected = parseMarkdownRef(s);
      expect(actual, `case #${c} input=${JSON.stringify(s)}`).toEqual(expected);
    }
  });

  it("every pathological shape deep-equals the reference at 8 KiB", () => {
    for (const [name, build] of PATHOLOGICAL) {
      const s = build(8 * KIB);
      expect(parseMarkdown(s), name).toEqual(parseMarkdownRef(s));
    }
  });

  it("the reference really is the OLD implementation (self-check: memo-free quadratic timing at 16 KiB)", () => {
    // The whole gate rests on the fixture staying the frozen pre-change copy. On "*a ".repeat
    // the ref is O(n²): at 16 KiB it must already be ~100× slower than the live one — if
    // someone "optimizes" the fixture too, this fails fast and the differential goes hollow.
    const s = "*a ".repeat(Math.floor((16 * KIB) / 3));
    const live = medianPerParse(() => parseMarkdown(s), 8);
    const ref = medianPerParse(() => parseMarkdownRef(s), 1);
    expect(ref).toBeGreaterThan(live * 10);
  });
});

describe("logic/markdown.js — §4.2 linearization benchmarks (256 KiB corpus)", () => {
  it.each(PATHOLOGICAL)("%s: ≤200 ms @256 KiB and growth ratio ≤8 (64→256 KiB)", (_name, build) => {
    const s64 = build(64 * KIB);
    const s256 = build(256 * KIB);
    parseMarkdown(s64); // warm-up: get both inputs past first-parse JIT/GC tiers
    parseMarkdown(s256);
    // Absolute bound — the plan's median-of-3 estimator, batched so one sample is real work.
    const median256 = medianPerParse(() => parseMarkdown(s256), 4);
    // Growth bound — interleaved min pair (see interleavedMinPair for why not two medians).
    const { t64, t256 } = interleavedMinPair(
      () => parseMarkdown(s64),
      () => parseMarkdown(s256),
      12,
      4,
    );
    expect(median256, `256 KiB median ${median256.toFixed(2)} ms`).toBeLessThanOrEqual(200);
    expect(t256 / t64, `ratio ${t256.toFixed(2)}/${t64.toFixed(2)}`).toBeLessThanOrEqual(8);
  });
});
