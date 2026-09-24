/**
 * compact-hint dynamic · D3 接线层（dynamic-threshold-plan.md §2/§4/§5/§8/§9/§10.3）。
 *
 * 本模块是动态阈值子系统的**唯一 pi-facing 装配**（`usage-range.ts` duck type、
 * `telemetry-store.ts` 只用 node fs、D1 六模块零 pi import 的分层纪律不变）：
 * - `wireDynamicThreshold` 构造 `DynamicRuntime`：全部可变状态在闭包内（无模块级可变状态），
 *   **不创建任何 timer**（T-D3-NO-TIMER），一切推进都挂在既有 turn_end / pi 事件上；
 * - 惰性（P1-5/R2-3）：构造期 `mode === "print" || mode === "json"`（与 `src/stack.ts` 既有
 *   早退**逐字一致**）⇒ 惰性 runtime（方法全 no-op、`statusView()` 返回 undefined）；
 *   此外每个 handler 内部再判一次同一条件（同一个 ctx 可能在 /reload 后语义变化）；
 *   RPC 驱动的主会话 mode 既非 print 也非 json，照常运行；
 * - 生命周期（P1-4）：`dispose()` 只做 flush（遥测观察窗按实际值 + 估计量落盘）与拒绝后续
 *   写入，接入 `session_shutdown` 与 `session_start` 防御性清理（见 index.ts），幂等；
 * - 估计量持久化（D9/§4.2）：`subagent:compact-dynamic` 条目（appendEntry）+ `getBranch()`
 *   倒序回读；写节流 = EWMA 相对上次落盘变化 >10% 或距上次 ≥20 轮，dispose flush 一次；
 * - 遥测（§5）：D2 的 tracker/store 直接复用；marker 建立与清除的全部路径见 §5.4；
 * - 退化阶梯第 7 行（§8.1）：纯函数抛异常 ⇒ 一次性 warn + 本会话禁用（internal-error）。
 */

import {
  advanceModelFingerprint,
  createEstimatorState,
  growthEstimate,
  handoffEstimate,
  modelFingerprint,
  observeGrowth,
  observeHandoff,
  observeRestart,
  parseEstimatorState,
  startEstimate,
  noteCompactBoundary,
  type EstimatorState,
  type ModelFingerprintParts,
} from "./estimator.js";
import { buildPriceModel, readRateAt } from "./pricing.js";
import {
  computeDynamicThreshold,
  PUBLISH_DEADBAND_PCT,
  resolveSubscriptionPressure,
  tierMarginTokens,
  type ForceLines,
  type PublishedLine,
  type StaticHintLines,
  type SubscriptionStateInput,
  type SubscriptionVerdictLike,
} from "./threshold.js";
import { effectiveThresholdPercentWithTokens, windowScaledForcePercent } from "../threshold.js";
import {
  createSwitchTelemetryTracker,
  type SessionCompactEventView,
  type SwitchTelemetryRecord,
  type TelemetrySnapshot,
} from "./telemetry.js";
import { createTelemetryStore, type SwitchTelemetryStore } from "./telemetry-store.js";
import type { BranchCtxLike } from "./usage-range.js";
import type { DynamicConfig, DynamicThresholdOutcome, PriceModel } from "./types.js";

// ---------------------------------------------------------------------------
// 常量（§2.2 写节流；§4.1 handoff token 换算）
// ---------------------------------------------------------------------------

/** 估计量落盘节流：EWMA 相对上次落盘变化超过此比例 ⇒ 立即落盘。 */
const PERSIST_CHANGE_FRACTION = 0.1;
/** 估计量落盘节流：距上次落盘的轮数上限。 */
const PERSIST_EVERY_TURNS = 20;
/** 估计量持久化条目类型（§4.2）。 */
export const COMPACT_DYNAMIC_ENTRY_TYPE = "subagent:compact-dynamic";
/**
 * onApplied 的 `chars` → token 近似（§4.1 handoff EWMA 的观测源只有字符数；交接以英文
 * 代码标识符/路径为主，≈4 chars/token）。先验 2000 token 对应实测 4191–8493 字符。
 */
const HANDOFF_CHARS_PER_TOKEN = 4;

