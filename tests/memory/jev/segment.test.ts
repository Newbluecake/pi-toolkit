// jev-plan §4 J6: segment record — seeding, dedup, latches by turnSeq,
// compaction reset, cap 30.

import { describe, expect, test } from "vitest";
import { MEMORY_RECALL_CUSTOM_TYPE, SEGMENT_MAX_INJECTED } from "../../../src/memory/jev/contracts.js";
import { createSegmentState, recallRecord, type BranchEntryLike } from "../../../src/memory/jev/segment.js";

const rec = (layer: "U" | "A" | "E" | "B", keys: string[], extra: { bFor?: string } = {}): BranchEntryLike => ({
  type: "custom",
  customType: MEMORY_RECALL_CUSTOM_TYPE,
  data: recallRecord(layer, keys, extra),
});
const compaction = (id: string): BranchEntryLike => ({ type: "compaction", id });

describe("createSegmentState", () => {
  test("markInjected dedups within the segment and reports only accepted hashes", () => {
    const s = createSegmentState();
    expect(s.markInjected("U", ["a", "b", "a"])).toEqual(["a", "b"]);
    expect(s.markInjected("A", ["b", "c"])).toEqual(["c"]);
    expect(s.isInjected("a")).toBe(true);
    expect(s.isInjected("z")).toBe(false);
    expect(s.count()).toBe(3);
    expect(s.stats().byLayer).toEqual({ U: 2, A: 1 });
    expect(s.lastInjected(2)).toEqual(["c", "b"]);
  });

  test("cap: injections stop at SEGMENT_MAX_INJECTED", () => {
    const s = createSegmentState();
    const keys = Array.from({ length: SEGMENT_MAX_INJECTED + 5 }, (_, i) => `h${i}`);
    expect(s.markInjected("U", keys)).toHaveLength(SEGMENT_MAX_INJECTED);
    expect(s.full()).toBe(true);
    expect(s.markInjected("U", ["late"])).toEqual([]);
  });

  test("seed rebuilds the current segment from recall records after the last compaction (reload/resume)", () => {
    const s = createSegmentState();
    s.seed([rec("U", ["old1"]), compaction("c1"), rec("U", ["n1", "n2"]), rec("A", ["n3"]), { type: "message" }]);
    expect(s.isInjected("old1")).toBe(false);
    expect(s.isInjected("n1")).toBe(true);
    expect(s.isInjected("n3")).toBe(true);
    expect(s.count()).toBe(3);
    expect(s.compactionId()).toBe("c1");
    // previous segment had injections and no B record for c1 ⇒ pending B
    expect(s.pendingReinject()).toEqual({ compactionId: "c1", hashes: ["old1"] });
    // reseeding is idempotent
    s.seed([rec("U", ["old1"]), compaction("c1"), rec("U", ["n1", "n2"]), rec("A", ["n3"])]);
    expect(s.count()).toBe(3);
  });

  test("a B record tagged bFor=<last compaction> marks the re-injection done", () => {
    const s = createSegmentState();
    s.seed([rec("U", ["a", "b"]), compaction("c1"), rec("B", ["a", "b"], { bFor: "c1" })]);
    expect(s.pendingReinject()).toBeUndefined();
    expect(s.isInjected("a")).toBe(true);
  });

  test("latches take effect only once turnSeq advances, and survive a same-segment reseed", () => {
    const s = createSegmentState();
    s.latch("g1", 5);
    expect(s.isLatched("g1", 5)).toBe(false);
    expect(s.isLatched("g1", 6)).toBe(true);
    expect(s.isLatched("other", 6)).toBe(false);
    s.seed([]);
    expect(s.isLatched("g1", 6)).toBe(true);
  });

  test("resetOnCompaction: dedup/latches/cap reset, previous ≤3 most recent returned for B", () => {
    const s = createSegmentState();
    s.markInjected("U", ["a", "b"]);
    s.markInjected("A", ["c", "d"]);
    s.latch("a", 1);
    const pending = s.resetOnCompaction("c9");
    expect(pending).toEqual({ compactionId: "c9", hashes: ["d", "c", "b"] });
    expect(s.isInjected("a")).toBe(false);
    expect(s.isLatched("a", 99)).toBe(false); // latches never carry into the new segment
    expect(s.count()).toBe(0);
    expect(s.pendingReinject()?.compactionId).toBe("c9");
    s.markReinjected("c9");
    expect(s.pendingReinject()).toBeUndefined();
    // a second reset for the same id is a no-op when B is still pending
    const s2 = createSegmentState();
    s2.markInjected("U", ["x"]);
    const p1 = s2.resetOnCompaction("k");
    expect(s2.resetOnCompaction("k")).toBe(p1);
  });

  test("seeding with a NEW compaction id drops latches", () => {
    const s = createSegmentState();
    s.seed([compaction("c1")]);
    s.latch("g", 1);
    s.seed([compaction("c1"), compaction("c2")]);
    expect(s.isLatched("g", 5)).toBe(false);
  });

  test("markGate counts gates and holds; recallRecord shape is v1 append-only", () => {
    const s = createSegmentState();
    s.markGate(["a"], false);
    s.markGate(["b", "c"], true);
    expect(s.stats()).toMatchObject({ gates: 3, holdGates: 2 });
    expect(recallRecord("B", ["a"], { bFor: "c1" })).toEqual({ v: 1, layer: "B", keys: ["a"], bFor: "c1" });
    expect(recallRecord("U", ["a"])).toEqual({ v: 1, layer: "U", keys: ["a"] });
  });
});
