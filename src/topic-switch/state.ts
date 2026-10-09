/**
 * topic-switch · cooldown + hold reducer (plan.md §P1 "state.ts", 纯函数).
 *
 * `stepHold` is the single authority for hold-phase transitions. Unlisted
 * event×phase combinations are no-ops (state unchanged, `fx=[]`) — that is
 * exactly the r2 #9/#11 rule that makes late/stale async results harmless:
 * the wire checks `{activationId, holdId}` before feeding, and anything that
 * slips through anyway dies here.
 *
 * Property (pinned by tests/topic-switch/hold.property.test.ts): over the
 * whole lifecycle the HELD item gets exactly one delivery decision —
 * `release` (current session) XOR `switch-entered`→done (new session) XOR
 * `persist-pending` from a pre-releasing phase (recoverable/manual). A
 * `persist-pending` emitted while already `releasing` covers only queue
 * items that were never sent (P3b.5) and never revises the held item's
 * decision. After `done`, every event yields `fx=[]`.
 */

import type { ConfirmOutcomeLike, EntryLike, JudgeVerdictLike, Outcome, ShutdownReason } from "./types.js";
import { ENTRY_TYPE, parseRecord } from "./records.js";

/** D4 翻转点：留下类结局进冷却的 outcome 集合（唯一一处定义；frozen 数组 + 判定函数，不导出 Set）。 */
export const COOLDOWN_OUTCOMES: readonly Outcome[] = Object.freeze(["declined", "confirm-timeout", "confirm-cancel"]);

export function isCooldownOutcome(outcome: Outcome): boolean {
  return COOLDOWN_OUTCOMES.includes(outcome);
}

/**
 * 冷却是否仍有效。解除条件（满足其一）：
 *  1. 最近一次 cooldown 记录之后分支上出现了 compaction 条目（新上下文纪元）；
 *  2. `tokensNow` 有限且 `tokensNow − cooldown.tokens ≥ regrowTokens`（regrowTokens>0 才启用，0 = 只随 compaction 解除）。
 */
export function cooldownActive(
  branch: readonly EntryLike[],
  tokensNow: number | null | undefined,
  regrowTokens: number,
): boolean {
  // 反向扫描：最近一条 cooldown 记录，以及其后是否出现过 compaction。
  for (let idx = branch.length - 1; idx >= 0; idx -= 1) {
    const entry = branch[idx];
    if (entry === undefined) continue;
    if (entry.type === "compaction") return false; // 冷却之后发生了压缩 ⇒ 解除
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      const record = parseRecord(entry.data);
      if (record !== undefined && record.kind === "cooldown") {
        if (
          typeof tokensNow === "number" &&
          Number.isFinite(tokensNow) &&
          regrowTokens > 0 &&
          Number.isFinite(record.tokens) &&
          tokensNow - record.tokens >= regrowTokens
        ) {
          return false;
        }
        return true;
      }
      // 非 cooldown 的本类型记录（outcome/pending/…）继续向前扫。
    }
  }
  return false; // 分支里没有 cooldown 记录 ⇒ 不在冷却
}

export type HoldPhase = "judging" | "confirming" | "hopping" | "switching" | "releasing" | "done";

export type HoldEvent =
  | { t: "judged"; v: JudgeVerdictLike }
  | { t: "confirmed"; o: ConfirmOutcomeLike }
  | { t: "newcomer" }
  | { t: "hop-timeout" }
  | { t: "ponr" }
  | { t: "preflight-failed" }
  | { t: "switch-entered" }
  | { t: "switch-cancelled" }
  | { t: "abort"; why: "watchdog" | "shutdown"; reason?: ShutdownReason }
  | { t: "released" };

export type HoldEffect =
  | { e: "judge" }
  | { e: "confirm" }
  | { e: "hop" }
  /** abort judge/confirm、作废 nonce（PONR 前的异步效应收口）。 */
  | { e: "cancel-async" }
  /** 恰好一次地把 held（及被截的新来者，由 P3b release 队列负责）回注当前会话。 */
  | { e: "release" }
  | { e: "persist-pending"; reason: ShutdownReason }
  | { e: "cooldown" }
  | { e: "record"; outcome: Outcome };

export interface HoldState {
  phase: HoldPhase;
}

export function initialHoldState(): HoldState {
  return { phase: "judging" };
}

/** judged 非「无关」时的 outcome 映射（全部 fail-open、不进冷却）。低置信度按 related 桶处理（判不清 ⇒ 不问）。 */
function outcomeOfJudgeVerdict(v: JudgeVerdictLike): Outcome {
  switch (v.kind) {
    case "ok":
      return "related";
    case "timeout":
      return "judge-timeout";
    case "parse-error":
      return "judge-parse";
    case "no-model":
      return "no-model";
    case "error":
    case "aborted":
    default:
      return "judge-error";
  }
}