/** R2-3：与 `src/stack.ts` 的既有早退**逐字一致**（不能写成 `mode !== "tui"`——RPC 主会话会被误杀）。 */
export function isLazyMode(mode: unknown): boolean {
  return mode === "print" || mode === "json";
}

// ---------------------------------------------------------------------------
// §10.3 只读状态视图（P1-11：不暴露内部可变对象；status/tool 经端口转发读取）
// ---------------------------------------------------------------------------

export interface DynamicStatusView {
  readonly mode: "off" | "shadow" | "on";
  readonly usable: boolean;
  readonly degradeReason: string | null;
  readonly hintPercent: number | null;
  readonly basis: string | null;
  readonly lowerBoundPercent: number | null;
  readonly capPercent: number | null;
  readonly cStarPercent: number | null;
  readonly g: number | null;
  readonly sigma: number | null;
  readonly s0: number | null;
  readonly rUsd: number;
  readonly rEquivalentTurns: number | null;
  readonly priceReadPerM: number | null;
  readonly priceWritePerM: number | null;
  /** 输出单价（§10.3 渲染行的 out 段；方案接口未列但渲染示例要求，见施工报告）。 */
  readonly priceOutputPerM: number | null;
  readonly writePricingApproximate: boolean;
  readonly subscriptionPressure: number | null;
  readonly telemetryCount: number;
  readonly telemetryPath: string | null;
}

// ---------------------------------------------------------------------------
// 输入形状（duck type，零 pi import）
// ---------------------------------------------------------------------------

/** pi `Model` 的结构化子集（只取指纹与价格需要的字段）。 */
export interface DynamicModelLike {
  provider?: unknown;
  id?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  contextWindow?: unknown;
  cost?: unknown;
}

export interface DynamicTurnInput {
  /** 事件时点的 ctx（mode 供 handler 内二次判惰性；sessionManager 供 §5.5 观察窗聚合）。 */
  ctx: { mode?: unknown; sessionManager?: unknown };
  /** 事件时点的 ctx.model。 */
  model: DynamicModelLike | undefined;
  /** `ctx.getContextUsage()` 的结构化子集。 */
  usage: { tokens: number | null; percent: number | null; contextWindow: number };
  /** 当前静态 hint 线（set_compact_threshold 可能在会话中改写）。 */
  staticHint: StaticHintLines;
  /** 当前 force 配置（forceScaling=false 时由 wire 预解析成 D1 的锚点形状，见 forceLinesOf）。 */
  force: { atPercent: number; atTokensK: number; forceScaling: boolean };
  reserveTokens: number;
}

export interface DynamicRuntime {
  readonly mode: "off" | "shadow" | "on";
  /** 惰性（print/json 构造）/已 dispose/内部禁用 ⇒ false；钩子据此完全跳过动态路径。 */
  readonly active: boolean;
  /** compact-hint 钩子每轮 turn_end：重算动态线 + 观测 g + 指纹兜底比对 + 观察窗推进。惰性 ⇒ 不重算。 */
  onTurnEnd(input: DynamicTurnInput): DynamicThresholdOutcome;
  /** §9.2 hintEpoch（「一次高位期」编号；mode !== "on" 恒 0，判定表达式与今天等价）。 */
  hintEpoch(): number;
  /** §9.2 真实回落 ⇒ hintEpoch + 1（提醒权重置的唯一来源）。 */
  noteRealDrop(): void;
  /** §6.3 跨档票：usedTokens ∈ [B − TIER_MARGIN, B] 且该 B 本会话未提醒过 ⇒ 消费一张返回 true。 */
  consumeTierTicket(usedTokens: number | null): boolean;
  // ── §5.4 marker 面（index.ts 注入）──────────────────────────────────────
  /** switch hook 的 `onApplied` 开火（R2-1 唯一因果信号）⇒ 建立 handoffMarker + handoff EWMA 观测。 */
  noteHandoffApplied(info: { seq: number; keepRecent?: boolean; chars?: number; reason?: string }): void;
  /** wire 自己发出 force 压缩 / demand ⇒ 建立 forceMarker。 */
  noteForce(kind: "force" | "demand"): void;
  /** `ctx.compact()` 的 onError / 同步 catch ⇒ 立即清 forceMarker（§5.4 清除②）。 */
  clearForceMarker(): void;
  /** 兜底清除（`session_compact_failed` 等）：两个 marker 都清。 */
  clearMarkers(scope?: string): void;
  /** pi `session_compact` 事件：遥测 switch 行 + estimator 压缩边界 + watermark + 清 marker。 */
  onSessionCompact(event: unknown, ctx: unknown): void;
  /** pi `tool_call` 事件：恒不拦截；只记「叫过 switch_context」辅助布尔（内存，不落盘）。 */
  onToolCall(toolName: string): void;
  /** pi `model_select` 事件：立即推进模型指纹（P1-7 epoch 翻转，published 清空）。 */
  noteModelSelected(model: unknown): void;
  /** P1-4：flush 遥测观察窗 + 估计量落盘；之后拒绝后续写入。幂等。无 timer 可清。 */
  dispose(ctx?: unknown): void;
  /** P1-11：只读状态视图；惰性 runtime 返回 undefined。 */
  statusView(): DynamicStatusView | undefined;
}

