import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WORK_TYPES,
  armFor,
  analyzeRuns,
  dedupeRuns,
  parseSessionText,
  roleOf,
} from "../../scripts/exp/consult-ab-lib.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(HERE, "..", "..", "tests", "fixtures", "consult-ab");
const ANALYZE_CLI = join(HERE, "..", "..", "scripts", "exp", "consult-ab-analyze.mjs");

/** Mirrors the CLI's walk (fixtures are flat): path-sorted *.jsonl, line-order snapshots. */
function loadFixtures(): { files: Array<{ path: string; snapshots: unknown[] }>; scan: Record<string, number> } {
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
  return { files, scan: { files: files.length, runEntries, malformedEntries } };
}

type Analysis = ReturnType<typeof analyzeFixture>;

function analyzeFixture(opts: Record<string, unknown> = {}) {
  const { files, scan } = loadFixtures();
  return analyzeRuns(dedupeRuns(files), { scan, ...opts }) as Record<string, any>;
}

const pkg = (analysis: Analysis, packageId: string) =>
  (analysis.packages as Array<Record<string, any>>).find((p) => p.packageId === packageId);

const exclusion = (analysis: Analysis, packageId: string) =>
  (analysis.excluded as Array<Record<string, any>>).find((e) => e.packageId === packageId);

const runCli = (args: string[]) => execFileSync("node", [ANALYZE_CLI, ...args], { encoding: "utf8", timeout: 60_000 });

/* ------------------------------------------------------------- dedupe ---- */

describe("consult-ab-analyze: runId dedup (P3 step 1)", () => {
  const { files } = loadFixtures();
  const chosen = dedupeRuns(files);

  it("globally dedupes by runId", () => {
    expect(chosen.size).toBe(40);
  });

  it("prefers the terminal entry when a journal entry also exists", () => {
    const r_e2 = chosen.get("r_e2")!;
    expect((r_e2.snapshot as any).status).toBe("completed");
    expect((r_e2.snapshot as any).diag.settledAt).toBeDefined();
    expect((r_e2.snapshot as any).journal).toBeUndefined();
  });

  it("keeps the journal snapshot for a run with no terminal entry", () => {
    const r_pd1 = chosen.get("r_pd1")!;
    expect((r_pd1.snapshot as any).status).toBe("queued");
    expect((r_pd1.snapshot as any).journal).toEqual({ kind: "shutdown_flush", shutdownReason: "reload" });
  });

  it("picks max updatedAt across files (same runId in two files)", () => {
    const r_e3 = chosen.get("r_e3")!;
    expect((r_e3.snapshot as any).diag.usage.costUsd).toBe(0.13); // more-file copy (newer), not 0.11
    expect(r_e3.path.endsWith("2026-10-03-more.jsonl")).toBe(true);
    expect(chosen.get("r_old_dup")!.path.endsWith("2026-10-03-more.jsonl")).toBe(true);
  });

  it("breaks updatedAt ties in favor of the LATER-scanned entry (seed `>=` semantics)", () => {
    // r_tv1: two terminal entries with EQUAL updatedAt; the post-policy one (with
    // structuredResult) is written after the first terminal entry in the same file.
    const r_tv1 = chosen.get("r_tv1")!;
    expect((r_tv1.snapshot as any).outcome.structuredResult.verdict).toBe("conditional_pass");
  });

  it("prefers the newer post-policy entry when updatedAt differs", () => {
    const r_v1 = chosen.get("r_v1")!;
    expect((r_v1.snapshot as any).updatedAt).toBe(1790841609800);
    expect((r_v1.snapshot as any).outcome.structuredResult.verdict).toBe("pass");
  });

  it("counts malformed subagent:run entries but keeps parsing old entries", () => {
    const { scan } = loadFixtures();
    expect(scan.malformedEntries).toBe(1);
    expect(scan.runEntries).toBe(45);
    // old entries parse fine — they just have no packageId
    const r_old_1 = chosen.get("r_old_1")!;
    expect((r_old_1.snapshot as any).diag.dispatchMeta).toBeUndefined();
  });
});

/* ------------------------------------------------------------ analysis ---- */

