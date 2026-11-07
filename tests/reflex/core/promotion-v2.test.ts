import { describe, expect, it } from "vitest";
import {
  accumulateV2,
  buildLiveEvidence,
  evaluateMergedPromotion,
  portReliabilityV2,
  PROMOTION_GATE_V2,
  type LiveEvidenceRow,
} from "../../../src/reflex/core/promotion.js";
import { BUILTIN_SCRIPTS } from "../../../src/reflex/core/catalog.js";
import type {
  BacktestEvidence,
  EvidenceIdentity,
  MergedEvidence,
  PortReliability,
  StatsV2,
} from "../../../src/reflex/core/types.js";
import { makeRecord } from "../helpers/turn.js";

const identity: EvidenceIdentity = { lineage: "jobs.list", templateHash: "hash", portId: "jobs.list", portVer: 1 };
const live: StatsV2 = { identity, judged: 50, diverge: 0, reasked: 0, corrected: 0, crossSessionRepeats: 0 };
const port: PortReliability = { portId: "jobs.list", portVer: 1, runs: 10, ok: 10, missing: 0, unavailable: 0 };
const backtest: BacktestEvidence = {
  batchId: "b",
  manifestHash: "m",
  identity,
  confirmed: { judged: 50, diverge: 0 },
  lenient: {
    judged: 1000,
    diverge: 0,
    unknownFacts: { idle: 0, pendingMessages: 0, topicSwitchActive: 0, goalBusy: 0, inFlight: 0, sourceMode: 1000 },
  },
  reasked: 0,
  corrected: 0,
  crossSessionRepeats: 0,
  waived: 0,
  suspects: 2,
  reviewed: 2,
  misfires: 0,
  unscored: 0,
};
const evidence = (over: Partial<MergedEvidence> = {}): MergedEvidence => ({
  identity,
  live,
  port,
  scanComplete: true,
  ...over,
});
const rows = (n: number, outcome: "ok" | "uncertain" = "ok", version = 1): LiveEvidenceRow[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: "record",
    entryId: `r${i}`,
    session: "a",
    rec: makeRecord({
      scriptId: "jobs.list",
      at: i,
      requestDigest: `d${i}`,
      port: { outcome, ms: 1, portVer: version },
    }),
  }));

describe("merged V2 evidence matrix", () => {
  it("freezes thresholds and accepts clean live evidence", () => {
    expect(PROMOTION_GATE_V2).toEqual({ minIntentSamples: 50, maxDivergeRate: 0.05, minPortRuns: 10 });
    expect(Object.isFrozen(PROMOTION_GATE_V2)).toBe(true);
    expect(evaluateMergedPromotion(evidence()).verdict).toBe("eligible");
  });
  it.each([49, 50])("confirmed %i; lenient cannot pad the rate", (judged) => {
    const e = evidence({
      live: { ...live, judged: 0 },
      backtest: { ...backtest, confirmed: { judged, diverge: 0 } },
      batchValid: { ok: true },
    });
    expect(evaluateMergedPromotion(e).verdict).toBe(judged === 50 ? "eligible" : "not-eligible");
  });
  it.each([50, 51])("diverge %i / 1000 threshold", (diverge) => {
    expect(evaluateMergedPromotion(evidence({ live: { ...live, judged: 1000, diverge } })).verdict).toBe(
      diverge === 50 ? "eligible" : "not-eligible",
    );
    expect(
      evaluateMergedPromotion(
        evidence({
          live: { ...live, judged: 0 },
          backtest: { ...backtest, confirmed: { judged: 1000, diverge } },
          batchValid: { ok: true },
        }),
      ).verdict,
    ).toBe(diverge === 50 ? "eligible" : "not-eligible");
  });
  it.each(["review-incomplete", "misfire", "scan-incomplete"])("blocks %s even with sufficient intent", (reason) => {
    const e = evidence({
      backtest: {
        ...backtest,
        reviewed: reason === "review-incomplete" ? 1 : 2,
        misfires: reason === "misfire" ? 1 : 0,
      },
      batchValid: { ok: true },
      scanComplete: reason !== "scan-incomplete",
    });
    expect(evaluateMergedPromotion(e).verdict).toBe("not-eligible");
    expect(evaluateMergedPromotion(e).reasons).toContain(reason);
  });
  it.each(["reasked", "corrected", "crossSessionRepeats"] as const)("zero tolerance: %s", (field) => {
    expect(evaluateMergedPromotion(evidence({ live: { ...live, [field]: 1 } })).verdict).toBe("not-eligible");
    expect(
      evaluateMergedPromotion(evidence({ backtest: { ...backtest, [field]: 1 }, batchValid: { ok: true } })).verdict,
    ).toBe("not-eligible");
  });
  it("backtest can stand alone with determined backtest repeats; unknown live repeats cannot", () => {
    const e = evidence({ backtest, batchValid: { ok: true } });
    delete e.live;
    expect(evaluateMergedPromotion(e).verdict).toBe("eligible");
    const unknown = { ...live };
    delete unknown.crossSessionRepeats;
    expect(evaluateMergedPromotion(evidence({ live: unknown })).verdict).toBe("undetermined");
  });
});

