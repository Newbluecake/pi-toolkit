// merge-plan revision S6: replayState is a pure function over the session
// branch entry list (caller passes ctx.sessionManager.getBranch()). It must
// recognize both historical shapes — `custom` entries with the
// "claude-code-todo-state" customType and `message` toolResult entries whose
// details carry a `state` snapshot — with the LAST valid candidate winning
// when they are interleaved.

import { describe, expect, test } from "vitest";
import { createTask, emptyState, replayState, STATE_ENTRY, type TodoState, updateTask } from "../../src/todo/state.js";

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
});
