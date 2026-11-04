// tests/memory/jev/predict-eval.test.ts — pins scripts/dev/predict-eval.mjs
// (memory-predict plan.md v3.2 §12.2/§12.3/§12.4): the labelled-set schema and
// stratification quotas, the holdout-only metric math against hand-computed
// expected values, the latency/cost aggregations, and — above all — the
// honesty contract: missing data ⇒ NOT-EVALUATED, never a fabricated PASS.
//
// The synthetic labels/runs below are TEST FIXTURES exercising the validator
// and the arithmetic only; the eval script itself never generates eval data.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as evalScript from "../../../scripts/dev/predict-eval.mjs";

// ───────────────────── fixture helpers ─────────────────────

function label(overrides = {}) {
  return {
    id: "r0001",
    session: "s1",
    subset: "tuning",
    sessionKind: "main",
    prompt: "把这个 fix 提交了",
    expected: { tags: ["git-commit"], anchors: ["pitfalls-git.md#1"], state: [] },
    flags: {},
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: "r0001",
    jev: "full",
    p: { tags: ["git-commit"], state: [], anchors: ["pitfalls-git.md#1"], origin: "rules" },
    uOn: { anchors: ["pitfalls-git.md#1"] },
    uOff: { anchors: [] },
    ...overrides,
  };
}

/**
 * A labelled set satisfying every §12.2 quota: 9 high-risk tags × 10 positives
 * (5 holdout each for per-tag support), every constraint bucket at/above its
 * minimum, ≥160 rounds, consistent by-session 60/40-ish split.
 */
function quotaSatisfyingLabels() {
  const labels = [];
  const add = (overrides) => labels.push(label(overrides));
  for (const t of [...evalScript.HIGH_RISK_TAGS]) {
    for (let i = 0; i < 10; i++)
      add({
        id: `q-tag-${t}-${i}`,
        session: i < 4 ? `s-${t}-h` : `s-${t}-t`, // subset-pure sessions (split is by session)
        subset: i < 4 ? "holdout" : "tuning", // 4 holdout + 6 tuning per tag
        expected: { tags: [t], anchors: [`${t}.md#${i}`], state: [] },
      });
    // 5th holdout positive so per-tag holdout support reaches 5 (M1 minimum)
    add({
      id: `q-tag-${t}-x`,
      session: `s-${t}-h`,
      subset: "holdout",
      expected: { tags: [t], anchors: [`${t}.md#x`], state: [] },
    });
  }
  const flagRows = [
    ["negated", 12],
    ["readonlyOrQuestion", 12],
    ["carryExpired", 10],
    ["releaseInProgress", 8],
    ["carry", 12],
    ["shortNewInstruction", 10],
    ["idleChat", 10],
  ];
  for (const [flag, count] of flagRows)
    for (let i = 0; i < count; i++)
      add({
        id: `q-${flag}-${i}`,
        session: i % 3 === 0 ? `s-${flag}-h` : `s-${flag}-t`,
        subset: i % 3 === 0 ? "holdout" : "tuning",
        expected: { tags: [], anchors: [], state: flag === "releaseInProgress" ? ["release-in-progress"] : [] },
        flags: { [flag]: true },
      });
  for (let i = 0; i < 12; i++)
    add({
      id: `q-child-${i}`,
      session: i % 3 === 0 ? "s-child-h" : "s-child-t",
      subset: i % 3 === 0 ? "holdout" : "tuning",
      sessionKind: "child",
      expected: { tags: [], anchors: [], state: [] },
    });
  return labels;
}

/** Runs for every holdout label of `quotaSatisfyingLabels`, engineered so all
 * of M1–M8 pass: correct predictions, full baselines, negation rounds silent,
 * carry honoured (vacuously — carry rounds carry no expected tags), S hit. */
function passingRuns(labels) {
  return labels
    .filter((l) => l.subset === "holdout")
    .map((l) => {
      const negated = Boolean(l.flags.negated || l.flags.readonlyOrQuestion);
      return run({
        id: l.id,
        // deterministic bucket mix so both M3 partial and full buckets have rows
        jev: Number(l.id.slice(-1)) % 2 === 0 ? "partial" : "full",
        p: {
          tags: negated ? [] : [...l.expected.tags],
          state: [...l.expected.state],
          anchors: negated ? [] : [...l.expected.anchors],
          origin: "rules",
        },
        uOn: { anchors: negated ? [] : [...l.expected.anchors] },
        uOff: { anchors: [] },
      });
    });
}

