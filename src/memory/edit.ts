// §4.3 v2 edit-command helpers (str_replace / insert / section resolution) —
// P2 real implementation (todo #22 optimize-plan §14.1).
//
// Also home to a line-indexed section splitter (`splitSectionsWithLines`)
// shared by `tool-v2.ts` (view path section=S / insert section=S) and
// `search.ts` (which section a search hit line falls in). `meta.ts`'s frozen
// `splitSections` (P0) exposes heading+text but not 1-indexed line numbers —
// re-deriving the same fence-aware split here (instead of editing the frozen
// file) keeps §4.3's "view/insert/search all share ONE coordinate system: a
// 1-indexed line number over the file's raw content, frontmatter included"
// invariant in a single place P2 owns.
//
// Zero pi/typebox imports; independently unit-testable.

import { parseFrontmatter } from "./frontmatter.js";
import { MemoryError } from "./paths.js";

// ───────────────────────────── str_replace ─────────────────────────────

export interface StrReplaceMatch {
  line: number;
}

/**
 * Locate every literal (never regex) occurrence of `oldStr` in `body`,
 * reporting the 1-indexed line its FIRST character falls on — the same
 * coordinate system `view`'s line numbers use (frontmatter included).
 * Overlapping occurrences are all reported (rare in practice for anything
 * long enough to be a meaningful `old_str`).
 */
export function findStrReplaceMatches(body: string, oldStr: string): StrReplaceMatch[] {
  if (oldStr === "") return [];
  const matches: StrReplaceMatch[] = [];
  let from = 0;
  for (;;) {
    const idx = body.indexOf(oldStr, from);
    if (idx === -1) break;
    matches.push({ line: lineNumberAt(body, idx) });
    from = idx + 1; // allow overlapping matches to be counted (ambiguity detection wants ALL of them)
  }
  return matches;
}

