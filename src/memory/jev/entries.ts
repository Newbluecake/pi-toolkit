// Entry splitting, hashing, inline-authority parsing, expiry predicates and
// the per-directory entry index cache (jev-arch §4.1/§4.2, jev-plan J1).
//
// Pure domain: pi-free root (tests/boundary/pi-free.test.ts), no module-scope
// mutable state (I4) — the `EntryIndex` cache lives on the instance, held by
// the wire closure. The splitting rules 1–5 are spelled out in
// jev/contracts.ts's `MemEntry` doc comment and pinned by
// tests/memory/jev/entries.test.ts.

import { createHash } from "node:crypto";
import { frontmatterSource, parseFrontmatter, stripLeadingDriftHeader } from "../frontmatter.js";
import { parseMemoryMeta } from "../meta.js";
import { listRegular, readRegular } from "../safe-fs.js";
import { looksSecret } from "../secret-patterns.js";
import { INLINE_META_MAX_BYTES, type EntryHash, type InlineMeta, type MemEntry } from "./contracts.js";
import { namedPrograms } from "./match.js";

// ───────────────────────────── normalization & hashing ─────────────────────────────

/** Line-level normalization shared by both hashes: strip trailing whitespace,
 *  unify line endings to `\n`, collapse blank-line runs to one, trim leading/
 *  trailing blank lines (the edge trim keeps hashes stable under edits that
 *  only add surrounding blank lines — a deliberate tightening of §4.1's
 *  "去掉行尾空白，统一换行符，合并连续空行"). */
