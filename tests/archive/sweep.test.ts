import { describe, expect, it } from "vitest";
import { ARCHIVE_ENTRIES_CAP, archiveItem, emptyArchiveState, type ArchiveState } from "../../src/archive/state.js";
import { liveKey, selectAutoArchives, trimToCap, type ArchiveCandidate } from "../../src/archive/sweep.js";

const policy = { afterMs: 100, keepRuns: 6, keepBash: 5 };
function rows(kind: "run" | "bash", count: number): ArchiveCandidate[] {
  return Array.from({ length: count }, (_, i) => ({ kind, id: `${kind}-${i}`, terminal: true, settledAt: i }));
}
function ids(candidates: ArchiveCandidate[], state = emptyArchiveState(), overrides = {}) {
  return selectAutoArchives(state, candidates, 1000, { ...policy, ...overrides }).map((item) => item.id);
}

describe("fleet auto-archive count + age gates", () => {
  it("retains all old items at or below the thresholds", () => {
    expect(ids([...rows("run", 6), ...rows("bash", 5)])).toEqual([]);
    expect(ids([...rows("run", 2), ...rows("bash", 1)])).toEqual([]);
  });

  it("selects only the oldest excess items, irrespective of input order, without mutating inputs", () => {
    const candidates = rows("run", 9).reverse();
    const before = structuredClone(candidates);
    const state = emptyArchiveState();
    expect(ids(candidates, state)).toEqual(["run-0", "run-1", "run-2"]);
    expect(candidates).toEqual(before);
    expect(state).toEqual(emptyArchiveState());
  });

  it("stops when no more items meet the time gate, including the exact age boundary", () => {
    const candidates = rows("run", 9).map((item, i) => ({ ...item, settledAt: i < 2 ? 899 + i : 901 + i }));
    expect(ids(candidates)).toEqual(["run-0", "run-1"]);
    expect(ids(rows("run", 7).map((item) => ({ ...item, settledAt: 901 })))).toEqual([]);
  });

  it("counts held items but never selects them, even if holds alone exceed the keep count", () => {
    const state: ArchiveState = { entries: [], held: [{ kind: "run", id: "run-0", at: 999 }] };
    expect(ids(rows("run", 7), state)).toEqual(["run-1"]);
    const held = rows("run", 8).map(({ kind, id }) => ({ kind, id, at: 999 }));
    expect(ids(rows("run", 9), { entries: [], held })).toEqual(["run-8"]);
  });

  it("0 means legacy time-only selection, still respecting holds and age", () => {
    const state: ArchiveState = { entries: [], held: [{ kind: "run", id: "run-0", at: 999 }] };
    expect(
      ids([...rows("run", 3), { kind: "run", id: "fresh", terminal: true, settledAt: 901 }], state, { keepRuns: 0 }),
    ).toEqual(["run-1", "run-2"]);
    expect(ids(rows("bash", 2), emptyArchiveState(), { keepBash: 0 })).toEqual(["bash-0", "bash-1"]);
  });

  it("counts agent and bash independently", () => {
    expect(ids([...rows("run", 7), ...rows("bash", 5)])).toEqual(["run-0"]);
    expect(ids([...rows("run", 6), ...rows("bash", 7)])).toEqual(["bash-0", "bash-1"]);
    expect(ids([...rows("run", 8), ...rows("bash", 6)])).toEqual(["run-0", "run-1", "bash-0"]);
  });

  it("neither counts nor selects running or archived items; duplicate ids count once", () => {
    const candidates = [
      ...rows("run", 6),
      ...rows("run", 4).map((item) => ({ ...item, id: `active-${item.id}`, terminal: false })),
    ];
    expect(ids(candidates)).toEqual([]);
    const state: ArchiveState = { entries: [{ kind: "run", id: "run-0", at: 1 }], held: [] };
    expect(ids(rows("run", 7), state)).toEqual([]);
    expect(ids([...rows("run", 6), ...rows("run", 6)])).toEqual([]);
  });

  it("afterMs=0 stays off regardless of count gates", () => {
    expect(
      ids([...rows("run", 9), ...rows("bash", 9)], emptyArchiveState(), { afterMs: 0, keepRuns: 0, keepBash: 0 }),
    ).toEqual([]);
  });
});

