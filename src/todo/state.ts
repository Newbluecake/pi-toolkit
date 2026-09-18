// Ported from pi-claude-todo (MIT, author is this repository's user) — src/state.ts.
// Strict-mode adaptations per docs/dev/plugin-merge/merge-plan.md D4.2; replayState
// moved here from the source's index.ts and made a pure function (revision S6).

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
 * Presentation order: open tasks (pending/in_progress) keep their relative
 * creation order, completed tasks sink to the bottom. The stored array order
 * is never mutated — apply this at display/serialization boundaries.
 */
export function orderTasks(tasks: readonly Task[]): Task[] {
  const open: Task[] = [];
  const completed: Task[] = [];
  for (const task of tasks) {
    (task.status === "completed" ? completed : open).push(task);
  }
  return [...open, ...completed];
}

export function restoreState(value: unknown): TodoState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { tasks?: unknown; nextId?: unknown };
  if (!Array.isArray(record.tasks) || typeof record.nextId !== "number" || !Number.isInteger(record.nextId))
    return undefined;
  const tasks: Task[] = [];
  for (const raw of record.tasks) {
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
    tasks.push({
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
    });
  }
  const state = { tasks, nextId: Math.max(record.nextId, 1) };
  try {
    validateState(state);
  } catch {
    return undefined;
  }
  return state;
}

/**
 * Pure replay (merge-plan revision S6): scans a session-branch entry list
 * (caller passes `ctx.sessionManager.getBranch()`) and rebuilds the todo
 * state from history. Two historical shapes are recognized, and when they
 * are interleaved the LAST valid candidate wins:
 *
 * 1. `custom` entries with customType STATE_ENTRY (written by persist()).
 * 2. `message` entries with role "toolResult" whose details carry a `state`
 *    snapshot (written into tool results by earlier versions / forks).
 *
 * Dirty candidates are skipped individually via restoreState; returns
 * undefined when nothing valid was found.
 */
export function replayState(entries: readonly unknown[]): TodoState | undefined {
  let restored: TodoState | undefined;
  for (const raw of entries) {
    const entry = raw as BranchEntry;
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      const candidate = restoreState(entry.data);
      if (candidate) restored = candidate;
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult" || message.isError) continue;
    if (!message.details || typeof message.details !== "object") continue;
    const details = message.details as { state?: unknown };
    const candidate = restoreState(details.state);
    if (candidate) restored = candidate;
  }
  return restored;
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

function cloneTask(task: Task): Task {
  return {
    ...task,
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  };
}
