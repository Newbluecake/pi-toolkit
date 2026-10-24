/**
 * web-hub archive plan (docs/dev/web-hub/archive-report.md): pure view-logic for the fleet
 * drawer's archive surfaces. `archivedOf` narrows `AgentState.status.archived` (the status
 * reducer replaces `agent.status` wholesale — same posture as `bashJobsOf`, consumers read the
 * slot directly and state.js/types.ts stay untouched); `partitionArchived` splits the drawer's
 * row set into live vs archived so FleetTree renders only the live rows and the archived fold
 * renders the rest. Unknown/absent wire shapes degrade to "nothing archived" — the drawer then
 * renders byte-identically to the pre-feature shape (old agents never send the field).
 */
import type { ArchiveEntryWire, ArchiveWire, FleetRowWire } from "@protocol/messages.js";
import type { AgentState } from "../../types.js";
import { statusOf } from "../detail/agentViews.js";

export type ArchiveSet = ReadonlyMap<string, ArchiveEntryWire>;

/** The session's archive info; `undefined` ⇔ field absent/empty/malformed ⇒ no archive UI. */
export function archivedOf(agent: Pick<AgentState, "status">): ArchiveWire | undefined {
  const w = statusOf(agent)?.archived;
  if (w === null || typeof w !== "object") return undefined;
  if (!Array.isArray(w.entries) || w.entries.length === 0) return undefined;
  return w as ArchiveWire;
}

/** `archivedOf` → per-kind id→entry map (the `auto` badge + `at` live on the entry). */
export function archiveSetOf(wire: ArchiveWire | undefined, kind: "run" | "bash"): ArchiveSet {
  const out = new Map<string, ArchiveEntryWire>();
  if (wire === undefined) return out;
  for (const e of wire.entries) {
    if (e !== null && typeof e === "object" && e.kind === kind && typeof e.id === "string") out.set(e.id, e);
  }
  return out;
}

export interface ArchivePartition {
  /** Rows to render in the tree (order preserved). */
  readonly live: readonly FleetRowWire[];
  /** Archived rows STILL present in the fleet wire (rendered in the archived fold, in wire order). */
  readonly archivedRows: readonly FleetRowWire[];
}

/** Split fleet rows by the archive set. Rows whose id is archived but no longer in the wire are
 *  gone from both halves (they were dropped by the fleet projection's own caps long ago). */
export function partitionArchived(rows: readonly FleetRowWire[], set: ArchiveSet): ArchivePartition {
  const live: FleetRowWire[] = [];
  const archivedRows: FleetRowWire[] = [];
  for (const row of rows) {
    if (set.has(String(row.runId))) archivedRows.push(row);
    else live.push(row);
  }
  return { live, archivedRows };
}
