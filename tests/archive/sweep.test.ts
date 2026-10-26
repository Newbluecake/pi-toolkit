import { describe, expect, it } from "vitest";
import { emptyArchiveState, type ArchiveState } from "../../src/archive/state.js";
import { selectAutoArchives, type ArchiveCandidate } from "../../src/archive/sweep.js";

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
