// §7.1 tidy cost estimation (dispatch-time upper bound + cap-watcher wiring)
// — todo #22 P4. Pure functions only; the actual cap watcher during a run
// reuses `../../consult/watcher.js`'s `createCapWatcher` (§7.1: "复用
// createCapWatcher"), wired from `command.ts`.

export interface TidyCostRates {
  input: number; // USD / 1M tokens
  output: number;
  cacheWrite?: number;
}

export interface EstimateTidyUsdInput {
  promptBytes: number;
  maxOutputBytes: number;
  rates: TidyCostRates;
}

/**
 * §7.1's dispatch-time upper-bound formula (same 2 B/token conservative
 * estimate `estimateFirstRequestUsd` uses elsewhere):
 *
 *   inTok  = ceil(promptBytes / 2)
 *   outTok = ceil(min(maxOutputBytes, 1.25 × promptBytes + 4096) / 2) + 2048
 *   est    = (inTok × max(rates.input, rates.cacheWrite) + outTok × rates.output) / 1e6
 */
export function estimateTidyUsd(input: EstimateTidyUsdInput): number {
  const { promptBytes, maxOutputBytes, rates } = input;
  const inTok = Math.ceil(promptBytes / 2);
  const outTok = Math.ceil(Math.min(maxOutputBytes, 1.25 * promptBytes + 4096) / 2) + 2048;
  const inputRate = Math.max(rates.input, rates.cacheWrite ?? 0);
  return (inTok * inputRate + outTok * rates.output) / 1e6;
}

/** §7.1's N1: `input > 0 || output > 0` ⇒ priced; otherwise the model has
 *  no cost info and tidy runs with "no cost guarantee" instead of a cost
 *  gate. */
export function isPricedRates(rates: TidyCostRates): boolean {
  return rates.input > 0 || rates.output > 0;
}

/** Structural shape of `Model.cost` (pi-ai's `ModelCost`) — kept structural
 *  (not imported from pi-ai) so this file stays pi-free and independently
 *  testable; `command.ts` passes `ctx.model?.cost` straight through, which
 *  satisfies this shape. */
export interface ModelCostLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: readonly { inputTokensAbove: number; input: number; output: number; cacheWrite: number }[];
}

/** Same request-wide tiered-pricing selection `src/stack.ts`'s `priceOf`
 *  uses for consult (review-3 #7①: the highest tier whose `inputTokensAbove`
 *  the estimate exceeds applies to the FULL request) — reimplemented here
 *  (not imported) because `src/stack.ts` is P0/P5-owned wiring, not a shared
 *  export; the algorithm itself is copied byte-for-byte on purpose so the
 *  two call sites can never silently diverge. */
export function tidyRatesFromModelCost(cost: ModelCostLike, contextTokens: number): TidyCostRates {
  const tier =
    [...(cost.tiers ?? [])]
      .filter((t) => contextTokens > t.inputTokensAbove)
      .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? cost;
  return { input: tier.input, output: tier.output, cacheWrite: tier.cacheWrite };
}
