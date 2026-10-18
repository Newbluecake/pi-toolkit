import { describe, expect, it } from "vitest";
import {
  accountRequestCost,
  buildExecutionPlan,
  contextWindowAdmits,
  estimateCost,
  formatConfirmText,
  formatCost,
  formatPlanLines,
  readPrice,
  sumCosts,
  tokenFigures,
  writePrice,
  ZERO_COST,
} from "../../src/cache-ttl/measure-plan.js";
import {
  CHARS_PER_TOKEN,
  CONTEXT_ADMISSION_MARGIN_TOKENS,
  INJECTION_ALLOWANCE_TOKENS,
  MEASURE_TIMING,
  OUTPUT_CAP,
  PREFIX_CHARS,
  P_BOUND_TOKENS,
  REQUEST_BUDGET,
  T_HI_TOKENS,
  T_LO_TOKENS,
  T_MID_TOKENS,
  TTL_GAPS_MS,
  type MeasurePriceFn,
  type PriceTokens,
  type UsageReading,
} from "../../src/cache-ttl/measure-types.js";

interface Rates {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  output?: number;
  /** Above this total prompt the whole request is billed at `tierMultiplier` (tier selected by the TOTAL). */
  tierAt?: number;
  tierMultiplier?: number;
}
/** $/M rates; `undefined` when a rate needed for a non-zero token kind is missing (pi-ai calculateCost semantics). */
function priced(r: Rates): MeasurePriceFn {
  return (t: PriceTokens) => {
    const need = (n: number, rate: number | undefined): number | undefined =>
      n > 0 && rate === undefined ? undefined : (n * (rate ?? 0)) / 1e6;
    const w1h = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
    const parts = [
      need(t.input, r.input),
      need(t.cacheRead, r.cacheRead),
      need(t.cacheWrite - w1h, r.cacheWrite),
      need(w1h, r.cacheWrite1h),
      need(t.output, r.output),
    ];
    if (parts.some((p) => p === undefined)) return undefined;
    const sum = (parts as number[]).reduce((a, b) => a + b, 0);
    const total = t.input + t.cacheRead + t.cacheWrite;
    return r.tierAt !== undefined && total > r.tierAt ? sum * (r.tierMultiplier ?? 1) : sum;
  };
}
const SONNET: Rates = { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 };
const ANTH = "anthropic-messages" as const;
const RESP = "openai-responses" as const;

const valid = (
  usage: { P: number; C: number; W?: number; W1h?: number; output?: number },
  items: Array<"output" | "write" | "write1h-split"> = [],
): UsageReading => ({
  usage,
  cacheEvidence: { kind: "valid" },
  billing: items.length === 0 ? { kind: "complete" } : { kind: "unknown", items },
});

describe("token figures", () => {
  it("are the frozen formulas: ceil(37500/{4,2.5,2.3}), P_bound = T_hi + 4608", () => {
    const t = tokenFigures();
    expect(t).toEqual({
      lo: Math.ceil(PREFIX_CHARS / CHARS_PER_TOKEN.lo),
      mid: Math.ceil(PREFIX_CHARS / CHARS_PER_TOKEN.mid),
      hi: Math.ceil(PREFIX_CHARS / CHARS_PER_TOKEN.hi),
      pBound: Math.ceil(PREFIX_CHARS / CHARS_PER_TOKEN.hi) + INJECTION_ALLOWANCE_TOKENS,
    });
    expect([t.lo, t.mid, t.hi, t.pBound]).toEqual([T_LO_TOKENS, T_MID_TOKENS, T_HI_TOKENS, P_BOUND_TOKENS]);
  });

  it("context admission needs P_bound + 2048 (boundary, fail closed on unknown)", () => {
    const need = P_BOUND_TOKENS + CONTEXT_ADMISSION_MARGIN_TOKENS;
    expect(contextWindowAdmits(need, P_BOUND_TOKENS)).toBe(true);
    expect(contextWindowAdmits(need - 1, P_BOUND_TOKENS)).toBe(false);
    expect(contextWindowAdmits(undefined, P_BOUND_TOKENS)).toBe(false);
    expect(contextWindowAdmits(Number.NaN, P_BOUND_TOKENS)).toBe(false);
    expect(contextWindowAdmits(200_000, P_BOUND_TOKENS)).toBe(true);
  });
});

