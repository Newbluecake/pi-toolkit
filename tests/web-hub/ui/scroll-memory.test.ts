import { describe, expect, it } from "vitest";
import {
  buildAnchorIndex,
  createScrollMemory,
  findAnchor,
  pickAnchor,
  restoreStart,
  SCROLL_MEMORY,
  SCROLL_MEMORY_CAP,
} from "../../../src/web-hub/ui/src/composables/useScrollMemory.js";

/**
 * `useScrollMemory.ts` (docs/dev/web-hub-session-switch/plan.md §1.4 — E1, v1 最小闭环):
 * the pure scroll-position memory — LRU store keyed by agentKey, anchor id resolution
 * (ambiguity exclusion), save-time row picking, and the restore-time window start rule (E1-4).
 * All pure data/math, no DOM (node environment).
 */

describe("createScrollMemory — insertion-order LRU (E1-6)", () => {
  it("evicts the least-recently-used key once past the cap", () => {
    const mem = createScrollMemory(3);
    mem.set("a", { following: true });
    mem.set("b", { following: true });
    mem.set("c", { following: true });
    mem.set("d", { following: true });
    expect(mem.size).toBe(3);
    expect(mem.get("a")).toBeUndefined(); // oldest evicted
    expect(mem.get("b")?.following).toBe(true);
    expect(mem.get("d")?.following).toBe(true);
  });

  it("get() touches: a read key survives later evictions", () => {
    const mem = createScrollMemory(2);
    mem.set("a", { following: false });
    mem.set("b", { following: true });
    expect(mem.get("a")).toEqual({ following: false }); // touch a — now b is the LRU
    mem.set("c", { following: true });
    expect(mem.get("b")).toBeUndefined(); // b evicted, a survived
    expect(mem.get("a")).toEqual({ following: false });
  });

  it("set() overwrites in place AND refreshes recency (覆盖写)", () => {
    const mem = createScrollMemory(2);
    mem.set("a", { following: true });
    mem.set("b", { following: true });
    mem.set("a", { following: false, anchorIds: ["e:x"] }); // overwrite + touch
    mem.set("c", { following: true });
    expect(mem.size).toBe(2);
    expect(mem.get("b")).toBeUndefined(); // b is the LRU now, not a
    expect(mem.get("a")).toEqual({ following: false, anchorIds: ["e:x"] });
  });

  it("delete() removes and size tracks exactly", () => {
    const mem = createScrollMemory();
    mem.set("k", { following: true });
    expect(mem.size).toBe(1);
    mem.delete("k");
    expect(mem.size).toBe(0);
    expect(mem.get("k")).toBeUndefined();
    mem.delete("missing"); // no throw
    expect(mem.size).toBe(0);
  });

  it("default cap is 16 and SCROLL_MEMORY is a distinct injection key", () => {
    expect(SCROLL_MEMORY_CAP).toBe(16);
    const mem = createScrollMemory();
    for (let i = 0; i < 20; i++) mem.set(`k${i}`, { following: true });
    expect(mem.size).toBe(16);
    expect(mem.get("k0")).toBeUndefined(); // first four evicted
    expect(typeof SCROLL_MEMORY).toBe("symbol");
  });

  it("cap floors at 1 (a degenerate cap still holds the newest record)", () => {
    const mem = createScrollMemory(0);
    mem.set("a", { following: true });
    mem.set("b", { following: true });
    expect(mem.size).toBe(1);
    expect(mem.get("b")).toEqual({ following: true });
  });
});

describe("buildAnchorIndex — duplicate ids are excluded (E1-1)", () => {
  it("maps unique ids to their entry index", () => {
    const index = buildAnchorIndex([["e:1"], [], ["e:3", "k:user:5"]]);
    expect(index.get("e:1")).toBe(0);
    expect(index.get("e:3")).toBe(2);
    expect(index.get("k:user:5")).toBe(2);
    expect(index.has("k:missing")).toBe(false);
  });

  it("an id occurring in TWO entries is ambiguous and excluded entirely", () => {
    const index = buildAnchorIndex([
      ["e:1", "k:dup"],
      ["e:2", "k:dup"],
    ]);
    expect(index.has("k:dup")).toBe(false); // the duplicate itself…
    expect(index.get("e:1")).toBe(0); // …but its unique siblings stay usable
    expect(index.get("e:2")).toBe(1);
  });

  it("an id repeated WITHIN one entry's own set still counts once per entry (no self-ambiguity)", () => {
    // degenerate input guard: same id listed twice in one row is one entry's identity
    const index = buildAnchorIndex([["e:1", "e:1"], ["e:2"]]);
    expect(index.get("e:1")).toBe(0);
    expect(index.get("e:2")).toBe(1);
  });
});