describe("consult-ab-analyze: fixtures analysis (no salt)", () => {
  const analysis = analyzeFixture();

  it("counts runs / packages / exclusions", () => {
    expect(analysis.totals).toEqual({
      runs: 40,
      enrolledRuns: 34,
      unenrolledRuns: 6, // r_old_1, r_old_2, r_old_dup, r_cons_1, r_p1r, r_cfgfail
      packages: 16,
      excludedPackages: 5,
      analyzedPackages: 11,
    });
    expect(analysis.scan).toMatchObject({ files: 3, runEntries: 45, malformedEntries: 1, uniqueRuns: 40 });
  });

  it("aggregates the experts arm (n, first-pass + Wilson 95%, rework, cost, wall, consult)", () => {
    const e = analysis.arms.experts;
    expect(e.n).toBe(6);
    expect(e.nVerdict).toBe(5);
    expect(e.firstPass).toMatchObject({ k: 3, n: 5, rate: 0.6 });
    expect(e.firstPass.ci95.lo).toBeCloseTo(0.2307242812760128, 9);
    expect(e.firstPass.ci95.hi).toBeCloseTo(0.882379225767352, 9);
    expect(e.firstPassOrCond).toMatchObject({ k: 3, n: 5 });
    expect(e.rework).toEqual({ n: 4, mean: 0.25, median: 0, censored: 2 });
    expect(e.cost.n).toBe(6);
    expect(e.cost.median).toBeCloseTo(0.33, 9);
    expect(e.cost.p90).toBeCloseTo(0.535, 9);
    expect(e.cost.total).toBeCloseTo(1.96, 9);
    expect(e.wallMs).toEqual({ n: 5, median: 8000, p90: 15600, nullCount: 1 });
    expect(e.consult).toEqual({ calls: 6, costUsd: 0.27, failed: 1 });
    expect(e.consultUsed).toEqual({ packages: 3, of: 6, fraction: 0.5 });
  });

  it("aggregates the control arm", () => {
    const c = analysis.arms.control;
    expect(c.n).toBe(5);
    expect(c.nVerdict).toBe(5);
    expect(c.firstPass).toMatchObject({ k: 2, n: 5, rate: 0.4 });
    expect(c.firstPass.ci95.lo).toBeCloseTo(0.11762077423264783, 9);
    expect(c.firstPass.ci95.hi).toBeCloseTo(0.769275718723987, 9);
    expect(c.firstPassOrCond).toMatchObject({ k: 4, n: 5 });
    expect(c.rework).toEqual({ n: 4, mean: 0, median: 0, censored: 1 });
    expect(c.cost.n).toBe(5);
    expect(c.cost.median).toBeCloseTo(0.29, 9);
    expect(c.cost.p90).toBeCloseTo(0.372, 9);
    expect(c.cost.total).toBeCloseTo(1.55, 9);
    expect(c.wallMs).toEqual({ n: 5, median: 8000, p90: 10400, nullCount: 0 });
    expect(c.consult).toEqual({ calls: 0, costUsd: 0, failed: 0 });
  });

  it("compares arms with a two-proportion z-test", () => {
    expect(analysis.comparison.firstPass.diff).toBeCloseTo(0.2, 12);
    expect(analysis.comparison.firstPass.z).toBeCloseTo(0.6324555320336757, 3);
    expect(analysis.comparison.firstPass.p).toBeCloseTo(0.5270892568655383, 3);
    expect(analysis.comparison.firstPassOrCond.diff).toBeCloseTo(-0.2, 12);
    expect(analysis.comparison.firstPassOrCond.z).toBeCloseTo(-0.6900655593423544, 3);
    expect(analysis.comparison.firstPassOrCond.p).toBeCloseTo(0.4901529604158248, 3);
  });

  it("stratifies by lane inside each arm", () => {
    const byLane = analysis.arms.experts.byLane as Array<Record<string, any>>;
    expect(byLane.map((l) => [l.lane, l.n, l.nVerdict, l.firstPassK])).toEqual([
      ["L2", 5, 4, 3],
      ["L3", 1, 1, 0],
    ]);
    expect(byLane[0]!.costMedian).toBeCloseTo(0.25, 9);
    expect(byLane[1]!.costMedian).toBeCloseTo(0.41, 9);
    expect(analysis.arms.control.byLane.map((l: any) => [l.lane, l.n, l.firstPassK])).toEqual([
      ["L1", 1, 1],
      ["L2", 4, 1],
    ]);
  });

  it("lists every exclusion with its reason and runIds", () => {
    expect((analysis.excluded as Array<Record<string, any>>).map((e) => [e.packageId, e.reasons])).toEqual([
      ["ctl-viol-01", ["control-has-experts"]],
      ["exp-mixed-01", ["mixed-arm"]],
      ["exp-part-01", ["partial-unenrolled"]],
      ["exp-viol-01", ["no-granted-experts"]],
      ["exp-vv-01", ["verifier-has-experts"]],
    ]);
    expect(exclusion(analysis, "ctl-viol-01").runIds).toEqual(["r_g2"]);
    expect(exclusion(analysis, "exp-mixed-01").runIds).toEqual(["r_m1", "r_m2"]);
    expect(exclusion(analysis, "exp-part-01").runIds).toEqual(["r_p1r"]); // the missing-meta run, not the package's own runs
    expect(exclusion(analysis, "exp-viol-01").runIds).toEqual(["r_g1"]);
    expect(exclusion(analysis, "exp-vv-01").runIds).toEqual(["r_gv2"]);
    expect(exclusion(analysis, "exp-mixed-01").detail).toContain("both arms");
  });

  it("does NOT flag an experts-arm package whose verifier carries no experts", () => {
    for (const id of ["exp-pkg-01", "exp-pkg-03", "ab-e-03"]) {
      expect(exclusion(analysis, id), id).toBeUndefined();
      const p = pkg(analysis, id)!;
      expect(p.verdicts.length, id).toBeGreaterThan(0); // verdict still counted
    }
  });

  it("warns on absorbed-cap-hit (never excludes) and verdictInconsistent", () => {
    const kinds = new Map(
      (analysis.warnings as Array<Record<string, any>>).map((w) => [`${w.packageId}:${w.kind}`, w]),
    );
    expect(kinds.get("exp-cap-01:absorbed-cap-hit").runIds).toEqual(["r_cap1"]);
    expect(kinds.get("exp-cap-01:verdictInconsistent").runIds).toEqual(["r_vcap"]);
    expect(exclusion(analysis, "exp-cap-01")).toBeUndefined(); // warning, not exclusion
    expect(pkg(analysis, "exp-cap-01").verdicts[0]).toMatchObject({
      verdict: "reject",
      blockers: 2,
      blockerFindings: 1,
      consistent: false,
    });
  });

  it("computes per-package metrics (cost excludes absorbed consult run; wall excludes no-settledAt runs)", () => {
    const p1 = pkg(analysis, "exp-pkg-01")!;
    expect(p1.costUsd).toBe(0.42); // 0.30 + 0.12 — the absorbed r_cons_1 ($0.20) is NOT added
    expect(p1.wallMs).toBe(8000); // max settledAt 9000 − min createdAt 1000
    expect(p1.consult).toEqual({ calls: 2, costUsd: 0.1, failed: 0 });
    expect(p1.firstPass).toBe(true);
    expect(p1.lane).toBe("L2");

    const e03 = pkg(analysis, "ab-e-03")!;
    expect(e03.reworkRounds).toBe(1); // reject → rework resume → pass
    expect(e03.firstPass).toBe(false);
    expect(e03.verdicts.map((v: any) => v.verdict)).toEqual(["reject", "pass"]); // sorted by createdAt
    expect(e03.costUsd).toBe(0.65);

    expect(pkg(analysis, "exp-pkg-03").costUsd).toBe(0.23); // 0.13 (more-file copy won) + 0.10

    const pend = pkg(analysis, "exp-pend-01")!;
    expect(pend.wallMs).toBeNull(); // journal-only run: no settledAt anywhere ⇒ null
    expect(pend.firstPass).toBeNull();
    expect(pend.censored).toBe(true);
    expect(pend.costUsd).toBe(0);
  });

  it("keeps the config-failure entry out of package metrics (it has no meta/sessionFile/settledAt)", () => {
    const cfg = pkg(analysis, "ctl-cfg-01")!;
    // config entry createdAt (T0+90000) is EARLIER than the package runs (T0+150000):
    // had it leaked into the package, wallMs would be 68000.
    expect(cfg.wallMs).toBe(8000);
    expect(cfg.costUsd).toBeCloseTo(0.29, 9);
    expect(cfg.runIds).toEqual(["r_cf1", "r_cfv"]);
    expect(exclusion(analysis, "ctl-cfg-01")).toBeUndefined(); // cannot be linked ⇒ no partial-unenrolled
  });

  it("marks the never-passed package as censored", () => {
    const np = pkg(analysis, "ab-c-02")!;
    expect(np.verdicts.map((v: any) => v.verdict)).toEqual(["reject", "reject"]);
    expect(np.firstPass).toBe(false);
    expect(np.reworkRounds).toBeNull();
    expect(np.censored).toBe(true);
  });

  it("emits the coverage hint by main session file (hint only)", () => {
    const coverage = analysis.coverage as Array<Record<string, any>>;
    expect(coverage.map((c) => [c.file.split("/").pop(), c.workRunsWithoutMeta, c.workRuns])).toEqual([
      ["2026-09-20-old.jsonl", 1, 0], // r_old_1 (r_old_dup's chosen copy lives in the more file)
      ["2026-10-01-main.jsonl", 1, 16], // r_p1r
      ["2026-10-03-more.jsonl", 1, 1], // r_old_dup chosen copy
    ]);
  });

  it("prints a power hint while per-arm n < 150", () => {
    expect(analysis.powerHint).toContain("150");
    expect(analysis.powerHint).toContain("underpowered");
  });

  it("is deterministic (stable JSON)", () => {
    expect(JSON.stringify(analysis)).toBe(JSON.stringify(analyzeFixture()));
  });
});

