/**
 * Burn-rate forecast (quota-plan §3.3 / D5): per-(provider, scope) sample ring
 * + first/last-slope ETA prediction + window-reset detection.
 * Zero pi imports — pure functions only; the ring lives in memory (cross-restart
 * slopes are meaningless, so nothing is persisted).
 *
 *   window 3h / min 2 samples / min span 5min / first↔last slope
 *   reset detection: drop >= QUOTA_HYSTERESIS_PCT vs the previous newest sample
 *   ⇒ the ring restarts with just the new sample (cross-reset slope is garbage).
 */

import type { Millis } from "../core/types.js";
import { QUOTA_HYSTERESIS_PCT } from "./ladder.js";

export interface BurnSample {
  readonly at: Millis;
  readonly usedPct: number;
}

export interface ForecastOptions {
  readonly windowMs: Millis; // 默认 FORECAST_WINDOW_MS
  readonly minSpanMs: Millis; // 默认 FORECAST_MIN_SPAN_MS
  readonly minSamples: number; // 默认 2
  readonly maxSamples: number; // 默认 32
}

export const FORECAST_WINDOW_MS = 10_800_000; // 3h
export const FORECAST_MIN_SPAN_MS = 300_000; // 5min

export const DEFAULT_FORECAST_OPTIONS: ForecastOptions = {
  windowMs: FORECAST_WINDOW_MS,
  minSpanMs: FORECAST_MIN_SPAN_MS,
  minSamples: 2,
  maxSamples: 32,
};

export interface ForecastResult {
  readonly etaMs?: Millis | undefined;
  readonly burnPctPerHour?: number | undefined;
  readonly samples: number;
  readonly skipped?: "too-few" | "too-short" | "not-burning" | undefined;
}

function resolve(options: Partial<ForecastOptions> | undefined): ForecastOptions {
  return { ...DEFAULT_FORECAST_OPTIONS, ...options };
}

/**
 * 追加一个样本并返回**新数组**（纯函数，不原地改）；检测到重置则只保留新样本。
 * 输入环假定按 `at` 升序（由本函数逐次构造保证）。
 */
export function pushSample(
  ring: readonly BurnSample[],
  sample: BurnSample,
  options?: Partial<ForecastOptions>,
): readonly BurnSample[] {
  const opts = resolve(options);
  const prev = ring.length > 0 ? ring[ring.length - 1] : undefined;
  if (prev !== undefined && sample.usedPct <= prev.usedPct - QUOTA_HYSTERESIS_PCT) {
    return [sample];
  }
  // Window prune relative to the new sample's timestamp (the natural "now"):
  // drop `at < sample.at - windowMs`.
  const cutoff = sample.at - opts.windowMs;
  const kept = ring.filter((s) => s.at >= cutoff);
  const next = [...kept, sample];
  return next.length > opts.maxSamples ? next.slice(next.length - opts.maxSamples) : next;
}

/** 首末斜率预测（D5）。可测试性压倒精度——两点即可手算期望 ETA；最小二乘留作未来优化。 */
export function forecast(ring: readonly BurnSample[], now: Millis, options?: Partial<ForecastOptions>): ForecastResult {
  const opts = resolve(options);
  const cutoff = now - opts.windowMs;
  const sorted = ring
    .filter((s) => s.at >= cutoff)
    .slice()
    .sort((a, b) => a.at - b.at);
  if (sorted.length < opts.minSamples) return { samples: sorted.length, skipped: "too-few" };
  const oldest = sorted[0] as BurnSample;
  const newest = sorted[sorted.length - 1] as BurnSample;
  const spanMs = newest.at - oldest.at;
  if (spanMs < opts.minSpanMs) return { samples: sorted.length, skipped: "too-short" };
  const burnPctPerMs = (newest.usedPct - oldest.usedPct) / spanMs;
  if (!(burnPctPerMs > 0)) return { samples: sorted.length, skipped: "not-burning" };
  return {
    etaMs: (100 - newest.usedPct) / burnPctPerMs,
    burnPctPerHour: burnPctPerMs * 3_600_000,
    samples: sorted.length,
  };
}
