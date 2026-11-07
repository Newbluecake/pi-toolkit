// #36 memory-governance arch r5 §3.3.3 — the blocks-layout render contract.
//
// Pi-free (tests/boundary/pi-free.test.ts): renders the resident section
// (`### User rules (always on)`) plus the one-line-per-topic index straight
// from BlockCorpus frontmatter — it never reads the sidecar for residency
// (only for the optional tag summary + resident sort importance), so the
// rendered bytes are identical with Jev on or off (I9; the golden proof).
//
// Resident line format (r5 裁定 8): `- [<id>] <body first line>` with the
// remaining body lines indented two spaces and the expiry note appended to
// the first line — §3.3.5's ledger protocol parses ids/renderKeys back out
// of this exact shape via `parseResidentSection`.
//
// The audience filter here is FRONTMATTER-ONLY (the Jev tag-inference tier is
// P6b's `govern/audience.ts`, injected through `audienceOf`): the rendered
// result therefore does not depend on Jev at all.

import type { ProjectCapture } from "../scoped-project-view.js";
import { createHash } from "node:crypto";
import { isExpired, isResident, type ParsedBlock } from "./format.js";
import { readCorpus, topicSummary, type BlockCorpus } from "./store.js";
import { entryHash } from "../jev/entries.js";
import { looksSecret } from "../secret-patterns.js";
import { listRegular, statRegularIfExists } from "../safe-fs.js";
import { injectionSentinel } from "../render.js";
import type { JevIndexV1 } from "../jev/contracts.js";

export const INDEX_MAX_BYTES = 2048;
export const INDEX_LINE_MAX_BYTES = 200;

export const EXPIRED_NOTE = "（已到期，待用户确认）";
const RESIDENT_HEADING = "### User rules (always on)";
const INDEX_GUIDE = "Topics (relevant blocks are injected automatically; read one with memory view <topic>):";
const RESIDENT_LINE_RE = /^- \[([a-z0-9][a-z0-9-]{0,47}\.[0-9]{3,6})\] (.*)$/;

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Same UTF-8-safe truncation as tiered.ts's exported helper, kept local so
 *  the blocks renderer does not pull the whole tiered module into its
 *  dependency closure (single-line index lines only). */