// ───────────────────── validateLabels ─────────────────────

describe("predict-eval: labelled-set schema and quotas", () => {
  it("reports every §12.2 quota miss on a tiny set (and never passes it)", () => {
    const result = evalScript.validateLabels([label()]);
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("strata total: 1 < 160");
    for (const t of evalScript.HIGH_RISK_TAGS) expect(joined).toContain(`strata tag:${t}: `);
    expect(joined).toContain("split: both tuning (1) and holdout (0) sessions must exist");
    for (const [name, min] of Object.entries(evalScript.STRATA_MIN))
      if (name !== "total") expect(joined).toContain(`strata ${name}: 0 < ${min}`);
  });

  it("accepts a quota-satisfying set with a consistent by-session split", () => {
    const labels = quotaSatisfyingLabels();
    const result = evalScript.validateLabels(labels);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts.total).toBeGreaterThanOrEqual(160);
    expect(result.counts.holdout).toBeGreaterThan(0);
    expect(result.counts.buckets["tag:git-commit"]).toBe(11);
    expect(result.counts.buckets["negation"]).toBe(12);
    expect(result.counts.buckets["child-session"]).toBe(12);
    expect(result.counts.buckets["release-in-progress"]).toBe(8);
  });

  it("rejects structural problems: duplicate id, split session, bad rows", () => {
    const labels = [
      label({ id: "dup" }),
      label({ id: "dup", session: "s2" }),
      label({ id: "r3", session: "sx", subset: "tuning" }),
      label({ id: "r4", session: "sx", subset: "holdout" }), // same session, two subsets
      label({ id: "r5", prompt: "" }), // empty prompt
      label({ id: "r6", subset: "other" }),
      label({ id: "r7", sessionKind: "server" }),
      { id: "r8", expected: "nope" },
    ];
    const errors = evalScript.validateLabels(labels).errors.join("\n");
    expect(errors).toContain("duplicate id");
    expect(errors).toContain("split across tuning and holdout");
    expect(errors).toContain("prompt: required non-empty string");
    expect(errors).toContain("subset: must be 'tuning' or 'holdout'");
    expect(errors).toContain("sessionKind: must be 'main' or 'child'");
    expect(errors).toContain("expected: required object");
  });

  it("derives strata buckets from expected.tags, flags and sessionKind", () => {
    const buckets = evalScript.strataBucketsOf(
      label({
        expected: { tags: ["release", "testing"], anchors: [], state: [] },
        sessionKind: "child",
        flags: { negated: true, carry: true },
      }),
    );
    expect([...buckets].sort()).toEqual(["carry", "child-session", "negation", "tag:release"]);
  });

  it("flags parse-error rows from parseJsonl as validation errors", () => {
    const rows = evalScript.parseJsonl('{"id":"a"}\nnot json\n');
    expect(rows).toHaveLength(2);
    const result = evalScript.validateLabels(rows);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("JSON parse error");
  });

  it("validateRuns matches run ids against labels and rejects shape errors", () => {
    const labels = [label({ id: "ok1" }), label({ id: "ok2" })];
    const { ok, errors } = evalScript.validateRuns(
      [
        run({ id: "ok1" }),
        run({ id: "ok1" }), // duplicate
        run({ id: "ghost" }), // unknown id
        run({ id: "ok2", jev: "sometimes" }),
        run({ id: "ok2", p: { tags: "git-commit" } }),
      ],
      labels,
    );
    expect(ok).toBe(false);
    const joined = errors.join("\n");
    expect(joined).toContain("duplicate run");
    expect(joined).toContain("no label with this id");
    expect(joined).toContain("jev: must be 'full' | 'probing' | 'partial'");
    expect(joined).toContain("p.tags: string[]");
  });
});

// ───────────────────── computeMetrics (holdout only, hand-checked math) ─────────────────────

