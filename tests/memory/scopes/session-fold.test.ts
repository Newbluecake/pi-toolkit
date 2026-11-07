/** #39 P1 fold: reference-model equivalence, whole-snap rejection, inheritance, dropped. */
import { describe, expect, it } from "vitest";
import { foldSessionMemory } from "../../../src/memory/scopes/session-fold.js";
import { SESSION_MEMORY_ENTRY_TYPE } from "../../../src/memory/scopes/types.js";

const STAMP = "2026-11-07T00:00:00.000Z";

function put(n: number, text: string, writerSid = "s1", extra: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: SESSION_MEMORY_ENTRY_TYPE,
    id: `e${n}`,
    data: {
      v: 1,
      sid: writerSid,
      op: "put",
      item: { id: `n${n}`, text, authority: "agent", created: STAMP, updated: STAMP, ...extra },
    },
  };
}

function del(n: number, writerSid = "s1") {
  return {
    type: "custom",
    customType: SESSION_MEMORY_ENTRY_TYPE,
    id: `e${n}`,
    data: { v: 1, sid: writerSid, op: "del", id: `n${n}` },
  };
}

function snap(items: { id: string; text: string }[], nextN: number, extra: Record<string, unknown> = {}) {
  return {
    type: "custom",
    customType: SESSION_MEMORY_ENTRY_TYPE,
    id: `esnap${nextN}`,
    data: {
      v: 1,
      sid: "s1",
      op: "snap",
      items: items.map((it) => ({ id: it.id, text: it.text, authority: "agent", created: STAMP, updated: STAMP })),
      nextN,
      ...extra,
    },
  };
}

const message = (n: number): unknown => ({ type: "message", id: `m${n}`, data: { role: "user", content: "hi" } });
const foreign = (n: number): unknown => ({
  type: "custom",
  customType: "other-extension",
  id: `f${n}`,
  data: { x: 1 },
});
const compaction = (n: number): unknown => ({ type: "compaction", id: `c${n}`, data: {} });

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("fold equals a reference model over seeded random op sequences", () => {
  it.each([1, 7, 42, 2026])("seed %i", (seedValue) => {
    const random = mulberry32(seedValue);
    const branch: unknown[] = [message(0)];
    let model = new Map<string, string>();
    const order: string[] = [];
    let counter = 0;
    let ops = 0;
    let expectedOpsSinceSnap = 0;
    for (let step = 0; step < 220; step++) {
      const roll = random();
      if (roll < 0.12) {
        branch.push(message(++counter));
        continue;
      }
      if (roll < 0.18) {
        branch.push(compaction(++counter));
        continue;
      }
      if (roll < 0.24) {
        branch.push(foreign(++counter));
        continue;
      }
      const ids = [...order];
      if (roll < 0.3 && ids.length > 0 && ids.length <= 40) {
        // periodic valid snap (only when small enough to stay inside product budgets)
        branch.push(
          snap(
            order.map((id) => ({ id, text: model.get(id)! })),
            order.length + 1,
          ),
        );
        model = new Map(order.map((id) => [id, model.get(id)!]));
        expectedOpsSinceSnap = 0;
        continue;
      }
      ops++;
      const pick = random();
      if (order.length > 0 && pick < 0.25) {
        const at = Math.floor(random() * order.length);
        const id = order.splice(at, 1)[0];
        model.delete(id);
        branch.push(del(Number(id.slice(1))));
      } else if (order.length > 0 && pick < 0.45) {
        const id = order[Math.floor(random() * order.length)]!;
        const text = `v${ops}`;
        model.set(id, text);
        branch.push(put(Number(id.slice(1)), text));
      } else if (order.length < 40) {
        const id = `n${ops}`;
        const text = `t${ops}`;
        order.push(id);
        model.set(id, text);
        branch.push(put(ops, text));
      } else {
        ops--;
        continue; // at the 40-item ceiling: emit nothing (model and branch stay in sync)
      }
      expectedOpsSinceSnap++;
    }
    const folded = foldSessionMemory(branch, "s1");
    expect(folded.items.map((f) => f.item.id)).toEqual(order);
    expect(folded.items.map((f) => f.item.text)).toEqual(order.map((id) => model.get(id)));
    expect(folded.nextN).toBeGreaterThanOrEqual(order.length + 1);
    expect(folded.opsSinceSnap).toBe(expectedOpsSinceSnap);
    expect(folded.dropped).toEqual([]);
  });
});

