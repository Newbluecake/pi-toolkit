// todo-archive-split #92 (§4.1): the pure persistence planner. Given the in-memory state and
// the two persist baselines (archiveBase: id → canonical key of the last ARCHIVE_ENTRY fold
// state actually written; liveKey: JSON of the last live snapshot actually written), derive
// the 1–3 entries persist() must append, in the fixed order **pre → live → post**:
//
//   pre  — archive package FIRST: "write the task into its new home" before "move it out of
//          the old one" (a crash between the two can only duplicate, and the merge rule
//          live-wins dissolves duplicates; it can never lose data, §4.3);
//   live — the narrowed live snapshot {v:1, nextId, tasks}, written ONLY when its content
//          differs from liveKey (quick win ② dedup; unchanged content never re-written);
//   post — drops for tasks that moved back INTO the live set (reopened archived tasks).
//
// Deletes/evictions share the pre package with the pruned neighbors' puts (atomic, §4.3 #9).
// This module imports ONLY ./state.js (no pi, no index.ts) — no import cycles by construction.

import { canonicalTask, isArchived, type Task, type TodoArchiveEntryV1, type TodoState } from "./state.js";

/** v1 shape of the narrowed live snapshot (todo-archive-split §2.2). The `v: 1` marker is
 *  informational only — readers (current and old) whitelist just `tasks`/`nextId` and ignore
 *  it (OD3: added so future migrations / statistics scripts can recognize the format). */
export interface TodoLiveSnapshotV1 {
  v: 1;
  nextId: number;
  tasks: Task[];
}

/** planPersist output (todo-archive-split §4.1). `liveKey` is ALWAYS the fresh key of the
 *  would-be live snapshot — including when `live` is absent (then it equals the input key). */
export interface TodoPersistPlan {
  pre?: TodoArchiveEntryV1;
  live?: TodoLiveSnapshotV1;
  liveKey: string;
  post?: TodoArchiveEntryV1;
}

/** Content key of a task relative to the archive baseline: the canonical (fixed field order)
 *  JSON form, so the comparison is immune to key-order noise. */
export function canonicalKey(task: Task): string {
  return JSON.stringify(canonicalTask(task));
}

/** Apply a WRITTEN archive package to the archive baseline (todo-archive-split §4.2). persist()
 *  calls this after every successful append so the baseline tracks exactly what is on disk —
 *  a mid-persist append failure leaves the baseline at the last written position and the next
 *  persist re-derives and re-writes the remainder (idempotent convergence). */
export function applyArchiveEntryToBase(base: Map<number, string>, entry: TodoArchiveEntryV1): void {
  if (entry.reset) base.clear();
  for (const task of entry.put ?? []) base.set(task.id, canonicalKey(task));
  for (const id of entry.drop ?? []) base.delete(id);
}

/** Build the narrowed live snapshot for `state` (todo-archive-split §2.2, D13): unarchived
 *  tasks only (open + unarchived completed), canonicalized, with blocks/blockedBy stripped to
 *  edges inside the live set — the live snapshot must be self-contained for old readers
 *  (OD1-c), the authoritative copies of cross-storage edges live in the archive packages. */
export function liveSnapshotOf(state: TodoState): TodoLiveSnapshotV1 {
  const liveIds = new Set(state.tasks.filter((task) => !isArchived(task)).map((task) => task.id));
  const tasks: Task[] = [];
  for (const task of state.tasks) {
    if (isArchived(task)) continue;
    const canonical = canonicalTask(task);
    tasks.push({
      ...canonical,
      blocks: canonical.blocks.filter((id) => liveIds.has(id)),
      blockedBy: canonical.blockedBy.filter((id) => liveIds.has(id)),
    });
  }
  return { v: 1, nextId: state.nextId, tasks };
}

/**
 * Derive the entries for the next persist (todo-archive-split §4.1). Rules:
 *
 *  - `puts`  = archived tasks whose canonical key differs from the baseline — new archives AND
 *    re-puts of changed ones (edits, edge add/remove, edge pruning after a neighbor delete);
 *  - `gone`  = baseline ids absent from the state (deleted or evicted);
 *  - `moved` = baseline ids that are back in the live set (reopened) → post drop;
 *  - clear shape: when the baseline is non-empty, `gone` covers the ENTIRE baseline and
 *    nothing moved, write `{v:1, reset:true, put?}` (typical `/tasklist clear`) instead of a
 *    giant drop list;
 *  - otherwise `pre = {v:1, put?, drop: gone}` when there is anything to write;
 *  - the live snapshot is emitted only when its JSON differs from liveKey (dedup); restore()
 *    always resets liveKey, so the first persist after a session boundary always writes.
 */
export function planPersist(
  state: TodoState,
  archiveBase: ReadonlyMap<number, string>,
  liveKey: string | undefined,
): TodoPersistPlan {
  const ids = new Set(state.tasks.map((task) => task.id));
  const liveIds = new Set(state.tasks.filter((task) => !isArchived(task)).map((task) => task.id));
  const puts: Task[] = [];
  for (const task of state.tasks) {
    if (!isArchived(task)) continue;
    const canonical = canonicalTask(task);
    if (archiveBase.get(task.id) !== canonicalKey(task)) puts.push(canonical);
  }
  const gone: number[] = [];
  const moved: number[] = [];
  for (const id of archiveBase.keys()) {
    if (!ids.has(id)) gone.push(id);
    else if (liveIds.has(id)) moved.push(id);
  }

  let pre: TodoArchiveEntryV1 | undefined;
  if (archiveBase.size > 0 && gone.length === archiveBase.size && moved.length === 0) {
    pre = { v: 1, reset: true, ...(puts.length > 0 ? { put: puts } : {}) };
  } else if (puts.length > 0 || gone.length > 0) {
    pre = { v: 1, ...(puts.length > 0 ? { put: puts } : {}), ...(gone.length > 0 ? { drop: gone } : {}) };
  }

  const live = liveSnapshotOf(state);
  const nextLiveKey = JSON.stringify(live);
  const post: TodoArchiveEntryV1 | undefined = moved.length > 0 ? { v: 1, drop: moved } : undefined;

  return {
    ...(pre !== undefined ? { pre } : {}),
    ...(nextLiveKey !== liveKey ? { live } : {}),
    liveKey: nextLiveKey,
    ...(post !== undefined ? { post } : {}),
  };
}