function truncateBytes(text: string, maxBytes: number): string {
  if (byteLen(text) <= maxBytes) return text;
  const budget = Math.max(0, maxBytes - byteLen("…"));
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

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}k`;
}

export interface RenderBlocksInput {
  readonly project?: ProjectCapture;
  readonly slug: string;
  readonly isChild: boolean;
  /** `memory.residentBytes` — soft budget; over-budget renders everything
   *  and appends the marker line, never truncates (arch §3.3.2). */
  readonly residentBytes: number;
  readonly today: string;
  /** Optional sidecar for the tag summary + resident sort importance. */
  readonly jevIndex?: JevIndexV1;
  /** P6b injects the tag-derived audience here; the default reads the
   *  frontmatter only. */
  readonly audienceOf?: (b: ParsedBlock) => "all" | "main" | "child";
}

export interface RenderBlocksResult {
  readonly text: string;
  /** The resident blocks that were rendered, in render order. */
  readonly resident: readonly ParsedBlock[];
  /** Σ(body + expiry note + 2B separator) over the MAIN-session resident set
   *  (audience filter disabled) — the budget verdict's口径, arch §3.3.2. */
  readonly residentBytesUsed: number;
  readonly overResidentBudget: boolean;
  /** Topics with ≥1 active visible block. */
  readonly topicCount: number;
  /** Active visible blocks. */
  readonly blockCount: number;
}

// ───────────────────────────── resident section ─────────────────────────────

function audienceMatches(b: ParsedBlock, isChild: boolean, audienceOf: RenderBlocksInput["audienceOf"]): boolean {
  const audience = audienceOf?.(b) ?? b.meta.audience ?? "all";
  return isChild ? audience !== "main" : audience !== "child";
}

/** Expiry note for the first rendered line — same text as jev/format.ts's
 *  expired marker so the U-layer annotation and the resident annotation read
 *  identically (arch §3.3.3). */
function expiryNote(b: ParsedBlock, today: string): string {
  return isExpired(b.meta, today) ? EXPIRED_NOTE : "";
}

/** The full rendered lines of one resident block (id-prefixed first line,
 *  two-space-indented continuations, note on the first line). */
export function residentLines(b: ParsedBlock, today: string): string[] {
  const bodyLines = b.body.split("\n");
  const first = (bodyLines[0] ?? "").replace(/^- /, "");
  const lines = [`- [${b.id}] ${first}${expiryNote(b, today)}`];
  for (const line of bodyLines.slice(1)) lines.push(`  ${line}`);
  return lines;
}

/** The same content without the `- [id] ` prefix / continuation indent — the
 *  `<渲染文本>` of an R-layer notice line (arch §3.3.5). */
export function residentEntryText(b: ParsedBlock, today: string): string {
  const lines = residentLines(b, today);
  const first = (lines[0] ?? "").slice(`- [${b.id}] `.length);
  return [first, ...lines.slice(1).map((line) => line.replace(/^  /, ""))].join("\n");
}

/** Soft-budget metering (arch §3.3.2): body bytes + expiry-note bytes + a
 *  2B separator per block. */
export function residentMeteredBytes(blocks: readonly ParsedBlock[], today: string): number {
  let used = 0;
  for (const b of blocks) {
    used += byteLen(b.body.replace(/^- /, "")) + byteLen(expiryNote(b, today)) + 2;
  }
  return used;
}

/** Resident selection: `isResident` ∧ audience-visible ∧ not private/secret
 *  (private/secret user rules never render into any prompt — eligibility
 *  rule 5 mirrors this so the ledger and the rendered snapshot agree), then
 *  the §3.3.2 display order: unexpired first → importance desc (sidecar,
 *  default 2) → updated desc → id asc. Order never decides admission. */
export function residentBlocksOf(
  blocks: readonly ParsedBlock[],
  opts: { isChild: boolean; today: string; jevIndex?: JevIndexV1; audienceOf?: RenderBlocksInput["audienceOf"] },
): ParsedBlock[] {
  const importanceOf = (b: ParsedBlock): number => opts.jevIndex?.entries[entryHash(b.body)]?.importance ?? 2;
  return blocks
    .filter(
      (b) =>
        isResident(b.meta) &&
        audienceMatches(b, opts.isChild, opts.audienceOf) &&
        b.meta.private !== true &&
        !looksSecret(b.body),
    )
    .sort(
      (a, b) =>
        Number(isExpired(a.meta, opts.today)) - Number(isExpired(b.meta, opts.today)) ||
        importanceOf(b) - importanceOf(a) ||
        (a.meta.updated < b.meta.updated ? 1 : a.meta.updated > b.meta.updated ? -1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
}

/** Render `### User rules (always on)` for an already-selected resident set.
 *  Empty set ⇒ "" (the whole section is omitted, arch §3.3.3). The marker
 *  line appears exactly when the MAIN-session口径 exceeds the budget. */
export function renderResidentSection(
  resident: readonly ParsedBlock[],
  opts: { today: string; residentBytes: number; mainSessionBytes: number },
): { text: string; overBudget: boolean } {
  if (resident.length === 0) return { text: "", overBudget: false };
  const lines = resident.flatMap((b) => residentLines(b, opts.today));
  const overBudget = opts.mainSessionBytes > opts.residentBytes;
  if (overBudget) {
    lines.push(
      `- resident: ${kb(opts.mainSessionBytes)}/${kb(opts.residentBytes)} over budget — consolidate (/mem review)`,
    );
  }
  return { text: [RESIDENT_HEADING, ...lines].join("\n"), overBudget };
}

/** renderKey of one resident block — identical to what `parseResidentSection`
 *  computes for the same rendered lines (sha1 over the whole entry), exposed
 *  so the onRender callback and the R layer never re-parse full texts. */
export function residentRenderKey(b: ParsedBlock, today: string): string {
  return createHash("sha1").update(residentLines(b, today).join("\n"), "utf8").digest("hex");
}

/** §3.3.5 ledger protocol input: parse `id → renderKey` out of a rendered
 *  `### User rules` section (usually the hub-persisted snapshot text).
 *  `renderKey = sha1(all rendered lines of the entry)` — body edits AND
 *  expiry-note changes both change it. */