describe("whole-snap rejection and dropped visibility", () => {
  it("an invalid snap (one bad item / dup id) is rejected whole; the earlier snap wins", () => {
    const good = snap(
      [
        { id: "n1", text: "a" },
        { id: "n2", text: "b" },
      ],
      3,
    );
    const badItem = {
      type: "custom",
      customType: SESSION_MEMORY_ENTRY_TYPE,
      id: "ebad",
      data: {
        v: 1,
        sid: "s1",
        op: "snap",
        items: [
          { id: "n1", text: "x", authority: "agent", created: STAMP, updated: STAMP },
          { id: "n2", text: "y", authority: "nope", created: STAMP, updated: STAMP },
        ],
        nextN: 3,
      },
    };
    const after = put(3, "c");
    const folded = foldSessionMemory([good, badItem, after], "s1");
    expect(folded.items.map((f) => f.item.id)).toEqual(["n1", "n2", "n3"]);
    expect(folded.items.map((f) => f.item.text)).toEqual(["a", "b", "c"]);
    expect(folded.dropped).toEqual([{ entryId: "ebad", reason: expect.stringContaining("authority") }]);
  });

  it("dup ids reject the whole snap", () => {
    const bad = {
      ...snap([{ id: "n1", text: "a" }], 2),
      data: {
        ...snap([{ id: "n1", text: "a" }], 2).data,
        items: [
          { id: "n1", text: "a", authority: "agent", created: STAMP, updated: STAMP },
          { id: "n1", text: "b", authority: "agent", created: STAMP, updated: STAMP },
        ],
      },
    };
    const folded = foldSessionMemory([put(1, "orig"), bad, put(2, "x")], "s1");
    expect(folded.items.map((f) => f.item.text)).toEqual(["orig", "x"]);
    expect(folded.dropped.length).toBe(1);
  });

  it("dropped is capped at the 16 most recent invalid entries", () => {
    const branch: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      branch.push({
        type: "custom",
        customType: SESSION_MEMORY_ENTRY_TYPE,
        id: `ebad${i}`,
        data: { v: 1, sid: "s1", op: "del", id: "n!!" },
      });
    }
    const folded = foldSessionMemory(branch, "s1");
    expect(folded.dropped.length).toBe(16);
    expect(folded.dropped.at(-1)?.entryId).toBe("ebad19");
    expect(folded.dropped[0]?.entryId).toBe("ebad4");
  });

  it("entries before the base snap are superseded, not dropped", () => {
    const base = snap([{ id: "n5", text: "z" }], 6);
    const folded = foldSessionMemory([put(1, "old"), del(1), put(2, "old2"), base], "s1");
    expect(folded.items.map((f) => f.item.id)).toEqual(["n5"]);
    expect(folded.dropped).toEqual([]);
    expect(folded.nextN).toBe(6);
  });

  it("a del of a missing id is a tolerated no-op in history; nextN still advances", () => {
    const folded = foldSessionMemory([put(4, "x"), del(9)], "s1");
    expect(folded.items.map((f) => f.item.id)).toEqual(["n4"]);
    expect(folded.nextN).toBe(10);
    expect(folded.opsSinceSnap).toBe(2);
  });

  it("snap nextN cannot regress below max id + 1", () => {
    const base = snap([{ id: "n7", text: "z" }], 2);
    const folded = foldSessionMemory([base], "s1");
    expect(folded.nextN).toBe(8);
  });
});

