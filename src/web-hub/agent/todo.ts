/**
 * todo-web plan §3.2 (T2) + todo-archive plan v2.1 §2 (D5/D7): the `StatusInfo.todo`
 * projection + its 1Hz-tick fingerprint.
 *
 * `projectTodo` turns the live `TodoState` closure (main session only — the
 * getter is threaded from `wireTodo` through src/index.ts) into a bounded
 * `TodoWire`. Row selection (todo-archive D4/D5): `partitionTasks(all, 3)` picks
 * `[...open, ...3 most-recent completed]`, capped at 32 rows, open first;
 * ARCHIVED tasks are never emitted and never counted (rows/total/counts).
 * Dependency lookups are a different matter (D7): `projectTask(t, all)` and
 * `countsOf(nonArchived, all)` always resolve blockers against the FULL task
 * list, so an archived completed predecessor still unblocks its successors.
 *
 * Budget is layered ("三段削"):
 *
 *   1. every `description` is truncated to TODO_DESC_MAX_BYTES (UTF-8
 *      code-point-safe via protocol/keys.ts's `truncateText`), subject kept;
 *   2. only if the serialized wire still exceeds TODO_WIRE_BUDGET_BYTES are
 *      whole descriptions dropped (tail-first — completed rows sit at the
 *      tail, so their least-actionable descriptions go first);
 *   3. still over budget, task rows themselves are dropped from the tail,
 *      folded into `omitted`.
 *
 * v2.1 review #7: EVERY byte-size decision above is made against the FINALIZED
 * wire (`finalize(rows)` — metadata included), never against a partial object;
 * the returned wire is the same object the last check measured, so the
 * ≤ 32 KiB budget holds for the bytes actually sent.
 *
 * `todoLightFingerprint` is the 1Hz-tick gate (fleet's `lastFleetFp` pattern):
 * it hashes only `{id,status,updatedAt,a}` + total. Every todo mutation either
 * advances some task's `updatedAt` or changes the population (`createTask`
 * always stamps now, `updateTask` leaves `updatedAt` untouched only when
 * nothing changed — and unchanged means nothing was persisted either,
 * `deleteTask` changes total), so subject/description edits cannot slip
 * through undetected; archiving deliberately does NOT touch `updatedAt`
 * (todo-archive D2), so the per-row `a` bit is what flips the fingerprint on
 * an archive-only change. A false positive (updatedAt moved, content
 * equivalent) only sends one extra frame.
 *
 * Cross-directory dependency on `../../todo/state.js` is intentional and
 * legal (pure functions, zero pi imports — same ruling as plan §3.2).
 */
import { truncateText } from "../protocol/keys.js";
import type { TodoWire, TodoTaskWire } from "../protocol/messages.js";
import {
  activeBlockers,
  isArchived,
  partitionTasks,
  type Task,
  type TaskPartition,
  type TodoState,
} from "../../todo/state.js";

/** Web projection caps (plan §0 预算行): 32 rows, 240-byte descriptions, 32 KiB hard budget. */
export const TODO_WIRE_MAX_TASKS = 32;
export const TODO_DESC_MAX_BYTES = 240;
export const TODO_WIRE_BUDGET_BYTES = 32 << 10;
/** todo-archive D4: the web panel folds completed tasks to the 3 most recent. */
export const TODO_RECENT_COMPLETED = 3;

/** `projectTodo`'s cap-gate switch (todo-archive D5): `archiveFields:true` ⇒ `completedHidden` /
 *  `archived` may ride the wire — only legal while the live hub's hello_ack.caps carries
 *  `todo.archive.v1` (see agent/index.ts's `todoArchiveCap`). */
export interface ProjectTodoOptions {
  archiveFields: boolean;
}

/** Empty-or-archived-only task list ⇒ `undefined` ⇒ the `todo` field is omitted entirely
 *  (byte-equal to pre-feature; todo-archive D5: archived-only ⇒ undefined). */
export function projectTodo(state: TodoState, opts: ProjectTodoOptions): TodoWire | undefined {
  const all = state.tasks;
  const p = partitionTasks(all, TODO_RECENT_COMPLETED);
  if (p.visible.length === 0) return undefined; // no open tasks AND no recent completed ⇒ nothing to show
  const candidates = [...p.open, ...p.recentCompleted];
  const selected = candidates.slice(0, TODO_WIRE_MAX_TASKS);
  // max(updatedAt) over the cap-selected rows, before any budget trim (口径 unchanged: a display
  // hint about the list's recency, not a per-row invariant).
  const updatedAt = selected.reduce((max, task) => Math.max(max, task.updatedAt), 0);
  const rows = selected.map((task) => projectTask(task, all));
  return fitBudget(rows, p, all, updatedAt, opts.archiveFields);
}

