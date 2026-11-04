// ledger.ts unit tests (plan.md v3.2 §11.2 ledger; §9 费用 / §8.2 flight 预留结算口径).

import { describe, expect, it } from "vitest";
import {
  createPredictLedger,
  localDayKey,
  MAX_LEDGER_DAYS,
  usablePrice,
  usableUsage,
  usageCostUsd,
  type DayKey,
  type DayLedger,
  type PredictLedger,
  type PredictLedgerConfig,
  type PredictLedgerTable,
  type PredictPrice,
  type PredictUsage,
  type Reservation,
} from "../../../../src/memory/jev/predict/ledger.js";

// §9.1 真实价目（input $0.30/M · cacheRead $0.006/M · output $1.20/M）。
const DEEPSEEK_PRICE: PredictPrice = { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 };

/** 本地时区的固定时刻（new Date(y, m-1, d, …) 本地构造 ⇒ 与机器 TZ 无关）。 */
function local(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
  return new Date(y, m - 1, d, h, min, s, ms).getTime();
}

function makeLedger(
  config: Partial<PredictLedgerConfig> = {},
  table: PredictLedgerTable = new Map<DayKey, DayLedger>(),
): { ledger: PredictLedger; table: PredictLedgerTable } {
  const ledger = createPredictLedger(table, { maxCallsPerDay: 100, maxUsdPerDay: 1, ...config });
  return { ledger, table };
}

/** 断言 reserve 成功并返回 Reservation。 */
function mustReserve(ledger: PredictLedger, now: number, estimateUsd: number): Reservation {
  const r = ledger.reserve(now, estimateUsd);
  if (!r.ok) throw new Error(`reserve(${estimateUsd}) should succeed, got ${r.reason}`);
  return r.reservation;
}

describe("localDayKey", () => {
  it("formats a local calendar day as YYYY-MM-DD (zero-padded, local timezone)", () => {
    expect(localDayKey(local(2026, 11, 4, 12, 0, 0))).toBe("2026-11-04");
    expect(localDayKey(local(2026, 1, 5, 0, 0, 0))).toBe("2026-01-05");
  });

  it("rolls over at local midnight (not UTC)", () => {
    expect(localDayKey(local(2026, 11, 4, 23, 59, 59, 999))).toBe("2026-11-04");
    expect(localDayKey(local(2026, 11, 5, 0, 0, 0, 0))).toBe("2026-11-05");
  });
});

describe("usageCostUsd", () => {
  it("computes usage × price per 1M tokens", () => {
    expect(usageCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, DEEPSEEK_PRICE)).toBeCloseTo(
      0.3,
      12,
    );
    expect(usageCostUsd({ inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0 }, DEEPSEEK_PRICE)).toBeCloseTo(
      0.006,
      12,
    );
    expect(usageCostUsd({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 }, DEEPSEEK_PRICE)).toBeCloseTo(
      1.2,
      12,
    );
  });

  it("sums all three components", () => {
    // 500k input + 1M cacheRead + 500k output = 0.15 + 0.006 + 0.6 = 0.756。
    const cost = usageCostUsd(
      { inputTokens: 500_000, cacheReadTokens: 1_000_000, outputTokens: 500_000 },
      DEEPSEEK_PRICE,
    );
    expect(cost).toBeCloseTo(0.756, 12);
  });

  it("clamps non-finite / negative inputs to 0 (never NaN)", () => {
    const bad: PredictUsage = { inputTokens: Number.NaN, cacheReadTokens: Number.POSITIVE_INFINITY, outputTokens: -5 };
    expect(usageCostUsd(bad, DEEPSEEK_PRICE)).toBe(0);
    const badPrice: PredictPrice = { inputPerM: Number.NaN, cacheReadPerM: 0, outputPerM: 0 };
    expect(Number.isFinite(usageCostUsd({ inputTokens: 1, cacheReadTokens: 0, outputTokens: 0 }, badPrice))).toBe(true);
  });
});