export function parseResidentSection(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let inSection = false;
  let current: { id: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined)
      out.set(current.id, createHash("sha1").update(current.lines.join("\n"), "utf8").digest("hex"));
    current = undefined;
  };
  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (inSection) {
        flush();
        break;
      }
      inSection = line === RESIDENT_HEADING;
      continue;
    }
    if (inSection && (line.startsWith("## ") || line.startsWith("Topics ("))) {
      flush();
      break;
    }
    if (!inSection) continue;
    const m = RESIDENT_LINE_RE.exec(line);
    if (m !== null) {
      flush();
      current = { id: m[1]!, lines: [line] };
      continue;
    }
    if (current === undefined) continue;
    if (line.trim() === "") {
      flush(); // a blank line closes the entry defensively
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return out;
}

// ───────────────────────────── topic index ─────────────────────────────

interface TopicStat {
  topic: string;
  active: number;
  decisions: number;
  expired: number;
}

function visibleBlocks(corpus: BlockCorpus, input: RenderBlocksInput): readonly ParsedBlock[] {
  return corpus.blocks.filter(
    (b) =>
      b.meta.status === "active" &&
      b.meta.private !== true &&
      !looksSecret(b.body) &&
      audienceMatches(b, input.isChild, input.audienceOf),
  );
}

