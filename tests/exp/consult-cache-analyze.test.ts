import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GO_ADDRESSABLE_MIN_SHARE,
  GO_C2_EFFECTIVE_MIN_HIT,
  GO_NET_MIN_SHARE,
  GO_NET_MIN_WEEKLY_USD,
  GO_RENEWABLE_MIN_SHARE,
  analyzeConsultCache,
  cacheResultOf,
  dedupeRuns,
  extractConsultCacheEvents,
  gapBucket,
  hitRatioOf,
  mergeConsultCacheEvents,
  parseSessionText,
  predictedSummary,
  predictionOf,
  preflightReason,
  preflightState,
  probeCostUsd,
  reconstructGaps,
  renderReport,
  threadOf,
} from "../../scripts/exp/consult-cache-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(HERE, "..", "..", "tests", "fixtures", "consult-cache");
const ANALYZE_CLI = join(HERE, "..", "..", "scripts", "exp", "consult-cache-analyze.mjs");

/** Parse + dedupe a single fixture file (path-sorted snapshots in line order). */
function loadFile(name: string) {
  const path = join(FIXTURES, name);
  const { snapshots, malformed } = parseSessionText(readFileSync(path, "utf8"));
  return {
    chosen: dedupeRuns([{ path, snapshots }]),
    scan: { files: 1, runEntries: snapshots.length, malformedEntries: malformed },
  };
}

/** Mirrors the CLI walk across all fixture files (path-sorted). */
function loadAllFixtures() {
  const names = readdirSync(FIXTURES)
    .filter((n) => n.endsWith(".jsonl"))
    .sort();
  const files = [] as Array<{ path: string; snapshots: unknown[] }>;
  let runEntries = 0;
  let malformedEntries = 0;
  for (const name of names) {
    const path = join(FIXTURES, name);
    const { snapshots, malformed } = parseSessionText(readFileSync(path, "utf8"));
    runEntries += snapshots.length;
    malformedEntries += malformed;
    files.push({ path, snapshots });
  }
  return { chosen: dedupeRuns(files), scan: { files: files.length, runEntries, malformedEntries } };
}

type Analysis = Record<string, any>;

function analyzeProbes(): Analysis {
  const { chosen, scan } = loadFile("probes.jsonl");
  return analyzeConsultCache(chosen, { scan }) as Analysis;
}

function analyzeRetro(): Analysis {
  const { chosen, scan } = loadFile("retro.jsonl");
  return analyzeConsultCache(chosen, { retro: true, scan }) as Analysis;
}

const runCli = (args: string[]) => execFileSync("node", [ANALYZE_CLI, ...args], { encoding: "utf8", timeout: 60_000 });

/* ------------------------------------------------------------- unit rules --- */

describe("consult-cache-analyze: probe field helpers", () => {
  it("computes hitRatio from the recorded field or requests[0]/prefix (clamped)", () => {
    expect(hitRatioOf({ hitRatio: 0.9 })).toBe(0.9);
    expect(hitRatioOf({ hitRatio: 1.7 })).toBe(1); // clamped
    expect(hitRatioOf({ requests: [{ cacheRead: 2000 }], expertPrefixTokens: 10000 })).toBe(0.2);
    expect(hitRatioOf({ requests: [{ cacheRead: 2000 }] })).toBeNull(); // no prefix
    expect(hitRatioOf({})).toBeNull();
  });

  it("classifies preflight pass/fail and extracts the reason code", () => {
    expect(preflightState({ identity: { preflight: "pass" } })).toBe("pass");
    expect(preflightState({ identity: { preflight: "fail:tool-definition:read,write" } })).toBe("fail");
    expect(preflightState({ identity: {} })).toBe("fail");
    expect(preflightReason({ identity: { preflight: "fail:tool-definition:read,write" } })).toBe(
      "tool-definition:read,write",
    );
    expect(preflightReason({ identity: { preflight: "pass" } })).toBeNull();
  });

  it("summarizes predicted record-only fields", () => {
    expect(predictedSummary({ identity: { predicted: { system: true, model: true } } })).toEqual({
      state: "match",
      mismatches: [],
    });
    expect(predictedSummary({ identity: { predicted: { system: false, model: true } } })).toEqual({
      state: "mismatch",
      mismatches: ["system"],
    });
    expect(predictedSummary({ identity: {} })).toEqual({ state: "n/a", mismatches: [] });
  });

  it("buckets gaps at the 4.25/15/45m boundaries", () => {
    expect(gapBucket(120_000)).toBe("within425");
    expect(gapBucket(4.25 * 60 * 1000)).toBe("_425_15"); // inclusive upper edge
    expect(gapBucket(45 * 60 * 1000)).toBe("_15_45");
    expect(gapBucket(45 * 60 * 1000 + 1)).toBe("over45");
    expect(gapBucket(undefined)).toBe("unknown");
  });

  it("sums per-request cost (excludes keepalivePingUsd)", () => {
    expect(probeCostUsd({ requests: [{ costUsd: 0.05 }, { costUsd: 0.07 }], keepalivePingUsd: 0.001 })).toBeCloseTo(
      0.12,
      9,
    );
    expect(probeCostUsd({})).toBe(0);
  });
});

