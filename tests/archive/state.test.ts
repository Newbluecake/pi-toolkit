/**
 * Archive state model (src/archive/state.ts) — pure functions: round-trip,
 * sanitize/read-back, mutation idempotence, caps, holds and auto-eligibility.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_ENTRY_TYPE,
  archiveItem,
  archivedSetOf,
  autoArchiveDue,
  emptyArchiveState,
  isArchived,
  readArchiveState,
  sanitizeArchiveState,
  unarchiveItem,
  type ArchiveState,
} from "../../src/archive/state.js";

const NOW = 1_000_000;

describe("archive state: sanitize + read-back", () => {
  it("round-trips a full state through sanitizeArchiveState", () => {
    const state: ArchiveState = {
      entries: [
        { kind: "run", id: "run-1", at: NOW, auto: true },
        { kind: "bash", id: "b_TEST", at: NOW + 1 },
      ],
      held: [{ kind: "run", id: "run-2", at: NOW + 2 }],
    };
    expect(sanitizeArchiveState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects non-objects and entries without an entries array", () => {
    expect(sanitizeArchiveState(undefined)).toBeUndefined();
    expect(sanitizeArchiveState(null)).toBeUndefined();
    expect(sanitizeArchiveState("x")).toBeUndefined();
    expect(sanitizeArchiveState({ held: [] })).toBeUndefined();
  });

  it("drops individual bad rows but keeps the snapshot", () => {
    const clean = sanitizeArchiveState({
      entries: [
        { kind: "run", id: "ok", at: 5 },
        { kind: "nope", id: "x", at: 5 },
        { kind: "run", id: "", at: 5 },
        { kind: "bash", id: "bad-at", at: "yesterday" },
      ],
      held: [
        { kind: "run", id: "h", at: 6 },
        { kind: "run", id: "h-bad" },
      ],
    });
    expect(clean).toEqual({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [{ kind: "run", id: "h", at: 6 }] });
  });

  it("readArchiveState takes the LAST valid entry off the branch", () => {
    const branch = [
      { type: "custom", customType: ARCHIVE_ENTRY_TYPE, data: { entries: [{ kind: "run", id: "old", at: 1 }] } },
      { type: "custom", customType: "claude-code-todo-state", data: {} },
      { type: "custom", customType: ARCHIVE_ENTRY_TYPE, data: { entries: [{ kind: "bash", id: "new", at: 2 }] } },
    ];
    expect(readArchiveState(branch)).toEqual({ entries: [{ kind: "bash", id: "new", at: 2 }], held: [] });
  });

  it("readArchiveState skips corrupt archive entries and returns empty on none", () => {
    expect(readArchiveState([{ type: "custom", customType: ARCHIVE_ENTRY_TYPE, data: { nope: 1 } }])).toEqual(
      emptyArchiveState(),
    );
    expect(readArchiveState([])).toEqual(emptyArchiveState());
  });
});

describe("archive state: mutations", () => {
  it("archiveItem adds an entry and is idempotent for the same auto flag", () => {
    let state = emptyArchiveState();
    const next = archiveItem(state, { kind: "run", id: "r1", auto: false, now: NOW });
    expect(next).toEqual({ entries: [{ kind: "run", id: "r1", at: NOW }], held: [] });
    // Same-direction repeat: no change ⇒ same reference semantics (undefined).
    expect(archiveItem(next!, { kind: "run", id: "r1", auto: false, now: NOW + 5 })).toBeUndefined();
  });

  it("re-archiving with a different auto flag updates the entry (auto badge follows the last op)", () => {
    const state: ArchiveState = { entries: [{ kind: "run", id: "r1", at: NOW, auto: true }], held: [] };
    const next = archiveItem(state, { kind: "run", id: "r1", auto: false, now: NOW + 10 });
    expect(next).toEqual({ entries: [{ kind: "run", id: "r1", at: NOW + 10 }], held: [] });
  });

  it("archiveItem lifts an existing hold", () => {
    const state: ArchiveState = {
      entries: [],
      held: [{ kind: "run", id: "r1", at: NOW }],
    };
    const next = archiveItem(state, { kind: "run", id: "r1", auto: true, now: NOW + 1 });
    expect(next).toEqual({ entries: [{ kind: "run", id: "r1", at: NOW + 1, auto: true }], held: [] });
  });

  it("unarchiveItem removes the entry and records a hold (auto-archive exemption)", () => {
    const state: ArchiveState = { entries: [{ kind: "bash", id: "b1", at: NOW }], held: [] };
    const next = unarchiveItem(state, { kind: "bash", id: "b1" }, NOW + 1);
    expect(next).toEqual({ entries: [], held: [{ kind: "bash", id: "b1", at: NOW + 1 }] });
    // Unarchiving something not archived: no change.
    expect(unarchiveItem(next!, { kind: "bash", id: "b1" }, NOW + 2)).toBeUndefined();
  });

  it("caps entries and holds FIFO at 256", () => {
    let state: ArchiveState = { entries: [], held: [] };
    for (let i = 0; i < 300; i++) {
      const next = archiveItem(state, { kind: "run", id: `r${i}`, auto: false, now: i });
      if (next !== undefined) state = next;
    }
    expect(state.entries).toHaveLength(256);
    expect(state.entries[0]).toEqual({ kind: "run", id: "r44", at: 44 });
    // Unarchiving the 44 evicted ids is a no-op (not archived); the 256 archived ones all hold.
    for (let i = 0; i < 300; i++) {
      const next = unarchiveItem(state, { kind: "run", id: `r${i}` }, i);
      if (next !== undefined) state = next;
    }
    expect(state.held).toHaveLength(256);
    expect(state.entries).toHaveLength(0);
  });

  it("isArchived and archivedSetOf partition by kind", () => {
    const state: ArchiveState = {
      entries: [
        { kind: "run", id: "r1", at: 1 },
        { kind: "bash", id: "b1", at: 2 },
      ],
      held: [],
    };
    expect(isArchived(state, { kind: "run", id: "r1" })).toBe(true);
    expect(isArchived(state, { kind: "bash", id: "r1" })).toBe(false);
    expect(archivedSetOf(state, "run")).toEqual(new Set(["r1"]));
    expect(archivedSetOf(state, "bash")).toEqual(new Set(["b1"]));
  });
});

describe("archive state: auto eligibility", () => {
  it("requires the threshold to have passed", () => {
    const state = emptyArchiveState();
    const afterMs = 30 * 60_000;
    expect(autoArchiveDue(state, { kind: "run", id: "r1" }, NOW, NOW + afterMs - 1, afterMs)).toBe(false);
    expect(autoArchiveDue(state, { kind: "run", id: "r1" }, NOW, NOW + afterMs, afterMs)).toBe(true);
  });

  it("never re-auto-archives an archived or held item, and 0 disables", () => {
    const archived: ArchiveState = { entries: [{ kind: "run", id: "r1", at: 1 }], held: [] };
    expect(autoArchiveDue(archived, { kind: "run", id: "r1" }, 0, 1e9, 60_000)).toBe(false);
    const held: ArchiveState = { entries: [], held: [{ kind: "run", id: "r1", at: 1 }] };
    expect(autoArchiveDue(held, { kind: "run", id: "r1" }, 0, 1e9, 60_000)).toBe(false);
    expect(autoArchiveDue(emptyArchiveState(), { kind: "run", id: "r1" }, 0, 1e9, 0)).toBe(false);
  });
});
