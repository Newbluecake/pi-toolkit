/**
 * compact-hint dynamic · 切换遥测的纯逻辑层（dynamic-threshold-plan.md §5.2 / §5.4 / §5.5）。
 *
 * 职责（无 IO、零 pi import、零 fs、零隐式 Date.now——时间与上下文全部由参数注入）：
 * - 遥测记录的纯构造器（§5.2：只记聚合数值，D5；缺失一律 null，绝不用 0 冒充未知）；
 * - marker 状态机（§5.4 建立与清除表：`onApplied` 的 seq 是唯一因果信号，时间窗只是兜底）；
 * - trigger 判定表（§5.4，六格逐格可测；判定不了一律 "unknown"，绝不猜）；
 * - 观察窗状态机（§5.5：turns ≥ 6 或 wallMs ≥ 600_000 先到者关闭；shutdown 按实际值 flush）。
 *
 * 落盘（telemetry-store.ts）与 pi 事件接线（D3 wire.ts）都不在本模块。
 */

import {
  aggregateAssistantUsageAfter,
  lastBranchEntryId,
  type BranchCtxLike,
  type UsageRangeAggregate,
} from "./usage-range.js";

// ---------------------------------------------------------------------------
// 常量（§5.4 / §5.5）
// ---------------------------------------------------------------------------

/** marker 兜底 TTL：**仅上限**，不充当因果依据（R2-1）。 */
export const MARKER_TTL_MS = 120_000;
/** 观察窗关闭条件之一：计入的 assistant usage 条数 ≥ 此值。 */
export const WINDOW_MIN_TURNS = 6;
/** 观察窗关闭条件之二：墙钟时长 ≥ 此值；与 turns 先到为准。 */
export const WINDOW_MAX_WALL_MS = 600_000;

// ---------------------------------------------------------------------------
// §5.2 遥测记录类型（v2）
// ---------------------------------------------------------------------------

/** R2-4：枚举收窄到**真正可观测**的 6 类。判定不了一律 "unknown"，绝不猜。 */
export type SwitchTrigger =
  | "switch-tool" // switch hook 的 onApplied 开火：交接文本真的被采用（唯一的因果信号）
  | "dynamic-force" // 本扩展的 force 压缩路径（wire 自己发的，有内部 marker）
  | "pi-auto" // reason="threshold" 且无任何我们的 marker ⇒ pi 自己的自动压缩
  | "overflow" // reason="overflow"
  | "manual" // reason="manual" 且无 marker
  | "unknown"; // 其余一律

export type CompactReason = "manual" | "threshold" | "overflow";

/** `SessionCompactEvent` 的结构化视图（S11：`fromHook` 在 `compactionEntry` 上，不在事件根上）。 */
export interface SessionCompactEventView {
  compactionEntry?: {
    /** = event.compactionEntry.fromHook === true ⇒ 交接文本被这次压缩采用（P0-3）。 */
    fromHook?: boolean;
    tokensBefore?: number;
    /** 生成摘要/应用交接那次 LLM 调用的账（R2-6：单列为 compactionCostUsd）。 */
    usage?: { cost?: { total?: number } };
  } | null;
  reason?: CompactReason | null;
}

export interface SwitchTelemetryRecord {
  v: 2;
  ts: number;
  sessionId: string;
  /**
   * 同一次切换的两行共用；`handoffApplied === true` 时来自 `onApplied` 的 seq（R2-1），
   * 其余切换用会话内 fallback 单调序号（语义不同：不是 PendingHandoffStore 的 seq）。
   */
  seq: number;
  phase: "switch" | "window";

  model: { provider: string | null; id: string | null; contextWindow: number | null };
  trigger: SwitchTrigger;
  reason: CompactReason | null; // SessionCompactEvent.reason
  adopted: boolean | null; // compactionEntry.fromHook
  /** R2-1：onApplied 开火过 ⇒ 交接文本确实被这次压缩消费（因果，不是时间巧合）。 */
  handoffApplied: boolean;
  /** R2-4：demand 不再是 trigger，降为独立事实。 */
  precededByDemand: boolean;

