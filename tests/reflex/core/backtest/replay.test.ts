/**
 * B1 · replay (BA §4.3): two-layer semantics identical to the runtime (builtin first, drafts
 * only on builtin miss — K2), acceptance mapping, ideal-TUI gate with real text/imageCount,
 * `wouldHit` on vetoes, reasked windows (V2 identity + digest, per session), memo-based
 * `corrected` replay, suspect precedence, and catalog parity ("replay 与 wire.ts 同输入同
 * band" — the same matcher the runtime uses, on the real builtin catalog's example corpus).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import { compileCatalog } from "../../../../src/reflex/core/match.js";
import { evaluateGate } from "../../../../src/reflex/core/gate.js";
import { replay } from "../../../../src/reflex/core/backtest/replay.js";
import { ALL_CAPS, builtinHits } from "./fixtures-b1.js";
import { makeDraft, makeTurn, T0 } from "../../helpers/turn.js";
import type { CorrectionFact, ReplayRow, Turn } from "../../../../src/reflex/core/types.js";

function rowsOf(
  turns: readonly Turn[],
  corrections: readonly CorrectionFact[] = [],
  drafts?: Parameters<typeof replay>[2]["drafts"],
) {
  return replay(
    turns,
    corrections,
    { builtin: BUILTIN_SCRIPTS, ...(drafts !== undefined ? { drafts } : {}) },
    ALL_CAPS,
  );
}

const HIT_Q = "后台还有几个 job";

describe("two-layer semantics (K2)", () => {
  it("a builtin high hit wins; the draft is never consulted", () => {
    const draft = makeDraft({ id: "draft.jobs" });
    const rows = rowsOf(
      [makeTurn({ session: "s", entryId: "1", text: HIT_Q, at: T0, settledAt: T0 + 1 })],
      [],
      [draft],
    );
    expect(rows[0]!.cls).toMatchObject({ k: "high", scriptId: "jobs.list", layer: "builtin" });
  });

  it("a builtin MISS falls through to the draft layer", () => {
    const draft = makeDraft({
      id: "draft.jobs",
      intent: {
        strong: ["喵喵清单"],
        weak: ["喵喵"],
        exclude: [],
        examples: {
          hit: ["喵喵清单", "喵喵清单吗", "喵喵清单呢", "喵喵清单看一下", "喵喵清单查一下"],
          miss: ["天气怎么样", "今天几号", "帮我看喵喵清单", "喵喵清单停了", "喵喵清单的日志"],
        },
      },
    });
    // "喵喵清单" is a true builtin miss (no weak word of any builtin) ⇒ the draft layer answers
    const rows = rowsOf(
      [makeTurn({ session: "s", entryId: "1", text: "喵喵清单", at: T0, settledAt: T0 + 1 })],
      [],
      [draft],
    );
    expect(rows[0]!.cls).toMatchObject({ k: "high", scriptId: "draft.jobs", layer: "draft" });
  });

  it("a builtin AMBIGUOUS hit stops the draft layer too (ambiguous ≠ miss)", () => {
    const draft = makeDraft({ id: "draft.any" });
    const rows = rowsOf(
      [makeTurn({ session: "s", entryId: "1", text: "agent 的 job 状态怎么样", at: T0, settledAt: T0 + 1 })],
      [],
      [draft],
    );
    expect(rows[0]!.cls.k).toBe("ambiguous");
    if (rows[0]!.cls.k === "ambiguous") {
      expect(rows[0]!.cls.candidates).toContain("jobs.list");
      expect(rows[0]!.cls.candidates).toContain("fleet.status");
    }
  });

  it("both layers miss ⇒ miss", () => {
    const draft = makeDraft({ id: "draft.jobs" });
    const rows = rowsOf(
      [makeTurn({ session: "s", entryId: "1", text: "今天天气怎么样", at: T0, settledAt: T0 + 1 })],
      [],
      [draft],
    );
    expect(rows[0]!.cls).toEqual({ k: "miss" });
  });
});

describe("catalog parity: replay's band equals the runtime matcher+gate on the same input", () => {
  it("every builtin examples.hit replays high for that script (acceptance aside)", () => {
    for (const { scriptId, text } of builtinHits()) {
      const rows = rowsOf([makeTurn({ session: "s", entryId: "1", text, at: T0, settledAt: T0 + 1 })]);
      const cls = rows[0]!.cls;
      expect(cls, text).toMatchObject({ k: "high", scriptId, layer: "builtin" });
    }
  });

  it("every builtin examples.miss never replays high (veto or miss), matching gate+match directly", () => {
    const matcher = compileCatalog(BUILTIN_SCRIPTS);
    for (const s of BUILTIN_SCRIPTS) {
      for (const text of s.intent.examples.miss) {
        const gate = evaluateGate({
          source: "interactive",
          mode: "tui",
          streamingBehavior: undefined,
          idle: true,
          pendingMessages: false,
          imageCount: 0,
          text,
          topicSwitchActive: false,
          goalBusy: false,
          inFlight: false,
        });
        const rows = rowsOf([makeTurn({ session: "s", entryId: "1", text, at: T0, settledAt: T0 + 1 })]);
        const cls = rows[0]!.cls;
        if (gate.pass) {
          // same band as the runtime matcher on the same normalized input
          const m = matcher.match(gate.norm.norm, ALL_CAPS);
          if (m.kind === "miss") expect(cls.k, text).toBe("miss");
          else if (m.band === "high") expect(cls, text).toMatchObject({ k: "high", scriptId: m.scriptId });
          else expect(cls, text).toMatchObject({ k: "ambiguous", candidates: m.candidates });
        } else {
          expect(cls.k, text).toBe("veto");
          if (cls.k === "veto") expect(cls.code, text).toBe(gate.veto);
        }
      }
    }
  });
});

describe("gate on ideal TUI facts (real text/imageCount)", () => {
  it("image turns veto with wouldHit naming the script the matcher would have hit", () => {
    const rows = rowsOf([
      makeTurn({ session: "s", entryId: "1", text: HIT_Q, imageCount: 1, at: T0, settledAt: T0 + 1 }),
    ]);
    expect(rows[0]!.cls).toMatchObject({ k: "veto", code: "image", wouldHit: "jobs.list" });
  });

  it("imperative/cancel text vetoes even though a weak word is present (same code as the gate)", () => {
    const rows = rowsOf([
      makeTurn({ session: "s", entryId: "1", text: "把后台 job 都停了", at: T0, settledAt: T0 + 1 }),
    ]);
    expect(rows[0]!.cls).toMatchObject({ k: "veto" });
    const gate = evaluateGate({
      source: "interactive",
      mode: "tui",
      streamingBehavior: undefined,
      idle: true,
      pendingMessages: false,
      imageCount: 0,
      text: "把后台 job 都停了",
      topicSwitchActive: false,
      goalBusy: false,
      inFlight: false,
    });
    expect(gate.pass).toBe(false);
    expect(rows[0]!.cls).toMatchObject({ k: "veto", code: gate.veto });
  });

  it("steer/replay-origin turns are judged as if typed in a TUI (counterfactual, BA §4.3)", () => {
    const rows = rowsOf([
      makeTurn({ session: "s", entryId: "1", text: HIT_Q, origin: "steer", at: T0, settledAt: T0 + 1 }),
      makeTurn({ session: "s", entryId: "2", text: HIT_Q, origin: "replay", at: T0 + 2, settledAt: T0 + 3 }),
    ]);
    expect(rows[0]!.cls).toMatchObject({ k: "high" });
    expect(rows[1]!.cls).toMatchObject({ k: "high" });
  });
});

describe("acceptance", () => {
  it("maps unknownFacts empty ⇔ confirmed, else lenient", () => {
    const rows = rowsOf([
      makeTurn({ session: "s", entryId: "1", text: HIT_Q, at: T0, settledAt: T0 + 1 }),
      makeTurn({
        session: "s",
        entryId: "2",
        text: HIT_Q,
        unknownFacts: ["sourceMode"],
        at: T0 + 2,
        settledAt: T0 + 3,
      }),
    ]);
    expect(rows[0]!.acceptance).toBe("confirmed");
    expect(rows[1]!.acceptance).toBe("lenient");
  });
});

describe("agreement & suspects", () => {
  /** Distinct digest + advancing time per row (no accidental re-ask windows); `hasWrite`
   * derives from the shapes because replay reads the builder-computed Turn flag. */
  const turn = (i: number, over: Parameters<typeof makeTurn>[0]) =>
    makeTurn({
      session: "s",
      text: HIT_Q,
      digest: `d${i}`,
      at: T0 + i * 200_000,
      settledAt: T0 + i * 200_000 + 1,
      ...over,
      ...(over.shapes !== undefined ? { hasWrite: over.shapes.some((x) => x === "edit" || x === "write") } : {}),
    });

  it("no tools ⇒ no-tool agree; agree-shape ⇒ agree; foreign shape ⇒ diverge", () => {
    const rows = rowsOf([
      turn(1, { entryId: "1", shapes: [] }),
      turn(2, { entryId: "2", shapes: ["bash_job:list"] }),
      turn(3, { entryId: "3", shapes: ["read"] }),
    ]);
    expect(rows[0]!.cls).toMatchObject({ k: "high", agree: "no-tool" });
    expect(rows[1]!.cls).toMatchObject({ k: "high", agree: "agree" });
    expect(rows[2]!.cls).toMatchObject({ k: "high", agree: "diverge" });
    expect(rows[2]!.suspect).toBe("diverge");
  });

  it("write turns report write-turn; another port's vocabulary reports other-port", () => {
    const rows = rowsOf([
      turn(1, { entryId: "1", shapes: ["edit"] }),
      turn(2, { entryId: "2", shapes: ["get_run_result"] }),
    ]);
    expect(rows[0]!.cls).toMatchObject({ agree: "diverge" });
    expect(rows[0]!.suspect).toBe("write-turn");
    expect(rows[1]!.suspect).toBe("other-port");
  });

  it("reasked/corrected outrank the diverge family", () => {
    const rows = rowsOf([
      turn(1, { entryId: "1", shapes: ["read"], digest: "dk" }),
      turn(2, { entryId: "2", shapes: ["read"], digest: "dk" }), // same identity+digest soon ⇒ reasked
    ]);
    expect(rows[0]!.suspect).toBe("diverge");
    expect(rows[1]!.reasked).toBe(true);
    expect(rows[1]!.suspect).toBe("reasked");
  });
});

