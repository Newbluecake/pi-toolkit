/**
 * Frozen execution plan, cost estimate and cost accounting of `/cache-ttl measure` (measure-plan.md r4 §4). Pure and
 * pi-free. ONE `ExecutionPlan` is built per run; the estimate text, the confirm text, the runner's counters and the
 * tests all read it.
 *
 * Price contract (`MeasurePriceFn`, injected by the command): receives a {@link PriceTokens} breakdown, returns USD
 * priced like pi-ai `calculateCost` at the tier the TOTAL prompt (`input + cacheRead + cacheWrite`) falls into, and
 * `undefined` when a rate needed for a NON-zero token kind is missing/0. `cacheWrite1h` is the part of `cacheWrite`
 * billed at the 1-hour write rate. `W(n)` below is probed as "n tokens as cache write" first and falls back to
 * "n tokens as plain input" when the route has no cache-write price (§4.3).
 */

import {
  CHARS_PER_TOKEN,
  CONTEXT_ADMISSION_MARGIN_TOKENS,
  INJECTION_ALLOWANCE_TOKENS,
  MEASURE_TIMING,
  OUTPUT_CAP,
  PREFIX_CHARS,
  REQUEST_BUDGET,
  SLOT_COUNT,
  CONTROL_SLOT,
  TTL_GAPS_MS,
  type BillingItem,
  type CostAccount,
  type CostCondition,
  type CostEstimate,
  type CostRange,
  type ExecutionPlan,
  type MeasureApi,
  type MeasurePriceFn,
  type PlannedSlot,
  type PriceTokens,
  type RequestedRetention,
  type UsageReading,
} from "./measure-types.js";

// ---------------------------------------------------------------------------------------------------------------------
// Token figures
// ---------------------------------------------------------------------------------------------------------------------

export const CONDITIONS: readonly CostCondition[] = ["C1", "C2", "C3"];

/** §3.1/§4.3: `T_lo/T_mid/T_hi` = ceil(chars / {4, 2.5, 2.3}); `pBound = T_hi + INJECTION_ALLOWANCE`. */
export function tokenFigures(chars: number = PREFIX_CHARS): ExecutionPlan["tokens"] {
  const hi = Math.ceil(chars / CHARS_PER_TOKEN.hi);
  return {
    lo: Math.ceil(chars / CHARS_PER_TOKEN.lo),
    mid: Math.ceil(chars / CHARS_PER_TOKEN.mid),
    hi,
    pBound: hi + INJECTION_ALLOWANCE_TOKENS,
  };
}