  before: { contextTokens: number | null; percent: number | null; turnsSinceLastSwitch: number | null };
  lines: {
    mode: "off" | "shadow" | "on";
    hintPercent: number | null;
    forcePercent: number | null;
    basis: string | null;
    dynamicUsable: boolean;
    degradeReason: string | null;
  };
  estimate: {
    g: number | null;
    sigma: number | null;
    s0: number | null;
    cStar: number | null;
    rUsd: number;
    handoffTokens: number | null;
  };
  price: {
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    tierHit: number | null;
    writePricingApproximate: true; // P1-1：v1 恒为 true
  };
  /**
   * R2-6：`CompactionEntry.usage`——生成摘要/应用交接那次 LLM 调用的账。它属于切换的固定
   * 成本 K（公式里的 H），与「切换后又花了多少」是两回事，因此单列，绝不混进 rProxy.costUsd。
   * switch_context 走 hook 时无摘要 LLM 调用 ⇒ 通常为 null 或 0；通用摘要压缩则不为 0。
   */
  compactionCostUsd: number | null;

  /**
   * phase === "window" 专有。命名刻意用 rProxy：这些都不是 R，只是它的代理量。
   * 任何取不到的值一律 null（绝不记 0）。
   */
  rProxy?: {
    turns: number | null;
    wallMs: number | null;
    /** R2-2：pi 的 Usage 没有 context 字段 ⇒ 用 input + cacheRead + cacheWrite 作为上下文规模代理。 */
    firstContextTokens: number | null;
    /** R2-2：同一条的原始四元组，便于日后重算代理口径而不用重跑会话。 */
    firstUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    costUsd: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    crossModel: boolean; // 观察窗内出现多个 model id
    costUnknownReason: string | null; // "watermark-lost" | "no-usage" | "cost-missing" | null
  };
}

/** phase === "window" 行的 rProxy 形状（NonNullable 别名便于构造）。 */
export type SwitchRProxy = NonNullable<SwitchTelemetryRecord["rProxy"]>;

// ---------------------------------------------------------------------------
// D1 依赖字段的最小局部快照类型
// ---------------------------------------------------------------------------

// D3 接线时与 dynamic/types.ts 统一（D1 在途，这里只声明遥测需要的最小结构化形状；
// 全部 nullable 的字段在记录里必须以 null 透传，缺省值由 D1/D3 决定）。

/** D3 接线时与 dynamic/types.ts 统一：动态线输出（DynamicThresholdOutcome + 发布态）的最小形状。 */
export interface ThresholdSnapshot {
  mode: "off" | "shadow" | "on";
  /** 上一次对外发布的 hintPercent（published）。 */
  hintPercent: number | null;
  /** 生效中的 force 线（百分比坐标）。 */
  forcePercent: number | null;
  /** ThresholdBasis（"cost" | "tier" | ...），退化时 null。 */
  basis: string | null;
  dynamicUsable: boolean;
  /** DegradeReason，可用时 null。 */
  degradeReason: string | null;
}

/** D3 接线时与 dynamic/types.ts 统一：在线估计量（EstimatorState 读侧）的最小形状。 */
export interface EstimateSnapshot {
  g: number | null;
  sigma: number | null;
  s0: number | null;
  cStar: number | null;
  /** config.rediscoveryUsd（配置常在，非有限时记 0 并由 status 标注）。 */
  rUsd: number;
  handoffTokens: number | null;
}

/** D3 接线时与 dynamic/types.ts 统一：价格模型（PriceModel / tier 命中）的最小形状。 */
export interface PriceSnapshot {
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  /** 观察时点下一个 tier 边界（tokens），无档或未知时 null。 */
  tierHit: number | null;
  writePricingApproximate: true;
}

/** D3 接线时与 dynamic/types.ts 统一：ctx.model 的最小形状。 */
export interface TelemetryModelSnapshot {
  provider: string | null;
  id: string | null;
  contextWindow: number | null;
}

/** 一次记录构造所需的全部会话侧快照（wire 每次事件时点组装）。 */
export interface TelemetrySnapshot {
  model: TelemetryModelSnapshot;
  lines: ThresholdSnapshot;
  estimate: EstimateSnapshot;
  price: PriceSnapshot;
  /** 上轮缓存的上下文 token 数（before.contextTokens 的回落来源，§5.4）。 */
  cachedContextTokens: number | null;
}

// ---------------------------------------------------------------------------
// marker（§5.4 建立与清除表）
// ---------------------------------------------------------------------------

export type ForceMarkerKind = "force" | "demand";

/** 建立：`onApplied({ seq, … })` 开火。清除：① session_compact 消费后；② session_compact_failed；③ TTL 兜底。 */
export interface HandoffMarker {
  seq: number;
  at: number;
}

