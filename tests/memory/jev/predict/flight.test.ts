// flight.ts unit tests (plan.md v3.2 §11.2 flight 列表；§8.2 请求链状态机).

import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../../src/core/clock.js";
import type { Clock } from "../../../../src/core/clock.js";
import {
  attemptBudgetMs,
  BREAKER_OPEN_MS,
  createPredictFlight,
  estimateInputTokens,
  estimatePredictUsd,
  type PredictFlight,
  type PredictFlightInput,
  type PredictFlightModel,
  type PredictFlightPort,
} from "../../../../src/memory/jev/predict/flight.js";
import { createPredictLedger } from "../../../../src/memory/jev/predict/ledger.js";
import type { PredictPrice, PredictUsage } from "../../../../src/memory/jev/predict/ledger.js";

const SYSTEM = "system prompt";
const USER = `{"v":1,"request":"fix it"}`;
const DEEPSEEK: PredictPrice = { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 };
const USAGE: PredictUsage = { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 50 };

function makeFlight(overrides: Partial<Parameters<typeof createPredictFlight>[1]> = {}): {
  flight: PredictFlight;
  clock: FakeClock;
} {
  const clock = new FakeClock(0);
  const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 100, maxUsdPerDay: 1 });
  const flight = createPredictFlight(ledger, {
    requestBudgetMs: 3000,
    maxCallsPerDay: 100,
    maxUsdPerDay: 1,
    clock,
    ...overrides,
  });
  return { flight, clock };
}

function input(models: readonly PredictFlightModel[], signal?: AbortSignal): PredictFlightInput {
  return { system: SYSTEM, user: USER, models, ...(signal === undefined ? {} : { signal }) };
}

function model(provider: string, id: string, port: PredictFlightPort, price?: PredictPrice): PredictFlightModel {
  return { provider, id, port, ...(price === undefined ? {} : { price }) };
}

/** 立即 resolve 一档。 */
function okPort(text = '{"tags":[]}', usage?: PredictUsage): PredictFlightPort {
  return { complete: () => Promise.resolve({ text, ...(usage === undefined ? {} : { usage }) }) };
}

/** 立即 reject 一档（真实错误）。 */
function errorPort(): PredictFlightPort {
  return { complete: () => Promise.reject(new Error("boom")) };
}