describe("execution plan", () => {
  const plan = buildExecutionPlan({
    runId: "m-r",
    api: ANTH,
    wireModel: "claude-x",
    requestedRetention: "short",
    price: priced(SONNET),
  });

  it("is ONE frozen shape: six slots with the fixed gaps, control on slot 5, hard cap 17", () => {
    expect(plan.slots.map((s) => s.gapMs)).toEqual([...TTL_GAPS_MS]);
    expect(plan.slots.map((s) => s.control)).toEqual([false, false, false, false, false, true]);
    expect(plan.budget).toBe(REQUEST_BUDGET);
    expect(plan.budget.total).toBe(17);
    expect(
      plan.budget.writes + plan.budget.replacements + plan.budget.controls + plan.budget.probes + plan.budget.renewal,
    ).toBe(17);
    expect(plan.timing).toBe(MEASURE_TIMING);
    expect(plan.outputCap).toBe(OUTPUT_CAP[ANTH]);
    expect(plan.tokens.pBound).toBe(P_BOUND_TOKENS);
    expect(plan.estimate.requestCap).toBe(17);
    expect(plan.estimate.conditions).toEqual(["C1", "C2", "C3"]);
    expect(plan.estimate.pBound).toBe(P_BOUND_TOKENS);
  });

  it("output cap follows the api (Responses floor 16)", () => {
    expect(buildExecutionPlan({ runId: "m", api: RESP, wireModel: "m", requestedRetention: "short" }).outputCap).toBe(
      16,
    );
    expect(
      buildExecutionPlan({ runId: "m", api: "openai-completions", wireModel: "m", requestedRetention: "short" })
        .outputCap,
    ).toBe(1);
  });

  it("estimate text shows plan, hard cap, both cost figures, conditions and the declared renewal exception", () => {
    const text = formatPlanLines(plan).join("\n");
    expect(text).toContain("hard request cap 17");
    expect(text).toContain("3/6/11/21/31/61");
    expect(text).toMatch(/typical ≈ \$0\.37/);
    expect(text).toMatch(/worst case ≈ \$1\.33/);
    expect(text).toContain("C1, C2, C3");
    expect(text).toMatch(/ONE declared boundary renewal read/);
    const confirm = formatConfirmText(plan);
    expect(confirm).toContain("/reload, /new, /resume, fork or exit cancel the run");
    expect(confirm).toContain(
      "all progress since the last successful save may be lost — in the extreme, the whole run",
    );
  });

  it("unpriced route prints unknown but keeps the cap", () => {
    const unpriced = buildExecutionPlan({ runId: "m", api: ANTH, wireModel: "m", requestedRetention: "short" });
    expect(unpriced.estimate).toMatchObject({ typicalUsd: null, conditionalWorstUsd: null, requestCap: 17 });
    expect(formatPlanLines(unpriced).join("\n")).toContain("unknown (unpriced route)");
  });
});