function tailSuffix(overflowCount: number, archivedCount: number): string {
  const parts: string[] = [];
  if (overflowCount > 0) parts.push(`+${overflowCount} more`);
  if (archivedCount > 0) parts.push(`+${archivedCount} archived`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

/** Compact tail for the over-budget index — same greedy whole-name rule as
 *  tiered's `buildTail`, over topic names instead of file names. */
function buildIndexTail(remaining: readonly string[], archivedCount: number, available: number): string {
  if (remaining.length === 0 && archivedCount === 0) return "";
  if (remaining.length === 0) return `- (+${archivedCount} archived)`;
  const prefixBytes = byteLen("- also: ");
  for (let shown = remaining.length; shown >= 1; shown--) {
    const names = remaining.slice(0, shown).join(", ");
    const suffix = tailSuffix(remaining.length - shown, archivedCount);
    if (prefixBytes + byteLen(names) + byteLen(suffix) <= available) return `- also: ${names}${suffix}`;
  }
  return `- … +${remaining.length} more${archivedCount > 0 ? ` (+${archivedCount} archived)` : ""}`;
}

function renderIndexPart(
  corpus: BlockCorpus,
  visible: readonly ParsedBlock[],
  archivedCount: number,
  input: RenderBlocksInput,
): { text: string; topicCount: number } {
  const stats = new Map<string, TopicStat>();
  for (const b of visible) {
    let stat = stats.get(b.topic);
    if (stat === undefined) {
      stat = { topic: b.topic, active: 0, decisions: 0, expired: 0 };
      stats.set(b.topic, stat);
    }
    stat.active += 1;
    if (b.meta.authority === "user" && (b.meta.scope ?? "topic") === "topic") stat.decisions += 1;
    if (isExpired(b.meta, input.today)) stat.expired += 1;
  }
  const ordered = [...stats.values()].sort(
    (a, b) => b.active - a.active || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0),
  );
  const lines = ordered.map((stat) => {
    // #36 P3 acceptance fix: the summary sees ONLY the visible set — a
    // main-only/private block's tags/sections must not leak into child or
    // external renders (store.topicSummary filters by topic+active only, so
    // the corpus is pre-filtered here instead of touching P1).
    const summary = topicSummary(
      { ...corpus, blocks: visible, archivedByTopic: new Map() },
      input.jevIndex,
      stat.topic,
    );
    let line = `- ${stat.topic}`;
    if (summary !== "") line += ` — ${summary}`;
    line += ` · ${stat.active} blocks`;
    if (stat.decisions > 0) line += ` · ${stat.decisions} decisions`;
    if (stat.expired > 0) line += ` · ${stat.expired} expired`;
    return truncateBytes(line, INDEX_LINE_MAX_BYTES);
  });
  // INDEX_MAX_BYTES caps the whole index part (guide + lines + tail).
  const guideBytes = byteLen(INDEX_GUIDE);
  const usedBy: string[] = [];
  let used = guideBytes + 1; // guide + the blank line after it
  let kept = 0;
  for (; kept < lines.length; kept++) {
    const cost = byteLen(lines[kept]!) + (kept > 0 ? 1 : 0);
    if (used + cost > INDEX_MAX_BYTES) break;
    used += cost;
    usedBy.push(lines[kept]!);
  }
  const tail = buildIndexTail(
    ordered.slice(kept).map((s) => s.topic),
    archivedCount,
    Math.max(0, INDEX_MAX_BYTES - used - 1),
  );
  const pieces = [INDEX_GUIDE, ...usedBy, ...(tail === "" ? [] : [tail])];
  return { text: pieces.join("\n"), topicCount: ordered.length };
}

// ───────────────────────────── top-level render ─────────────────────────────

export function renderBlocks(corpus: BlockCorpus, input: RenderBlocksInput): RenderBlocksResult {
  const visible = visibleBlocks(corpus, input);
  if (visible.length === 0 && corpus.archivedByTopic.size === 0) {
    return { text: "", resident: [], residentBytesUsed: 0, overResidentBudget: false, topicCount: 0, blockCount: 0 };
  }
  // Budget verdict on the MAIN-session resident set (arch §3.3.2), even when
  // rendering for a child session.
  const mainResident = residentBlocksOf(corpus.blocks, {
    isChild: false,
    today: input.today,
    ...(input.jevIndex === undefined ? {} : { jevIndex: input.jevIndex }),
    ...(input.audienceOf === undefined ? {} : { audienceOf: input.audienceOf }),
  });
  const resident = input.isChild
    ? mainResident.filter((b) => audienceMatches(b, true, input.audienceOf))
    : mainResident;
  const mainSessionBytes =
    residentMeteredBytes(mainResident, input.today) +
    (input.project === undefined ? 0 : mainResident.length * input.project.entryReserve);
  const residentSection = renderResidentSection(resident, {
    today: input.today,
    residentBytes: input.residentBytes,
    mainSessionBytes,
  });
  for (const b of resident) input.project?.block(b, residentLines(b, input.today).join("\n"));
  const archivedCount = [...corpus.archivedByTopic.values()].reduce((sum, n) => sum + n, 0);
  const index = renderIndexPart(corpus, visible, archivedCount, input);
  const pieces: string[] = [];
  if (residentSection.text !== "") pieces.push(residentSection.text);
  if (index.text !== "") pieces.push(index.text);
  const header = `## Memory (${input.slug}) — ${index.topicCount} topic(s) · ${visible.length} block(s)`;
  const text = `${header}\n\n${pieces.join("\n\n")}\n\n${injectionSentinel(input.slug)}`;
  return {
    text,
    resident,
    residentBytesUsed: mainSessionBytes,
    overResidentBudget: residentSection.overBudget,
    topicCount: index.topicCount,
    blockCount: visible.length,
  };
}

/** Convenience for callers that only have the directory: one `readCorpus`
 * round (the no-lock reader lives in store.ts). */
export function renderBlocksDir(realDir: string, input: RenderBlocksInput): RenderBlocksResult {
  return renderBlocks(readCorpus(realDir), input);
}

/** #36 P3 acceptance fix (arch §3.3.5 重算判定): the cheap change probe —
 *  sha1 over every `blocks/*.md`'s (name, size, mtimeMs, ino), STAT ONLY,
 *  never reading bodies. Callers gate their full `readCorpus` on this:
 *  unchanged corpus ⇒ zero body reads; foreign writes flip mtimeMs/ino ⇒
 *  one re-read. Sorting mirrors readCorpus's stamp list so both agree on
 *  what "unchanged" means. */
export function corpusStampFingerprint(realDir: string): string {
  const { files } = listRegular(realDir, { names: "legacy" });
  const stamps = files
    .map((f) => {
      const stat = statRegularIfExists(realDir, f.name);
      return [f.name, f.size, f.mtimeMs, stat?.ino ?? 0] as const;
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha1").update(JSON.stringify(stamps), "utf8").digest("hex");
}
