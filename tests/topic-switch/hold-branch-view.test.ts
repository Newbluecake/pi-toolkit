// todo-archive-split #92 §8.4 reader regression: `buildBranchView`'s `todoInProgress` gate
// reads the todo state through the SAME `replayState` choke point as the todo module itself,
// so a SPLIT-format branch (narrowed `claude-code-todo-state` live snapshot +
// `claude-code-todo-archive` incremental packages) must keep reporting an in-progress task —
// hold.ts itself has zero code changes for the split format. No pre-existing buildBranchView
// test file existed (gate tests stub BranchView directly); this file pins the todo edge only.

import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildBranchView } from "../../src/topic-switch/hold.js";
import { ARCHIVE_ENTRY, STATE_ENTRY } from "../../src/todo/state.js";

function custom(customType: string, data: unknown): SessionEntry {
  return { type: "custom", customType, data } as unknown as SessionEntry;
}

describe("topic-switch buildBranchView · todoInProgress on a split-format branch", () => {
  it("an in_progress task in the narrowed live snapshot keeps the gate closed (todoInProgress=true)", () => {
    const branch: SessionEntry[] = [
      custom(ARCHIVE_ENTRY, {
        v: 1,
        put: [
          {
            id: 1,
            subject: "archived predecessor",
            description: "d",
            status: "completed",
            blocks: [2], // authoritative cross edge (OD1-c) — live side stripped it
            blockedBy: [],
            createdAt: 1,
            updatedAt: 2,
            completedAt: 2,
            archivedAt: 100,
          },
        ],
      }),
      custom(STATE_ENTRY, {
        v: 1,
        nextId: 3,
        tasks: [
          {
            id: 2,
            subject: "wiring the split storage",
            description: "d",
            status: "in_progress",
            blocks: [],
            blockedBy: [],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      }),
    ];
    const view = buildBranchView(branch);
    expect(view.todoInProgress).toBe(true);
  });

  it("a split branch whose live tasks are all pending reports todoInProgress=false", () => {
    const branch: SessionEntry[] = [
      custom(ARCHIVE_ENTRY, { v: 1, put: [] }),
      custom(STATE_ENTRY, {
        v: 1,
        nextId: 2,
        tasks: [
          {
            id: 1,
            subject: "only pending",
            description: "d",
            status: "pending",
            blocks: [],
            blockedBy: [],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      }),
    ];
    expect(buildBranchView(branch).todoInProgress).toBe(false);
  });
});