/* ------------------------------------------------------- salt + window ---- */

describe("consult-ab-analyze: salt verification and time window", () => {
  it("excludes hash-mismatch packages when --salt is given, and nothing else changes arms", () => {
    const analysis = analyzeFixture({ salt: "consult-ab-v1" });
    expect(exclusion(analysis, "exp-hash-01").reasons).toEqual(["hash-mismatch"]);
    expect(exclusion(analysis, "exp-hash-01").detail).toContain("hash draws control");
    expect(analysis.totals.excludedPackages).toBe(6);
    expect(analysis.arms.experts.n).toBe(5); // exp-hash-01 (declared experts) dropped
    expect(analysis.arms.experts.nVerdict).toBe(4);
    expect(analysis.arms.experts.firstPass.k).toBe(2);
    expect(analysis.arms.control.n).toBe(5);
    expect(analysis.comparison.firstPass.p).toBeCloseTo(0.7641771556220949, 3);
  });

  it("checks every fixture package's declared arm against the hash rule", () => {
    const { files } = loadFixtures();
    const chosen = dedupeRuns(files);
    for (const { snapshot } of chosen.values()) {
      const meta = (snapshot as any).diag?.dispatchMeta;
      if (meta?.abArm === undefined) continue;
      if (meta.packageId === "exp-hash-01" || meta.packageId === "exp-mixed-01") continue; // deliberate fixtures
      expect(armFor(meta.packageId), meta.packageId).toBe(meta.abArm);
    }
  });

  it("filters runs by createdAt window (--since inclusive at UTC midnight)", () => {
    const analysis = analyzeFixture({ since: Date.parse("2026-10-01T00:00:00.000Z") });
    expect(analysis.scan.outOfWindow).toBe(3); // r_old_1, r_old_2, r_old_dup (created 2026-09-20)
    expect(analysis.totals.unenrolledRuns).toBe(3);
    // r_old_dup's chosen entry is out of window even though it lives in the more file,
    // so only the main file still has an unenrolled work run (r_p1r)
    expect(analysis.coverage.map((c: any) => c.file.split("/").pop())).toEqual(["2026-10-01-main.jsonl"]);
    // packages are unaffected — old runs never carried meta
    expect(analysis.totals.packages).toBe(16);
    expect(analysis.arms.experts.n).toBe(6);
  });
});

