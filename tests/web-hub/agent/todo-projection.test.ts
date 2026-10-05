// todo-web plan §3.2/§7 (T2): the StatusInfo.todo projection — caps, truncation,
// the three-pass byte budget, and the 1Hz light fingerprint's no-false-negative
// argument (pinned against the real state.ts mutation API).
import { describe, expect, it } from "vitest";
import {
  TODO_DESC_MAX_BYTES,
  TODO_WIRE_BUDGET_BYTES,
  TODO_WIRE_MAX_TASKS,
  projectTodo,
  todoLightFingerprint,
} from "../../../src/web-hub/agent/todo.js";
import type { TodoWire } from "../../../src/web-hub/protocol/messages.js";
import { createTask, deleteTask, updateTask, type Task, type TodoState } from "../../../src/todo/state.js";

function task(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    subject: `task ${id}`,
    description: `desc ${id}`,
    status: "pending",
    blocks: [],
    blockedBy: [],
    createdAt: id * 100,
    updatedAt: id * 100,
    ...over,
  };
}

function stateOf(tasks: Task[], nextId = tasks.length + 1): TodoState {
  return { tasks, nextId };
}

function wireBytes(wire: TodoWire): number {
  return Buffer.byteLength(JSON.stringify(wire), "utf8");
}

describe("projectTodo — basics", () => {
  it("empty task list ⇒ undefined (field omitted entirely)", () => {
    expect(projectTodo(stateOf([]))).toBeUndefined();
  });

  it("projects task fields; metadata/blocks/createdAt never cross the wire", () => {
    const t1 = task(1, {
      status: "in_progress",
      owner: "dev",
      activeForm: "wiring status.todo",
      metadata: { arbitrary: { nested: true } },
      createdAt: 1,
      updatedAt: 50,
    });
    const t2 = task(2, { subject: "blocker", status: "pending" }); // default updatedAt 200
    t1.blockedBy = [2];
    t2.blocks = [1];
    const wire = projectTodo(stateOf([t1, t2]))!;
    expect(wire.total).toBe(2);
    expect(wire.counts).toEqual({ open: 1, inProgress: 1, completed: 0, blocked: 1 });
    expect(wire.updatedAt).toBe(200); // max over the contained tasks
    expect(wire.tasks).toHaveLength(2);
    const row = wire.tasks.find((t) => t.id === 1)!;
    expect(row).toMatchObject({
      id: 1,
      subject: "task 1",
      status: "in_progress",
      owner: "dev",
      activeForm: "wiring status.todo",
      blockedBy: [2],
      description: "desc 1",
    });
    expect("metadata" in row).toBe(false);
    expect("blocks" in row).toBe(false);
    expect("createdAt" in row).toBe(false);
    expect("updatedAt" in row).toBe(false);
  });

  it("orderTasks order (completed sink); blockedBy keeps only OPEN blockers", () => {
    const t1 = task(1, { status: "pending", updatedAt: 1 });
    const t2 = task(2, { status: "completed", updatedAt: 2 });
    const t3 = task(3, { status: "pending", updatedAt: 3 });
    // #1 is blocked by #2 (completed ⇒ no longer blocking) and #3 (open ⇒ blocking)
    t1.blockedBy = [2, 3];
    const wire = projectTodo(stateOf([t1, t2, t3]))!;
    expect(wire.tasks.map((t) => t.id)).toEqual([1, 3, 2]); // completed #2 sinks
    expect(wire.tasks[0]!.blockedBy).toEqual([3]);
    expect(wire.counts).toEqual({ open: 2, inProgress: 0, completed: 1, blocked: 1 });
  });
});

describe("projectTodo — description truncation (pass 1)", () => {
  it("truncates at 240 UTF-8 bytes without splitting a code point; marks descTruncated", () => {
    const cjk80 = "任".repeat(80); // 80 × 3B = exactly 240B
    const cjk90 = "任".repeat(90); // 270B ⇒ must cut back to 80 chars / 240B
    const wire = projectTodo(stateOf([task(1, { description: cjk80 }), task(2, { description: cjk90 })]))!;
    expect(wire.tasks[0]!.description).toBe(cjk80);
    expect("descTruncated" in wire.tasks[0]!).toBe(false);
    expect(wire.tasks[1]!.description).toBe(cjk80); // 80 whole CJK chars, not 80.33
    expect(wire.tasks[1]!.descTruncated).toBe(true);
  });

  it("4-byte emoji never gets split at the cut", () => {
    const emoji = "🙂".repeat(200); // 800B ⇒ cut at 240B would land mid-emoji (240 % 4 == 0, but 238..239 windows too)
    const wire = projectTodo(stateOf([task(1, { description: emoji })]))!;
    const desc = wire.tasks[0]!.description!;
    expect(Buffer.byteLength(desc, "utf8")).toBeLessThanOrEqual(TODO_DESC_MAX_BYTES);
    expect(Buffer.byteLength(desc, "utf8")).toBeGreaterThanOrEqual(TODO_DESC_MAX_BYTES - 3);
    expect(desc).toMatch(/^🙂+$/u); // only whole code points (u-flag: 🙂 is one code point, not a surrogate pair)
    expect(wire.tasks[0]!.descTruncated).toBe(true);
  });

  it("empty description string is omitted", () => {
    const wire = projectTodo(stateOf([task(1, { description: "" })]))!;
    expect("description" in wire.tasks[0]!).toBe(false);
    expect("descTruncated" in wire.tasks[0]!).toBe(false);
  });
});