describe("usableUsage / usablePrice (flight 与 settle 共用的结算口径)", () => {
  it("usableUsage requires all three token fields finite and non-negative", () => {
    expect(usableUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBe(true);
    expect(usableUsage({ inputTokens: 1000, cacheReadTokens: 5, outputTokens: 50 })).toBe(true);
    expect(usableUsage(undefined)).toBe(false);
    expect(usableUsage({ inputTokens: Number.NaN, cacheReadTokens: 0, outputTokens: 0 })).toBe(false);
    expect(usableUsage({ inputTokens: 0, cacheReadTokens: Number.POSITIVE_INFINITY, outputTokens: 0 })).toBe(false);
    expect(usableUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: -1 })).toBe(false);
  });

  it("usablePrice requires all three rate fields finite and non-negative", () => {
    expect(usablePrice(DEEPSEEK_PRICE)).toBe(true);
    expect(usablePrice(undefined)).toBe(false);
    expect(usablePrice({ inputPerM: Number.NaN, cacheReadPerM: 0, outputPerM: 0 })).toBe(false);
    expect(usablePrice({ inputPerM: 0, cacheReadPerM: Number.NEGATIVE_INFINITY, outputPerM: 0 })).toBe(false);
    expect(usablePrice({ inputPerM: 0, cacheReadPerM: 0, outputPerM: -0.5 })).toBe(false);
  });

  it("settle falls back to the reserve when usage OR price is unusable (never usage-cost 0)", () => {
    const { ledger } = makeLedger();
    const r1 = mustReserve(ledger, local(2026, 11, 4), 0.001);
    ledger.settle(r1, { inputTokens: Number.NaN, cacheReadTokens: 0, outputTokens: 0 }, DEEPSEEK_PRICE);
    const r2 = mustReserve(ledger, local(2026, 11, 4), 0.002);
    ledger.settle(
      r2,
      { inputTokens: 450, cacheReadTokens: 0, outputTokens: 60 },
      {
        inputPerM: 0.3,
        cacheReadPerM: 0.006,
        outputPerM: Number.NaN,
      },
    );
    expect(ledger.snapshot(local(2026, 11, 4)).spent).toBeCloseTo(0.003, 12);
  });
});

describe("reserve", () => {
  it("reserves an estimate and counts a call", () => {
    const { ledger } = makeLedger();
    expect(ledger.reserve(local(2026, 11, 4), 0.25).ok).toBe(true);
    expect(ledger.snapshot(local(2026, 11, 4))).toEqual({ dayKey: "2026-11-04", spent: 0, reserved: 0.25, calls: 1 });
  });

  it("rejects when projected spend exceeds the USD limit (usd)", () => {
    const { ledger } = makeLedger({ maxUsdPerDay: 1 });
    expect(ledger.reserve(local(2026, 11, 4), 0.5).ok).toBe(true);
    expect(ledger.reserve(local(2026, 11, 4), 0.5).ok).toBe(true); // 0.5 + 0.5 = 1.0 恰好等于上限 ⇒ 放行
    expect(ledger.reserve(local(2026, 11, 4), 0.125)).toEqual({ ok: false, reason: "usd" });
    expect(ledger.snapshot(local(2026, 11, 4)).reserved).toBe(1);
  });

  it("rejects when the call cap is reached (calls)", () => {
    const { ledger } = makeLedger({ maxCallsPerDay: 2 });
    expect(ledger.reserve(local(2026, 11, 4), 0.1).ok).toBe(true);
    expect(ledger.reserve(local(2026, 11, 4), 0.1).ok).toBe(true);
    expect(ledger.reserve(local(2026, 11, 4), 0.1)).toEqual({ ok: false, reason: "calls" });
    expect(ledger.snapshot(local(2026, 11, 4)).calls).toBe(2);
  });

  it("rejects invalid estimates (NaN / Infinity / negative / zero) without corrupting state", () => {
    const { ledger } = makeLedger();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(ledger.reserve(local(2026, 11, 4), bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(ledger.snapshot(local(2026, 11, 4))).toEqual({ dayKey: "2026-11-04", spent: 0, reserved: 0, calls: 0 });
  });

  it("rejects everything when maxUsdPerDay is 0", () => {
    const { ledger } = makeLedger({ maxUsdPerDay: 0 });
    expect(ledger.reserve(local(2026, 11, 4), 0.001)).toEqual({ ok: false, reason: "usd" });
  });

  it("rejects everything when maxCallsPerDay is 0", () => {
    const { ledger } = makeLedger({ maxCallsPerDay: 0 });
    expect(ledger.reserve(local(2026, 11, 4), 0.001)).toEqual({ ok: false, reason: "calls" });
  });

  it("allows concurrent reservations up to the limit, then rejects (spent + reserved ≤ max)", () => {
    const { ledger } = makeLedger({ maxUsdPerDay: 1 });
    for (let i = 0; i < 4; i++) expect(ledger.reserve(local(2026, 11, 4), 0.25).ok).toBe(true);
    expect(ledger.reserve(local(2026, 11, 4), 0.25)).toEqual({ ok: false, reason: "usd" });
    const snap = ledger.snapshot(local(2026, 11, 4));
    expect(snap.reserved).toBe(1);
    expect(snap.spent + snap.reserved).toBeLessThanOrEqual(1);
  });
});

describe("settle", () => {
  it("settles by usage × price when usage is truthfully returned", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4), 0.0012); // 最坏预留
    ledger.settle(r, { inputTokens: 450, cacheReadTokens: 0, outputTokens: 60 }, DEEPSEEK_PRICE);
    // 450×0.30 + 60×1.20 = 135 + 72 = 207 / 1e6 = $0.000207。
    expect(ledger.snapshot(local(2026, 11, 4)).spent).toBeCloseTo(0.000207, 12);
    expect(ledger.snapshot(local(2026, 11, 4)).reserved).toBe(0);
  });

  it("settles by the reserved amount when usage is absent (failure / abort / timeout)", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4), 0.0012);
    ledger.settle(r); // 无 usage ⇒ 按预留结算
    expect(ledger.snapshot(local(2026, 11, 4)).spent).toBeCloseTo(0.0012, 12);
    expect(ledger.snapshot(local(2026, 11, 4)).reserved).toBe(0);
  });

  it("settles by the reserved amount when usage is non-finite (no free call, no NaN)", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4), 0.0012);
    const bad: PredictUsage = { inputTokens: Number.NaN, cacheReadTokens: 0, outputTokens: 0 };
    ledger.settle(r, bad, DEEPSEEK_PRICE);
    expect(ledger.snapshot(local(2026, 11, 4)).spent).toBeCloseTo(0.0012, 12);
  });

  it("is idempotent (double settle records once)", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4), 0.5);
    ledger.settle(r);
    ledger.settle(r);
    expect(ledger.snapshot(local(2026, 11, 4)).spent).toBeCloseTo(0.5, 12);
    expect(ledger.snapshot(local(2026, 11, 4)).reserved).toBe(0);
  });

  it("never lets spent + reserved exceed the limit even when usage exceeds the reserve", () => {
    const { ledger } = makeLedger({ maxUsdPerDay: 1 });
    const r = mustReserve(ledger, local(2026, 11, 4), 0.25);
    // usage 折算 $0.30 > 预留 $0.25 ⇒ 按预留额结算（§9.3 下界口径），不得突破上限。
    ledger.settle(r, { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }, DEEPSEEK_PRICE);
    const snap = ledger.snapshot(local(2026, 11, 4));
    expect(snap.spent).toBeCloseTo(0.25, 12);
    expect(snap.spent + snap.reserved).toBeLessThanOrEqual(1);
  });
});

