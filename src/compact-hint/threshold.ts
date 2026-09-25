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
/** Default (coarsest) step between usage-tick reports. 0 disables ticks. */
export const DEFAULT_USAGE_TICK_STEP_PERCENT = 10;
/** Drop (in percent points) below the last tick step that re-arms the latch.
 *  Distinguishes a real context drop (compaction) from boundary wobble. */
export const USAGE_TICK_HYSTERESIS_PERCENT = 5;
/** Reference window (tokens) at which a configured force anchor is taken
 *  literally; smaller windows scale the line up, larger ones down. */
export const FORCE_SCALE_REFERENCE_WINDOW = 1_000_000;
/** Percentage points the force line rises per decade of window shrinkage.
 *  Anchored on the default 88: 1M→88, 200k→91 (≈ pi's own reserve line),
 *  37k→95. Rationale: headroom should be a bounded absolute amount, so a
 *  small window must be allowed to run much closer to full. */
export const FORCE_SCALE_POINTS_PER_DECADE = 5;
/** Hard ceiling for a scaled force line; the reserve cap clamps further. */
export const FORCE_SCALE_MAX_PERCENT = 98;

/** Window-scaled force line: `anchorPercent` is the value for a
 *  FORCE_SCALE_REFERENCE_WINDOW-token window and rises by
 *  FORCE_SCALE_POINTS_PER_DECADE for every decade the real window is smaller
 *  (falls for larger ones). 0 (disabled) stays 0. The result is still subject
 *  to the reserve cap via `effectiveThresholdPercentWithTokens`, which is what
 *  keeps small windows below pi's own automatic line. */
export function windowScaledForcePercent(anchorPercent: number, contextWindow: number): number {
  if (anchorPercent <= 0) return 0;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return anchorPercent;
  const decades = Math.log10(FORCE_SCALE_REFERENCE_WINDOW / contextWindow);
  const scaled = Math.round(anchorPercent + FORCE_SCALE_POINTS_PER_DECADE * decades);
  return Math.min(FORCE_SCALE_MAX_PERCENT, Math.max(1, scaled));
}

/** Non-linear tick grid, ascending. Far from the ceiling the marks stay
 *  on the plain multiples of `step`; within two steps of the ceiling the grid
 *  densifies (step/2, then step/5 next to the line), so reporting frequency
 *  rises exactly as usage approaches the threshold. Marks never include 0
 *  or the ceiling itself (the force zone owns at/above it). */
export function usageTickMarks(step: number, ceiling: number): number[] {
  if (step <= 0 || !Number.isFinite(ceiling) || ceiling <= 0) return [];
  const fine = Math.max(1, Math.round(step / 5));
  const mid = Math.max(1, Math.round(step / 2));
  const nearFloor = ceiling - 2 * step;
  const marks: number[] = [];
  for (let mark = step; mark <= nearFloor && mark <= 100; mark += step) marks.push(mark);
  const near: number[] = [];
  let mark = ceiling;
  // Bounded: every delta is >= 1 and the ceiling is a percentage.
  for (let guard = 0; guard < 256 && mark > nearFloor; guard += 1) {
    const remaining = ceiling - mark;
    const delta = remaining < step ? fine : mid;
    mark -= delta;
    if (mark > nearFloor && mark >= step) near.push(mark);
  }
  return [...marks, ...near.reverse()];
}

/** Current tick step for a usage percent: the highest grid mark at or below
 *  `percent` (0 below the first mark). Ticks never fire at/above `ceiling` —
 *  the force-compaction zone owns that range. */
export function usageTickStep(percent: number, step: number, ceiling: number): number {
  if (step <= 0 || percent >= ceiling) return 0;
  const marks = usageTickMarks(step, ceiling);
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const mark = marks[i] as number;
    if (percent >= mark) return mark;
  }
  return 0;
}

/** hint/tick 文案里推荐的工具名：switch_context（模型自写交接）或 compact_context（通用摘要）。 */
export type CompactToolName = "switch_context" | "compact_context";

/**
 * 上下文通报文案（§10.1）：可选第 4 参 `marker`（动态阈值的英文短标记，如 `hint 41% · cost`）
 * 追加在文案尾部（空格分隔）。省略时输出与今天**逐字节相同**（mode !== "on" 时钩子永远省略）。
 */
