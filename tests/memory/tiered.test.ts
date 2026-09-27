// todo #22 optimize-plan §2/§10 G group (package P1): `src/memory/tiered.ts`'s
// `renderTiered` / `minimalFrame` / `accessFromTools` / `sizeTier` /
// `MetaCache`. Golden fixtures live in `tests/fixtures/memory/tiered-golden/`
// (one `.txt` per case id, `${MEMROOT}` placeholder standing in for the
// per-run mkdtemp() root — §10.1 point 5) and, like the legacy golden, are
// generated ONCE (`UPDATE_MEMORY_GOLDEN=1`) and never regenerated silently.
//
// `renderTiered`/`minimalFrame` take NO `paths` override (frozen
// `TieredRenderInput` shape, §14.1) — every fixture here points at its
// temp root via `vi.stubEnv("ARMORY_MEMORY_ROOT", ...)` instead of an
// explicit `paths` argument.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeFileSync as writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSULT_READONLY_TOOLS } from "../../src/runtime/tool-scope.js";
import {
  accessFromTools,
  joinNamesTruncated,
  MetaCache,
  minimalFrame,
  renderTiered,
  sizeTier,
  truncateBytes,
  type TieredRenderContext,
} from "../../src/memory/tiered.js";
import type { MemoryAccess, TieredRenderInput } from "../../src/memory/contracts.js";
import { defaultPaths, toSlug } from "../../src/memory/paths.js";
import { materializeFixture, materializeEmptyFixture, writeMemAt, FIXTURES_ROOT } from "./helpers/fixture-dir.js";
import * as safeFs from "../../src/memory/safe-fs.js";

const GOLDEN_DIR = join(FIXTURES_ROOT, "tiered-golden");
const UPDATE = process.env.UPDATE_MEMORY_GOLDEN === "1";
const pending = new Map<string, string>();

function goldenPath(id: string): string {
  return join(GOLDEN_DIR, `${id}.txt`);
}

/** Compares (or records) `actual` against `tests/fixtures/memory/tiered-golden/<id>.txt`,
 *  after substituting the per-run mkdtemp() root for the stable `${MEMROOT}`
 *  placeholder (\u00a710.1 point 5). Never overwrites an existing golden file. */
function goldenCheck(id: string, actualText: string, root: string): void {
  const normalized = actualText.split(root).join("${MEMROOT}");
  if (UPDATE) {
    pending.set(id, normalized);
    return;
  }
  let expected: string;
  try {
    expected = readFileSync(goldenPath(id), "utf8");
  } catch {
    throw new Error(
      `missing tiered golden fixture ${goldenPath(id)} — run with UPDATE_MEMORY_GOLDEN=1 once to generate`,
    );
  }
  expect(normalized).toBe(expected);
}

afterAll(() => {
  if (!UPDATE) return;
  mkdirSync(GOLDEN_DIR, { recursive: true });
  for (const [id, text] of pending) {
    const path = goldenPath(id);
    let existing: string | undefined;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing !== undefined) {
      throw new Error(
        `refusing to overwrite existing tiered golden ${path} (goldens are generated once, never re-generated)`,
      );
    }
    writeFileSync(path, text);
  }
});

// ────────────────────────────── env safety net ──────────────────────────────

let envTmp: string;
beforeEach(() => {
  envTmp = mkdtempSync(join(tmpdir(), "memfx-tiered-env-"));
  vi.stubEnv("HOME", join(envTmp, "nohome"));
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(envTmp, "root"));
  expect(defaultPaths().memoryRoot.startsWith(tmpdir())).toBe(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(envTmp, { recursive: true, force: true });
});

const DEFAULT_INPUT_BASE = { coreBytes: 1600, blockBytes: 2400, indexMax: 15 } as const;

function inputFor(cwd: string, over: Partial<TieredRenderInput> = {}): TieredRenderInput {
  return { cwd, profile: "full", access: "memory+read", ...DEFAULT_INPUT_BASE, ...over };
}

// ═══════════════════════════ G1 — current-5 ════════════════════════════

