// §4.3 `search` command — P2 real implementation (todo #22 optimize-plan
// §14.1). Whitespace-tokenized (≤8 words), literal (never regex),
// case-insensitive multi-word scoring over each file's raw content (which,
// since it includes any frontmatter block, naturally covers `description`/
// `read_when` hits too — §4.3's "扫描正文行 + description/read_when 命中").
//
// Zero pi/typebox imports; independently unit-testable.

import { parseMemoryMeta } from "./meta.js";
import { sectionAtLine, splitSectionsWithLines } from "./edit.js";

export interface MemorySearchHit {
  file: string;
  line: number;
  section?: string;
  text: string;
  /** Extension beyond the P0-b stub (owned by this file, not contracts.ts):
   *  §4.3's "archived 标记" — true when the hit's file has `status: archived`. */
  archived: boolean;
}

const MAX_WORDS = 8;
const MAX_HITS = 20;
const MAX_LINE_BYTES = 160;

/** Whitespace-split, non-empty, lower-cased, capped at 8 DISTINCT words
 *  (extra words are ignored — §4.3 gives no explicit behavior for >8, and
 *  silently dropping the tail keeps scoring bounded). Duplicate words (e.g.
 *  a repeated term in the query) collapse to one — otherwise a line matching
 *  it once would score as if it matched two distinct words. */
function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const w = raw.trim().toLowerCase();
    if (w.length === 0 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

/** Code-point-safe hard truncation to `maxBytes` UTF-8 bytes TOTAL
 *  (including the trailing `…` marker when anything was cut — reserving its
 *  bytes up front, rather than appending it after an already-full slice,
 *  is what keeps the result within `maxBytes` instead of overshooting by
 *  the marker's own width). No markdown-boundary logic — this is a single
 *  search-result line, not a truncateAtSection-style block. */
function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - ELLIPSIS_BYTES);
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (bytes + b > budget) break;
    bytes += b;
    end += ch.length;
  }
  return text.slice(0, end) + ELLIPSIS;
}

interface RawHit {
  file: string;
  line: number;
  section: string | undefined;
  score: number;
  text: string;
  archived: boolean;
}

/**
 * Score+rank literal, case-insensitive, multi-word matches across `files`'
 * raw content (line by line, 1-indexed — the same coordinate system `view`
 * uses, frontmatter included). Score = count of DISTINCT query words that
 * literally occur in the line; ties break by filename then line number;
 * capped at 20 results, each hit's text hard-truncated to 160 UTF-8 bytes.
 */
export function searchMemory(files: readonly { name: string; body: string }[], query: string): MemorySearchHit[] {
  const words = tokenize(query);
  if (words.length === 0) return [];
  const raw: RawHit[] = [];
  for (const file of files) {
    const meta = parseMemoryMeta(file.body, file.name.replace(/\.md$/, ""));
    const archived = meta.meta.status === "archived";
    const lines = file.body.split("\n");
    const { sections } = splitSectionsWithLines(file.body);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lower = line.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (lower.includes(w)) score++;
      }
      if (score === 0) continue;
      const lineNo = i + 1;
      raw.push({
        file: file.name,
        line: lineNo,
        section: sectionAtLine(sections, lineNo)?.heading,
        score,
        text: truncateBytes(line.trim(), MAX_LINE_BYTES),
        archived,
      });
    }
  }
  raw.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  return raw.slice(0, MAX_HITS).map((h) => ({
    file: h.file,
    line: h.line,
    text: h.text,
    archived: h.archived,
    ...(h.section === undefined ? {} : { section: h.section }),
  }));
}
