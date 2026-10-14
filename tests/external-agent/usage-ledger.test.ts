import { describe, expect, it } from "vitest";
import type { ExternalPricing } from "../../src/core/types.js";
import { createUsageLedger } from "../../src/external-agent/usage-ledger.js";
import type { ExternalTokenCounts } from "../../src/external-agent/types.js";

const C = (o: Partial<ExternalTokenCounts> = {}): ExternalTokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
  credits: 0,
  ...o,
});
const PRICED: ExternalPricing = {
  status: "priced",
  source: "anthropic/claude-sonnet-5",
  basis: "upstream",
  approx: false,
  // $1 / $2 / $0.5 / $4 per 1M
  table: {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 4,
    tiers: [{ inputTokensAbove: 1000, input: 10, output: 20, cacheRead: 5, cacheWrite: 40 }],
  },
};
const UNPRICED: ExternalPricing = { status: "unpriced", reason: "no_match", detail: "d" };
const mk = (p: ExternalPricing = PRICED, o: { thinkingInOutput?: boolean; cumulativeIncludesChild?: boolean } = {}) =>
  createUsageLedger(p, {
    thinkingInOutput: o.thinkingInOutput ?? true,
    cumulativeIncludesChild: o.cumulativeIncludesChild ?? false,
  });

describe("usage ledger", () => {
  it("L1/L2: fresh session baseline zeros; cumulative → per-step increments", () => {
    const l = mk();
    l.beginTurn(C());
    const d1 = l.observeCumulative(C({ input: 100, output: 10 }));
    const d2 = l.observeCumulative(C({ input: 150, output: 30 }));
    expect(d1).toMatchObject({ input: 100, output: 10 });
    expect(d2).toMatchObject({ input: 50, output: 20 });
    expect(d1?.costUsd).toBeCloseTo((100 * 1 + 10 * 2) / 1e6, 12);
    expect(l.lastCumulative()).toEqual(C({ input: 150, output: 30 }));
    expect(l.observeCumulative(C({ input: 150, output: 30 }))).toBeUndefined(); // no change
  });

  it("L1/L2: resume first turn has undefined baseline ⇒ first event is the baseline, not usage", () => {
    const l = mk();
    l.beginTurn(undefined);
    expect(l.observeCumulative(C({ input: 5000, output: 900 }))).toBeUndefined();
    const d = l.observeCumulative(C({ input: 5100, output: 920 }));
    expect(d).toMatchObject({ input: 100, output: 20 });
    expect(l.totals().usage.input).toBe(100); // history never booked
  });

  it("L1: later turns start from lastCumulative(); first event equal to baseline adds nothing", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 100, output: 10 }));
    l.completeTurn(C({ input: 100, output: 10 }));
    l.beginTurn(l.lastCumulative());
    expect(l.observeCumulative(C({ input: 100, output: 10 }))).toBeUndefined();
    expect(l.observeCumulative(C({ input: 130, output: 15 }))).toMatchObject({ input: 30, output: 5 });
  });

  it("L2: observe outside a turn only records prev (no usage)", () => {
    const l = mk();
    expect(l.observeCumulative(C({ input: 77 }))).toBeUndefined();
    expect(l.lastCumulative()).toEqual(C({ input: 77 }));
    expect(l.totals().usage.input).toBe(0);
  });

  it("L2: regressions never go negative and never double-count the rebound", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 100 }));
    expect(l.observeCumulative(C({ input: 60 }))).toBeUndefined();
    expect(l.observeCumulative(C({ input: 90 }))).toBeUndefined(); // still below the high-water mark
    expect(l.observeCumulative(C({ input: 120 }))).toMatchObject({ input: 20 });
    expect(l.totals().usage.input).toBe(120);
  });

  it("L3: completeTurn books only the remainder (live + reconcile never double count)", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 100, output: 10 }));
    const rem = l.completeTurn(C({ input: 150, output: 25 }));
    expect(rem).toMatchObject({ input: 50, output: 15 });
    expect(l.totals().usage).toMatchObject({ input: 150, output: 25 });
    expect(l.totals().overcount).toBe(false);
  });

  it("L3: duplicate completeTurn for the same turn ⇒ undefined, totals unchanged", () => {
    const l = mk();
    l.beginTurn(C());
    expect(l.completeTurn(C({ input: 10 }))).toMatchObject({ input: 10 });
    expect(l.completeTurn(C({ input: 10 }))).toBeUndefined();
    expect(l.totals().usage.input).toBe(10);
    // and completeTurn without any beginTurn is a no-op too
    expect(mk().completeTurn(C({ input: 1 }))).toBeUndefined();
  });

  it("L3: emitted > turnTotal ⇒ overcount flag (sticky), remainder clamps to 0 (no negative)", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 200 }));
    expect(l.completeTurn(C({ input: 150 }))).toBeUndefined();
    const t = l.totals();
    expect(t.overcount).toBe(true);
    expect(t.usage.input).toBe(200);
    l.beginTurn(l.lastCumulative());
    l.completeTurn(C());
    expect(l.totals().overcount).toBe(true);
  });

  it("L4: process dies mid-turn — increments already booked remain, nothing is reconciled", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 100, output: 10 }));
    expect(l.totals().usage).toMatchObject({ input: 100, output: 10 });
    expect(l.totals().usage.costUsd).toBeGreaterThan(0);
  });

  it("L5: thinkingInOutput=true leaves output alone; false folds thinking into output (priced as output)", () => {
    const a = mk(PRICED, { thinkingInOutput: true });
    a.beginTurn(C());
    a.observeCumulative(C({ output: 10, thinking: 6 }));
    const da = a.completeTurn(C({ output: 10, thinking: 6 }));
    expect(da).toBeUndefined();
    expect(a.totals().usage.output).toBe(10);
    expect(a.totals().thinking).toBe(6);
    const b = mk(PRICED, { thinkingInOutput: false });
    b.beginTurn(C());
    const db = b.observeCumulative(C({ output: 10, thinking: 6 }));
    expect(db).toMatchObject({ output: 16 });
    expect(db?.costUsd).toBeCloseTo((16 * 2) / 1e6, 12);
    expect(b.completeTurn(C({ output: 10, thinking: 6 }))).toBeUndefined();
    expect(b.totals()).toMatchObject({ thinking: 6, usage: { output: 16 } });
    // thinking arriving only in the final reconcile
    const c = mk(PRICED, { thinkingInOutput: false });
    c.beginTurn(C());
    expect(c.completeTurn(C({ output: 4, thinking: 3 }))).toMatchObject({ output: 7 });
  });

  it("L6: child usage counts tokens, never cost; delta and pricing diag degrade to partial", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 100 }));
    const d = l.completeTurn(C({ input: 100 }), C({ input: 1_000_000, output: 500_000 }));
    expect(d).toMatchObject({ input: 1_000_000, output: 500_000, costUsd: 0, unpriced: "partial" });
    const t = l.totals();
    expect(t.childTokens).toBe(1_500_000);
    expect(t.usage.unpriced).toBe("partial");
    expect(t.usage.costUsd).toBeCloseTo(100 / 1e6, 12); // only the parent's 100 input tokens priced
    expect(t.pricing).toMatchObject({
      status: "partial",
      reason: "child_usage",
      source: "anthropic/claude-sonnet-5",
      basis: "upstream",
    });
  });

  it("L6: cumulativeIncludesChild — target includes the child tokens (no overcount), flagged partial", () => {
    const l = mk(PRICED, { cumulativeIncludesChild: true });
    l.beginTurn(C());
    l.observeCumulative(C({ input: 300 })); // live cumulative already carries the child's 200
    const d = l.completeTurn(C({ input: 100 }), C({ input: 200 }));
    expect(d).toBeUndefined();
    const t = l.totals();
    expect(t.overcount).toBe(false);
    expect(t.usage.input).toBe(300);
    expect(t.childTokens).toBe(200);
    expect(t.pricing.status).toBe("partial");
  });

  it("L7: unpriced run ⇒ every delta costUsd 0 + unpriced:'all'; diag unpriced with reason/detail", () => {
    const l = mk(UNPRICED);
    l.beginTurn(C());
    const d = l.observeCumulative(C({ input: 100, output: 5 }));
    expect(d).toEqual({ input: 100, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: "all" });
    expect(l.completeTurn(C({ input: 120 }))).toMatchObject({ input: 20, costUsd: 0, unpriced: "all" });
    const t = l.totals();
    expect(t.usage).toMatchObject({ costUsd: 0, unpriced: "all" });
    expect(t.pricing).toEqual({ status: "unpriced", reason: "no_match", detail: "d" });
  });

  it("L7: priced run has no unpriced key anywhere; approx pricing carries approx:true in diag", () => {
    const l = mk();
    l.beginTurn(C());
    const d = l.observeCumulative(C({ input: 10 }));
    expect("unpriced" in (d as object)).toBe(false);
    expect("unpriced" in l.totals().usage).toBe(false);
    expect(l.totals().pricing).toEqual({ status: "priced", source: "anthropic/claude-sonnet-5", basis: "upstream" });
    const approx = createUsageLedger(
      { ...PRICED, basis: "family", approx: true },
      { thinkingInOutput: true, cumulativeIncludesChild: false },
    );
    expect(approx.totals().pricing).toMatchObject({ approx: true, basis: "family" });
  });

  it("L7: tier selection prefers lastCall (≈ one request) over the increment itself", () => {
    const l = mk();
    l.beginTurn(C());
    // increment is tiny (100 input) but the last request carried 5000 input tokens ⇒ upper tier ($10/1M)
    const d = l.observeCumulative(C({ input: 100 }), C({ input: 5000 }));
    expect(d?.costUsd).toBeCloseTo((100 * 10) / 1e6, 12);
    // without lastCall the same increment is priced on the base tier ($1/1M)
    const l2 = mk();
    l2.beginTurn(C());
    expect(l2.observeCumulative(C({ input: 100 }))?.costUsd).toBeCloseTo((100 * 1) / 1e6, 12);
    // lastCall cache tokens count toward the request size
    const l3 = mk();
    l3.beginTurn(C());
    expect(l3.observeCumulative(C({ input: 100 }), C({ input: 10, cacheRead: 2000 }))?.costUsd).toBeCloseTo(
      (100 * 10) / 1e6,
      12,
    );
  });

  it("NaN / negative / non-number fields are clamped to 0 (never poison totals)", () => {
    const l = mk();
    l.beginTurn(C({ input: Number.NaN }));
    const d = l.observeCumulative({ ...C({ input: 10 }), output: Number.NaN, cacheRead: -4, credits: Infinity });
    expect(d).toMatchObject({ input: 10, output: 0, cacheRead: 0 });
    const t = l.totals();
    for (const v of [t.usage.input, t.usage.output, t.usage.costUsd, t.credits, t.thinking])
      expect(Number.isFinite(v)).toBe(true);
    expect(t.credits).toBe(0);
  });

  it("L8: credits come from cumulative differences (and reconcile remainder), never from costUsd", () => {
    const l = mk();
    l.beginTurn(C());
    expect(l.observeCumulative(C({ input: 10, credits: 1.5 }))).toMatchObject({ input: 10 });
    l.observeCumulative(C({ input: 10, credits: 4 }));
    expect(l.totals().credits).toBeCloseTo(4, 9);
    l.completeTurn(C({ input: 10, credits: 5 }));
    expect(l.totals().credits).toBeCloseTo(5, 9);
    // credits-only change yields no UsageDelta but is tracked
    const l2 = mk();
    l2.beginTurn(C());
    expect(l2.observeCumulative(C({ credits: 2 }))).toBeUndefined();
    expect(l2.totals().credits).toBe(2);
    expect(l2.totals().usage.costUsd).toBe(0);
  });

  it("lastCumulative returns a copy", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 5 }));
    const a = l.lastCumulative();
    if (a) a.input = 999;
    expect(l.lastCumulative()?.input).toBe(5);
  });

  it("multi-turn totals sum across turns", () => {
    const l = mk();
    l.beginTurn(C());
    l.observeCumulative(C({ input: 100 }));
    l.completeTurn(C({ input: 100 }));
    l.beginTurn(l.lastCumulative());
    l.observeCumulative(C({ input: 100 }));
    l.observeCumulative(C({ input: 160, output: 8 }));
    l.completeTurn(C({ input: 60, output: 8 }));
    expect(l.totals().usage).toMatchObject({ input: 160, output: 8 });
  });
});