/** confirmed 非 switch 时的 outcome 映射；unavailable/error/aborted（confirm 通道失败）统一 ui-unavailable、不进冷却。 */
function outcomeOfConfirmOutcome(o: ConfirmOutcomeLike): Outcome {
  switch (o.kind) {
    case "stay":
      return "declined";
    case "timeout":
      return "confirm-timeout";
    case "cancel":
      return "confirm-cancel";
    case "unavailable":
    case "error":
    case "aborted":
    default:
      return "ui-unavailable";
  }
}

/**
 * 状态转移（未列出的组合 ⇒ 状态不变、fx=[]，即迟到事件无副作用 #9/#11）。
 * 效应顺序固定：cancel-async → release → record → cooldown / persist-pending。
 */
export function stepHold(
  s: HoldState,
  ev: HoldEvent,
  minConfidence: number,
): { s: HoldState; fx: readonly HoldEffect[] } {
  const phase = s.phase;
  if (phase === "done") return { s, fx: [] };

  switch (ev.t) {
    case "judged": {
      if (phase !== "judging") return { s, fx: [] };
      const v = ev.v;
      if (v.kind === "ok" && !v.related && v.confidence >= minConfidence) {
        return { s: { phase: "confirming" }, fx: [{ e: "confirm" }] };
      }
      return { s: { phase: "releasing" }, fx: [{ e: "release" }, { e: "record", outcome: outcomeOfJudgeVerdict(v) }] };
    }
    case "confirmed": {
      if (phase !== "confirming") return { s, fx: [] };
      if (ev.o.kind === "switch") {
        return { s: { phase: "hopping" }, fx: [{ e: "hop" }] };
      }
      const outcome = outcomeOfConfirmOutcome(ev.o);
      const fx: HoldEffect[] = [{ e: "release" }, { e: "record", outcome }];
      if (isCooldownOutcome(outcome)) fx.push({ e: "cooldown" });
      return { s: { phase: "releasing" }, fx };
    }
    case "newcomer": {
      // switching 中 newcomer 不进归约器（I4：PONR 后输入直接放行）；releasing 中由 release 队列追加。
      if (phase !== "judging" && phase !== "confirming" && phase !== "hopping") return { s, fx: [] };
      return {
        s: { phase: "releasing" },
        fx: [{ e: "cancel-async" }, { e: "release" }, { e: "record", outcome: "newcomer" }],
      };
    }
    case "abort": {
      if (ev.why === "watchdog") {
        if (phase !== "judging" && phase !== "confirming" && phase !== "hopping") return { s, fx: [] };
        return {
          s: { phase: "releasing" },
          fx: [{ e: "cancel-async" }, { e: "release" }, { e: "record", outcome: "watchdog" }],
        };
      }
      // shutdown：judging/confirming/hopping ⇒ 持久化 pending（I5：崩溃/重载窗口至多一次自动投递）；
      // releasing ⇒ 只持久化尚未发出的队列项（held 的决定已是 release，不变更）；switching ⇒ 只通知（I4）。
      if (phase === "releasing") {
        return { s: { phase: "done" }, fx: [{ e: "persist-pending", reason: ev.reason ?? "reload" }] };
      }
      if (phase === "switching") return { s, fx: [] };
      if (phase !== "judging" && phase !== "confirming" && phase !== "hopping") return { s, fx: [] };
      return {
        s: { phase: "done" },
        fx: [{ e: "cancel-async" }, { e: "persist-pending", reason: ev.reason ?? "reload" }],
      };
    }
    case "hop-timeout": {
      if (phase !== "hopping") return { s, fx: [] };
      return { s: { phase: "releasing" }, fx: [{ e: "release" }, { e: "record", outcome: "hop-timeout" }] };
    }
    case "preflight-failed": {
      if (phase !== "hopping") return { s, fx: [] };
      return { s: { phase: "releasing" }, fx: [{ e: "release" }, { e: "record", outcome: "preflight" }] };
    }
    case "ponr": {
      if (phase !== "hopping") return { s, fx: [] };
      return { s: { phase: "switching" }, fx: [] };
    }
    case "switch-entered": {
      if (phase !== "switching") return { s, fx: [] };
      return { s: { phase: "done" }, fx: [{ e: "record", outcome: "switched" }] };
    }
    case "switch-cancelled": {
      if (phase !== "switching") return { s, fx: [] };
      return { s: { phase: "releasing" }, fx: [{ e: "release" }, { e: "record", outcome: "switch-cancelled" }] };
    }
    case "released": {
      if (phase !== "releasing") return { s, fx: [] };
      return { s: { phase: "done" }, fx: [] };
    }
  }
}
