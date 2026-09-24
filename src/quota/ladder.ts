/**
 * Quota ladder (quota-plan §3.2 / §5.2-§5.3): pure threshold → level logic.
 * Zero pi imports — unit-testable under plain node (plan §2 分层纪律).
 *
 * Semantics baseline (requirements「预警阶梯」): warnings must fire *early*
 * (burn-rate forecast can raise a window above its percentage tier), the 5h
 * and week windows are judged independently, and the provider-level verdict is
 * the MAX across windows (the "Kimi week-exhausted while 5h idle" trap).
 */

import type { LadderLevel, QuotaProviderId, QuotaSnapshot, QuotaWindow, WindowScope } from "./types.js";
import type { Millis } from "../core/types.js";

export interface LadderThresholds {
  readonly l1: number;
  readonly l2: number;
  readonly l3: number;
  /** ETA 低于此值直接 L3。 */
  readonly l3EtaMs: Millis;
}

export type LadderReason = "none" | "pct" | "forecast-before-reset" | "forecast-eta" | "exhausted";

export interface WindowVerdict {
  readonly scope: WindowScope;
  readonly usedPct: number;
  readonly level: LadderLevel;
  readonly reason: LadderReason;
  readonly resetAt?: Millis | undefined;
  /** 预测耗尽还需多久；无预测时 undefined。 */
  readonly etaMs?: Millis | undefined;
}

export interface ProviderVerdict {
  readonly provider: QuotaProviderId;
  /** 全部窗口的**最高**严重级 —— Kimi 周耗尽陷阱的唯一正解。 */
  readonly level: LadderLevel;
  readonly windows: readonly WindowVerdict[];
  /** 持久化的「已降位」标记仍在有效期内。 */
  readonly demoted: boolean;
  /** 降位标记的到期时刻（demotion store 的 expiresAt）；未降位 / 未知时 undefined。 */
  readonly demotedUntil?: Millis | undefined;
  readonly fetchedAt: Millis;
  /** 快照年龄超过 staleAfterMs —— 闸门据此退化为不阻断。 */
  readonly stale: boolean;
  readonly plan?: string | undefined;
}

/**
 * 重新武装的边界抖动幅度（plan D4/D5）：窗口 usedPct 相对上次观测回落至少
 * 这么多才**可能**是窗口重置。service 层还要求重置证据（旧 resetAt 已过 / resetAt
 * 前移 / 下一次拉取二次确认）才据此清降位与样本环——单凭回落不够，上游故障时
 * 端点会短暂返回归零读数（2026-09-24 kimi 现场）。
 */
export const QUOTA_HYSTERESIS_PCT = 15;

export const DEFAULT_THRESHOLDS: LadderThresholds = { l1: 50, l2: 75, l3: 90, l3EtaMs: 1_800_000 };

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/** 单窗口判定（plan §5.2）。etaMs 由调用方（service）从 forecast 注入，本函数保持纯。 */
export function windowLevel(
  window: QuotaWindow,
  input: { readonly now: Millis; readonly etaMs?: Millis | undefined; readonly thresholds: LadderThresholds },
): WindowVerdict {
  const pct = clampPct(window.usedPct);
  const { now, thresholds } = input;
  const etaMs = input.etaMs !== undefined && Number.isFinite(input.etaMs) ? input.etaMs : undefined;

  // 1) 硬耗尽
  if (pct >= 100) {
    return {
      scope: window.scope,
      usedPct: pct,
      level: 3,
      reason: "exhausted",
      ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
      ...(etaMs === undefined ? {} : { etaMs }),
    };
  }

  // 2) 百分比网格
  let level: LadderLevel = pct >= thresholds.l3 ? 3 : pct >= thresholds.l2 ? 2 : pct >= thresholds.l1 ? 1 : 0;
  const pctReason: LadderReason = level > 0 ? "pct" : "none";

  // 3) 速率预测（「提前」的关键，可以把 60% 抬到 L2）。反向不降级：90% 且马上
  //    重置的窗口仍按 90% 报 —— 降级会让它在重置前 1 分钟被判 L0，随后被真实
  //    429 打脸（plan §5.2 显式锁死）。
  let reason: LadderReason = pctReason;
  if (etaMs !== undefined && etaMs >= 0) {
    if (etaMs < thresholds.l3EtaMs && level < 3) {
      // 3a) ETA 短于硬线 ⇒ L3（无论重置多远）
      level = 3;
      reason = "forecast-eta";
    } else if (window.resetAt !== undefined && now + etaMs < window.resetAt && level < 2) {
      // 3b) 预测在窗口重置**之前**耗尽 ⇒ 至少 L2。resetAt 未知时不做此判定。
      level = 2;
      reason = "forecast-before-reset";
    }
  }

  return {
    scope: window.scope,
    usedPct: pct,
    level,
    reason,
    ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
    ...(etaMs === undefined ? {} : { etaMs }),
  };
}