describe("implicit archive: the settled horizon (#91)", () => {
  it("items settled at/below the horizon neither count toward keep nor get selected; held still counts", () => {
    // 6 unarchived runs settled BELOW the horizon plus one fresh one: without the
    // horizon exclusion the count would be 7 > keep-6 and the oldest (implicit)
    // item would be selected. With it, only the fresh item counts — nothing to do.
    const state: ArchiveState = { entries: [], held: [], horizon: { run: 50 } };
    const candidates = [
      ...rows("run", 6).map((item) => ({ ...item, settledAt: 10 + item.settledAt })), // 10..15 ≤ 50
      { kind: "run", id: "run-fresh", terminal: true, settledAt: 900 },
    ];
    expect(ids(candidates, state)).toEqual([]);
    // Over the keep count with eligible fresh items: only the FRESH ones are picked,
    // even though the implicit ones are far older. (8 counted − keep 6 = 2.)
    const fresh = Array.from({ length: 7 }, (_, i) => ({
      kind: "run" as const,
      id: `f-${i}`,
      terminal: true,
      settledAt: 900,
    }));
    expect(ids([...candidates, ...fresh], state)).toEqual(["run-fresh", "f-0"]);
    // The horizon is per kind: a bash item settled below horizon.run still counts.
    expect(ids([...rows("bash", 6), { kind: "bash", id: "b-x", terminal: true, settledAt: 900 }], state)).toEqual([
      "bash-0",
      "bash-1",
    ]);
  });

  it("a held item settled below the horizon still counts toward keep (hold beats horizon)", () => {
    const state: ArchiveState = {
      entries: [],
      held: [{ kind: "run", id: "run-held", at: 999 }],
      horizon: { run: 500 },
    };
    const candidates = [
      { kind: "run", id: "run-held", terminal: true, settledAt: 100 },
      ...rows("run", 6).map((item) => ({ ...item, settledAt: 600 + item.settledAt })),
    ];
    // held + 6 = 7 counted > keep-6: the oldest NON-held eligible item goes, never the hold.
    expect(ids(candidates, state)).toEqual(["run-0"]);
  });
});

