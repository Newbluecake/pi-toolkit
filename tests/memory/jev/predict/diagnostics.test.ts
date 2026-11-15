// Pure selection observations only; no model/network/timers. Tier1 by default.
import { describe, expect, test } from "vitest";
import {
  PredictDiagnostics,
  PREDICT_DIAG_MAX_BYTES,
  PREDICT_DIAG_MAX_REJECTED,
} from "../../../../src/memory/jev/predict/diagnostics.js";
import { selectPEntries, type Candidate, type SelectPInput } from "../../../../src/memory/jev/predict/select.js";

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  hash: "h",
  diagnosticId: "topic.001",
  isPrivate: false,
  isSecret: false,
  isInjected: false,
  isStaticCore: false,
  coolingDown: false,
  pending: false,
  importance: 2,
  type: "rule",
  tagP: { release: 1 },
  byteLength: 100,
  ...overrides,
});
const input = (candidates: readonly Candidate[], overrides: Partial<SelectPInput> = {}): SelectPInput => ({
  tags: [{ tag: "release", score: 0.9, sources: ["U"], rules: ["x"] }],
  eligibleTags: new Set(["release"]),
  candidates,
  maxEntries: 2,
  maxBytes: 512,
  ...overrides,
});
const finish = (d: PredictDiagnostics, i: SelectPInput) =>
  d.finish({
    turnSeq: 1,
    isChild: false,
    tags: i.tags,
    taxonomy: [{ id: "release", risk: "high" }],
    fastPath: { allowTags: [], denyTags: [] },
    selected: [],
    committed: [],
    idOf: (h) => h,
    origin: "rules",
    remainingBefore: 30,
    remainingAfter: 30,
    maxEntries: i.maxEntries,
    maxBytes: i.maxBytes,
  });

describe("P selection rejection reasons", () => {
  test.each([
    ["private-secret", { isPrivate: true }],
    ["private-secret", { isSecret: true }],
    ["segment-dup", { isInjected: true }],
    ["resident-global", { isStaticCore: true }],
    ["cooldown", { coolingDown: true }],
    ["importance", { importance: 1 }],
    ["type", { type: "fact" }],
    ["shared-tag", { tagP: { docs: 1 } }],
    ["byte-budget", { byteLength: 513 }],
  ] as const)("%s rejects with unchanged picks", (reason, overrides) => {
    const i = input([candidate(overrides)]);
    const d = new PredictDiagnostics();
    expect(selectPEntries(i, d)).toEqual(selectPEntries(i));
    expect(selectPEntries(i)).toEqual([]);
    expect(d.counts[reason]?.reject).toBe(1);
    expect(d.rejected).toEqual(reason === "private-secret" ? [] : [{ id: "topic.001", reason }]);
  });

  test("score/risk-allow gates and deny membership are distinct", () => {
    for (const [score, eligible, reason] of [
      [0.84, true, "tag-score"],
      [0.9, false, "risk-allow"],
    ] as const) {
      const i = input([candidate()], {
        tags: [{ tag: "release", score, sources: ["M"], rules: [] }],
        eligibleTags: new Set(eligible ? ["release"] : []),
      });
      const d = new PredictDiagnostics();
      expect(selectPEntries(i, d)).toEqual([]);
      expect(d.rejected).toEqual([{ id: "topic.001", reason }]);
    }
    const d = new PredictDiagnostics();
    const r = d.finish({
      ...{
        turnSeq: 1,
        isChild: true,
        tags: input([]).tags,
        taxonomy: [{ id: "release", risk: "high" as const }],
        selected: [],
        committed: [],
        idOf: (h: string) => h,
        origin: "rules+cache",
        remainingBefore: 30,
        remainingAfter: 30,
        maxEntries: 2,
        maxBytes: 512,
      },
      fastPath: { allowTags: ["release"], denyTags: ["release"] },
    });
    expect(r.tags[0]).toMatchObject({ highRisk: true, allow: true, deny: true, eligible: false });
    expect(r.counts["deny-clear"]).toEqual({ pass: 0, reject: 1 });
    expect(r.session).toBe("child");
  });

  test("entry cap counts all remaining ranked candidates", () => {
    const i = input([candidate(), candidate({ hash: "h2", diagnosticId: "topic.002" })], { maxEntries: 1 });
    const d = new PredictDiagnostics();
    expect(selectPEntries(i, d)).toEqual(selectPEntries(i));
    expect(d.rejected).toEqual([{ id: "topic.002", reason: "entry-cap" }]);
  });

  test.each([
    ["bypass-entry-cap", { maxEntries: 0 }],
    ["bypass-byte-budget", { maxBytes: 99 }],
  ] as const)("%s never bypasses budget", (reason, overrides) => {
    const i = input([candidate({ coolingDown: true })], { ...overrides, highRiskTags: new Set(["release"]) });
    const d = new PredictDiagnostics();
    expect(selectPEntries(i, d)).toEqual([]);
    expect(d.counts["bypass-available"]?.pass).toBe(1);
    expect(d.counts[reason]?.reject).toBe(1);
  });

  test("bypass retains the original cooldown rejection and marks the actual selected pick", () => {
    const i = input([candidate({ coolingDown: true })], { highRiskTags: new Set(["release"]) });
    const d = new PredictDiagnostics();
    expect(selectPEntries(i, d)).toEqual([{ hash: "h", score: 1.8, byteLength: 100, bypass: true }]);
    expect(d.counts["cooldown"]?.reject).toBe(1);
    expect(d.counts["bypass-byte-budget"]?.pass).toBe(1);
  });

  test("sample and UTF-8 bounds preserve complete counters, with no bodies", () => {
    const d = new PredictDiagnostics();
    const i = input(
      Array.from({ length: 200 }, (_, n) =>
        candidate({ hash: `h${n}`, diagnosticId: '汉"\\'.repeat(96), importance: 1 }),
      ),
    );
    expect(selectPEntries(i, d)).toEqual([]);
    const r = finish(d, i);
    expect(r.counts["importance"]?.reject).toBe(200);
    expect(r.rejected.length).toBeLessThanOrEqual(PREDICT_DIAG_MAX_REJECTED);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(PREDICT_DIAG_MAX_BYTES);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

test("defensive field/byte limits also cover escaping IDs, picks and future gate additions", () => {
  const d = new PredictDiagnostics();
  for (let n = 0; n < 200; n++) d.gate(`future-${n}`, false, "\u0000".repeat(200));
  const r = d.finish({
    turnSeq: 1,
    isChild: false,
    tags: Array.from({ length: 40 }, () => ({
      tag: "\u0000".repeat(200),
      score: 0.9,
      sources: ["M" as const],
      rules: [],
    })),
    taxonomy: [],
    fastPath: { allowTags: [], denyTags: [] },
    selected: Array.from({ length: 40 }, () => ({ hash: "x", score: 1, byteLength: 1 })),
    committed: Array.from({ length: 40 }, () => "x"),
    idOf: () => "\u0000".repeat(200),
    origin: "rules+cache",
    remainingBefore: 30,
    remainingAfter: 30,
    maxEntries: 5,
    maxBytes: 8192,
  });
  expect(r.truncated).toBe(true);
  expect(Object.keys(r.counts).length).toBeLessThanOrEqual(49);
  expect(Object.values(r.counts).reduce((n, c) => n + c.reject, 0)).toBeGreaterThanOrEqual(200);
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(PREDICT_DIAG_MAX_BYTES);
  expect(r.selected.length).toBeLessThanOrEqual(32);
  expect(r.committed.length).toBeLessThanOrEqual(32);
});