describe("reasked window (per session, V2 identity + digest)", () => {
  const t = (session: string, entryId: string, at: number) =>
    makeTurn({ session, entryId, text: HIT_Q, digest: "dd", at, settledAt: at + 1 });

  it("same session + same digest within REPEAT_WINDOW_MS ⇒ reasked; beyond the window or in another session ⇒ not", () => {
    const rows = rowsOf([
      t("s1", "1", T0),
      t("s1", "2", T0 + 60_000), // 1 min later ⇒ re-ask
      t("s1", "3", T0 + 700_000), // > 10 min after the last high ⇒ fresh
      t("s2", "4", T0 + 120_000), // different session ⇒ no in-session flag
    ]);
    expect(rows.map((r) => r.reasked)).toEqual([false, true, false, false]);
  });

  it("different digest or different script identity never re-asks", () => {
    const rows = rowsOf([
      makeTurn({ session: "s", entryId: "1", text: HIT_Q, digest: "a", at: T0, settledAt: T0 + 1 }),
      makeTurn({
        session: "s",
        entryId: "2",
        text: "工作区干净吗",
        digest: "b",
        at: T0 + 60_000,
        settledAt: T0 + 61_000,
      }),
      makeTurn({ session: "s", entryId: "3", text: HIT_Q, digest: "a", at: T0 + 120_000, settledAt: T0 + 121_000 }),
    ]);
    expect(rows[1]!.cls).toMatchObject({ scriptId: "git.status" });
    expect(rows[1]!.reasked).toBe(false);
    expect(rows[2]!.reasked).toBe(true); // same jobs.list identity + digest a again
  });
});

