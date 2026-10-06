/**
 * worktree-web plan §4.2 (W2): the `StatusInfo.worktrees` projection + its
 * 1Hz-tick fingerprint.
 *
 * `projectWorktrees` turns a `ScanResult{kind:"ok"}` (W1's `src/git/worktrees.ts`,
 * already ranked current → main → others → `pi-agent-*` → prunable) into a
 * bounded `WorktreesWire`. Budget is layered ("三段削", same ladder as
 * `../../web-hub/agent/todo.ts`'s `projectTodo`):
 *
 *   1. every field is truncated to its own byte cap at row-projection time
 *      (`truncateText`, UTF-8 code-point-safe);
 *   2. only if the serialized wire still exceeds WT_WIRE_BUDGET_BYTES is the
 *      `path` field dropped from rows, tail-first (plan §4.2 pass 2 — `label`
 *      stays, so the row is still identifiable);
 *   3. still over budget, whole rows are dropped from the tail, folded into
 *      `omitted` — index 0 (current, when it exists; otherwise whatever
 *      ranking placed first) is never dropped (plan §3 "current 行永不被削").
 *
 * `total`/`probed`/`dirtyCount`/`agentCount` are always full-population counts
 * — computed from the scan's complete `worktrees` array before the 24-row cap
 * or the byte budget ever trims `rows` (same "full count, bounded display"
 * split as `projectTodo`'s `counts`).
 *
 * `staleMin` is deliberately never set here: it is W3's `worktree-sampler.ts`
 * job (agent-clock freshness, recomputed independently of any new sample).
 */
import { truncateText } from "../protocol/keys.js";
import type { WorktreeRowWire, WorktreesWire } from "../protocol/messages.js";
import { abbreviateHome } from "../../git/path-label.js";
import type { ScanResult, ScannedWorktree } from "../../git/worktrees.js";

/** Web projection caps (plan §3.2/§4.2). Schema's own `maxLength`/`maxItems` are wider on purpose. */
export const WT_MAX_ROWS = 24;
export const WT_LABEL_MAX_BYTES = 200;
export const WT_PATH_MAX_BYTES = 1024;
export const WT_BRANCH_MAX_BYTES = 200;
export const WT_RUNID_MAX_BYTES = 64;
export const WT_WIRE_BUDGET_BYTES = 16 << 10;

type OkScan = Extract<ScanResult, { kind: "ok" }>;

/** Projects an `ok` scan into `StatusInfo.worktrees`'s body. Caller decides what an absent/`not-repo`/`error` scan means. */
export function projectWorktrees(scan: OkScan, home: string | undefined, sampledAt: number): WorktreesWire {
  const full = scan.worktrees;
  const ranked = full.slice(0, WT_MAX_ROWS).map((row) => projectRow(row, home));
  const wire: WorktreesWire = {
    rows: ranked,
    total: full.length,
    ...(scan.listCapped ? { listCapped: true as const } : {}),
    ...(full.length > ranked.length ? { omitted: full.length - ranked.length } : {}),
    probed: countOf(full, (row) => row.probe !== undefined),
    dirtyCount: countOf(full, (row) => row.probe !== undefined && row.probe.dirty > 0),
    agentCount: countOf(full, (row) => row.agentRunId !== undefined),
    sampledAt,
  };
  return fitBudget(wire);
}

/** 1Hz-tick fingerprint (fleet's `lastFleetFp` pattern): content changes OR the minute bucket of
 *  `sampledAt` advances OR `staleMin` changes (plan §4.2 "内容（去 sampledAt）+ floor(sampledAt/60s)
 *  + staleMin"). The minute bucket (not the raw timestamp) means re-sampling to an unchanged
 *  result inside the same minute never triggers a resend. */
export function worktreesFingerprint(wire: WorktreesWire | undefined): string {
  if (wire === undefined) return "";
  const { sampledAt, staleMin, ...content } = wire;
  return JSON.stringify({ content, minuteBucket: Math.floor(sampledAt / 60000), staleMin });
}

function countOf(rows: readonly ScannedWorktree[], pred: (row: ScannedWorktree) => boolean): number {
  let n = 0;
  for (const row of rows) if (pred(row)) n++;
  return n;
}

function projectRow(row: ScannedWorktree, home: string | undefined): WorktreeRowWire {
  const wire: WorktreeRowWire = {
    label: truncateText(abbreviateHome(row.path, home), WT_LABEL_MAX_BYTES).text,
  };
  const path = truncateText(row.path, WT_PATH_MAX_BYTES).text;
  if (path.length > 0) wire.path = path;
  if (row.branch !== undefined) {
    const branch = truncateText(row.branch, WT_BRANCH_MAX_BYTES).text;
    if (branch.length > 0) wire.branch = branch;
  }
  if (row.head !== undefined) wire.head = row.head.slice(0, 7);
  if (row.current) wire.current = true;
  if (row.main) wire.main = true;
  if (row.agentRunId !== undefined) {
    const agentRunId = truncateText(row.agentRunId, WT_RUNID_MAX_BYTES).text;
    if (agentRunId.length > 0) wire.agentRunId = agentRunId;
  }
  if (row.bare) wire.bare = true;
  if (row.locked) wire.locked = true;
  if (row.prunable) wire.prunable = true;
  if (row.probe !== undefined) {
    wire.dirty = row.probe.dirty;
    if (row.probe.dirtyCapped) wire.dirtyCapped = true;
    if (row.probe.untrackedSkipped) wire.untrackedSkipped = true;
    if (row.probe.upstream) {
      wire.ahead = row.probe.ahead;
      wire.behind = row.probe.behind;
    }
  }
  if (row.unprobed !== undefined) wire.unprobed = row.unprobed;
  return wire;
}

/** Passes 2–3 of the budget ladder (pass 1 already ran inside `projectRow`). */
function fitBudget(wire: WorktreesWire): WorktreesWire {
  if (byteSize(wire) <= WT_WIRE_BUDGET_BYTES) return wire;
  // Pass 2: drop the `path` field, tail-first — `label` keeps the row identifiable.
  const rows = wire.rows.map((row) => ({ ...row }));
  let fitted: WorktreesWire = { ...wire, rows };
  for (let i = rows.length - 1; i >= 0; i--) {
    if (byteSize(fitted) <= WT_WIRE_BUDGET_BYTES) break;
    delete rows[i]!.path;
  }
  if (byteSize(fitted) <= WT_WIRE_BUDGET_BYTES) return fitted;
  // Pass 3: drop whole rows from the tail, never index 0 (current, when it exists — plan §3's
  // "current 行永不被削"). Every dropped row (cap- or budget-trimmed) lands in `omitted`.
  while (rows.length > 1 && byteSize(fitted) > WT_WIRE_BUDGET_BYTES) rows.pop();
  const omitted = wire.total - rows.length;
  fitted = {
    ...fitted,
    rows: [...rows],
    ...(omitted > 0 ? { omitted } : {}),
  };
  return fitted;
}

function byteSize(wire: WorktreesWire): number {
  return Buffer.byteLength(JSON.stringify(wire) ?? "", "utf8");
}
