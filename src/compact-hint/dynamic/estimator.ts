/**
 * compact-hint dynamic · g / σ / S0 / handoff 的不可变 EWMA（dynamic-threshold-plan.md §4）。
 *
 * P2-2：更新公式写死，**方差用旧均值**、clamp 只在读侧（threshold §3.4 第 5 步）、
 * round 只在渲染侧；所有更新函数返回新对象，不就地改。样本减半用 `Math.floor`。
 *
 * 样本纪律（§4.1）：
 * - `Δ = tokens − lastTokens`；`Δ <= 0` **丢弃**（压缩/切换的负跳变不是增长）；
 *   `Δ > 0.25·W` **截断**到 `0.25·W` 后入 EWMA；
 * - `session_compact` 后把 `lastTokens` 置 `undefined`，**丢弃压缩后的第一个 Δ**；
 * - 热身混合：`gSamples < G_WARMUP_SAMPLES` 时按 `G_PRIOR` 加权；`s0Samples === 0` 时用 S0 先验。
 *
 * 持久化（D9，§4.2）：条目类型 `subagent:compact-dynamic`，回读逐字段校验、
 * `version !== 2` 丢弃重来、任何异常 ⇒ 全新状态，**永不抛**（`parseEstimatorState`）。
 * 不做跨 session 共享：fork 出的新分支天然看不到旧分支条目。
 */

import {
  EWMA_ALPHA_G,
  EWMA_ALPHA_S0,
  G_PRIOR,
  G_WARMUP_SAMPLES,
  HANDOFF_PRIOR_TOKENS,
  s0PriorTokens,
} from "./threshold.js";
import type { GrowthEstimate, StartEstimate } from "./types.js";

export interface EstimatorState {
  readonly gMean: number;
  readonly gVar: number;
  readonly gSamples: number;
  readonly s0Mean: number;
  readonly s0Samples: number;
  readonly handoffMean: number;
  readonly handoffSamples: number;
  readonly lastTokens: number | undefined;
  readonly modelEpoch: number;
  readonly modelFingerprint: string;
  readonly version: 2;
}

/** 初始指纹：空串永不等于任何算出的指纹（真实指纹含 "|" 分隔符）。 */
export const INITIAL_MODEL_FINGERPRINT = "";

export function createEstimatorState(): EstimatorState {
  return {
    gMean: G_PRIOR,
    gVar: 0,
    gSamples: 0,
    s0Mean: 0,
    s0Samples: 0,
    handoffMean: HANDOFF_PRIOR_TOKENS,
    handoffSamples: 0,
    lastTokens: undefined,
    modelEpoch: 0,
    modelFingerprint: INITIAL_MODEL_FINGERPRINT,
    version: 2,
  };
}

// ---------------------------------------------------------------------------
// 不可变 EWMA 更新（P2-2）
// ---------------------------------------------------------------------------

/** `delta` 基于旧均值；`var_new = (1 − α)·(var_old + α·delta²)`。 */
function updateEwma(meanOld: number, varOld: number, alpha: number, x: number): { mean: number; variance: number } {
  const delta = x - meanOld; // 方差用旧均值（P2-2）
  const mean = meanOld + alpha * delta;
  const variance = (1 - alpha) * (varOld + alpha * delta * delta);
  return { mean, variance };
}

function sigmaOf(variance: number): number {
  return Math.sqrt(Math.max(0, variance));
}

/**
 * 观测一轮上下文增长。压缩边界后的首个观测只记录 `lastTokens`、不入 EWMA；
 * `Δ <= 0` 丢弃（不入 EWMA）；`Δ > 0.25·W` 截断。被丢弃/截断的观测仍推进
 * `lastTokens`，使每个 Δ 都保持「每轮增量」口径（负跳变不会被合并进后续 Δ）。
 */
