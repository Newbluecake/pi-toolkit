// Ported from pi-claude-todo (MIT, author is this repository's user) — src/state.ts.
// Strict-mode adaptations per docs/dev/plugin-merge/merge-plan.md D4.2; replayState
// moved here from the source's index.ts and made a pure function (revision S6).
// todo-archive-split #92: persistence is now two-tier — live tasks keep flowing through the
// STATE_ENTRY snapshot while ARCHIVED tasks persist as incremental ARCHIVE_ENTRY packages;
// replayTodo/replayState fold + merge them back (details in docs/dev/todo-archive-split/plan.md
// and docs/dev/todo-archive/plan.md §9 D10–D15). Invariant to keep: cross-storage dependency
// edges are authoritative on the ARCHIVE side — the live snapshot strips them on write (D13).
// The in-memory model is unchanged: state still contains archived tasks.

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: number;
  subject: string;
  description: string;
  activeForm?: string;
  status: TaskStatus;
  blocks: number[];
  blockedBy: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** Set when the task transitions into `completed` (todo-archive D2); preserved across edits of
   *  other fields, cleared together with `archivedAt` on reopen. Meaningful only while
   *  `status === "completed"`; old snapshots without it fall back to `updatedAt` (`completionTime`). */
  completedAt?: number;
  /** Presence alone means "archived" (todo-archive D2); `updatedAt` is never touched by archiving.
   *  Cleared on reopen. Meaningful only while `status === "completed"`. */
  archivedAt?: number;
}

export interface TodoState {
  tasks: Task[];
  nextId: number;
}

export interface TaskInput {
  subject?: unknown;
  description?: unknown;
  activeForm?: unknown;
  status?: unknown;
  owner?: unknown;
  metadata?: unknown;
  blockedBy?: unknown;
  blocks?: unknown;
  removeBlockedBy?: unknown;
  removeBlocks?: unknown;
}

/**
 * Persistence customType for task-list snapshots (merge-plan D3: string kept
 * verbatim from the standalone plugin so existing session data keeps loading).
 */
export const STATE_ENTRY = "claude-code-todo-state";

/**
 * Persistence customType for ARCHIVED-task incremental packages (todo-archive-split #92, D10).
 * Same `claude-code-todo-*` family namespace as STATE_ENTRY — it belongs to the todo plugin's
 * data namespace, not `subagent:*`. The live snapshot stays in STATE_ENTRY (string frozen by
 * I7/D3); this entry only ever carries `{v:1, reset?, put?, drop?}` archive deltas.
 *
 * Forward compatibility rule: a v1 reader IGNORES any package whose `v !== 1` (sanitize is
 * fail-closed on the whole package). Therefore a future v2 bump must be safe to be ignored by
 * v1 readers — otherwise introduce a NEW customType instead of bumping `v` here.
 */
export const ARCHIVE_ENTRY = "claude-code-todo-archive";

/**
 * Hard cap on the archived set (todo-archive-split #92, D14 / OD2): same order of magnitude as
 * src/archive's ARCHIVE_ENTRIES_CAP. Bounds the in-memory state, the replay fold size and the
 * TaskList includeCompleted / TUI showAll output — NOT the file growth (that is what the
 * incremental form solves). Deliberately a constant, not a setting: a new settings key would
 * grow the I9 surface for no user-facing value. Eviction happens ONLY in sweep (§6).
 */
export const TODO_ARCHIVE_CAP = 256;

/**
 * v1 payload of an ARCHIVE_ENTRY (todo-archive-split §2.1). One package applies its fields in
 * the fixed order `reset → put → drop`; packages apply in branch order. The writer guarantees
 * a single package never puts AND drops the same id.
 */
export interface TodoArchiveEntryV1 {
  v: 1;
  /** Fold starts by clearing the whole archived set (`/tasklist clear`). */
  reset?: true;
  /** Upsert: whole tasks (full copies, not tombstones). */
  put?: Task[];
  /** Remove these ids from the archived set. */
  drop?: number[];
}

