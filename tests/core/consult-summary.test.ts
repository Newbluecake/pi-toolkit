import { describe, expect, it } from "vitest";
import {
  appendConsultCacheProbe,
  classifyConsultToolEnd,
  CONSULT_CACHE_PROBES_CAP,
  CONSULT_NOT_IN_WHITELIST_MARK,
  CONSULT_OUTCOMES,
  foldConsultCacheProbe,
  foldConsultCall,
  type ConsultCallFact,
  type ConsultSummary,
} from "../../src/core/consult-summary.js";

function okResult(details: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: "answer" }], details };
}
function errorResult(message: string): unknown {
  return { content: [{ type: "text", text: message }], details: {} };
}

describe("classifyConsultToolEnd (consult A/B instrumentation plan §2/§5 P1a)", () => {
  it("classifies a whitelist-mismatch throw as bad_ref", () => {
    const msg = `consult: expert "ghost" ${CONSULT_NOT_IN_WHITELIST_MARK} (allowed: a, b).`;
    expect(classifyConsultToolEnd(true, errorResult(msg))).toEqual({ result: "bad_ref" });
  });

  it("classifies any other throw as invalid", () => {
    expect(classifyConsultToolEnd(true, errorResult("consult: question must not be empty."))).toEqual({
      result: "invalid",
    });
  });

  it("classifies an isError result with no parseable content as invalid (no MARK found)", () => {
    expect(classifyConsultToolEnd(true, { content: [], details: {} })).toEqual({ result: "invalid" });
    expect(classifyConsultToolEnd(true, undefined)).toEqual({ result: "invalid" });
  });

  it("classifies every real tool outcome verbatim", () => {
    for (const outcome of CONSULT_OUTCOMES) {
      expect(classifyConsultToolEnd(false, okResult({ outcome, expertRunId: "r_x" }))).toEqual({
        result: outcome,
        expertRunId: "r_x",
      });
    }
  });

  it("classifies a missing/unrecognized details.outcome as unknown", () => {
    expect(classifyConsultToolEnd(false, okResult({}))).toEqual({ result: "unknown" });
    expect(classifyConsultToolEnd(false, okResult({ outcome: "some_future_outcome" }))).toEqual({ result: "unknown" });
    expect(classifyConsultToolEnd(false, { content: [{ type: "text", text: "x" }] })).toEqual({ result: "unknown" });
  });

  it("carries costUsd/truncated/partial through when present", () => {
    expect(classifyConsultToolEnd(false, okResult({ outcome: "completed", costUsd: 0.12, truncated: true }))).toEqual({
      result: "completed",
      costUsd: 0.12,
      truncated: true,
    });
    expect(classifyConsultToolEnd(false, okResult({ outcome: "aborted", partial: true }))).toEqual({
      result: "aborted",
      partial: true,
    });
  });

  it("ignores a non-finite or non-number costUsd", () => {
    expect(classifyConsultToolEnd(false, okResult({ outcome: "completed", costUsd: NaN }))).toEqual({
      result: "completed",
    });
    expect(classifyConsultToolEnd(false, okResult({ outcome: "completed", costUsd: "0.1" }))).toEqual({
      result: "completed",
    });
  });

  it("ignores a blank/non-string expertRunId", () => {
    expect(classifyConsultToolEnd(false, okResult({ outcome: "completed", expertRunId: "" }))).toEqual({
      result: "completed",
    });
    expect(classifyConsultToolEnd(false, okResult({ outcome: "completed", expertRunId: 42 }))).toEqual({
      result: "completed",
    });
  });
});

