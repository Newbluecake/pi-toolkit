// §7.3 step 5 tidy proposal validation — todo #22 P4. Pure function: given
// the model's `TidyProposal` and the pre-dispatch snapshot, decides whether
// the WHOLE proposal is admissible (schema-shape / output-byte cap) and
// flags each per-file entry for the UI's default decision (hand-written ⇒
// suggestion-only, unaccounted content ⇒ default Skip, over budget ⇒ no
// Apply).

import { isV2Name } from "../safe-fs.js";
import {
  isMetaLengthOverage,
  MAX_DESCRIPTION_BYTES,
  MAX_READ_WHEN_BYTES,
  parseMemoryMeta,
  truncateMetaField,
} from "../meta.js";
import { stripFrontmatter, upsertFrontmatterFields } from "../frontmatter.js";
import { TIDY_MAX_FILES } from "../contracts.js";
import type { TidyProposal, TidyProposalFile } from "../contracts.js";
import type { TidySnapshotFile } from "./snapshot.js";

export interface TidyValidationIssue {
  file?: string;
  message: string;
}

export interface TidyFileFlag {
  /** Lines from the original file that were neither reproduced in an output
   *  file nor accounted for in `dropped[]` (0 = fully accounted). Only set
   *  for files whose action is rewrite/delete/rename. */
  unaccountedLines: number;
  /** false ⇒ the UI must not offer "Apply" for this file (hand-written
   *  source, over a hard byte cap, or invalid frontmatter) — view/edit-only. */
  canApply: boolean;
  /** Short annotation for the per-file confirm title, e.g. "hand-written —
   *  suggestion only; Take over & apply to rewrite", "3 lines unaccounted",
   *  "412B over the 1600B core cap", "description truncated to 300B"
   *  (2026-10-16). */
  note?: string;
  /** 2026-10-16: proposed content whose ONLY frontmatter problem was an
   *  over-limit description/read_when, with those fields truncated at a
   *  UTF-8 code-point boundary. Callers MUST use this instead of the
   *  proposal's raw `content` for diff/preview and apply — the size and
   * conservation checks below already ran against it. */
  normalizedContent?: string;
}

export interface TidyValidationResult {
  ok: boolean;
  issues: readonly TidyValidationIssue[];
  fileFlags: ReadonlyMap<string, TidyFileFlag>;
}

export interface TidyValidateContext {
  /** name -> pre-dispatch snapshot entry (only files that were part of the
   *  request; a proposal "create" won't have an entry here). */
  original: ReadonlyMap<string, TidySnapshotFile>;
  coreBytes: number;
  topicMaxBytes: number;
  maxOutputBytes: number;
  /** Names currently present on disk; used to reject rename/create collisions. */
  existingNames?: ReadonlySet<string>;
  /** 2026-10-21 user ruling: explicit per-file takeover grants. A
   *  hand-written file named here is NOT forced to `canApply:false` — the
   *  user picked "Take over & apply" in the confirm loop and the write
   *  stamps `source: agent`. The hand-written guard itself stays in place
   *  for every file NOT in this set; nothing else relaxes it. */
  takeover?: ReadonlySet<string>;
}

export const SCHEMA_LIMITS = {
  maxFiles: TIDY_MAX_FILES,
  maxDropped: 200,
  nameMax: 128,
  reasonMax: 200,
  contentMax: 65_536,
  notesMax: 1000,
  movedFromMax: 8,
} as const;

function byteLen(s: string | undefined): number {
  return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}

/** §7.2's output-byte cap: sum of UTF-8 bytes of every string field. */
export function computeOutputBytes(proposal: TidyProposal): number {
  let total = 0;
  for (const f of proposal.files) {
    total += byteLen(f.name) + byteLen(f.newName) + byteLen(f.content) + byteLen(f.reason);
    for (const m of f.movedFrom ?? []) total += byteLen(m);
  }
  for (const d of proposal.dropped) {
    total += byteLen(d.from) + byteLen(d.text) + byteLen(d.reason);
  }
  total += byteLen(proposal.notes);
  return total;
}

/** Normalize a line for the content-conservation check: trim, collapse
 *  internal whitespace, drop a leading markdown heading marker (`#`+) so a
 *  re-leveled heading still counts as "the same line"; empty/heading-only
 *  lines are never required to be accounted for by the caller. */