/** Structural view of the session-branch entries replayState scans. */
export type BranchEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: {
    role?: string;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
};

const STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"];

export function emptyState(): TodoState {
  return { tasks: [], nextId: 1 };
}

/** Completion timestamp for recency ordering (todo-archive D2): `completedAt` when present, else
 *  the pre-feature `updatedAt` fallback — a documented one-time imprecision for old sessions where
 *  a completed task later edited would rank as newer than it really is. */
export function completionTime(task: Task): number {
  return task.completedAt ?? task.updatedAt;
}

/** Archival is presence-based (todo-archive D2): `archivedAt !== undefined`. */
export function isArchived(task: Task): boolean {
  return task.archivedAt !== undefined;
}

/** Row selection for display surfaces (todo-archive D4/D7). ROWS ONLY — dependency lookups
 *  (activeBlockers/isBlocked/counts) must always be fed the FULL task list: a partition that omits
 *  archived completed predecessors would misreport successors as blocked. */
export interface TaskPartition {
  /** Display rows this partition was asked for: `[...open, ...recentCompleted]` (recent ascending). */
  readonly visible: Task[];
  /** pending/in_progress tasks, stored order. */
  readonly open: Task[];
  /** Completed and NOT archived, stored order. */
  readonly completed: Task[];
  /** The `recentCount` most recently completed non-archived tasks, ascending display order
   *  (selection is by `completionTime` desc, ties broken by higher id = more recent). */
  readonly recentCompleted: Task[];
  /** Completed non-archived tasks not covered by `recentCompleted`. */
  readonly hiddenCompleted: number;
  /** Archived tasks, stored order. */
  readonly archived: Task[];
}

export function partitionTasks(tasks: readonly Task[], recentCount: number): TaskPartition {
  const open: Task[] = [];
  const completed: Task[] = [];
  const archived: Task[] = [];
  for (const task of tasks) {
    if (task.status !== "completed") open.push(task);
    else if (isArchived(task)) archived.push(task);
    else completed.push(task);
  }
  const latest = [...completed].sort((a, b) => {
    const delta = completionTime(b) - completionTime(a);
    return delta !== 0 ? delta : b.id - a.id;
  });
  const recent = latest.slice(0, Math.max(0, recentCount)).reverse();
  return {
    visible: [...open, ...recent],
    open,
    completed,
    recentCompleted: recent,
    hiddenCompleted: completed.length - recent.length,
    archived,
  };
}

/** Archive completed tasks (todo-archive D1/D2). Only "completed and not yet archived" tasks are
 *  touched; `updatedAt` is never modified; ids that are unknown, open, or already archived are
 *  skipped. Returns the SAME reference when there is nothing to archive. */
export function archiveCompleted(state: TodoState, ids: number[] | "all", now: number): TodoState {
  const targets = ids === "all" ? undefined : new Set(ids);
  let changed = false;
  const next = cloneState(state);
  for (const task of next.tasks) {
    if (task.status !== "completed" || task.archivedAt !== undefined) continue;
    if (targets !== undefined && !targets.has(task.id)) continue;
    task.archivedAt = now;
    changed = true;
  }
  return changed ? next : state;
}

/** `/tasklist clear` (todo-archive D9): empties the task list while keeping the `nextId` high-water
 *  mark, so ids are never reused within a branch/session even after a clear. */
export function clearTasks(state: TodoState): TodoState {
  return { tasks: [], nextId: state.nextId };
}

/**
 * Hard-cap eviction for the archived set (todo-archive-split §6, D14 / OD2). Pure function:
 * returns the SAME reference while the archived count is ≤ cap. When over, the oldest tasks by
 * `(archivedAt asc, id asc)` are PERMANENTLY deleted with deleteTask semantics — their ids are
 * pruned from every remaining task's blocks/blockedBy (a pruned neighbor therefore differs and
 * produces a put in the same sweep package as the eviction drop, §4.3 #9). Evicted tasks are
 * completed, so no blocking computation ever changes. The ONLY execution point is sweep
 * (restore never evicts — it does not write; edits never evict — no "deleted right after an
 * edit"). Note eviction is branch-local: navigateTree back past the eviction point resurrects
 * the tasks (natural fold semantics — the session file is the truth; review Nit #6).
 */
