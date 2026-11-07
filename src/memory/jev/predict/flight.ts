// 预测模型请求链状态机（plan.md v3.2 §8.2，P2 `predict/flight.ts`）。
// pi-free：只 import node:buffer + core 的 clock/deadline + 本包 ledger；无模块级
// 可变状态（I4，全部状态在 createPredictFlight 实例闭包里）。不绑定真实
// modelRegistry——wire 包照 topic-switch `runJudge` 的同款写法把
// `modelRegistry.complete` 适配成 `PredictFlightPort`（本文件不 import 它）。
//
// 语义（§8.2/§9.2）：
//   - admit：flight 未在飞 ∧ zombies=0 ∧ breaker 闭合 ∧ 日计数/估算预算允许（只读，无副作用）。
//   - start：全链 deadlineAt = now + requestBudgetMs；逐模型 failover，每档独立 reserve，
//     attemptTimeout：链上最后一档直接用全部剩余预算（#36 §6.5：单档链不再被
//     budget/2 掐断），其余档 = min(剩余, ceil(requestBudgetMs/2))，剩余 ≤0 即停止
//     failover。
//     每次尝试有自己的计时器与 abort 监听，在该尝试结束时移除。档位的 price 非法
//     （非有限/负值）时估算退回 estimatePrice 保守预留（不让 NaN 估算静默拒发），
//     结算仍按该档自身 price 判定（不可用 ⇒ 按预留）。
//   - 外层 race(chain, timer(deadlineAt+500))：不依赖 provider 响应 abort。provider
//     无视 abort（永不 settle）时外层期限释放 flight，悬挂 promise 记为 zombie（阻止
//     后续准入），zombie settle 后恢复；迟到结果按 flight 语义丢弃（chain 已按 abort
//     结算，迟到的 resolve 只触发 zombie 减回）。
//   - 结算：有 usage 且价目可用（两者均经 ledger 的 usableUsage/usablePrice 校验——
//     任一字段非有限/负值/缺失都视为不可用）⇒ usage×价目；否则（失败/abort/超时/
//     非法 usage/非法价目）按预留额，flight 与 ledger 的 costSource/costUsd 口径严格
//     一致，绝不出现 ledger 按预留入账而 flight 报 costSource:"usage" 且 costUsd=0
//     的背离（M1）；shutdown（disposed）后 settle 不再产生副作用（改 release）。
//   - 断路器：连续 3 次失败打开 10min（segmented clock，unref）；ok 复位。

import { Buffer } from "node:buffer";
import type { Clock, TimerHandle } from "../../../core/clock.js";
import { systemClock } from "../../../core/clock.js";
import { clampSpanMs } from "../../../core/deadline.js";
import { usablePrice, usableUsage, usageCostUsd } from "./ledger.js";
import type { PredictLedger, PredictPrice, PredictUsage, Reservation } from "./ledger.js";

// ───────────────────────────── 常量（§8.1/§8.2/§9.1） ─────────────────────────────

/** §8.1 requestBudgetMs 缺省（1000–6000）。 */
export const DEFAULT_REQUEST_BUDGET_MS = 3_000;
/** 外层 race 的宽限：deadlineAt + 500（§8.2）。 */
export const OUTER_GRACE_MS = 500;
/** 连续失败打开断路器的阈值（§8.2）。 */
export const BREAKER_THRESHOLD = 3;
/** 断路器打开时长（§8.2）。 */
export const BREAKER_OPEN_MS = 10 * 60_000;
/** §9.1 输出 token 上限（预留用）。 */
export const MAX_OUTPUT_TOKENS = 384;
/** deepseek 价目（§9.1；estimate 缺省价目）。 */
export const DEEPSEEK_PRICE: PredictPrice = { inputPerM: 0.3, cacheReadPerM: 0.006, outputPerM: 1.2 };

// ───────────────────────────── 端口 ─────────────────────────────

/** 单次模型调用的完成：原始回复文本 + 可选 usage（§9.2 如实返回时按 usage 结算）。 */
export interface PredictFlightCompletion {
  readonly text: string;
  readonly usage?: PredictUsage;
}

/** 单档调用端口：围绕 `PredictLlmPort.complete(system, user, signal)` 同款签名，
 *  返回值多带一个可选的 `usage`（wire 把 `modelRegistry.complete` 的 usage 透传）。 */
