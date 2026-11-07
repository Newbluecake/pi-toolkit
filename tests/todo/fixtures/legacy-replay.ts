/**
 * todo-archive-split plan §8.2 (评审 Nit #5)：改动前 `src/todo/state.ts` 里
 * `restoreState` / `replayState` / `validateState` 及其闭包私有依赖的**逐字冻结副本**。
 *
 * 落位说明：freeze 先例 `legacy-quota-schema.ts` 实际位于 `tests/web-hub/protocol/`；
 * 本文件按 plan 落在 `tests/todo/fixtures/`——它不在 A 级冻结目录 `tests/fixtures/`
 * 范围内（那是仓库根的 fixtures，prettier/发布脚本另有规则），因此可以在此新建。
 *
 * DO NOT EDIT（除随 vitest/import 语法升级外）。用途只有两个：
 *  1. 段 2 等价 fuzz：对只含旧形状（STATE_ENTRY custom 条目 + toolResult details.state）
 *     的随机分支，断言新的 `replayState` 与这份冻结实现 deep-equal——证明「没有归档包 ⇒
 *     与改动前逐字节一致」这条验收线（OD4）。
 *  2. OD1-c 降级证明：用这份冻结副本读**新格式**分支（live 快照 + 归档包），断言结果
 *     非 undefined、open 任务集合与 nextId 与新读者一致、归档任务缺席。
 *
 * 依赖口径：只 `import type`（类型在运行时擦除，不会随实现漂移）；`STATE_ENTRY` 字符串、
 * `BranchEntry` 形状与全部函数体**逐字拷贝自 #92 改动前的工作区**（含原本的注释）。
 */
import type { Task, TaskStatus, TodoState } from "../../../src/todo/state.js";

/** verbatim "claude-code-todo-state"（merge-plan D3 / I7 钉死的字符串）。 */
const STATE_ENTRY = "claude-code-todo-state";

/** Verbatim copy of state.ts's BranchEntry (structural view). */
type BranchEntry = {
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

// ---- verbatim pre-#92 copy (do not edit) ---------------------------------------------------

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && STATUSES.includes(value as TaskStatus);
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

export function legacyRestoreState(value: unknown): TodoState | undefined {
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
      // todo-archive D2: the two optional timestamps survive restore only as finite numbers on a
      // completed task; otherwise just the field is dropped — the candidate state stays valid.
      ...(isFiniteTimestamp(task.completedAt) && task.status === "completed" ? { completedAt: task.completedAt } : {}),
      ...(isFiniteTimestamp(task.archivedAt) && task.status === "completed" ? { archivedAt: task.archivedAt } : {}),
    });
  }
  const state = { tasks, nextId: Math.max(record.nextId, 1) };
  try {
    legacyValidateState(state);
  } catch {
    return undefined;
  }
  return state;
}

export function legacyReplayState(entries: readonly unknown[]): TodoState | undefined {
  let restored: TodoState | undefined;
  for (const raw of entries) {
    const entry = raw as BranchEntry;
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      const candidate = legacyRestoreState(entry.data);
      if (candidate) restored = candidate;
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult" || message.isError) continue;
    if (!message.details || typeof message.details !== "object") continue;
    const details = message.details as { state?: unknown };
    const candidate = legacyRestoreState(details.state);
    if (candidate) restored = candidate;
  }
  return restored;
}

export function legacyValidateState(state: TodoState): void {
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