export function evictArchived(state: TodoState, cap: number): TodoState {
  const archived = state.tasks.filter(isArchived);
  if (archived.length <= cap) return state;
  const excess = archived.length - cap;
  const oldest = [...archived]
    .sort((a, b) => (a.archivedAt ?? 0) - (b.archivedAt ?? 0) || a.id - b.id)
    .slice(0, excess);
  const evictIds = new Set(oldest.map((task) => task.id));
  const next = cloneState(state);
  next.tasks = next.tasks.filter((task) => !evictIds.has(task.id));
  for (const task of next.tasks) {
    task.blocks = task.blocks.filter((id) => !evictIds.has(id));
    task.blockedBy = task.blockedBy.filter((id) => !evictIds.has(id));
  }
  return next;
}

export function cloneState(state: TodoState): TodoState {
  return {
    nextId: state.nextId,
    tasks: state.tasks.map((task) => ({
      ...task,
      blocks: [...task.blocks],
      blockedBy: [...task.blockedBy],
      ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
    })),
  };
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && STATUSES.includes(value as TaskStatus);
}

export function createTask(state: TodoState, input: TaskInput, now = Date.now()): { state: TodoState; task: Task } {
  const subject = requiredText(input.subject, "subject", 200);
  const description = requiredText(input.description, "description", 4000);
  const activeForm = optionalText(input.activeForm, "activeForm", 200);
  const owner = optionalText(input.owner, "owner", 200);
  const metadata = normalizeMetadata(input.metadata);
  const blockedBy = normalizeIds(input.blockedBy, "blockedBy");
  const blocks = normalizeIds(input.blocks, "blocks");
  const next = cloneState(state);
  const task: Task = {
    id: next.nextId,
    subject,
    description,
    ...(activeForm ? { activeForm } : {}),
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...(owner ? { owner } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: now,
    updatedAt: now,
  };
  next.nextId += 1;
  next.tasks.push(task);
  connectDependencies(next, task.id, blockedBy, blocks);
  validateDependencyGraph(next);
  return { state: next, task: cloneTask(findTask(next, task.id)) };
}

export function updateTask(
  state: TodoState,
  id: unknown,
  input: TaskInput,
  now = Date.now(),
): { state: TodoState; task: Task; changed: boolean } {
  const taskId = requiredId(id, "taskId");
  const next = cloneState(state);
  const task = findTask(next, taskId);
  const before = JSON.stringify(task);
  const was = task.status === "completed";
  const removeBlockedBy = normalizeIds(input.removeBlockedBy, "removeBlockedBy");
  const removeBlocks = normalizeIds(input.removeBlocks, "removeBlocks");
  const hasMutation =
    input.subject !== undefined ||
    input.description !== undefined ||
    input.activeForm !== undefined ||
    input.status !== undefined ||
    input.owner !== undefined ||
    input.metadata !== undefined ||
    normalizeIds(input.blockedBy, "blockedBy").length > 0 ||
    normalizeIds(input.blocks, "blocks").length > 0 ||
    removeBlockedBy.length > 0 ||
    removeBlocks.length > 0;
  if (!hasMutation) throw new Error("TaskUpdate requires at least one field to change");

  if (input.subject !== undefined) task.subject = requiredText(input.subject, "subject", 200);
  if (input.description !== undefined) task.description = requiredText(input.description, "description", 4000);
  // exactOptionalPropertyTypes: optionalText/normalizeMetadata may yield
  // undefined (empty string clears the field) — delete instead of assigning
  // undefined to an optional property.
  if (input.activeForm !== undefined) {
    const activeForm = optionalText(input.activeForm, "activeForm", 200);
    if (activeForm === undefined) delete task.activeForm;
    else task.activeForm = activeForm;
  }
  if (input.owner !== undefined) {
    const owner = optionalText(input.owner, "owner", 200);
    if (owner === undefined) delete task.owner;
    else task.owner = owner;
  }
  if (input.metadata !== undefined) {
    const metadata = normalizeMetadata(input.metadata);
    if (metadata === undefined) delete task.metadata;
    else task.metadata = metadata;
  }
  if (input.status !== undefined) {
    if (!isTaskStatus(input.status)) throw new Error(`status must be one of: ${STATUSES.join(", ")}`);
    // todo-archive D2 bookkeeping: stamp on the transition into completed, clear both markers on
    // the transition out (reopen). A completed→completed no-op leaves the fields untouched, and
    // edits of other fields never come through this branch at all.
    if (!was && input.status === "completed") task.completedAt = now;
    else if (was && input.status !== "completed") {
      delete task.completedAt;
      delete task.archivedAt;
    }
    task.status = input.status;
  }

  const addBlockedBy = normalizeIds(input.blockedBy, "blockedBy");
  const addBlocks = normalizeIds(input.blocks, "blocks");
  if (addBlockedBy.length > 0 || addBlocks.length > 0) {
    connectDependencies(next, taskId, addBlockedBy, addBlocks);
  }

  for (const dependencyId of removeBlockedBy) {
    task.blockedBy = task.blockedBy.filter((value) => value !== dependencyId);
    const dependency = findTask(next, dependencyId);
    dependency.blocks = dependency.blocks.filter((value) => value !== taskId);
  }
  for (const blockedId of removeBlocks) {
    task.blocks = task.blocks.filter((value) => value !== blockedId);
    const blocked = findTask(next, blockedId);
    blocked.blockedBy = blocked.blockedBy.filter((value) => value !== taskId);
  }

  validateDependencyGraph(next);
  const changed = before !== JSON.stringify(task);
  if (!changed) return { state, task: cloneTask(findTask(state, taskId)), changed: false };
  task.updatedAt = now;
  return { state: next, task: cloneTask(task), changed: true };
}

export function deleteTask(state: TodoState, id: unknown): { state: TodoState; task: Task } {
  const taskId = requiredId(id, "taskId");
  const next = cloneState(state);
  const task = findTask(next, taskId);
  next.tasks = next.tasks.filter((candidate) => candidate.id !== taskId);
  for (const candidate of next.tasks) {
    candidate.blocks = candidate.blocks.filter((value) => value !== taskId);
    candidate.blockedBy = candidate.blockedBy.filter((value) => value !== taskId);
  }
  return { state: next, task: cloneTask(task) };
}

export function getTask(state: TodoState, id: unknown): Task {
  return cloneTask(findTask(state, requiredId(id, "taskId")));
}

/**
 * Presentation order (todo-archive §2): open tasks keep their relative creation order, completed
 * non-archived tasks sink below them, archived tasks sink to the very bottom. With no archived
 * tasks the result is byte-identical to the pre-archive two-segment order. The stored array order
 * is never mutated — apply this at display/serialization boundaries.
 */
export function orderTasks(tasks: readonly Task[]): Task[] {
  const open: Task[] = [];
  const completed: Task[] = [];
  const archived: Task[] = [];
  for (const task of tasks) {
    if (task.status !== "completed") open.push(task);
    else if (isArchived(task)) archived.push(task);
    else completed.push(task);
  }
  return [...open, ...completed, ...archived];
}

/**
 * Per-task whitelist rebuild (todo-archive-split §4.1), extracted verbatim from restoreState's
 * loop body. Doubles as the canonical serialization form `canonicalTask`: fixed field order +
 * id dedup, so JSON.stringify keys are stable across writes. Returns undefined for ANY
 * non-conforming task — the whole candidate is then invalid (single-task-fail ⇒ candidate-fail,
 * the pre-existing restoreState contract).
 */
export function restoreTask(raw: unknown): Task | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const task = raw as Partial<Task>;
  if (
    typeof task.id !== "number" ||
    !Number.isInteger(task.id) ||
    task.id < 1 ||
    typeof task.subject !== "string" ||
    typeof task.description !== "string" ||
    !isTaskStatus(task.status) ||
    !Array.isArray(task.blocks) ||
    !Array.isArray(task.blockedBy) ||
    !task.blocks.every(isIntegerId) ||
    !task.blockedBy.every(isIntegerId) ||
    typeof task.createdAt !== "number" ||
    typeof task.updatedAt !== "number"
  )
    return undefined;
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    ...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
    status: task.status,
    blocks: uniqueIds(task.blocks),
    blockedBy: uniqueIds(task.blockedBy),
    ...(typeof task.owner === "string" ? { owner: task.owner } : {}),
    ...(task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
      ? { metadata: { ...(task.metadata as Record<string, unknown>) } }
      : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    // todo-archive D2: the two optional timestamps survive restore only as finite numbers on a
    // completed task; otherwise just the field is dropped — the candidate state stays valid.
    ...(isFiniteTimestamp(task.completedAt) && task.status === "completed" ? { completedAt: task.completedAt } : {}),
    ...(isFiniteTimestamp(task.archivedAt) && task.status === "completed" ? { archivedAt: task.archivedAt } : {}),
  };
}