describe("correction memo replay (runtime single-slot semantics)", () => {
  const corr = (
    session: string,
    at: number,
    entryId: string,
    origin: CorrectionFact["origin"] = "tui",
    corrHit = true,
  ): CorrectionFact => ({
    session,
    entryId,
    at,
    origin,
    corrHit,
  });

  it("marks the settled high target corrected; a correction BETWEEN at and settledAt hits the PREVIOUS memo", () => {
    const rows = rowsOf(
      [
        makeTurn({ session: "s", entryId: "u1", text: HIT_Q, digest: "q1", at: T0, settledAt: T0 + 5 }),
        makeTurn({ session: "s", entryId: "u2", text: "第二问", digest: "q2", at: T0 + 10, settledAt: T0 + 60 }),
      ],
      [corr("s", T0 + 20, "c1")], // inside u2's pending window, but memo is still u1's
    );
    expect(rows[0]!.corrected).toBe(true);
    expect(rows[0]!.suspect).toBe("corrected");
    expect(rows[1]!.corrected).toBe(false);
  });

  it("a later memo replaces the slot (single-slot, latest high wins)", () => {
    const rows = rowsOf(
      [
        makeTurn({ session: "s", entryId: "u1", text: HIT_Q, digest: "q1", at: T0, settledAt: T0 + 5 }),
        makeTurn({ session: "s", entryId: "u2", text: HIT_Q, digest: "q2", at: T0 + 10, settledAt: T0 + 15 }),
      ],
      [corr("s", T0 + 20, "c1")], // after u2 settled ⇒ targets u2 only
    );
    expect(rows[0]!.corrected).toBe(false);
    expect(rows[1]!.corrected).toBe(true);
  });
});

describe("row shape", () => {
  it("returns rows in input order and drops nothing", () => {
    const turns = [
      makeTurn({ session: "s", entryId: "1", text: HIT_Q, at: T0, settledAt: T0 + 1 }),
      makeTurn({ session: "s", entryId: "2", text: "今天天气怎么样", at: T0 + 2, settledAt: T0 + 3 }),
    ];
    const rows: readonly ReplayRow[] = rowsOf(turns);
    expect(rows.map((r) => r.turn.entryId)).toEqual(["1", "2"]);
    expect(rows[0]).toMatchObject({ reasked: false, corrected: false });
  });
});
