// todo-archive-split #92 §8.3: pure-function tests for the persistence planner — planPersist,
// liveSnapshotOf, applyArchiveEntryToBase, canonicalKey. The end-to-end write-path scenarios
// (fake host, real wireTodo persist) live in tools.test.ts's "todo-archive-split §4.3" block;
// here we pin the EXACT payload shapes at the plan level.

import { describe, expect, test } from "vitest";
import {
  archiveCompleted,
  canonicalTask,
  clearTasks,
  createTask,
  deleteTask,
  emptyState,
  evictArchived,
  TODO_ARCHIVE_CAP,
  updateTask,
  type TodoState,
} from "../../src/todo/state.js";
import { applyArchiveEntryToBase, canonicalKey, liveSnapshotOf, planPersist } from "../../src/todo/persist-plan.js";

function key(base: Map<number, string>, ...states: TodoState[]): Map<number, string> {
  for (const state of states) {
    for (const task of state.tasks) {
      // canonicalKey of any task is stable regardless of which state it came from
      if (task.archivedAt !== undefined) base.set(task.id, canonicalKey(task));
    }
  }
  return base;
}

describe("planPersist (§4.1)", () => {
  test("#1 plain live change (create): only the live snapshot, no archive entries", () => {
    const state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    const plan = planPersist(state, new Map(), undefined);
    expect(plan.pre).toBeUndefined();
    expect(plan.post).toBeUndefined();
    expect(plan.live).toEqual({ v: 1, nextId: 2, tasks: [state.tasks[0]] });
    expect(plan.liveKey).toBe(JSON.stringify(plan.live));
  });

  test("#2 sweep archive: pre put (newly archived) THEN narrowed live", () => {
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    const swept = archiveCompleted(state, "all", 3);
    const base = new Map<number, string>();
    const baseLiveKey = JSON.stringify(liveSnapshotOf(state)); // pre-sweep live on disk
    const plan = planPersist(swept, base, baseLiveKey);
    expect(plan.pre).toEqual({ v: 1, put: [swept.tasks[0]] });
    expect(plan.live).toEqual({ v: 1, nextId: 2, tasks: [] }); // #1 archived out
    expect(plan.post).toBeUndefined();
  });

  test("#3 edit of an archived task: pre put ONLY — the live snapshot is dedup-skipped", () => {
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, "all", 3);
    const edited = updateTask(state, "1", { subject: "A2" }, 4).state;
    const base = key(new Map(), state);
    const liveKey = JSON.stringify(liveSnapshotOf(state)); // unchanged by the edit
    const plan = planPersist(edited, base, liveKey);
    expect(plan.pre).toEqual({ v: 1, put: [edited.tasks[0]] });
    expect(plan.live).toBeUndefined(); // dedup: live content unchanged
    expect(plan.liveKey).toBe(liveKey);
    expect(plan.post).toBeUndefined();
  });

  test("#4 reopen of an archived task: live (with the reopened task) THEN post drop", () => {
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, "all", 3);
    const reopened = updateTask(state, "1", { status: "pending" }, 4).state;
    const base = key(new Map(), state);
    const plan = planPersist(reopened, base, JSON.stringify(liveSnapshotOf(state)));
    expect(plan.pre).toBeUndefined();
    expect(plan.live?.tasks.map((task) => task.id)).toEqual([1]);
    expect(plan.live?.tasks[0]?.archivedAt).toBeUndefined();
    expect(plan.post).toEqual({ v: 1, drop: [1] });
  });

  test("#5 delete of an archived task: pruned ARCHIVE neighbors are put in the SAME package as the drop", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "d" }, 1).state; // #1
    state = createTask(state, { subject: "B", description: "d" }, 2).state; // #2
    state = updateTask(state, "1", { blockedBy: ["2"] }, 3).state; // #1 blockedBy #2
    state = updateTask(state, "2", { status: "completed" }, 4).state;
    state = updateTask(state, "1", { status: "completed" }, 5).state;
    state = archiveCompleted(state, "all", 6); // both archived; #1.blockedBy=[2] is inside A
    const base = key(new Map(), state);
    const liveKey = JSON.stringify(liveSnapshotOf(state));
    const afterDelete = deleteTask(state, "2").state; // #2 gone, #1's blockedBy pruned
    const plan = planPersist(afterDelete, base, liveKey);
    expect(plan.pre).toEqual({ v: 1, put: [afterDelete.tasks[0]], drop: [2] }); // atomic package
    expect(plan.pre!.put![0]!.blockedBy).toEqual([]);
    expect(plan.live).toBeUndefined(); // live snapshot never contained either task
    expect(plan.post).toBeUndefined();
  });

  test("#6 clear with a non-empty base: pre {v:1, reset:true} THEN the empty live snapshot", () => {
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = createTask(state, { subject: "B", description: "d" }, 2).state;
    state = updateTask(state, "1", { status: "completed" }, 3).state;
    state = archiveCompleted(state, "all", 4);
    const base = key(new Map(), state); // baseline: #1 archived, #2 live
    const liveKey = JSON.stringify(liveSnapshotOf(state)); // live still contains #2
    const cleared = clearTasks(state);
    const plan = planPersist(cleared, base, liveKey);
    expect(plan.pre).toEqual({ v: 1, reset: true });
    expect(plan.live).toEqual({ v: 1, nextId: 3, tasks: [] });
    expect(plan.post).toBeUndefined();
  });

  test("#6b clear with an EMPTY base: no reset — just the empty live snapshot", () => {
    const state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    const cleared = clearTasks(state);
    const plan = planPersist(cleared, new Map(), JSON.stringify(liveSnapshotOf(state)));
    expect(plan.pre).toBeUndefined();
    expect(plan.live).toEqual({ v: 1, nextId: 2, tasks: [] });
  });

  test("#7 cross-storage edge added on a live task: pre put of the archived endpoint, live strips the cross edge", () => {
    let state = emptyState();
    state = createTask(state, { subject: "X", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, "all", 3);
    const base = key(new Map(), state); // baseline captured BEFORE the cross edge exists
    state = createTask(state, { subject: "P", description: "d", blockedBy: ["1"] }, 4).state; // live P ← archived X
    const plan = planPersist(state, base, undefined);
    // X gained blocks:[2] — the authoritative copy goes to the archive side…
    expect(plan.pre).toEqual({ v: 1, put: [state.tasks[0]] });
    expect(plan.pre!.put![0]!.blocks).toEqual([2]);
    // …while the live snapshot keeps P WITHOUT the cross edge (OD1-c: self-contained).
    const liveP = plan.live!.tasks.find((task) => task.id === 2)!;
    expect(liveP.blockedBy).toEqual([]);
  });

  test("#8 migration (old-shape session, empty base): one-shot full put + live", () => {
    let state = emptyState();
    for (let i = 1; i <= 3; i++) {
      state = createTask(state, { subject: `t${i}`, description: "d" }, i).state;
      state = updateTask(state, String(i), { status: "completed" }, i + 10).state;
    }
    state = archiveCompleted(state, "all", 99);
    state = createTask(state, { subject: "live", description: "d" }, 100).state;
    const plan = planPersist(state, new Map(), undefined);
    expect(plan.pre?.put).toHaveLength(3); // every archived task, one-shot
    expect(plan.live?.tasks.map((task) => task.id)).toEqual([4]);
    expect(plan.post).toBeUndefined();
  });

  test("#9 eviction: >256 archived ⇒ eviction drop + pruned-archived-neighbor put share the SAME pre package", () => {
    let state = emptyState();
    // 257 archived tasks; #2 is blocked by #1 — an edge INSIDE the archived set, so the
    // pruned neighbor is itself archived (its fix travels as a put, not a live change).
    state = createTask(state, { subject: "t1", description: "d" }, 1).state;
    state = createTask(state, { subject: "t2", description: "d", blockedBy: ["1"] }, 2).state;
    for (let i = 3; i <= 257; i++) {
      state = createTask(state, { subject: `t${i}`, description: "d" }, i).state;
    }
    for (let i = 1; i <= 257; i++) {
      state = updateTask(state, String(i), { status: "completed" }, 1000 + i).state;
      state = archiveCompleted(state, [i], 2000 + i); // distinct archivedAt ⇒ #1 is the oldest
    }
    const base = key(new Map(), state); // on-disk fold: all 257 archived, #2 still blockedBy #1
    const liveKey = JSON.stringify(liveSnapshotOf(state));
    const afterEviction = evictArchived(state, TODO_ARCHIVE_CAP);
    expect(afterEviction.tasks).toHaveLength(256); // #1 (oldest) permanently evicted
    const plan = planPersist(afterEviction, base, liveKey);
    // Atomic §4.3 #9: the drop of the evicted id and the pruned neighbor's put are ONE package.
    expect(plan.pre).toEqual({
      v: 1,
      put: [afterEviction.tasks.find((task) => task.id === 2)!],
      drop: [1],
    });
    expect(plan.pre!.put![0]!.blockedBy).toEqual([]); // the pruned edge
    expect(plan.live).toBeUndefined(); // no live tasks ⇒ snapshot content unchanged
    expect(plan.post).toBeUndefined();
  });

  test("no change at all: zero entries (convergence guard)", () => {
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, "all", 3);
    const base = key(new Map(), state);
    const liveKey = JSON.stringify(liveSnapshotOf(state));
    const plan = planPersist(state, base, liveKey);
    expect(plan.pre).toBeUndefined();
    expect(plan.live).toBeUndefined();
    expect(plan.post).toBeUndefined();
  });

  test("reset shape still carries puts when an edited archived task coexists with a clear", () => {
    // Exotic: clear wiped two of three baseline entries but a re-put task is also pending —
    // the reset branch applies whenever gone covers the WHOLE base and nothing moved.
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, "all", 3);
    const base = key(new Map(), state);
    // Now clear AND re-create a completed+archived task in one step is not reachable via the
    // public API; approximate the shape directly: state has NO baseline ids, but a new archived task.
    const rebuilt: TodoState = {
      nextId: 10,
      tasks: [{ ...state.tasks[0]!, id: 9, subject: "new archived" }],
    };
    const plan = planPersist(rebuilt, base, undefined);
    expect(plan.pre).toEqual({ v: 1, reset: true, put: [rebuilt.tasks[0]] });
    expect(plan.live).toEqual({ v: 1, nextId: 10, tasks: [] });
  });
});