/**
 * Whitelist rebuild WITHOUT the dependency-graph validation (todo-archive-split §3.1): the
 * exported `restoreState` behavior is unchanged (whitelist + validateState); replayTodo defers
 * validation to AFTER the archive merge, which is what lets split-format candidates live in
 * the candidate list before we know whether their merge validates.
 */
export function restoreShape(value: unknown): TodoState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { tasks?: unknown; nextId?: unknown };
  if (!Array.isArray(record.tasks) || typeof record.nextId !== "number" || !Number.isInteger(record.nextId))
    return undefined;
  const tasks: Task[] = [];
  for (const raw of record.tasks) {
    const task = restoreTask(raw);
    if (!task) return undefined;
    tasks.push(task);
  }
  return { tasks, nextId: Math.max(record.nextId, 1) };
}

/** Canonical serialization form (todo-archive-split §4.1): restoreTask applied to an in-memory
 *  task — fixed field order + id dedup. Keys the persist baselines against must be stable, so
 *  everything written to disk (live snapshot tasks AND archive puts) goes through this. */
export function canonicalTask(task: Task): Task {
  const canonical = restoreTask(task);
  if (!canonical) throw new Error(`Task #${task.id} cannot be canonicalized`);
  return canonical;
}

export function restoreState(value: unknown): TodoState | undefined {
  const state = restoreShape(value);
  if (!state) return undefined;
  try {
    validateState(state);
  } catch {
    return undefined;
  }
  return state;
}