/** §1 admission: `model.contextWindow ≥ P_bound + 2048`. Unknown/non-finite window ⇒ refuse (fail closed). */
export function contextWindowAdmits(contextWindow: number | undefined, pBound: number): boolean {
  return (
    typeof contextWindow === "number" &&
    Number.isFinite(contextWindow) &&
    contextWindow >= pBound + CONTEXT_ADMISSION_MARGIN_TOKENS
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------------------------------------

const zero = (): PriceTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

/** `W(n)`: n prompt tokens all billed as a write (cacheWrite price, else the input price); long Anthropic ⇒ 1h rate. */
export function writePrice(
  price: MeasurePriceFn,
  n: number,
  api: MeasureApi,
  retention: RequestedRetention,
): number | undefined {
  const long1h = api === "anthropic-messages" && retention === "long";
  const asWrite = price({ ...zero(), cacheWrite: n, ...(long1h ? { cacheWrite1h: n } : {}) });
  return asWrite ?? price({ ...zero(), input: n });
}

/** `R(n)`: n tokens read from cache. */
export const readPrice = (price: MeasurePriceFn, n: number): number | undefined => price({ ...zero(), cacheRead: n });
/** `O`: `outputTokens` billed as output. */
export const outputPrice = (price: MeasurePriceFn, outputTokens: number): number | undefined =>
  price({ ...zero(), output: outputTokens });

const add = (...xs: Array<number | undefined>): number | undefined => {
  let sum = 0;
  for (const x of xs) {
    if (x === undefined) return undefined;
    sum += x;
  }
  return sum;
};

/**
 * §4.3: typical = `6·W(T_mid) + 7·R(T_mid) + 13·O` (all hits, one control, no boundary); conditional worst =
 * `17·(W(P_bound) + O)` priced at the tier `P_bound` falls into. Either figure is `null` when a needed rate is missing.
 */
export function estimateCost(
  price: MeasurePriceFn | undefined,
  api: MeasureApi,
  retention: RequestedRetention,
  tokens: ExecutionPlan["tokens"] = tokenFigures(),
): CostEstimate {
  const base = { pBound: tokens.pBound, requestCap: REQUEST_BUDGET.total, conditions: CONDITIONS };
  if (price === undefined) return { typicalUsd: null, conditionalWorstUsd: null, ...base };
  const O = outputPrice(price, OUTPUT_CAP[api]);
  const wMid = writePrice(price, tokens.mid, api, retention);
  const rMid = readPrice(price, tokens.mid);
  const wBound = writePrice(price, tokens.pBound, api, retention);
  const typical =
    wMid === undefined || rMid === undefined || O === undefined
      ? undefined
      : REQUEST_BUDGET.writes * wMid + 7 * rMid + 13 * O;
  const worst = wBound === undefined || O === undefined ? undefined : REQUEST_BUDGET.total * (wBound + O);
  return { typicalUsd: typical ?? null, conditionalWorstUsd: worst ?? null, ...base };
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------------------

export function buildExecutionPlan(input: {
  runId: string;
  api: MeasureApi;
  wireModel: string;
  requestedRetention: RequestedRetention;
  price?: MeasurePriceFn;
}): ExecutionPlan {
  const tokens = tokenFigures();
  const slots: PlannedSlot[] = Array.from({ length: SLOT_COUNT }, (_, slot) => ({
    slot,
    gapMs: TTL_GAPS_MS[slot]!,
    control: slot === CONTROL_SLOT,
  }));
  return {
    runId: input.runId,
    api: input.api,
    wireModel: input.wireModel,
    requestedRetention: input.requestedRetention,
    outputCap: OUTPUT_CAP[input.api],
    slots,
    budget: REQUEST_BUDGET,
    tokens,
    timing: MEASURE_TIMING,
    estimate: estimateCost(input.price, input.api, input.requestedRetention, tokens),
  };
}

const usd = (n: number | null): string => (n === null ? "unknown (unpriced route)" : `≈ $${n.toFixed(2)}`);

/** The printed estimate (`--estimate`, status and the confirm body): plan, hard cap, both cost figures. */
export function formatPlanLines(plan: ExecutionPlan): string[] {
  const gaps = plan.slots.map((s) => `${s.gapMs / 60_000}`).join("/");
  const b = plan.budget;
  return [
    `/cache-ttl measure · ${plan.api} · ${plan.wireModel} · retention ${plan.requestedRetention}`,
    `plan: ${plan.slots.length} prefixes (~${plan.tokens.mid} tokens each), gaps ${gaps} min, control read on the 61-min prefix; ` +
      `stops at the first clear miss, then ONE declared boundary renewal read (the only request after a miss)`,
    `hard request cap ${b.total} = ${b.writes} writes + ${b.replacements} replacement writes + ${b.controls} control reads + ` +
      `${b.probes} TTL probes + ${b.renewal} renewal read; max duration ${MEASURE_TIMING.hardDeadlineMs / 60_000} min`,
    `cost: typical ${usd(plan.estimate.typicalUsd)}; worst case ${usd(plan.estimate.conditionalWorstUsd)} ` +
      `ONLY IF ${plan.estimate.conditions.join(", ")} hold (C1 each prompt ≤ ${plan.estimate.pBound} tokens, ` +
      `C2 output ≤ ${plan.outputCap} token(s), C3 list prices without relay surcharge); a run stops when C1 or C2 breaks`,
  ];
}

/** Confirm dialog body (ruling 11 both figures, ruling 14 the declared renewal exception, §1 quit-loss wording). */
export function formatConfirmText(plan: ExecutionPlan): string {
  return [
    ...formatPlanLines(plan),
    "/reload, /new, /resume, fork or exit cancel the run; all progress since the last successful save may be lost — " +
      "in the extreme, the whole run",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Cost accounting (§4.3) — never "actual cost"
// ---------------------------------------------------------------------------------------------------------------------

export const ZERO_COST: CostAccount = { knownUsd: 0, unknownUsd: [0, 0], unknownItems: [] };

const ITEM_RE = /^(.+)×(\d+)$/;

function mergeItems(...lists: ReadonlyArray<readonly string[]>): string[] {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) {
      const m = ITEM_RE.exec(item);
      const name = m ? m[1]! : item;
      counts.set(name, (counts.get(name) ?? 0) + (m ? Number(m[2]) : 1));
    }
  }
  return [...counts].map(([name, n]) => `${name}×${n}`);
}

/** Sum accounts; any unpriced (`null`) component makes that total `null`. */
export function sumCosts(accounts: readonly CostAccount[]): CostAccount {
  let known: number | null = 0;
  let lo: number | null = 0;
  let hi: number | null = 0;
  for (const a of accounts) {
    known = known === null || a.knownUsd === null ? null : known + a.knownUsd;
    if (a.unknownUsd === null || lo === null || hi === null) {
      lo = null;
      hi = null;
    } else {
      lo += a.unknownUsd[0];
      hi += a.unknownUsd[1];
    }
  }
  return {
    knownUsd: known,
    unknownUsd: lo === null || hi === null ? null : [lo, hi],
    unknownItems: mergeItems(...accounts.map((a) => a.unknownItems)),
  };
}

export interface CostRequestInput {
  api: MeasureApi;
  requestedRetention: RequestedRetention;
  outputCap: number;
  /** `undefined` ⇒ the request was never sent (zero cost). */
  sent: boolean;
  reading?: UsageReading;
  price: MeasurePriceFn | undefined;
  pBound: number;
}

const rangeOf = (hi: number | undefined): CostRange | null => (hi === undefined ? null : [0, Math.max(0, hi)]);

/**
 * Per request: `knownUsd` = every component the provider reported (uncached input `P − C − W`, cached read `C`,
 * write `W` incl. the 1h part when the split is reported, output when reported), priced at THIS request's own tier;
 * `unknownUsd` = only the unreported components (output not observed ⇒ `[0, cap·out]`; Anthropic long without the 1h
 * split ⇒ `[0, W@1h − W@5m]`; OpenAI without `cache_write_tokens` ⇒ `[0, (cacheWrite − input)·(P − C)]`; a sent request
 * without any usage ⇒ `[0, W(P_bound) + O]`, conditional).
 */
export function accountRequestCost(input: CostRequestInput): CostAccount {
  if (!input.sent) return ZERO_COST;
  const { price, api, requestedRetention: retention } = input;
  if (price === undefined) {
    return { knownUsd: null, unknownUsd: null, unknownItems: unknownItemsOf(input.reading, true) };
  }
  const usage = input.reading?.cacheEvidence.kind === "valid" ? input.reading.usage : undefined;
  if (usage === undefined) {
    // sent but no usable usage at all: nothing known, the conditional bound is the unknown range
    const w = writePrice(price, input.pBound, api, retention);
    const o = outputPrice(price, input.outputCap);
    return {
      knownUsd: 0,
      unknownUsd: rangeOf(add(w, o)),
      unknownItems: ["all×1"],
    };
  }

  const W = usage.W ?? 0;
  const tokens: PriceTokens = {
    input: Math.max(0, usage.P - usage.C - W),
    cacheRead: usage.C,
    cacheWrite: W,
    ...(usage.W1h !== undefined ? { cacheWrite1h: usage.W1h } : {}),
    output: usage.output ?? 0,
  };
  const known = price(tokens);
  const items: BillingItem[] = input.reading?.billing.kind === "unknown" ? [...input.reading.billing.items] : [];
  let hi: number | undefined = 0;
  const addHi = (x: number | undefined) => {
    hi = hi === undefined || x === undefined ? undefined : hi + x;
  };
  for (const item of items) {
    if (item === "output") {
      addHi(outputPrice(price, input.outputCap));
    } else if (item === "write1h-split") {
      // known holds W at the short-write rate; the premium is the 1h rate on the same tokens
      const { cacheWrite1h: _reported, ...noSplit } = tokens;
      void _reported;
      const shortRate = price(noSplit);
      const longRate = price({ ...noSplit, cacheWrite1h: W });
      addHi(shortRate === undefined || longRate === undefined ? undefined : Math.max(0, longRate - shortRate));
    } else if (item === "write") {
      // OpenAI without cache_write_tokens: the uncached input is in `known` at the input price
      const uncached = Math.max(0, usage.P - usage.C);
      const asWrite = price({ ...zero(), cacheWrite: uncached });
      const asInput = price({ ...zero(), input: uncached });
      addHi(asWrite === undefined || asInput === undefined ? 0 : Math.max(0, asWrite - asInput));
    } else {
      const w = writePrice(price, input.pBound, api, retention);
      addHi(add(w, outputPrice(price, input.outputCap)));
    }
  }
  return {
    knownUsd: known ?? null,
    unknownUsd: rangeOf(hi),
    unknownItems: mergeItems(items.map((i) => `${i}×1`)),
  };
}

function unknownItemsOf(reading: UsageReading | undefined, sent: boolean): string[] {
  if (!sent) return [];
  if (reading?.billing.kind === "unknown") return mergeItems(reading.billing.items.map((i) => `${i}×1`));
  return reading === undefined ? ["all×1"] : [];
}

/** Display line: "known ≈ $x; unreported components $lo–$hi (N items)". */
export function formatCost(cost: CostAccount): string {
  if (cost.knownUsd === null) return "cost unknown (unpriced route)";
  const n = cost.unknownItems.reduce((s, i) => s + Number(ITEM_RE.exec(i)?.[2] ?? 1), 0);
  const range =
    cost.unknownUsd === null
      ? "unreported components unpriced"
      : `unreported components $${cost.unknownUsd[0].toFixed(4)}–$${cost.unknownUsd[1].toFixed(4)}`;
  return `known ≈ $${cost.knownUsd.toFixed(4)}; ${range} (${n} item${n === 1 ? "" : "s"})`;
}