describe("cost estimate (§4.3)", () => {
  it("Sonnet-class example: typical ≈ $0.37, conditional worst ≈ $1.33", () => {
    const e = estimateCost(priced(SONNET), ANTH, "short");
    // 6·W(15000) + 7·R(15000) + 13·O(1)
    const w = (15_000 * 3.75) / 1e6;
    const r = (15_000 * 0.3) / 1e6;
    const o = 15 / 1e6;
    expect(e.typicalUsd).toBeCloseTo(6 * w + 7 * r + 13 * o, 10);
    expect(e.typicalUsd!).toBeGreaterThan(0.36);
    expect(e.typicalUsd!).toBeLessThan(0.38);
    // 17·(W(P_bound) + O)
    expect(e.conditionalWorstUsd).toBeCloseTo(17 * ((P_BOUND_TOKENS * 3.75) / 1e6 + o), 10);
    expect(e.conditionalWorstUsd!).toBeGreaterThan(1.32);
    expect(e.conditionalWorstUsd!).toBeLessThan(1.34);
  });

  it("long Anthropic prices the write at the 1h rate (2× input)", () => {
    const short = estimateCost(priced(SONNET), ANTH, "short");
    const long = estimateCost(priced(SONNET), ANTH, "long");
    expect(long.typicalUsd!).toBeGreaterThan(short.typicalUsd!);
    expect(writePrice(priced(SONNET), 1_000_000, ANTH, "long")).toBeCloseTo(6, 10);
    expect(writePrice(priced(SONNET), 1_000_000, ANTH, "short")).toBeCloseTo(3.75, 10);
    // non-Anthropic "long" is not priced at 1h
    expect(writePrice(priced({ ...SONNET, cacheWrite: undefined }), 1_000_000, RESP, "long")).toBeCloseTo(3, 10);
  });

  it("W(n) falls back to the input price when the route has no cache-write price", () => {
    const openai: Rates = { input: 2, cacheRead: 0.5, output: 8 };
    expect(writePrice(priced(openai), 1_000_000, RESP, "short")).toBeCloseTo(2, 10);
    const e = estimateCost(priced(openai), RESP, "short");
    expect(e.typicalUsd).toBeCloseTo((6 * (15_000 * 2)) / 1e6 + (7 * (15_000 * 0.5)) / 1e6 + 13 * ((16 * 8) / 1e6), 10);
    expect(readPrice(priced(openai), 1_000_000)).toBeCloseTo(0.5, 10);
  });

  it("the worst case is priced at the tier P_bound falls into, the typical at the tier T_mid falls into", () => {
    // tier jump between T_mid (15000) and P_bound (20913): only the worst case pays the multiplier
    const tiered = priced({ ...SONNET, tierAt: 18_000, tierMultiplier: 2 });
    const flat = estimateCost(priced(SONNET), ANTH, "short");
    const jumped = estimateCost(tiered, ANTH, "short");
    expect(jumped.typicalUsd).toBeCloseTo(flat.typicalUsd!, 10);
    // Both the prompt AND output of that request pay the P_bound tier (measure-plan §4.3).
    expect(jumped.conditionalWorstUsd).toBeCloseTo(17 * 2 * ((P_BOUND_TOKENS * 3.75 + 15) / 1e6), 10);
  });

  it("a missing rate makes only the dependent figure unknown", () => {
    const noRead = estimateCost(priced({ ...SONNET, cacheRead: undefined }), ANTH, "short");
    expect(noRead.typicalUsd).toBeNull();
    expect(noRead.conditionalWorstUsd).not.toBeNull();
    const noOutput = estimateCost(priced({ ...SONNET, output: undefined }), ANTH, "short");
    expect(noOutput).toMatchObject({ typicalUsd: null, conditionalWorstUsd: null });
  });
});

