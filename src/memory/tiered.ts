// §2.2–§2.3 tiered rendering (todo #22 optimize-plan, package P1, §14.1).
//
// `renderTiered` is the pure, deterministic (given the memory dir's on-disk
// state) block renderer for `memory.layout === "tiered"`; `minimalFrame` is
// the shared "would the unreducible skeleton even fit?" probe used for the
// L5 decision (§2.3 step 1/point "L5 是否允许超限"). Both build on the SAME
// frozen `TIERED_TEMPLATES` constant (contracts.ts, P0) — never a second
// copy of the block's text. `accessFromTools` (§2.4) and the two caches
// (`MetaCache` §2.5, `TieredRenderCache` §2.5) are the other P1 exports
// `src/memory/inject.ts` wires into the injection hot path.
//
// Zero pi/typebox imports; independently unit-testable (matches every other
// file under `src/memory/**` except `safe-fs.ts`).

import { createHash } from "node:crypto";
import type { MemoryToolSurface } from "../config/settings.js";
import { CONSULT_READONLY_TOOLS } from "../runtime/tool-scope.js";
import {
  TIERED_TEMPLATES,
  type MemoryAccess,
  type MemoryMeta,
  type TieredLevel,
  type TieredRenderInput,
  type TieredRenderResult,
} from "./contracts.js";
import { frontmatterSource, stripFrontmatter } from "./frontmatter.js";
import { descriptionOrHeading, parseMemoryMeta, splitSections, type MemorySection } from "./meta.js";
import { memoryDirFor, toSlug } from "./paths.js";
import { injectionSentinel, stripDriftHeader } from "./render.js";
import { canonicalDir, listRegular, readRegular, readRegularHead } from "./safe-fs.js";

const HEAD_BYTES = 4096;
const NAME_LIST_MAX_BYTES = 200;
const INDEX_LINE_MAX_BYTES = 200;
const DESCRIPTION_MAX_BYTES = 110;
const READ_WHEN_MAX_BYTES = 70;
const IDX_FLOOR_CAP = 240;
/** §2.3: `C ≤ B − 600` (room reserved for the unreducible skeleton). */
const RESERVED_MARGIN = 600;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Plain codepoint-order comparator (`<`/`>` on strings) — §2.2's "码点序"
 *  sort rule, NOT locale-aware `localeCompare` (matches `tool-surface.ts`'s
 *  existing convention for the same reason: deterministic across locales). */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Fill `{key}` placeholders in a frozen `TIERED_TEMPLATES` string. Plain
 *  split/join (not regex) — template text may itself contain regex
 *  metacharacters (e.g. the header's em dash is fine, but this avoids ever
 *  having to think about it). */
function fill(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

/** Codepoint-safe truncation of a single line/text to `maxBytes`, appending
 *  "…" at the cut point when truncated (§2.2's per-index-line rule). Never
 *  splits a surrogate pair (`for...of` iterates by codepoint). */
export function truncateBytes(text: string, maxBytes: number): string {
  if (byteLen(text) <= maxBytes) return text;
  const ellipsisBytes = byteLen("…");
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const b = byteLen(ch);
    if (bytes + b > budget) break;
    out += ch;
    bytes += b;
  }
  return out + "…";
}

/**
 * Greedy, whole-name-safe name-list truncation shared by the primary's
 * omitted-sections line (§2.1 point 3: "节名单超过200B时截为 `A · B · +3`")
 * and the index tail's compact name list (§2.3 step 5). Includes as many
 * WHOLE names (in original order) as fit alongside the eventual "+N"
 * suffix — never splits a name mid-way (stronger than "codepoint safe").
 */
export function joinNamesTruncated(names: readonly string[], maxBytes: number, sep = " · "): string {
  if (names.length === 0) return "";
  let included = 0;
  for (let i = 0; i < names.length; i++) {
    const remaining = names.length - (i + 1);
    const suffix = remaining > 0 ? `${sep}+${remaining}` : "";
    const text = names.slice(0, i + 1).join(sep) + suffix;
    if (byteLen(text) <= maxBytes) {
      included = i + 1;
    } else {
      break;
    }
  }
  if (included === 0) {
    return names.length === 1 ? truncateBytes(names[0]!, maxBytes) : `+${names.length}`;
  }
  const remaining = names.length - included;
  return names.slice(0, included).join(sep) + (remaining > 0 ? `${sep}+${remaining}` : "");
}