/** 建立：wire 自己发出 force 压缩或 demand。清除：① session_compact 消费后；② ctx.compact()
 *  的 onError/同步 catch（wire 调 clearForceMarker）；③ session_compact_failed；④ TTL 兜底。
 *  成功 / 失败 / 超时三条路径全覆盖（R2-4）。 */
export interface ForceMarker {
  kind: ForceMarkerKind;
  at: number;
}

/** TTL 检查（严格大于才作废：`now - at > MARKER_TTL_MS`）。返回仍存活的 marker。 */
export function liveHandoffMarker(marker: HandoffMarker | undefined, now: number): HandoffMarker | undefined {
  return marker !== undefined && now - marker.at <= MARKER_TTL_MS ? marker : undefined;
}

export function liveForceMarker(marker: ForceMarker | undefined, now: number): ForceMarker | undefined {
  return marker !== undefined && now - marker.at <= MARKER_TTL_MS ? marker : undefined;
}

// ---------------------------------------------------------------------------
// trigger 判定表（§5.4，逐格单测；顺序即语义）
// ---------------------------------------------------------------------------

export interface TriggerInput {
  /** handoffMarker 存活（onApplied 开火过且未被消费/未超时）。 */
  handoffApplied: boolean;
  /** 存活的 forceMarker 的 kind；无存活 marker 时 null（demand 也是 marker，会命中「无任何 marker」的反面）。 */
  forceKind: ForceMarkerKind | null;
  reason: CompactReason | null | undefined;
}

/**
 * | 条件                                                   | trigger           |
 * | handoffApplied === true                                | "switch-tool"     |
 * | forceMarker?.kind === "force"（且未 handoffApplied）    | "dynamic-force"   |
 * | reason === "overflow"                                  | "overflow"        |
 * | reason === "threshold" 且无任何 marker                 | "pi-auto"         |
 * | reason === "manual" 且无任何 marker                    | "manual"          |
 * | 其余（reason 缺失、marker 与 reason 矛盾）             | "unknown"         |
 */
export function classifyTrigger(input: TriggerInput): SwitchTrigger {
  if (input.handoffApplied) return "switch-tool";
  if (input.forceKind === "force") return "dynamic-force";
  if (input.reason === "overflow") return "overflow";
  // 到这里 handoffApplied === false ⇒ handoff marker 不存活；「无任何 marker」= 无 force marker。
  const noMarker = input.forceKind === null;
  if (input.reason === "threshold" && noMarker) return "pi-auto";
  if (input.reason === "manual" && noMarker) return "manual";
  return "unknown";
}

// ---------------------------------------------------------------------------
// 记录构造（纯）
// ---------------------------------------------------------------------------