/** 悬挂且尊重 abort 的一档：signal.abort 时 reject，否则永不 settle。 */
function slowRespectingPort(): PredictFlightPort {
  return {
    complete: (_s, _u, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
}

/** 悬挂且无视 abort 的一档：永不 settle，也不监听 signal。 */
function hangingPort(): {
  port: PredictFlightPort;
  resolve: (v: { text: string }) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: { text: string }) => void;
  let reject!: (e: unknown) => void;
  const port: PredictFlightPort = {
    complete: () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  };
  return { port, resolve: (v) => resolve(v), reject: (e) => reject(e) };
}

/** 冲洗若干轮微任务（FakeClock.advance 是同步的，链的 await 续延靠微任务推进）。 */
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("estimatePredictUsd / attemptBudgetMs", () => {
  it("estimates input tokens from UTF-8 bytes (≥1) and computes reserve with output allowance", () => {
    // 13B（system prompt）+ 26B（user） = 39B × 0.4 = 15.6 → ceil 16；(16 × 0.3 + 384 × 1.2)/1e6。
    expect(estimateInputTokens(SYSTEM, USER)).toBe(16);
    const expected = (16 * 0.3 + 384 * 1.2) / 1e6;
    expect(estimatePredictUsd(SYSTEM, USER, DEEPSEEK)).toBeCloseTo(expected, 12);
  });

  it("attemptBudgetMs = min(remaining, ceil(budget/2)) and is non-negative", () => {
    expect(attemptBudgetMs(3000, 3000)).toBe(1500);
    expect(attemptBudgetMs(3000, 1500)).toBe(1500);
    expect(attemptBudgetMs(3000, 500)).toBe(500);
    expect(attemptBudgetMs(3000, 0)).toBe(0);
    expect(attemptBudgetMs(3000, -10)).toBe(0);
  });
});

describe("admit", () => {
  it("rejects when there is an in-flight flight", async () => {
    const { flight, clock } = makeFlight();
    const hang = hangingPort();
    const p = flight.start(input([model("p", "m", hang.port)]));
    expect(flight.admit(input([model("p", "m", hang.port)]))).toBe(false);
    // 收尾：让 flight 结束，避免悬挂。
    clock.advance(3500);
    await p;
  });

  it("rejects when the day budget is exhausted", () => {
    const { flight } = makeFlight({ maxUsdPerDay: 0.0001 });
    expect(flight.admit(input([model("p", "m", okPort(), DEEPSEEK)]))).toBe(false);
  });

  it("rejects empty model chains", () => {
    const { flight } = makeFlight();
    expect(flight.admit(input([]))).toBe(false);
  });
});

describe("start · ok / failed", () => {
  it("settles by usage when the port reports usage and a price is available", async () => {
    const { flight } = makeFlight();
    const outcome = await flight.start(input([model("deepseek", "deepseek-flash", okPort("ok", USAGE), DEEPSEEK)]));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.model).toBe("deepseek/deepseek-flash");
    expect(outcome.cost.costSource).toBe("usage");
    expect(outcome.cost.costUsd).toBeCloseTo((1000 * 0.3 + 50 * 1.2) / 1e6, 12);
    expect(outcome.cost.reserveUsd).toBeGreaterThan(0);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.kind).toBe("ok");
  });

  it("settles by reserve when usage is missing (无 usage 按预留)", async () => {
    const { flight } = makeFlight();
    const outcome = await flight.start(input([model("deepseek", "deepseek-flash", okPort("ok"), DEEPSEEK)]));
    expect(outcome.kind).toBe("ok");
    expect(outcome.cost.costSource).toBe("reserve");
    expect(outcome.cost.costUsd).toBeCloseTo(outcome.cost.reserveUsd, 12);
  });

  it("fails on error and settles by reserve, then releases the flight", async () => {
    const { flight, clock } = makeFlight();
    const outcome = await flight.start(input([model("p", "m", errorPort(), DEEPSEEK)]));
    expect(outcome.kind).toBe("failed");
    expect(outcome.cost.costSource).toBe("reserve");
    expect(outcome.attempts[0]!.kind).toBe("error");
    expect(flight.isInFlight()).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("start · 非法 usage/price 按预留结算（M1）", () => {
  /** 带可观测 ledger 的 flight（结算口径须与账本一致）。 */
  function flightWithLedger(): {
    flight: PredictFlight;
    ledger: ReturnType<typeof createPredictLedger>;
    now: () => number;
  } {
    const clock = new FakeClock(0);
    const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 100, maxUsdPerDay: 1 });
    const flight = createPredictFlight(ledger, {
      requestBudgetMs: 3000,
      maxCallsPerDay: 100,
      maxUsdPerDay: 1,
      clock,
    });
    return { flight, ledger, now: () => clock.now() };
  }

  it("ok with non-finite/negative usage settles by reserve, never costSource:'usage' with costUsd=0", async () => {
    const badUsages: PredictUsage[] = [
      { inputTokens: Number.NaN, cacheReadTokens: 0, outputTokens: 0 },
      { inputTokens: 1000, cacheReadTokens: Number.POSITIVE_INFINITY, outputTokens: 50 },
      { inputTokens: 1000, cacheReadTokens: 0, outputTokens: -5 },
      { inputTokens: -1, cacheReadTokens: -1, outputTokens: -1 },
    ];
    for (const bad of badUsages) {
      const { flight, ledger, now } = flightWithLedger();
      const outcome = await flight.start(input([model("deepseek", "deepseek-flash", okPort("ok", bad), DEEPSEEK)]));
      expect(outcome.kind).toBe("ok");
      // flight 与 ledger 一样按预留结算：costSource=reserve 且 costUsd=reserveUsd。
      expect(outcome.cost.costSource).toBe("reserve");
      expect(outcome.cost.costUsd).toBeCloseTo(outcome.cost.reserveUsd, 12);
      expect(outcome.cost.costUsd).toBeGreaterThan(0);
      expect(outcome.attempts[0]!.costSource).toBe("reserve");
      expect(outcome.attempts[0]!.costUsd).toBeCloseTo(outcome.attempts[0]!.reserveUsd, 12);
      // 账本侧也按预留入账（不是 0），两边口径一致。
      expect(ledger.snapshot(now()).spent).toBeCloseTo(outcome.cost.reserveUsd, 12);
    }
  });

  it("ok with an invalid price settles by reserve even when usage is valid", async () => {
    const badPrices: PredictPrice[] = [
      { inputPerM: Number.NaN, cacheReadPerM: 0.006, outputPerM: 1.2 },
      { inputPerM: 0.3, cacheReadPerM: Number.NEGATIVE_INFINITY, outputPerM: 1.2 },
      { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: -0.1 },
    ];
    for (const bad of badPrices) {
      const { flight, ledger, now } = flightWithLedger();
      const outcome = await flight.start(input([model("deepseek", "deepseek-flash", okPort("ok", USAGE), bad)]));
      expect(outcome.kind).toBe("ok");
      expect(outcome.cost.costSource).toBe("reserve");
      expect(outcome.cost.costUsd).toBeCloseTo(outcome.cost.reserveUsd, 12);
      expect(ledger.snapshot(now()).spent).toBeCloseTo(outcome.cost.reserveUsd, 12);
    }
  });

  it("valid usage with valid price still settles by usage（合法路径语义不变）", async () => {
    const { flight, ledger, now } = flightWithLedger();
    const outcome = await flight.start(input([model("deepseek", "deepseek-flash", okPort("ok", USAGE), DEEPSEEK)]));
    expect(outcome.kind).toBe("ok");
    expect(outcome.cost.costSource).toBe("usage");
    const usageCost = (1000 * 0.3 + 50 * 1.2) / 1e6;
    expect(outcome.cost.costUsd).toBeCloseTo(usageCost, 12);
    expect(ledger.snapshot(now()).spent).toBeCloseTo(usageCost, 12);
  });

  it("missing usage still settles by reserve（无 usage 语义不变）", async () => {
    const { flight, ledger, now } = flightWithLedger();
    const outcome = await flight.start(input([model("deepseek", "deepseek-flash", okPort("ok"), DEEPSEEK)]));
    expect(outcome.kind).toBe("ok");
    expect(outcome.cost.costSource).toBe("reserve");
    expect(ledger.snapshot(now()).spent).toBeCloseTo(outcome.cost.reserveUsd, 12);
  });
});

describe("start · failover", () => {
  it("moves to the second tier with the remaining budget when the first hangs (respects abort)", async () => {
    const { flight, clock } = makeFlight();
    const p = flight.start(
      input([model("a", "first", slowRespectingPort(), DEEPSEEK), model("b", "second", okPort("ok", USAGE), DEEPSEEK)]),
    );
    clock.advance(1500); // 首档计时器到点 → abort → 尊重 abort ⇒ failover
    await flush();
    clock.advance(1500); // 第二档计时器（剩余 1500）到点前其实已完成
    const outcome = await p;
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.model).toBe("b/second");
    // 首档按预留结算（无 usage），第二档按 usage 结算。
    expect(outcome.attempts.map((a) => a.kind)).toEqual(["timeout", "ok"]);
    expect(outcome.attempts[0]!.costSource).toBe("reserve");
    expect(outcome.attempts[1]!.costSource).toBe("usage");
    expect(clock.pendingTimers).toBe(0);
  });

  it("gives up at the total deadline when both tiers hang (总期限到达即放弃)", async () => {
    const { flight, clock } = makeFlight();
    const p = flight.start(
      input([
        model("a", "first", slowRespectingPort(), DEEPSEEK),
        model("b", "second", slowRespectingPort(), DEEPSEEK),
      ]),
    );
    clock.advance(1500); // 首档 failover
    await flush();
    clock.advance(1500); // 第二档 failover，总期限到达
    await flush();
    const outcome = await p;
    expect(outcome.kind).toBe("failed");
    expect(outcome.ms).toBe(3000);
    expect(outcome.attempts.map((a) => a.kind)).toEqual(["timeout", "timeout"]);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("start · timeout / zombie", () => {
  it("provider 永不 resolve 且无视 abort ⇒ 外层期限触发，zombies=1，下一轮不准入；zombie settle 后恢复", async () => {
    const { flight, clock } = makeFlight();
    const hang = hangingPort();
    const p = flight.start(input([model("p", "m", hang.port, DEEPSEEK)]));
    clock.advance(1500); // 首档计时器到点 → abort，provider 无视 → 悬挂
    clock.advance(2000); // 外层期限（3500）触发
    const outcome = await p;
    expect(outcome.kind).toBe("timeout");
    expect(flight.zombies()).toBe(1);
    expect(flight.isInFlight()).toBe(false);
    expect(flight.admit(input([model("p", "m", okPort())]))).toBe(false); // 拒绝后续准入

    // zombie settle 后恢复准入。
    hang.resolve({ text: "late" });
    await flush();
    expect(flight.zombies()).toBe(0);
    expect(flight.admit(input([model("p", "m", okPort())]))).toBe(true);
  });

  it("discards the late result (token 丢弃迟到结果) and keeps no residual timers after an hour", async () => {
    const { flight, clock } = makeFlight();
    const hang = hangingPort();
    const p = flight.start(input([model("p", "m", hang.port, DEEPSEEK)]));
    clock.advance(3500);
    const outcome = await p;
    expect(outcome.kind).toBe("timeout");
    // 迟到的 resolve 只触发 zombie 减回，不再投递任何结果。
    hang.resolve({ text: "late" });
    await flush();
    expect(flight.zombies()).toBe(0);
    clock.advance(60 * 60_000); // 空闲 1 小时
    expect(clock.pendingTimers).toBe(0);
    expect(flight.isInFlight()).toBe(false);
  });

  it("a normal ok flight leaves no residual timers after one idle hour", async () => {
    const { flight, clock } = makeFlight();
    const outcome = await flight.start(input([model("p", "m", okPort("ok"), DEEPSEEK)]));
    expect(outcome.kind).toBe("ok");
    expect(clock.pendingTimers).toBe(0);
    expect(flight.isInFlight()).toBe(false);
    clock.advance(60 * 60_000);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe("breaker", () => {
  it("opens after 3 consecutive failures and closes after 10 minutes", async () => {
    const { flight, clock } = makeFlight();
    const failing = input([model("p", "m", errorPort(), DEEPSEEK)]);
    for (let i = 0; i < 3; i++) {
      const outcome = await flight.start(failing);
      expect(outcome.kind).toBe("failed");
    }
    expect(flight.isBreakerOpen()).toBe(true);
    expect(flight.admit(failing)).toBe(false);

    clock.advance(BREAKER_OPEN_MS);
    expect(flight.isBreakerOpen()).toBe(false);
    expect(flight.admit(failing)).toBe(true);
  });

  it("a success resets the consecutive failure count", async () => {
    const { flight } = makeFlight();
    const failing = input([model("p", "m", errorPort(), DEEPSEEK)]);
    await flight.start(failing);
    await flight.start(failing);
    // 第三次前成功 ⇒ 计数复位，不打开。
    await flight.start(input([model("p", "m", okPort("ok"), DEEPSEEK)]));
    await flight.start(failing);
    expect(flight.isBreakerOpen()).toBe(false);
  });
});

describe("shutdown", () => {
  it("aborts the in-flight request, clears timers, disposes, and releases (no settle)", async () => {
    const { flight, clock } = makeFlight();
    const hang = hangingPort();
    const p = flight.start(input([model("p", "m", hang.port, DEEPSEEK)]));
    expect(flight.isInFlight()).toBe(true);

    flight.shutdown();
    const outcome = await p;
    expect(outcome.kind).toBe("aborted");
    expect(flight.isDisposed()).toBe(true);
    expect(flight.isInFlight()).toBe(false);
    expect(clock.pendingTimers).toBe(0);
    // disposed 后 settle 不再产生副作用 ⇒ 预留被 release，无 spent。
    expect(flight.admit(input([model("p", "m", okPort())]))).toBe(false); // disposed 拒绝一切
  });

  it("subsequent start after shutdown is denied with no side effects", async () => {
    const { flight } = makeFlight();
    flight.shutdown();
    const outcome = await flight.start(input([model("p", "m", okPort("ok"), DEEPSEEK)]));
    expect(outcome.kind).toBe("denied");
  });
});

describe("timers & listeners balance (spy)", () => {
  it("returns every attempt's timers and abort listeners to zero", async () => {
    const addSpy = vi.spyOn(EventTarget.prototype, "addEventListener");
    const removeSpy = vi.spyOn(EventTarget.prototype, "removeEventListener");
    // 计时器计数：包一层 FakeClock 统计 set/clear。
    const base = new FakeClock(0);
    let set = 0;
    let clear = 0;
    const clock: Clock = {
      now: () => base.now(),
      setTimer: (ms, fn) => {
        set += 1;
        return base.setTimer(ms, fn);
      },
      clearTimer: (h) => {
        clear += 1;
        base.clearTimer(h);
      },
    };
    const ledger = createPredictLedger(new Map(), { maxCallsPerDay: 100, maxUsdPerDay: 1 });
    const flight = createPredictFlight(ledger, {
      requestBudgetMs: 3000,
      maxCallsPerDay: 100,
      maxUsdPerDay: 1,
      clock,
    });
    try {
      const outcome = await flight.start(input([model("p", "m", okPort("ok"), DEEPSEEK)]));
      expect(outcome.kind).toBe("ok");
      expect(base.pendingTimers).toBe(0);
      expect(set).toBe(clear); // ok 路径：attempt 计时器与 outer 计时器都被清除
      expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});