/** §2.2's `sizeTier(size)`: `size ≤ 1024 ⇒ "1k"`, else `ceil(size/1024)+"k"`. */
export function sizeTier(size: number): string {
  if (size <= 1024) return "1k";
  return `${Math.ceil(size / 1024)}k`;
}

function setEquals(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((x) => a.has(x));
}

/**
 * §2.4's access classification. `tools === undefined` covers all three
 * "can't tell" cases (the CALLER is responsible for collapsing a missing/
 * throwing/non-array `pi.getActiveTools()` to `undefined` before calling
 * this — `src/memory/inject.ts`'s `safeGetActiveTools` does exactly that);
 * this function itself never throws. Rule 2 (consult's exact-set exception)
 * is checked before the general rule 3 combination so a consult run is
 * `"read"` even though it isn't literally "has read, no memory" — though
 * for the tidy readonly domain (four tools + `StructuredOutput`) rule 3
 * already yields `"read"` on its own (no special case needed there).
 */
export function accessFromTools(tools: readonly string[] | undefined, toolSurface: MemoryToolSurface): MemoryAccess {
  if (tools === undefined) return "none";
  const set = new Set(tools);
  if (setEquals(set, CONSULT_READONLY_TOOLS)) return "read";
  const hasRead = set.has("read");
  const hasMemory = toolSurface === "v2" && set.has("memory");
  if (hasMemory && hasRead) return "memory+read";
  if (hasMemory) return "memory";
  if (hasRead) return "read";
  return "none";
}

// ───────────────────────────── §2.5 MetaCache ─────────────────────────────

interface MetaEntry {
  size: number;
  mtimeMs: number;
  sha1: string;
  meta: MemoryMeta;
  errors: readonly string[];
  description: string;
}

/**
 * Per-file metadata cache (§2.5): keyed by `dir\0name` (stronger than the
 * plan's shorthand "键 name" — this instance is shared across renders for
 * potentially different cwds within one process, so the directory must be
 * part of the key to avoid a same-named-file collision across projects).
 * `listRegular`'s cheap readdir-time `{size, mtimeMs}` stands in for the
 * plan's `{dev, ino, mtimeNs}` lstat signature (`safe-fs.ts` is frozen and
 * does not expose dev/ino through `listRegular`, and P1 may not modify it) —
 * unchanged size+mtime is treated as "lstat unchanged" (skip the read
 * entirely); a changed size/mtime forces a re-read, and THEN an unchanged
 * sha1 reuses the previously parsed meta/description (touch-without-
 * content-change, e.g. from `utimesSync` or a byte-identical rewrite).
 */
export class MetaCache {
  private readonly entries = new Map<string, MetaEntry>();
  private readonly capacity: number;

  constructor(capacity = 512) {
    this.capacity = capacity;
  }

  read(dir: string, name: string, size: number, mtimeMs: number): MetaEntry {
    const key = `${dir}\0${name}`;
    const cached = this.entries.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
    const { text } = readRegularHead(dir, name, HEAD_BYTES);
    const sha1 = createHash("sha1").update(text, "utf8").digest("hex");
    if (cached && cached.sha1 === sha1) {
      const updated: MetaEntry = { ...cached, size, mtimeMs };
      this.setBounded(key, updated);
      return updated;
    }
    const fallbackTopic = name.replace(/\.md$/, "");
    const { meta, errors } = parseMemoryMeta(text, fallbackTopic);
    const bodyAfterFm = stripDriftHeader(stripFrontmatter(text));
    const description = descriptionOrHeading(bodyAfterFm, meta);
    const entry: MetaEntry = { size, mtimeMs, sha1, meta, errors, description };
    this.setBounded(key, entry);
    return entry;
  }