describe("liveSnapshotOf (§2.2, D13)", () => {
  test("unarchived completed tasks STAY in the live snapshot; cross edges are stripped on both ends", () => {
    let state = emptyState();
    state = createTask(state, { subject: "P", description: "d" }, 1).state; // #1 live
    state = createTask(state, { subject: "C", description: "d", blockedBy: ["1"] }, 2).state; // #2
    state = updateTask(state, "2", { status: "completed" }, 3).state; // completed, NOT archived
    state = createTask(state, { subject: "X", description: "d", blocks: ["1"] }, 4).state; // #3
    state = updateTask(state, "3", { status: "completed" }, 5).state;
    state = archiveCompleted(state, [3], 6); // X archived; X.blocks=[1] is now a cross edge
    const snapshot = liveSnapshotOf(state);
    expect(snapshot.v).toBe(1);
    expect(snapshot.nextId).toBe(4);
    expect(snapshot.tasks.map((task) => task.id)).toEqual([1, 2]); // P + completed-not-archived C
    // P↔C both live: their edges survive. X's copy of the edge does not exist here at all.
    expect(snapshot.tasks[0]?.blocks).toEqual([2]);
    expect(snapshot.tasks[1]?.blockedBy).toEqual([1]);
  });

  test("canonical field order makes the JSON key stable (metadata last-applied optional fields included)", () => {
    let state = emptyState();
    state = createTask(
      state,
      { subject: "A", description: "d", activeForm: "Doing", owner: "o", metadata: { k: 1 } },
      1,
    ).state;
    const snapshot = liveSnapshotOf(state);
    const keys = Object.keys(snapshot.tasks[0]!);
    expect(keys).toEqual([
      "id",
      "subject",
      "description",
      "activeForm",
      "status",
      "blocks",
      "blockedBy",
      "owner",
      "metadata",
      "createdAt",
      "updatedAt",
    ]);
    // Key order is what makes JSON.stringify stable across writes.
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(liveSnapshotOf(state)));
  });
});

describe("applyArchiveEntryToBase (§4.2)", () => {
  test("applies reset → put → drop and mirrors exactly what foldArchive does to the read side", () => {
    let state = createTask(emptyState(), { subject: "A", description: "d" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 2).state;
    state = archiveCompleted(state, "all", 3);
    const base = new Map<number, string>();
    applyArchiveEntryToBase(base, { v: 1, put: [state.tasks[0]!] });
    expect(base.get(1)).toBe(canonicalKey(state.tasks[0]!));
    applyArchiveEntryToBase(base, { v: 1, drop: [1] });
    expect(base.has(1)).toBe(false);
    applyArchiveEntryToBase(base, { v: 1, put: [state.tasks[0]!] });
    applyArchiveEntryToBase(base, { v: 1, reset: true });
    expect(base.size).toBe(0);
  });
});