describe("G1 — current-5 (real-world fixture)", () => {
  it("bytes exactly match the golden (root-substituted), level 2, all 5 files present, no truncated marker", () => {
    const fx = materializeFixture("current-5");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const input = inputFor(fx.cwd);
    const result = renderTiered(input);
    // Exact-byte assertion (verification fallout #2): a hardcoded literal
    // count (e.g. "2122") would silently depend on THIS machine's tmpdir()
    // path length — fx.paths.memoryRoot is `<mkdtemp root>/root`, and the
    // rendered block spells that real path out in full (the guide line's
    // `read ${MEMROOT}/<slug>/<name>` hint), so its byte length shifts with
    // every environment's temp-dir prefix. The golden fixture already
    // substitutes the real root for the stable ${MEMROOT} placeholder
    // (§10.1 point 5) — reversing that substitution on the golden's saved
    // bytes reproduces the exact count THIS run must have produced, without
    // hardcoding a machine-specific number. (The previous report's "2123"
    // vs. an independent "2122" recompute was exactly this: a literal typed
    // on one machine, one byte off from another machine's real root length.)
    const goldenRaw = readFileSync(goldenPath("g1_current5"), "utf8");
    const expectedText = goldenRaw.split("${MEMROOT}").join(fx.paths.memoryRoot);
    expect(result.bytes).toBe(Buffer.byteLength(expectedText, "utf8"));
    expect(result.bytes).toBeLessThanOrEqual(2400);
    expect(result.bytes).toBe(Buffer.byteLength(result.text, "utf8"));
    expect(result.level).toBe(2);
    for (const name of fx.names) expect(result.text).toContain(name);
    expect(result.text).not.toContain("truncated");
    expect(result.text).toContain('memory view pitfalls.md section="');
    goldenCheck("g1_current5", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });
});

// ═══════════════════════════ G2 — synthetic goldens ════════════════════

function renderSynthetic(name: string, over: Partial<TieredRenderInput> = {}) {
  const fx = materializeFixture(`synthetic/${name}`);
  vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
  const input = inputFor(fx.cwd, over);
  const result = renderTiered(input);
  return { fx, input, result };
}

describe("G2 — synthetic tiered golden cases", () => {
  it("long-slug: soft L5 (bytes(minimalFrame) > B, bytes(I) \u2264 B)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "memfx-longslug-"));
    const cwd = `/${"x".repeat(79)}`; // toSlug byte length 80
    const slug = toSlug(cwd);
    const root = join(tmp, "root");
    const memDir = join(root, slug);
    mkdirSync(memDir, { recursive: true });
    const srcDir = join(FIXTURES_ROOT, "synthetic/long-slug");
    writeFileSync(join(memDir, "topic.md"), readFileSync(join(srcDir, "topic.md")));
    utimesSync(join(memDir, "topic.md"), 1, 1);
    vi.stubEnv("ARMORY_MEMORY_ROOT", root);
    const input = inputFor(cwd, { blockBytes: 300 });
    const result = renderTiered(input);
    const H = `## Memory (${slug}) — 1 file(s)`;
    expect(result.level).toBe(5);
    expect(result.tailKind).toBe("frame-only");
    expect(result.bytes).toBeLessThanOrEqual(300);
    expect(result.text.startsWith(H)).toBe(true);
    expect(result.text).not.toBe(`${H}\n\n<!-- pi-toolkit:memory ${slug} -->\n`); // not the bare unreducible form
    goldenCheck("g2_long_slug", result.text, root);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("huge-slug: hard L5 (bytes(I) > B, output === I, exceeds B)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "memfx-hugeslug-"));
    const cwd = `/${"x".repeat(99)}`; // toSlug byte length 100 (ext4-safe, <=255B component)
    const slug = toSlug(cwd);
    const root = join(tmp, "root");
    const memDir = join(root, slug);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "topic.md"), "# t\n\nbody\n");
    utimesSync(join(memDir, "topic.md"), 1, 1);
    vi.stubEnv("ARMORY_MEMORY_ROOT", root);
    const input = inputFor(cwd, { blockBytes: 200 });
    const result = renderTiered(input);
    const H = `## Memory (${slug}) — 1 file(s)`;
    const S = `<!-- pi-toolkit:memory ${slug} -->\n`;
    const I = `${H}\n\n${S}`;
    expect(result.level).toBe(5);
    expect(result.tailKind).toBe("frame-only");
    expect(result.text).toBe(I);
    expect(result.bytes).toBeGreaterThan(200);
    goldenCheck("g2_huge_slug", result.text, root);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("many-files: L0 at default budget, all 12 topics as full lines", () => {
    const { fx, result } = renderSynthetic("many-files");
    expect(result.level).toBe(0);
    expect(result.tailKind).toBe("none");
    expect(result.fullIndexLines).toBe(12);
    goldenCheck("g2_many_files_l0", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("many-files: L1 compact tail at a smaller budget", () => {
    const { fx, result } = renderSynthetic("many-files", { blockBytes: 430 });
    expect(result.level).toBe(1);
    expect(result.tailKind).toBe("compact");
    expect(result.text).toContain("- also:");
    expect(result.bytes).toBeLessThanOrEqual(430);
    goldenCheck("g2_many_files_compact", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("many-files: L1 degrades further to a bare overflow line at an even smaller budget", () => {
    const { fx, result } = renderSynthetic("many-files", { blockBytes: 500 });
    expect(result.level).toBe(1);
    expect(result.tailKind).toBe("overflow");
    expect(result.text).toMatch(/- … \+\d+ more/);
    expect(result.bytes).toBeLessThanOrEqual(500);
    goldenCheck("g2_many_files_overflow", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("long-desc: description/read_when clipped at their own byte caps, codepoint-safe", () => {
    const { fx, result } = renderSynthetic("long-desc");
    expect(result.level).toBe(0);
    expect(result.text).toContain("…");
    for (const line of result.text.split("\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(200);
    goldenCheck("g2_long_desc", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("cjk-emoji: codepoint-safe clipping never splits a surrogate pair / multi-byte char", () => {
    const { fx, result } = renderSynthetic("cjk-emoji");
    expect(result.text).not.toContain("\uFFFD"); // no replacement char from a mangled surrogate
    for (const ch of result.text) expect(ch.length).toBeLessThanOrEqual(2); // never a lone surrogate half
    expect(Buffer.byteLength(result.text, "utf8")).toBe(result.bytes);
    goldenCheck("g2_cjk_emoji", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("no-core: no primary at all \u2014 no `### ` core section in the output", () => {
    const { fx, result } = renderSynthetic("no-core");
    expect(result.level).toBe(0);
    expect(result.text).not.toContain("### ");
    goldenCheck("g2_no_core", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("core-over: whole-section admission (L2) at a normal budget", () => {
    const { fx, result } = renderSynthetic("core-over");
    expect(result.level).toBe(2);
    expect(result.omittedSections.length).toBeGreaterThan(0);
    expect(result.text).toContain('memory view core.md section="Section B"');
    goldenCheck("g2_core_over_l2", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("core-over: demoted entirely at a smaller budget (L4, \u26a0 sorted first)", () => {
    const { fx, result } = renderSynthetic("core-over", { blockBytes: 500 });
    expect(result.level).toBe(4);
    expect(result.text).not.toContain("### core.md");
    expect(result.text).toContain("core.md — core-over");
    expect(result.text).toContain("\u26a0 over core budget");
    const idxLine = result.text.split("\n").find((l) => l.startsWith("- core.md"));
    expect(idxLine).toBeDefined();
    goldenCheck("g2_core_over_l4", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("extra-pinned: whole-file inline at a normal budget (L0)", () => {
    const { fx, result } = renderSynthetic("extra-pinned");
    expect(result.level).toBe(0);
    expect(result.text).toContain("### pinned-a.md");
    expect(result.text).toContain("### pinned-b.md");
    expect(result.demotedPinned).toEqual([]);
    goldenCheck("g2_extra_pinned_l0", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("extra-pinned: demoted to the index with \ud83d\udccc at a smaller budget (L3/L4)", () => {
    const { fx, result } = renderSynthetic("extra-pinned", { blockBytes: 500 });
    expect(result.demotedPinned).toEqual(["pinned-a.md", "pinned-b.md"]);
    expect(result.text).toContain("pinned-a.md \ud83d\udccc");
    expect(result.text).toContain("pinned-b.md \ud83d\udccc");
    goldenCheck("g2_extra_pinned_demoted", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it('archived-only: zero listable items but archived > 0 \u21d2 bare "(+M archived)" tail', () => {
    const { fx, result } = renderSynthetic("archived-only");
    expect(result.tailKind).toBe("archived-only");
    expect(result.text).toContain("(+2 archived)");
    expect(result.fullIndexLines).toBe(0);
    goldenCheck("g2_archived_only", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });

  it("code-fence-heading: a `## ` line inside a fenced block is not a section boundary", () => {
    const { fx, result } = renderSynthetic("code-fence-heading");
    expect(result.level).toBe(0);
    expect(result.text).toContain("## This looks like a heading but is inside a code fence");
    expect(result.text).toContain("## Real Section");
    expect(result.text).toContain("## Another Section");
    expect(result.omittedSections).toEqual([]);
    goldenCheck("g2_code_fence_heading", result.text, fx.paths.memoryRoot);
    fx.cleanup();
  });
});

// ═══════════════════════════ G3 — property invariants (seeded) ═════════════

// Deterministic PRNG (mulberry32) \u2014 the same seed always produces the same
// sequence, so a failing case's printed seed reproduces exactly.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const ASCII_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_,.";
const CJK_EMOJI_POOL = Array.from(
  "\u4e2d\u6587\u6d4b\u8bd5\u63cf\u8ff0\u5b57\u8282\ud83d\udccc\ud83d\ude80\u2705\ud83d\udd25\ud83c\udfaf",
); // split by codepoint, never a lone surrogate half
const ASCII_POOL = Array.from(ASCII_CHARS);

function randText(rng: () => number, approxBytes: number, mixCjk: boolean): string {
  let out = "";
  let bytes = 0;
  const pool = mixCjk ? [...ASCII_POOL, ...CJK_EMOJI_POOL] : ASCII_POOL;
  while (bytes < approxBytes) {
    const piece = pool[randInt(rng, 0, pool.length - 1)]!;
    out += piece;
    bytes += Buffer.byteLength(piece, "utf8");
  }
  return out;
}

interface GenFile {
  name: string;
  frontmatter: Record<string, string>;
  body: string;
}

function genFixture(rng: () => number): {
  cwd: string;
  files: GenFile[];
  access: MemoryAccess;
  blockBytes: number;
  coreBytes: number;
} {
  const fileCount = randInt(rng, 0, 60);
  // ext4 caps a single path component at 255 bytes (toSlug flattens the
  // whole cwd into ONE directory-name component) \u2014 when there are files to
  // actually discover, keep the slug real-fs-safe; when there are zero
  // files, the directory need not exist at all, so the full 1\u20131200B range
  // from the plan is honored there instead.
  const slugBytes = fileCount === 0 ? randInt(rng, 1, 1200) : randInt(rng, 1, 200);
  const cwd = `/${randText(rng, Math.max(1, slugBytes - 1), false).replace(/\//g, "_")}`;
  const files: GenFile[] = [];
  const hasCoreMd = fileCount > 0 && rng() < 0.3;
  for (let i = 0; i < fileCount; i++) {
    const name = i === 0 && hasCoreMd ? "core.md" : `f${i}.md`;
    const frontmatter: Record<string, string> = { source: "agent" };
    if (rng() < 0.25) frontmatter.pin = "true";
    const statusRoll = rng();
    if (statusRoll < 0.12) frontmatter.status = "archived";
    else if (statusRoll < 0.24) frontmatter.status = "stale";
    if (rng() < 0.6) frontmatter.description = randText(rng, randInt(rng, 0, 400), rng() < 0.3);
    if (rng() < 0.3) frontmatter.read_when = randText(rng, randInt(rng, 0, 200), false);
    const sectionCount = randInt(rng, 0, 4);
    let body = `# ${name}\n\n`;
    for (let s = 0; s < sectionCount; s++) {
      // Unique heading per (file, section) — avoids a heading-name collision
      // across different files' independently-generated sections, which
      // would otherwise make the I-M3 substring check below ambiguous.
      body += `## ${name} Section ${s}\n\n${randText(rng, randInt(rng, 0, 600), rng() < 0.3)}\n\n`;
      if (rng() < 0.2) body += "```\n## fake heading inside a fence\n```\n\n";
    }
    files.push({ name, frontmatter, body });
  }
  const accesses: MemoryAccess[] = ["memory+read", "memory", "read", "none"];
  const access = accesses[randInt(rng, 0, 3)]!;
  const blockBytes = randInt(rng, 800, 16384);
  const coreBytes = randInt(rng, 0, blockBytes);
  return { cwd, files, access, blockBytes, coreBytes };
}

function materializeGenerated(root: string, cwd: string, files: GenFile[]): void {
  if (files.length === 0) return; // zero files — no directory needs to exist at all (huge slugs stay ext4-safe by never being mkdir'd)
  const dir = join(root, toSlug(cwd));
  mkdirSync(dir, { recursive: true });
  files.forEach((f, i) => {
    const fmLines = Object.entries(f.frontmatter).map(([k, v]) => `${k}: ${v}`);
    const content = `---\n${fmLines.join("\n")}\n---\n\n${f.body}`;
    writeFileSync(join(dir, f.name), content);
    const t = Date.now() / 1000 + i; // arbitrary but distinct
    utimesSync(join(dir, f.name), t, t);
  });
}

describe("G3 — property invariants (seeded, 300 cases)", () => {
  it("I-M1a\u2013I-M1d, I-M2\u2013I-M4 hold for 300 seeded random fixtures", () => {
    const SEED = 1337;
    const rng = mulberry32(SEED);
    const N_CASES = 300;
    for (let i = 0; i < N_CASES; i++) {
      const gen = genFixture(rng);
      const tmp = mkdtempSync(join(tmpdir(), "memfx-prop-"));
      const root = join(tmp, "root");
      mkdirSync(root, { recursive: true });
      try {
        materializeGenerated(root, gen.cwd, gen.files);
        vi.stubEnv("ARMORY_MEMORY_ROOT", root);
        const input: TieredRenderInput = {
          cwd: gen.cwd,
          profile: "full",
          access: gen.access,
          coreBytes: gen.coreBytes,
          blockBytes: gen.blockBytes,
          indexMax: 15,
        };
        const result = renderTiered(input);
        const failMsg = `seed=${SEED} case=${i} cwd=${JSON.stringify(gen.cwd)} B=${gen.blockBytes} C=${gen.coreBytes} access=${gen.access} files=${gen.files.length}`;

        // I-M1a
        expect(result.bytes, failMsg).toBe(Buffer.byteLength(result.text, "utf8"));
        // I-M1b
        if (result.level <= 4) expect(result.bytes, failMsg).toBeLessThanOrEqual(gen.blockBytes);
        // I-M1c (independent recompute)
        const mfBytes = Buffer.byteLength(minimalFrame(input), "utf8");
        expect(result.level === 5, failMsg).toBe(mfBytes > gen.blockBytes);
        // I-M1d
        if (result.level === 5) {
          expect(result.bytes, failMsg).toBeLessThanOrEqual(
            Math.max(gen.blockBytes, unreducibleBytes(gen.cwd, gen.files)),
          );
          if (result.bytes > gen.blockBytes) expect(result.text, failMsg).toBe(unreducibleText(gen.cwd, gen.files));
        }
        // I-M3: every "## " section appearing in the block matches a source
        // file's section byte-for-byte (checked up to trailing whitespace,
        // which this renderer trims at content edges).
        for (const f of gen.files) {
          const sections = extractH2Sections(f.body);
          for (const sec of sections) {
            if (result.text.includes(`\n${sec.heading}\n`) || result.text.startsWith(sec.heading)) {
              // If a section heading line literally appears, its immediate
              // body (up to the next boundary) must appear verbatim too.
              expect(result.text.includes(sec.text.trimEnd()), `${failMsg} section=${sec.heading}`).toBe(true);
            }
          }
        }
        expect(result.text, failMsg).not.toContain("truncated");
        // I-M4: file-count conservation (N shown in header matches total addressable count).
        const validNames = gen.files.filter((f) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(f.name));
        if (validNames.length === 0) {
          expect(result.text, failMsg).toBe(""); // §2.2: empty/missing dir ⇒ ""
        } else {
          const headerMatch = /— (\d+) file\(s\)/.exec(result.text);
          expect(headerMatch, failMsg).not.toBeNull();
          expect(Number(headerMatch![1]), failMsg).toBe(validNames.length);

          // I-M4b (verification fallout #2): full conservation, not just a
          // header count — every file must appear in EXACTLY ONE of body /
          // full index / tail "also:" (never lost, never duplicated), OR be
          // one of the two aggregate-only escapes (archived, folded only
          // into the archived count; or an "overflow"/"frame-only" leftover,
          // folded only into a "+N more"/"N files" count). random file
          // bodies are drawn from an alphabet with NO "#" character
          // (ASCII_CHARS above), so a literal "\n### name\n" / "\n- name"
          // anchor can only ever come from the renderer's own structural
          // template text, never from generated body/description noise.
          const bodyNames = [...result.text.matchAll(/^### ([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md)$/gm)].map(
            (m) => m[1]!,
          );
          const indexNames = [...result.text.matchAll(/^- ([A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md)\b/gm)].map(
            (m) => m[1]!,
          );
          const alsoMatch = /^- also: (.+)$/m.exec(result.text);
          const alsoNames = alsoMatch
            ? alsoMatch[1]!
                .replace(/ \([^)]*\)$/, "")
                .split(", ")
                .filter(Boolean)
            : [];
          const bucketed = [...bodyNames, ...indexNames, ...alsoNames];

          const archivedNames = new Set(
            validNames.filter((f) => f.frontmatter.status === "archived").map((f) => f.name),
          );
          const nonArchivedNames = validNames.map((f) => f.name).filter((n) => !archivedNames.has(n));

          // Every bucketed name is a real, non-archived file of THIS case
          // (guards against a phantom match from generated noise).
          for (const n of bucketed) {
            expect(nonArchivedNames.includes(n), `${failMsg} phantom-bucketed=${n}`).toBe(true);
          }
          // No file is bucketed in more than one place.
          const counts = new Map<string, number>();
          for (const n of bucketed) counts.set(n, (counts.get(n) ?? 0) + 1);
          for (const [n, c] of counts) expect(c, `${failMsg} duplicated=${n}`).toBe(1);
          // Archived files are never individually named anywhere.
          for (const n of archivedNames) {
            expect(bucketed.includes(n), `${failMsg} archived-named=${n}`).toBe(false);
          }
          // Full count conservation: bucketed names PLUS whatever a tail's
          // own "+N more" figure says is hidden behind the count (present in
          // BOTH the "compact" also-line's suffix and the bare "overflow"
          // line — same `{n} more` template fragment, tiered.ts's
          // `tailSuffix`/`TIERED_TEMPLATES.overflow`) must equal the total
          // non-archived count. A "compact" tail is NOT the same as "every
          // remaining file individually named" — it greedily names as many
          // as fit and folds the rest into that same "+N more" figure, so
          // the two tail kinds share one formula here. Level 5 (frame-only)
          // uses a differently-worded "+{n} files" summary with nothing
          // individually named at all — excluded, same as the other L5
          // special-cases above.
          if (result.level < 5) {
            const moreMatch = /\+(\d+) more/.exec(result.text);
            const notNamedCount = moreMatch ? Number(moreMatch[1]) : 0;
            expect(bucketed.length + notNamedCount, failMsg).toBe(nonArchivedNames.length);
          }
        }
      } finally {
        vi.unstubAllEnvs();
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });
});

function extractH2Sections(body: string): { heading: string; text: string }[] {
  const lines = body.split("\n");
  const out: { heading: string; text: string }[] = [];
  let inFence = false;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^```/.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^##\s/.test(line)) starts.push(i);
  }
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const end = starts[i + 1] ?? lines.length;
    out.push({ heading: (lines[start] ?? "").trim(), text: lines.slice(start, end).join("\n") });
  }
  return out;
}

function unreducibleBytes(cwd: string, files: GenFile[]): number {
  return Buffer.byteLength(unreducibleText(cwd, files), "utf8");
}
function unreducibleText(cwd: string, files: GenFile[]): string {
  const slug = toSlug(cwd);
  const validNames = files.filter((f) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(f.name));
  return `## Memory (${slug}) — ${validNames.length} file(s)\n\n<!-- pi-toolkit:memory ${slug} -->\n`;
}

// ═══════════════════════════ G4 — determinism under touch / order shuffle ══

describe("G4 — touch / mtime-order / readdir-order invariance (I-M2)", () => {
  it("touching a file's mtime without changing content does not change the rendered bytes", () => {
    const fx = materializeFixture("current-5");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const input = inputFor(fx.cwd);
    const before = renderTiered(input);
    const target = join(fx.memDir, "quota.md");
    const t = Date.now() / 1000 + 3600;
    utimesSync(target, t, t);
    const after = renderTiered(input);
    expect(after.text).toBe(before.text);
    fx.cleanup();
  });

  it("shuffled mtimes (same content) produce byte-identical output", () => {
    const fx1 = materializeFixture("synthetic/many-files");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx1.paths.memoryRoot);
    const input1 = inputFor(fx1.cwd);
    const a = renderTiered(input1).text.split(fx1.paths.memoryRoot).join("${MEMROOT}");
    fx1.cleanup();

    const fx2 = materializeFixture("synthetic/many-files");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx2.paths.memoryRoot);
    // Reverse the mtime assignment order relative to fx1's ascending-by-name default.
    fx2.names
      .slice()
      .reverse()
      .forEach((name, i) => {
        const t = Date.parse("2026-09-01T00:00:00Z") / 1000 + i * 60;
        utimesSync(join(fx2.memDir, name), t, t);
      });
    const input2 = inputFor(fx2.cwd);
    const b = renderTiered(input2).text.split(fx2.paths.memoryRoot).join("${MEMROOT}");
    fx2.cleanup();

    expect(b).toBe(a);
  });
});

// ═══════════════════════════ G5 — access variants ══════════════════════════

describe("G5 — access variants (guide/omitted-suffix per access, toolSurface=legacy)", () => {
  const cases: { access: MemoryAccess; guideNeedle: string; omittedSuffixNeedle: string }[] = [
    {
      access: "memory+read",
      guideNeedle: "memory view <name>",
      omittedSuffixNeedle: 'memory view pitfalls.md section="',
    },
    { access: "memory", guideNeedle: "memory view <name>", omittedSuffixNeedle: 'memory view pitfalls.md section="' },
    { access: "read", guideNeedle: "read ", omittedSuffixNeedle: "read " },
    { access: "none", guideNeedle: "not openable in this session", omittedSuffixNeedle: "" },
  ];

  for (const c of cases) {
    it(`access=${c.access}: guide line and omitted-suffix match the frozen per-access template`, () => {
      const fx = materializeFixture("current-5");
      vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
      const result = renderTiered(inputFor(fx.cwd, { access: c.access }));
      expect(result.text).toContain(c.guideNeedle);
      if (c.omittedSuffixNeedle) expect(result.text).toContain(c.omittedSuffixNeedle);
      expect(result.text).not.toContain("<dir>");
      fx.cleanup();
    });
  }
});

// ═══════════════════════════ G6 — sizeTier boundaries ═══════════════════════

describe("G6 — sizeTier boundaries", () => {
  it.each([
    [0, "1k"],
    [1, "1k"],
    [1024, "1k"],
    [1025, "2k"],
    [2048, "2k"],
    [2049, "3k"],
  ])("sizeTier(%i) === %s", (size, expected) => {
    expect(sizeTier(size)).toBe(expected);
  });
});

// ═══════════════════════════ G7 — childProfile ═══════════════════════════

describe("G7 — childProfile (renderTiered's own handling)", () => {
  it('profile="core" forces k=0 (everything beyond core goes to the tail)', () => {
    const fx = materializeFixture("synthetic/many-files");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const full = renderTiered(inputFor(fx.cwd, { profile: "full" }));
    const core = renderTiered(inputFor(fx.cwd, { profile: "core" }));
    expect(full.fullIndexLines).toBeGreaterThan(0);
    expect(core.fullIndexLines).toBe(0);
    expect(core.level).toBeGreaterThanOrEqual(1);
    fx.cleanup();
  });

  it('profile="none" ⇒ empty result regardless of on-disk content', () => {
    const fx = materializeFixture("current-5");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const result = renderTiered(inputFor(fx.cwd, { profile: "none" }));
    expect(result).toEqual({
      text: "",
      bytes: 0,
      level: 0,
      omittedSections: [],
      demotedPinned: [],
      fullIndexLines: 0,
      tailKind: "none",
    });
    fx.cleanup();
  });

  it("options.extraTopics non-empty is rejected (T4 not implemented yet)", () => {
    const fx = materializeEmptyFixture();
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    expect(() => renderTiered(inputFor(fx.cwd, { options: { extraTopics: ["x"] } }))).toThrow(/not implemented/);
    // Empty array / undefined must NOT throw.
    expect(() => renderTiered(inputFor(fx.cwd, { options: { extraTopics: [] } }))).not.toThrow();
    expect(() => renderTiered(inputFor(fx.cwd))).not.toThrow();
    fx.cleanup();
  });
});

// ═══════════════════════════ G8 — accessFromTools ══════════════════════════

describe("G8 — accessFromTools", () => {
  it("undefined tools \u21d2 none (covers missing/throwing/non-array at the caller)", () => {
    expect(accessFromTools(undefined, "v2")).toBe("none");
  });
  it("exact CONSULT_READONLY_TOOLS set \u21d2 read", () => {
    expect(accessFromTools([...CONSULT_READONLY_TOOLS], "v2")).toBe("read");
    expect(accessFromTools([...CONSULT_READONLY_TOOLS].reverse(), "v2")).toBe("read");
  });
  it("CONSULT_READONLY_TOOLS + StructuredOutput \u21d2 read (rule 3, not the exact-set exception)", () => {
    expect(accessFromTools([...CONSULT_READONLY_TOOLS, "StructuredOutput"], "v2")).toBe("read");
  });
  it("read+memory (v2) \u21d2 memory+read; read+memory (legacy toolSurface) \u21d2 read (memory invisible)", () => {
    expect(accessFromTools(["read", "memory"], "v2")).toBe("memory+read");
    expect(accessFromTools(["read", "memory"], "legacy")).toBe("read");
  });
  it("memory only (v2) \u21d2 memory; (legacy) \u21d2 none", () => {
    expect(accessFromTools(["memory"], "v2")).toBe("memory");
    expect(accessFromTools(["memory"], "legacy")).toBe("none");
  });
  it("custom agent with neither read nor memory \u21d2 none", () => {
    expect(accessFromTools(["bash", "edit"], "v2")).toBe("none");
  });
  it("empty array \u21d2 none", () => {
    expect(accessFromTools([], "v2")).toBe("none");
  });
});

// ═══════════════════════════ G9 — MetaCache ═════════════════════════════════

describe("G9 — MetaCache read-skip on unchanged lstat", () => {
  it("touching one file re-reads only that file on the next render", () => {
    const fx = materializeFixture("synthetic/many-files");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const metaCache = new MetaCache();
    const context: TieredRenderContext = { metaCache };
    const input = inputFor(fx.cwd);

    renderTiered(input, context); // warm the cache (reads every file's head once)

    const spy = vi.spyOn(safeFs, "readRegularHead");
    const target = join(fx.memDir, "topic-05.md");
    const t = Date.now() / 1000 + 7200;
    utimesSync(target, t, t);

    renderTiered(input, context);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    fx.cleanup();
  });

  it("without a shared cache (bare call), correctness holds but nothing is skipped", () => {
    const fx = materializeFixture("synthetic/many-files");
    vi.stubEnv("ARMORY_MEMORY_ROOT", fx.paths.memoryRoot);
    const input = inputFor(fx.cwd);
    const a = renderTiered(input);
    const b = renderTiered(input);
    expect(a.text).toBe(b.text);
    fx.cleanup();
  });
});

// keep referenced (helper import used only for type checking / potential
// future direct unit tests of the byte-truncation primitives).
void truncateBytes;
void joinNamesTruncated;
void writeMemAt;
void writeSync;