  private setBounded(key: string, entry: MetaEntry): void {
    if (!this.entries.has(key) && this.entries.size >= this.capacity) this.entries.clear();
    this.entries.set(key, entry);
  }
}

// ───────────────────────────── §2.5 TieredRenderCache ─────────────────────────────

/** cwd-scoped content fingerprint for the tiered path (v2 names only,
 *  mirrors `render.ts`'s `memoryFingerprint` but restricted to `isV2Name`
 *  entries — a bad-named file is invisible to the tiered renderer too). */
export function tieredFingerprint(cwd: string): string {
  const display = memoryDirFor(cwd);
  const canon = canonicalDir(display);
  const dir = canon ? canon.real : display;
  const { files } = listRegular(dir, { names: "v2" });
  return files
    .map((f) => `${f.name}:${f.size}:${Math.floor(f.mtimeMs)}`)
    .sort()
    .join("\n");
}

/**
 * Full-block cache for the tiered renderer (§2.5): a NEW class (never
 * `RenderCache`) because the cache key has different dimensions
 * (`profile`/`coreBytes`/`blockBytes`/`toolSurface`/`access`, none of which
 * exist in legacy's `InjectBudget`). `src/memory/inject.ts` is the sole
 * consumer — it computes `tieredFingerprint(cwd)` and calls `get`/`set`
 * around its own call to `renderTiered`, exactly like `render.ts`'s
 * `RenderCache` is used around `renderMemoryBlock` today.
 */
export class TieredRenderCache {
  private readonly entries = new Map<string, { fingerprint: string; result: TieredRenderResult }>();
  private readonly capacity: number;

  constructor(capacity = 64) {
    this.capacity = capacity;
  }

  private key(input: TieredRenderInput, toolSurface: MemoryToolSurface): string {
    return `${input.cwd}\0tiered:${input.profile}:${input.coreBytes}:${input.blockBytes}:${input.indexMax}:${toolSurface}:${input.access}`;
  }

  get(input: TieredRenderInput, toolSurface: MemoryToolSurface, fingerprint: string): TieredRenderResult | undefined {
    const e = this.entries.get(this.key(input, toolSurface));
    if (!e || e.fingerprint !== fingerprint) return undefined;
    return e.result;
  }

  /** Ignores fingerprint — last-written result for this exact key. */
  peek(input: TieredRenderInput, toolSurface: MemoryToolSurface): TieredRenderResult | undefined {
    return this.entries.get(this.key(input, toolSurface))?.result;
  }

  set(input: TieredRenderInput, toolSurface: MemoryToolSurface, fingerprint: string, result: TieredRenderResult): void {
    const k = this.key(input, toolSurface);
    if (!this.entries.has(k) && this.entries.size >= this.capacity) this.entries.clear();
    this.entries.set(k, { fingerprint, result });
  }

  delete(cwd: string): void {
    const prefix = `${cwd}\0`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }
}

// ───────────────────────────── file gathering ─────────────────────────────

interface FileMeta {
  name: string;
  size: number;
  mtimeMs: number;
  meta: MemoryMeta;
  description: string;
}

interface Gathered {
  displayDir: string;
  realDir: string;
  files: FileMeta[];
}

function gatherFiles(cwd: string, metaCache: MetaCache): Gathered {
  const displayDir = memoryDirFor(cwd);
  const canon = canonicalDir(displayDir);
  const realDir = canon ? canon.real : displayDir;
  const { files: entries } = listRegular(realDir, { names: "v2" });
  const files: FileMeta[] = entries.map((e) => {
    const cached = metaCache.read(realDir, e.name, e.size, e.mtimeMs);
    return { name: e.name, size: e.size, mtimeMs: e.mtimeMs, meta: cached.meta, description: cached.description };
  });
  return { displayDir, realDir, files };
}

// ───────────────────────────── template pieces ─────────────────────────────

function headerLine(slug: string, n: number): string {
  return fill(TIERED_TEMPLATES.header, { slug, n: String(n) });
}