// ---------------------------------------------------------------------------
// 构造依赖
// ---------------------------------------------------------------------------

export interface DynamicWiringDeps {
  /** 构造时的事件 ctx（mode 判惰性；sessionManager 可选）。 */
  ctx: { mode?: unknown; sessionManager?: unknown };
  config: DynamicConfig;
  sessionId: string;
  /** 遥测文件完整路径（生产：join(getAgentDir(), "telemetry", "compact-switch.jsonl")；测试用 tmpdir）。 */
  telemetryFilePath: string;
  now: () => number;
  /** `pi.appendEntry`（估计量持久化）。 */
  appendEntry: (customType: string, data: unknown) => void;
  /** `ctx.sessionManager.getBranch`（§4.2 回读 + §5.5 watermark；缺席 ⇒ 全新状态）。 */
  readBranch: () => readonly unknown[];
  /** 订阅制识别与压力（§8.2）；quota 关闭 ⇒ enabled=false ⇒ 恒不前压。 */
  quota: {
    enabled: boolean;
    isSubscription: (provider: string) => boolean;
    verdictFor: (provider: string) => SubscriptionVerdictLike | undefined;
  };
  warn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// 模型形状提取（永不抛；读不到记 undefined ⇒ 指纹字段为 "unknown"）
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ratesOf(
  model: DynamicModelLike | undefined,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const cost = model?.cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  const record = cost as Record<string, unknown>;
  const input = finiteNumber(record.input);
  const output = finiteNumber(record.output);
  const cacheRead = finiteNumber(record.cacheRead);
  const cacheWrite = finiteNumber(record.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function tiersOf(model: DynamicModelLike | undefined): unknown {
  const cost = model?.cost;
  if (typeof cost !== "object" || cost === null) return undefined;
  return (cost as Record<string, unknown>).tiers;
}

function fingerprintPartsOf(model: DynamicModelLike | undefined, window: number): ModelFingerprintParts {
  const rawTiers = tiersOf(model);
  const tiers = Array.isArray(rawTiers)
    ? rawTiers.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as Record<string, unknown>;
        const above = finiteNumber(record.inputTokensAbove);
        const cacheRead = finiteNumber(record.cacheRead);
        return above !== undefined && cacheRead !== undefined ? [{ inputTokensAbove: above, cacheRead }] : [];
      })
    : undefined;
  return {
    provider: typeof model?.provider === "string" ? model.provider : undefined,
    id: typeof model?.id === "string" ? model.id : undefined,
    api: typeof model?.api === "string" ? model.api : undefined,
    baseUrl: typeof model?.baseUrl === "string" ? model.baseUrl : undefined,
    contextWindow: finiteNumber(model?.contextWindow) ?? (Number.isFinite(window) ? window : undefined),
    rates: ratesOf(model),
    tiers,
  };
}

function asBranchCtxLike(ctx: unknown): BranchCtxLike | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (typeof sessionManager !== "object" || sessionManager === null) return undefined;
  return { sessionManager: sessionManager as BranchCtxLike["sessionManager"] };
}

