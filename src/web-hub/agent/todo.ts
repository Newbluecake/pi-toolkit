/**
 * todo-web plan §3.2 (T2): the `StatusInfo.todo` projection + its 1Hz-tick
 * fingerprint.
 *
 * `projectTodo` turns the live `TodoState` closure (main session only — the
 * getter is threaded from `wireTodo` through src/index.ts) into a bounded
 * `TodoWire`. Budget is layered ("三段削"):
 *
 *   1. every `description` is truncated to TODO_DESC_MAX_BYTES (UTF-8
 *      code-point-safe via protocol/keys.ts's `truncateText`), subject kept;
 *   2. only if the serialized wire still exceeds TODO_WIRE_BUDGET_BYTES are
 *      whole descriptions dropped (tail-first — `orderTasks` sinks completed
 *      tasks to the end, so their least-actionable descriptions go first);
 *   3. still over budget, task rows themselves are dropped from the tail,
 *      folded into `omitted`.
 *
 * `todoLightFingerprint` is the 1Hz-tick gate (fleet's `lastFleetFp` pattern):
 * it hashes only `{id,status,updatedAt}` + total. Every todo mutation either
 * advances some task's `updatedAt` or changes the population (`createTask`
 * always stamps now, `updateTask` leaves `updatedAt` untouched only when
 * nothing changed — and unchanged means nothing was persisted either,
 * `deleteTask` changes total), so subject/description edits cannot slip
 * through undetected; a false positive (updatedAt moved, content equivalent)
 * only sends one extra frame.
 *
 * Cross-directory dependency on `../../todo/state.js` is intentional and
 * legal (pure functions, zero pi imports — same ruling as plan §3.2).
 */
import { truncateText } from "../protocol/keys.js";
import type { TodoWire, TodoTaskWire } from "../protocol/messages.js";
import { activeBlockers, orderTasks, type Task, type TodoState } from "../../todo/state.js";

/** Web projection caps (plan §0 预算行): 32 rows, 240-byte descriptions, 32 KiB hard budget. */
export const TODO_WIRE_MAX_TASKS = 32;
export const TODO_DESC_MAX_BYTES = 240;
export const TODO_WIRE_BUDGET_BYTES = 32 << 10;

/** Empty task list ⇒ `undefined` ⇒ the `todo` field is omitted entirely (byte-equal to pre-feature). */
export function projectTodo(state: TodoState): TodoWire | undefined {
  const all = state.tasks;
  if (all.length === 0) return undefined;
  const ordered = orderTasks(all).slice(0, TODO_WIRE_MAX_TASKS);
  const wire: TodoWire = {
    tasks: ordered.map((task) => projectTask(task, all)),
    total: all.length,
    counts: countsOf(all),
    ...(all.length > ordered.length ? { omitted: all.length - ordered.length } : {}),
    updatedAt: ordered.reduce((max, task) => Math.max(max, task.updatedAt), 0),
  };
  return fitBudget(wire);
}

/** Cheap change-detection key for the 1Hz tick — never serializes subjects/descriptions. */
export function todoLightFingerprint(state: TodoState): string {
  return JSON.stringify({
    total: state.tasks.length,
    tasks: state.tasks.map((task) => ({ id: task.id, status: task.status, updatedAt: task.updatedAt })),
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

/** Full-population counts; `blocked` mirrors the TUI widget (non-completed + open blocker). */
function countsOf(all: readonly Task[]): TodoWire["counts"] {
  let open = 0;
  let inProgress = 0;
  let completed = 0;
  let blocked = 0;
  for (const task of all) {
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

/** Passes 2–3 of the budget ladder (pass 1 already ran inside `projectTask`). */
function fitBudget(wire: TodoWire): TodoWire {
  if (byteSize(wire) <= TODO_WIRE_BUDGET_BYTES) return wire;
  // Pass 2: drop whole descriptions (subject stays), tail-first so completed
  // tasks (sunk to the end by orderTasks) lose theirs before open ones.
  const tasks = wire.tasks.map((task) => ({ ...task }));
  let fitted: TodoWire = { ...wire, tasks };
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (byteSize(fitted) <= TODO_WIRE_BUDGET_BYTES) break;
    const task = tasks[i]!;
    delete task.description;
    delete task.descTruncated;
  }
  if (byteSize(fitted) <= TODO_WIRE_BUDGET_BYTES) return fitted;
  // Pass 3: drop task rows from the tail; every dropped row (cap- or
  // budget-trimmed) lands in `omitted`. `updatedAt` keeps the pre-trim max —
  // it is a display hint about the *list's* recency, not a per-row invariant.
  while (tasks.length > 0 && byteSize(fitted) > TODO_WIRE_BUDGET_BYTES) tasks.pop();
  const omitted = wire.total - tasks.length;
  fitted = {
    ...fitted,
    tasks: [...tasks],
    ...(omitted > 0 ? { omitted } : {}),
  };
  return fitted;
}

function byteSize(wire: TodoWire): number {
  return Buffer.byteLength(JSON.stringify(wire) ?? "", "utf8");
}