function normalizeLines(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));
  const out: string[] = [];
  for (const line of lines) {
    if (line === "" && out.length > 0 && out[out.length - 1] === "") continue;
    out.push(line);
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** §4.1 normalization for the sidecar-hash body: comment-stripped +
 *  line-normalized. Idempotent by construction. */
export function normalizeBody(text: string): string {
  return normalizeLines(stripInlineMeta(text));
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** Sidecar key: sha1(normalizeBody(body)).slice(0,12). Editing only the
 *  inline comment leaves it unchanged. */
export function entryHash(body: string): EntryHash {
  return sha1Hex(normalizeBody(body)).slice(0, 12);
}

/** Q4 pairing hash: sha1 of the line-normalized RAW text (comment included),
 *  so editing the `user` marker counts as a change. */
function entryGuardHash(raw: string): string {
  return sha1Hex(normalizeLines(raw));
}

// ───────────────────────────── inline authority comment (§4.2) ─────────────────────────────

const INLINE_COMMENT_RE = /<!--[ \t]*mem\b[^\n]*?-->/g;
const INLINE_OPENER_RE = /<!--[ \t]*mem\b/;
const TAG_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse one line's `<!-- mem … -->` authority comment. NEVER throws: every
 *  problem lands in `errors` (→ D18). No comment ⇒ `{present:false}`, no
 *  errors. Keys: user · lesson · expires=YYYY-MM-DD · until="…" ·
 *  gate|gate=hold|nogate · tags=+a,-b · private; ≤200B overall. */
export function parseInlineMeta(line: string): { meta: InlineMeta; errors: string[] } {
  const errors: string[] = [];
  INLINE_COMMENT_RE.lastIndex = 0;
  const first = INLINE_COMMENT_RE.exec(line);
  if (first === null) {
    // An opener without a closer on the same line is still a (broken) attempt.
    if (INLINE_OPENER_RE.test(line)) {
      return { meta: { present: true }, errors: ["unterminated inline comment (missing -->)"] };
    }
    return { meta: { present: false }, errors };
  }
  const whole = first[0];
  if (INLINE_COMMENT_RE.exec(line) !== null) errors.push("multiple inline comments on one line");
  if (Buffer.byteLength(whole, "utf8") > INLINE_META_MAX_BYTES) {
    errors.push(`inline comment exceeds ${INLINE_META_MAX_BYTES}B`);
  }
  const inner = whole
    .replace(/^<!--[ \t]*mem\b/, "")
    .replace(/-->$/, "")
    .trim();
  if (INLINE_OPENER_RE.test(inner)) errors.push("nested inline comment");

  const meta: {
    present: boolean;
    authority?: "user" | "lesson";
    expires?: string;
    until?: string;
    gate?: "gate" | "hold" | "nogate";
    tagsAdd?: string[];
    tagsRemove?: string[];
    isPrivate?: boolean;
  } = { present: true };
  const seen = new Set<string>();
  let sawGate = false;
  let sawNogate = false;

  // Tokenizer: whitespace-separated `key` / `key=value`; values may be one
  // double-quoted phrase (`until="a b"`).
  const tokens: { key: string; value?: string | undefined }[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && /\s/.test(inner[i]!)) i++;
    if (i >= inner.length) break;
    let key = "";
    while (i < inner.length && !/[\s=]/.test(inner[i]!)) key += inner[i++]!;
    let value: string | undefined;
    if (inner[i] === "=") {
      i++;
      if (inner[i] === '"') {
        i++;
        let quoted = "";
        while (i < inner.length && inner[i] !== '"') quoted += inner[i++]!;
        if (inner[i] === '"') i++;
        else errors.push(`unterminated quoted value for ${key}`);
        value = quoted;
      } else {
        let bare = "";
        while (i < inner.length && !/\s/.test(inner[i]!)) bare += inner[i++]!;
        value = bare;
      }
    }
    tokens.push({ key, value });
  }

  for (const { key, value } of tokens) {
    if (key === "") continue;
    if (seen.has(key)) {
      errors.push(`duplicate key ${JSON.stringify(key)}`);
      continue;
    }
    seen.add(key);
    switch (key) {
      case "user":
      case "lesson":
        if (value !== undefined) errors.push(`${key} takes no value`);
        meta.authority = key;
        break;
      case "expires":
        if (value === undefined || value === "") {
          errors.push("expires requires a value");
          break;
        }
        if (!DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
          errors.push(`expires ${JSON.stringify(value)} is not a valid YYYY-MM-DD date`);
        }
        meta.expires = value;
        break;
      case "until":
        if (value === undefined || value === "") {
          errors.push("until requires a value");
          break;
        }
        meta.until = value;
        break;
      case "gate":
        sawGate = true;
        if (value === undefined || value === "") meta.gate = "gate";
        else if (value === "hold") meta.gate = "hold";
        else errors.push(`gate ${JSON.stringify(value)} is not a valid value (use gate or gate=hold)`);
        break;
      case "nogate":
        sawNogate = true;
        if (value !== undefined) errors.push("nogate takes no value");
        meta.gate = "nogate";
        break;
      case "tags": {
        if (value === undefined || value === "") {
          errors.push("tags requires a value");
          break;
        }
        const add: string[] = [];
        const remove: string[] = [];
        for (const item of value.split(",")) {
          if (item === "") continue;
          const sign = item[0];
          const id = item.slice(1);
          if ((sign === "+" || sign === "-") && TAG_ID_RE.test(id)) {
            (sign === "+" ? add : remove).push(id);
          } else {
            errors.push(`invalid tag item ${JSON.stringify(item)} in tags=`);
          }
        }
        if (add.length > 0) meta.tagsAdd = add;
        if (remove.length > 0) meta.tagsRemove = remove;
        break;
      }
      case "private":
        if (value !== undefined) errors.push("private takes no value");
        meta.isPrivate = true;
        break;
      default:
        errors.push(`unknown key ${JSON.stringify(key)}`);
    }
  }
  if (sawGate && sawNogate) errors.push("gate and nogate are mutually exclusive");
  return { meta: meta, errors };
}

/** Remove every `<!-- mem … -->` comment from a text (rendering + body
 *  extraction). Idempotent: the result contains no further matches. */
export function stripInlineMeta(text: string): string {
  return text
    .replace(INLINE_COMMENT_RE, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// ───────────────────────────── expiry predicates (§6.3.5) ─────────────────────────────

function validDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/** Entries whose (valid) `expires` is strictly EARLIER than `today`
 *  (`YYYY-MM-DD`, local date): still valid on the day itself; invalid dates
 *  never expire (they are already reported via `inlineErrors`). */
export function expiredEntries(entries: readonly MemEntry[], today: string): readonly MemEntry[] {
  return entries.filter(
    (e) => e.inline.expires !== undefined && validDate(e.inline.expires) && e.inline.expires < today,
  );
}

/** Entries with only an `until` (event condition), no `expires`. */
export function untilEntries(entries: readonly MemEntry[]): readonly MemEntry[] {
  return entries.filter((e) => e.inline.until !== undefined && e.inline.expires === undefined);
}

// ───────────────────────────── splitting (§4.1 rules 1–5) ─────────────────────────────

export interface EntryFileInfo {
  /** Frontmatter `status`; "archived" files never reach here (EntryIndex
   *  skips them; direct callers may pass either value). */
  status: "active" | "stale";
  /** No `source: agent` in the frontmatter ⇒ hand-written ⇒ default
   *  authority "user" (Q4/O5); an inline `user`/`lesson` overrides. */
  handWritten: boolean;
}

/** 0-based index of the first body line (frontmatter + leading drift banner
 *  excluded), so `lineStart`/`lineEnd` stay true to the raw file. */
function bodyStartLineIndex(raw: string): number {
  const effective = stripLeadingDriftHeader(raw);
  const bannerLines =
    raw.length === effective.length ? 0 : raw.slice(0, raw.length - effective.length).split("\n").length - 1;
  const fm = parseFrontmatter(effective);
  if (fm === undefined) return bannerLines;
  return bannerLines + (effective.slice(0, fm.bodyStart).split("\n").length - 1);
}

type BlockKind = "list" | "table" | "quote" | "html" | "para";

interface RawBlock {
  /** Inclusive 0-based line indices into the raw line array. */
  start: number;
  end: number;
  kind: BlockKind;
  /** Region id: one per `## ` occurrence (0 = the file head); a trailing H1
   *  (after at least one `## `) reopens a head-like region. */
  regionId: number;
  /** Active `## ` title at block start ("" = file head). */
  section: string;
  /** Active heading label at block start (`A` / `A › B` / undefined). */
  heading: string | undefined;
}

const FENCE_RE = /^\s*(?:```|~~~)/;
const H1_RE = /^#\s/;
const H2_RE = /^##\s/;
const H3_RE = /^###\s/;
const LIST_RE = /^(?:[-*+]|\d{1,9}[.)])\s/;
const TABLE_RE = /^\|/;
const QUOTE_RE = /^>/;
const HTML_RE = /^<[A-Za-z]/;

/** Walk the raw lines and cut them into region-annotated blocks. */
function cutBlocks(lines: readonly string[], from: number): RawBlock[] {
  const blocks: RawBlock[] = [];
  let regionId = 0;
  let sawH2 = false;
  let section = "";
  let h2: string | undefined;
  let h3: string | undefined;
  let inFence = false;
  let open: RawBlock | undefined;
  const headingLabel = (): string | undefined =>
    h2 === undefined && h3 === undefined ? undefined : h2 === undefined ? h3 : h3 === undefined ? h2 : `${h2} › ${h3}`;

  const close = (end: number): void => {
    if (open !== undefined && end >= open.start) blocks.push({ ...open, end });
    open = undefined;
  };
  const openBlock = (kind: BlockKind, start: number): void => {
    open = { start, end: start, kind, regionId, section, heading: headingLabel() };
  };
  const continueOrOpen = (kind: BlockKind, i: number): void => {
    if (open?.kind === kind) open.end = i;
    else {
      close(i - 1);
      openBlock(kind, i);
    }
  };

  for (let i = from; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (inFence) {
      // Fenced content is opaque; a fence belonging to an open list entry (or
      // an HTML block, which absorbs through to the next blank line) is its
      // continuation, otherwise it is skipped entirely.
      if (FENCE_RE.test(line)) inFence = false;
      if (open !== undefined && (open.kind === "list" || open.kind === "html")) open.end = i;
      continue;
    }
    if (FENCE_RE.test(line)) {
      inFence = true;
      if (open !== undefined && (open.kind === "list" || open.kind === "html")) open.end = i; // rule 3: “属于它的围栏块”
      continue;
    }
    if (line === "") {
      if (open?.kind === "list") {
        open.end = i; // rule 3: blank lines inside the list continue it
      } else {
        close(i - 1);
      }
      continue;
    }
    if (H1_RE.test(line) || H2_RE.test(line) || H3_RE.test(line)) {
      close(i - 1);
      if (H2_RE.test(line)) {
        sawH2 = true;
        regionId++;
        section = line.replace(H2_RE, "").trim();
        h2 = section === "" ? undefined : section;
        h3 = undefined;
      } else if (H3_RE.test(line)) {
        h3 = line.replace(H3_RE, "").trim() || undefined;
      } else if (sawH2) {
        // Trailing H1 closes the section without opening one (splitSections
        // precedent); subsequent content falls back to a fresh head-like
        // region — rare, documented.
        regionId++;
        section = "";
        h2 = undefined;
        h3 = undefined;
      }
      continue;
    }
    const indented = /^[ \t]/.test(line);
    if (open?.kind === "html") {
      // Rule 5: an HTML block runs from its `<tag` line through the next
      // blank line (headings still close it defensively).
      open.end = i;
      continue;
    }
    if (open?.kind === "list") {
      if (!indented && (LIST_RE.test(line) || TABLE_RE.test(line) || QUOTE_RE.test(line) || HTML_RE.test(line))) {
        // Next col-0 list item (rule 3) or a col-0 block-level structure
        // (rule 5) — both end the open entry.
        close(i - 1);
        openBlock(
          LIST_RE.test(line) ? "list" : TABLE_RE.test(line) ? "table" : QUOTE_RE.test(line) ? "quote" : "html",
          i,
        );
        continue;
      }
      if (indented) {
        open.end = i; // rule 3: indented continuation (incl. tables/quotes)
        continue;
      }
      close(i - 1); // non-indented ordinary paragraph ends it (rule 3)
      openBlock("para", i);
      continue;
    }
    if (indented) {
      // Indented stray lines join the current paragraph (loose continuation).
      continueOrOpen("para", i);
      continue;
    }
    if (LIST_RE.test(line)) {
      close(i - 1);
      openBlock("list", i);
      continue;
    }
    if (TABLE_RE.test(line)) {
      continueOrOpen("table", i);
      continue;
    }
    if (QUOTE_RE.test(line)) {
      continueOrOpen("quote", i);
      continue;
    }
    if (HTML_RE.test(line)) {
      continueOrOpen("html", i);
      continue;
    }
    continueOrOpen("para", i);
  }
  close(lines.length - 1);
  return blocks;
}

function paragraphCodePoints(lines: readonly string[], start: number, end: number): number {
  let text = "";
  for (let i = start; i <= end; i++) text += `${(lines[i] ?? "").replace(/\r$/, "").trim()} `;
  return Array.from(text.trim()).length;
}

/** Split one memory file into entries. `raw` is the WHOLE file content
 *  (frontmatter + drift banner are skipped internally; `lineStart`/`lineEnd`
 *  remain 1-based raw-file line numbers). Never throws. */
export function splitEntries(file: string, raw: string, fileInfo: EntryFileInfo): MemEntry[] {
  const lines = raw.split("\n");
  // A trailing "\n" leaves a phantom empty final element — drop it so it
  // never lands inside an entry's line span.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const from = bodyStartLineIndex(raw);
  const blocks = cutBlocks(lines, from);

  // Group blocks per region (one region per `## ` occurrence + the file
  // head). Rule 4: a region with NO list block collapses into ONE entry.
  // Rule 5: short paragraphs (<40 code points) merge into the next entry as
  // context; with no next entry they merge into the previous one (J1 default
  // for end-of-file, reported to root); with neither, they stand alone.
  interface Span {
    start: number;
    end: number;
    section: string;
    heading: string | undefined;
    ordinal: number;
  }
  const spans: Span[] = [];
  let regionStart = 0;
  while (regionStart < blocks.length) {
    const regionId = blocks[regionStart]!.regionId;
    let regionEnd = regionStart;
    while (regionEnd + 1 < blocks.length && blocks[regionEnd + 1]!.regionId === regionId) regionEnd++;
    const regionBlocks = blocks.slice(regionStart, regionEnd + 1).map((b) => ({ ...b }));
    regionStart = regionEnd + 1;

    if (!regionBlocks.some((b) => b.kind === "list")) {
      if (regionBlocks.length > 0) {
        spans.push({
          start: regionBlocks[0]!.start,
          end: regionBlocks[regionBlocks.length - 1]!.end,
          section: regionBlocks[0]!.section,
          heading: regionBlocks[0]!.heading,
          ordinal: 1,
        });
      }
      continue;
    }
    const merged: RawBlock[] = [];
    for (const block of regionBlocks) {
      if (block.kind === "para" && paragraphCodePoints(lines, block.start, block.end) < 40) {
        const next = regionBlocks.find((b) => b.start > block.end);
        if (next !== undefined) {
          next.start = Math.min(next.start, block.start); // absorb forward
          continue;
        }
        const prev = [...merged].reverse().find((b) => b.end < block.start);
        if (prev !== undefined) {
          prev.end = Math.max(prev.end, block.end); // absorb backward (EOF default)
          continue;
        }
      }
      merged.push(block);
    }
    let ordinal = 0;
    for (const block of merged) {
      spans.push({
        start: block.start,
        end: block.end,
        section: block.section,
        heading: block.heading,
        ordinal: ++ordinal,
      });
    }
  }

  const entries: MemEntry[] = [];
  for (const span of spans) {
    if (span.end < span.start) continue;
    const rawText = normalizeLines(lines.slice(span.start, span.end + 1).join("\n"));
    if (rawText === "") continue;
    const body = normalizeBody(rawText);
    // Inline comment: the entry's first non-empty line (the list-item line,
    // or the first body line under the heading for whole-section entries).
    let inlineLine = "";
    for (let i = span.start; i <= span.end; i++) {
      const line = (lines[i] ?? "").replace(/\r$/, "");
      if (line.trim() !== "") {
        inlineLine = line;
        break;
      }
    }
    const { meta, errors } = parseInlineMeta(inlineLine);
    const authority: "user" | "agent" =
      meta.authority === "user"
        ? "user"
        : meta.authority === "lesson"
          ? "agent"
          : fileInfo.handWritten
            ? "user"
            : "agent";
    entries.push({
      file,
      ...(span.heading === undefined ? {} : { heading: span.heading }),
      section: span.section,
      ordinal: span.ordinal,
      lineStart: span.start + 1,
      lineEnd: span.end + 1,
      raw: rawText,
      body,
      hash: entryHash(body),
      guardHash: entryGuardHash(rawText),
      inline: meta,
      inlineErrors: errors,
      authority,
      fileStatus: fileInfo.status,
      secret: looksSecret(body),
      namedPrograms: namedPrograms(body),
    });
  }
  return entries;
}

// ───────────────────────────── EntryIndex (per-directory cache, §4.1) ─────────────────────────────

export interface EntryIndexStat {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Injectable fs seam so tests can count reads (fingerprint pinning). The
 *  default lists `*.md` via node:fs and never throws. */
export interface EntryIndexFs {
  list(dir: string): readonly EntryIndexStat[];
  read(dir: string, name: string): string | undefined;
}

class DefaultEntryIndexFs implements EntryIndexFs {
  list(dir: string): readonly EntryIndexStat[] {
    try {
      // safe-fs is the only node:fs importer under src/memory (fs-guard §3.1);
      // listRegular skips symlinks/non-files like every other memory layer.
      const { files } = listRegular(dir, { names: "legacy" });
      return files
        .map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return [];
    }
  }
  read(dir: string, name: string): string | undefined {
    try {
      return readRegular(dir, name).text;
    } catch {
      return undefined;
    }
  }
}

interface CachedFile {
  readonly fp: string;
  readonly entries: readonly MemEntry[]; // empty for archived files
}

/** Directory-keyed entry cache. Fingerprint = per-file name+size+mtime;
 *  unchanged files are never re-read or re-split (secret/namedPrograms ride
 *  along, recomputed only when a file changes). Held by the wire closure —
 *  never at module scope (I4). */
export class EntryIndex {
  private readonly fs: EntryIndexFs;
  private readonly cache = new Map<string, { files: Map<string, CachedFile>; entries: readonly MemEntry[] }>();

  constructor(fs?: EntryIndexFs) {
    this.fs = fs ?? new DefaultEntryIndexFs();
  }

  get(dir: string): readonly MemEntry[] {
    const cached = this.cache.get(dir);
    const stats = this.fs.list(dir);
    if (cached !== undefined) {
      let changed = stats.length !== cached.files.size;
      const next = new Map<string, CachedFile>();
      for (const stat of stats) {
        const prev = cached.files.get(stat.name);
        const fp = `${stat.name}:${stat.size}:${stat.mtimeMs}`;
        if (prev !== undefined && prev.fp === fp) {
          next.set(stat.name, prev);
        } else {
          changed = true;
          next.set(stat.name, this.splitFile(dir, stat.name, fp));
        }
      }
      if (!changed) return cached.entries;
      const entries = [...next.values()].flatMap((f) => [...f.entries]);
      this.cache.set(dir, { files: next, entries });
      return entries;
    }
    const files = new Map<string, CachedFile>();
    for (const stat of stats) {
      files.set(stat.name, this.splitFile(dir, stat.name, `${stat.name}:${stat.size}:${stat.mtimeMs}`));
    }
    const entries = [...files.values()].flatMap((f) => [...f.entries]);
    this.cache.set(dir, { files, entries });
    return entries;
  }

  invalidate(dir?: string): void {
    if (dir === undefined) this.cache.clear();
    else this.cache.delete(dir);
  }

  private splitFile(dir: string, name: string, fp: string): CachedFile {
    const raw = this.fs.read(dir, name);
    if (raw === undefined) return { fp, entries: [] };
    const { meta } = parseMemoryMeta(raw, name.replace(/\.md$/, ""));
    if (meta.status === "archived") return { fp, entries: [] };
    const handWritten = frontmatterSource(raw) !== "agent";
    return {
      fp,
      entries: splitEntries(name, raw, {
        status: meta.status === "stale" ? "stale" : "active",
        handWritten,
      }),
    };
  }
}