function fin(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface SwitchRecordInput {
  now: number;
  sessionId: string;
  seq: number;
  event: SessionCompactEventView;
  /** 存活（已过 TTL 检查）的 marker；调用方负责 live-check。 */
  handoff: HandoffMarker | undefined;
  force: ForceMarker | undefined;
  turnsSinceLastSwitch: number | null;
  snapshot: TelemetrySnapshot;
}

/** 构造 `phase: "switch"` 行。不做任何 IO；所有可缺失量缺失时记 null（绝不用 0 冒充）。 */
export function buildSwitchTelemetryRecord(input: SwitchRecordInput): SwitchTelemetryRecord {
  const { event, snapshot } = input;
  const compactionEntry = event.compactionEntry ?? undefined;

  const handoffApplied = input.handoff !== undefined;
  const forceKind = input.force?.kind ?? null;
  const reason = event.reason ?? null;

  // before.contextTokens：优先 tokensBefore，缺失回落上轮缓存 usage.tokens，再缺失 null（§5.4）。
  const contextTokens = fin(compactionEntry?.tokensBefore) ?? fin(snapshot.cachedContextTokens);
  const window = fin(snapshot.model.contextWindow);
  const percent =
    contextTokens !== null && window !== null && window > 0 ? Math.floor((contextTokens / window) * 100) : null;

  return {
    v: 2,
    ts: input.now,
    sessionId: input.sessionId,
    seq: input.seq,
    phase: "switch",
    model: {
      provider: str(snapshot.model.provider),
      id: str(snapshot.model.id),
      contextWindow: window,
    },
    trigger: classifyTrigger({ handoffApplied, forceKind, reason }),
    reason,
    adopted: compactionEntry === undefined ? null : compactionEntry.fromHook === true,
    handoffApplied,
    precededByDemand: forceKind === "demand",
    before: {
      contextTokens,
      percent,
      turnsSinceLastSwitch: input.turnsSinceLastSwitch,
    },
    lines: {
      mode: snapshot.lines.mode,
      hintPercent: fin(snapshot.lines.hintPercent),
      forcePercent: fin(snapshot.lines.forcePercent),
      basis: str(snapshot.lines.basis),
      dynamicUsable: snapshot.lines.dynamicUsable === true,
      degradeReason: str(snapshot.lines.degradeReason),
    },
    estimate: {
      g: fin(snapshot.estimate.g),
      sigma: fin(snapshot.estimate.sigma),
      s0: fin(snapshot.estimate.s0),
      cStar: fin(snapshot.estimate.cStar),
      // rUsd 来自配置（默认 10），恒为 number；非有限输入按 0 处理由 status 的 uncalibrated 标注兜住。
      rUsd: fin(snapshot.estimate.rUsd) ?? 0,
      handoffTokens: fin(snapshot.estimate.handoffTokens),
    },
    price: {
      cacheRead: fin(snapshot.price.cacheRead),
      cacheWrite: fin(snapshot.price.cacheWrite),
      output: fin(snapshot.price.output),
      tierHit: fin(snapshot.price.tierHit),
      writePricingApproximate: true, // P1-1：v1 恒为 true
    },
    compactionCostUsd: fin(compactionEntry?.usage?.cost?.total),
  };
}

/** 由范围聚合构造 rProxy（§5.5）。watermark-lost 时 turns 不可知 ⇒ null；no-usage 的 0 是真实零。 */
export function buildRProxy(aggregate: UsageRangeAggregate, wallMs: number): SwitchRProxy {
  return {
    turns: aggregate.unknownReason === "watermark-lost" ? null : aggregate.turns,
    wallMs: Math.max(0, Math.round(wallMs)),
    firstContextTokens: aggregate.firstContextTokens,
    firstUsage: aggregate.firstUsage === null ? null : { ...aggregate.firstUsage },
    costUsd: aggregate.costUsd,
    cacheRead: aggregate.cacheRead,
    cacheWrite: aggregate.cacheWrite,
    crossModel: aggregate.models.length > 1,
    costUnknownReason: aggregate.unknownReason,
  };
}

/** 构造 `phase: "window"` 行：复用 switch 行的全部切换时点事实（含 seq），仅 ts/phase/rProxy 不同。 */
export function buildWindowTelemetryRecord(
  base: SwitchTelemetryRecord,
  rProxy: SwitchRProxy,
  ts: number,
): SwitchTelemetryRecord {
  return { ...base, ts, phase: "window", rProxy };
}

// ---------------------------------------------------------------------------
// 观察窗 + marker 的会话内状态机（闭包内可变；无 IO；时间全部注入）
// ---------------------------------------------------------------------------

export interface SwitchTelemetryTrackerDeps {
  now: () => number;
  sessionId: string;
  /** 非交接切换（无 onApplied seq）的 seq 分配器；缺省用内部单调计数器。D3 可接 telemetrySeq。 */
  allocFallbackSeq?: (() => number) | undefined;
}

export interface SwitchTelemetryTracker {
  /** `onApplied({ seq, … })` 开火 ⇒ 建立 handoffMarker（R2-1 唯一因果信号）。 */
  noteHandoffApplied(info: { seq: number }): void;
  /** wire 自己发出 force 压缩或 demand ⇒ 建立 forceMarker。 */
  noteForce(kind: ForceMarkerKind): void;
  /** `ctx.compact()` 的 onError / 同步 catch ⇒ 立即清 forceMarker（§5.4 清除②）。 */
  clearForceMarker(): void;
  /** `session_compact_failed` 等兜底清除：两个 marker 都清（§5.4 清除②/③）。 */
  clearMarkers(scope?: string): void;
  /**
   * `session_compact`：写 switch 行（若上一个观察窗仍开着，先按实际值 flush 它，不丢样本），
   * 记 watermark，打开观察窗，清两个 marker，重置轮计数。
   */
  onSessionCompact(
    event: SessionCompactEventView,
    ctx: BranchCtxLike | undefined,
    snapshot: TelemetrySnapshot,
  ): SwitchTelemetryRecord[];
  /** 既有 `turn_end`：累计轮数；窗口满足 turns ≥ 6 或 wallMs ≥ 600_000 时关闭并写 window 行。
   *  `_snapshot` 仅为 D3 wire 的统一调用形状保留：window 行复用 switch 行的切换时点快照。 */
  onTurnEnd(ctx: BranchCtxLike | undefined, _snapshot: TelemetrySnapshot): SwitchTelemetryRecord[];
  /** `session_shutdown` / dispose：窗口仍开着 ⇒ 按实际值 flush（不丢样本）。同上不消费快照。 */
  flushWindow(ctx: BranchCtxLike | undefined, _snapshot: TelemetrySnapshot): SwitchTelemetryRecord[];
  /** 诊断/测试：当前 marker 状态（已过 TTL 的视为不存在）。 */
  markerState(): { handoff: HandoffMarker | undefined; force: ForceMarker | undefined };
  /** 诊断/测试：观察窗状态。 */
  windowState(): { open: boolean; seq: number | null; afterEntryId: string | null };
}

interface OpenWindow {
  seq: number;
  afterEntryId: string | null;
  openedAt: number;
  /** switch 行（window 行复用其切换时点事实与 seq）。 */
  base: SwitchTelemetryRecord;
}

export function createSwitchTelemetryTracker(deps: SwitchTelemetryTrackerDeps): SwitchTelemetryTracker {
  let handoff: HandoffMarker | undefined;
  let force: ForceMarker | undefined;
  let openWindow: OpenWindow | undefined;
  let turnsSinceSwitch = 0;
  let fallbackSeq = 0;

  const allocSeq = (): number => (deps.allocFallbackSeq ? deps.allocFallbackSeq() : (fallbackSeq += 1));

  /** TTL 过期的 marker 就地作废（读取侧统一走这里）。 */
  const prune = (now: number): void => {
    handoff = liveHandoffMarker(handoff, now);
    force = liveForceMarker(force, now);
  };

  const closeWindow = (
    now: number,
    ctx: BranchCtxLike | undefined,
    aggregate: UsageRangeAggregate | undefined,
  ): SwitchTelemetryRecord => {
    const window = openWindow as OpenWindow; // 调用方保证存在
    const agg = aggregate ?? aggregateAssistantUsageAfter(ctx, window.afterEntryId);
    const record = buildWindowTelemetryRecord(window.base, buildRProxy(agg, now - window.openedAt), now);
    openWindow = undefined;
    return record;
  };

  return {
    noteHandoffApplied(info) {
      handoff = { seq: info.seq, at: deps.now() };
    },
    noteForce(kind) {
      force = { kind, at: deps.now() };
    },
    clearForceMarker() {
      force = undefined;
    },
    clearMarkers() {
      handoff = undefined;
      force = undefined;
    },
    onSessionCompact(event, ctx, snapshot) {
      const now = deps.now();
      prune(now);
      const records: SwitchTelemetryRecord[] = [];
      // 上一个窗口仍开着：被新切换打断 ⇒ 先按实际值 flush（不丢样本），再开新窗。
      if (openWindow !== undefined) records.push(closeWindow(now, ctx, undefined));
      const seq = handoff !== undefined ? handoff.seq : allocSeq();
      const record = buildSwitchTelemetryRecord({
        now,
        sessionId: deps.sessionId,
        seq,
        event,
        handoff,
        force,
        turnsSinceLastSwitch: turnsSinceSwitch,
        snapshot,
      });
      records.push(record);
      // watermark：session_compact 后分支末条目 id（即压缩条目本身，§5.5）。
      openWindow = { seq, afterEntryId: lastBranchEntryId(ctx), openedAt: now, base: record };
      handoff = undefined;
      force = undefined;
      turnsSinceSwitch = 0;
      return records;
    },
    onTurnEnd(ctx) {
      turnsSinceSwitch += 1;
      if (openWindow === undefined) return [];
      const now = deps.now();
      const aggregate = aggregateAssistantUsageAfter(ctx, openWindow.afterEntryId);
      if (aggregate.turns >= WINDOW_MIN_TURNS || now - openWindow.openedAt >= WINDOW_MAX_WALL_MS) {
        return [closeWindow(now, ctx, aggregate)];
      }
      return [];
    },
    flushWindow(ctx) {
      if (openWindow === undefined) return [];
      return [closeWindow(deps.now(), ctx, undefined)];
    },
    markerState() {
      const now = deps.now();
      prune(now);
      return { handoff, force };
    },
    windowState() {
      return openWindow === undefined
        ? { open: false, seq: null, afterEntryId: null }
        : { open: true, seq: openWindow.seq, afterEntryId: openWindow.afterEntryId };
    },
  };
}
