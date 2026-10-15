// merge-plan revision S6: replayState is a pure function over the session
// branch entry list (caller passes ctx.sessionManager.getBranch()). It must
// recognize both historical shapes — `custom` entries with the
// "claude-code-todo-state" customType and `message` toolResult entries whose
// details carry a `state` snapshot — with the LAST valid candidate winning
// when they are interleaved.

import { describe, expect, test } from "vitest";
import {
  archiveCompleted,
  createTask,
  emptyState,
  replayState,
  STATE_ENTRY,
  type TodoState,
  updateTask,
} from "../../src/todo/state.js";

function stateWith(subject: string): TodoState {
  return createTask(emptyState(), { subject, description: `desc ${subject}` }, 1).state;
}

function customEntry(data: unknown): unknown {
  return { type: "custom", customType: STATE_ENTRY, data };
}

function toolResultEntry(state: unknown, isError = false): unknown {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "TaskCreate", isError, details: { state } },
  };
}

describe("replayState", () => {
  test("returns undefined for an empty branch", () => {
    expect(replayState([])).toBeUndefined();
  });

  test("restores from a custom entry (persisted snapshot)", () => {
    const state = stateWith("from custom");
    expect(replayState([customEntry(state)])).toEqual(state);
  });

  test("restores from a toolResult details.state snapshot", () => {
    const state = stateWith("from toolResult");
    expect(replayState([toolResultEntry(state)])).toEqual(state);
  });

  test("ignores unrelated entries and error toolResults", () => {
    const state = stateWith("kept");
    const entries = [
      { type: "custom", customType: "unrelated", data: stateWith("unrelated") },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "toolResult", isError: true, details: { state: stateWith("err") } } },
      { type: "message", message: { role: "toolResult", isError: false, details: {} } },
      { type: "message", message: { role: "toolResult", isError: false, details: null } },
      toolResultEntry(state),
    ];
    expect(replayState(entries)).toEqual(state);
    expect(replayState(entries.slice(0, 5))).toBeUndefined();
  });

  test("skips dirty candidates without failing the replay", () => {
    const state = stateWith("valid");
    const dirty = { tasks: [{ id: "x" }], nextId: 2 };
    expect(replayState([customEntry(dirty)])).toBeUndefined();
    expect(replayState([toolResultEntry(dirty)])).toBeUndefined();
    // A dirty entry after a valid one must not clobber the valid candidate.
    expect(replayState([customEntry(state), customEntry(dirty)])).toEqual(state);
    expect(replayState([toolResultEntry(state), toolResultEntry(dirty)])).toEqual(state);
  });

  test("mixed shapes: the last valid candidate wins", () => {
    const older = stateWith("older");
    const newer = updateTask(older, "1", { status: "completed" }, 2).state;

    // custom first, toolResult second → toolResult wins.
    expect(replayState([customEntry(older), toolResultEntry(newer)])).toEqual(newer);
    // toolResult first, custom second → custom wins.
    expect(replayState([toolResultEntry(older), customEntry(newer)])).toEqual(newer);
    // Same shape twice → the later entry wins.
    expect(replayState([customEntry(newer), customEntry(older)])).toEqual(older);
  });

  // ── todo-archive (plan §3): the two new optional fields must survive replay —
  // in BOTH historical shapes — and degrade per D2 on inconsistent data. ──

  test("carries archivedAt and completedAt forward through BOTH historical shapes", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 10).state;
    state = archiveCompleted(state, "all", 20);

    // The wire shape is the JSON round-trip persist() writes.
    const persisted = JSON.parse(JSON.stringify(state)) as unknown;
    expect(replayState([customEntry(persisted)])).toEqual(state);
    expect(replayState([toolResultEntry(persisted)])).toEqual(state);

    const restored = replayState([customEntry(persisted)])!;
    expect(restored.tasks[0]?.completedAt).toBe(10);
    expect(restored.tasks[0]?.archivedAt).toBe(20);
  });

  test("non-completed tasks carrying the fields keep the candidate valid with just the fields dropped", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    const dirty = {
      ...JSON.parse(JSON.stringify(state)),
      tasks: state.tasks.map((task) => ({ ...task, completedAt: 5, archivedAt: 6 })),
    } as unknown;
    const restored = replayState([customEntry(dirty)])!;
    expect(restored).toBeDefined();
    expect(restored.tasks[0]?.status).toBe("pending");
    expect(restored.tasks[0]?.completedAt).toBeUndefined();
    expect(restored.tasks[0]?.archivedAt).toBeUndefined();

    const sameViaToolResult = replayState([toolResultEntry(dirty)])!;
    expect(sameViaToolResult.tasks[0]?.completedAt).toBeUndefined();
  });

  test("non-finite timestamp values are dropped individually, candidate stays valid", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 10).state;
    const dirty = {
      ...JSON.parse(JSON.stringify(state)),
      tasks: state.tasks.map((task) => ({ ...task, completedAt: "yesterday", archivedAt: Number.NaN })),
    } as unknown;
    const restored = replayState([customEntry(dirty)])!;
    expect(restored.tasks[0]?.completedAt).toBeUndefined();
    expect(restored.tasks[0]?.archivedAt).toBeUndefined();
  });

  test("old entries (no new fields) round-trip identically", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 10).state;
    // Strip the new field entirely — the pre-feature persisted shape.
    const legacy = {
      ...state,
      tasks: state.tasks.map(({ ...task }) => {
        delete (task as { completedAt?: number }).completedAt;
        return task;
      }),
    } as unknown;
    const restored = replayState([customEntry(JSON.parse(JSON.stringify(legacy)))])!;
    expect(restored).toEqual(legacy);
    expect(restored.tasks[0]?.completedAt).toBeUndefined();
    expect(restored.tasks[0]?.archivedAt).toBeUndefined();
  });

  test("an unarchived snapshot after an archived one wins (last valid candidate)", () => {
    let state = emptyState();
    state = createTask(state, { subject: "A", description: "A" }, 1).state;
    state = updateTask(state, "1", { status: "completed" }, 10).state;
    const archived = archiveCompleted(state, "all", 20);
    // Reopen AFTER the archived snapshot: archivedAt/completedAt cleared again.
    const reopened = updateTask(archived, "1", { status: "pending" }, 30);

    expect(replayState([customEntry(archived), customEntry(reopened.state)])).toEqual(reopened.state);
    expect(replayState([customEntry(reopened.state), customEntry(archived)])).toEqual(archived);
  });
});
