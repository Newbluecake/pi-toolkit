// quota-plan §9.2 ladder.test.ts — threshold grid, forecast raising, provider
// aggregation (Kimi week trap), demotion floor, gridStep, stale.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_THRESHOLDS_BY_WINDOW,
  gridStep,
  providerVerdict,
  windowLevel,
} from "../../src/quota/ladder.js";
import type { QuotaWindowsSnapshot } from "../../src/quota/types.js";

const NOW = 1_000_000;
const HOUR = 3_600_000;
const STALE_AFTER_MS = HOUR;

function win(usedPct: number, resetAt?: number) {
  return { scope: "5h" as const, usedPct, ...(resetAt === undefined ? {} : { resetAt }) };
}

function windowsSnapshot(provider: QuotaWindowsSnapshot["provider"], windows: QuotaWindowsSnapshot["windows"]) {
  return { provider, kind: "windows" as const, windows, fetchedAt: NOW };
}

describe("windowLevel", () => {
  it("maps the threshold grid 49/50/74/75/89/90 → L0/L1/L1/L2/L2/L3", () => {
    const cases: readonly [number, 0 | 1 | 2 | 3][] = [
      [49, 0],
      [50, 1],
      [74, 1],
      [75, 2],
      [89, 2],
      [90, 3],
    ];
    for (const [pct, level] of cases) {
      expect(windowLevel(win(pct), { now: NOW, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
        level,
        reason: level === 0 ? "none" : "pct",
      });
    }
  });

  it("treats usedPct >= 100 as L3 exhausted (and clamps out-of-range input)", () => {
    for (const pct of [100, 100.5, 120]) {
      expect(windowLevel(win(pct), { now: NOW, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
        level: 3,
        reason: "exhausted",
        usedPct: 100,
      });
    }
  });

  it("raises 62% to L2 when the forecast exhausts before the window resets (#forecast-before-reset)", () => {
    const resetAt = NOW + 3 * HOUR;
    const v = windowLevel(win(62, resetAt), { now: NOW, etaMs: HOUR, thresholds: DEFAULT_THRESHOLDS });
    expect(v).toMatchObject({ level: 2, reason: "forecast-before-reset" });
    expect(v.resetAt).toBe(resetAt);
    expect(v.etaMs).toBe(HOUR);
  });

  it("raises 62% to L3 when ETA < 30min even with resetAt unknown", () => {
    const v = windowLevel(win(62), { now: NOW, etaMs: 20 * 60_000, thresholds: DEFAULT_THRESHOLDS });
    expect(v).toMatchObject({ level: 3, reason: "forecast-eta" });
  });

  it("does NOT downgrade 90% that is about to reset (no reverse rule)", () => {
    const v = windowLevel(win(90, NOW + 60_000), { now: NOW, thresholds: DEFAULT_THRESHOLDS });
    expect(v).toMatchObject({ level: 3, reason: "pct" });
  });

  it("skips forecast-before-reset when resetAt is undefined (only rule 3a applies)", () => {
    const v = windowLevel(win(62), { now: NOW, etaMs: 2 * HOUR, thresholds: DEFAULT_THRESHOLDS });
    expect(v).toMatchObject({ level: 1, reason: "pct" });
  });

  it("ignores negative etaMs", () => {
    const v = windowLevel(win(62, NOW + 3 * HOUR), { now: NOW, etaMs: -5, thresholds: DEFAULT_THRESHOLDS });
    expect(v).toMatchObject({ level: 1, reason: "pct" });
  });
});

// 规则 0（reset-elapsed）：重置时刻已过的窗口旧读数视同过期——等级 0、不贡献
// provider 最高级（修：「快照未 stale 但窗口已重置」期间的误 L3 闸门/注入）。
describe("windowLevel reset-elapsed", () => {
  it("treats a window whose resetAt has passed as level 0 / reset-elapsed, even at 100% or with a short ETA", () => {
    for (const usedPct of [100, 92, 62]) {
      expect(windowLevel(win(usedPct, NOW - 1), { now: NOW, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
        level: 0,
        reason: "reset-elapsed",
        usedPct,
      });
    }
    // 速率预测不得把已过期窗口重新抬级（跨重置的斜率是垃圾）。
    const forecast = windowLevel(win(100, NOW - 1), {
      now: NOW,
      etaMs: 60_000,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(forecast).toMatchObject({ level: 0, reason: "reset-elapsed" });
    expect(forecast.etaMs).toBeUndefined();
  });

  it("counts the resetAt === now boundary as elapsed, and keeps resetAt === now+1 on the legacy path", () => {
    expect(windowLevel(win(100, NOW), { now: NOW, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
      level: 0,
      reason: "reset-elapsed",
    });
    expect(windowLevel(win(100, NOW + 1), { now: NOW, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
      level: 3,
      reason: "exhausted",
    });
  });

  it("leaves resetAt-unknown windows byte-identical to the legacy behavior", () => {
    expect(windowLevel(win(100), { now: NOW, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
      level: 3,
      reason: "exhausted",
    });
    expect(windowLevel(win(62), { now: NOW, etaMs: 20 * 60_000, thresholds: DEFAULT_THRESHOLDS })).toMatchObject({
      level: 3,
      reason: "forecast-eta",
    });
  });
});

describe("providerVerdict", () => {
  it("takes the max window level: week 100% beats idle 5h #kimi-week-trap", () => {
    const snap = windowsSnapshot("kimi-coding", [
      { scope: "5h", usedPct: 0 },
      { scope: "week", usedPct: 100 },
    ]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    });
    expect(v.level).toBe(3);
    expect(v.windows).toHaveLength(2);
    expect(v.windows[1]).toMatchObject({ scope: "week", level: 3, reason: "exhausted" });
  });

  it("pins a demoted provider at level >= 2 even when windows compute L1 (demotion floor)", () => {
    const snap = windowsSnapshot("zai-coding-cn", [win(60)]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: true,
    });
    expect(v.level).toBe(2);
    expect(v.demoted).toBe(true);
  });

  it("injects etaOf(scope) per window", () => {
    const snap = windowsSnapshot("zai-coding-cn", [win(62, NOW + 3 * HOUR)]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: (scope) => (scope === "5h" ? HOUR : undefined),
      demoted: false,
    });
    expect(v.level).toBe(2);
    expect(v.windows[0]?.reason).toBe("forecast-before-reset");
  });

  it("marks stale only when age exceeds staleAfterMs (strictly)", () => {
    const snap = windowsSnapshot("zai-coding-cn", [win(10)]);
    const base = {
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    } as const;
    expect(providerVerdict({ ...snap, fetchedAt: NOW - STALE_AFTER_MS }, { now: NOW, ...base }).stale).toBe(false);
    expect(providerVerdict({ ...snap, fetchedAt: NOW - STALE_AFTER_MS - 1 }, { now: NOW, ...base }).stale).toBe(true);
  });

  it("carries plan through for HUD display", () => {
    const snap: QuotaWindowsSnapshot = {
      provider: "zai-coding-cn",
      kind: "windows",
      windows: [win(10)],
      fetchedAt: NOW,
      plan: "max",
    };
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    });
    expect(v.plan).toBe("max");
  });

  it("reset-elapsed windows contribute nothing: elapsed week 100% + idle 5h → level 0", () => {
    const snap = windowsSnapshot("kimi-coding", [
      { scope: "5h", usedPct: 8, resetAt: NOW + 3 * HOUR },
      { scope: "week", usedPct: 100, resetAt: NOW - 1 },
    ]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    });
    expect(v.level).toBe(0);
    expect(v.windows[1]).toMatchObject({ scope: "week", level: 0, reason: "reset-elapsed", usedPct: 100 });
  });

  it("still takes the max of live windows: elapsed week + live exhausted 5h → level 3", () => {
    const snap = windowsSnapshot("kimi-coding", [
      { scope: "5h", usedPct: 100, resetAt: NOW + 3 * HOUR },
      { scope: "week", usedPct: 100, resetAt: NOW - 1 },
    ]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    });
    expect(v.level).toBe(3);
    expect(v.windows[0]).toMatchObject({ scope: "5h", level: 3, reason: "exhausted" });
  });

  it("demotion floor is unaffected: every window elapsed + demoted → still pinned at level 2", () => {
    const snap = windowsSnapshot("kimi-coding", [
      { scope: "5h", usedPct: 100, resetAt: NOW - 1 },
      { scope: "week", usedPct: 100, resetAt: NOW - 2 },
    ]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: true,
      demotedUntil: NOW + 6 * HOUR,
    });
    expect(v.level).toBe(2);
    expect(v.windows.every((w) => w.reason === "reset-elapsed")).toBe(true);
  });
});

