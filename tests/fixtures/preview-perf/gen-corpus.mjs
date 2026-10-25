#!/usr/bin/env node
/**
 * preview-perf PB corpus generator (docs/dev/preview-perf/plan.md §6.1). Deterministic:
 * every synthetic artifact is derived from the fixed seeds below, and every pinned copy
 * (stack-3609.ts, uploads-2292.ts, hl-600.ts, hl-601.ts) is byte-copied from the named
 * source file, with its line count ASSERTED — if the source drifts the generator fails and
 * forces a deliberate re-pin (update the expected count AND the fixture name together).
 *
 * `manifest.json` records sha256 + bytes + lines for every file on disk. The runner
 * (`scripts/web-hub/preview-perf-probe.ts`) verifies it before every run and refuses on
 * mismatch — the baseline numbers are only comparable against the exact pinned bytes.
 *
 * ON-DISK SUFFIX: every corpus payload is written as `<canonical-name>.txt` (e.g.
 * `hl-600.ts.txt`). They are TEXT PAYLOADS, not source modules — `hl-600.ts`/`hl-601.ts`
 * are deliberately mid-file slices (syntactically invalid TS) and `longline.js` is keyword
 * soup, so prettier's parser must never see them as `.ts`/`.js` (the repo format gate checks
 * everything); `.txt` keeps them outside prettier's extension list without a `.prettierignore`
 * entry. The CANONICAL names (what the probe page requests and what the manifest keys) stay
 * extension-real so the preview's language detection/highlighting path is exercised as-is.
 *
 * `log-8mib` is NOT on disk: plan §6.1 pins it as "runtime-generated with a fixed seed"
 * (8 MiB would dwarf the repo fixtures). Its seed/size/chunk-plan constants live in
 * `manifest.json` under `log8mib` and BOTH sides (this generator asserts the constants are
 * in range; the probe page `src/web-hub/ui/csp-probe/preview-perf.ts` renders it from the
 * same constants) must be updated together.
 *
 * Usage: node tests/fixtures/preview-perf/gen-corpus.mjs   (regenerates everything in cwd)
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

/** Deterministic PRNG (mulberry32) — same one the probe page uses for log-8mib. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const log8mib = {
  seed: 0x0b1701,
  totalBytes: 8 * 1024 * 1024,
  firstChunkBytes: 256 * 1024,
  nextChunkBytes: 1024 * 1024,
  emojiLineEvery: 1024,
  surrogateSplitBoundary: 5,
};

function pinnedCopy(srcRel, name, expectLines) {
  const src = resolve(REPO, srcRel);
  const text = readFileSync(src, "utf8");
  // countCodeLines semantics: a source-final "\n" adds no phantom line.
  const nl = (text.match(/\n/g) ?? []).length;
  const logical = text.endsWith("\n") ? nl : nl + 1;
  if (logical !== expectLines) {
    throw new Error(
      `${name}: ${srcRel} now has ${logical} lines, expected ${expectLines} — the fixture name pins the count; ` +
        `re-pin deliberately (regenerate with an updated name + manifest) instead of silently drifting`,
    );
  }
  const dst = resolve(HERE, `${name}.txt`);
  copyFileSync(src, dst);
  return dst;
}

function headLines(srcRel, name, count) {
  const src = resolve(REPO, srcRel);
  const text = readFileSync(src, "utf8");
  // exact first `count` lines, each keeping its own newline ("\n" terminator included)
  const out = text.split("\n", count).join("\n") + "\n";
  const dst = resolve(HERE, `${name}.txt`);
  writeFileSync(dst, out, "utf8");
  return dst;
}

/** longline.js — 700 ordinary lines plus ONE 200 KB line planted at line 350 (plan §6.1). */
function genLongline() {
  const rand = mulberry32(0x1016c0de);
  const words = "const let return function export import if else await async buffer stream chunk preview window".split(
    " ",
  );
  const parts = [];
  for (let i = 1; i <= 701; i++) {
    if (i === 350) {
      parts.push(`export const bigBlob = "${"A".repeat(200 * 1024)}"; // 200 KB single logical line`);
      continue;
    }
    const n = 8 + Math.floor(rand() * 14);
    const toks = [];
    for (let j = 0; j < n; j++) toks.push(words[Math.floor(rand() * words.length)]);
    parts.push(`const v${i} = /* line ${i} */ [${toks.join(", ")}].length;`);
  }
  const dst = resolve(HERE, "longline.js.txt");
  writeFileSync(dst, parts.join("\n") + "\n", "utf8");
  return dst;
}

