/** Hint message custom type. */
export const COMPACT_HINT_CUSTOM_TYPE = "subagent:compact-hint";
/** Default raw threshold setting. */
export const DEFAULT_HINT_THRESHOLD_PERCENT = 75;
/** Minimum interval between hints. */
export const COMPACT_HINT_COOLDOWN_MS = 600_000;
/** pi's built-in reserveTokens fallback. */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;
/** Default raw threshold for forced compaction. */
export const DEFAULT_FORCE_THRESHOLD_PERCENT = 88;
/** Usage-tick message custom type (lightweight stepped usage reports, no action urged). */
export const USAGE_TICK_CUSTOM_TYPE = "subagent:usage-tick";
/** Default step between usage-tick reports. 0 disables ticks. */
export const DEFAULT_USAGE_TICK_STEP_PERCENT = 10;
/** Drop (in percent points) below the last tick step that re-arms the latch.
 *  Distinguishes a real context drop (compaction) from boundary wobble. */
export const USAGE_TICK_HYSTERESIS_PERCENT = 5;

/** Current tick step for a usage percent: multiples of `step` (0 below the
 *  first step, so ticks start at `step`% itself). Ticks never fire at/above
 *  `ceiling` — the force-compaction zone owns that range. */
export function usageTickStep(percent: number, step: number, ceiling: number): number {
  if (step <= 0 || percent >= ceiling) return 0;
  return Math.floor(percent / step) * step;
}

export function buildUsageTickText(percent: number, hintCeiling: number): string {
  const hintLine =
    hintCeiling > 0 && hintCeiling <= 100
      ? percent >= hintCeiling
        ? `已超过提醒阈值 ${hintCeiling}%；如果你正在收尾一个子任务，请尽快调用 compact_context。`
        : `达到 ${hintCeiling}% 时会再提醒你考虑 compact_context；现在无需操作。`
      : "现在无需操作。";
  return `[pi-subagent 上下文通报] 上下文已使用约 ${Math.round(percent)}%。${hintLine}`;
}

export function maxThresholdPercent(contextWindow: number, reserveTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(0, Math.floor(((contextWindow - reserveTokens) / contextWindow) * 100));
}

export function effectiveThresholdPercent(
  thresholdPercent: number,
  contextWindow: number,
  reserveTokens: number,
): number {
  if (thresholdPercent <= 0) return 0;
  return Math.min(thresholdPercent, maxThresholdPercent(contextWindow, reserveTokens));
}

/** Combined trigger line in absolute tokens (0 = no line): the min of the
 *  percent-derived line (needs a known window) and the absolute line
 *  (`tokensK` is in units of k, i.e. `tokensK * 1000` tokens). The absolute
 *  line auto-disables when it strictly exceeds the context window. Exported
 *  for the set_compact_threshold tool's cross-validation. */
export function thresholdLineTokens(
  thresholdPercent: number,
  thresholdTokensK: number,
  contextWindow?: number,
): number {
  const lines: number[] = [];
  if (thresholdPercent > 0 && contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0)
    lines.push(Math.floor((thresholdPercent / 100) * contextWindow));
  if (thresholdTokensK > 0 && (contextWindow === undefined || !tokenLineExceedsWindow(thresholdTokensK, contextWindow)))
    lines.push(Math.floor(thresholdTokensK * 1000));
  return lines.length === 0 ? 0 : Math.min(...lines);
}

/** An absolute token line (unit k) auto-disables when it STRICTLY exceeds the
 *  context window — a line the context can never reach. Distinct from the
 *  reserve clamp: a line <= window but > (window − reserve) still applies via
 *  clamping; only > window drops out entirely. */
export function tokenLineExceedsWindow(thresholdTokensK: number, contextWindow: number): boolean {
  return Number.isFinite(contextWindow) && contextWindow > 0 && thresholdTokensK * 1000 > contextWindow;
}

/** Absolute-token-aware threshold: combines a percent threshold with an
 *  absolute token threshold (unit k) — whichever fires first (min in token
 *  space) wins — then clamps to the dynamic reserve cap and converts back to
 *  the percent coordinate (floor) used by the hook/ticks. The absolute line
 *  auto-disables when `tokensK * 1000 > contextWindow` (strictly). With
 *  `thresholdTokensK <= 0` (or auto-disabled) this degenerates exactly to
 *  `effectiveThresholdPercent` (floor distributes over min, so the
 *  percent-only path is bit-identical); with `thresholdPercent <= 0` the
 *  absolute line alone decides. */
export function effectiveThresholdPercentWithTokens(
  thresholdPercent: number,
  thresholdTokensK: number,
  contextWindow: number,
  reserveTokens: number,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const tokenActive = thresholdTokensK > 0 && !tokenLineExceedsWindow(thresholdTokensK, contextWindow);
  if (thresholdPercent <= 0 && !tokenActive) return 0;
  let result = maxThresholdPercent(contextWindow, reserveTokens);
  if (thresholdPercent > 0) result = Math.min(result, thresholdPercent);
  if (tokenActive) result = Math.min(result, Math.floor(((thresholdTokensK * 1000) / contextWindow) * 100));
  return result;
}

export function buildCompactForceText(percent: number, forceAt: number): string {
  return (
    `[pi-subagent 上下文警告] 上下文已使用约 ${Math.round(percent)}%，达到强制阈值 ${forceAt}%，` +
    "正在强制压缩（通用摘要）；压缩不是终止，完成后会自动继续当前任务。"
  );
}

export function buildCompactHintText(percent: number, effective: number, forceAt = 0): string {
  const forceLine =
    forceAt > 0 ? `若用量继续涨至 ${forceAt}%，系统将强制压缩并使用通用摘要，你可能丢失想保留的细节；\n` : "";
  return (
    `[pi-subagent 上下文警告] 上下文已使用约 ${Math.round(percent)}%（阈值 ${effective}%）。\n\n` +
    "建议在当前子任务告一段落后调用 compact_context 主动压缩：\n" +
    "- 通过 instructions 参数写明必须保留的内容（当前目标、关键文件路径、未决决策、TODO），\n" +
    "  这是只有自主压缩才有的控制权；\n" +
    (forceAt > 0 ? `- ${forceLine}` : forceLine) +
    "- 压缩不是终止：压缩后你会带着摘要自动继续当前任务。"
  );
}
