/**
 * B1 · correction timeline semantics end-to-end (BA §4.2/§4.3, Major 9): the builder records a
 * CorrectionFact for EVERY user entry, and replay's memo accepts only origin ∈ {tui, replay}
 * within CORRECTION_WINDOW_MS, one shot per target, with non-correcting inputs never clearing
 * the slot. Long/multi-line/web corrections are COUNTED as facts but only tui/replay ones can
 * mark a memo target.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { replay } from "../../../../src/reflex/core/backtest/replay.js";
import { builderFor, feedFile, userLine, customLine, assistantLine, eid, TG, ALL_CAPS } from "./fixtures-b1.js";
import { makeTurn, T0 } from "../../helpers/turn.js";
import type { CorrectionFact, ReplayRow } from "../../../../src/reflex/core/types.js";

const HIT_Q = "后台还有几个 job";
const ROOT = { id: "croot-c", at: TG };

/** Run builder lines for one session and replay the result (corrections come from the timeline). */
function replayFile(lines: readonly string[]): { rows: readonly ReplayRow[]; facts: readonly CorrectionFact[] } {
  const b = builderFor([ROOT]);
  const { turns, corrections } = feedFile(b, ROOT, lines);
  const rows = replay(turns, corrections, { builtin: BUILTIN_SCRIPTS }, ALL_CAPS);
  return { rows, facts: corrections };
}

const rowOf = (rows: readonly ReplayRow[], entryId: string): ReplayRow => {
  const r = rows.find((x) => x.turn.entryId === entryId);
  if (r === undefined) throw new Error(`no row ${entryId}`);
  return r;
};

function turnAt(at: number, entryId: string) {
  return userLine({ id: entryId, at, text: HIT_Q });
}

/** A settled high round: user question + assistant stop (settled at `at+5`). */
function highRound(at: number, entryId: string): string[] {
  return [
    userLine({ id: entryId, at, text: HIT_Q }),
    assistantLine({ id: eid("a"), at: at + 5, stopReason: "stop", toolCalls: [] }),
  ];
}

describe("correction facts are produced for every user entry", () => {
  it("long sentences and multi-line corrections are recorded even though they can never be turns", () => {
    const { facts, rows } = replayFile([
      ...highRound(TG, "u1"),
      userLine({ id: "c1", at: TG + 10, text: "不对，" + "你理解错了".repeat(40) }),
      userLine({ id: "c2", at: TG + 20, text: "不是这样\n重新来" }),
    ]);
    expect(facts.filter((f) => f.corrHit).map((f) => f.entryId)).toEqual(["c1", "c2"]);
    expect(rowOf(rows, "u1").corrected).toBe(true); // the long + multi-line corrections both land in the window
  });

  it("web / injected / steer corrections never mark a memo target", () => {
    const pid = eid();
    const webParent = customLine({ id: pid, at: TG, customType: "subagent:web-origin", data: { v: 1 } });
    const { rows } = replayFile([
      ...highRound(TG, "u1"),
      webParent,
      userLine({ id: "w1", parentId: pid, at: TG + 10, text: "不对" }),
      userLine({ id: "i1", at: TG + 12, text: "[switch_context] 不对" }),
    ]);
    expect(rowOf(rows, "u1").corrected).toBe(false);
  });
});

describe("memo acceptance windows", () => {
  it("counts a correction after intermediate unrelated input (the memo is never cleared)", () => {
    const { rows } = replayFile([
      ...highRound(TG, "u1"),
      userLine({ id: "x1", at: TG + 10, text: "嗯好的知道了" }),
      userLine({ id: "c1", at: TG + 20, text: "不对" }),
    ]);
    expect(rowOf(rows, "u1").corrected).toBe(true);
  });

  it("rejects corrections outside CORRECTION_WINDOW_MS (90s after settle)", () => {
    const { rows } = replayFile([...highRound(TG, "u1"), userLine({ id: "c1", at: TG + 96_000, text: "不对" })]);
    expect(rowOf(rows, "u1").corrected).toBe(false);
  });

  it("counts a correction only once per target", () => {
    const { rows } = replayFile([
      ...highRound(TG, "u1"),
      userLine({ id: "c1", at: TG + 10, text: "不对" }),
      userLine({ id: "c2", at: TG + 12, text: "又错了" }),
    ]);
    expect(rowOf(rows, "u1").corrected).toBe(true); // flagged once; the second correction is a no-op on the same memo
  });

  it("ignores corrections with no settled high target", () => {
    const { rows } = replayFile([userLine({ id: "c0", at: TG, text: "不对" }), ...highRound(TG + 10, "u1")]);
    expect(rowOf(rows, "u1").corrected).toBe(false);
    expect(rowOf(rows, "u1").suspect).toBeUndefined();
  });

  it("non-corrHit inputs never count even inside the window", () => {
    const { rows } = replayFile([...highRound(TG, "u1"), userLine({ id: "x1", at: TG + 10, text: "继续" })]);
    expect(rowOf(rows, "u1").corrected).toBe(false);
  });
});

describe("corrections from a different session never leak", () => {
  it("memo state is per session", () => {
    const rows = replay(
      [makeTurn({ session: "s1", entryId: "u1", text: HIT_Q, digest: "q", at: T0, settledAt: T0 + 5 })],
      [{ session: "s2", entryId: "c1", at: T0 + 10, origin: "tui", corrHit: true }],
      { builtin: BUILTIN_SCRIPTS },
      ALL_CAPS,
    );
    expect(rows[0]!.corrected).toBe(false);
  });
});