/**
 * Fail-closed sanitize of an ARCHIVE_ENTRY payload (todo-archive-split §2.1), following the
 * prompt-sections/store.ts v1 precedent. Only the two whole-package failures ignore the
 * package entirely (so a pre-split session never takes the split read path — OD4):
 *   - not an object, or `v !== 1` (this is what makes a future v2 invisible to v1 readers);
 * everything else degrades field-by-field / element-by-element (D2's "single field droppable,
 * candidate still valid" spirit):
 *   - `reset` must be `=== true`, else just the field is dropped;
 *   - `put` must be an array, else just the field is dropped; elements run through restoreTask
 *     PLUS the archive invariants (completed + finite archivedAt) — bad elements are dropped
 *     individually, the package stays valid;
 *   - `drop` must be an array, else just the field is dropped; only positive integer ids
 *     survive, deduplicated;
 *   - no cap on put count at read time (truncation would lose data); the cap is write-side only.
 */
export function sanitizeArchiveEntry(raw: unknown): TodoArchiveEntryV1 | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as { v?: unknown; reset?: unknown; put?: unknown; drop?: unknown };
  if (record.v !== 1) return undefined;
  let put: Task[] | undefined;
  if (Array.isArray(record.put)) {
    const tasks: Task[] = [];
    for (const element of record.put) {
      const task = restoreTask(element);
      if (!task || task.status !== "completed" || !isFiniteTimestamp(task.archivedAt)) continue;
      tasks.push(task);
    }
    put = tasks;
  }
  let drop: number[] | undefined;
  if (Array.isArray(record.drop)) {
    drop = uniqueIds(record.drop.filter(isIntegerId));
  }
  return {
    v: 1,
    ...(record.reset === true ? { reset: true } : {}),
    ...(put !== undefined ? { put } : {}),
    ...(drop !== undefined ? { drop } : {}),
  };
}