/** Cheap change-detection key for the 1Hz tick — never serializes subjects/descriptions. */
export function todoLightFingerprint(state: TodoState): string {
  return JSON.stringify({
    total: state.tasks.length,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
      a: isArchived(task),
    })),
  });
}

function projectTask(task: Task, all: readonly Task[]): TodoTaskWire {
  const wire: TodoTaskWire = {
    id: task.id,
    subject: task.subject,
    status: task.status,
    blockedBy: activeBlockers(task, all), // open blockers only — TUI formatTaskLine's gauge
  };
  if (task.owner !== undefined) wire.owner = task.owner;
  if (task.activeForm !== undefined) wire.activeForm = task.activeForm;
  if (task.description !== "") {
    const t = truncateText(task.description, TODO_DESC_MAX_BYTES);
    if (t.text !== "") {
      wire.description = t.text;
      if (t.truncated) wire.descTruncated = true;
    }
  }
  return wire;
}

/** Counts over the given population; `blocked` mirrors the TUI widget (non-completed + open
 *  blocker). Callers pass the non-archived population (open ∪ completed); blocker lookups
 *  always resolve against the FULL `all` list (todo-archive D7). */
function countsOf(population: readonly Task[], all: readonly Task[]): TodoWire["counts"] {
  let open = 0;
  let inProgress = 0;
  let completed = 0;
  let blocked = 0;
  for (const task of population) {
    if (task.status === "completed") {
      completed += 1;
      continue;
    }
    if (task.status === "in_progress") inProgress += 1;
    else open += 1;
    if (activeBlockers(task, all).length > 0) blocked += 1;
  }
  return { open, inProgress, completed, blocked };
}

/** The complete wire for a given row set — metadata (total/counts/omitted/completedHidden/
 *  archived/updatedAt) finalized BEFORE any byte-size decision (v2.1 review #7). */
function finalize(
  rows: readonly TodoTaskWire[],
  p: TaskPartition,
  all: readonly Task[],
  updatedAt: number,
  archiveFields: boolean,
): TodoWire {
  // Non-archived population (open ∪ completed): archived never counted (D5).
  const nonArchived = [...p.open, ...p.completed];
  const total = nonArchived.length;
  const counts = countsOf(nonArchived, all);
  const omitted = total - rows.length;
  const emittedCompleted = rows.reduce((n, row) => (row.status === "completed" ? n + 1 : n), 0);
  const completedHidden = counts.completed - emittedCompleted;
  return {
    tasks: [...rows],
    total,
    counts,
    ...(omitted > 0 ? { omitted } : {}),
    ...(archiveFields && completedHidden > 0 ? { completedHidden } : {}),
    ...(archiveFields && p.archived.length > 0 ? { archived: p.archived.length } : {}),
    updatedAt,
  };
}

/** Passes 2–3 of the budget ladder (pass 1 already ran inside `projectTask`). Every check
 *  measures the FINALIZED wire (see `finalize`). */
function fitBudget(
  rows: readonly TodoTaskWire[],
  p: TaskPartition,
  all: readonly Task[],
  updatedAt: number,
  archiveFields: boolean,
): TodoWire {
  let wire = finalize(rows, p, all, updatedAt, archiveFields);
  if (byteSize(wire) <= TODO_WIRE_BUDGET_BYTES) return wire;
  // Pass 2: drop whole descriptions (subject stays), tail-first so completed
  // rows (at the tail of the open-first order) lose theirs before open ones.
  const tasks = wire.tasks.map((task) => ({ ...task }));
  for (let i = tasks.length - 1; i >= 0; i--) {
    wire = finalize(tasks, p, all, updatedAt, archiveFields);
    if (byteSize(wire) <= TODO_WIRE_BUDGET_BYTES) return wire;
    const task = tasks[i]!;
    delete task.description;
    delete task.descTruncated;
  }
  // Pass 3: drop task rows from the tail; every dropped row (cap- or
  // budget-trimmed) lands in `omitted`. `updatedAt` keeps the pre-trim max —
  // it is a display hint about the *list's* recency, not a per-row invariant.
  while (tasks.length > 0) {
    wire = finalize(tasks, p, all, updatedAt, archiveFields);
    if (byteSize(wire) <= TODO_WIRE_BUDGET_BYTES) return wire;
    tasks.pop();
  }
  return finalize(tasks, p, all, updatedAt, archiveFields);
}

function byteSize(wire: TodoWire): number {
  return Buffer.byteLength(JSON.stringify(wire) ?? "", "utf8");
}