/** S11：`fromHook` 在 `compactionEntry` 上，不在事件根上（P0-3）。 */
function asSessionCompactEventView(event: unknown): SessionCompactEventView {
  if (typeof event !== "object" || event === null) return {};
  const record = event as Record<string, unknown>;
  const entry = record.compactionEntry;
  const view: SessionCompactEventView = {};
  if (typeof entry === "object" && entry !== null) {
    const entryRecord = entry as Record<string, unknown>;
    const usage = entryRecord.usage;
    const tokensBefore = finiteNumber(entryRecord.tokensBefore);
    view.compactionEntry = {
      ...(typeof entryRecord.fromHook === "boolean" ? { fromHook: entryRecord.fromHook } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(typeof usage === "object" && usage !== null ? { usage: usage as { cost?: { total?: number } } } : {}),
    };
  }
  const reason = record.reason;
  if (reason === "manual" || reason === "threshold" || reason === "overflow") view.reason = reason;
  return view;
}

// ---------------------------------------------------------------------------
// 估计量持久化 payload（§4.2：序列化 EstimatorState + publishedPercent + telemetrySeq）
// ---------------------------------------------------------------------------

interface PersistedDynamicState {
  estimator: EstimatorState;
  publishedPercent: number | null;
  telemetrySeq: number;
}

function readPersistedState(branch: readonly unknown[]): PersistedDynamicState | undefined {
  try {
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
      if (entry?.type !== "custom" || entry.customType !== COMPACT_DYNAMIC_ENTRY_TYPE) continue;
      const data = entry.data;
      if (typeof data !== "object" || data === null) return undefined;
      const record = data as Record<string, unknown>;
      const estimator = parseEstimatorState(record, Number.NaN);
      const publishedPercent = finiteNumber(record.publishedPercent);
      const telemetrySeq = finiteNumber(record.telemetrySeq);
      return {
        estimator,
        publishedPercent: publishedPercent === undefined || publishedPercent <= 0 ? null : Math.floor(publishedPercent),
        telemetrySeq: telemetrySeq === undefined || telemetrySeq < 0 ? 0 : Math.floor(telemetrySeq),
      };
    }
  } catch {
    return undefined; // 任何异常 ⇒ 全新状态（§4.2 永不抛）
  }
  return undefined;
}

function percentOf(tokens: number, window: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return null;
  return Math.floor((tokens / window) * 100);
}

/** R / 轮均成本（§5.1）：优先取 argmin 候选里距当前线最近的 A(C)，否则用 r·C 渐近估计。 */
function rEquivalentTurnsOf(
  outcome: DynamicThresholdOutcome | undefined,
  price: PriceModel | undefined,
  rUsd: number,
): number | null {
  if (outcome?.usable !== true) return null;
  let usdPerTurn: number | null = null;
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of outcome.candidates) {
    const distance = Math.abs(candidate.tokens - outcome.hintTokens);
    if (distance < nearest) {
      nearest = distance;
      usdPerTurn = candidate.usdPerTurn;
    }
  }
  if (usdPerTurn === null || !Number.isFinite(usdPerTurn) || usdPerTurn <= 0) {
    if (price === undefined) return null;
    const readCost = readRateAt(price, outcome.hintTokens) * outcome.hintTokens;
    if (!Number.isFinite(readCost) || readCost <= 0) return null;
    usdPerTurn = readCost;
  }
  const turns = rUsd / usdPerTurn;
  return Number.isFinite(turns) && turns >= 0 ? Math.round(turns) : null;
}

// ---------------------------------------------------------------------------
// wireDynamicThreshold
// ---------------------------------------------------------------------------

function lazyRuntime(mode: "off" | "shadow" | "on"): DynamicRuntime {
  const inert: DynamicThresholdOutcome = { usable: false, reason: "window-unknown" };
  return {
    mode,
    active: false,
    onTurnEnd: () => inert,
    hintEpoch: () => 0,
    noteRealDrop: () => undefined,
    consumeTierTicket: () => false,
    noteHandoffApplied: () => undefined,
    noteForce: () => undefined,
    clearForceMarker: () => undefined,
    clearMarkers: () => undefined,
    onSessionCompact: () => undefined,
    onToolCall: () => undefined,
    noteModelSelected: () => undefined,
    dispose: () => undefined,
    statusView: () => undefined,
  };
}

