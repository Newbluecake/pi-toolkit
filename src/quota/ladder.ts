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
  readonly fetchedAt: Millis;
  /** 快照年龄超过 staleAfterMs —— 闸门据此退化为不阻断。 */
  readonly stale: boolean;
  readonly plan?: string | undefined;
}

/**
 * 重新武装的边界抖动幅度（plan D4/D5）：窗口 usedPct 相对上次观测回落至少
 * 这么多才认定为真实窗口重置（clears latches / forecast rings / demotions）。
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
    fetchedAt: snapshot.fetchedAt,
    stale,
    ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }),
  };
}

/** usedPct 的线性网格步（step<=0 ⇒ 恒 0，即关闭网格闸）。 */
export function gridStep(usedPct: number, step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.floor(clampPct(usedPct) / step) * step;
}