/* -------------------------------------------------------------- probe mode --- */

describe("consult-cache-analyze: probe mode over probes.jsonl", () => {
  const analysis = analyzeProbes();

  it("counts runs / probes / malformed probes", () => {
    expect(analysis.mode).toBe("probe");
    expect(analysis.totals).toEqual({
      runs: 4,
      runsWithProbes: 3,
      probes: 5,
      probesMalformed: 2,
      consultCalls: 0,
    });
    expect(analysis.scan.uniqueRuns).toBe(4);
  });

  it("groups outcomes and identity_mismatch by reason code", () => {
    expect(analysis.outcomes.byOutcome).toEqual({
      completed: 3,
      identity_mismatch: 1,
      blocked_cap: 1,
    });
    expect(analysis.outcomes.identityMismatchByReason).toEqual({ "tool-definition:read,write": 1 });
  });

  it("stratifies hitRatio by api × preflight × predicted", () => {
    const groups = analysis.hitRatio.groups as Array<Record<string, any>>;
    expect(groups.map((g) => [g.api, g.preflight, g.predicted, g.n, g.median])).toEqual([
      ["anthropic-messages", "fail", "n/a", 0, null],
      ["anthropic-messages", "pass", "match", 1, 0.9],
      ["anthropic-messages", "pass", "mismatch", 1, 0.2],
      ["anthropic-messages", "pass", "n/a", 1, 0.55],
      ["openai-responses", "pass", "match", 1, 0.7],
    ]);
  });

  it("lists preflight-passed but hitRatio<0.5 cases", () => {
    expect(analysis.hitRatio.misses).toEqual([
      {
        runId: "r_c2",
        expertRunId: "r_x1",
        api: "anthropic-messages",
        predicted: { state: "mismatch", mismatches: ["system"] },
        hitRatio: 0.2,
        gapSettleMs: 300000,
        prefixSource: "snapshot-usage",
      },
    ]);
  });

  it("flattens per-request cacheRead/cacheWrite", () => {
    const requests = analysis.requests as Array<Record<string, any>>;
    expect(requests).toHaveLength(5);
    expect(requests.map((r) => [r.runId, r.index, r.cacheRead, r.cacheWrite, r.costUsd, r.toolsDrift ?? null])).toEqual(
      [
        ["r_c1", 0, 9000, 0, 0.05, null],
        ["r_c2", 0, 2000, 8000, 0.08, null],
        ["r_c2", 0, 3500, 0, 0.02, null],
        ["r_c3", 0, 5500, 0, 0.06, true],
        ["r_c3", 1, 0, 6000, 0.07, null],
      ],
    );
  });

  it("splits cost cold/warm and keeps keepalive ping separate", () => {
    expect(analysis.cost.cold).toEqual({ n: 1, costUsd: 0.08 });
    expect(analysis.cost.warm).toEqual({ n: 3, costUsd: 0.2 });
    expect(analysis.cost.totalConsultCostUsd).toBeCloseTo(0.28, 9);
    expect(analysis.cost.keepalivePingUsd).toBeCloseTo(0.001, 9);
  });

  it("aggregates blocked counters and costAfterUsd", () => {
    expect(analysis.blocked).toEqual({
      calls: 3,
      batches: 2,
      terminated: 1,
      identity: 1,
      nested: 1,
      costAfterUsd: 0.04,
      disallowedInvalidCalls: 1,
      unknownToolCalls: 2,
    });
  });

  it("buckets gapSettleMs", () => {
    expect(analysis.gaps.buckets).toEqual({ within425: 3, _425_15: 1, _15_45: 1, over45: 0, unknown: 0 });
  });

  it("reports §11 keepalive go/no-go conditions", () => {
    const ka = analysis.keepalive;
    expect(ka.c2Effective.n).toBe(2);
    expect(ka.c2Effective.hitRatioMedian).toBeCloseTo(0.725, 9);
    expect(ka.c2Effective.pass).toBe(true);
    expect(ka.renewable).toEqual({ n: 5, nWithin425: 3, share: 0.6, pass: true });
    expect(ka.addressable).toEqual({ n: 4, nAddressable: 2, share: 0.5, pass: true });
    expect(ka.economics).toMatchObject({
      totalConsultCostUsd: 0.28,
      coldCostUsd: 0.08,
      warmCostUsd: 0.2,
      potentialColdSavingsUsd: 0.08,
    });
    expect(ka.eligibility).toMatchObject({ minWeeks: 4, minAnthropicConsults: 30, anthropicConsultCount: 4 });
  });

  it("exports the §11 gate thresholds for shared reference", () => {
    expect(GO_C2_EFFECTIVE_MIN_HIT).toBe(0.6);
    expect(GO_RENEWABLE_MIN_SHARE).toBe(0.5);
    expect(GO_ADDRESSABLE_MIN_SHARE).toBe(0.3);
    expect(GO_NET_MIN_SHARE).toBe(0.2);
    expect(GO_NET_MIN_WEEKLY_USD).toBe(2);
  });
});

