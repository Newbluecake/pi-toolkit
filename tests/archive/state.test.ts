/**
 * Archive state model (src/archive/state.ts) — pure functions: round-trip,
 * sanitize/read-back, mutation idempotence, caps, holds, horizons and auto-eligibility.
 */
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_ENTRY_TYPE,
  archiveItem,
  archivedSetOf,
  autoArchiveDue,
  emptyArchiveState,
  horizonOf,
  isArchived,
  raiseHorizon,
  readArchiveState,
  sameArchiveState,
  sanitizeArchiveState,
  unarchiveItem,
  type ArchiveEntry,
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

describe("archive state: horizon sanitize (#91)", () => {
  it("a pre-#91 snapshot (no horizon field) sanitizes WITHOUT a horizon key — byte-identical", () => {
    const clean = sanitizeArchiveState({ entries: [{ kind: "run", id: "r1", at: 5 }], held: [] });
    expect(clean).toStrictEqual({ entries: [{ kind: "run", id: "r1", at: 5 }], held: [] });
    expect("horizon" in (clean ?? {})).toBe(false);
  });

  it("round-trips a horizon, both kinds independently", () => {
    const state = sanitizeArchiveState({
      entries: [{ kind: "run", id: "r1", at: 5, auto: true }],
      held: [],
      horizon: { run: 5, bash: 7 },
    });
    expect(state).toStrictEqual({
      entries: [{ kind: "run", id: "r1", at: 5, auto: true }],
      held: [],
      horizon: { run: 5, bash: 7 },
    });
    expect(sanitizeArchiveState({ entries: [], held: [], horizon: { run: 5 } })).toStrictEqual({
      entries: [],
      held: [],
      horizon: { run: 5 },
    });
    expect(
      readArchiveState([
        { type: "custom", customType: ARCHIVE_ENTRY_TYPE, data: { entries: [], held: [], horizon: { bash: 9 } } },
      ]).horizon,
    ).toEqual({ bash: 9 });
  });

  it("a bad horizon loses only its own field(s), never the snapshot", () => {
    // run invalid (string / NaN / Infinity), bash valid ⇒ run dropped, bash kept.
    expect(
      sanitizeArchiveState({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [], horizon: { run: "x", bash: 3 } }),
    ).toStrictEqual({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [], horizon: { bash: 3 } });
    expect(
      sanitizeArchiveState({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [], horizon: { run: Number.NaN } }),
    ).toStrictEqual({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [] });
    expect(
      sanitizeArchiveState({
        entries: [{ kind: "run", id: "ok", at: 5 }],
        held: [],
        horizon: { run: Number.POSITIVE_INFINITY, bash: Number.POSITIVE_INFINITY },
      }),
    ).toStrictEqual({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [] });
    // Non-object shapes (array, string) drop the whole horizon, entries survive.
    expect(
      sanitizeArchiveState({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [], horizon: [1, 2] }),
    ).toStrictEqual({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [] });
    expect(
      sanitizeArchiveState({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [], horizon: "soon" }),
    ).toStrictEqual({ entries: [{ kind: "run", id: "ok", at: 5 }], held: [] });
  });

  it("horizonOf defaults to −∞; raiseHorizon is monotone and kind-scoped", () => {
    expect(horizonOf(emptyArchiveState(), "run")).toBe(-Infinity);
    expect(horizonOf({ entries: [], held: [], horizon: { run: 5 } }, "bash")).toBe(-Infinity);
    expect(horizonOf({ entries: [], held: [], horizon: { run: 5 } }, "run")).toBe(5);
    let h = raiseHorizon(undefined, "run", 10);
    expect(h).toEqual({ run: 10 });
    h = raiseHorizon(h, "run", 7); // never moves down
    expect(h).toEqual({ run: 10 });
    h = raiseHorizon(h, "bash", 3); // the other kind untouched
    expect(h).toEqual({ run: 10, bash: 3 });
    h = raiseHorizon(h, "run", 12);
    expect(h).toEqual({ run: 12, bash: 3 });
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

  it("archiveItem(·, Infinity) does not truncate and passes the horizon through", () => {
    const state: ArchiveState = { entries: [], held: [], horizon: { run: 40 } };
    let next = archiveItem(state, { kind: "run", id: "r1", auto: true, now: 1 }, Infinity)!;
    for (let i = 2; i <= 300; i++) {
      next = archiveItem(next, { kind: "run", id: `r${i}`, auto: true, now: i }, Infinity) ?? next;
    }
    expect(next.entries).toHaveLength(300); // unbounded: trimToCap owns eviction
    expect(next.horizon).toEqual({ run: 40 });
    // …and the default cap still FIFO-truncates for any legacy caller.
    const capped = archiveItem(emptyArchiveState(), { kind: "run", id: "r1", auto: true, now: 1 })!;
    expect(capped.entries).toHaveLength(1);
  });

  it("mutations on a horizon-less state never invent a horizon key", () => {
    let state: ArchiveState = { entries: [], held: [] };
    state = archiveItem(state, { kind: "run", id: "r1", auto: true, now: 1 }, Infinity)!;
    expect("horizon" in state).toBe(false);
    state = unarchiveItem(state, { kind: "run", id: "r1" }, 2)!;
    expect("horizon" in state).toBe(false);
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

describe("archive state: sameArchiveState (#89 A1 dedup guard)", () => {
  it("empty states are equal; any real field difference is not", () => {
    expect(sameArchiveState(emptyArchiveState(), emptyArchiveState())).toBe(true);
    const base: ArchiveState = {
      entries: [
        { kind: "run", id: "r1", at: 1, auto: true },
        { kind: "bash", id: "b1", at: 2 },
      ],
      held: [{ kind: "run", id: "r2", at: 3 }],
    };
    expect(sameArchiveState(base, JSON.parse(JSON.stringify(base)))).toBe(true);
    // `at` participates: an at-only rewrite is NOT "the same state" for the guard.
    expect(
      sameArchiveState(base, { ...base, entries: [{ kind: "run", id: "r1", at: 99, auto: true }, base.entries[1]!] }),
    ).toBe(false);
    // kind / id / auto differences
    expect(
      sameArchiveState(base, { ...base, entries: [{ kind: "bash", id: "r1", at: 1, auto: true }, base.entries[1]!] }),
    ).toBe(false);
    expect(
      sameArchiveState(base, { ...base, entries: [{ kind: "run", id: "rx", at: 1, auto: true }, base.entries[1]!] }),
    ).toBe(false);
    expect(sameArchiveState(base, { ...base, entries: [{ kind: "run", id: "r1", at: 1 }, base.entries[1]!] })).toBe(
      false,
    );
  });

  it("is ORDER-sensitive: the same rows in a different order are not equal", () => {
    const a: ArchiveState = {
      entries: [
        { kind: "run", id: "r1", at: 1 },
        { kind: "run", id: "r2", at: 2 },
      ],
      held: [],
    };
    const b: ArchiveState = {
      entries: [
        { kind: "run", id: "r2", at: 2 },
        { kind: "run", id: "r1", at: 1 },
      ],
      held: [],
    };
    expect(sameArchiveState(a, b)).toBe(false);
  });

  it("treats an absent `auto` and an explicit non-true `auto` as equal (sanitize normalizes to absent)", () => {
    const plain: ArchiveEntry = { kind: "run", id: "r1", at: 1 };
    expect(sameArchiveState({ entries: [plain], held: [] }, { entries: [plain], held: [] })).toBe(true);
    const explicitFalse = { kind: "run", id: "r1", at: 1, auto: false } as unknown as ArchiveEntry;
    expect(sameArchiveState({ entries: [plain], held: [] }, { entries: [explicitFalse], held: [] })).toBe(true);
  });

  it("length mismatches and `held` differences count", () => {
    const base: ArchiveState = { entries: [{ kind: "run", id: "r1", at: 1 }], held: [] };
    expect(sameArchiveState(base, { entries: [], held: [] })).toBe(false);
    expect(sameArchiveState(base, { entries: base.entries, held: [{ kind: "run", id: "h1", at: 5 }] })).toBe(false);
    const withHold: ArchiveState = { entries: [], held: [{ kind: "run", id: "h1", at: 5 }] };
    expect(sameArchiveState(withHold, { entries: [], held: [{ kind: "run", id: "h1", at: 6 }] })).toBe(false);
  });

  it("a horizon-only difference is NOT equal (a horizon-only change is a real write)", () => {
    const base: ArchiveState = { entries: [{ kind: "run", id: "r1", at: 1 }], held: [] };
    expect(sameArchiveState(base, { entries: base.entries, held: [], horizon: { run: 5 } })).toBe(false);
    expect(sameArchiveState({ ...base, horizon: { run: 5 } }, { ...base, horizon: { run: 6 } })).toBe(false);
    expect(sameArchiveState({ ...base, horizon: { run: 5 } }, { ...base, horizon: { run: 5, bash: 5 } })).toBe(false);
    expect(sameArchiveState({ ...base, horizon: { run: 5 } }, { ...base, horizon: { run: 5 } })).toBe(true);
    expect(sameArchiveState({ ...base, horizon: { bash: 5 } }, { ...base, horizon: { run: 5 } })).toBe(false);
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

  it("settled at/below the horizon is never auto-due (boundary inclusive); kind-scoped", () => {
    const state: ArchiveState = { entries: [], held: [], horizon: { run: 100 } };
    expect(autoArchiveDue(state, { kind: "run", id: "r1" }, 99, 1e9, 60_000)).toBe(false);
    expect(autoArchiveDue(state, { kind: "run", id: "r1" }, 100, 1e9, 60_000)).toBe(false); // s == horizon
    expect(autoArchiveDue(state, { kind: "run", id: "r1" }, 101, 1e9, 60_000)).toBe(true);
    // bash has no horizon here — only the age gate applies.
    expect(autoArchiveDue(state, { kind: "bash", id: "b1" }, 100, 1e9, 60_000)).toBe(true);
  });
});