describe("projectTodo — caps and the byte budget (passes 0–3)", () => {
  it("more than 32 tasks ⇒ 32 rows, full-population total/counts, omitted counts the rest", () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task(i + 1, { status: i < 35 ? "pending" : "completed", updatedAt: i + 1 }),
    );
    const wire = projectTodo(stateOf(tasks, 41))!;
    expect(wire.tasks).toHaveLength(TODO_WIRE_MAX_TASKS);
    expect(wire.total).toBe(40);
    expect(wire.omitted).toBe(8);
    expect(wire.counts).toEqual({ open: 35, inProgress: 0, completed: 5, blocked: 0 });
    // orderTasks sinks completed ⇒ the kept 32 are the open ones (ids 1..32)
    expect(wire.tasks[0]!.id).toBe(1);
    expect(wire.tasks.at(-1)!.id).toBe(32);
    expect(wire.updatedAt).toBe(32); // max over the CONTAINED tasks
  });

  it("pass 2: over budget ⇒ whole descriptions dropped tail-first, row count and subject survive", () => {
    // 25 rows × (600B subject + 450B owner + 240B truncated description + structure) ≈ 34.7 KB —
    // over the 32 KiB budget after pass 1, comfortably under it once descriptions are gone.
    const subject = "任".repeat(200);
    const owner = "务".repeat(150);
    const description = "描".repeat(100); // 300B ⇒ pass-1 truncates to 240B
    const tasks = Array.from({ length: 25 }, (_, i) =>
      task(i + 1, { subject, owner, description, status: i < 5 ? "completed" : "pending" }),
    );
    const wire = projectTodo(stateOf(tasks, 26))!;
    expect(wireBytes(wire)).toBeLessThanOrEqual(TODO_WIRE_BUDGET_BYTES);
    expect(wire.tasks).toHaveLength(25); // no rows dropped ⇒ no omitted
    expect(wire.omitted).toBeUndefined();
    expect(wire.tasks.every((t) => t.subject === subject)).toBe(true);
    const withDesc = wire.tasks.filter((t) => t.description !== undefined);
    const withoutDesc = wire.tasks.filter((t) => t.description === undefined);
    // Tail-first: completed rows (sunk to the end by orderTasks) lost theirs first,
    // and the head rows kept theirs — the ladder really prefers descriptions over rows.
    expect(withoutDesc.length).toBeGreaterThan(0);
    expect(withDesc.length).toBeGreaterThan(0);
    expect(wire.tasks.slice(-withoutDesc.length).every((t) => t.description === undefined)).toBe(true);
    expect(wire.tasks.slice(0, withDesc.length).every((t) => t.description !== undefined)).toBe(true);
  });

  it("pass 3: still over budget after all descriptions are gone ⇒ rows drop from the tail into omitted", () => {
    // 18 rows × (600B subject + 600B owner + 600B activeForm + 240B desc) ≈ 38 KB; with every
    // description gone still ≈ 33.8 KB ⇒ the row-count pass must fire.
    const blob = "任".repeat(200);
    const tasks = Array.from({ length: 18 }, (_, i) =>
      task(i + 1, { subject: blob, owner: blob, activeForm: blob, description: blob, updatedAt: i + 1 }),
    );
    const wire = projectTodo(stateOf(tasks, 19))!;
    expect(wireBytes(wire)).toBeLessThanOrEqual(TODO_WIRE_BUDGET_BYTES);
    expect(wire.tasks.length).toBeLessThan(18);
    expect(wire.total).toBe(18);
    expect(wire.omitted).toBe(18 - wire.tasks.length);
    // reaching pass 3 means pass 2 stripped every description
    expect(wire.tasks.every((t) => t.description === undefined)).toBe(true);
    // the head (oldest open) rows survive
    expect(wire.tasks[0]!.id).toBe(1);
  });
});

describe("todoLightFingerprint — the tick gate", () => {
  it("identical states hash identically; the projection-affecting fields ride updatedAt/total", () => {
    const a = stateOf([task(1, { updatedAt: 10 }), task(2, { updatedAt: 20 })]);
    const b = stateOf([task(1, { updatedAt: 10 }), task(2, { updatedAt: 20 })]);
    expect(todoLightFingerprint(a)).toBe(todoLightFingerprint(b));
  });

  it("NO false negatives via the real mutation API: every persisted change flips the fingerprint", () => {
    let state: TodoState = { tasks: [], nextId: 1 };
    let fp = todoLightFingerprint(state);

    const created = createTask(state, { subject: "s", description: "d" });
    state = created.state;
    expect(todoLightFingerprint(state)).not.toBe(fp);
    fp = todoLightFingerprint(state);

    // subject/description edits — the exact case the light fingerprint must not miss —
    // updateTask always advances updatedAt when anything actually changed.
    const edited = updateTask(state, 1, { subject: "s2", description: "d2" }, 12345);
    state = edited.state;
    expect(edited.changed).toBe(true);
    expect(todoLightFingerprint(state)).not.toBe(fp);
    fp = todoLightFingerprint(state);

    // unchanged updateTask keeps the old state object ⇒ same fingerprint, same projection
    const unchanged = updateTask(state, 1, { subject: "s2" }, 99999);
    expect(unchanged.changed).toBe(false);
    expect(todoLightFingerprint(unchanged.state)).toBe(fp);

    const deleted = deleteTask(state, 1);
    expect(todoLightFingerprint(deleted.state)).not.toBe(fp);
  });
});