/* -------------------------------------------------------------- retro mode --- */

describe("consult-cache-analyze: retro mode over retro.jsonl", () => {
  it("reconstructs expert-settle -> consumer-dispatch gaps", () => {
    const { chosen } = loadFile("retro.jsonl");
    const gaps = reconstructGaps(chosen)
      .map((g) => g.gapSettleMs)
      .sort((a, b) => a - b);
    expect(gaps).toEqual([110000, 310000, 610000, 1500000]);
  });

  it("reports retro outcomes, gaps and cost without cacheProbes", () => {
    const analysis = analyzeRetro();
    expect(analysis.mode).toBe("retro");
    expect(analysis.totals).toEqual({ runs: 8, runsWithProbes: 0, probes: 0, probesMalformed: 0, consultCalls: 4 });
    expect(analysis.outcomes.byOutcome).toEqual({ completed: 3, failed: 1 });
    expect(analysis.gaps.buckets).toEqual({ within425: 1, _425_15: 2, _15_45: 1, over45: 0, unknown: 0 });
    expect(analysis.cost.cold).toBeNull();
    expect(analysis.cost.warm).toBeNull();
    expect(analysis.cost.totalConsultCostUsd).toBeCloseTo(0.35, 9);
    expect(analysis.cost.keepalivePingUsd).toBe(0);
    expect(analysis.blocked).toEqual({
      calls: 0,
      batches: 0,
      terminated: 0,
      identity: 0,
      nested: 0,
      costAfterUsd: 0,
      disallowedInvalidCalls: 0,
      unknownToolCalls: 0,
    });
  });

  it("reports retro keepalive conditions (c2Effective null, addressable as upper bound)", () => {
    const ka = analyzeRetro().keepalive;
    expect(ka.c2Effective).toBeNull();
    expect(ka.renewable).toEqual({ n: 4, nWithin425: 1, share: 0.25, pass: false });
    expect(ka.addressable).toMatchObject({ n: 4, nAddressable: 3, share: 0.75, pass: true });
    expect(ka.addressable.note).toContain("upper bound");
    expect(ka.economics.totalConsultCostUsd).toBeCloseTo(0.35, 9);
  });
});

/* ----------------------------------------------- cacheResult v1 + threads ---- */