export interface PredictFlightPort {
  complete(system: string, user: string, signal: AbortSignal): Promise<PredictFlightCompletion>;
}

/** failover 链上的一档：已解析的模型引用 + 价目（可选，缺省时结算退回按预留）。 */
export interface PredictFlightModel {
  readonly provider: string;
  readonly id: string;
  readonly price?: PredictPrice;
  readonly port: PredictFlightPort;
}

// ───────────────────────────── 估算（§9.2） ─────────────────────────────

/** 估算输入 token：system + user 的 UTF-8 字节按 ~2.5B/token 折算（对齐 §9.1 最坏
 *  2500 token @ 6144B user），向上取整、至少 1。 */
export function estimateInputTokens(system: string, user: string): number {
  const bytes = Buffer.byteLength(system, "utf8") + Buffer.byteLength(user, "utf8");
  return Math.max(1, Math.ceil(bytes * 0.4));
}

/** §9.2 派发前估算预留：估算输入 token × 未命中价 + 384 × 输出价（$/1M）。 */
export function estimatePredictUsd(system: string, user: string, price: PredictPrice): number {
  return (estimateInputTokens(system, user) * price.inputPerM + MAX_OUTPUT_TOKENS * price.outputPerM) / 1e6;
}

/** §8.2 attemptTimeout；#36 §6.5 修复——`isLastAttempt`（链上最后一档）直接
 *  用全部剩余预算（单模型链即拿满 requestBudgetMs，不再被 budget/2=1500ms
 *  掐断）；其余档仍为 `min(deadlineAt−now, ceil(requestBudgetMs/2))`。非负。 */
export function attemptBudgetMs(requestBudgetMs: number, remainingMs: number, isLastAttempt: boolean): number {
  const remaining = Math.max(0, remainingMs);
  if (isLastAttempt) return remaining;
  return Math.min(remaining, Math.ceil(requestBudgetMs / 2));
}

// ───────────────────────────── 结果类型 ─────────────────────────────

export type PredictFlightCostSource = "usage" | "reserve";

export interface PredictFlightCost {
  /** 总预留额（各档 Reservation.amount 之和）。 */
  readonly reserveUsd: number;
  /** 总结算额（有 usage 的档按 usage×价目、其余按预留；≤ reserveUsd）。 */
  readonly costUsd: number;
  /** 是否至少有一档按 usage 结算（真实 cost）。 */
  readonly costSource: PredictFlightCostSource;
}

export interface PredictFlightAttemptOutcome {
  readonly provider: string;
  readonly id: string;
  readonly kind: "ok" | "timeout" | "error" | "aborted";
  readonly ms: number;
  readonly reserveUsd: number;
  readonly costUsd: number;
  readonly costSource: PredictFlightCostSource;
}

export type PredictFlightKind = "ok" | "failed" | "timeout" | "aborted" | "denied";

export type PredictFlightOutcome =
  | {
      readonly kind: "ok";
      readonly text: string;
      readonly model: string;
      readonly ms: number;
      readonly cost: PredictFlightCost;
      readonly attempts: readonly PredictFlightAttemptOutcome[];
    }
  | {
      readonly kind: Exclude<PredictFlightKind, "ok">;
      readonly ms: number;
      readonly cost: PredictFlightCost;
      readonly attempts: readonly PredictFlightAttemptOutcome[];
    };

export interface PredictFlightInput {
  /** 已构建的 system prompt（llm.buildPredictSystemPrompt 输出）。 */
  readonly system: string;
  /** 已序列化的 user DTO（outbound.serializePredictOutbound 输出）。 */
  readonly user: string;
  /** failover 模型链（wire 已解析 registry）。 */
  readonly models: readonly PredictFlightModel[];
  /** 外部 abort（session_shutdown 等）。 */
  readonly signal?: AbortSignal;
}