export function observeGrowth(state: EstimatorState, tokens: number, window: number): EstimatorState {
  if (!Number.isFinite(tokens) || tokens < 0) return state;
  const last = state.lastTokens;
  if (last === undefined) {
    // 压缩后首个 Δ 丢弃（§4.1）：先立基准
    return { ...state, lastTokens: tokens };
  }
  let delta = tokens - last;
  const truncateAt = Number.isFinite(window) && window > 0 ? 0.25 * window : Number.POSITIVE_INFINITY;
  if (delta > truncateAt) delta = truncateAt;
  const base: EstimatorState = { ...state, lastTokens: tokens };
  if (!(delta > 0)) return base; // Δ <= 0 丢弃
  const { mean, variance } = updateEwma(state.gMean, state.gVar, EWMA_ALPHA_G, delta);
  return { ...base, gMean: mean, gVar: variance, gSamples: state.gSamples + 1 };
}

/** `session_compact` 边界：丢弃 `lastTokens` 基准（压缩后的第一个 Δ 随之被丢）。 */
export function noteCompactBoundary(state: EstimatorState): EstimatorState {
  return { ...state, lastTokens: undefined };
}

/** 观测一次切换后起点 S0（§5.5 的观察窗关闭时喂 `firstContextTokens`）。只更新均值（§4.1 状态只带 gVar）。 */
export function observeRestart(state: EstimatorState, s0Tokens: number): EstimatorState {
  if (!Number.isFinite(s0Tokens) || s0Tokens < 0) return state;
  const { mean } = updateEwma(state.s0Mean, 0, EWMA_ALPHA_S0, s0Tokens);
  return { ...state, s0Mean: mean, s0Samples: state.s0Samples + 1 };
}

/** 观测一次交接长度（token）——交接长度是模型写作习惯，epoch 翻转只做样本减半（§4.3）。 */
export function observeHandoff(state: EstimatorState, tokens: number): EstimatorState {
  if (!Number.isFinite(tokens) || tokens < 0) return state;
  // α 同 S0：样本同样只来自真实切换、稀少故更快（EWMA_ALPHA_S0 的推导口径，§3.5）
  const { mean } = updateEwma(state.handoffMean, 0, EWMA_ALPHA_S0, tokens);
  return { ...state, handoffMean: mean, handoffSamples: state.handoffSamples + 1 };
}

// ---------------------------------------------------------------------------
// 读侧导出（先验混合在此做；clamp 仍留给 threshold §3.4 第 5 步）
// ---------------------------------------------------------------------------

/** 热身混合：`gSamples < 8` 时 `(n·gMean + (8−n)·G_PRIOR) / 8`。 */
export function growthEstimate(state: EstimatorState): GrowthEstimate {
  const sigma = sigmaOf(state.gVar);
  if (state.gSamples < G_WARMUP_SAMPLES) {
    const mixed = (state.gSamples * state.gMean + (G_WARMUP_SAMPLES - state.gSamples) * G_PRIOR) / G_WARMUP_SAMPLES;
    return { g: mixed, sigma, samples: state.gSamples };
  }
  return { g: state.gMean, sigma, samples: state.gSamples };
}

/** `s0Samples === 0` ⇒ S0 先验（min(10%·W, 100k)，§3.5）。 */
export function startEstimate(state: EstimatorState, window: number): StartEstimate {
  if (state.s0Samples <= 0) return { s0: s0PriorTokens(window), samples: state.s0Samples };
  return { s0: state.s0Mean, samples: state.s0Samples };
}

export interface HandoffEstimate {
  tokens: number;
  samples: number;
}

/** `handoffSamples === 0` ⇒ HANDOFF_PRIOR_TOKENS。 */
export function handoffEstimate(state: EstimatorState): HandoffEstimate {
  if (state.handoffSamples <= 0) return { tokens: HANDOFF_PRIOR_TOKENS, samples: state.handoffSamples };
  return { tokens: state.handoffMean, samples: state.handoffSamples };
}

// ---------------------------------------------------------------------------
// §4.3 模型 epoch（P1-7）
// ---------------------------------------------------------------------------

export interface ModelFingerprintParts {
  provider: string | undefined;
  id: string | undefined;
  api: string | undefined;
  baseUrl: string | undefined;
  contextWindow: number | undefined;
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
  tiers: readonly { inputTokensAbove: number; cacheRead: number }[] | undefined;
}