function guideLine(access: MemoryAccess, dirDisplay: string): string {
  // §2.2's worked example shows the guide line's `{name}`/`{words}` tokens
  // appearing UNFILLED in the final text (as `<name>`/`<words>`) — they are
  // a generic "put an actual name/words here" cue for the MODEL, not values
  // this renderer knows (there is no single "the" topic name a guide line
  // refers to). Only `{dir}` gets a real substitution; `{name}`/`{words}`
  // are converted from the template's `{xxx}` notation to the doc's shown
  // `<xxx>` angle-bracket form (a notation swap, not a value fill).
  return fill(TIERED_TEMPLATES.guide[access], { dir: dirDisplay })
    .split("{name}")
    .join("<name>")
    .split("{words}")
    .join("<words>");
}

function overflowLine(n: number, archivedCount: number): string {
  const archived = archivedCount > 0 ? ` (+${archivedCount} archived)` : "";
  return fill(TIERED_TEMPLATES.overflow, { n: String(n), archived });
}

function archivedOnlyLine(n: number): string {
  return fill(TIERED_TEMPLATES.archivedOnly, { n: String(n) });
}

function alsoLine(names: string): string {
  return fill(TIERED_TEMPLATES.also, { names });
}

function frameLineFor(access: MemoryAccess, n: number, dirDisplay: string): string {
  return fill(TIERED_TEMPLATES.frameLine[access], { n: String(n), dir: dirDisplay });
}

function omittedSuffixFor(access: MemoryAccess, file: string, a: string, dirDisplay: string): string {
  return fill(TIERED_TEMPLATES.omittedSuffix[access], { file, a, dir: dirDisplay });
}

function omittedLineText(
  headings: readonly string[],
  primaryName: string,
  access: MemoryAccess,
  dirDisplay: string,
): string {
  const names = joinNamesTruncated(headings, NAME_LIST_MAX_BYTES);
  const first = headings[0] ?? "";
  const suffix = omittedSuffixFor(access, primaryName, first, dirDisplay);
  return `…(omitted sections: ${names}${suffix})`;
}

// ───────────────────────────── §2.1 whole-section admission ─────────────────────────────

interface AdmitResult {
  fits: boolean;
  text: string;
  /** Omitted section headings, in ORIGINAL file order. */
  omitted: string[];
}

/**
 * §2.1's "整节准入算法" for the primary file. `coreAvail` is the SAME budget
 * unit the whole-file check uses (i.e. it already includes room for the
 * trailing `"\n\n"` join the caller charges every core piece — reserved
 * here too so the two checks are consistent and mutually exclusive).
 */
function admitPrimarySections(
  rawBody: string,
  headPart: string,
  coreAvail: number,
  primaryName: string,
  access: MemoryAccess,
  dirDisplay: string,
): AdmitResult {
  const { preamble, sections } = splitSections(rawBody);
  const avail = coreAvail - byteLen(headPart) - 2; // reserve the trailing "\n\n"
  if (avail < 0 || byteLen(preamble) > avail) {
    return { fits: false, text: "", omitted: [] };
  }

  const admitted: MemorySection[] = [];
  let used = byteLen(preamble);
  for (const s of sections) {
    const need = used === 0 ? byteLen(s.text) : byteLen(`\n${s.text}`);
    if (used + need <= avail) {
      admitted.push(s);
      used += need;
    }
  }

  const buildBody = (adm: readonly MemorySection[]): string => {
    let body = preamble;
    for (const s of adm) body = body === "" ? s.text : `${body}\n${s.text}`;
    return body.replace(/\s+$/, "");
  };

  if (admitted.length === sections.length) {
    // Nothing skipped — only reachable if the whole-file check's slightly
    // different accounting (no `- 2` margin split the same way) missed an
    // exact-fit case; render as plain admitted content, no omitted line.
    return { fits: true, text: headPart + buildBody(admitted), omitted: [] };
  }

  const currentAdmitted = [...admitted];
  while (true) {
    const admittedSet = new Set(currentAdmitted);
    const omittedInFileOrder = sections.filter((s) => !admittedSet.has(s)).map((s) => s.heading);
    const omittedLine = omittedLineText(omittedInFileOrder, primaryName, access, dirDisplay);
    const body = buildBody(currentAdmitted);
    const candidate = headPart + body + (body === "" ? "" : "\n") + omittedLine;
    if (byteLen(candidate) <= coreAvail - 2) {
      return { fits: true, text: candidate, omitted: omittedInFileOrder };
    }
    if (currentAdmitted.length === 0) {
      return { fits: false, text: "", omitted: [] };
    }
    currentAdmitted.pop();
  }
}

