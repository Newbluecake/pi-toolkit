/**
 * #39 P1 session-memory fold: reconstruct the current session-scope state from a real
 * `getBranch()` entry array (arch §6.2「折叠」).
 *
 * Semantics pinned here:
 * - The base is the MOST RECENT wholly-valid snap; a snap failing ANY check (one bad item,
 *   duplicate ids, count/body/DTO overflow) is rejected whole — never partially adopted —
 *   and the search continues further back.
 * - Valid put/del entries after the base apply in order; entries that fail validation are
 *   recorded in `dropped` (≤16, most recent kept) and otherwise ignored.
 * - Inheritance marking: items written by a sid ≠ the current session are fork-inherited;
 *   items living in a seed snap (`inherit`) are spawn-inherited. `currentSid === undefined`
 *   (no session / read-only host) marks EVERYTHING inherited — writes are the store's call.
 * - Non-memory branch entries (messages, compaction markers, fork bookkeeping, anything with
 *   another customType) are ignored — branch-locality comes from reading `getBranch()` only.
 *
 * Pi-free, pure, no I/O. The caller supplies the branch array; this function never touches
 * a session manager.
 */
import type { FoldedSessionItem, FoldedSessionMemory, MemoryInheritance, SessionMemoryEntryV1 } from "./types.js";
import { SESSION_MEMORY_ENTRY_TYPE } from "./types.js";
import { sessionItemRevision, validateSessionEntry } from "./limits.js";

const DROPPED_MAX = 16;

export const EMPTY_FOLD: FoldedSessionMemory = Object.freeze({
  items: Object.freeze([]),
  nextN: 1,
  opsSinceSnap: 0,
  dropped: Object.freeze([]),
});

interface RawBranchEntry {
  readonly type?: unknown;
  readonly customType?: unknown;
  readonly data?: unknown;
  readonly id?: unknown;
}

function isMemoryEntry(entry: unknown): entry is RawBranchEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as RawBranchEntry;
  return candidate.type === "custom" && candidate.customType === SESSION_MEMORY_ENTRY_TYPE;
}

const entryIdOf = (entry: RawBranchEntry, index: number): string =>
  typeof entry.id === "string" && entry.id.length > 0 ? entry.id : `#${index}`;

const dropReasonText = (reason: string): string => `invalid-entry:${reason}`;

/**
 * Fold a branch. `branch` is the raw `getBranch()` array (unknown entries tolerated);
 * `currentSid` is the current session id, or undefined when there is no session identity.
 */