export function buildUsageTickText(
  percent: number,
  hintCeiling: number,
  tool: CompactToolName = "compact_context",
  marker?: string,
): string {
  const hintLine =
    hintCeiling > 0 && hintCeiling <= 100
      ? percent >= hintCeiling
        ? `已超过提醒阈值 ${hintCeiling}%；如果你正在收尾一个子任务，请尽快调用 ${tool}。`
        : `达到 ${hintCeiling}% 时会再提醒你考虑 ${tool}；现在无需操作。`
      : "现在无需操作。";
  const markerSuffix = marker !== undefined && marker.length > 0 ? ` ${marker}` : "";
  return `[pi-subagent 上下文通报] 上下文已使用约 ${Math.round(percent)}%。${hintLine}${markerSuffix}`;
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

/**
 * 通用摘要压缩的 L1 提醒（§10.2）：可选第 4 参 `note`（动态阈值的中文单行说明，仅
 * basis ∈ {cost, tier, quota} 时非空）追加为末尾新行。省略时与今天逐字节相同。
 */
export function buildCompactHintText(percent: number, effective: number, forceAt = 0, note?: string): string {
  const forceLine =
    forceAt > 0 ? `若用量继续涨至 ${forceAt}%，系统将强制压缩并使用通用摘要，你可能丢失想保留的细节；\n` : "";
  return (
    `[pi-subagent 上下文警告] 上下文已使用约 ${Math.round(percent)}%（阈值 ${effective}%）。\n\n` +
    "建议在当前子任务告一段落后调用 compact_context 主动压缩：\n" +
    "- 通过 instructions 参数写明必须保留的内容（当前目标、关键文件路径、未决决策、TODO），\n" +
    "  这是只有自主压缩才有的控制权；\n" +
    (forceAt > 0 ? `- ${forceLine}` : forceLine) +
    "- 压缩不是终止：压缩后你会带着摘要自动继续当前任务。" +
    (note !== undefined && note.length > 0 ? `\n${note}` : "")
  );
}

/**
 * switch_context 模式的 L1 提示（替代 buildCompactHintText）：重点不是"去压缩"，
 * 而是"交接内容由你来写，写漏即永久丢失" —— 这是自主切换相对通用摘要的唯一优势，
 * 也是模型最容易敷衍的地方。可选第 4 参 `note` 同 buildCompactHintText（§10.2）。
 */
export function buildSwitchHintText(percent: number, effective: number, forceAt = 0, note?: string): string {
  const forceLine =
    forceAt > 0
      ? `- 若用量继续涨至 ${forceAt}%，系统会先硬性要求你切换；仍不照办就回落到通用摘要压缩，\n  届时保留什么由摘要模型决定，你会失去控制权；\n`
      : "";
  return (
    `[pi-subagent 上下文警告] 上下文已使用约 ${Math.round(percent)}%（阈值 ${effective}%）。\n\n` +
    "建议在当前子任务告一段落后调用 switch_context 主动切换上下文：\n" +
    "- 你在参数里写下的 goal / progress / next_steps / decisions / key_files 就是切换后的全部上下文，\n" +
    "  没有摘要模型替你补救——写全才不丢；\n" +
    forceLine +
    "- 切换不是终止：切换后你会带着自己写的交接内容自动继续当前任务。" +
    (note !== undefined && note.length > 0 ? `\n${note}` : "")
  );
}

/**
 * switch_context 模式的 L2 硬性要求（先礼后兵的"礼"）：越过强制线时先让模型自己交接，
 * 只有它不照办，下一轮才回落到 buildCompactForceText 的通用强制压缩。
 */
export function buildSwitchDemandText(percent: number, forceAt: number): string {
  return (
    `[pi-subagent 上下文警告] 上下文已使用约 ${Math.round(percent)}%，已达强制线 ${forceAt}%。\n\n` +
    "请在本回合内调用 switch_context 完成上下文切换（先把手头这一步收尾，不要开新工作）：\n" +
    "- 把目标、进展、下一步、已定决策、关键文件写进参数，这些就是切换后你能看到的全部内容；\n" +
    "- 如果本回合结束时仍未切换，系统将改为强制通用摘要压缩，保留什么将不再由你决定。"
  );
}

/**
 * How close (in percentage points) usage may get to the earliest active line before a
 * switch counts as imminent. At 5pp a 1M window leaves ~50k tokens of headroom — a few
 * turns at typical growth, one turn after a large file read.
 */
export const SWITCH_IMMINENT_MARGIN_PERCENT = 5;

/**
 * Whether the current prefix is about to be discarded by a context switch/compaction:
 * usage is within `margin` points of the earliest active line (the effective hint line or
 * the effective force line; a line <= 0 is off). The cache-ttl layer reads this to stop
 * investing in a prefix it would throw away (a 1h entry fee rewrites the whole prefix at
 * 2x input price right before switch_context drops it).
 */
export function isSwitchImminent(
  percent: number,
  effectiveHintPercent: number,
  effectiveForcePercent: number,
  margin = SWITCH_IMMINENT_MARGIN_PERCENT,
): boolean {
  if (!Number.isFinite(percent)) return false;
  const lines = [effectiveHintPercent, effectiveForcePercent].filter((line) => Number.isFinite(line) && line > 0);
  if (lines.length === 0) return false;
  return percent >= Math.min(...lines) - margin;
}
