/**
 * droid turn 终态判定（plan §4.5 表，arch §8.4 修订版——策略拒绝行已随 U2′ 删除）。
 * 纯函数：输入 turn 结束事实，产出 ErrorInfo（undefined = 正常完成）。
 * 退出码一律不作判据（droid-protocol §10）。
 */
import type { ErrorInfo } from "../../core/types.js";
import { MSG_USAGE_EXHAUSTED, msgAuthFailure, msgUnexpectedCancel } from "../messages.js";

import { DROID_AUTH_ERROR_RE } from "./auth.js";
export { DROID_AUTH_ERROR_RE } from "./auth.js";
/** 429 ⇒ retryable（§4.5「其它 error」行）。 */
export const DROID_RATE_LIMIT_RE = /\b429\b/;

/** 错误细节截断（鉴权文案的 detail 括号；调用方已脱敏）。 */
const ERROR_DETAIL_CAP = 300;

export interface TurnTerminalFacts {
  /** agent_turn_completed.reason（实测值 completed / cancelled / model_usage_exhausted；未知值按 completed 处理）。 */
  reason: string;
  /** 我方发起过 interrupt/abort（requestAbort / dispose-kill / fatal 收口）。 */
  abortRequested: boolean;
  /** 本 turn 收集到的 error 通知文本（已脱敏，按到达序）。 */
  errors: readonly string[];
  /** 本 run 已同步批准的 request_permission 次数（§4.3 cancel 文案提示用）。 */
  permissionApprovals: number;
}

/**
 * 判定优先级（§4.5 表行序 + 402 实测样例 S/10 同时命中 auth 与 usage_exhausted 两行，auth 先）：
 * 我方 abort 的 cancelled ⇒ 正常（runner 按 stopCause/timeoutReason 结算）→ auth 错误 →
 * model_usage_exhausted → 非我方 cancelled → 其它 error → completed。
 */
export function classifyTurnEnd(facts: TurnTerminalFacts): ErrorInfo | undefined {
  if (facts.reason === "cancelled" && facts.abortRequested) return undefined;
  const authError = facts.errors.find((e) => DROID_AUTH_ERROR_RE.test(e));
  if (authError !== undefined) {
    return {
      kind: "auth",
      retryable: false,
      message: msgAuthFailure(authError.slice(0, ERROR_DETAIL_CAP)),
    };
  }
  if (facts.reason === "model_usage_exhausted") return { kind: "auth", retryable: false, message: MSG_USAGE_EXHAUSTED };
  if (facts.reason === "cancelled")
    return { kind: "model", retryable: false, message: msgUnexpectedCancel(facts.permissionApprovals) };
  const firstError = facts.errors[0];
  if (firstError !== undefined)
    return {
      kind: "model",
      retryable: DROID_RATE_LIMIT_RE.test(firstError),
      message: firstError.slice(0, ERROR_DETAIL_CAP),
    };
  return undefined;
}