/** Fold one sanitized package into the archived set (todo-archive-split §2.1): within a
 *  package `reset → put → drop`; across packages, branch order. Mutates `archived` in place
 *  (the map is replayTodo-local; callers get the original objects back, review Minor #4). */
export function foldArchive(archived: Map<number, Task>, entry: TodoArchiveEntryV1): void {
  if (entry.reset) archived.clear();
  for (const task of entry.put ?? []) archived.set(task.id, task);
  for (const id of entry.drop ?? []) archived.delete(id);
}

/**
 * Merge a live-snapshot candidate with the folded archived set (todo-archive-split §3.3, D11).
 *  1. id conflict ⇒ LIVE wins: the archived copy is ignored entirely (reopening self-heals; a
 *     crash-window duplicate dissolves the same way);
 *  2. result sorted by id ascending — the stored order has been creation order (createTask only
 *     appends), so this equals the pre-persist in-memory order;
 *  3. tolerant reattach, A-SOURCE tasks only: edges pointing outside the merged set are dropped
 *     (tolerant read); edges pointing at a live task get their opposite edge pushed onto that
 *     live task when missing. Live-source edges are NEVER touched — a dangling live edge is
 *     data corruption and must be rejected by validateState, exactly like today. Reattach only
 *     ever completes the opposite of an EXISTING edge, so it cannot create a cycle on its own.
 *
 * Clone rule (review Minor #4): the tolerant edge work happens on CLONES — the folded task
 * objects in `archived` are never mutated (replayTodo returns them as-is so the caller can key
 * the restore baseline with the PRE-drop edges, which is what self-heals dangling on-disk edges
 * on the next persist).
 *
 * Edge-array order: reattached edges are pushed at the end, so a round trip guarantees edge-SET
 * equality, not order. Safe because reattached edges always point at archived (completed)
 * tasks and every display surface uses activeBlockers (completed never blocks).
 */
export function mergeArchive(candidate: TodoState, archived: ReadonlyMap<number, Task>): TodoState {
  const liveIds = new Set(candidate.tasks.map((task) => task.id));
  const liveTasks = candidate.tasks.map(cloneTask); // live source: edges untouched
  const archiveTasks: Task[] = [];
  for (const task of archived.values()) {
    if (liveIds.has(task.id)) continue; // live wins
    archiveTasks.push(cloneTask(task));
  }
  const merged = [...liveTasks, ...archiveTasks].sort((a, b) => a.id - b.id);
  const mergedIds = new Set(merged.map((task) => task.id));
  const byId = new Map(merged.map((task) => [task.id, task]));
  for (const task of archiveTasks) {
    task.blocks = task.blocks.filter((id) => mergedIds.has(id));
    task.blockedBy = task.blockedBy.filter((id) => mergedIds.has(id));
  }
  for (const task of archiveTasks) {
    for (const blockedId of task.blocks) {
      const target = byId.get(blockedId)!; // membership asserted by the filter above
      if (liveIds.has(blockedId) && !target.blockedBy.includes(task.id)) target.blockedBy.push(task.id);
    }
    for (const dependencyId of task.blockedBy) {
      const target = byId.get(dependencyId)!; // same
      if (liveIds.has(dependencyId) && !target.blocks.includes(task.id)) target.blocks.push(task.id);
    }
  }
  let maxId = 0;
  for (const task of merged) if (task.id > maxId) maxId = task.id;
  return { tasks: merged, nextId: Math.max(candidate.nextId, maxId + 1) };
}

/** replayTodo result (todo-archive-split §3.1). `archived` holds the fold's ORIGINAL task
 *  objects (pre-merge, pre-tolerant-drop — review Minor #4); `degraded` is true only when a
 *  split-format session failed to validate ANY merge and fell back to live-only. */