/* ---------------------------------------------------------- unit rules ---- */

describe("consult-ab-analyze: unit rules on synthetic runs", () => {
  const t0 = 1790841600000;
  const meta = (packageId: string, abArm: string) => ({ lane: "L2", packageId, abArm });

  function run(runId: string, over: Record<string, unknown> = {}) {
    return {
      runId,
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: {},
      updatedAt: t0 + 1000,
      diag: {
        createdAt: t0,
        settledAt: t0 + 1000,
        agentType: "general",
        escalation: [],
        degraded: [],
        unkillable: [],
        orphaned: false,
        generation: 1,
        pendingTools: 0,
        turns: 1,
        staleInputs: 0,
      },
      ...over,
    };
  }

  function analyze(snapshots: unknown[], opts: Record<string, unknown> = {}) {
    const files = [{ path: "synthetic.jsonl", snapshots }];
    return analyzeRuns(dedupeRuns(files), {
      scan: { files: 1, runEntries: snapshots.length, malformedEntries: 0 },
      ...opts,
    });
  }

  it("skips the cost of a run absorbed into another run's usage", () => {
    const analysis = analyze([
      run("r_absorbed", {
        diag: {
          agentType: "general",
          createdAt: t0,
          dispatchMeta: meta("pkg-a", "experts"),
          experts: { refs: [{ runId: "x", agentType: "Plan" }], granted: true },
          usage: { costUsd: 0.5 },
        },
      }),
      run("r_other", {
        diag: {
          agentType: "general",
          createdAt: t0,
          dispatchMeta: meta("pkg-b", "control"),
          usage: { costUsd: 0.1 },
          absorbedRunIds: ["r_absorbed"],
        },
      }),
    ]);
    expect(pkg(analysis, "pkg-a").costUsd).toBe(0);
    expect(pkg(analysis, "pkg-a").absorbedCostSkipped).toBe(1);
    expect(pkg(analysis, "pkg-b").costUsd).toBe(0.1);
    expect(exclusion(analysis, "pkg-a")).toBeUndefined(); // absorption is cost bookkeeping, not a protocol violation
  });

  it("warns verdict-missing when a completed verdict/v1 verifier has no structuredResult", () => {
    const analysis = analyze([
      run("r_dev", {
        diag: {
          agentType: "general",
          createdAt: t0,
          dispatchMeta: meta("pkg-c", "experts"),
          experts: { refs: [{ runId: "x", agentType: "Plan" }], granted: true },
        },
      }),
      run("r_ver", {
        diag: {
          agentType: "verifier",
          createdAt: t0 + 100,
          dispatchMeta: meta("pkg-c", "experts"),
          schemaPreset: "verdict/v1",
        },
      }),
    ]);
    expect(analysis.warnings).toHaveLength(1);
    expect(analysis.warnings[0]).toMatchObject({ packageId: "pkg-c", kind: "verdict-missing", runIds: ["r_ver"] });
    expect(pkg(analysis, "pkg-c").verdicts).toEqual([]);
    expect(analysis.arms.experts.nVerdict).toBe(0);
    expect(analysis.arms.experts.firstPass.rate).toBeNull();
  });

  it("treats verifier as the verify role even when listed in --work-types (hard rule)", () => {
    expect(roleOf("verifier")).toBe("verify");
    expect(roleOf("verifier", ["verifier", "general"])).toBe("verify");
    expect(roleOf("general")).toBe("work");
    expect(roleOf("frontend-dev")).toBe("work");
    expect(roleOf("frontend-dev", ["general"])).toBe("other");
    expect(roleOf("Plan")).toBe("other");
    expect(roleOf(undefined)).toBe("other");
    expect(DEFAULT_WORK_TYPES).toEqual(["general", "frontend-dev"]);
  });

  it("honors --work-types overrides (cost-only for non-work types)", () => {
    const analysis = analyze(
      [
        run("r_plan", {
          diag: { agentType: "Plan", createdAt: t0, dispatchMeta: meta("pkg-d", "control"), usage: { costUsd: 0.9 } },
        }),
        run("r_gen", {
          diag: {
            agentType: "general",
            createdAt: t0,
            dispatchMeta: meta("pkg-d", "control"),
            usage: { costUsd: 0.1 },
          },
        }),
      ],
      { workTypes: ["Plan"] },
    );
    const p = pkg(analysis, "pkg-d");
    expect(p.roles).toEqual({ work: 1, verify: 0, other: 1 }); // general became cost-only
    expect(p.costUsd).toBe(1); // other-role runs still count toward cost
    // no work run in the default set ⇒ control arm has no protocol complaint either way
    expect(exclusion(analysis, "pkg-d")).toBeUndefined();
  });
});