describe("predict-eval: §12.2 metrics", () => {
  it("M1/M2 compute per-tag and micro precision from real predictions only (tuning excluded)", () => {
    const labels = [
      ...[1, 2, 3, 4, 5].map((i) =>
        label({
          id: `h${i}`,
          session: `sh${i}`,
          subset: "holdout",
          expected: { tags: ["git-commit"], anchors: [], state: [] },
        }),
      ),
      ...[6, 7, 8, 9, 10].map((i) =>
        label({
          id: `h${i}`,
          session: `sh${i}`,
          subset: "holdout",
          expected: { tags: ["release"], anchors: [], state: [] },
        }),
      ),
      // tuning round with a wrong-prediction counterpart — must not count
      label({ id: "t1", session: "st", subset: "tuning", expected: { tags: ["git-commit"], anchors: [], state: [] } }),
    ];
    const runs = labels
      .filter((l) => l.subset === "holdout")
      .map((l, i) => run({ id: l.id, p: { tags: i === 4 ? ["release"] : l.expected.tags, anchors: [], state: [] } }));
    const r = evalScript.computeMetrics(labels, runs, { noModel: true });
    const m1 = r.metrics[0];
    expect(m1.name).toContain("M1");
    // git-commit: support 5, predicted 4 (h1–h4), all correct ⇒ 4/4
    const commit = m1.detail.find((d) => d.startsWith("git-commit"));
    expect(commit).toContain("(4/4)");
    expect(commit).toContain("PASS");
    // release: support 5, predicted 6 (h5's stray + h6–h10), 5 correct ⇒ 5/6
    const rel = m1.detail.find((d) => d.startsWith("release"));
    expect(rel).toContain("83.3% (5/6)");
    expect(rel).toContain("PASS");
    // the other 7 tags have no holdout support ⇒ NOT-EVALUATED, so is M1
    expect(m1.status).toBe("NOT-EVALUATED");
    // M2 micro: 9 correct / 10 predicted = 90.0% (tuning round excluded)
    const m2 = r.metrics[1];
    expect(m2.detail[0]).toContain("90.0% (9/10)");
  });

  it("M1 stays NOT-EVALUATED below support 5 or with zero predictions (no fabricated precision)", () => {
    const labels = [
      label({ id: "h1", session: "a", subset: "holdout", expected: { tags: ["deletion"], anchors: [], state: [] } }),
    ];
    const r = evalScript.computeMetrics(
      labels,
      [run({ id: "h1", p: { tags: ["deletion"], anchors: [], state: [] } })],
      {
        noModel: true,
      },
    );
    const m1 = r.metrics[0];
    expect(m1.status).toBe("NOT-EVALUATED");
    expect(m1.detail.join("\n")).toContain("support 1 < 5");
  });

  it("M3 coverage delta splits by jev bucket and demands uOn+uOff baselines", () => {
    const labels = [1, 2, 3, 4].map((i) =>
      label({ id: `p${i}`, session: "sp", subset: "holdout", expected: { tags: [], anchors: [`a${i}`], state: [] } }),
    );
    labels.push(
      label({ id: "f1", session: "sf", subset: "holdout", expected: { tags: [], anchors: ["b1"], state: [] } }),
    );
    const runs = [
      // partial: on hits 3/4 (75%), off 0/4 ⇒ +75pp ≥ +25pp
      ...[1, 2, 3].map((i) =>
        run({
          id: `p${i}`,
          jev: "partial",
          p: { tags: [], anchors: [`a${i}`], state: [] },
          uOn: { anchors: [`a${i}`] },
          uOff: { anchors: [] },
        }),
      ),
      run({
        id: "p4",
        jev: "partial",
        p: { tags: [], anchors: [], state: [] },
        uOn: { anchors: [] },
        uOff: { anchors: [] },
      }),
      // full: uOff baseline absent ⇒ NOT-EVALUATED (explicit undefined — the
      // run() default would otherwise leave an empty-but-present uOff)
      run({
        id: "f1",
        jev: "full",
        p: { tags: [], anchors: ["b1"], state: [] },
        uOn: { anchors: ["b1"] },
        uOff: undefined,
      }),
    ];
    const r = evalScript.computeMetrics(labels, runs, { noModel: true });
    const m3 = r.metrics.find((m) => m.name.startsWith("M3"));
    expect(m3.status).toBe("NOT-EVALUATED");
    const d = m3.detail.join("\n");
    expect(d).toContain("partial: on 75.0% vs off 0.0% ⇒ +75.0pp (need ≥+25.0pp, n=4) PASS");
    expect(d).toContain("full: NOT-EVALUATED");
    expect(d).toContain("missing uOff.anchors");
  });

  it("M4/M5 count extra and misinjected anchors against the baselines/labels", () => {
    const labels = [
      label({ id: "h1", session: "s", subset: "holdout", expected: { tags: [], anchors: ["good"], state: [] } }),
      label({ id: "h2", session: "s", subset: "holdout", expected: { tags: [], anchors: ["good"], state: [] } }),
    ];
    const runs = [
      // h1: P injects good (also in uOn ⇒ neither extra nor wrong) + stray (extra AND wrong)
      run({
        id: "h1",
        p: { tags: [], anchors: ["good", "stray"], state: [] },
        uOn: { anchors: ["good"] },
        uOff: { anchors: [] },
      }),
      // h2: good would have come from U anyway (in uOff) ⇒ not extra, not wrong
      run({
        id: "h2",
        p: { tags: [], anchors: ["good"], state: [] },
        uOn: { anchors: [] },
        uOff: { anchors: ["good"] },
      }),
    ];
    const r = evalScript.computeMetrics(labels, runs, { noModel: true });
    const m4 = r.metrics.find((m) => m.name.startsWith("M4"));
    expect(m4.status).toBe("FAIL"); // mean 1 stray / 2 turns = 0.5 > 0.3
    expect(m4.detail[0]).toContain("0.500/turn (1 across 2 turns");
    const m5 = r.metrics.find((m) => m.name.startsWith("M5"));
    expect(m5.status).toBe("FAIL"); // 1 wrong of 3 injected anchors = 33.3% > 20%
    expect(m5.detail[0]).toContain("33.3% (1/3 anchors");
  });

  it("M6 fails on any write-action tag over a negation/readonly round", () => {
    const labels = [
      label({
        id: "h1",
        session: "s",
        subset: "holdout",
        flags: { negated: true },
        expected: { tags: [], anchors: [], state: [] },
      }),
    ];
    const runs = [run({ id: "h1", p: { tags: ["git-commit"], anchors: [], state: [] } })];
    const r = evalScript.computeMetrics(labels, runs, { noModel: true });
    const m6 = r.metrics.find((m) => m.name.startsWith("M6"));
    expect(m6.status).toBe("FAIL");
    expect(m6.detail[0]).toContain("1/1 rounds");
    expect(r.verdict).toBe("FAIL");
  });

  it("M7 evaluates carry coverage and false carry (carryTags preferred over tags)", () => {
    const labels = [
      label({
        id: "c1",
        session: "s",
        subset: "holdout",
        flags: { carry: true },
        expected: { tags: ["release"], anchors: [], state: [] },
      }),
      label({
        id: "c2",
        session: "s",
        subset: "holdout",
        flags: { carry: true },
        expected: { tags: ["release"], anchors: [], state: [] },
      }),
      label({
        id: "n1",
        session: "s",
        subset: "holdout",
        flags: { shortNewInstruction: true },
        expected: { tags: ["git-commit"], anchors: [], state: [] },
      }),
    ];
    const runs = [
      run({ id: "c1", p: { tags: ["release"], carryTags: ["release"], anchors: [], state: [] } }),
      run({ id: "c2", p: { tags: [], anchors: [], state: [] } }), // carry missed
      // n1 predicts the right new tag but ALSO carries stale "release" ⇒ false carry
      run({ id: "n1", p: { tags: ["git-commit", "release"], carryTags: ["release"], anchors: [], state: [] } }),
    ];
    const r = evalScript.computeMetrics(labels, runs, { noModel: true });
    const m7 = r.metrics.find((m) => m.name.startsWith("M7"));
    expect(m7.status).toBe("FAIL");
    const d = m7.detail[0];
    expect(d).toContain("carry coverage 50.0% (1/2) FAIL");
    expect(d).toContain("false carry 1/1");
  });

  it("M8 measures S-entry coverage on release-in-progress rounds", () => {
    const labels = [1, 2].map((i) =>
      label({
        id: `s${i}`,
        session: "s",
        subset: "holdout",
        flags: { releaseInProgress: true },
        expected: { tags: [], anchors: [], state: [] },
      }),
    );
    const runs = [
      run({ id: "s1", p: { tags: [], anchors: [], state: ["release-in-progress"] } }),
      run({ id: "s2", p: { tags: [], anchors: [], state: [] } }),
    ];
    const r = evalScript.computeMetrics(labels, runs, { noModel: true });
    const m8 = r.metrics.find((m) => m.name.startsWith("M8"));
    expect(m8.status).toBe("FAIL"); // 50% < 90%
    expect(m8.detail[0]).toContain("50.0% (1/2)");
  });

  it("M9 needs a model pass (or --no-model); with one it computes the increment", () => {
    const labels = [
      label({ id: "u1", session: "s", subset: "holdout", expected: { tags: [], anchors: ["a"], state: [] } }),
    ];
    const baseRun = run({
      id: "u1",
      p: { tags: [], anchors: [], state: [], uncertain: true },
      uOn: { anchors: [] },
      uOff: { anchors: [] },
    });
    const noData = evalScript.computeMetrics(labels, [baseRun], {});
    expect(noData.metrics.find((m) => m.name.startsWith("M9")).detail[0]).toContain("no --runs-model file");
    const declared = evalScript.computeMetrics(labels, [baseRun], { noModel: true });
    expect(declared.metrics.find((m) => m.name.startsWith("M9")).detail[0]).toContain("P1b rules-only run");

    const modelRun = run({
      id: "u1",
      p: { tags: [], anchors: ["a"], state: [], uncertain: true },
      uOn: { anchors: ["a"] },
      uOff: { anchors: [] },
    });
    const withModel = evalScript.computeMetrics(labels, [baseRun], { runsModel: [modelRun] });
    const m9 = withModel.metrics.find((m) => m.name.startsWith("M9"));
    expect(m9.status).toBe("PASS");
    expect(m9.detail[0]).toContain("coverage 100.0% vs 0.0% ⇒ +100.0pp (need ≥+5.0pp) PASS");
    expect(m9.detail[0]).toContain("(+0.000, need ≤0.1)");
  });

  it("verdict is INCOMPLETE (never PASS) while any metric lacks data", () => {
    const labels = [
      label({ id: "h1", subset: "holdout", session: "s", expected: { tags: [], anchors: [], state: [] } }),
    ];
    const r = evalScript.computeMetrics(labels, [run({ id: "h1", p: { tags: [], anchors: [], state: [] } })], {
      noModel: true,
    });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.metrics.some((m) => m.status === "NOT-EVALUATED")).toBe(true);
  });

  it("a fully-recorded pass yields PASS across M1–M9 (and only then)", () => {
    const labels = quotaSatisfyingLabels();
    const labelById = new Map(labels.map((l) => [l.id, l]));
    const runs = passingRuns(labels);
    // 45 holdout tag-rounds carry expected anchors; blank 6 of them in the base
    // (rules-only) pass so the model pass has a real ≥5pp increment to recover.
    const anchorRuns = runs.filter((r) => r.p.anchors.length > 0);
    expect(anchorRuns.length).toBe(45);
    const recoveredIds = new Set(anchorRuns.slice(0, 6).map((r) => r.id));
    for (const r of runs) {
      r.p.uncertain = true;
      if (recoveredIds.has(r.id)) {
        r.p.anchors = [];
        r.uOn = { anchors: [] };
      }
    }
    const modelRuns = runs.map((r) => {
      const anchors = labelById.get(r.id).expected.anchors;
      return recoveredIds.has(r.id)
        ? { ...r, p: { ...r.p, origin: "rules+model", anchors: [...anchors] }, uOn: { anchors: [...anchors] } }
        : { ...r, p: { ...r.p, origin: "rules+model" } };
    });
    const result = evalScript.computeMetrics(labels, runs, { runsModel: modelRuns });
    expect(result.metrics.filter((m) => m.status === "FAIL")).toEqual([]);
    expect(result.metrics.filter((m) => m.status === "NOT-EVALUATED")).toEqual([]);
    // 6/76 uncertain holdout rounds recovered ⇒ +7.9pp ≥ +5pp, extra delta 0
    const m9 = result.metrics.find((m) => m.name.startsWith("M9"));
    expect(m9.status).toBe("PASS");
    expect(m9.detail[0]).toContain("n=76");
    expect(result.verdict).toBe("PASS");
  });
});