function fingerprintField(value: string | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/** 指纹 = provider|id|api|baseUrl|contextWindow|input/output/cacheRead/cacheWrite|tiers（读不到记 "unknown"）。 */
export function modelFingerprint(parts: ModelFingerprintParts): string {
  const rates = parts.rates;
  const ratesText =
    rates !== undefined && Number.isFinite(rates.input)
      ? `${rates.input}/${rates.output}/${rates.cacheRead}/${rates.cacheWrite}`
      : "unknown";
  const tiersText =
    parts.tiers !== undefined ? parts.tiers.map((t) => `${t.inputTokensAbove}:${t.cacheRead}`).join(",") : "unknown";
  return [
    fingerprintField(parts.provider),
    fingerprintField(parts.id),
    fingerprintField(parts.api),
    fingerprintField(parts.baseUrl),
    parts.contextWindow !== undefined && Number.isFinite(parts.contextWindow) ? String(parts.contextWindow) : "unknown",
    ratesText,
    tiersText,
  ].join("|");
}

/**
 * epoch 翻转处置（§4.3 表）：`published` 的清空在 wire 层（published 不在本状态内）。
 * g/σ 值保留、样本减半（floor）；S0 清空回先验；handoff 值保留、样本减半。
 * 窗口变化已含在指纹里（换窗口 = 换 epoch）。
 */
export function decayEstimator(state: EstimatorState, newFingerprint: string, window: number): EstimatorState {
  return {
    ...state,
    gSamples: Math.floor(state.gSamples / 2),
    s0Mean: s0PriorTokens(window),
    s0Samples: 0,
    handoffSamples: Math.floor(state.handoffSamples / 2),
    modelEpoch: state.modelEpoch + 1,
    modelFingerprint: newFingerprint,
  };
}

/** 指纹未变 ⇒ 原样返回；变化 ⇒ `decayEstimator`（`model_select` 或每轮 turn_end 兜底比对用）。 */
export function advanceModelFingerprint(state: EstimatorState, fingerprint: string, window: number): EstimatorState {
  return fingerprint === state.modelFingerprint ? state : decayEstimator(state, fingerprint, window);
}

// ---------------------------------------------------------------------------
// §4.2 序列化 / 回读（永不抛）
// ---------------------------------------------------------------------------

export function serializeEstimatorState(state: EstimatorState): string {
  return JSON.stringify(state);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  const parsed = finiteNonNegative(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

/**
 * 回读（§4.2）：`version !== 2` ⇒ 丢弃重来；逐字段校验（非有限/负数 ⇒ 取先验，
 * mean 失效时对应 samples 一并归 0）；任何形状异常 ⇒ 全新状态。**永不抛。**
 */
export function parseEstimatorState(raw: unknown, window: number): EstimatorState {
  const fresh = createEstimatorState();
  if (typeof raw !== "object" || raw === null) return fresh;
  const record = raw as Record<string, unknown>;
  if (record.version !== 2) return fresh;

  const gMean = finiteNonNegative(record.gMean);
  let gSamples = nonNegativeInt(record.gSamples) ?? 0;
  if (gMean === undefined) gSamples = 0;
  const s0Mean = finiteNonNegative(record.s0Mean);
  let s0Samples = nonNegativeInt(record.s0Samples) ?? 0;
  if (s0Mean === undefined) s0Samples = 0;
  const handoffMean = finiteNonNegative(record.handoffMean);
  let handoffSamples = nonNegativeInt(record.handoffSamples) ?? 0;
  if (handoffMean === undefined) handoffSamples = 0;

  return {
    gMean: gMean ?? G_PRIOR,
    gVar: finiteNonNegative(record.gVar) ?? 0,
    gSamples,
    s0Mean: s0Mean ?? s0PriorTokens(window),
    s0Samples,
    handoffMean: handoffMean ?? HANDOFF_PRIOR_TOKENS,
    handoffSamples,
    lastTokens: finiteNonNegative(record.lastTokens),
    modelEpoch: nonNegativeInt(record.modelEpoch) ?? 0,
    modelFingerprint: typeof record.modelFingerprint === "string" ? record.modelFingerprint : INITIAL_MODEL_FINGERPRINT,
    version: 2,
  };
}