/* ----------------------------------------------------------------- CLI ---- */

describe("consult-ab-analyze.mjs CLI", () => {
  it("--json output equals the in-lib analysis byte-for-byte (determinism)", () => {
    const stdout = runCli(["--dir", FIXTURES, "--json"]);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout)).toEqual(analyzeFixture());
    const salted = runCli(["--dir", FIXTURES, "--json", "--salt", "consult-ab-v1"]);
    expect(JSON.parse(salted)).toEqual(analyzeFixture({ salt: "consult-ab-v1" }));
  });

  it("renders the human report with the exclusion list and warnings", () => {
    const out = runCli(["--dir", FIXTURES]);
    expect(out).toContain("consult A/B analysis");
    expect(out).toContain("arm experts (n=6 packages, 5 with verdicts)");
    expect(out).toContain("partial-unenrolled");
    expect(out).toContain("absorbed-cap-hit");
    expect(out).toContain("FIFO set capped at 100");
    expect(out).toContain("Wilson95");
    expect(out).toContain("underpowered");
  });

  it("supports --since and rejects bad arguments", () => {
    const out = runCli(["--dir", FIXTURES, "--since", "2026-10-01"]);
    expect(out).toContain("3 out of window");
    expect(() => runCli(["--dir", FIXTURES, "--since", "Oct-1"])).toThrow();
    expect(() => runCli(["--dir", "/nonexistent-consult-ab-dir"])).toThrow();
  });
});