describe("release", () => {
  it("frees the reserved amount without charging", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4), 0.5);
    ledger.release(r);
    expect(ledger.snapshot(local(2026, 11, 4))).toEqual({ dayKey: "2026-11-04", spent: 0, reserved: 0, calls: 1 });
  });

  it("is idempotent", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4), 0.5);
    ledger.release(r);
    ledger.release(r);
    expect(ledger.snapshot(local(2026, 11, 4)).reserved).toBe(0);
  });

  it("settle then release (and release then settle) is a no-op", () => {
    const { ledger } = makeLedger();
    const r1 = mustReserve(ledger, local(2026, 11, 4), 0.5);
    const r2 = mustReserve(ledger, local(2026, 11, 4), 0.25);
    ledger.settle(r1);
    ledger.release(r1); // 已结算 ⇒ no-op
    ledger.release(r2);
    ledger.settle(r2); // 已释放 ⇒ no-op
    const snap = ledger.snapshot(local(2026, 11, 4));
    expect(snap.spent).toBeCloseTo(0.5, 12);
    expect(snap.reserved).toBe(0);
    expect(snap.calls).toBe(2); // calls 不因 release 回退
  });
});

describe("cross-day reset", () => {
  it("resets spent / reserved / calls at local midnight", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4, 23), 0.5);
    ledger.settle(r);
    expect(ledger.snapshot(local(2026, 11, 4, 23)).spent).toBeCloseTo(0.5, 12);

    const next = ledger.snapshot(local(2026, 11, 5, 0));
    expect(next).toEqual({ dayKey: "2026-11-05", spent: 0, reserved: 0, calls: 0 });
    expect(ledger.reserve(local(2026, 11, 5), 1).ok).toBe(true); // 新日全额可用
  });

  it("applies settle to the reservation's originating day (captured at reserve time)", () => {
    const { ledger } = makeLedger();
    const r = mustReserve(ledger, local(2026, 11, 4, 23, 59, 59), 0.5);
    ledger.settle(r); // 无 now 参数：记回 2026-11-04
    expect(ledger.snapshot(local(2026, 11, 4)).spent).toBeCloseTo(0.5, 12);
    expect(ledger.snapshot(local(2026, 11, 5)).spent).toBe(0);
  });
});