describe("consult-cache-analyze: cacheResult v1 / prediction / threads / follow-gaps", () => {
  const { chosen, scan } = loadFile("cache-result.jsonl");

  const analyze = () => analyzeConsultCache(chosen, { scan }) as Analysis;
  const analyzeFg = () => analyzeConsultCache(chosen, { scan, followGaps: true }) as Analysis;

  it("normalizes v1 cacheResult and rejects unknown versions", () => {
    expect(cacheResultOf({ v: 1, readShare: 0.96, label: "hit", anchor: "added" })).toEqual({
      v: 1,
      readShare: 0.96,
      label: "hit",
      anchor: "added",
    });
    expect(cacheResultOf({ v: 1, readShare: null, label: "n/a", anchor: "n/a" })).toEqual({
      v: 1,
      readShare: null,
      label: "n/a",
      anchor: "n/a",
    });
    expect(cacheResultOf({ v: 2, readShare: 0.9, label: "hit", anchor: "added" })).toBeNull();
    expect(cacheResultOf(undefined)).toBeNull();
  });

  it("normalizes predictions and thread refs (probe {id,seq} vs run {threadId,seq})", () => {
    expect(predictionOf({ state: "warm", reason: "proven-touch" })).toEqual({ state: "warm", reason: "proven-touch" });
    expect(predictionOf({ state: "bogus" })).toBeNull();
    expect(threadOf({ id: "th1", seq: 2 })).toEqual({ id: "th1", seq: 2 });
    expect(threadOf({ threadId: "th1", seq: 2 })).toEqual({ id: "th1", seq: 2 });
    expect(threadOf({ id: "th1" })).toBeNull();
    expect(threadOf({ id: "th1", seq: 0 })).toBeNull();
  });

  it("reads v1 cacheResult from both sources, dedupes by thread id+seq, and skips unknown versions", () => {
    const a = analyze();
    expect(a.cacheResult.byLabel).toEqual({ hit: 3, partial: 1, miss: 3, "n/a": 1 });
    expect(a.cacheResult.bySource).toEqual({ probe: 2, run: 6 });
    expect(a.cacheResult.unknownVersion).toBe(1);
    expect(a.cacheResult.readShare.n).toBe(7);
    expect(a.cacheResult.readShare.median).toBeCloseTo(0.5, 9);
    expect(a.cacheResult.readShare.p90).toBeCloseTo(0.924, 9);
    expect(a.cacheResult.readShare.min).toBeCloseTo(0.05, 9);
    expect(a.cacheResult.readShare.max).toBeCloseTo(0.96, 9);
  });

  it("builds the prediction accuracy matrix (predicted × actual)", () => {
    const p = analyze().prediction;
    expect(p.byPredicted.warm).toEqual({ n: 2, byLabel: { hit: 1, partial: 1, miss: 0, "n/a": 0 } });
    expect(p.byPredicted.cold).toEqual({ n: 3, byLabel: { hit: 1, partial: 0, miss: 2, "n/a": 0 } });
    expect(p.byPredicted.unknown).toEqual({ n: 3, byLabel: { hit: 1, partial: 0, miss: 1, "n/a": 1 } });
    expect(p.predictedWithoutResult).toEqual({ warm: 1, cold: 1, unknown: 0 });
  });

  it("groups threads: seq 1 vs follow-ups and per-seq cost/readShare", () => {
    const t = analyze().threads;
    expect(t.n).toBe(8);
    expect(t.threadCount).toBe(5);
    expect(t.seq1.n).toBe(5);
    expect(t.seq1.costUsd).toBeCloseTo(0.16, 9);
    expect(t.seq1.readShare).toEqual({ n: 3, median: 0.9 });
    expect(t.followUp.n).toBe(3);
    expect(t.followUp.costUsd).toBeCloseTo(0.13, 9);
    expect(t.followUp.readShare.n).toBe(2);
    expect(t.followUp.readShare.median).toBeCloseTo(0.3, 9);
    expect(t.bySeq.map((s) => [s.seq, s.n])).toEqual([
      [1, 5],
      [2, 2],
      [3, 1],
    ]);
    expect(t.bySeq[0].costUsd).toBeCloseTo(0.16, 9);
    expect(t.bySeq[1].costUsd).toBeCloseTo(0.05, 9);
    expect(t.bySeq[2].costUsd).toBeCloseTo(0.08, 9);
    expect(t.bySeq[0].readShare).toEqual({ n: 3, median: 0.9 });
    expect(t.bySeq[1].readShare).toEqual({ n: 1, median: 0.5 });
    expect(t.bySeq[2].readShare).toEqual({ n: 1, median: 0.1 });
    expect(t.byThread.map((b) => [b.id, b.n, b.seqMax])).toEqual([
      ["th1", 3, 3],
      ["th2", 2, 2],
      ["th3", 1, 1],
      ["th4", 1, 1],
      ["thX", 1, 1],
    ]);
    expect(t.byThread.map((b) => b.costUsd)).toEqual([0.16, 0.08, 0.01, 0.02, 0.02]);
  });

  it("followGaps is null by default and computed under --follow-gaps", () => {
    expect(analyze().followGaps).toBeNull();
    const fg = analyzeFg().followGaps;
    expect(fg.n).toBe(3);
    expect(fg.byBucket.within425).toEqual({ n: 1, byLabel: { hit: 0, partial: 1, miss: 0, "n/a": 0 } });
    expect(fg.byBucket._425_15).toEqual({ n: 1, byLabel: { hit: 0, partial: 0, miss: 0, "n/a": 1 } });
    expect(fg.byBucket._15_45).toEqual({ n: 1, byLabel: { hit: 0, partial: 0, miss: 1, "n/a": 0 } });
    expect(fg.byBucket.over45).toEqual({ n: 0, byLabel: { hit: 0, partial: 0, miss: 0, "n/a": 0 } });
    expect(fg.samples).toEqual([
      { threadId: "th1", seq: 2, gapMs: 180000, label: "partial", source: "run" },
      { threadId: "th1", seq: 3, gapMs: 1020000, label: "miss", source: "run" },
      { threadId: "th2", seq: 2, gapMs: 600000, label: "n/a", source: "run" },
    ]);
  });
});