/** wide-1200.md — 1200 lines of width-hostile text: CJK, emoji (surrogate pairs), tabs,
 *  combining marks, İ, Σ, mixed-width runs (plan §6.1). Clean UTF-8 only (no lone
 *  surrogates) so the on-disk sha256 is stable across Node versions. */
function genWide() {
  const rand = mulberry32(0x21de_0b17);
  const cjk = "预览性能宽字符行宽估算上界虚拟滚动块渲染查找高亮窗口拖动缩放";
  const emoji = ["📊", "🚀", "🧪", "宽", "✅", "🔧"];
  const combining = ["e\u0301", "a\u0308", "o\u0302"];
  const specials = ["İ", "Σ", "ẞ", "ı"];
  const parts = [];
  parts.push("# wide-1200 — preview-perf width corpus\n");
  for (let i = 1; i <= 1200; i++) {
    const kind = Math.floor(rand() * 6);
    const cjkRun = Array.from({ length: 6 + Math.floor(rand() * 18) }, () => cjk[Math.floor(rand() * cjk.length)]).join(
      "",
    );
    const asciiRun = Array.from({ length: Math.floor(rand() * 40) }, () =>
      String.fromCharCode(97 + Math.floor(rand() * 26)),
    ).join("");
    if (kind === 0) parts.push(`${i}. CJK ${cjkRun}${asciiRun}\n`);
    else if (kind === 1) parts.push(`${i}. ${emoji[Math.floor(rand() * emoji.length)]} ${asciiRun}${cjkRun}\n`);
    else if (kind === 2) parts.push(`${i}.\ttabbed\t${asciiRun}\t${cjkRun}\n`);
    else if (kind === 3)
      parts.push(
        `${i}. combining ${combining[Math.floor(rand() * combining.length)]}${asciiRun} ${specials[Math.floor(rand() * specials.length)]}\n`,
      );
    else if (kind === 4)
      parts.push(`${"İ".repeat(1 + Math.floor(rand() * 5))}${"Σ".repeat(1 + Math.floor(rand() * 5))} ${asciiRun}\n`);
    else parts.push(`${i}: ${cjkRun} | ${asciiRun} | ${emoji[Math.floor(rand() * emoji.length)]}\n`);
  }
  const dst = resolve(HERE, "wide-1200.md.txt");
  writeFileSync(dst, parts.join(""), "utf8");
  return dst;
}

function sha256Of(path) {
  const buf = readFileSync(path);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

function logicalLines(text) {
  const nl = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? nl : nl + 1;
}

mkdirSync(HERE, { recursive: true });
const files = {};
const pinned = [
  pinnedCopy("src/stack.ts", "stack-3609.ts", 3609),
  pinnedCopy("src/web-hub/hub/uploads.ts", "uploads-2292.ts", 2292),
];
const heads = [
  headLines("src/web-hub/hub/uploads.ts", "hl-600.ts", 600),
  headLines("src/web-hub/hub/uploads.ts", "hl-601.ts", 601),
];
const synth = [genLongline(), genWide()];
for (const p of [...pinned, ...heads, ...synth]) {
  const { sha256, bytes } = sha256Of(p);
  const text = readFileSync(p, "utf8");
  // canonical name = on-disk name minus the .txt suffix
  const name = p.slice(HERE.length + 1).replace(/\.txt$/, "");
  files[name] = { sha256, bytes, lines: logicalLines(text) };
}
const manifest = { version: 1, generator: "tests/fixtures/preview-perf/gen-corpus.mjs", files, log8mib };
writeFileSync(resolve(HERE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`manifest.json: ${Object.keys(files).length} files pinned, log-8mib seed 0x${log8mib.seed.toString(16)}`);
