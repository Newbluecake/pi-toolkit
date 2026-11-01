// Entry-level edit primitives for `/mem review` and `/mem expired`
// (jev-plan §4 J8; jev-arch §6.3.4 execution / §6.3.5 到期).
//
// Both operations re-split the LIVE file inside the directory lock and
// locate the target entry by content hash (`EntryHash` — stable across
// inline-comment edits, same key the sidecar index and review state use),
// not by line number or the stricter guard hash: a suggestion/expiry can be
// acted on hours after it was computed, and the only thing that should make
// it "stale" is the entry's CONTENT having actually changed or disappeared
// (§6.3.4's "过期建议" rule), not an unrelated inline-comment touch-up.
//
// `deleteEntry` backs the original file up whole into `.trash/<id>-<name>`
// BEFORE rewriting it (same `.trash` directory `/mem restore --trash`
// already reads — `tool-v2.ts`'s whole-file delete uses an identical id
// shape; this module duplicates the tiny id/prune helpers rather than
// importing them, since tool-v2.ts exports neither). jev-plan §4 J8 risk
// item (default applied, reported to root): deleting an entry that is the
// ONLY entry under its `## ` heading also removes the heading line — never
// leaving an orphan heading with nothing under it — while an entry with
// live siblings in the same section only loses its own lines. (`heading`
// on `MemEntry` mirrors the active `## `/`### ` label and is NOT a useful
// signal here — it equals the plain `## ` title even with no `### ` open —
// so the test is section-membership count, not the `heading`/`ordinal`
// fields.) Edge case accepted as-is (verdict nit): when a section's ONLY
// entry normalizes to nothing visible on its own (e.g. a comment-only
// block) and the file's body-splitting then folds the remainder into the
// PREVIOUS section, deleting it still removes the right heading — no data
// loss, and the pre-edit file is always recoverable from `.trash`.
//
// No direct `node:fs` import (tests/memory/fs-guard.test.ts): every touch
// goes through `../safe-fs.js`. Pi-free root; no module-scope state (I4).

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { newTidyId } from "../tidy/manifest.js";
import { frontmatterSource } from "../frontmatter.js";
import { MemoryError } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import {
  ensurePrivateDir,
  listRegular,
  readRegular,
  replaceAtomic,
  statRegularIfExists,
  unlinkRegular,
  writeTempRegular,
} from "../safe-fs.js";
import { splitEntries } from "./entries.js";
import type { InlineMeta, MemEntry } from "./contracts.js";

export type EntryEditResult = "ok" | "stale" | "busy";

const TRASH_DIR_NAME = ".trash";
const TRASH_KEEP = 20;

/** `.trash` id in the exact shape `safe-fs` TRASH_NAME_RE and
 *  `tidy/manifest` listTrashEntries accept (ms-precision stamp + 6 hex) —
 *  the previous local stamp dropped the milliseconds and used base36, so
 *  `/mem restore --trash` never listed tool/review deletions. */
function trashId(): string {
  return newTidyId(new Date(), process.pid, randomBytes(3).toString("hex"));
}

function isLockBusy(err: unknown): boolean {
  return err instanceof MemoryError && err.message.includes("memory dir busy");
}

function fileInfoFor(raw: string): { status: "active" | "stale"; handWritten: boolean } {
  return { status: "active", handWritten: frontmatterSource(raw) !== "agent" };
}

/** Content-hash match, position-insensitive (see module doc). */
function locateEntry(entries: readonly MemEntry[], target: MemEntry): MemEntry | undefined {
  return entries.find((e) => e.hash === target.hash && e.file === target.file && e.section === target.section);
}

/** jev-plan §4 J8 risk item default: an entry is the sole content under its
 *  `## ` heading — whether because it IS the rule-4 "whole section, no
 *  list" case, or because it happens to be the only list item/block the
 *  region ever had — and removing the heading alongside it never leaves an
 *  orphan. Any OTHER sibling entry sharing the section means some other
 *  content still needs that heading, so only the entry's own lines go. */
function isWholeSectionEntry(entries: readonly MemEntry[], target: MemEntry): boolean {
  if (target.section === "") return false; // file head has no `## ` line to remove
  return entries.filter((e) => e.section === target.section).length === 1;
}

function pruneTrash(dir: string): void {
  let names: readonly string[];
  try {
    names = listRegular(join(dir, TRASH_DIR_NAME), { names: "legacy" }).files.map((f) => f.name);
  } catch {
    return; // best effort — missing .trash is not an error
  }
  const sorted = [...names].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest id first (ids sort lexically by time)
  for (const name of sorted.slice(TRASH_KEEP)) {
    try {
      unlinkRegular(join(dir, TRASH_DIR_NAME), name);
    } catch {
      // best effort; a failed prune never blocks the edit itself
    }
  }
}

function backupWholeFile(dir: string, name: string, raw: string): void {
  ensurePrivateDir(join(dir, TRASH_DIR_NAME));
  const id = trashId();
  const trashName = `${id}-${name}`;
  const tmp = writeTempRegular(join(dir, TRASH_DIR_NAME), trashName, Buffer.from(raw, "utf8"), 0o600);
  replaceAtomic(join(dir, TRASH_DIR_NAME), tmp, trashName);
  pruneTrash(dir);
}

function commitFile(dir: string, name: string, text: string): void {
  const stat = statRegularIfExists(dir, name);
  const tmp = writeTempRegular(dir, name, Buffer.from(text, "utf8"), stat?.mode ?? 0o600);
  replaceAtomic(dir, tmp, name);
}