export interface ReplayTodoResult {
  state: TodoState | undefined;
  archived: ReadonlyMap<number, Task>;
  degraded: boolean;
}

/** validateState as a predicate (replayTodo's `valid()`). */
function isValidState(state: TodoState): boolean {
  try {
    validateState(state);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure three-phase replay (todo-archive-split §3.2, D11). Single pass over the branch in order:
 *  - custom ARCHIVE_ENTRY → sanitize (fail-closed) → fold into the archived set;
 *  - custom STATE_ENTRY / non-error toolResult `details.state` → whitelist (restoreShape) into
 *    the candidate list (BOTH historical shapes, like the pre-#92 replayState).
 *
 * Phase 2 — no valid archive package ever seen (pre-split session): iterate candidates from the
 * LAST, first one passing validateState wins; deep-equal to the pre-#92 replayState (proven by
 * the frozen-copy fuzz in tests/todo/archive-store.test.ts). No lenient repair, no sorting,
 * no nextId adjustment in this path (OD4: old sessions must stay byte-identical).
 *
 * Phase 3 — split session: from the last candidate, merge with the archived set and validate
 * the MERGED state; first success wins. If every merge fails (e.g. the archived set is
 * internally inconsistent), degrade: return the best live-only candidate per the phase-2 rule
 * plus `degraded: true` — never WORSE than not reading the archive at all. The caller reacts by
 * refusing to drop what it could not read (empty restore baseline).
 */
export function replayTodo(entries: readonly unknown[]): ReplayTodoResult {
  const archived = new Map<number, Task>();
  let sawArchive = false;
  const candidates: TodoState[] = [];
  for (const raw of entries) {
    const entry = raw as BranchEntry;
    if (entry.type === "custom" && entry.customType === ARCHIVE_ENTRY) {
      const clean = sanitizeArchiveEntry(entry.data);
      if (clean) {
        sawArchive = true;
        foldArchive(archived, clean);
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      const candidate = restoreShape(entry.data);
      if (candidate) candidates.push(candidate);
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult" || message.isError) continue;
    if (!message.details || typeof message.details !== "object") continue;
    const details = message.details as { state?: unknown };
    const candidate = restoreShape(details.state);
    if (candidate) candidates.push(candidate);
  }
  if (!sawArchive) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i]!;
      if (isValidState(candidate)) return { state: candidate, archived, degraded: false };
    }
    return { state: undefined, archived, degraded: false };
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const merged = mergeArchive(candidates[i]!, archived);
    if (isValidState(merged)) return { state: merged, archived, degraded: false };
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (isValidState(candidate)) return { state: candidate, archived, degraded: true };
  }
  return { state: undefined, archived, degraded: true };
}

/**
 * Pure replay (merge-plan revision S6; todo-archive-split §3.1 wrapper): the pre-#92 signature —
 * `replayTodo(entries).state`. All three readers (restore, session-facts, topic-switch hold)
 * go through this single choke point, which is what keeps the split format invisible to them.
 */
export function replayState(entries: readonly unknown[]): TodoState | undefined {
  return replayTodo(entries).state;
}

export function validateState(state: TodoState): void {
  if (!Number.isInteger(state.nextId) || state.nextId < 1) throw new Error("Invalid nextId");
  const ids = new Set<number>();
  for (const task of state.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!task.subject || !task.description || !isTaskStatus(task.status)) throw new Error(`Invalid task #${task.id}`);
    if (!task.blocks.every((id) => ids.has(id) || state.tasks.some((candidate) => candidate.id === id))) {
      throw new Error(`Task #${task.id} has a missing blocks dependency`);
    }
    if (!task.blockedBy.every((id) => state.tasks.some((candidate) => candidate.id === id))) {
      throw new Error(`Task #${task.id} has a missing blockedBy dependency`);
    }
  }
  validateDependencyGraph(state);
}

