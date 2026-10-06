/**
 * worktree-web plan §5 (W4): pure view-logic for the detail header's git-worktree panel.
 * `worktreesOf` narrows `AgentState.status.worktrees` (a deliberately loose
 * `Record<string, unknown>` in `types.ts`, P0-frozen) to the `WorktreesWire` shape declared in
 * `@protocol/messages.js` — same posture as `agentViews.ts`'s `statusOf`/`cardOf`. Unlike the
 * todo wire there is NO `@logic/state.js` mirror field for worktrees (plan §1.3: the status
 * reducer replaces `agent.status` wholesale, so the panel reads the slot directly and
 * `state.js`/`types.ts` stay untouched).
 *
 * Render rules the component consumes from here:
 * - a wire with no `rows` array (or an empty one) renders NO panel at all — same empty-state
 *   ruling as `TodoPanel` (absent ⇒ cwd not in a git repo / not sampled yet / web-hub off);
 * - unknown future row/body fields (Q4 open schema) are never read, so they never reach the DOM;
 * - `unprobed` is an open string on the wire (schema caps length but not values): any value
 *   outside the known `"cap" | "timeout" | "error"` set maps to the generic error display.
 */
import type { WorktreeRowWire, WorktreesWire } from "@protocol/messages.js";
import type { AgentState } from "../../types.js";
import { statusOf } from "./agentViews.js";

/** The wire when it exists and carries at least one row; `undefined` ⇒ render nothing. */
export function worktreesOf(agent: Pick<AgentState, "status">): WorktreesWire | undefined {
  const w = statusOf(agent)?.worktrees;
  if (w === null || typeof w !== "object") return undefined;
  if (!Array.isArray(w.rows) || w.rows.length === 0) return undefined;
  return w;
}

/** The row flagged `current` (realpath-equal to the session cwd's repo toplevel), if any. */
export function currentRowOf(wire: WorktreesWire): WorktreeRowWire | undefined {
  return wire.rows.find((row) => row.current === true);
}

/**
 * One row's dirty/probe status, reduced to a single display token (plan §5):
 * - `unprobed`  ⇒ `?` (tooltip distinguishes cap / timeout / error; unknown ⇒ error wording)
 * - `dirty` 0   ⇒ `clean`
 * - `dirty` N>0 ⇒ `*N`, with `+` appended when `dirtyCapped` (lower bound, status output hit the
 *   64 KiB cap) and `~` when `untrackedSkipped` (degraded `-uno` probe)
 * - neither     ⇒ `none` (bare / prunable rows are never probed — their flag chips say it all)
 */
export type RowStatus =
  | { readonly kind: "unprobed"; readonly reason: string }
  | { readonly kind: "clean" }
  | { readonly kind: "dirty"; readonly text: string; readonly capped: boolean; readonly skipped: boolean }
  | { readonly kind: "none" };

export function rowStatus(row: WorktreeRowWire): RowStatus {
  // `unprobed` is an open string on the wire (schema caps length, not values — Q4): read it as
  // unknown so future reasons (e.g. the fixture's "slow-fs") type-check and flow through.
  const unprobed: unknown = row.unprobed;
  if (typeof unprobed === "string" && unprobed !== "") {
    return { kind: "unprobed", reason: unprobed };
  }
  if (typeof row.dirty !== "number" || !Number.isFinite(row.dirty)) return { kind: "none" };
  if (row.dirty === 0) return { kind: "clean" };
  const capped = row.dirtyCapped === true;
  const skipped = row.untrackedSkipped === true;
  return { kind: "dirty", text: `*${row.dirty}${capped ? "+" : ""}${skipped ? "~" : ""}`, capped, skipped };
}

/** `HH:MM` for the expanded list's `last sample` footer. Display-only: `sampledAt` is the
 * agent's clock (plan §3.1), rendered here in the browser's local timezone. */
export function formatSampleTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
