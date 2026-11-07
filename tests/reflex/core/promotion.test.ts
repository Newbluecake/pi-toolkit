/**
 * R1 · promotion (plan R1 step 11; U5): PROMOTION_GATE, accumulate folding, boundary cases,
 * countCrossSessionRepeats semantics, msPercentiles.
 */
import { describe, expect, it } from "vitest";
import {
  PROMOTION_GATE,
  accumulate,
  countCrossSessionRepeats,
  evaluatePromotion,
  msPercentiles,
  type ScriptStats,
} from "../../../src/reflex/core/promotion.js";
import type { ReflexAnswerDetailsV1, ReflexCorrectionV1, ReflexRecordV1 } from "../../../src/reflex/core/types.js";

function stats(over: Partial<ScriptStats> = {}): ScriptStats {
  const base: ScriptStats = {
    scriptId: "quota.summary",
    scriptVer: 1,
    candidates: 50,
    portRuns: 50,
    portOk: 50,
    unavailable: 0,
    judged: 50,
    agree: 50,
    noTool: 0,
    diverge: 0,
    unknown: 0,
    reasked: 0,
    crossSessionRepeats: 0,
    corrected: 0,
    answered: 0,
    fallback: 0,
    repeat: 0,
  };
  return { ...base, ...over };
}

function shadowRecord(over: Partial<ReflexRecordV1> = {}): ReflexRecordV1 {
  return {
    v: 1,
    kind: "shadow",
    at: 1_000,
    scriptId: "quota.summary",
    scriptVer: 1,
    state: "shadow",
    band: "high",
    requestDigest: "0123456789abcdef",
    chars: 10,
    ...over,
  };
}

function answerDetails(over: Partial<ReflexAnswerDetailsV1> = {}): ReflexAnswerDetailsV1 {
  return {
    v: 1,
    scriptId: "quota.summary",
    scriptVer: 1,
    portId: "quota.summary",
    portVer: 1,
    ms: 5,
    requestDigest: "0123456789abcdef",
    lines: 4,
    truncated: false,
    facts: {},
    ...over,
  };
}

function correction(over: Partial<ReflexCorrectionV1> = {}): ReflexCorrectionV1 {
  return {
    v: 1,
    at: 2_000,
    targetKind: "shadow",
    targetScriptId: "quota.summary",
    targetScriptVer: 1,
    targetDigest: "0123456789abcdef",
    deltaMs: 10_000,
    correctionDigest: "ffffffffffffffff",
    ...over,
  };
}

describe("PROMOTION_GATE (U5)", () => {
  it("pins the user-approved thresholds", () => {
    expect(PROMOTION_GATE).toEqual({
      minCandidates: 50,
      minOkRate: 0.99,
      maxDivergeRate: 0.05,
      maxReasked: 0,
      maxCorrected: 0,
    });
    expect(Object.isFrozen(PROMOTION_GATE)).toBe(true);
  });
});