export interface PredictFlightConfig {
  /** §8.1 请求链硬期限（1000–6000）。 */
  readonly requestBudgetMs: number;
  /** 日调用次数上限（admit 只读检查用，须与 ledger 同源）。 */
  readonly maxCallsPerDay: number;
  /** 估算日额上限（admit 只读检查用，须与 ledger 同源）。 */
  readonly maxUsdPerDay: number;
  /** 连续失败阈值（缺省 3）。 */
  readonly breakerThreshold?: number;
  /** 断路器打开时长（缺省 10min）。 */
  readonly breakerOpenMs?: number;
  /** 时钟注入（缺省 systemClock；测试用 FakeClock）。 */
  readonly clock?: Clock;
  /** 估算用价目（缺省 deepseek；仅当档位无价目时用于估算，不用于结算）。 */
  readonly estimatePrice?: PredictPrice;
}

// ───────────────────────────── 实例接口 ─────────────────────────────

export interface PredictFlight {
  /** §8.2 admit：只读门（无副作用）。 */
  admit(input: PredictFlightInput): boolean;
  /** §8.2 start：reserve + failover 链（须在 admit 通过后调用）。 */
  start(input: PredictFlightInput): Promise<PredictFlightOutcome>;
  /** session_shutdown：abort 在飞、清计时器、置 disposed。 */
  shutdown(): void;
  zombies(): number;
  isBreakerOpen(): boolean;
  isDisposed(): boolean;
  isInFlight(): boolean;
}

// ───────────────────────────── 实现 ─────────────────────────────