function normalizeLine(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isAccountableLine(raw: string): boolean {
  const t = raw.trim();
  if (t === "") return false;
  if (/^#{1,6}\s*/.test(t) && normalizeLine(t) === "") return false; // bare heading marker only
  return true;
}

/** §7.3 step 5's content-conservation check for ONE original file: every
 *  accountable line must appear (normalized) in some output file's content,
 *  or be covered by a `dropped[]` entry whose `from` matches this file. */
function countUnaccountedLines(
  originalBody: string,
  allOutputContent: readonly string[],
  droppedTextForFile: readonly string[],
): number {
  const outputNormalized = new Set<string>();
  for (const content of allOutputContent) {
    for (const line of content.split("\n")) {
      const n = normalizeLine(line);
      if (n !== "") outputNormalized.add(n);
    }
  }
  const droppedBlob = droppedTextForFile.map(normalizeLine).join(" \n ");
  let unaccounted = 0;
  for (const rawLine of originalBody.split("\n")) {
    if (!isAccountableLine(rawLine)) continue;
    const n = normalizeLine(rawLine);
    if (n === "") continue;
    if (outputNormalized.has(n)) continue;
    if (droppedBlob.includes(n)) continue;
    unaccounted++;
  }
  return unaccounted;
}

function effectiveName(f: TidyProposalFile): string {
  return f.action === "rename" && f.newName ? f.newName : f.name;
}

interface FrontmatterNormalize {
  content: string;
  notes: string[];
}

/** 2026-10-16 user ruling: a proposed file whose ONLY frontmatter problem is
 *  description/read_when over its byte limit is NOT rejected — the offending
 *  field is truncated to the limit (meta.ts's constants) at a UTF-8
 *  code-point boundary, "…" appended when it still fits. Returns undefined
 *  when nothing needed truncating, or when the re-parsed result still isn't
 *  clean (then the original error keeps blocking, unchanged). */
function normalizeFrontmatterOverage(content: string, fallbackTopic: string): FrontmatterNormalize | undefined {
  const first = parseMemoryMeta(content, fallbackTopic);
  if (first.errors.length === 0 || !first.errors.every(isMetaLengthOverage)) return undefined;
  const fields: Record<string, string> = {};
  const notes: string[] = [];
  if (first.errors.some((m) => m.startsWith("description")) && first.meta.description !== undefined) {
    fields.description = truncateMetaField(first.meta.description, MAX_DESCRIPTION_BYTES);
    notes.push(`description truncated to ${String(MAX_DESCRIPTION_BYTES)}B`);
  }
  if (first.errors.some((m) => m.startsWith("read_when")) && first.meta.readWhen !== undefined) {
    fields.read_when = truncateMetaField(first.meta.readWhen, MAX_READ_WHEN_BYTES);
    notes.push(`read_when truncated to ${String(MAX_READ_WHEN_BYTES)}B`);
  }
  const normalized = upsertFrontmatterFields(content, fields);
  if (parseMemoryMeta(normalized, fallbackTopic).errors.length > 0) return undefined;
  return { content: normalized, notes };
}

export function validateTidyProposal(proposal: TidyProposal, ctx: TidyValidateContext): TidyValidationResult {
  const issues: TidyValidationIssue[] = [];

  if (proposal.files.length > SCHEMA_LIMITS.maxFiles) {
    issues.push({
      message: `proposal has ${String(proposal.files.length)} files, over the ${String(SCHEMA_LIMITS.maxFiles)} cap`,
    });
  }
  if (proposal.dropped.length > SCHEMA_LIMITS.maxDropped) {
    issues.push({
      message: `proposal has ${String(proposal.dropped.length)} dropped entries, over the ${String(SCHEMA_LIMITS.maxDropped)} cap`,
    });
  }

  const outputBytes = computeOutputBytes(proposal);
  if (outputBytes > ctx.maxOutputBytes) {
    issues.push({
      message: `tidy output ${String(Math.ceil(outputBytes / 1024))}kB over cap ${String(Math.ceil(ctx.maxOutputBytes / 1024))}kB — narrow the file set`,
    });
  }

  const seenNames = new Set<string>();
  const newNames = new Map<string, string>(); // effective name -> source name, dup detection
  for (const f of proposal.files) {
    if (byteLen(f.name) > SCHEMA_LIMITS.nameMax)
      issues.push({ file: f.name, message: "name exceeds schema length cap" });
    if (byteLen(f.reason) > SCHEMA_LIMITS.reasonMax)
      issues.push({ file: f.name, message: "reason exceeds schema length cap" });
    if (byteLen(f.content) > SCHEMA_LIMITS.contentMax)
      issues.push({ file: f.name, message: "content exceeds schema length cap" });
    if ((f.movedFrom?.length ?? 0) > SCHEMA_LIMITS.movedFromMax)
      issues.push({ file: f.name, message: "movedFrom exceeds schema length cap" });
    if (seenNames.has(f.name)) issues.push({ file: f.name, message: `duplicate file entry ${f.name}` });
    seenNames.add(f.name);

    if (!isV2Name(f.name)) {
      issues.push({
        file: f.name,
        message: `invalid file name ${JSON.stringify(f.name)} — *.md only, no path separators`,
      });
    }
    if (f.action === "rewrite" || f.action === "create") {
      if (f.content === undefined) issues.push({ file: f.name, message: `${f.action} requires content` });
    }
    if (f.action === "rename") {
      if (!f.newName) issues.push({ file: f.name, message: "rename requires newName" });
      else if (!isV2Name(f.newName))
        issues.push({ file: f.name, message: `invalid newName ${JSON.stringify(f.newName)}` });
      else if (ctx.existingNames?.has(f.newName) && f.newName !== f.name)
        issues.push({ file: f.name, message: `rename target ${f.newName} already exists` });
    }
    if (f.action === "create" && (ctx.original.has(f.name) || ctx.existingNames?.has(f.name))) {
      issues.push({ file: f.name, message: `create target ${f.name} already exists` });
    }
    if ((f.action === "rewrite" || f.action === "rename") && !ctx.original.has(f.name)) {
      issues.push({ file: f.name, message: `${f.action} target ${f.name} was not in the snapshot` });
    }

    const eff = effectiveName(f);
    const existingSrc = newNames.get(eff);
    if (existingSrc !== undefined && existingSrc !== f.name) {
      issues.push({ file: f.name, message: `${eff} would be produced by both ${existingSrc} and ${f.name}` });
    }
    newNames.set(eff, f.name);
  }

  const allOutputContent: string[] = [];
  // 2026-10-16: frontmatter length-overage normalize pass — every content
  // check below (frontmatter validity, byte caps, content conservation) and,
  // via fileFlags[].normalizedContent, the caller's diff/apply path see the
  // TRUNCATED content, never the over-limit original.
  const normalized = new Map<string, FrontmatterNormalize>();
  for (const f of proposal.files) {
    if (f.content === undefined) continue;
    const n = normalizeFrontmatterOverage(f.content, effectiveName(f).replace(/\.md$/, ""));
    if (n) normalized.set(f.name, n);
  }
  const contentOf = (f: TidyProposalFile): string | undefined => normalized.get(f.name)?.content ?? f.content;
  for (const f of proposal.files) {
    const c = contentOf(f);
    if (c !== undefined) allOutputContent.push(c);
  }
  // §2.1: `core.md` wins primary-core outright. When the proposal itself
  // produces a core.md (the migration-mode case), a pinned legacy primary
  // (e.g. `pitfalls.md` with `pin: true`) stops being primary after apply and
  // must be judged against the topic cap, not the core cap — otherwise every
  // migration proposal for it is un-applyable by construction.
  const proposalProducesCore = proposal.files.some((f) => f.action !== "delete" && effectiveName(f) === "core.md");

  const fileFlags = new Map<string, TidyFileFlag>();
  for (const f of proposal.files) {
    if (f.action === "keep") continue;
    const orig = ctx.original.get(f.name);
    const notes: string[] = [];
    let canApply = true;
    let unaccountedLines = 0;

    if (orig?.handWritten === true) {
      if (ctx.takeover?.has(f.name) === true) {
        // Explicit per-file takeover (see TidyValidateContext.takeover):
        // Apply becomes reachable; the apply path stamps source: agent.
        notes.push("hand-written — takeover granted (becomes source: agent)");
      } else {
        canApply = false;
        notes.push("hand-written — suggestion only; Take over & apply to rewrite");
      }
    }

    if (f.content !== undefined) {
      // inside this guard f.content is a string, so the ?? always lands on it
      const effContent = normalized.get(f.name)?.content ?? f.content;
      const norm = normalized.get(f.name);
      const { errors } = parseMemoryMeta(effContent, effectiveName(f).replace(/\.md$/, ""));
      if (errors.length > 0) {
        canApply = false;
        notes.push(`invalid frontmatter: ${errors[0] ?? ""}`);
      }
      if (norm) notes.push(...norm.notes);
      const eff = effectiveName(f);
      const isCore = eff === "core.md" || (orig?.isPrimaryCore === true && !proposalProducesCore);
      const cap = isCore ? ctx.coreBytes : ctx.topicMaxBytes;
      const size = Buffer.byteLength(effContent, "utf8");
      if (size > cap) {
        canApply = false;
        notes.push(`${String(size - cap)}B over the ${String(cap)}B ${isCore ? "core" : "topic"} cap`);
      }
    }

    if ((f.action === "rewrite" || f.action === "delete" || f.action === "rename") && orig !== undefined) {
      const droppedTextForFile = proposal.dropped.filter((d) => d.from === f.name).map((d) => d.text);
      unaccountedLines = countUnaccountedLines(stripFrontmatter(orig.body), allOutputContent, droppedTextForFile);
      if (unaccountedLines > 0) {
        // 2026-10-21 ruling: this warning is the ONLY signal for the risk —
        // the menu order is now fixed (Apply always first), so the note must
        // say plainly what to do.
        notes.push(`\u26a0 ${String(unaccountedLines)} lines unaccounted — check View diff before Apply`);
      }
    }

    const normEntry = normalized.get(f.name);
    fileFlags.set(f.name, {
      unaccountedLines,
      canApply,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      ...(normEntry ? { normalizedContent: normEntry.content } : {}),
    });
  }

  return { ok: issues.length === 0 && outputBytes <= ctx.maxOutputBytes, issues, fileFlags };
}