describe("findAnchor — any-id hit wins, cross-index hits are ambiguous (E1-1)", () => {
  const index = buildAnchorIndex([["e:1"], ["e:2", "k:assistant:9"], ["e:3"]]);

  it("returns the index when any single id hits", () => {
    expect(findAnchor(index, ["e:gone", "e:2"])).toBe(1);
    expect(findAnchor(index, ["k:assistant:9"])).toBe(1);
  });

  it("returns undefined when no id hits at all", () => {
    expect(findAnchor(index, ["e:nope", "k:nope"])).toBeUndefined();
    expect(findAnchor(index, [])).toBeUndefined();
  });

  it("returns undefined when two ids of the SAME record hit DIFFERENT indices", () => {
    expect(findAnchor(index, ["e:1", "e:3"])).toBeUndefined();
    expect(findAnchor(index, ["e:1", "e:2"])).toBeUndefined();
  });

  it("ids hitting the SAME index (or missing) never conflict", () => {
    expect(findAnchor(index, ["e:2", "k:assistant:9", "e:gone"])).toBe(1);
  });

  it("an ambiguous id (excluded from the index) is simply a miss", () => {
    const amb = buildAnchorIndex([["k:dup"], ["e:2", "k:dup"]]);
    expect(findAnchor(amb, ["k:dup"])).toBeUndefined();
    expect(findAnchor(amb, ["k:dup", "e:2"])).toBe(1);
  });
});

describe("pickAnchor — first visible anchorable row (E1-3)", () => {
  it("picks the first row with ids that reaches below the viewport top", () => {
    const picked = pickAnchor(
      [
        { ids: ["e:0"], top: 0, bottom: 100 },
        { ids: ["e:1"], top: 100, bottom: 200 },
        { ids: ["e:2"], top: 200, bottom: 300 },
      ],
      150,
    );
    expect(picked).toEqual({ ids: ["e:1"], offsetPx: -50 }); // row 1 straddles the top: negative offset
  });

  it("skips rows with empty ids (streaming / live tools / ambiguity-filtered rows)", () => {
    const picked = pickAnchor(
      [
        { ids: [], top: 0, bottom: 100 },
        { ids: [], top: 100, bottom: 200 },
        { ids: ["e:2"], top: 200, bottom: 300 },
      ],
      50,
    );
    expect(picked).toEqual({ ids: ["e:2"], offsetPx: 150 });
  });

  it("skips rows entirely above the viewport (bottom <= viewportTop)", () => {
    const picked = pickAnchor(
      [
        { ids: ["e:0"], top: 0, bottom: 90 },
        { ids: ["e:1"], top: 90, bottom: 180 },
      ],
      90, // boundary: bottom === viewportTop does NOT count as visible
    );
    expect(picked).toEqual({ ids: ["e:1"], offsetPx: 0 });
  });

  it("returns undefined for an empty row list / nothing below the fold", () => {
    expect(pickAnchor([], 0)).toBeUndefined();
    expect(pickAnchor([{ ids: ["e:0"], top: 0, bottom: 10 }], 500)).toBeUndefined();
  });

  it("offsetPx is measured from the viewport top (positive when the row sits below it)", () => {
    const picked = pickAnchor([{ ids: ["e:x"], top: 400, bottom: 460 }], 250);
    expect(picked).toEqual({ ids: ["e:x"], offsetPx: 150 });
  });
});

describe("restoreStart — E1-4 window rule", () => {
  it("anchor inside the default tail window ⇒ the default window IS the restore", () => {
    // len 500, default 200 ⇒ defaultStart 300; j 350 ≥ 300
    expect(restoreStart(350, 500, 200)).toBe(300);
    expect(restoreStart(500, 500, 200)).toBe(300);
  });

  it("earlier anchor ⇒ centered: j - floor(defaultSize/2), clamped at 0", () => {
    expect(restoreStart(150, 500, 200)).toBe(50);
    expect(restoreStart(40, 500, 200)).toBe(0);
    expect(restoreStart(90, 500, 80)).toBe(50); // mobile window halves to 40
  });

  it("property: j always lands inside [start, start + defaultSize) (exhaustive small range)", () => {
    for (const size of [80, 200]) {
      for (let len = 0; len <= 260; len += 7) {
        for (let j = 0; j < len; j += 3) {
          const start = restoreStart(j, len, size);
          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThanOrEqual(j);
          expect(j).toBeLessThan(start + size);
        }
      }
    }
  });
});
