// 预测层日预算账本（plan.md v3.2 §9 费用 / §11.2 P2 `predict/ledger.ts`）。
// pi-free：无任何 import，无模块级可变状态（I4），不挂 `globalThis`/`Symbol.for`。
//
// 进程级账本表由**参数传入**（`createPredictLedger(table, config)`），跨 `/reload`
// 与同进程多会话的共享由 wire 层（`Symbol.for("pi-subagent:memory-predict-ledger")`）
// 负责，本模块不持有、也不创建任何全局表。账本只做「有条件估算上限」（§9.3）：
// 不承诺绝对金额硬上限——失败/abort/zombie 晚完成等拿不到 usage 的请求按预留结算，
// 多 pi 进程时日额按进程计。
//
// 语义（§9.2 / §8.2）：
//   - 每次模型尝试前 `reserve(now, estimateUsd)` 估算预留；预留会超出余额时拒绝；
//     failover 每档各自 `reserve`（独立 Reservation）。
//   - 有 usage（如实返回）⇒ `settle(res, usage, price)` 按 usage × 价目结算；
//     无 usage（失败/abort/超时/usage 非法）⇒ `settle(res)` 按预留额结算。
//   - `settle`/`release` 幂等；结算额不超过预留额，故 `spent + reserved ≤ maxUsdPerDay`
//     恒成立（usage 超过预留的罕见情形按预留结算，属 §9.3 记载的超额风险的下界口径）。
//   - 本地日历日（非 UTC）；跨日自动重置；表 cap 8 天，逐最旧淘汰。
//   - 所有方法显式接收 `now`（reserve 用它定日；settle/release 用 Reservation 上
//     捕获的 day，天然跨午夜仍记回发起当日）。

/** Epoch 毫秒（本地墙钟）。 */
export type Millis = number;

/** 本地日历日键，形如 `YYYY-MM-DD`（本地时区；定宽补零 ⇒ 字典序 == 时间序）。 */
export type DayKey = string;

/** deepseek 价目（$/1M tokens，§9.1：input 0.30 · cacheRead 0.006 · output 1.20）。 */
export interface PredictPrice {
  readonly inputPerM: number;
  readonly cacheReadPerM: number;
  readonly outputPerM: number;
}

/** 一次模型尝试的 usage（token 数）。 */
export interface PredictUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
}

/** 单日账目（spent=已结算支出 · reserved=未结算预留 · calls=已计入的尝试次数）。 */
export interface DayLedger {
  spent: number;
  reserved: number;
  calls: number;
}

/** 进程级账本表（由参数传入；本模块不持有全局引用）。 */
export type PredictLedgerTable = Map<DayKey, DayLedger>;

/** 账本配置（非 live 键，改后 `/reload` 重建账本实例）。 */
export interface PredictLedgerConfig {
  /** 0 表示不调用（§10）。 */
  readonly maxCallsPerDay: number;
  /** 估算日额（§9.2，默认 0.14）。 */
  readonly maxUsdPerDay: number;
}

/** 表上限（§2.2 cap 8 天）。 */
export const MAX_LEDGER_DAYS = 8;

export type ReserveDenyReason = "usd" | "calls" | "invalid";

/** 预留句柄：`id` 是账本实例内的唯一键；`day`/`amount` 为发起时捕获，仅供诊断。 */
export interface Reservation {
  readonly id: string;
  readonly day: DayKey;
  readonly amount: number;
}

export type ReserveResult =
  { readonly ok: true; readonly reservation: Reservation } | { readonly ok: false; readonly reason: ReserveDenyReason };

export interface LedgerSnapshot {
  readonly dayKey: DayKey;
  readonly spent: number;
  readonly reserved: number;
  readonly calls: number;
}

export interface PredictLedger {
  /** 估算预留；余额不足（`usd`）、次数已满（`calls`）或估算非法（`invalid`）时拒绝。 */
  reserve(now: Millis, estimateUsd: number): ReserveResult;
  /** 有 usage 且价目可用 ⇒ 按 usage × 价目结算；否则（无 usage/失败/abort/超时）按预留结算。幂等。 */
  settle(reservation: Reservation, usage?: PredictUsage, price?: PredictPrice): void;
  /** 释放未结算预留（该尝试从未计费）。幂等；不改变 spent/calls。 */
  release(reservation: Reservation): void;
  /** 只读快照（不创建日条目）；跨日重置后返回全 0。 */
  snapshot(now: Millis): LedgerSnapshot;
}

// ───────────────────────────── 纯函数（可独立测试） ─────────────────────────────