describe("cost accounting (§4.3) — known vs unreported, never 'actual cost'", () => {
  const base = { api: ANTH, requestedRetention: "short" as const, outputCap: 1, sent: true, pBound: P_BOUND_TOKENS };
  const price = priced(SONNET);

  it("Anthropic request keeps its full input / read / write cost in knownUsd; output sits in the unknown range", () => {
    const acc = accountRequestCost({ ...base, price, reading: valid({ P: 19_000, C: 4_000, W: 10_000 }, ["output"]) });
    // uncached input = 19000 − 4000 − 10000 = 5000
    const expected = (5_000 * 3 + 4_000 * 0.3 + 10_000 * 3.75) / 1e6;
    expect(acc.knownUsd).toBeCloseTo(expected, 12);
    expect(acc.unknownUsd).toEqual([0, 15 / 1e6]);
    expect(acc.unknownItems).toEqual(["output×1"]);
  });

  it("a read-only hit (P = C) costs the read price and still reports output as unknown", () => {
    const acc = accountRequestCost({ ...base, price, reading: valid({ P: 15_000, C: 15_000, W: 0 }, ["output"]) });
    expect(acc.knownUsd).toBeCloseTo((15_000 * 0.3) / 1e6, 12);
    expect(acc.unknownItems).toEqual(["output×1"]);
  });

  it("Anthropic long without the 1h split: known at the 5m write rate, unknown range = the 1h premium", () => {
    const acc = accountRequestCost({
      ...base,
      requestedRetention: "long",
      price,
      reading: valid({ P: 15_000, C: 0, W: 15_000 }, ["output", "write1h-split"]),
    });
    expect(acc.knownUsd).toBeCloseTo((15_000 * 3.75) / 1e6, 12);
    const premium = (15_000 * (6 - 3.75)) / 1e6;
    expect(acc.unknownUsd![0]).toBe(0);
    expect(acc.unknownUsd![1]).toBeCloseTo(premium + 15 / 1e6, 12);
    expect([...acc.unknownItems].sort()).toEqual(["output×1", "write1h-split×1"]);
  });

  it("Anthropic long WITH a reported 1h split prices the 1h part at the 1h rate in knownUsd", () => {
    const acc = accountRequestCost({
      ...base,
      requestedRetention: "long",
      price,
      reading: valid({ P: 15_000, C: 0, W: 15_000, W1h: 15_000 }, ["output"]),
    });
    expect(acc.knownUsd).toBeCloseTo((15_000 * 6) / 1e6, 12);
    expect(acc.unknownItems).toEqual(["output×1"]);
  });

  it("OpenAI with output reported and no write price: input price known, nothing unknown", () => {
    const acc = accountRequestCost({
      ...base,
      api: RESP,
      outputCap: 16,
      price: priced({ input: 2, cacheRead: 0.5, output: 8 }),
      reading: valid({ P: 15_000, C: 5_000, W: 0, output: 3 }),
    });
    expect(acc.knownUsd).toBeCloseTo((10_000 * 2 + 5_000 * 0.5 + 3 * 8) / 1e6, 12);
    expect(acc.unknownUsd).toEqual([0, 0]);
    expect(acc.unknownItems).toEqual([]);
  });

  it("OpenAI without cache_write_tokens: uncached input is known at the input price, hi adds the write premium", () => {
    const acc = accountRequestCost({
      ...base,
      api: RESP,
      outputCap: 16,
      price: priced({ input: 2, cacheRead: 0.5, cacheWrite: 2.5, output: 8 }),
      reading: valid({ P: 15_000, C: 5_000, output: 1 }, ["write"]),
    });
    expect(acc.knownUsd).toBeCloseTo((10_000 * 2 + 5_000 * 0.5 + 8) / 1e6, 12);
    expect(acc.unknownUsd![1]).toBeCloseTo((10_000 * (2.5 - 2)) / 1e6, 12);
    expect(acc.unknownItems).toEqual(["write×1"]);
  });

  it("a sent request without usable usage: known 0, unknown [0, W(P_bound) + O] (conditional)", () => {
    const acc = accountRequestCost({ ...base, price });
    const hi = (P_BOUND_TOKENS * 3.75 + 15) / 1e6;
    expect(acc.knownUsd).toBe(0);
    expect(acc.unknownUsd![0]).toBe(0);
    expect(acc.unknownUsd![1]).toBeCloseTo(hi, 12);
    expect(acc.unknownItems).toEqual(["all×1"]);
    const invalid: UsageReading = {
      cacheEvidence: { kind: "invalid", reason: "negative" },
      billing: { kind: "unknown", items: ["all"] },
    };
    expect(accountRequestCost({ ...base, price, reading: invalid }).unknownItems).toEqual(["all×1"]);
  });

  it("a request that never reached the base fetch costs nothing", () => {
    expect(accountRequestCost({ ...base, price, sent: false })).toEqual(ZERO_COST);
  });

  it("unpriced route ⇒ knownUsd/unknownUsd null", () => {
    const acc = accountRequestCost({ ...base, price: undefined, reading: valid({ P: 100, C: 0, W: 100 }, ["output"]) });
    expect(acc.knownUsd).toBeNull();
    expect(acc.unknownUsd).toBeNull();
  });

  it("sums per run: known adds up, ranges add up, item counts merge", () => {
    const a = accountRequestCost({ ...base, price, reading: valid({ P: 15_000, C: 0, W: 15_000 }, ["output"]) });
    const b = accountRequestCost({ ...base, price, reading: valid({ P: 15_000, C: 15_000, W: 0 }, ["output"]) });
    const lost = accountRequestCost({ ...base, price });
    const total = sumCosts([a, b, lost, ZERO_COST]);
    expect(total.knownUsd).toBeCloseTo(a.knownUsd! + b.knownUsd!, 12);
    expect(total.unknownUsd![1]).toBeCloseTo(a.unknownUsd![1] + b.unknownUsd![1] + lost.unknownUsd![1], 12);
    expect([...total.unknownItems].sort()).toEqual(["all×1", "output×2"]);
    expect(sumCosts([])).toEqual(ZERO_COST);
    // any unpriced component poisons the total (not a silent undercount)
    const unpriced = accountRequestCost({ ...base, price: undefined, reading: valid({ P: 100, C: 0, W: 100 }) });
    expect(sumCosts([a, unpriced]).knownUsd).toBeNull();
    expect(sumCosts([a, unpriced]).unknownUsd).toBeNull();
  });

  it("report wording: 'known ≈ $x; unreported components $lo–$hi (N items)'", () => {
    const a = accountRequestCost({ ...base, price, reading: valid({ P: 15_000, C: 0, W: 15_000 }, ["output"]) });
    const line = formatCost(sumCosts([a, a]));
    expect(line).toMatch(/^known ≈ \$0\.1125; unreported components \$0\.0000–\$0\.0000 \(2 items\)$/);
    expect(formatCost({ knownUsd: null, unknownUsd: null, unknownItems: [] })).toBe("cost unknown (unpriced route)");
    expect(line).not.toMatch(/actual/i);
  });
});