describe("port V2", () => {
  it.each([9, 10])("%i successes", (n) => {
    const p = portReliabilityV2(rows(n)).get("jobs.list@1")!;
    expect(p.runs).toBe(n);
    expect(evaluateMergedPromotion(evidence({ port: p })).verdict).toBe(n === 10 ? "eligible" : "not-eligible");
  });
  it("uncertain is a failed run; unavailable is separate", () => {
    const r = rows(9).concat(rows(1, "uncertain"));
    r.push({
      kind: "record",
      rec: makeRecord({ scriptId: "jobs.list", port: { outcome: "unavailable", ms: 1, portVer: 1 } }),
    });
    const p = portReliabilityV2(r).get("jobs.list@1")!;
    expect(p).toEqual({ ...port, ok: 9, unavailable: 1 });
    expect(evaluateMergedPromotion(evidence({ port: p })).verdict).toBe("not-eligible");
  });
  it("old successes cannot support a new port version", () => {
    const p = portReliabilityV2(rows(10)).get("jobs.list@1")!;
    expect(evaluateMergedPromotion(evidence({ identity: { ...identity, portVer: 2 }, port: p })).verdict).toBe(
      "not-eligible",
    );
  });
  it("late discarded failure / slot replacement is missing and taints a new version", () => {
    const r = rows(10);
    r.push({ kind: "record", rec: makeRecord({ scriptId: "jobs.list" }) });
    const ports = portReliabilityV2(r);
    expect(ports.get("jobs.list@0")?.missing).toBe(1);
    expect(ports.get("jobs.list@1")?.missing).toBe(1);
    expect(
      evaluateMergedPromotion(evidence({ identity: { ...identity, portVer: 2 }, port: ports.get("jobs.list@0")! }))
        .verdict,
    ).toBe("undetermined");
  });
  it("fork dedup happens before runs and cross-session repeats", () => {
    const r = rows(10);
    const result = buildLiveEvidence(r.concat(r.map((x) => ({ ...x, session: "fork" }))), BUILTIN_SCRIPTS, []);
    expect(result.ports.get("jobs.list@1")?.runs).toBe(10);
    expect([...result.stats.values()][0]?.crossSessionRepeats).toBe(0);
  });
  it("unknown agreement and ambiguous records cannot pad judged", () => {
    const r = rows(1).concat([
      { kind: "record", rec: makeRecord({ scriptId: "jobs.list", kind: "ambiguous" }) },
      { kind: "record", rec: makeRecord({ scriptId: "jobs.list", model: { agree: "unknown", tools: [] } }) },
    ]);
    expect(accumulateV2(r, () => identity).get("jobs.list#hash")?.judged).toBe(1);
  });
});