/** 1-indexed line number containing byte/char offset `index` (frontmatter counted). */
function lineNumberAt(body: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (body.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/** Character offset where `body`'s frontmatter block ends (`fm.bodyStart`), or
 *  `0` when there is no frontmatter — i.e. "any offset ≥ this is in the body". */
export function frontmatterEndOffset(body: string): number {
  return parseFrontmatter(body)?.bodyStart ?? 0;
}

/** 1-indexed line number of the LAST line of the frontmatter block (the
 *  closing `---` fence line), or `0` when there is no frontmatter. */
export function frontmatterCloseLine(body: string): number {
  const end = frontmatterEndOffset(body);
  if (end === 0) return 0;
  // end points just past the closing fence's trailing '\n' (or EOF if the
  // fence is the last line with no trailing newline) — the fence line's own
  // number is the count of '\n' characters strictly before it.
  let line = 0;
  for (let i = 0; i < end; i++) {
    if (body.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ───────────────────────────── insert target resolution ─────────────────────────────

export interface InsertTarget {
  afterLine: number;
  note?: string;
}

/**
 * §4.3's insert-target resolution: exactly one of `insertLine`/`section` must
 * be given. `insertLine` falling strictly inside frontmatter (line 1 through
 * the closing fence line minus one) is rejected; `insertLine: 0` on a file
 * WITH frontmatter is normalized to "right after the closing fence" with a
 * note. `section` resolves via `resolveSectionMatch` and targets the END of
 * the matched section (insert after its last line).
 */
export function resolveInsertTarget(body: string, opts: { insertLine?: number; section?: string }): InsertTarget {
  const hasLine = opts.insertLine !== undefined;
  const hasSection = opts.section !== undefined;
  if (hasLine === hasSection) {
    throw new MemoryError("insert requires exactly one of insert_line or section");
  }
  if (hasSection) {
    const { sections } = splitSectionsWithLines(body);
    const match = resolveSectionMatch(sections, opts.section as string);
    return { afterLine: match.endLine };
  }
  const n = opts.insertLine as number;
  const closeLine = frontmatterCloseLine(body);
  if (closeLine > 0 && n >= 1 && n <= closeLine - 1) {
    throw new MemoryError(
      `insert_line ${n} falls inside the frontmatter block (lines 1-${closeLine}); insert at ${closeLine} or later`,
    );
  }
  if (n === 0 && closeLine > 0) {
    return { afterLine: closeLine, note: `inserted after frontmatter (line ${closeLine})` };
  }
  const totalLines = body === "" ? 0 : body.split("\n").length;
  if (n < 0 || n > totalLines) {
    throw new MemoryError(`invalid insert_line ${n} — must be within [0, ${totalLines}]`);
  }
  return { afterLine: n };
}

// ───────────────────────────── line-indexed section splitting ─────────────────────────────

export interface SectionRange {
  /** Heading text, `## ` prefix and surrounding whitespace stripped. */
  heading: string;
  /** 1-indexed line number of the `## ` heading line itself. */
  startLine: number;
  /** 1-indexed line number of the section's last line (inclusive). */
  endLine: number;
  /** The heading line through `endLine`, joined with `\n`. */
  text: string;
}

export interface SplitSectionsWithLines {
  preamble: string;
  /** 1-indexed line number of the preamble's last line (0 when the file is empty). */
  preambleEndLine: number;
  sections: readonly SectionRange[];
}

const FENCE_RE = /^```/;
const H2_RE = /^##\s/;
const H1_RE = /^#\s/;

/** Same fence-aware `## `-boundary algorithm as `meta.ts`'s frozen
 *  `splitSections`, but also returning 1-indexed line numbers for each
 *  section (needed by `view path section=S`'s "section L12–L25" suffix,
 *  `insert section=S`'s end-of-section target, and `search`'s per-hit
 *  section lookup — none of which meta.ts's frozen shape exposes). */
export function splitSectionsWithLines(body: string): SplitSectionsWithLines {
  const lines = body.split("\n");
  let inFence = false;
  let sawH2 = false;
  const boundaries: number[] = []; // 0-indexed line index that ENDS the preceding section
  const sectionStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (H2_RE.test(line)) {
      sawH2 = true;
      boundaries.push(i);
      sectionStarts.push(i);
    } else if (H1_RE.test(line) && sawH2) {
      boundaries.push(i);
    }
  }
  const preambleEndIdx = boundaries[0] ?? lines.length;
  const preamble = lines.slice(0, preambleEndIdx).join("\n");
  const sections: SectionRange[] = [];
  for (const start of sectionStarts) {
    const nextBoundary = boundaries.find((b) => b > start);
    const endIdx = (nextBoundary ?? lines.length) - 1; // 0-indexed last line of this section
    sections.push({
      heading: (lines[start] ?? "").replace(H2_RE, "").trim(),
      startLine: start + 1,
      endLine: endIdx + 1,
      text: lines.slice(start, endIdx + 1).join("\n"),
    });
  }
  return { preamble, preambleEndLine: preambleEndIdx, sections };
}

/** Locate which section (if any) contains 1-indexed `line`; undefined for a
 *  line in the preamble (or an out-of-range line). */
export function sectionAtLine(sections: readonly SectionRange[], line: number): SectionRange | undefined {
  return sections.find((s) => line >= s.startLine && line <= s.endLine);
}

/**
 * §4.3's section-name resolution: exact match first (heading text, `#`
 * stripped, trimmed, case-insensitive), else a unique case-insensitive
 * prefix match; zero or multiple candidates throw a `MemoryError` listing
 * the candidates (and their line numbers, for the ambiguous case).
 */
export function resolveSectionMatch(sections: readonly SectionRange[], query: string): SectionRange {
  const q = query
    .trim()
    .replace(/^#+\s*/, "")
    .toLowerCase();
  const exact = sections.filter((s) => s.heading.toLowerCase() === q);
  if (exact.length === 1) return exact[0] as SectionRange;
  if (exact.length > 1) {
    return ambiguous(exact, q);
  }
  const prefix = sections.filter((s) => s.heading.toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0] as SectionRange;
  if (prefix.length > 1) return ambiguous(prefix, q);
  const names = sections.map((s) => s.heading).join(", ");
  throw new MemoryError(`no section matching ${JSON.stringify(query)} — available sections: ${names || "(none)"}`);
}

function ambiguous(candidates: readonly SectionRange[], query: string): never {
  const list = candidates.map((s) => `"${s.heading}" (L${s.startLine})`).join(", ");
  throw new MemoryError(`ambiguous section ${JSON.stringify(query)} — matches: ${list}`);
}