describe("cap-full progression (#91: selection is unclamped, trimToCap owns capacity)", () => {
  /** The live map control would build: every candidate keyed by liveKey. */
  const liveMap = (candidates: readonly ArchiveCandidate[]): Map<string, number> => {
    const live = new Map<string, number>();
    for (const c of candidates) {
      const key = liveKey(c.kind, c.id);
      if (!live.has(key)) live.set(key, c.settledAt);
    }
    return live;
  };

  it("selects the FULL excess past the cap — no room truncation (the pre-#91 stall, inverted)", () => {
    // 300 live terminal runs, keep 6 ⇒ 294 selected. The pre-#91 clamp cut this to
    // `archiveRoom` (free + gone); on a full live fleet that was 0 — the #91 stall.
    const picked = ids(rows("run", 300));
    expect(picked).toHaveLength(294);
    expect(picked[0]).toBe("run-0");
    expect(picked[picked.length - 1]).toBe("run-293");
  });

  it("trimToCap keeps the newest-settled 256, folds the rest into the horizon in the same pass", () => {
    const candidates = rows("run", 300);
    const selected = selectAutoArchives(emptyArchiveState(), candidates, 1000, policy);
    expect(selected).toHaveLength(294);
    let state: ArchiveState = emptyArchiveState();
    for (const item of selected) {
      state = archiveItem(state, { kind: item.kind, id: item.id, auto: true, now: 1000 }, Infinity) ?? state;
    }
    expect(state.entries).toHaveLength(294); // folded unbounded — trim owns the cap
    const next = trimToCap(state, liveMap(candidates), new Set());
    expect(next.entries).toHaveLength(ARCHIVE_ENTRIES_CAP);
    expect(next.entries[0]?.id).toBe("run-38"); // newest-settled 256 win the contest…
    expect(next.entries[next.entries.length - 1]?.id).toBe("run-293");
    expect(next.horizon).toEqual({ run: 37 }); // …the oldest 37 SELECTED items lose it same-pass
    expect(next.entries.some((e) => e.id === "run-0")).toBe(false);
  });

  it("a full-live cap + new arrivals evicts the oldest-settled LIVE entries (not “room=0, select nothing”)", () => {
    // The intentionally INVERTED pre-#91 assertion: a 256-entry state of live entries
    // used to yield selection [] (room 0). Now the selection is the full excess and
    // trimToCap evicts the 2 oldest-settled live entries for the 2 new arrivals.
    const candidates = rows("run", 300);
    let state: ArchiveState = emptyArchiveState();
    for (let i = 0; i < ARCHIVE_ENTRIES_CAP; i++) {
      state = archiveItem(state, { kind: "run", id: `run-${i}`, auto: true, now: 1 }, Infinity) ?? state;
    }
    expect(ids(candidates, state)).toHaveLength(38); // 300 − 256 archived − keep 6
    for (const item of selectAutoArchives(state, candidates, 1000, policy)) {
      state = archiveItem(state, { kind: item.kind, id: item.id, auto: true, now: 1000 }, Infinity) ?? state;
    }
    const next = trimToCap(state, liveMap(candidates), new Set());
    expect(next.entries).toHaveLength(ARCHIVE_ENTRIES_CAP);
    expect(next.horizon).toEqual({ run: 37 });
    expect(next.entries.some((e) => e.id === "run-0")).toBe(false); // evicted: oldest-settled live
    expect(next.entries.some((e) => e.id === "run-37")).toBe(false);
    expect(next.entries.some((e) => e.id === "run-38")).toBe(true); // survives: settled above the new horizon
  });

  it("gone entries are evicted first (P1) and do not raise the horizon", () => {
    // 256 archived runs of which run-0/run-1 have LEFT the candidate lists, plus 8
    // fresh arrivals ⇒ selection 2 (8 counted − keep 6), overflow 2: the two GONE
    // entries are the victims — live entries stay, the horizon does not move.
    const candidates = [
      ...rows("run", 256).filter((c) => c.id !== "run-0" && c.id !== "run-1"),
      ...Array.from({ length: 8 }, (_, i) => ({
        kind: "run" as const,
        id: `f-${i}`,
        terminal: true,
        settledAt: 800 + i, // all comfortably past the age gate at now=1000
      })),
    ];
    let state: ArchiveState = emptyArchiveState();
    for (let i = 0; i < ARCHIVE_ENTRIES_CAP; i++) {
      state = archiveItem(state, { kind: "run", id: `run-${i}`, auto: true, now: 1 }, Infinity) ?? state;
    }
    const selected = selectAutoArchives(state, candidates, 1000, policy);
    expect(selected.map((s) => s.id)).toEqual(["f-0", "f-1"]);
    for (const item of selected) {
      state = archiveItem(state, { kind: item.kind, id: item.id, auto: true, now: 1000 }, Infinity) ?? state;
    }
    const next = trimToCap(state, liveMap(candidates), new Set());
    expect(next.entries).toHaveLength(ARCHIVE_ENTRIES_CAP);
    expect(next.entries.some((e) => e.id === "run-0" || e.id === "run-1")).toBe(false); // the gone ones
    expect(next.entries.some((e) => e.id === "run-2")).toBe(true); // live entries untouched
    expect(next.entries.some((e) => e.id === "f-0" || e.id === "f-1")).toBe(true); // the arrivals
    expect(next.horizon).toBeUndefined(); // gone victims never move the watermark
  });

  it("no overflow ⇒ the SAME reference (callers rely on reference identity for change detection)", () => {
    const state = emptyArchiveState();
    expect(trimToCap(state, new Map(), new Set())).toBe(state);
    const full = archiveItem(emptyArchiveState(), { kind: "run", id: "r", auto: true, now: 1 }, Infinity)!;
    expect(trimToCap(full, new Map(), new Set())).toBe(full);
  });
});