describe("8-day GC", () => {
  it("evicts the oldest day beyond MAX_LEDGER_DAYS", () => {
    const table = new Map<DayKey, DayLedger>();
    const { ledger } = makeLedger({}, table);
    for (let i = 0; i < MAX_LEDGER_DAYS + 3; i++) {
      expect(ledger.reserve(local(2026, 11, 1 + i), 0.01).ok).toBe(true); // 11-01 … 11-11
    }
    expect(table.size).toBe(MAX_LEDGER_DAYS);
    expect(table.has("2026-11-01")).toBe(false); // 最旧被淘汰
    expect(table.has("2026-11-11")).toBe(true); // 最新保留
  });
});

describe("failover tiers", () => {
  it("each tier reserves independently and settles independently", () => {
    const { ledger } = makeLedger({ maxUsdPerDay: 1 });
    const t1 = mustReserve(ledger, local(2026, 11, 4), 0.00075); // 第一档
    const t2 = mustReserve(ledger, local(2026, 11, 4), 0.0012); // 第二档（其自身价目）
    expect(ledger.snapshot(local(2026, 11, 4)).reserved).toBeCloseTo(0.00195, 12);

    // 第一档失败（无 usage）⇒ 按预留结算；第二档仍在飞。
    ledger.settle(t1);
    let snap = ledger.snapshot(local(2026, 11, 4));
    expect(snap.spent).toBeCloseTo(0.00075, 12);
    expect(snap.reserved).toBeCloseTo(0.0012, 12);

    // 第二档如实返回 usage ⇒ 按 usage 结算。
    ledger.settle(t2, { inputTokens: 450, cacheReadTokens: 0, outputTokens: 60 }, DEEPSEEK_PRICE);
    snap = ledger.snapshot(local(2026, 11, 4));
    expect(snap.spent).toBeCloseTo(0.00075 + 0.000207, 12);
    expect(snap.reserved).toBe(0);
  });
});

describe("config sanitization", () => {
  it("non-finite / negative config values are clamped to 0 (deny-all, never bypass)", () => {
    const nan = makeLedger({ maxUsdPerDay: Number.NaN });
    expect(nan.ledger.reserve(local(2026, 11, 4), 0.001)).toEqual({ ok: false, reason: "usd" });

    const neg = makeLedger({ maxUsdPerDay: -3 });
    expect(neg.ledger.reserve(local(2026, 11, 4), 0.001)).toEqual({ ok: false, reason: "usd" });

    const inf = makeLedger({ maxCallsPerDay: Number.POSITIVE_INFINITY });
    expect(inf.ledger.reserve(local(2026, 11, 4), 0.001)).toEqual({ ok: false, reason: "calls" });
  });
});

describe("invariant: spent + reserved ≤ maxUsdPerDay", () => {
  it("holds at every step of a mixed reserve / settle / release sequence with truthful usage", () => {
    const { ledger } = makeLedger({ maxUsdPerDay: 1 });
    const now = local(2026, 11, 4, 10);

    const check = (): void => {
      const s = ledger.snapshot(now);
      expect(Number.isFinite(s.spent)).toBe(true);
      expect(Number.isFinite(s.reserved)).toBe(true);
      expect(s.spent + s.reserved).toBeLessThanOrEqual(1);
    };

    const a = mustReserve(ledger, now, 0.5);
    check();
    const b = mustReserve(ledger, now, 0.25);
    check();
    const c = mustReserve(ledger, now, 0.125);
    check();
    ledger.settle(b, { inputTokens: 100_000, cacheReadTokens: 0, outputTokens: 0 }, DEEPSEEK_PRICE); // $0.03 < 0.25
    check();
    ledger.release(c);
    check();
    ledger.settle(a); // 按预留结算 0.5
    check();
    expect(ledger.reserve(now, 0.4).ok).toBe(true); // 0.5 + 0.4 = 0.9 ≤ 1
    check();
    expect(ledger.reserve(now, 0.2)).toEqual({ ok: false, reason: "usd" }); // 0.9 + 0.2 > 1 ⇒ 拒
    check();
  });
});