function connectDependencies(state: TodoState, taskId: number, blockedBy: number[], blocks: number[]): void {
  const task = findTask(state, taskId);
  for (const dependencyId of blockedBy) {
    if (dependencyId === taskId) throw new Error("A task cannot block itself");
    const dependency = findTask(state, dependencyId);
    if (!task.blockedBy.includes(dependencyId)) task.blockedBy.push(dependencyId);
    if (!dependency.blocks.includes(taskId)) dependency.blocks.push(taskId);
  }
  for (const blockedId of blocks) {
    if (blockedId === taskId) throw new Error("A task cannot block itself");
    const blocked = findTask(state, blockedId);
    if (!task.blocks.includes(blockedId)) task.blocks.push(blockedId);
    if (!blocked.blockedBy.includes(taskId)) blocked.blockedBy.push(taskId);
  }
}

function validateDependencyGraph(state: TodoState): void {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  for (const task of state.tasks) {
    for (const dependencyId of [...task.blocks, ...task.blockedBy]) {
      if (!byId.has(dependencyId)) throw new Error(`Task #${task.id} references missing task #${dependencyId}`);
    }
    for (const blockedId of task.blocks) {
      // byId membership was asserted just above (pre-existing assertion, kept per merge-plan D4.2).
      const blocked = byId.get(blockedId)!;
      if (!blocked.blockedBy.includes(task.id))
        throw new Error(`Dependency graph is not bidirectional for #${task.id} -> #${blockedId}`);
    }
    for (const dependencyId of task.blockedBy) {
      // Same: membership asserted above.
      const dependency = byId.get(dependencyId)!;
      if (!dependency.blocks.includes(task.id))
        throw new Error(`Dependency graph is not bidirectional for #${dependencyId} -> #${task.id}`);
    }
  }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): void => {
    if (visiting.has(id)) throw new Error("Dependency cycle detected");
    if (visited.has(id)) return;
    visiting.add(id);
    // Same: id comes from state.tasks, so it is always present in byId.
    for (const child of byId.get(id)!.blocks) visit(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of state.tasks) visit(task.id);
}

/**
 * A task's blockedBy edges that still reference a non-completed task.
 * Completed predecessors no longer count as blocking (deleted predecessors
 * are already pruned from blockedBy by deleteTask, so no extra filtering is
 * needed for that case).
 */
export function activeBlockers(task: Task, tasks: readonly Task[]): number[] {
  if (task.blockedBy.length === 0) return [];
  const completedIds = new Set(
    tasks.filter((candidate) => candidate.status === "completed").map((candidate) => candidate.id),
  );
  return task.blockedBy.filter((id) => !completedIds.has(id));
}

export function isBlocked(task: Task, tasks: readonly Task[]): boolean {
  return activeBlockers(task, tasks).length > 0;
}

/**
 * Tasks that were blocked in `before` and are no longer blocked in `after`
 * (all remaining predecessors completed, or the blocking predecessor was
 * removed/deleted). Used to report "Unblocked: ..." after a mutation.
 * Newly-created tasks (absent from `before`) are not reported; completed
 * tasks are never reported as unblocked.
 */
export function newlyUnblockedTasks(before: TodoState, after: TodoState): Task[] {
  const result: Task[] = [];
  for (const task of after.tasks) {
    if (task.status === "completed") continue;
    const beforeTask = before.tasks.find((candidate) => candidate.id === task.id);
    if (!beforeTask) continue;
    if (isBlocked(beforeTask, before.tasks) && !isBlocked(task, after.tasks)) result.push(task);
  }
  return result;
}

function findTask(state: TodoState, id: number): Task {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task #${id} not found`);
  return task;
}

function requiredId(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^#?\d+$/.test(value.trim())) return Number(value.trim().replace(/^#/, ""));
  throw new Error(`${label} must be a positive integer task ID`);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maxLength);
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("metadata must be an object");
  return { ...(value as Record<string, unknown>) };
}

function normalizeIds(value: unknown, label: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of task IDs`);
  const ids = value.map((item) => requiredId(item, `${label} item`));
  return uniqueIds(ids);
}

function uniqueIds(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}

function isIntegerId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  };
}
