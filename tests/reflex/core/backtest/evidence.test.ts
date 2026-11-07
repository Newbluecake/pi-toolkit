/**
 * B1 · evidence fold (BA §4.7 / U2 / U4 / K11): batch-membership scoping, confirmed-vs-lenient
 * ledgers, unknownFacts tallies, review waivers (unverified records, R-I14), suspect/review/
 * misfire counting, unscored rows, cross-session repeats via the B0 promotion helper, and the
 * DILUTION counter-example — 3/50 confirmed diverge stays 6% while 50 lenient no-tool rows
 * sit in their own ledger and never soften it.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_SCRIPTS } from "../../../../src/reflex/core/catalog.js";
import {
  backtestEvidence,
  highIdentityOf,
  parseReviewFile,
  turnKeyOf,
} from "../../../../src/reflex/core/backtest/evidence.js";
import { replay } from "../../../../src/reflex/core/backtest/replay.js";
import { ALL_CAPS } from "./fixtures-b1.js";
import { makeTurn, T0 } from "../../helpers/turn.js";
import type {
  EvalBatchV1,
  EvidenceIdentity,
  ReplayRow,
  ReviewFileV1,
  Turn,
} from "../../../../src/reflex/core/types.js";

const HIT_Q = "后台还有几个 job";

const IDENT: EvidenceIdentity = { lineage: "jobs.list", templateHash: "t".repeat(16), portId: "jobs.list", portVer: 1 };

function makeBatch(turns: readonly Pick<Turn, "entryId" | "at">[], over: Partial<EvalBatchV1> = {}): EvalBatchV1 {
  const turnKeys = turns.map(turnKeyOf);
  return {
    v: 1,
    batchId: "batch-1",
    lineage: IDENT.lineage,
    manifestHash: "m".repeat(16),
    cutoffAt: 0,
    since: 0,
    until: Number.MAX_SAFE_INTEGER,
    turnKeys,
    turnDigests: [],
    createdAt: T0 + 1_000,
    ...over,
  };
}

function highRow(over: Partial<Turn> & Pick<Turn, "session" | "entryId">): ReturnType<typeof replay>[number] {
  const turn = makeTurn({ text: HIT_Q, at: T0, settledAt: T0 + 1, ...over });
  const rows = replay([turn], [], { builtin: BUILTIN_SCRIPTS }, ALL_CAPS);
  expect(rows[0]!.cls.k).toBe("high");
  return rows[0]!;
}

describe("turnKeyOf", () => {
  it("is sha256(entryId\\0at) full hex — the batch-key definition B3/B5 reuse", () => {
    const h = createHash("sha256").update("e1\u0000123", "utf8").digest("hex");
    expect(turnKeyOf({ entryId: "e1", at: 123 })).toBe(h);
    expect(h).toHaveLength(64);
  });
});

describe("parseReviewFile", () => {
  const good: ReviewFileV1 = {
    v: 1,
    entries: [{ digest: "d1", portId: "jobs.list", verdict: "ok", at: 1 }],
    unverified: true,
  };
  it("accepts a well-formed file and returns it verbatim", () => {
    expect(parseReviewFile(good)).toEqual(good);
  });
  it("rejects bad data with undefined (never partial trust)", () => {
    expect(parseReviewFile(undefined)).toBeUndefined();
    expect(parseReviewFile({ ...good, unverified: false })).toBeUndefined();
    expect(parseReviewFile({ ...good, v: 2 })).toBeUndefined();
    expect(
      parseReviewFile({ ...good, entries: [{ digest: "d1", portId: "p", verdict: "maybe", at: 1 }] }),
    ).toBeUndefined();
    expect(parseReviewFile({ ...good, entries: [{ digest: "", portId: "p", verdict: "ok", at: 1 }] })).toBeUndefined();
    expect(parseReviewFile({ ...good, entries: "no" })).toBeUndefined();
    expect(
      parseReviewFile({ ...good, entries: [{ digest: "d", portId: "p", verdict: "ok", at: -1 }] }),
    ).toBeUndefined();
  });
});

describe("highIdentityOf", () => {
  it("resolves builtin and draft rows; non-high rows are undefined", () => {
    const high = highRow({ session: "s", entryId: "1" });
    const ident = highIdentityOf(high, BUILTIN_SCRIPTS, []);
    expect(ident).toMatchObject({ lineage: "jobs.list", portId: "jobs.list" });
    expect(ident!.templateHash).toHaveLength(16);
    const missRow = replay(
      [makeTurn({ session: "s", entryId: "2", text: "今天天气怎么样", at: T0, settledAt: T0 + 1 })],
      [],
      { builtin: BUILTIN_SCRIPTS },
      ALL_CAPS,
    )[0]!;
    expect(highIdentityOf(missRow, BUILTIN_SCRIPTS, [])).toBeUndefined();
  });
});

describe("backtestEvidence scoping", () => {
  it("counts only rows whose turnKey ∈ batch AND split === holdout", () => {
    const inBatch = highRow({ session: "s", entryId: "in1", split: "holdout", digest: "a" });
    const outOfBatch = highRow({ session: "s", entryId: "out1", split: "holdout", digest: "b" });
    const trainRow = highRow({ session: "s", entryId: "tr1", split: "train", digest: "c" });
    const unscoredRow = highRow({ session: "s", entryId: "un1", split: "unscored", digest: "d" });
    const batch = makeBatch([inBatch.turn]);
    const ev = backtestEvidence([inBatch, outOfBatch, trainRow, unscoredRow], batch, IDENT);
    expect(ev.confirmed.judged).toBe(1); // only inBatch
    expect(ev.unscored).toBe(1); // regression-report rows counted separately
  });

  it("keeps confirmed and lenient ledgers apart with per-fact tallies", () => {
    const rows = [
      highRow({ session: "s", entryId: "c1", split: "holdout", digest: "a", unknownFacts: [] }),
      highRow({ session: "s", entryId: "c2", split: "holdout", digest: "b", unknownFacts: [], shapes: ["read"] }), // diverge
      highRow({
        session: "s",
        entryId: "l1",
        split: "holdout",
        digest: "c",
        unknownFacts: ["sourceMode", "idle", "pendingMessages"],
      }),
      highRow({
        session: "s",
        entryId: "l2",
        split: "holdout",
        digest: "d",
        unknownFacts: ["sourceMode"],
        shapes: ["read"],
      }),
    ];
    const ev = backtestEvidence(rows, makeBatch(rows.map((r) => r.turn)), IDENT);
    expect(ev.confirmed).toEqual({ judged: 2, diverge: 1 });
    expect(ev.lenient.judged).toBe(2);
    expect(ev.lenient.diverge).toBe(1);
    expect(ev.lenient.unknownFacts).toEqual({
      idle: 1,
      pendingMessages: 1,
      topicSwitchActive: 0,
      goalBusy: 0,
      inFlight: 0,
      sourceMode: 2,
    });
  });
});

describe("review records (unverified) affect only stats", () => {
  it("waives reasked/corrected with ok verdicts and counts suspects/reviewed/misfires", () => {
    // jobs.list rows: h1 no-tool; h2 diverge (misfired per review); h3 corrected (waived);
    // h4 re-asks h1's digest within the window (waived). g1 is a git.status row the caller
    // filters away per the backtestEvidence contract — its review noise must not leak in.
    const t1 = makeTurn({
      session: "s",
      entryId: "h1",
      text: HIT_Q,
      digest: "q1",
      at: T0,
      settledAt: T0 + 1,
      split: "holdout",
    });
    const t2 = makeTurn({
      session: "s",
      entryId: "h2",
      text: HIT_Q,
      digest: "q2",
      at: T0 + 60,
      settledAt: T0 + 61,
      split: "holdout",
      shapes: ["read"],
    });
    const t3 = makeTurn({
      session: "s",
      entryId: "h3",
      text: HIT_Q,
      digest: "q3",
      at: T0 + 70,
      settledAt: T0 + 71,
      split: "holdout",
    });
    const t4 = makeTurn({
      session: "s",
      entryId: "h4",
      text: HIT_Q,
      digest: "q1",
      at: T0 + 80,
      settledAt: T0 + 81,
      split: "holdout",
    });
    const tGit = makeTurn({
      session: "s",
      entryId: "g1",
      text: "工作区干净吗",
      digest: "g9",
      at: T0 + 200,
      settledAt: T0 + 201,
      split: "holdout",
    });
    const corrections = [{ session: "s", entryId: "cx", at: T0 + 90, origin: "tui" as const, corrHit: true }];
    const all = replay([t1, t2, t3, t4, tGit], corrections, { builtin: BUILTIN_SCRIPTS }, ALL_CAPS);
    const rows = all.filter((r) => {
      const id = highIdentityOf(r, BUILTIN_SCRIPTS, []);
      return id !== undefined && id.lineage === "jobs.list";
    });
    expect(rows).toHaveLength(4);
    const by = (id: string) => rows.find((r) => r.turn.entryId === id)!;
    expect(by("h4").corrected).toBe(true); // correction at T0+90 lands in the LATEST memo (h4, settled T0+81)
    expect(by("h4").reasked).toBe(true); // h1's digest again within REPEAT_WINDOW_MS, same session
    const review: ReviewFileV1 = {
      v: 1,
      unverified: true,
      entries: [
        { digest: "q3", portId: "jobs.list", verdict: "ok", at: T0 + 300 }, // waives h3's corrected
        { digest: "q1", portId: "jobs.list", verdict: "ok", at: T0 + 301 }, // waives h4's reasked
        { digest: "q2", portId: "jobs.list", verdict: "misfire", at: T0 + 302 }, // a REAL misfire on h2
        { digest: "g9", portId: "git.status", verdict: "misfire", at: T0 + 303 }, // filtered row — must not count
      ],
    };
    const ev = backtestEvidence(rows, makeBatch(rows.map((r) => r.turn)), IDENT, review);
    expect(ev.reasked).toBe(0); // waived
    expect(ev.corrected).toBe(0); // waived
    expect(ev.waived).toBe(1); // h4 (reasked + corrected on the same row, waived once)
    expect(ev.suspects).toBe(2); // h2 diverge + h4 corrected
    expect(ev.reviewed).toBe(2); // h2 and h4 digests have review entries
    expect(ev.misfires).toBe(1); // q2 only — the git-status entry never leaks in
    expect(ev.confirmed.judged).toBe(4);
    expect(ev.confirmed.diverge).toBe(1);
    // without the review file everything counts and nothing is waived
    const bare = backtestEvidence(rows, makeBatch(rows.map((r) => r.turn)), IDENT);
    expect(bare).toMatchObject({ reasked: 1, corrected: 1, waived: 0, misfires: 0, reviewed: 0 });
  });
});

describe("cross-session repeats", () => {
  it("derives from countCrossSessionRepeats over the batch's high rows", () => {
    const d = "shared";
    const t1 = makeTurn({
      session: "s1",
      entryId: "a1",
      text: HIT_Q,
      digest: d,
      at: T0,
      settledAt: T0 + 1,
      split: "holdout",
    });
    const t2 = makeTurn({
      session: "s2",
      entryId: "a2",
      text: HIT_Q,
      digest: d,
      at: T0 + 60_000,
      settledAt: T0 + 60_001,
      split: "holdout",
    });
    const rows = replay([t1, t2], [], { builtin: BUILTIN_SCRIPTS }, ALL_CAPS);
    const ev = backtestEvidence(rows, makeBatch([t1, t2]), IDENT);
    expect(ev.crossSessionRepeats).toBe(1);
    // out-of-batch repeats do not count
    const ev2 = backtestEvidence(rows, makeBatch([t1]), IDENT);
    expect(ev2.crossSessionRepeats).toBe(0);
  });
});

describe("the dilution counter-example (K11)", () => {
  it("3/50 confirmed diverge stays 6% — 50 lenient no-tool rows never soften it", () => {
    const confirmedRows = Array.from({ length: 50 }, (_, i) =>
      highRow({
        session: "s",
        entryId: `c${i}`,
        digest: `c${i}`,
        split: "holdout",
        shapes: i < 3 ? ["read"] : [], // 3 diverge, 47 no-tool
      }),
    );
    const lenientRows = Array.from({ length: 50 }, (_, i) =>
      highRow({
        session: "s",
        entryId: `l${i}`,
        digest: `l${i}`,
        split: "holdout",
        unknownFacts: ["sourceMode"],
      }),
    );
    const ev = backtestEvidence(
      [...confirmedRows, ...lenientRows],
      makeBatch([...confirmedRows, ...lenientRows].map((r) => r.turn)),
      IDENT,
    );
    expect(ev.confirmed.judged).toBe(50);
    expect(ev.confirmed.diverge).toBe(3);
    expect(ev.confirmed.diverge / ev.confirmed.judged).toBeCloseTo(0.06); // > 5% ⇒ still not eligible
    expect(ev.lenient.judged).toBe(50); // single separate ledger
    expect(ev.lenient.diverge).toBe(0);
  });
});