// ───────────────────── latency / cost / percentile ─────────────────────

describe("predict-eval: §12.3 latency and §12.4 cost aggregation", () => {
  it("percentile uses nearest-rank on sorted input", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(evalScript.percentile(sorted, 50)).toBe(5);
    expect(evalScript.percentile(sorted, 99)).toBe(10);
    expect(evalScript.percentile([], 99)).toBeUndefined();
  });

  it("latencyStats groups by phase and flags over-budget p99", () => {
    const runs = [
      run({ id: "a", p: { tags: [], anchors: [], state: [], ms: 1, phase: "rules" } }),
      run({ id: "b", p: { tags: [], anchors: [], state: [], ms: 3, phase: "rules" } }),
      run({ id: "c", p: { tags: [], anchors: [], state: [], ms: 12, phase: "runPredict-hot" } }),
    ];
    const rows = evalScript.latencyStats(runs);
    const rules = rows.find((r) => r.phase === "rules");
    expect(rules.n).toBe(2);
    expect(rules.p50).toBe(1);
    expect(rules.p99).toBe(3);
    expect(rules.overBudget).toBe(true); // 3ms > 2ms local budget
    const hot = rows.find((r) => r.phase === "runPredict-hot");
    expect(hot.overBudget).toBe(true); // 12 > 10
    expect(rows.find((r) => r.phase === "runPredict-cold")).toBeUndefined();
  });

  it("costStats settles usage-first, reserve-fallback, and groups by day", () => {
    const stats = evalScript.costStats([
      { at: "2026-11-04T10:00:00Z", ok: true, reserveUsd: 0.0003, costUsd: 0.00028, costSource: "usage" },
      { at: "2026-11-04T11:00:00Z", ok: false, reserveUsd: 0.0003, costSource: "reserve" },
      { day: "2026-11-05", ok: true, reserveUsd: 0.0003, costUsd: 0.0003, costSource: "usage" },
    ]);
    expect(stats.hasData).toBe(true);
    const d4 = stats.days.find((d) => d.day === "2026-11-04");
    expect(d4.calls).toBe(2);
    expect(d4.spentUsd).toBeCloseTo(0.00058, 6);
    expect(d4.reserveShare).toBe(0.5);
    expect(d4.overUsdCap).toBe(false);
    const d5 = stats.days.find((d) => d.day === "2026-11-05");
    expect(d5.spentUsd).toBeCloseTo(0.0003, 6);
    expect(evalScript.costStats([]).hasData).toBe(false);
  });
});

// ───────────────────── CLI honesty paths ─────────────────────

describe("predict-eval: CLI (help / missing data never claims a pass)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("--help exits 0 and prints the usage", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await evalScript.main(["--help"]);
    expect(code).toBe(0);
    expect(spy.mock.calls.flat().join("\n")).toContain("--check-labels");
  });

  it("--check-labels on a missing file reports it and exits 0 (nothing to validate)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await evalScript.main(["--check-labels", "--labels", "/tmp/definitely-missing-predict-eval.jsonl"]);
    expect(code).toBe(0);
    const out = spy.mock.calls.flat().join("\n");
    expect(out).toContain("not found");
    expect(out).toContain("never generates it");
  });

  it("--metrics without inputs exits 1 saying NOT-EVALUATED, with no GATE: PASS", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await evalScript.main(["--metrics", "--labels", "/tmp/definitely-missing-predict-eval.jsonl"]);
    expect(code).toBe(1);
    const out = spy.mock.calls.flat().join("\n");
    expect(out).toContain("metrics: NOT-EVALUATED");
    expect(out).not.toContain("GATE: PASS");
  });
});