// ───────────────────────────── core (primary + extra pinned) admission ─────────────────────────────

interface CoreBuild {
  pieces: string[];
  level: TieredLevel;
  demotedPrimary?: FileMeta;
  demotedPinned: FileMeta[];
  primaryOmittedSections: string[];
}

function wholePiece(realDir: string, f: FileMeta): string {
  const raw = readRegular(realDir, f.name).text;
  const fenced = frontmatterSource(raw) === "agent";
  const fenceLine = fenced ? `${TIERED_TEMPLATES.agentSourceFence}\n` : "";
  const body = stripDriftHeader(stripFrontmatter(raw)).replace(/\s+$/, "");
  return `### ${f.name}\n${fenceLine}${body}`;
}

function buildCore(
  primary: FileMeta | undefined,
  extraPinned: readonly FileMeta[],
  realDir: string,
  coreAvail: number,
  access: MemoryAccess,
  dirDisplay: string,
): CoreBuild {
  const pieces: string[] = [];
  let used = 0;
  let level: TieredLevel = 0;
  let demotedPrimary: FileMeta | undefined;
  const demotedPinned: FileMeta[] = [];
  let primaryOmittedSections: string[] = [];

  if (primary) {
    const raw = readRegular(realDir, primary.name).text;
    const fenced = frontmatterSource(raw) === "agent";
    const fenceLine = fenced ? `${TIERED_TEMPLATES.agentSourceFence}\n` : "";
    const headPart = `### ${primary.name}\n${fenceLine}`;
    const rawBody = stripDriftHeader(stripFrontmatter(raw));
    const wholeBody = rawBody.replace(/\s+$/, "");
    const wholeCandidate = headPart + wholeBody;
    const wholeCost = byteLen(wholeCandidate) + 2;
    if (wholeCost <= coreAvail) {
      pieces.push(wholeCandidate);
      used += wholeCost;
    } else {
      const admitted = admitPrimarySections(rawBody, headPart, coreAvail, primary.name, access, dirDisplay);
      if (admitted.fits) {
        pieces.push(admitted.text);
        used += byteLen(admitted.text) + 2;
        primaryOmittedSections = admitted.omitted;
        if (admitted.omitted.length > 0) level = 2;
      } else {
        demotedPrimary = primary;
        level = 4;
      }
    }
  }

  for (const p of extraPinned) {
    const candidate = wholePiece(realDir, p);
    const cost = byteLen(candidate) + 2;
    if (used + cost <= coreAvail) {
      pieces.push(candidate);
      used += cost;
    } else {
      demotedPinned.push(p);
      level = Math.max(level, 3) as TieredLevel;
    }
  }

  return {
    pieces,
    level,
    ...(demotedPrimary !== undefined ? { demotedPrimary } : {}),
    demotedPinned,
    primaryOmittedSections,
  };
}

// ───────────────────────────── index/tail ─────────────────────────────

function buildIndexLine(f: FileMeta, opts: { pinned?: boolean; overBudget?: boolean }): string {
  const desc = truncateBytes(f.description, DESCRIPTION_MAX_BYTES);
  let line = `- ${f.name}`;
  if (opts.pinned) line += " 📌";
  line += ` — ${desc}`;
  if (f.meta.readWhen !== undefined) {
    line += ` · when: ${truncateBytes(f.meta.readWhen, READ_WHEN_MAX_BYTES)}`;
  }
  line += ` · ${sizeTier(f.size)}`;
  if (f.meta.status === "stale") line += " · stale";
  if (opts.overBudget) line += " · ⚠ over core budget";
  return truncateBytes(line, INDEX_LINE_MAX_BYTES);
}