export function wireDynamicThreshold(deps: DynamicWiringDeps): DynamicRuntime {
  // P1-5/R2-3：构造期即判惰性（print/json 子会话）——条件与 src/stack.ts 的既有早退逐字一致。
  if (isLazyMode(deps.ctx.mode)) return lazyRuntime(deps.config.mode);

  const warn = deps.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));

  // ── 闭包内全部可变状态（无模块级可变状态）──────────────────────────────────
  let estimator: EstimatorState;
  let published: PublishedLine | undefined;
  let telemetrySeq = 0;
  {
    const restored = readPersistedState(deps.readBranch());
    if (restored !== undefined) {
      estimator = restored.estimator;
      telemetrySeq = restored.telemetrySeq;
      if (restored.publishedPercent !== null) {
        published = { percent: restored.publishedPercent, epoch: estimator.modelEpoch };
      }
    } else {
      estimator = createEstimatorState();
    }
  }
  const tracker = createSwitchTelemetryTracker({
    now: deps.now,
    sessionId: deps.sessionId,
    // §4.2 telemetrySeq：非交接类切换（无 onApplied seq）的 seq 分配器，跨 /reload 续号。
    allocFallbackSeq: () => (telemetrySeq += 1),
  });
  const store: SwitchTelemetryStore = createTelemetryStore({ filePath: deps.telemetryFilePath, warn });
  let hintEpoch = 0; // §9.2「一次高位期」编号：只在真实回落时自增
  let lastOutcome: DynamicThresholdOutcome | undefined;
  let lastWindow = Number.NaN;
  let lastGrowthG = Number.NaN;
  let lastSigma = Number.NaN;
  let lastS0 = Number.NaN;
  let lastPrice: PriceModel | undefined;
  let lastCachedTokens: number | null = null;
  let lastForcePercent: number | null = null;
  const tierTickets = new Set<number>(); // §6.3：每个 B 一张票
  let switchToolSeen = false; // §5.4 tool_call 辅助布尔：仅内存诊断（叫过但未生效的分析），不落盘
  let turnsSincePersist = 0;
  let lastPersistedGMean = estimator.gMean;
  let lastPersistedS0Mean = estimator.s0Mean;
  let internalDisabled = false;
  let internalWarned = false;
  let disposed = false;

  const persistNow = (): void => {
    turnsSincePersist = 0;
    lastPersistedGMean = estimator.gMean;
    lastPersistedS0Mean = estimator.s0Mean;
    try {
      deps.appendEntry(COMPACT_DYNAMIC_ENTRY_TYPE, {
        ...(JSON.parse(JSON.stringify(estimator)) as Record<string, unknown>),
        publishedPercent: published === undefined ? null : published.percent,
        telemetrySeq,
      });
    } catch (error) {
      warn(`compact-dynamic persist failed: ${String(error)}`);
    }
  };

  /** §3.4 力线输入：D1 的 ForceLines.atPercent 是 1M 锚点（内部恒 window-scale）。 */
  const forceLinesOf = (input: DynamicTurnInput): ForceLines => {
    if (input.force.forceScaling) {
      return { atPercent: input.force.atPercent, atTokensK: input.force.atTokensK };
    }
    // forceScaling=false：先按钩子的字面表达式算出有效线，再以绝对 token 线喂给 D1
    // （tokensK*1000 = effPct/100·W 实数，D1 内部 floor 换算后回到同一百分点）。
    const effPct = effectiveThresholdPercentWithTokens(
      input.force.atPercent,
      input.force.atTokensK,
      input.usage.contextWindow,
      input.reserveTokens,
    );
    return { atPercent: 0, atTokensK: effPct > 0 ? ((effPct / 100) * input.usage.contextWindow) / 1000 : 0 };
  };

  const effectiveForcePercentOf = (input: DynamicTurnInput): number => {
    const anchor = input.force.forceScaling
      ? windowScaledForcePercent(input.force.atPercent, input.usage.contextWindow)
      : input.force.atPercent;
    return effectiveThresholdPercentWithTokens(
      anchor,
      input.force.atTokensK,
      input.usage.contextWindow,
      input.reserveTokens,
    );
  };

  /** 观察窗关闭 ⇒ firstContextTokens（非 null 时）喂给 estimator 的 observeRestart（§5.5）。 */
  const appendRecords = (records: readonly SwitchTelemetryRecord[]): void => {
    for (const record of records) {
      store.append(record);
      if (record.phase === "window" && record.rProxy?.firstContextTokens != null) {
        estimator = observeRestart(estimator, record.rProxy.firstContextTokens);
      }
    }
  };

  const buildSnapshot = (model: DynamicModelLike | undefined): TelemetrySnapshot => {
    const outcome = lastOutcome;
    const growth = growthEstimate(estimator);
    const start = startEstimate(estimator, Number.isFinite(lastWindow) ? lastWindow : Number.NaN);
    const usable = outcome?.usable === true;
    const rates = ratesOf(model);
    return {
      model: {
        provider: typeof model?.provider === "string" && model.provider.length > 0 ? model.provider : null,
        id: typeof model?.id === "string" && model.id.length > 0 ? model.id : null,
        contextWindow: Number.isFinite(lastWindow) ? lastWindow : null,
      },
      lines: {
        mode: deps.config.mode,
        hintPercent: published?.percent ?? null,
        forcePercent: lastForcePercent,
        basis: usable ? outcome.basis : null,
        dynamicUsable: usable,
        degradeReason: !usable && outcome !== undefined ? outcome.reason : null,
      },
      estimate: {
        g: growth.g,
        sigma: growth.sigma,
        s0: start.s0,
        cStar: usable ? (outcome.cStarTokens ?? null) : null,
        rUsd: deps.config.rediscoveryUsd,
        handoffTokens: handoffEstimate(estimator).tokens,
      },
      price: {
        cacheRead: rates?.cacheRead ?? null,
        cacheWrite: rates?.cacheWrite ?? null,
        output: rates?.output ?? null,
        tierHit: usable ? (outcome.nextTierTokens ?? null) : null,
        writePricingApproximate: true, // P1-1：v1 恒 true
      },
      cachedContextTokens: lastCachedTokens,
    };
  };

  const runtime: DynamicRuntime = {
    mode: deps.config.mode,
    get active(): boolean {
      return !disposed && !internalDisabled;
    },

    onTurnEnd(input) {
      if (disposed || internalDisabled) return { usable: false, reason: "internal-error" };
      // P1-5：handler 内二次判惰性（同一个 ctx 可能在 /reload 后语义变化）。
      if (isLazyMode(input.ctx.mode)) {
        return lastOutcome ?? { usable: false, reason: "window-unknown" };
      }
      const nowMs = deps.now();
      const window = input.usage.contextWindow;
      const tokens = input.usage.tokens;
      lastWindow = window;
      lastCachedTokens = tokens;
      lastForcePercent = effectiveForcePercentOf(input);

      try {
        // §4.3 指纹兜底比对（model_select 之外的主路径）：变化 ⇒ epoch+1、衰减、published 清空。
        const fingerprint = modelFingerprint(fingerprintPartsOf(input.model, window));
        if (fingerprint !== estimator.modelFingerprint) {
          estimator = advanceModelFingerprint(estimator, fingerprint, window);
          published = undefined;
        }
        // §4.1 增长观测（Δ ≤ 0 丢弃 / Δ > 0.25W 截断的纪律在 estimator 内）。
        if (tokens !== null) estimator = observeGrowth(estimator, tokens, window);

        // §8.2 订阅识别（quota 关闭 / verdict 缺失 ⇒ 不进订阅分支）。
        let subscription: SubscriptionStateInput | undefined;
        const provider = typeof input.model?.provider === "string" ? input.model.provider : undefined;
        if (deps.quota.enabled && provider !== undefined && deps.quota.isSubscription(provider)) {
          const verdict = deps.quota.verdictFor(provider);
          subscription = {
            active: verdict !== undefined,
            usedPct: verdict === undefined ? null : resolveSubscriptionPressure(verdict, nowMs),
          };
        }

        lastPrice = buildPriceModel(
          ratesOf(input.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          tiersOf(input.model),
        );
        const growth = growthEstimate(estimator);
        const start = startEstimate(estimator, window);
        lastGrowthG = growth.g;
        lastSigma = growth.sigma;
        lastS0 = start.s0;

        const outcome = computeDynamicThreshold({
          window,
          usedTokens: tokens,
          price: lastPrice,
          growth,
          start,
          handoffTokens: handoffEstimate(estimator).tokens,
          config: deps.config,
          force: forceLinesOf(input),
          reserveTokens: input.reserveTokens,
          staticHint: input.staticHint,
          ...(subscription !== undefined ? { subscription } : {}),
          ...(published !== undefined ? { published } : {}),
          epoch: estimator.modelEpoch,
        });
        lastOutcome = outcome;

        // §9.2 发布状态：死区内 D1 已沿用 published.percent（此处赋值成为 no-op）；
        // 差值 ≥ 死区 ⇒ published 前移到新值。hintTokens 由百分比重构（发布状态只看百分比）。
        if (outcome.usable) {
          if (published === undefined || outcome.hintPercent !== published.percent) {
            published = { percent: outcome.hintPercent, epoch: estimator.modelEpoch };
          }
        }

        // §5.5 观察窗推进（turns ≥ 6 或 wallMs ≥ 600s 先到者关闭）。
        appendRecords(tracker.onTurnEnd(asBranchCtxLike(input.ctx) ?? undefined, buildSnapshot(input.model)));
      } catch (error) {
        // §8.1 第 7 行：一次性 warn + 本会话禁用（后续轮次一律 internal-error 退化）。
        if (!internalWarned) {
          internalWarned = true;
          warn(`compact-dynamic disabled after internal error: ${String(error)}`);
        }
        internalDisabled = true;
        lastOutcome = { usable: false, reason: "internal-error" };
        return lastOutcome;
      }

      // §2.2 写节流：EWMA 相对上次落盘变化 >10%，或距上次落盘 ≥20 轮。
      turnsSincePersist += 1;
      const gMoved =
        lastPersistedGMean === 0
          ? estimator.gMean !== 0
          : Math.abs(estimator.gMean - lastPersistedGMean) / lastPersistedGMean > PERSIST_CHANGE_FRACTION;
      const s0Moved =
        lastPersistedS0Mean === 0
          ? estimator.s0Mean !== 0
          : Math.abs(estimator.s0Mean - lastPersistedS0Mean) / lastPersistedS0Mean > PERSIST_CHANGE_FRACTION;
      if (turnsSincePersist >= PERSIST_EVERY_TURNS || gMoved || s0Moved) persistNow();
      return lastOutcome as DynamicThresholdOutcome;
    },

    hintEpoch() {
      return deps.config.mode === "on" ? hintEpoch : 0;
    },

    noteRealDrop() {
      if (disposed || internalDisabled || deps.config.mode !== "on") return;
      hintEpoch += 1; // §9.2：只有真实用量的回落才重置提醒权（线自己动不重置）
    },

    consumeTierTicket(usedTokens) {
      const outcome = lastOutcome;
      if (outcome?.usable !== true) return false;
      const nextTier = outcome.nextTierTokens;
      if (nextTier === undefined || usedTokens === null || !Number.isFinite(usedTokens)) return false;
      // P1-9：B 本身仍属低价档 ⇒ 票在 usedTokens ≤ B 时仍有效。
      const margin = tierMarginTokens(lastGrowthG, Number.isFinite(lastWindow) ? lastWindow : nextTier);
      if (usedTokens < nextTier - margin || usedTokens > nextTier) return false;
      if (tierTickets.has(nextTier)) return false;
      tierTickets.add(nextTier);
      return true;
    },

    noteHandoffApplied(info) {
      if (disposed || internalDisabled) return;
      tracker.noteHandoffApplied({ seq: info.seq });
      // §4.1 handoff EWMA：chars → token 近似（HANDOFF_CHARS_PER_TOKEN）。
      if (typeof info.chars === "number" && Number.isFinite(info.chars) && info.chars > 0) {
        estimator = observeHandoff(estimator, info.chars / HANDOFF_CHARS_PER_TOKEN);
      }
    },

    noteForce(kind) {
      if (disposed || internalDisabled) return;
      tracker.noteForce(kind);
    },

    clearForceMarker() {
      tracker.clearForceMarker();
    },

    clearMarkers() {
      tracker.clearMarkers();
    },

    onSessionCompact(event, ctx) {
      if (disposed || internalDisabled) return;
      // P1-5：handler 内二次判惰性。
      if (isLazyMode((ctx as { mode?: unknown } | null)?.mode)) return;
      switchToolSeen = false; // 压缩落定：本轮「叫过」观察归零
      try {
        appendRecords(
          tracker.onSessionCompact(
            asSessionCompactEventView(event),
            asBranchCtxLike(ctx) ?? undefined,
            buildSnapshot((ctx as { model?: unknown } | null)?.model as DynamicModelLike | undefined),
          ),
        );
        // §4.1 压缩边界：丢弃 lastTokens 基准（压缩后的第一个 Δ 不入 EWMA）。
        estimator = noteCompactBoundary(estimator);
      } catch (error) {
        warn(`compact-dynamic session_compact handler failed: ${String(error)}`);
      }
    },

    onToolCall(toolName) {
      // 纯辅助诊断（R2-4 降级）：只记「叫过 switch_context」，绝不拦截/改 input/落盘。
      if (toolName === "switch_context") switchToolSeen = true;
    },

    noteModelSelected(model: unknown) {
      if (disposed || internalDisabled) return;
      const modelLike = model as DynamicModelLike | undefined;
      try {
        const fingerprint = modelFingerprint(
          fingerprintPartsOf(modelLike, Number.isFinite(lastWindow) ? lastWindow : Number.NaN),
        );
        if (fingerprint !== estimator.modelFingerprint) {
          estimator = advanceModelFingerprint(
            estimator,
            fingerprint,
            Number.isFinite(lastWindow) ? lastWindow : Number.NaN,
          );
          published = undefined; // §4.3：死区必须重新起算，否则旧线粘住新模型
        }
      } catch {
        // 指纹算不出 ⇒ 留给每轮 turn_end 的兜底比对
      }
    },

    dispose(ctx) {
      if (disposed) return;
      try {
        // §5.5：观察窗仍开着 ⇒ 按实际值 flush（不丢样本）。
        appendRecords(tracker.flushWindow(asBranchCtxLike(ctx) ?? undefined, buildSnapshot(undefined)));
      } catch (error) {
        warn(`compact-dynamic dispose flush failed: ${String(error)}`);
      }
      persistNow(); // §2.2：session_shutdown flush 一次
      disposed = true;
    },

    statusView() {
      if (disposed || internalDisabled) return undefined;
      const outcome = lastOutcome;
      const usable = outcome?.usable === true;
      const view: DynamicStatusView = {
        mode: deps.config.mode,
        usable,
        degradeReason: !usable && outcome !== undefined ? outcome.reason : null,
        hintPercent: usable ? outcome.hintPercent : null,
        basis: usable ? outcome.basis : null,
        lowerBoundPercent: usable ? percentOf(outcome.lowerBound, lastWindow) : null,
        capPercent: usable ? percentOf(outcome.cap, lastWindow) : null,
        cStarPercent: usable && outcome.cStarTokens !== undefined ? percentOf(outcome.cStarTokens, lastWindow) : null,
        g: Number.isFinite(lastGrowthG) ? lastGrowthG : null,
        sigma: Number.isFinite(lastSigma) ? lastSigma : null,
        s0: Number.isFinite(lastS0) ? lastS0 : null,
        rUsd: deps.config.rediscoveryUsd,
        rEquivalentTurns: rEquivalentTurnsOf(outcome, lastPrice, deps.config.rediscoveryUsd),
        priceReadPerM: lastPrice?.base.cacheRead ?? null,
        priceWritePerM: lastPrice?.base.cacheWrite ?? null,
        priceOutputPerM: lastPrice?.base.output ?? null,
        writePricingApproximate: true, // P1-1：v1 恒 true
        subscriptionPressure: usable ? (outcome.subscriptionPressure ?? null) : null,
        telemetryCount: store.count(),
        telemetryPath: deps.telemetryFilePath,
      };
      return view;
    },
  };
  void switchToolSeen; // 辅助布尔仅内存记录（D5：不扩展落盘 schema）
  return runtime;
}
