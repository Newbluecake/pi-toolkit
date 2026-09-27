// §7.1 tidy cost estimation (dispatch-time upper bound + cap-watcher wiring)
// — STUB (todo #22 P0-b's frozen-surface commit; real implementation lands
// in package P4, §14.1).

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

/** Not implemented yet (P4). Pure function — §7.1's `est` formula. */
export function estimateTidyUsd(_input: EstimateTidyUsdInput): number {
  throw new Error("estimateTidyUsd: not implemented yet (todo #22 P4)");
}
