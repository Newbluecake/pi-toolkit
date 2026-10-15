// todo-web plan §3.2/§7 (T2) + todo-archive plan v2.1 §2/§3 (D5/D7): the StatusInfo.todo
// projection — caps, truncation, the three-pass byte budget, the archive fold (open-first
// rows, archived never counted, full-list dependency lookups) and the 1Hz light
// fingerprint's no-false-negative argument (pinned against the real state.ts mutation API).
import { describe, expect, it } from "vitest";
import {
  TODO_DESC_MAX_BYTES,
  TODO_RECENT_COMPLETED,
  TODO_WIRE_BUDGET_BYTES,
  TODO_WIRE_MAX_TASKS,
  projectTodo,
  todoLightFingerprint,
} from "../../../src/web-hub/agent/todo.js";
import type { TodoWire } from "../../../src/web-hub/protocol/messages.js";
import {
  archiveCompleted,
  createTask,
  deleteTask,
  updateTask,
  type Task,
  type TodoState,
} from "../../../src/todo/state.js";

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

const noArchive = { archiveFields: false } as const;
const withArchive = { archiveFields: true } as const;

describe("projectTodo — basics", () => {
  it("empty task list ⇒ undefined (field omitted entirely)", () => {
    expect(projectTodo(stateOf([]), noArchive)).toBeUndefined();
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
    const wire = projectTodo(stateOf([t1, t2]), noArchive)!;
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

  it("open-first order with recent completed at the tail; blockedBy keeps only OPEN blockers", () => {
    const t1 = task(1, { status: "pending", updatedAt: 1 });
    const t2 = task(2, { status: "completed", updatedAt: 2, completedAt: 2 });
    const t3 = task(3, { status: "pending", updatedAt: 3 });
    // #1 is blocked by #2 (completed ⇒ no longer blocking) and #3 (open ⇒ blocking)
    t1.blockedBy = [2, 3];
    const wire = projectTodo(stateOf([t1, t2, t3]), noArchive)!;
    expect(wire.tasks.map((t) => t.id)).toEqual([1, 3, 2]); // open stored order, completed tail
    expect(wire.tasks[0]!.blockedBy).toEqual([3]);
    expect(wire.counts).toEqual({ open: 2, inProgress: 0, completed: 1, blocked: 1 });
  });
});

describe("projectTodo — todo-archive D5: the fold", () => {
  it("archived tasks are excluded from rows/total/counts entirely", () => {
    const t1 = task(1, { status: "completed", completedAt: 10, archivedAt: 99, updatedAt: 10 });
    const t2 = task(2, { status: "pending" });
    const wire = projectTodo(stateOf([t1, t2]), withArchive)!;
    expect(wire.tasks.map((t) => t.id)).toEqual([2]);
    expect(wire.total).toBe(1); // archived #1 not counted
    expect(wire.counts).toEqual({ open: 1, inProgress: 0, completed: 0, blocked: 0 });
    expect(wire.archived).toBe(1);
    expect(wire.omitted).toBeUndefined();
    expect(wire.completedHidden).toBeUndefined();
  });

  it("archived-ONLY task list ⇒ undefined (no visible tasks)", () => {
    const t1 = task(1, { status: "completed", completedAt: 10, archivedAt: 99, updatedAt: 10 });
    expect(projectTodo(stateOf([t1]), withArchive)).toBeUndefined();
    expect(projectTodo(stateOf([t1]), noArchive)).toBeUndefined();
  });

  it("completed beyond the recent-3 fold: emitted rows + omitted/completedHidden bookkeeping", () => {
    // 2 open + 5 completed (ids 3..7, completion order by id) ⇒ rows = [open×2, recent 3],
    // total = 7, omitted = 2 (folded #3/#4), completedHidden = 5 − 3 = 2.
    const tasks = [
      task(1, { status: "pending" }),
      task(2, { status: "in_progress" }),
      ...Array.from({ length: 5 }, (_, i) =>
        task(3 + i, { status: "completed", completedAt: 100 + i, updatedAt: 100 + i }),
      ),
    ];
    const wire = projectTodo(stateOf(tasks), withArchive)!;
    expect(wire.tasks.map((t) => t.id)).toEqual([1, 2, 5, 6, 7]); // recent 3 = ids 5,6,7 ascending
    expect(wire.total).toBe(7);
    expect(wire.counts.completed).toBe(5);
    expect(wire.omitted).toBe(2);
    expect(wire.completedHidden).toBe(2);
    // the legacy shape (archiveFields:false) carries the SAME fold in omitted alone
    const legacy = projectTodo(stateOf(tasks), noArchive)!;
    expect(legacy.omitted).toBe(2);
    expect("completedHidden" in legacy).toBe(false);
    expect("archived" in legacy).toBe(false);
  });

  it("archiveFields:false never emits either new field, even with folded/archived tasks", () => {
    const tasks = [
      task(1, { status: "pending" }),
      task(2, { status: "completed", completedAt: 10, archivedAt: 99, updatedAt: 10 }),
      ...Array.from({ length: 5 }, (_, i) =>
        task(3 + i, { status: "completed", completedAt: 100 + i, updatedAt: 100 + i }),
      ),
    ];
    const wire = projectTodo(stateOf(tasks), noArchive)!;
    expect(JSON.stringify(wire)).not.toContain("completedHidden");
    expect(JSON.stringify(wire)).not.toContain("archived");
  });

  it("archived fields emitted only when > 0 (archiveFields:true, zero values stay absent)", () => {
    // 1 open + 1 completed (emitted as recent) + no archived ⇒ no new fields even with the cap.
    const tasks = [task(1, { status: "pending" }), task(2, { status: "completed", completedAt: 5, updatedAt: 5 })];
    const wire = projectTodo(stateOf(tasks), withArchive)!;
    expect(wire.tasks).toHaveLength(2);
    expect("completedHidden" in wire).toBe(false);
    expect("archived" in wire).toBe(false);
  });

  it("D7 regression: an archived COMPLETED predecessor does not block its successor", () => {
    const t1 = task(1, { status: "completed", completedAt: 10, archivedAt: 99, updatedAt: 10 });
    const t2 = task(2, { status: "pending" });
    t1.blocks = [2];
    t2.blockedBy = [1];
    const wire = projectTodo(stateOf([t1, t2]), withArchive)!;
    const row = wire.tasks.find((t) => t.id === 2)!;
    expect(row.blockedBy).toEqual([]); // full-list lookup: archived-completed #1 still unblocks
    expect(wire.counts.blocked).toBe(0);
  });
});

describe("projectTodo — caps and the byte budget (passes 0–3)", () => {
  it("more than 32 visible tasks ⇒ 32 rows (open first), full non-archived total/counts, omitted counts the rest", () => {
    const tasks = Array.from({ length: 40 }, (_, i) =>
      task(i + 1, { status: i < 35 ? "pending" : "completed", updatedAt: i + 1 }),
    );
    const wire = projectTodo(stateOf(tasks, 41), withArchive)!;
    expect(wire.tasks).toHaveLength(TODO_WIRE_MAX_TASKS);
    expect(wire.total).toBe(40);
    expect(wire.omitted).toBe(8);
    expect(wire.counts).toEqual({ open: 35, inProgress: 0, completed: 5, blocked: 0 });
    // open tasks fill the cap first (ids 1..32), the recent completed never make the cut
    expect(wire.tasks[0]!.id).toBe(1);
    expect(wire.tasks.at(-1)!.id).toBe(32);
    expect(wire.tasks.every((t) => t.status !== "completed")).toBe(true);
    expect(wire.updatedAt).toBe(32); // max over the CONTAINED tasks
    // the five completed are all folded: emitted 0, counts.completed 5
    expect(wire.completedHidden).toBe(5);
    expect(0).toBeLessThanOrEqual(wire.completedHidden!);
    expect(wire.completedHidden!).toBeLessThanOrEqual(wire.omitted!);
  });

  it("pass 2: over budget ⇒ whole descriptions dropped tail-first, row count and subject survive", () => {
    // 24 rows (21 open + 3 recent completed; one more completed folded into omitted) ×
    // (600B subject + 450B owner + 240B truncated description + structure) ≈ 33.4 KB —
    // over the 32 KiB budget after pass 1, comfortably under it once descriptions are gone.
    const subject = "任".repeat(200);
    const owner = "务".repeat(150);
    const description = "描".repeat(100); // 300B ⇒ pass-1 truncates to 240B
    const tasks = [
      ...Array.from({ length: 21 }, (_, i) => task(i + 1, { subject, owner, description, status: "pending" })),
      ...Array.from({ length: 4 }, (_, i) =>
        task(22 + i, { subject, owner, description, status: "completed", completedAt: 500 + i, updatedAt: 500 + i }),
      ),
    ];
    const wire = projectTodo(stateOf(tasks, 26), noArchive)!;
    expect(wireBytes(wire)).toBeLessThanOrEqual(TODO_WIRE_BUDGET_BYTES);
    expect(wire.tasks).toHaveLength(24); // 21 open + 3 recent completed
    expect(wire.total).toBe(25);
    expect(wire.omitted).toBe(1); // the 4th completed folded
    expect(wire.tasks.every((t) => t.subject === subject)).toBe(true);
    const withDesc = wire.tasks.filter((t) => t.description !== undefined);
    const withoutDesc = wire.tasks.filter((t) => t.description === undefined);
    // Tail-first: completed rows (at the tail of the open-first order) lost theirs first,
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
    const wire = projectTodo(stateOf(tasks, 19), noArchive)!;
    expect(wireBytes(wire)).toBeLessThanOrEqual(TODO_WIRE_BUDGET_BYTES);
    expect(wire.tasks.length).toBeLessThan(18);
    expect(wire.total).toBe(18);
    expect(wire.omitted).toBe(18 - wire.tasks.length);
    // reaching pass 3 means pass 2 stripped every description
    expect(wire.tasks.every((t) => t.description === undefined)).toBe(true);
    // the head (oldest open) rows survive
    expect(wire.tasks[0]!.id).toBe(1);
  });

  it("boundary (v2.1 review #7): stage-3 trim keeps the finalized-wire invariants + final bytes ≤ 32 KiB", () => {
    // 40 open with fat fields + 5 completed: the 32-row cap admits only open tasks, pass 2
    // strips every description, pass 3 must drop open rows from the tail — with the metadata
    // (omitted/completedHidden/archived) already finalized at EVERY byte decision.
    const blob = "任".repeat(200);
    const tasks = [
      ...Array.from({ length: 40 }, (_, i) =>
        task(i + 1, { subject: blob, owner: blob, activeForm: blob, description: blob, updatedAt: i + 1 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        task(41 + i, {
          subject: "done",
          description: "d",
          status: "completed",
          completedAt: 500 + i,
          updatedAt: 500 + i,
        }),
      ),
    ];
    const wire = projectTodo(stateOf(tasks, 46), withArchive)!;
    const bytes = wireBytes(wire);
    expect(bytes).toBeLessThanOrEqual(TODO_WIRE_BUDGET_BYTES);
    expect(wireBytes(wire)).toBe(bytes); // stable — the returned object IS the measured one
    // invariant 1: omitted === total − tasks.length
    expect(wire.omitted).toBe(wire.total - wire.tasks.length);
    // invariant 2: completedHidden === counts.completed − emitted completed rows
    const emittedCompleted = wire.tasks.filter((t) => t.status === "completed").length;
    expect(wire.completedHidden).toBe(wire.counts.completed - emittedCompleted);
    // invariant 3+4: 0 ≤ completedHidden ≤ omitted
    expect(wire.completedHidden!).toBeGreaterThanOrEqual(0);
    expect(wire.completedHidden!).toBeLessThanOrEqual(wire.omitted!);
    // reaching stage 3: every surviving row lost its description, rows dropped from the tail
    expect(wire.tasks.every((t) => t.description === undefined)).toBe(true);
    expect(wire.tasks.length).toBeLessThan(TODO_WIRE_MAX_TASKS);
    expect(wire.tasks[0]!.id).toBe(1);
    expect(wire.tasks.map((t) => t.id)).toEqual(Array.from({ length: wire.tasks.length }, (_, i) => i + 1));
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

  it("todo-archive: an ARCHIVE-ONLY change flips the fingerprint (archiving never touches updatedAt)", () => {
    const tasks = [task(1, { status: "completed", completedAt: 10, updatedAt: 10 }), task(2, { status: "pending" })];
    const before = stateOf(tasks);
    const fp = todoLightFingerprint(before);
    const after = archiveCompleted(before, "all", 99);
    expect(after).not.toBe(before); // really archived something
    expect(after.tasks[0]!.updatedAt).toBe(10); // D2: updatedAt untouched
    expect(todoLightFingerprint(after)).not.toBe(fp);
  });

  it("same population, differing only in archive bits ⇒ differing fingerprints (per-row `a`)", () => {
    const plain = task(1, { status: "completed", completedAt: 10, updatedAt: 10 });
    const archived = { ...plain, archivedAt: 99 };
    expect(todoLightFingerprint(stateOf([plain]))).not.toBe(todoLightFingerprint(stateOf([archived])));
  });
});

describe("projectTodo — TODO_RECENT_COMPLETED fold constant", () => {
  it("the fold width is 3 (partitionTasks recentCount)", () => {
    expect(TODO_RECENT_COMPLETED).toBe(3);
  });
});
