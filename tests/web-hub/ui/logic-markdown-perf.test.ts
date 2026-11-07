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
 *    samples) and fits a growth exponent ≤1.5 over 64/128/256/512 KiB (CPU-time minima per size;
 *    linear ≈ 1, quadratic ≈ 2). No wall-clock ratio of two sizes is asserted.
 */

/**
 * The live parser now emits `pathlink`/`textlink` where the frozen ref emitted the literal source
 * as a text node (relative / non-http link targets). Each new node carries `raw` = that exact
 * source slice, so mapping it back to `{type:"text", text: raw}` must reproduce the ref byte for
 * byte — everything else stays strictly equal.
 */
function legacyShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(legacyShape);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ((o.type === "pathlink" || o.type === "textlink") && typeof o.raw === "string")
      return { type: "text", text: o.raw };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, legacyShape(x)]));
  }
  return v;
}

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

const cpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/**
 * Growth criterion: fit the power-law exponent k in t ≈ c·n^k by least squares on
 * (ln n, ln t) over several input sizes. Linear ⇒ k≈1, quadratic ⇒ k≈2; a fit over 4 sizes
 * is far less sensitive to a single noisy size than one ratio of two timings. Each size's
 * time is the MINIMUM per-parse process CPU time over interleaved rounds (preemption on a
 * shared runner and stray GC pauses only ever add time, never remove it).
 */
function fitExponent(sizes: number[], fns: Array<() => void>, iters: number[], rounds = 6): number {
  const best = sizes.map(() => Infinity);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < fns.length; i++) {
      const t0 = cpuMs();
      for (let k = 0; k < iters[i]!; k++) fns[i]!();
      best[i] = Math.min(best[i]!, (cpuMs() - t0) / iters[i]!);
    }
  }
  const xs = sizes.map((n) => Math.log(n));
  const ys = best.map((t) => Math.log(Math.max(t, 1e-3)));
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
  const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return num / den;
}

const MAX_EXPONENT = 1.5;

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
      expect(legacyShape(actual), `case #${c} input=${JSON.stringify(s)}`).toEqual(expected);
    }
  });

  it("every pathological shape deep-equals the reference at 8 KiB", () => {
    for (const [name, build] of PATHOLOGICAL) {
      const s = build(8 * KIB);
      expect(legacyShape(parseMarkdown(s)), name).toEqual(parseMarkdownRef(s));
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

describe("logic/markdown.js — §4.2 linearization benchmarks (up to 512 KiB corpus)", () => {
  it('the exponent estimator separates linear from quadratic (frozen O(n²) ref on "*a ".repeat, 2–16 KiB)', () => {
    const sizes = [2, 4, 8, 16];
    const inputs = sizes.map((k) => "*a ".repeat(Math.floor((k * KIB) / 3)));
    for (const x of inputs) parseMarkdownRef(x);
    const k = fitExponent(
      sizes,
      inputs.map((x) => () => parseMarkdownRef(x)),
      [4, 2, 1, 1],
      3,
    );
    if (process.env.PERF_DBG) console.log("ref exponent", k);
    expect(k, `ref exponent ${k.toFixed(2)}`).toBeGreaterThan(MAX_EXPONENT);
  }, 60_000);

  it.each(PATHOLOGICAL)(
    "%s: ≤200 ms @256 KiB and growth exponent ≤1.5 (64→512 KiB)",
    (_name, build) => {
      const sizes = [64, 128, 256, 512];
      const inputs = sizes.map((k) => build(k * KIB));
      for (const x of inputs) parseMarkdown(x); // warm-up past first-parse JIT/GC tiers
      const fns = inputs.map((x) => () => parseMarkdown(x));
      const s256 = inputs[2]!;
      // Absolute bound — loose sentinel (median of 3 batched samples), not the growth gate.
      const median256 = medianPerParse(() => parseMarkdown(s256), 4);
      // Up to 3 independent windows; a truly super-linear parser exceeds 1.5 in every one.
      let k = Infinity;
      for (let attempt = 0; attempt < 3 && k > MAX_EXPONENT; attempt++) {
        k = Math.min(k, fitExponent(sizes, fns, [16, 8, 4, 2]));
      }
      expect(median256, `256 KiB median ${median256.toFixed(2)} ms`).toBeLessThanOrEqual(200);
      expect(k, `growth exponent ${k.toFixed(2)}`).toBeLessThanOrEqual(MAX_EXPONENT);
    },
    90_000,
  );
});