describe("evaluatePromotion · boundaries", () => {
  it("the clean 50/50/50 baseline is eligible with zero reasons", () => {
    const verdict = evaluatePromotion(stats());
    expect(verdict).toEqual({ eligible: true, reasons: [] });
  });

  it("candidates: 50 passes, 49 fails with the Chinese reason", () => {
    expect(evaluatePromotion(stats({ candidates: 49 })).eligible).toBe(false);
    expect(evaluatePromotion(stats({ candidates: 49 })).reasons[0]).toContain("候选不足 50");
    expect(evaluatePromotion(stats({ candidates: 50 })).eligible).toBe(true);
  });

  it("portRuns below 50 fails independently", () => {
    const verdict = evaluatePromotion(stats({ portRuns: 49, portOk: 49 }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(";")).toContain("port 运行数不足");
  });

  it("okRate: 0.99 passes exactly, 0.989/0.98 fail", () => {
    expect(evaluatePromotion(stats({ portRuns: 100, portOk: 99 })).eligible).toBe(true); // exactly 0.99
    expect(evaluatePromotion(stats({ portRuns: 99, portOk: 98 })).eligible).toBe(false); // 0.9898…
    expect(evaluatePromotion(stats({ portRuns: 100, portOk: 98 })).eligible).toBe(false); // 0.98
  });

  it("divergeRate: exactly 5% passes, above fails", () => {
    expect(evaluatePromotion(stats({ agree: 190, diverge: 10, judged: 200 })).eligible).toBe(true); // 0.05
    expect(evaluatePromotion(stats({ agree: 189, diverge: 11, judged: 200 })).eligible).toBe(false); // 0.055
    expect(evaluatePromotion(stats({ agree: 189, diverge: 11, judged: 200 })).reasons.join(";")).toContain("分歧率");
  });

  it("judged below 50 fails independently", () => {
    const verdict = evaluatePromotion(stats({ agree: 40, diverge: 0, judged: 40 }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(";")).toContain("判定样本不足");
  });

  it("unknown never enters the judged denominator", () => {
    // diverge 6/50 judged = 12% (fail); 950 unknowns must NOT dilute it to 0.6%.
    const verdict = evaluatePromotion(stats({ agree: 44, diverge: 6, judged: 50, unknown: 950 }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(";")).toContain("分歧率 12.0%");
  });

  it("reasked = 1 fails; crossSessionRepeats undefined OR ≥1 fails; corrected = 1 fails", () => {
    expect(evaluatePromotion(stats({ reasked: 1 })).eligible).toBe(false);
    expect(evaluatePromotion(stats({ reasked: 1 })).reasons.join(";")).toContain("重复提问");
    expect(evaluatePromotion(stats({ crossSessionRepeats: undefined })).eligible).toBe(false);
    expect(evaluatePromotion(stats({ crossSessionRepeats: undefined })).reasons.join(";")).toContain(
      "跨会话重复未判定",
    );
    expect(evaluatePromotion(stats({ crossSessionRepeats: 1 })).eligible).toBe(false);
    expect(evaluatePromotion(stats({ corrected: 1 })).eligible).toBe(false);
    expect(evaluatePromotion(stats({ corrected: 1 })).reasons.join(";")).toContain("纠正");
  });

  it("lists every failed criterion at once (never truncates reasons)", () => {
    const verdict = evaluatePromotion(
      stats({
        candidates: 0,
        portRuns: 0,
        portOk: 0,
        judged: 0,
        agree: 0,
        crossSessionRepeats: undefined,
        corrected: 3,
        reasked: 2,
      }),
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.length).toBe(7);
  });
});

describe("accumulate (口径 folding)", () => {
  it("shadow records feed candidates / portRuns / portOk; unavailable stays out of the rate", () => {
    const map = new Map();
    accumulate(map, { kind: "record", rec: shadowRecord({ port: { outcome: "ok", ms: 4, portVer: 1 } }) });
    accumulate(map, { kind: "record", rec: shadowRecord({ port: { outcome: "unavailable", ms: 1, portVer: 1 } }) });
    accumulate(map, {
      kind: "record",
      rec: shadowRecord({ port: { outcome: "error", ms: 2, reason: "x", portVer: 1 } }),
    });
    const s = map.get("quota.summary@1")!;
    expect(s.candidates).toBe(3);
    expect(s.portRuns).toBe(2); // ok + error
    expect(s.portOk).toBe(1);
    expect(s.unavailable).toBe(1);
  });

  it("agreement folds into agree/noTool/diverge/unknown and keeps judged = a+n+d", () => {
    const map = new Map();
    for (const agree of ["agree", "no-tool", "diverge", "unknown"] as const) {
      accumulate(map, { kind: "record", rec: shadowRecord({ model: { agree, tools: [] } }) });
    }
    const s = map.get("quota.summary@1")!;
    expect([s.agree, s.noTool, s.diverge, s.unknown]).toEqual([1, 1, 1, 1]);
    expect(s.judged).toBe(3);
  });

  it("reasked marks and AUTO-era repeats both count; the repeat field tracks kind separately", () => {
    const map = new Map();
    accumulate(map, { kind: "record", rec: shadowRecord({ reasked: true }) });
    accumulate(map, { kind: "record", rec: shadowRecord({ kind: "repeat", state: "auto", band: "high" }) });
    accumulate(map, { kind: "record", rec: shadowRecord({ kind: "repeat", state: "shadow" }) });
    const s = map.get("quota.summary@1")!;
    expect(s.reasked).toBe(2); // mark + AUTO repeat
    expect(s.repeat).toBe(2);
    expect(s.candidates).toBe(1); // only the shadow record
  });

  it("fallback records count fallback (not candidates); answers count answered", () => {
    const map = new Map();
    accumulate(map, {
      kind: "record",
      rec: shadowRecord({ kind: "fallback", port: { outcome: "timeout", ms: 1200, portVer: 1 } }),
    });
    accumulate(map, { kind: "answer", details: answerDetails() });
    const s = map.get("quota.summary@1")!;
    expect(s.fallback).toBe(1);
    expect(s.candidates).toBe(0);
    expect(s.portRuns).toBe(0); // fallback ports stay out of the shadow-scoped rate
    expect(s.answered).toBe(1);
  });

  it("corrections target scriptId@scriptVer exactly", () => {
    const map = new Map();
    accumulate(map, { kind: "record", rec: shadowRecord() });
    accumulate(map, { kind: "correction", c: correction({ targetScriptId: "quota.summary", targetScriptVer: 2 }) });
    expect(map.get("quota.summary@1")!.corrected).toBe(0);
    expect(map.get("quota.summary@2")!.corrected).toBe(1);
  });

  it("a mixed realistic stream lands on an eligible verdict", () => {
    const map = new Map();
    for (let i = 0; i < 100; i++) {
      accumulate(map, {
        kind: "record",
        rec: shadowRecord({
          port: { outcome: i < 99 ? "ok" : "uncertain", ms: 3, portVer: 1 },
          model: { agree: "agree", tools: [] },
        }),
      });
    }
    const s = map.get("quota.summary@1")!;
    expect(s.portRuns).toBe(100);
    expect(s.portOk).toBe(99); // exactly 0.99
    s.crossSessionRepeats = countCrossSessionRepeats([
      { session: "a", at: 1, key: "quota.summary@1", digest: "d" },
    ]).get("quota.summary@1");
    expect(evaluatePromotion(s).eligible).toBe(true);
  });
});

describe("countCrossSessionRepeats", () => {
  const K = "quota.summary@1";
  const D = "0123456789abcdef";

  it("same-session repeats never count", () => {
    const rows = [
      { session: "a", at: 0, key: K, digest: D },
      { session: "a", at: 300_000, key: K, digest: D },
      { session: "a", at: 599_999, key: K, digest: D },
    ];
    expect(countCrossSessionRepeats(rows).get(K)).toBe(0);
  });

  it("cross-session within REPEAT_WINDOW_MS counts", () => {
    const rows = [
      { session: "a", at: 0, key: K, digest: D },
      { session: "b", at: 600_000, key: K, digest: D }, // boundary inclusive
    ];
    expect(countCrossSessionRepeats(rows).get(K)).toBe(1);
  });

  it("outside the window does not count", () => {
    const rows = [
      { session: "a", at: 0, key: K, digest: D },
      { session: "b", at: 600_001, key: K, digest: D },
    ];
    expect(countCrossSessionRepeats(rows).get(K)).toBe(0);
  });

  it("different scriptVer (key) and different digest are separate series", () => {
    const rows = [
      { session: "a", at: 0, key: K, digest: D },
      { session: "b", at: 1, key: "quota.summary@2", digest: D }, // different key
      { session: "b", at: 2, key: K, digest: "ffffffffffffffff" }, // different digest
    ];
    const counts = countCrossSessionRepeats(rows);
    expect(counts.get(K)).toBe(0);
    expect(counts.get("quota.summary@2")).toBe(0);
  });

  it("chained sessions count per re-occurrence (a→b→a = 2)", () => {
    const rows = [
      { session: "a", at: 0, key: K, digest: D },
      { session: "b", at: 360_000, key: K, digest: D },
      { session: "a", at: 480_000, key: K, digest: D },
    ];
    expect(countCrossSessionRepeats(rows).get(K)).toBe(2);
  });

  it("unsorted input is ordered by `at` first", () => {
    const rows = [
      { session: "b", at: 300_000, key: K, digest: D },
      { session: "a", at: 0, key: K, digest: D },
    ];
    expect(countCrossSessionRepeats(rows).get(K)).toBe(1);
  });

  it("every seen key maps (0 included); unseen keys are absent ⇒ undetermined upstream", () => {
    const counts = countCrossSessionRepeats([{ session: "a", at: 0, key: K, digest: D }]);
    expect(counts.has(K)).toBe(true);
    expect(counts.get(K)).toBe(0);
    expect(counts.has("jobs.list@1")).toBe(false);
  });
});

describe("msPercentiles", () => {
  it("empty ⇒ no percentiles", () => {
    expect(msPercentiles([])).toEqual({});
  });

  it("picks nearest-rank percentiles from sorted samples", () => {
    expect(msPercentiles([10, 20, 30, 40])).toEqual({ p50: 30, p95: 40 });
    expect(msPercentiles(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ p50: 51, p95: 96 });
  });
});