/** Split `raw` into lines, reporting whether it ended with a trailing
 *  newline, so callers can reconstruct the same convention on write. */
function splitLines(raw: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Delete one entry from `dir/entry.file` — a `/mem review`/`/mem expired`
 * "delete" action (jev-arch §6.3.4/§6.3.5). Re-locates the entry by content
 * hash inside the lock; "stale" when it's gone (deleted/edited since it was
 * read), "busy" when the directory lock can't be acquired. The pre-edit
 * file is always backed up whole into `.trash` first, recoverable with
 * `/mem restore --trash <id>`.
 */
export async function deleteEntry(dir: string, entry: MemEntry): Promise<EntryEditResult> {
  try {
    return await withMemoryDirLock(dir, () => {
      const current = readRegular(dir, entry.file);
      const freshEntries = splitEntries(entry.file, current.text, fileInfoFor(current.text));
      const match = locateEntry(freshEntries, entry);
      if (match === undefined) return "stale" as const;

      const { lines, trailingNewline } = splitLines(current.text);
      let startIdx = match.lineStart - 1;
      const endIdx = match.lineEnd - 1;
      if (isWholeSectionEntry(freshEntries, match)) {
        for (let i = startIdx - 1; i >= 0; i--) {
          const line = lines[i] ?? "";
          if (/^##\s/.test(line)) {
            startIdx = i;
            break;
          }
          if (line.trim() !== "") break; // only blank separator lines allowed
        }
      }
      const kept = [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
      backupWholeFile(dir, entry.file, current.text);
      commitFile(dir, entry.file, joinLines(kept, trailingNewline));
      return "ok" as const;
    });
  } catch (err) {
    if (isLockBusy(err)) return "busy";
    throw err;
  }
}

/** `null` clears the field; `undefined` (the key simply absent) leaves it
 *  untouched — the three fields `/mem expired`/`/mem review` ever write. */
export interface InlineMetaPatch {
  readonly expires?: string | null;
  readonly until?: string | null;
  readonly authority?: "user" | "lesson" | null;
}

function applyPatch(meta: InlineMeta, patch: InlineMetaPatch): InlineMeta {
  const out: { -readonly [K in keyof InlineMeta]?: InlineMeta[K] } = { ...meta, present: true };
  if (patch.expires !== undefined) {
    if (patch.expires === null) delete out.expires;
    else out.expires = patch.expires;
  }
  if (patch.until !== undefined) {
    if (patch.until === null) delete out.until;
    else out.until = patch.until;
  }
  if (patch.authority !== undefined) {
    if (patch.authority === null) delete out.authority;
    else out.authority = patch.authority;
  }
  return out as InlineMeta;
}

/** Re-render the `<!-- mem … -->` comment from a (possibly patched)
 *  `InlineMeta` — every other key (gate/tags/private) rides through
 *  unchanged. Empty meta ⇒ "" (no comment at all). */
function serializeInlineMeta(meta: InlineMeta): string {
  const parts: string[] = [];
  if (meta.authority !== undefined) parts.push(meta.authority);
  if (meta.expires !== undefined) parts.push(`expires=${meta.expires}`);
  if (meta.until !== undefined) parts.push(`until="${meta.until}"`);
  if (meta.gate === "hold") parts.push("gate=hold");
  else if (meta.gate === "gate") parts.push("gate");
  else if (meta.gate === "nogate") parts.push("nogate");
  const tagItems = [...(meta.tagsAdd ?? []).map((t) => `+${t}`), ...(meta.tagsRemove ?? []).map((t) => `-${t}`)];
  if (tagItems.length > 0) parts.push(`tags=${tagItems.join(",")}`);
  if (meta.isPrivate === true) parts.push("private");
  return parts.length === 0 ? "" : `<!-- mem ${parts.join(" ")} -->`;
}

const INLINE_COMMENT_RE = /<!--[ \t]*mem\b[^\n]*?-->/;

/**
 * Patch the inline authority comment on one entry's first non-empty line
 * (jev-arch §4.2) — `/mem expired`'s "extend 30 days" / "clear" / "make
 * permanent" and `/mem review`'s "mark as user order" all go through this.
 * Same CAS/locking/stale contract as `deleteEntry`.
 */
export async function setInlineMeta(dir: string, entry: MemEntry, patch: InlineMetaPatch): Promise<EntryEditResult> {
  try {
    return await withMemoryDirLock(dir, () => {
      const current = readRegular(dir, entry.file);
      const freshEntries = splitEntries(entry.file, current.text, fileInfoFor(current.text));
      const match = locateEntry(freshEntries, entry);
      if (match === undefined) return "stale" as const;

      const { lines, trailingNewline } = splitLines(current.text);
      let targetIdx = -1;
      for (let i = match.lineStart - 1; i <= match.lineEnd - 1; i++) {
        if ((lines[i] ?? "").trim() !== "") {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx === -1) return "stale" as const;

      const next = applyPatch(match.inline, patch);
      const comment = serializeInlineMeta(next);
      const original = lines[targetIdx] ?? "";
      const stripped = original.replace(INLINE_COMMENT_RE, "").replace(/[ \t]+$/, "");
      lines[targetIdx] = comment === "" ? stripped : stripped === "" ? comment : `${stripped} ${comment}`;

      commitFile(dir, entry.file, joinLines(lines, trailingNewline));
      return "ok" as const;
    });
  } catch (err) {
    if (isLockBusy(err)) return "busy";
    throw err;
  }
}