describe("gridStep", () => {
  it("floors to the linear grid", () => {
    expect(gridStep(62, 10)).toBe(60);
    expect(gridStep(49, 10)).toBe(40);
    expect(gridStep(100, 10)).toBe(100);
    expect(gridStep(0, 10)).toBe(0);
  });

  it("returns 0 when step <= 0 (grid gate disabled) or input is NaN", () => {
    expect(gridStep(62, 0)).toBe(0);
    expect(gridStep(62, -5)).toBe(0);
    expect(gridStep(Number.NaN, 10)).toBe(0);
  });
});

// 阶梯阈值按窗口区分：providerVerdict 的 thresholds 支持按 scope 解析的函数
// （service.ts 实际传入的形态），5h 与 week 的默认阈值应各自独立生效。
describe("providerVerdict per-window thresholds", () => {
  const byWindow = (scope: "5h" | "week") => DEFAULT_THRESHOLDS_BY_WINDOW[scope];

  it("week 94% stays L1, 95% raises to L2, 98% raises to L3 (week defaults 50/95/98)", () => {
    const cases: readonly [number, 0 | 1 | 2 | 3][] = [
      [94, 1],
      [95, 2],
      [98, 3],
    ];
    for (const [pct, level] of cases) {
      const snap = windowsSnapshot("kimi-coding", [{ scope: "week", usedPct: pct }]);
      const v = providerVerdict(snap, {
        now: NOW,
        thresholds: byWindow,
        staleAfterMs: STALE_AFTER_MS,
        etaOf: () => undefined,
        demoted: false,
      });
      expect(v.level, `pct=${pct}`).toBe(level);
    }
  });

  it("5h 75% raises to L2, 90% raises to L3 (5h defaults 50/75/90, unchanged)", () => {
    const cases: readonly [number, 0 | 1 | 2 | 3][] = [
      [75, 2],
      [90, 3],
    ];
    for (const [pct, level] of cases) {
      const snap = windowsSnapshot("kimi-coding", [{ scope: "5h", usedPct: pct }]);
      const v = providerVerdict(snap, {
        now: NOW,
        thresholds: byWindow,
        staleAfterMs: STALE_AFTER_MS,
        etaOf: () => undefined,
        demoted: false,
      });
      expect(v.level, `pct=${pct}`).toBe(level);
    }
  });

  it("judges the two windows independently in the same snapshot: 5h 75% (L2) vs week 75% (still L1)", () => {
    const snap = windowsSnapshot("kimi-coding", [
      { scope: "5h", usedPct: 75 },
      { scope: "week", usedPct: 75 },
    ]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: byWindow,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    });
    expect(v.windows.find((w) => w.scope === "5h")).toMatchObject({ level: 2 });
    expect(v.windows.find((w) => w.scope === "week")).toMatchObject({ level: 1 });
    expect(v.level).toBe(2); // max across windows
  });

  it("also accepts a single flat LadderThresholds (back-compat call shape used elsewhere)", () => {
    const snap = windowsSnapshot("kimi-coding", [win(80)]);
    const v = providerVerdict(snap, {
      now: NOW,
      thresholds: DEFAULT_THRESHOLDS,
      staleAfterMs: STALE_AFTER_MS,
      etaOf: () => undefined,
      demoted: false,
    });
    expect(v.level).toBe(2);
  });
});
