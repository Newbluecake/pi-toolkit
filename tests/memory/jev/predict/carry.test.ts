// carry.ts unit tests (plan.md v3.2 section 3.3).

import { describe, expect, it } from "vitest";
import {
  buildFinalRecord,
  carryFromFinal,
  carryHits,
  detectCarryClear,
  isCarryPhrase,
  isTodoReplaced,
  MAX_CARRIES,
  revalidateCarry,
} from "../../../../src/memory/jev/predict/carry.js";
import type { CarryState } from "../../../../src/memory/jev/predict/contracts.js";

describe("isCarryPhrase", () => {
  it.each(["继续", "好的", "ok", "Continue", "goahead"])("accepts ack phrases: %s", (p) => {
    expect(isCarryPhrase(p)).toBe(true);
  });

  it.each(["别提交", "换任务", "改成 dev", "继续写这个函数"])("rejects non-ack short messages: %s", (p) => {
    expect(isCarryPhrase(p)).toBe(false);
  });

  it("excludes thanks/lgtm/收到 (removed from ACK_PHRASES per section 3.3)", () => {
    expect(isCarryPhrase("谢谢")).toBe(false);
    expect(isCarryPhrase("thanks")).toBe(false);
    expect(isCarryPhrase("thankyou")).toBe(false);
    expect(isCarryPhrase("收到")).toBe(false);
    expect(isCarryPhrase("lgtm")).toBe(false);
  });
});

function state(overrides: Partial<CarryState> = {}): CarryState {
  return {
    tags: [
      {
        tag: "dispatch",
        score: 0.9,
        sources: ["U"],
        rules: ["R05"],
        evidence: { todoIds: [], jobShapes: [] },
      },
    ],
    carries: 0,
    ...overrides,
  };
}

describe("revalidateCarry", () => {
  it("keeps a U/M-only tag with 0.95 decay", () => {
    const next = revalidateCarry(state(), { todo: [], git: {} });
    expect(next?.tags[0]?.score).toBeCloseTo(0.9 * 0.95, 5);
    expect(next?.carries).toBe(1);
  });

  it("keeps a T-sourced tag only while its todoId is still in_progress", () => {
    const withTodo = state({
      tags: [
        {
          tag: "frozen-files",
          score: 0.9,
          sources: ["T"],
          rules: ["R07-T"],
          evidence: { todoIds: [7], jobShapes: [] },
        },
      ],
    });
    const kept = revalidateCarry(withTodo, { todo: [{ id: 7, subject: "x", status: "in_progress" }], git: {} });
    expect(kept?.tags).toHaveLength(1);
    const dropped = revalidateCarry(withTodo, { todo: [{ id: 7, subject: "x", status: "pending" }], git: {} });
    expect(dropped).toBeUndefined();
  });

  it("keeps a W-sourced git-commit tag only while dirty is still true", () => {
    const withW = state({
      tags: [
        { tag: "git-commit", score: 0.3, sources: ["W"], rules: ["R12"], evidence: { todoIds: [], jobShapes: [] } },
      ],
    });
    expect(revalidateCarry(withW, { todo: [], git: { dirty: true } })).toBeDefined();
    expect(revalidateCarry(withW, { todo: [], git: { dirty: false } })).toBeUndefined();
  });

  it("expires once carries reaches MAX_CARRIES (<=3)", () => {
    expect(revalidateCarry(state({ carries: MAX_CARRIES }), { todo: [], git: {} })).toBeUndefined();
    expect(revalidateCarry(state({ carries: MAX_CARRIES - 1 }), { todo: [], git: {} })).toBeDefined();
  });
});

describe("carryHits", () => {
  it("maps a carry state into source C hits carrying the decayed score", () => {
    const hits = carryHits(state());
    expect(hits).toEqual([
      {
        rule: "carry",
        source: "C",
        tag: "dispatch",
        conf: "high",
        baseConf: "high",
        score: 0.9,
        evidence: { todoIds: [], jobShapes: [] },
      },
    ]);
  });

  it("returns [] for undefined carry", () => {
    expect(carryHits(undefined)).toEqual([]);
  });
});

describe("detectCarryClear / isTodoReplaced", () => {
  it("cancel takes priority over every other reason", () => {
    expect(detectCarryClear({ cancelled: true, compacted: true, todoReplaced: true, finalTagsEmpty: true })).toBe(
      "cancel",
    );
  });
  it("falls through compaction -> todo-replaced -> empty -> undefined", () => {
    expect(detectCarryClear({ cancelled: false, compacted: true, todoReplaced: true, finalTagsEmpty: true })).toBe(
      "compaction",
    );
    expect(detectCarryClear({ cancelled: false, compacted: false, todoReplaced: true, finalTagsEmpty: true })).toBe(
      "todo-replaced",
    );
    expect(detectCarryClear({ cancelled: false, compacted: false, todoReplaced: false, finalTagsEmpty: true })).toBe(
      "empty",
    );
    expect(
      detectCarryClear({ cancelled: false, compacted: false, todoReplaced: false, finalTagsEmpty: false }),
    ).toBeUndefined();
  });

  it("isTodoReplaced is true only when the whole in_progress group changed", () => {
    expect(isTodoReplaced([1, 2], [2, 3])).toBe(false); // overlap -> not replaced
    expect(isTodoReplaced([1, 2], [3, 4])).toBe(true); // no overlap -> replaced
    expect(isTodoReplaced([], [3, 4])).toBe(false); // no prior T evidence -> never "replaced"
  });
});

describe("buildFinalRecord / carryFromFinal: only-from-final restore (section 3.3)", () => {
  it("round-trips a non-empty final record into a CarryState", () => {
    const record = buildFinalRecord(5, state().tags, 1);
    expect(carryFromFinal(record)).toEqual({ tags: state().tags, carries: 1 });
  });

  it("an empty final (cleared) restores to undefined", () => {
    const cleared = buildFinalRecord(5, [], 0, "cancel");
    expect(carryFromFinal(cleared)).toBeUndefined();
  });

  it("a final with empty tags and no cleared reason also restores to undefined", () => {
    expect(carryFromFinal(buildFinalRecord(5, [], 0))).toBeUndefined();
  });

  it("undefined record (no final ever written, or only kind:call records exist) restores to undefined", () => {
    expect(carryFromFinal(undefined)).toBeUndefined();
  });
});