describe("foldConsultCall (consult A/B instrumentation plan §2/§5 P1a)", () => {
  function fact(over: Partial<ConsultCallFact> = {}): ConsultCallFact {
    return { result: "completed", ...over };
  }

  it("starts every counter at zero and increments calls/byResult on the first fold", () => {
    const out = foldConsultCall(undefined, fact({ costUsd: 0.5 }), 100);
    expect(out).toEqual<ConsultSummary>({
      calls: 1,
      byResult: { completed: 1 },
      truncated: 0,
      partial: 0,
      costUsd: 0.5,
      unpricedCalls: 0,
      latencyMs: 100,
      maxLatencyMs: 100,
      latencyUnknown: 0,
    });
  });

  it("accumulates byResult per distinct outcome across folds", () => {
    let s: ConsultSummary | undefined;
    s = foldConsultCall(s, fact({ result: "completed" }), 10);
    s = foldConsultCall(s, fact({ result: "bad_ref" }), undefined);
    s = foldConsultCall(s, fact({ result: "completed" }), 20);
    expect(s.calls).toBe(3);
    expect(s.byResult).toEqual({ completed: 2, bad_ref: 1 });
  });

  it("sums costUsd across calls without double counting (plain addition)", () => {
    let s: ConsultSummary | undefined;
    s = foldConsultCall(s, fact({ costUsd: 0.1 }), 1);
    s = foldConsultCall(s, fact({ costUsd: 0.25 }), 1);
    expect(s.costUsd).toBeCloseTo(0.35);
  });

  it("counts truncated/partial independently", () => {
    let s: ConsultSummary | undefined;
    s = foldConsultCall(s, fact({ truncated: true }), 1);
    s = foldConsultCall(s, fact({ partial: true }), 1);
    s = foldConsultCall(s, fact({ truncated: true, partial: true }), 1);
    expect(s.truncated).toBe(2);
    expect(s.partial).toBe(2);
  });

  it("counts a post-spawn call with no/zero cost as unpriced", () => {
    let s: ConsultSummary | undefined;
    s = foldConsultCall(s, fact({ result: "completed" }), 1); // no costUsd at all
    s = foldConsultCall(s, fact({ result: "completed", costUsd: 0 }), 1); // explicit zero
    s = foldConsultCall(s, fact({ result: "completed", costUsd: 0.5 }), 1); // priced
    expect(s.unpricedCalls).toBe(2);
  });

  it("never counts a pre-spawn nack (no run was ever started) as unpriced", () => {
    let s: ConsultSummary | undefined;
    for (const result of ["unavailable", "still_running", "busy", "context_too_large", "cost_too_high"] as const) {
      s = foldConsultCall(s, fact({ result }), undefined);
    }
    expect(s.unpricedCalls).toBe(0);
  });

  it("latency: unresolved startedAt contributes 0 to latencyMs and increments latencyUnknown, leaves maxLatencyMs alone", () => {
    let s: ConsultSummary | undefined;
    s = foldConsultCall(s, fact(), 50);
    s = foldConsultCall(s, fact(), undefined);
    s = foldConsultCall(s, fact(), 30);
    expect(s.latencyMs).toBe(80); // 50 + 0 + 30
    expect(s.maxLatencyMs).toBe(50);
    expect(s.latencyUnknown).toBe(1);
  });

  it("byExpert: counts per expertRunId, caps the TOTAL key count (incl. _other) at 16 — review §8 M3", () => {
    let s: ConsultSummary | undefined;
    for (let i = 0; i < 20; i++) {
      s = foldConsultCall(s, fact({ expertRunId: `r_${i}` }), 1);
    }
    const byExpert = s!.byExpert!;
    const realKeys = Object.keys(byExpert).filter((k) => k !== "_other");
    // "_other" itself occupies one of the 16 total slots: 15 real experts get
    // their own key, r_15..r_19 (5 experts) all fold into "_other".
    expect(Object.keys(byExpert)).toHaveLength(16);
    expect(realKeys).toHaveLength(15);
    expect(byExpert["_other"]).toBe(5); // r_15..r_19
    // Re-visiting an already-tracked key increments it, not _other.
    s = foldConsultCall(s, fact({ expertRunId: "r_0" }), 1);
    expect(s.byExpert!["r_0"]).toBe(2);
    expect(Object.keys(s.byExpert!)).toHaveLength(16); // revisiting never grows the total
  });

  it("leaves byExpert absent entirely when no fact ever carried an expertRunId", () => {
    let s: ConsultSummary | undefined;
    s = foldConsultCall(s, fact(), 1);
    s = foldConsultCall(s, fact(), 1);
    expect(s.byExpert).toBeUndefined();
  });
});

describe("ConsultCacheProbe bounded FIFO ring (consult C2 §4.1)", () => {
  function probe(i: number): Parameters<typeof appendConsultCacheProbe>[1] {
    return {
      expertRunId: `r_${i}`,
      outcome: "completed",
      identity: { preflight: "pass", expertTools: i },
    };
  }

  it("keeps only the newest eight probes and does not mutate the input ring", () => {
    let ring = [probe(-1)];
    for (let i = 0; i < CONSULT_CACHE_PROBES_CAP + 3; i++) ring = appendConsultCacheProbe(ring, probe(i));
    expect(ring).toHaveLength(CONSULT_CACHE_PROBES_CAP);
    expect(ring.map((p) => p.expertRunId)).toEqual(["r_3", "r_4", "r_5", "r_6", "r_7", "r_8", "r_9", "r_10"]);
    expect(appendConsultCacheProbe(undefined, probe(1))).toEqual([probe(1)]);
  });

  it("folds probe diagnostics without changing the existing call counters", () => {
    const first = foldConsultCacheProbe(undefined, {
      ...probe(1),
      identity: { preflight: "fail:tool-definition:read", expertTools: 1 },
      blocked: { calls: 2, batches: 1, terminated: true, identity: 1, nested: 0, costAfterUsd: 0.2 },
    });
    expect(first.calls).toBe(0);
    expect(first.cacheProbes).toHaveLength(1);
    expect(first.blockedCalls).toBe(2);
    expect(first.identityFailures).toEqual({ "tool-definition:read": 1 });
  });
});