/* ------------------------------------------------------------------ CLI ---- */

describe("consult-cache-analyze.mjs CLI", () => {
  it("--json output equals the in-lib analysis byte-for-byte (determinism)", () => {
    const { chosen, scan } = loadAllFixtures();
    const combined = analyzeConsultCache(chosen, { scan });
    const stdout = runCli(["--dir", FIXTURES, "--json"]);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout)).toEqual(combined);
  });

  it("--retro --json equals the in-lib retro analysis over all files", () => {
    const { chosen, scan } = loadAllFixtures();
    const combined = analyzeConsultCache(chosen, { retro: true, scan });
    const stdout = runCli(["--dir", FIXTURES, "--retro", "--json"]);
    expect(JSON.parse(stdout)).toEqual(combined);
  });

  it("renders the human report with outcomes, buckets and keepalive lines", () => {
    const out = runCli(["--dir", FIXTURES]);
    expect(out).toContain("consult cache analysis (probe)");
    expect(out).toContain("identity_mismatch by reason code:");
    expect(out).toContain("tool-definition:read,write");
    expect(out).toContain("hitRatio by api × preflight × predicted");
    expect(out).toContain("preflight-passed but hitRatio < 0.5");
    expect(out).toContain("interval buckets:");
    expect(out).toContain("<4.25m: 3");
    expect(out).toContain("keepalive go/no-go (§11):");
    expect(out).toContain("C2 effective:");
    expect(out).toContain("renewable:");
    expect(out).toContain("addressable:");
  });

  it("renders the retro human report and flags c2Effective n/a", () => {
    const out = runCli(["--dir", FIXTURES, "--retro"]);
    expect(out).toContain("consult cache analysis (retro)");
    expect(out).toContain("consult calls (retro reconstruction)");
    expect(out).toContain("n/a (requires cacheProbes; not available in retro mode)");
  });

  it("--follow-gaps --json equals the in-lib follow-gaps analysis over all files", () => {
    const { chosen, scan } = loadAllFixtures();
    const combined = analyzeConsultCache(chosen, { scan, followGaps: true });
    const stdout = runCli(["--dir", FIXTURES, "--follow-gaps", "--json"]);
    expect(JSON.parse(stdout)).toEqual(combined);
  });

  it("renders the new sections in the human report, gated on --follow-gaps", () => {
    const withFlag = runCli(["--dir", FIXTURES, "--follow-gaps"]);
    expect(withFlag).toContain("cacheResult v1:");
    expect(withFlag).toContain("prediction accuracy (predicted × actual):");
    expect(withFlag).toContain("threads:");
    expect(withFlag).toContain("follow-gaps (consecutive consult gap vs cache outcome):");
    const withoutFlag = runCli(["--dir", FIXTURES]);
    expect(withoutFlag).toContain("cacheResult v1:");
    expect(withoutFlag).toContain("prediction accuracy (predicted × actual):");
    expect(withoutFlag).not.toContain("follow-gaps");
  });

  it("supports --since and rejects bad arguments", () => {
    const out = runCli(["--dir", FIXTURES, "--since", "2026-10-02", "--json"]);
    const parsed = JSON.parse(out) as Analysis;
    expect(parsed.scan.outOfWindow).toBe(4); // the 4 probe-file runs are created 2026-10-01
    expect(() => runCli(["--dir", FIXTURES, "--since", "Oct-1"])).toThrow();
    expect(() => runCli(["--dir", "/nonexistent-consult-cache-dir"])).toThrow();
    expect(() => runCli(["--dir", FIXTURES, "--bogus"])).toThrow();
  });

  it("reports the rendered report deterministically via renderReport", () => {
    const analysis = analyzeProbes();
    const text = renderReport(analysis);
    expect(text).toBe(renderReport(analysis));
    expect(text).toContain("blocked calls 3");
  });
});