export function foldSessionMemory(branch: readonly unknown[], currentSid: string | undefined): FoldedSessionMemory {
  // Indices (into the memory-entry subsequence) of parsed entries + validity.
  const memory: {
    entry: RawBranchEntry;
    parsed: { ok: true; entry: SessionMemoryEntryV1 } | { ok: false; reason: string };
    entryId: string;
  }[] = [];
  for (const raw of branch) {
    if (!isMemoryEntry(raw)) continue;
    const parsed = validateSessionEntry(raw.data, { mode: "fold" });
    memory.push({ entry: raw, parsed, entryId: entryIdOf(raw, memory.length) });
  }

  // Base: the latest wholly-valid snap.
  let baseIndex = -1;
  for (let i = memory.length - 1; i >= 0; i--) {
    const candidate = memory[i];
    if (candidate !== undefined && candidate.parsed.ok && candidate.parsed.entry.op === "snap") {
      baseIndex = i;
      break;
    }
  }

  // Apply the base snap (if any), then forward-apply valid put/del entries.
  const items = new Map<string, { item: FoldedSessionItem["item"]; writerSid: string; spawn?: MemoryInheritance }>();
  const order: string[] = [];
  let nextN = 1;
  let opsSinceSnap = 0;
  if (baseIndex >= 0) {
    const baseRecord = memory[baseIndex];
    const base = (baseRecord === undefined ? undefined : baseRecord.parsed) as
      { ok: true; entry: Extract<SessionMemoryEntryV1, { op: "snap" }> } | undefined;
    if (base === undefined) return EMPTY_FOLD; // unreachable: baseIndex points at a parsed snap
    nextN = Math.max(1, base.entry.nextN);
    const spawn = base.entry.inherit;
    for (const item of base.entry.items) {
      items.set(item.id, { item, writerSid: base.entry.sid, ...(spawn !== undefined ? { spawn } : {}) });
      order.push(item.id);
      nextN = Math.max(nextN, idNumber(item.id) + 1);
    }
  }
  const dropped: { entryId: string; reason: string }[] = [];
  const noteDropped = (entryId: string, reason: string): void => {
    dropped.push({ entryId, reason: dropReasonText(reason) });
    if (dropped.length > DROPPED_MAX) dropped.shift();
  };
  for (let i = baseIndex + 1; i < memory.length; i++) {
    const record = memory[i];
    if (record === undefined) continue;
    if (!record.parsed.ok) {
      noteDropped(record.entryId, record.parsed.reason);
      continue;
    }
    const entry = record.parsed.entry;
    if (entry.op === "put") {
      if (!items.has(entry.item.id)) order.push(entry.item.id);
      items.set(entry.item.id, { item: entry.item, writerSid: entry.sid });
      nextN = Math.max(nextN, idNumber(entry.item.id) + 1);
      opsSinceSnap++;
    } else if (entry.op === "del") {
      // Historical del of a missing id is a tolerated no-op (stale branches); planning new
      // ops stays strict (E_NOT_FOUND) — permissive fold, strict write.
      if (items.delete(entry.id)) {
        const at = order.indexOf(entry.id);
        if (at >= 0) order.splice(at, 1);
      }
      nextN = Math.max(nextN, idNumber(entry.id) + 1);
      opsSinceSnap++;
    }
    // A valid snap after the base cannot exist (the base IS the latest valid snap); snaps
    // that failed validation were dropped above. Nothing else to apply.
  }

  const folded: FoldedSessionItem[] = [];
  for (const id of order) {
    const record = items.get(id);
    if (record === undefined) continue;
    const inherited = inheritedMark(record, currentSid);
    folded.push({
      item: record.item,
      rev: sessionItemRevision(record.item),
      ...(inherited !== undefined ? { inherited } : {}),
    });
  }
  // nextN is MONOTONIC over every id ever seen (snap nextN + put/del ids), never recomputed
  // from the surviving items: a delete must not free its number for reuse. It may reach the
  // INTERNAL 1_000_000 exhaustion sentinel (item n999999 exists); published entry nextN stays
  // within the validated 1..999999 range, and the fold reconstructs the sentinel from the id.
  return Object.freeze({
    items: Object.freeze(folded),
    nextN: Math.max(1, nextN),
    opsSinceSnap,
    dropped: Object.freeze(dropped),
  });
}

function inheritedMark(
  record: { item: FoldedSessionItem["item"]; writerSid: string; spawn?: MemoryInheritance },
  currentSid: string | undefined,
): FoldedSessionItem["inherited"] {
  if (record.spawn !== undefined)
    return {
      kind: "spawn",
      fromSid: record.spawn.fromSid,
      ...(record.spawn.frozenAt !== undefined ? { frozenAt: record.spawn.frozenAt } : {}),
    };
  if (currentSid === undefined || record.writerSid !== currentSid) return { kind: "fork", fromSid: record.writerSid };
  return undefined;
}

function idNumber(id: string): number {
  const parsed = Number.parseInt(id.slice(1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Cache key for the store's fold cache: leafId + entry count (arch §6.2 write step 2). */
export const foldCacheKey = (leafId: string | undefined, branch: readonly unknown[]): string =>
  `${leafId ?? "noleaf"}:${branch.length}`;
