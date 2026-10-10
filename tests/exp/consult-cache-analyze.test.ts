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
  dedupeRuns,
  gapBucket,
  hitRatioOf,
  parseSessionText,
  predictedSummary,
  preflightReason,
  preflightState,
  probeCostUsd,
  reconstructGaps,
  renderReport,
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