describe("inheritance marking", () => {
  it("items written by another sid are fork-inherited; own writes are not", () => {
    const folded = foldSessionMemory([put(1, "mine", "s1"), put(2, "theirs", "s9")], "s1");
    expect(folded.items[0]?.inherited).toBeUndefined();
    expect(folded.items[1]?.inherited).toEqual({ kind: "fork", fromSid: "s9" });
  });

  it("a later own-sid rewrite clears fork inheritance", () => {
    const folded = foldSessionMemory([put(1, "x", "s9"), put(1, "y", "s1")], "s1");
    expect(folded.items[0]?.inherited).toBeUndefined();
    expect(folded.items[0]?.item.text).toBe("y");
  });

  it("seed-snap items are spawn-inherited with fromSid/frozenAt", () => {
    const seedSnap = snap([{ id: "n1", text: "a" }], 2, {
      inherit: { kind: "spawn", fromSid: "parent", fromLeaf: "leaf-1", frozenAt: STAMP },
    });
    const folded = foldSessionMemory([seedSnap], "s1");
    expect(folded.items[0]?.inherited).toEqual({ kind: "spawn", fromSid: "parent", frozenAt: STAMP });
  });

  it("currentSid undefined marks everything inherited (read-only host)", () => {
    const folded = foldSessionMemory([put(1, "x", "s1")], undefined);
    expect(folded.items[0]?.inherited).toEqual({ kind: "fork", fromSid: "s1" });
  });

  it("rev is the canonical sha1/8 of the item", () => {
    const folded = foldSessionMemory([put(1, "x")], "s1");
    expect(folded.items[0]?.rev).toMatch(/^[a-f0-9]{8}$/);
  });
});

describe("fold hard budgets allow history above product caps", () => {
  it("a 50-item historical snap folds (blocks writes at plan time, not fold time)", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `n${i + 1}`, text: "x" }));
    const folded = foldSessionMemory([snap(items, 51)], "s1");
    expect(folded.items.length).toBe(50);
    expect(folded.dropped).toEqual([]);
  });
});

describe("id-space exhaustion sentinel (Root minor-fix 2026-11-07)", () => {
  const maxPut = (extra: Record<string, unknown> = {}) => ({
    type: "custom",
    customType: SESSION_MEMORY_ENTRY_TYPE,
    id: "emax",
    data: {
      v: 1,
      sid: "s1",
      op: "put",
      item: { id: "n999999", text: "last legal id", authority: "agent", created: STAMP, updated: STAMP, ...extra },
    },
    ...extra,
  });

  it("an existing n999999 drives the internal nextN to the 1_000_000 sentinel", () => {
    const folded = foldSessionMemory([maxPut()], "s1");
    expect(folded.items.length).toBe(1);
    expect(folded.nextN).toBe(1_000_000);
  });

  it("the sentinel is reconstructed from a published snap whose nextN field is capped at 999999", () => {
    const snap = {
      type: "custom",
      customType: SESSION_MEMORY_ENTRY_TYPE,
      id: "esnapmax",
      data: {
        v: 1,
        sid: "s1",
        op: "snap",
        items: [{ id: "n999999", text: "x", authority: "agent", created: STAMP, updated: STAMP }],
        nextN: 999999, // the validated published range
      },
    };
    expect(foldSessionMemory([snap], "s1").nextN).toBe(1_000_000);
  });

  it("deleting n999999 never frees the number for reuse (monotonic contract)", () => {
    const del = {
      type: "custom",
      customType: SESSION_MEMORY_ENTRY_TYPE,
      id: "edel",
      data: { v: 1, sid: "s1", op: "del", id: "n999999" },
    };
    const folded = foldSessionMemory([maxPut(), del], "s1");
    expect(folded.items.length).toBe(0);
    expect(folded.nextN).toBe(1_000_000);
  });
});