type TailKind = TieredRenderResult["tailKind"];

/** §2.3's tail suffix: `(+N more[, +M archived])` — present only when
 *  there IS an overflow count or an archived count (or both); absent
 *  otherwise. Distinct from `joinNamesTruncated`'s bare "· +N" convention
 *  (that one is for the primary's omitted-SECTIONS list, §2.1 point 3 —
 *  a different piece of text with a different frozen shape). */
function tailSuffix(overflowCount: number, archivedCount: number): string {
  const parts: string[] = [];
  if (overflowCount > 0) parts.push(`+${overflowCount} more`);
  if (archivedCount > 0) parts.push(`+${archivedCount} archived`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/**
 * §2.3 step 5's compact name list: "`- also: a.md, b.md (+N more[, +M
 * archived])`—名字按序贪心加入直到放不下，余数记 +N more". Greedily includes as
 * many WHOLE remaining names (comma-joined, in order) as fit alongside the
 * eventual `tailSuffix`; shrinks from the end (increasing the "more" count)
 * until it fits; degrades to the plain overflow line if not even one name
 * fits.
 */
function buildTail(
  remaining: readonly { name: string }[],
  archivedCount: number,
  availableForTail: number,
): {
  text: string;
  kind: TailKind;
} {
  if (remaining.length === 0 && archivedCount === 0) return { text: "", kind: "none" };
  if (remaining.length === 0) return { text: archivedOnlyLine(archivedCount), kind: "archived-only" };
  const prefixBytes = byteLen(alsoLine(""));
  for (let shown = remaining.length; shown >= 1; shown--) {
    const overflowCount = remaining.length - shown;
    const names = remaining
      .slice(0, shown)
      .map((r) => r.name)
      .join(", ");
    const suffix = tailSuffix(overflowCount, archivedCount);
    const candidate = prefixBytes + byteLen(names) + byteLen(suffix);
    if (candidate <= availableForTail) {
      return { text: alsoLine(names + suffix), kind: "compact" };
    }
  }
  return { text: overflowLine(remaining.length, archivedCount), kind: "overflow" };
}

interface Candidate {
  name: string;
  line: string;
}

function buildIndexPart(
  guide: string,
  candidates: readonly Candidate[],
  k: number,
  archivedCount: number,
  availableForIndexPart: number,
): { text: string; tailKind: TailKind } {
  const shown = candidates.slice(0, k);
  const remaining = candidates.slice(k);
  const linesText = shown.map((c) => c.line).join("\n");
  if (linesText === "" && remaining.length === 0 && archivedCount === 0) {
    return { text: "", tailKind: "none" };
  }
  const budgetForGuideAndLines = byteLen(guide) + 1 + byteLen(linesText) + (linesText ? 1 : 0);
  const availForTail = Math.max(0, availableForIndexPart - budgetForGuideAndLines);
  const tail = buildTail(remaining, archivedCount, availForTail);
  const pieces = [guide, ...(linesText ? [linesText] : []), ...(tail.text ? [tail.text] : [])];
  return { text: pieces.join("\n"), tailKind: tail.kind };
}

// ───────────────────────────── L5 (frame-only) ─────────────────────────────

function renderFrameOnly(
  header: string,
  sentinel: string,
  unreducible: string,
  n: number,
  blockBytes: number,
  access: MemoryAccess,
  dirDisplay: string,
): TieredRenderResult {
  const candidates = [frameLineFor(access, n, dirDisplay), `- … +${n} files`];
  for (const c of candidates) {
    const text = `${header}\n\n${c}\n\n${sentinel}`;
    if (byteLen(text) <= blockBytes) {
      return {
        text,
        bytes: byteLen(text),
        level: 5,
        omittedSections: [],
        demotedPinned: [],
        fullIndexLines: 0,
        tailKind: "frame-only",
      };
    }
  }
  return {
    text: unreducible,
    bytes: byteLen(unreducible),
    level: 5,
    omittedSections: [],
    demotedPinned: [],
    fullIndexLines: 0,
    tailKind: "frame-only",
  };
}

// ───────────────────────────── shared frame computation ─────────────────────────────

interface Frame {
  displayDir: string;
  realDir: string;
  files: FileMeta[];
  nonArchived: FileMeta[];
  archived: FileMeta[];
  N: number;
  L: number;
  A: number;
  H: string;
  S: string;
  G: string;
  Tmax: string;
  M: string;
  I: string;
}

function computeFrame(input: TieredRenderInput, metaCache: MetaCache): Frame {
  const slug = toSlug(input.cwd);
  const { displayDir, realDir, files } = gatherFiles(input.cwd, metaCache);
  const nonArchived = files.filter((f) => f.meta.status !== "archived");
  const archived = files.filter((f) => f.meta.status === "archived");
  const N = files.length;
  const L = nonArchived.length;
  const A = archived.length;
  const H = headerLine(slug, N);
  const S = `${injectionSentinel(slug)}\n`;
  const G = guideLine(input.access, displayDir);
  const Tmax = overflowLine(L, A);
  const M = `${H}\n\n${G}\n${Tmax}\n\n${S}`;
  const I = `${H}\n\n${S}`;
  return { displayDir, realDir, files, nonArchived, archived, N, L, A, H, S, G, Tmax, M, I };
}

// ───────────────────────────── public entry points ─────────────────────────────

export interface TieredRenderContext {
  metaCache?: MetaCache;
}

const EMPTY_RESULT: TieredRenderResult = {
  text: "",
  bytes: 0,
  level: 0,
  omittedSections: [],
  demotedPinned: [],
  fullIndexLines: 0,
  tailKind: "none",
};

/**
 * §2.2–§2.3's tiered block renderer. Deterministic given the memory dir's
 * on-disk state (I-M2) — mtime/readdir order never affect the output bytes,
 * only which files' content gets re-read (MetaCache). `context.metaCache`
 * lets a caller (inject.ts) reuse a persistent cache across renders; a bare
 * call (as every G-group unit test makes) gets a fresh one-shot cache, which
 * is still fully correct — MetaCache is a performance layer, never a
 * correctness dependency.
 */
export function renderTiered(input: TieredRenderInput, context: TieredRenderContext = {}): TieredRenderResult {
  if (input.options?.extraTopics && input.options.extraTopics.length > 0) {
    throw new Error("renderTiered: options.extraTopics is not implemented yet (todo #22 T4)");
  }
  if (input.profile === "none") return EMPTY_RESULT;

  const metaCache = context.metaCache ?? new MetaCache();
  const B = input.blockBytes;
  const C = Math.min(Math.max(0, input.coreBytes), Math.max(0, B - RESERVED_MARGIN));
  const frame = computeFrame(input, metaCache);
  // §2.2's closing note: "目录为空（可寻址文件 0 个）⇒返回 ''（与现状一致）" — same parity legacy's
  // `renderMemoryBlock` has (an empty/missing dir yields nothing to inject,
  // not a header-only frame). Checked AFTER `computeFrame` so it naturally
  // covers both a genuinely empty directory and a missing one (`gatherFiles`
  // degrades a failed readdir to `files: []`, same as listRegular always has).
  if (frame.N === 0) return EMPTY_RESULT;
  const { displayDir, realDir, nonArchived, N, L, A, H, S, G, Tmax, M, I } = frame;

  if (byteLen(M) > B) {
    return renderFrameOnly(H, S, I, N, B, input.access, displayDir);
  }

  const R = byteLen(M);
  // §2.3's `compactAll`: the compact-list line if ALL `L` non-archived files
  // had to be named (worst case) — comma-joined, no truncation, no suffix
  // (nothing is left over when everything is included).
  const compactAllLine = alsoLine(nonArchived.map((f) => f.name).join(", "));
  const idxFloor = Math.min(IDX_FLOOR_CAP, Math.max(0, byteLen(compactAllLine) - byteLen(Tmax)));
  const coreAvail = Math.max(0, Math.min(C, B - R - idxFloor));

  let primary: FileMeta | undefined = nonArchived.find((f) => f.name === "core.md");
  if (!primary) {
    primary = [...nonArchived].filter((f) => f.meta.pin).sort(byName)[0];
  }
  const extraPinned = nonArchived.filter((f) => f.meta.pin && f !== primary).sort(byName);
  const topics = nonArchived.filter((f) => f !== primary && !extraPinned.includes(f));

  const core = buildCore(primary, extraPinned, realDir, coreAvail, input.access, displayDir);
  let level: TieredLevel = core.level;

  const activeTopics = topics.filter((f) => f.meta.status === "active").sort(byName);
  const staleTopics = topics.filter((f) => f.meta.status === "stale").sort(byName);

  const candidates: Candidate[] = [];
  if (core.demotedPrimary) {
    candidates.push({
      name: core.demotedPrimary.name,
      line: buildIndexLine(core.demotedPrimary, { overBudget: true }),
    });
  }
  for (const p of core.demotedPinned) candidates.push({ name: p.name, line: buildIndexLine(p, { pinned: true }) });
  for (const t of activeTopics) candidates.push({ name: t.name, line: buildIndexLine(t, {}) });
  for (const t of staleTopics) candidates.push({ name: t.name, line: buildIndexLine(t, {}) });

  const corePart = core.pieces.length > 0 ? core.pieces.join("\n\n") : undefined;
  const prefixJoined = corePart !== undefined ? `${H}\n\n${corePart}` : H;
  const restBudget = B - byteLen(prefixJoined);
  const availableForIndexPart = restBudget - 4 - byteLen(S);

  const maxK = input.profile === "core" ? 0 : Math.min(input.indexMax, candidates.length);

  let chosenK: number | undefined;
  let chosenIndex: { text: string; tailKind: TailKind } | undefined;
  for (let k = maxK; k >= 0; k--) {
    const idx = buildIndexPart(G, candidates, k, A, availableForIndexPart);
    const full = idx.text ? `${prefixJoined}\n\n${idx.text}\n\n${S}` : `${prefixJoined}\n\n${S}`;
    if (byteLen(full) <= B) {
      chosenK = k;
      chosenIndex = idx;
      break;
    }
  }

  if (chosenK === undefined || chosenIndex === undefined) {
    return renderFrameOnly(H, S, I, N, B, input.access, displayDir);
  }

  const text = chosenIndex.text ? `${prefixJoined}\n\n${chosenIndex.text}\n\n${S}` : `${prefixJoined}\n\n${S}`;

  if (candidates.length > 0 && chosenK < candidates.length) level = Math.max(level, 1) as TieredLevel;
  if (input.profile === "core" && candidates.length > 0) level = Math.max(level, 1) as TieredLevel;
  if (A > 0) level = Math.max(level, 1) as TieredLevel;

  return {
    text,
    bytes: byteLen(text),
    level,
    omittedSections: core.primaryOmittedSections,
    demotedPinned: core.demotedPinned.map((p) => p.name),
    fullIndexLines: chosenK,
    tailKind: chosenIndex.tailKind,
  };
}

/**
 * §2.3's `minimalFrame` — shares `TIERED_TEMPLATES`/frame computation with
 * `renderTiered` (never a second copy of the format); used both internally
 * (the L5 decision) and as an independently-callable probe so property test
 * I-M1c can recompute `M` and cross-check `level === 5 ⇔ bytes(M) > B`.
 */
export function minimalFrame(input: TieredRenderInput, context: TieredRenderContext = {}): string {
  if (input.profile === "none") return "";
  const metaCache = context.metaCache ?? new MetaCache();
  const frame = computeFrame(input, metaCache);
  if (frame.N === 0) return ""; // parity with renderTiered's empty-dir short-circuit (I-M1c)
  return frame.M;
}