/** provider 级聚合（plan §5.3）：max(windows) ∪ demotion 地板（降位标记把等级钉在 >= 2）。 */
export function providerVerdict(
  snapshot: QuotaSnapshot,
  input: {
    readonly now: Millis;
    readonly thresholds: LadderThresholds;
    readonly staleAfterMs: Millis;
    readonly etaOf: (scope: WindowScope) => Millis | undefined;
    readonly demoted: boolean;
    readonly demotedUntil?: Millis | undefined;
  },
): ProviderVerdict {
  const stale = input.now - snapshot.fetchedAt > input.staleAfterMs;

  const windows = snapshot.windows.map((w) =>
    windowLevel(w, { now: input.now, etaMs: input.etaOf(w.scope), thresholds: input.thresholds }),
  );
  // ★ Kimi 陷阱的唯一正解：provider 级 = 全部窗口取**最高**严重级，周窗口
  //   used_ratio:1 (L3) 必须压过 5h 的 remaining:100 (L0)。
  let level: LadderLevel = 0;
  for (const w of windows) if (w.level > level) level = w.level;
  if (input.demoted && level < 2) level = 2;
  return {
    provider: snapshot.provider,
    level,
    windows,
    demoted: input.demoted,
    ...(input.demoted && input.demotedUntil !== undefined ? { demotedUntil: input.demotedUntil } : {}),
    fetchedAt: snapshot.fetchedAt,
    stale,
    ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
  };
}

/**
 * 额度恢复事件（service → hook，额度恢复播报）：`applySnapshot` 认定观测重置
 * （有重置证据或两次一致回落，service.classifyDrop）且快照被接受时发出。数据面只
 * 描述事实；是否注入由 hook 层按闩锁（「本会话曾真播报过」）决定——从未告警过的
 * provider 无「恢复」可言。
 */
export interface QuotaRecoveryEvent {
  readonly provider: QuotaProviderId;
  /** 本次被认定观测重置的窗口 scope 集合。 */
  readonly resetScopes: ReadonlySet<WindowScope>;
  /** 落地后的**终态**判定（含按现有语义当场重建的降位标记）。 */
  readonly verdict: ProviderVerdict;
  /** 镜像 evaluateQuotaGate 的阻断判定（gate && !stale && level ≥ gateLevel）——文案据此如实写闸门状态。 */
  readonly gateBlocked: boolean;
  readonly at: Millis;
}

/**
 * 等级只来自降位地板：仍在降位期，但没有任何窗口自身达到 L2。读数与降位矛盾
 * （上游残缺数据、或服务端提前重置尚未被观测确认）——文案层据此如实说明，
 * 不能拿用量最低的窗口去讲「已用 0%」。
 */
export function isDemotionFloorOnly(v: ProviderVerdict): boolean {
  return v.demoted && v.level >= 2 && v.windows.every((w) => w.level < 2);
}

/** usedPct 的线性网格步（step<=0 ⇒ 恒 0，即关闭网格闸）。 */
export function gridStep(usedPct: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(clampPct(usedPct) / step) * step;
}
