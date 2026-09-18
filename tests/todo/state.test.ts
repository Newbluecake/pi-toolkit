// Ported from pi-claude-todo (MIT) — src/__tests__/state.test.ts (7 tests),
// plus merge-plan D5 additions: restoreState round-trip and dirty-data rejection.

import { describe, expect, test } from "vitest";
import {
  cloneState,
  createTask,
  deleteTask,
  emptyState,
  orderTasks,
  restoreState,
  updateTask,
} from "../../src/todo/state.js";

describe("claude todo state", () => {
  test("creates tasks and keeps dependency edges bidirectional", () => {
    let state = emptyState();
    const first = createTask(state, { subject: "Inspect code", description: "Read the existing implementation" }, 1);
    state = first.state;
    const second = createTask(
      state,
      {
        subject: "Implement change",
        description: "Make the requested change",
        blockedBy: ["1"],
      },
      2,
    );

    expect(second.task.id).toBe(2);
    expect(second.state.tasks[1]?.blockedBy).toEqual([1]);
    expect(second.state.tasks[0]?.blocks).toEqual([2]);
  });

  test("rejects dependency cycles without mutating the input state", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = createTask(state, { subject: "B", description: "B", blockedBy: ["1"] }, 2).state;
    const before = JSON.stringify(state);

    expect(() => updateTask(state, "1", { blocks: ["2"], blockedBy: ["2"] }, 3)).toThrow("Dependency cycle detected");
    expect(JSON.stringify(state)).toBe(before);
  });

  test("updates and deletes dependency edges", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = createTask(state, { subject: "B", description: "B", blockedBy: ["1"] }, 2).state;

    const updated = updateTask(state, "2", { removeBlockedBy: ["1"], status: "in_progress" }, 3);
    expect(updated.changed).toBe(true);
    expect(updated.state.tasks[1]?.blockedBy).toEqual([]);
    expect(updated.state.tasks[0]?.blocks).toEqual([]);

    const deleted = deleteTask(updated.state, "1");
    expect(deleted.state.tasks.map((task) => task.id)).toEqual([2]);
  });

  test("recognizes no-op updates", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    const result = updateTask(state, "1", { status: "pending" }, 2);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
  });

  describe("orderTasks", () => {
    test("completed tasks sink to the bottom, preserving relative order", () => {
      let state = emptyState();
      state = createTask(state, { subject: "A", description: "A" }, 1).state;
      state = createTask(state, { subject: "B", description: "B" }, 2).state;
      state = createTask(state, { subject: "C", description: "C" }, 3).state;
      state = updateTask(state, "1", { status: "completed" }, 4).state;

      expect(orderTasks(state.tasks).map((task) => task.id)).toEqual([2, 3, 1]);
      // stored order is untouched — ordering is presentation-only
      expect(state.tasks.map((task) => task.id)).toEqual([1, 2, 3]);
    });

    test("multiple completed tasks keep their relative order at the bottom", () => {
      let state = emptyState();
      state = createTask(state, { subject: "A", description: "A" }, 1).state;
      state = createTask(state, { subject: "B", description: "B" }, 2).state;
      state = createTask(state, { subject: "C", description: "C" }, 3).state;
      state = updateTask(state, "3", { status: "completed" }, 4).state;
      state = updateTask(state, "1", { status: "completed" }, 5).state;

      expect(orderTasks(state.tasks).map((task) => task.id)).toEqual([2, 1, 3]);
    });

    test("reopened tasks float back up to their original position", () => {
      let state = emptyState();
      state = createTask(state, { subject: "A", description: "A" }, 1).state;
      state = createTask(state, { subject: "B", description: "B" }, 2).state;
      state = updateTask(state, "1", { status: "completed" }, 3).state;
      state = updateTask(state, "1", { status: "pending" }, 4).state;

      expect(orderTasks(state.tasks).map((task) => task.id)).toEqual([1, 2]);
    });
  });

  describe("restoreState", () => {
    test("round-trips a state built through the mutation API", () => {
      let state = emptyState();
      state = createTask(
        state,
        { subject: "A", description: "A", activeForm: "Doing A", owner: "agent", metadata: { k: 1 } },
        1,
      ).state;
      state = createTask(state, { subject: "B", description: "B", blockedBy: ["1"] }, 2).state;
      state = updateTask(state, "1", { status: "completed" }, 3).state;

      // Persist goes through appendEntry → JSON serialization; the restore
      // path must accept exactly that shape.
      const persisted = JSON.parse(JSON.stringify(cloneState(state))) as unknown;
      expect(restoreState(persisted)).toEqual(state);
    });

    test("rejects non-object and structurally invalid data", () => {
      expect(restoreState(undefined)).toBeUndefined();
      expect(restoreState(null)).toBeUndefined();
      expect(restoreState("state")).toBeUndefined();
      expect(restoreState({})).toBeUndefined();
      expect(restoreState({ tasks: "nope", nextId: 1 })).toBeUndefined();
      expect(restoreState({ tasks: [], nextId: 1.5 })).toBeUndefined();
      expect(restoreState({ tasks: [], nextId: "1" })).toBeUndefined();
    });

    test("rejects tasks with invalid fields", () => {
      const valid = createTask(emptyState(), { subject: "A", description: "A" }, 1).state;
      const task = valid.tasks[0]!;
      expect(restoreState({ tasks: [{ ...task, status: "done" }], nextId: 2 })).toBeUndefined();
      expect(restoreState({ tasks: [{ ...task, id: 0 }], nextId: 2 })).toBeUndefined();
      expect(restoreState({ tasks: [{ ...task, subject: 42 }], nextId: 2 })).toBeUndefined();
      expect(restoreState({ tasks: [{ ...task, blockedBy: ["1"] }], nextId: 2 })).toBeUndefined();
      expect(restoreState({ tasks: [null], nextId: 2 })).toBeUndefined();
    });

    test("rejects dangling dependency references and cycles", () => {
      const base = createTask(emptyState(), { subject: "A", description: "A" }, 1).state.tasks[0]!;
      // blockedBy points at a task that does not exist.
      expect(restoreState({ tasks: [{ ...base, blockedBy: [99] }], nextId: 2 })).toBeUndefined();
      // Bidirectional violation: 1 blocks 2, but 2 does not list 1 in blockedBy.
      const a = { ...base, id: 1, blocks: [2], blockedBy: [] };
      const b = { ...base, id: 2, blocks: [], blockedBy: [] };
      expect(restoreState({ tasks: [a, b], nextId: 3 })).toBeUndefined();
      // Cycle: 1 blockedBy 2 and 2 blockedBy 1 (bidirectionally consistent).
      const c = { ...base, id: 1, blocks: [2], blockedBy: [2] };
      const d = { ...base, id: 2, blocks: [1], blockedBy: [1] };
      expect(restoreState({ tasks: [c, d], nextId: 3 })).toBeUndefined();
    });
  });
});