/** 本地日历日键。用 `getFullYear/getMonth/getDate`（本地时区，非 UTC）。 */
export function localDayKey(now: Millis): DayKey {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function finiteNonNeg(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** usage × 价目 ⇒ USD（$/1M tokens）。非有限/负值按 0 计，永不 NaN/Infinity。 */
export function usageCostUsd(usage: PredictUsage, price: PredictPrice): number {
  const input = finiteNonNeg(usage.inputTokens);
  const cacheRead = finiteNonNeg(usage.cacheReadTokens);
  const output = finiteNonNeg(usage.outputTokens);
  const inputRate = finiteNonNeg(price.inputPerM);
  const cacheReadRate = finiteNonNeg(price.cacheReadPerM);
  const outputRate = finiteNonNeg(price.outputPerM);
  return (input * inputRate + cacheRead * cacheReadRate + output * outputRate) / 1e6;
}

/** usage 是否可用于结算：三字段齐全、有限、非负。任一字段非法 ⇒ false，
 *  调用方必须退回按预留结算（flight 的 costSource 口径与 `settle` 一致）。 */
export function usableUsage(u: PredictUsage | undefined): u is PredictUsage {
  return (
    u !== undefined &&
    Number.isFinite(u.inputTokens) &&
    u.inputTokens >= 0 &&
    Number.isFinite(u.cacheReadTokens) &&
    u.cacheReadTokens >= 0 &&
    Number.isFinite(u.outputTokens) &&
    u.outputTokens >= 0
  );
}

/** 价目是否可用于结算：三字段齐全、有限、非负。任一字段非法 ⇒ false，
 *  调用方必须退回按预留结算（同 `usableUsage`）。 */
export function usablePrice(p: PredictPrice | undefined): p is PredictPrice {
  return (
    p !== undefined &&
    Number.isFinite(p.inputPerM) &&
    p.inputPerM >= 0 &&
    Number.isFinite(p.cacheReadPerM) &&
    p.cacheReadPerM >= 0 &&
    Number.isFinite(p.outputPerM) &&
    p.outputPerM >= 0
  );
}

// ───────────────────────────── 账本实现 ─────────────────────────────

interface ActiveReservation {
  readonly day: DayKey;
  readonly amount: number;
}

/** 用传入的表构建账本实例。表是唯一的可变共享状态；其余（active/seq）属实例闭包。 */
export function createPredictLedger(table: PredictLedgerTable, config: PredictLedgerConfig): PredictLedger {
  // 配置消毒：非有限/负值夹到 0（0 = 拒绝一切，绝不因异常输入放行——不绕过预算）。
  const maxCallsPerDay = Math.max(0, Math.floor(finiteNonNeg(config.maxCallsPerDay)));
  const maxUsdPerDay = Math.max(0, finiteNonNeg(config.maxUsdPerDay));

  const active = new Map<string, ActiveReservation>();
  let seq = 0;

  function gcDays(): void {
    while (table.size > MAX_LEDGER_DAYS) {
      let oldest: DayKey | undefined;
      for (const key of table.keys()) {
        if (oldest === undefined || key < oldest) oldest = key;
      }
      if (oldest === undefined) break;
      table.delete(oldest);
    }
  }

  function getOrCreateDay(day: DayKey): DayLedger {
    let rec = table.get(day);
    if (rec === undefined) {
      rec = { spent: 0, reserved: 0, calls: 0 };
      table.set(day, rec);
      gcDays();
    }
    return rec;
  }

  return {
    reserve(now, estimateUsd) {
      if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) {
        return { ok: false, reason: "invalid" };
      }
      const day = localDayKey(now);
      const rec = getOrCreateDay(day);
      if (rec.calls >= maxCallsPerDay) {
        return { ok: false, reason: "calls" };
      }
      if (rec.spent + rec.reserved + estimateUsd > maxUsdPerDay) {
        return { ok: false, reason: "usd" };
      }
      rec.reserved += estimateUsd;
      rec.calls += 1;
      seq += 1;
      const id = `res_${day}_${seq}`;
      active.set(id, { day, amount: estimateUsd });
      return { ok: true, reservation: { id, day, amount: estimateUsd } };
    },

    settle(reservation, usage, price) {
      const rec = active.get(reservation.id);
      if (rec === undefined) return; // 已结算/已释放/未知 ⇒ 幂等 no-op
      active.delete(reservation.id);
      const day = table.get(rec.day);
      // 结算额 = usage × 价目（两者均可用时）否则按预留额；上限 = 预留额，
      // 保证 spent + reserved 不超过限额（usage 超额按预留结算，§9.3）。
      const cost = usableUsage(usage) && usablePrice(price) ? usageCostUsd(usage, price) : rec.amount;
      const settled = Math.min(cost, rec.amount);
      if (day !== undefined) {
        day.reserved = Math.max(0, day.reserved - rec.amount);
        day.spent += settled;
      }
    },

    release(reservation) {
      const rec = active.get(reservation.id);
      if (rec === undefined) return; // 幂等 no-op
      active.delete(reservation.id);
      const day = table.get(rec.day);
      if (day !== undefined) {
        day.reserved = Math.max(0, day.reserved - rec.amount);
      }
    },

    snapshot(now) {
      const day = localDayKey(now);
      const rec = table.get(day);
      return rec === undefined
        ? { dayKey: day, spent: 0, reserved: 0, calls: 0 }
        : { dayKey: day, spent: rec.spent, reserved: rec.reserved, calls: rec.calls };
    },
  };
}