function finiteNonNeg(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 单次尝试的内部结果。 */
type AttemptResult =
  | { readonly kind: "ok"; readonly text: string; readonly usage?: PredictUsage; readonly ms: number }
  | { readonly kind: "timeout" | "error" | "aborted"; readonly ms: number };

export function createPredictFlight(ledger: PredictLedger, config: PredictFlightConfig): PredictFlight {
  const requestBudgetMs = clampSpanMs(config.requestBudgetMs) ?? DEFAULT_REQUEST_BUDGET_MS;
  const maxCallsPerDay = Math.max(0, Math.floor(finiteNonNeg(config.maxCallsPerDay)));
  const maxUsdPerDay = Math.max(0, finiteNonNeg(config.maxUsdPerDay));
  const breakerThreshold = Math.max(1, Math.floor(finiteNonNeg(config.breakerThreshold ?? BREAKER_THRESHOLD)));
  const breakerOpenMs = clampSpanMs(config.breakerOpenMs ?? BREAKER_OPEN_MS) ?? BREAKER_OPEN_MS;
  const clock = config.clock ?? systemClock;
  const estimatePrice = config.estimatePrice ?? DEEPSEEK_PRICE;

  let inFlight = false;
  let zombieCount = 0;
  let disposed = false;
  let consecutiveFails = 0;
  let breakerOpen = false;
  let breakerTimer: TimerHandle | undefined;
  // 在飞请求的控制器（shutdown 用）。
  let activeAbort: AbortController | undefined;

  function clearBreakerTimer(): void {
    if (breakerTimer !== undefined) {
      clock.clearTimer(breakerTimer);
      breakerTimer = undefined;
    }
  }

  function closeBreaker(): void {
    clearBreakerTimer();
    breakerOpen = false;
    consecutiveFails = 0;
  }

  function openBreaker(): void {
    if (disposed) return;
    breakerOpen = true;
    clearBreakerTimer();
    breakerTimer = clock.setTimer(breakerOpenMs, () => {
      breakerOpen = false;
      consecutiveFails = 0;
      breakerTimer = undefined;
    });
  }

  function recordFailure(): void {
    if (disposed) return;
    consecutiveFails += 1;
    if (!breakerOpen && consecutiveFails >= breakerThreshold) openBreaker();
  }

  function recordSuccess(): void {
    if (disposed) return;
    closeBreaker();
  }

  function admit(input: PredictFlightInput): boolean {
    if (disposed || inFlight || zombieCount > 0 || breakerOpen) return false;
    const first = input.models[0];
    if (first === undefined) return false;
    const firstPrice = usablePrice(first.price) ? first.price : estimatePrice;
    const estimate = estimatePredictUsd(input.system, input.user, firstPrice);
    const snap = ledger.snapshot(clock.now());
    if (snap.calls >= maxCallsPerDay) return false;
    if (snap.spent + snap.reserved + estimate > maxUsdPerDay) return false;
    return true;
  }

  async function start(input: PredictFlightInput): Promise<PredictFlightOutcome> {
    if (disposed || inFlight || zombieCount > 0 || breakerOpen) {
      return { kind: "denied", ms: 0, cost: { reserveUsd: 0, costUsd: 0, costSource: "reserve" }, attempts: [] };
    }
    inFlight = true;
    const startedAt = clock.now();
    const deadlineAt = startedAt + requestBudgetMs;
    const controller = new AbortController();
    activeAbort = controller;
    const signal = controller.signal;

    const attempts: PredictFlightAttemptOutcome[] = [];
    let totalReserve = 0;
    let totalCost = 0;
    let anyUsage = false;
    let outcomeKind: PredictFlightKind = "denied";
    let okText = "";
    let okModel = "";

    // 悬挂中的当前档（外层期限同步结算用）。
    let current:
      | { model: PredictFlightModel; reservation: Reservation; price: PredictPrice | undefined; startedAt: number }
      | undefined;
    let currentComplete: Promise<PredictFlightCompletion> | undefined;

    const settleAttempt = (
      model: PredictFlightModel,
      reservation: Reservation,
      price: PredictPrice | undefined,
      result: AttemptResult,
    ): void => {
      let cost = reservation.amount;
      let source: PredictFlightCostSource = "reserve";
      if (disposed) {
        ledger.release(reservation);
        cost = 0;
      } else if (result.kind === "ok" && usableUsage(result.usage) && usablePrice(price)) {
        ledger.settle(reservation, result.usage, price);
        cost = Math.min(usageCostUsd(result.usage, price), reservation.amount);
        source = "usage";
      } else {
        ledger.settle(reservation);
      }
      totalCost += cost;
      if (source === "usage") anyUsage = true;
      attempts.push({
        provider: model.provider,
        id: model.id,
        kind: result.kind,
        ms: result.ms,
        reserveUsd: reservation.amount,
        costUsd: source === "usage" ? cost : reservation.amount,
        costSource: source,
      });
    };

    const buildOutcome = (kind: PredictFlightKind): PredictFlightOutcome => {
      const ms = clock.now() - startedAt;
      if (kind === "ok") recordSuccess();
      else if (kind === "failed" || kind === "timeout") recordFailure();
      const cost: PredictFlightCost = {
        reserveUsd: totalReserve,
        costUsd: totalCost,
        costSource: anyUsage ? "usage" : "reserve",
      };
      if (kind === "ok") return { kind: "ok", text: okText, model: okModel, ms, cost, attempts };
      return { kind, ms, cost, attempts };
    };

    // 外部 signal（shutdown 等）→ 立即 abort controller。
    const onExternalAbort = (): void => controller.abort();
    let externalAttached = false;
    if (input.signal !== undefined) {
      if (input.signal.aborted) controller.abort();
      else {
        input.signal.addEventListener("abort", onExternalAbort, { once: true });
        externalAttached = true;
      }
    }

    const run = (async (): Promise<void> => {
      let anyDispatched = false;
      const lastIdx = input.models.length - 1;
      for (const [idx, model] of input.models.entries()) {
        if (signal.aborted) {
          outcomeKind = "aborted";
          return;
        }
        const remaining = deadlineAt - clock.now();
        if (remaining <= 0) {
          outcomeKind = anyDispatched ? "failed" : "denied";
          return;
        }
        // #36 §6.5：最后一档拿全部剩余预算（arch r5 §6.5）。
        const attemptTimeout = attemptBudgetMs(requestBudgetMs, remaining, idx === lastIdx);
        const price = model.price;
        // 估算价目：档位价目不可用（非有限/负值）时退回保守缺省，绝不产出 NaN 预留。
        const reserve = ledger.reserve(
          clock.now(),
          estimatePredictUsd(input.system, input.user, usablePrice(price) ? price : estimatePrice),
        );
        if (!reserve.ok) {
          outcomeKind = anyDispatched ? "failed" : "denied";
          return;
        }
        totalReserve += reserve.reservation.amount;
        anyDispatched = true;

        // 单次尝试：自己的 AbortController + 计时器（到点只 abort、不判超时——provider
        // 尊重 abort（reject）⇒ 记 timeout 并 failover；无视 abort（永不 settle）⇒ 尝试
        // 悬挂，由外层期限兜底（zombie））。
        const attemptStarted = clock.now();
        const ac = new AbortController();
        let timedOut = false;
        let attemptTimer: TimerHandle | undefined;
        let onParentAbort: (() => void) | undefined;
        const cancel = new Promise<"aborted">((resolve) => {
          onParentAbort = (): void => resolve("aborted");
          signal.addEventListener("abort", onParentAbort, { once: true });
          if (attemptTimeout > 0) {
            attemptTimer = clock.setTimer(attemptTimeout, () => {
              timedOut = true;
              ac.abort();
            });
          }
        });

        current = { model, reservation: reserve.reservation, price, startedAt: attemptStarted };
        let result: AttemptResult;
        try {
          const completeP = model.port.complete(input.system, input.user, ac.signal);
          currentComplete = completeP;
          const raced = await Promise.race([completeP, cancel]);
          if (raced === "aborted") result = { kind: "aborted", ms: clock.now() - attemptStarted };
          else {
            result = {
              kind: "ok",
              text: raced.text,
              ...(raced.usage === undefined ? {} : { usage: raced.usage }),
              ms: clock.now() - attemptStarted,
            };
          }
        } catch {
          result = { kind: timedOut ? "timeout" : "error", ms: clock.now() - attemptStarted };
        }
        // 每次尝试的计时器与 abort 监听在此移除（try/catch 覆盖全部失败路径，等价于 finally）。
        if (attemptTimer !== undefined) clock.clearTimer(attemptTimer);
        if (onParentAbort !== undefined) signal.removeEventListener("abort", onParentAbort);
        if (current !== undefined) {
          settleAttempt(current.model, current.reservation, current.price, result);
          current = undefined;
        }
        currentComplete = undefined;

        if (result.kind === "ok") {
          okText = result.text;
          okModel = `${model.provider}/${model.id}`;
          outcomeKind = "ok";
          return;
        }
        if (result.kind === "aborted") {
          outcomeKind = "aborted";
          return;
        }
        // timeout / error ⇒ failover 下一档。
      }
      outcomeKind = anyDispatched ? "failed" : "denied";
    })();

    const outerMs = clampSpanMs(requestBudgetMs + OUTER_GRACE_MS) ?? requestBudgetMs + OUTER_GRACE_MS;
    const outcome = await new Promise<PredictFlightOutcome>((resolveOuter) => {
      let outerDone = false;
      const outerTimer = clock.setTimer(outerMs, () => {
        if (outerDone) return;
        outerDone = true;
        // 外层期限触发：不依赖 provider 响应 abort。同步按预留结算当前悬挂档，
        // 记为 zombie（阻止后续准入），detach 迟到结果，释放 flight。
        if (current !== undefined) {
          settleAttempt(current.model, current.reservation, current.price, {
            kind: "timeout",
            ms: clock.now() - current.startedAt,
          });
          current = undefined;
        }
        if (currentComplete !== undefined) {
          zombieCount += 1;
          const pending = currentComplete;
          pending.then(
            () => {
              zombieCount -= 1;
            },
            () => {
              zombieCount -= 1;
            },
          );
        }
        controller.abort();
        resolveOuter(buildOutcome("timeout"));
      });
      const settleOuter = (): void => {
        if (outerDone) return;
        outerDone = true;
        clock.clearTimer(outerTimer);
        resolveOuter(buildOutcome(outcomeKind));
      };
      run.then(settleOuter, settleOuter);
    });

    // 清理：移除外部 listener、释放 in-flight、清 activeAbort。
    if (externalAttached && input.signal !== undefined) {
      input.signal.removeEventListener("abort", onExternalAbort);
    }
    inFlight = false;
    activeAbort = undefined;
    return outcome;
  }

  function shutdown(): void {
    if (disposed) return;
    disposed = true;
    if (activeAbort !== undefined) activeAbort.abort();
    activeAbort = undefined;
    clearBreakerTimer();
    breakerOpen = false;
    consecutiveFails = 0;
  }

  return {
    admit,
    start,
    shutdown,
    zombies: () => zombieCount,
    isBreakerOpen: () => breakerOpen,
    isDisposed: () => disposed,
    isInFlight: () => inFlight,
  };
}
