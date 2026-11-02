/**
 * fabric-thread P1 (arch r3 §6.3): the routing DECISION TABLE R0–R7 as one pure, ordered
 * function. The engine feeds it state snapshot facts (live subscribers, hourly cap, lane/records
 * capacity, budget); the P3 caller feeds frame facts (origin/meta/header/bypass/addressing).
 *
 * Order is normative (§6.3): R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7. Note R1 (bypass) precedes
 * R2 (no live subscriber) and R2 precedes R3 (addressed_other) — a bypassed frame never even
 * pays the lazy-validation pass. §6.7 folds “records table full” into the R5 native path.
 */
import { steerSpanMs } from "./deadline.js";

export interface RouteDecisionInput {
  /** `fabric.enabled ∧ fabric.threads.enabled ∧ 非 secure` — the engine exists only when true,
   *  but the table keeps the row so R0 stays total (G2a tests drive it directly). */
  featureEnabled: boolean;
  /** §4.2 `isFeishuCmdOrigin(frame.origin)` — only the hub can construct a feishu cmd origin. */
  trustedOrigin: boolean;
  /** the cmd frame carries `cmd.thread`. */
  hasThreadMeta: boolean;
  /** `cmd.thread` passes the P0 schema (ThreadMetaSchema). */
  threadMetaValid: boolean;
  /** §6.2 first line strictly matches the hub header (`parseRequestHeader`) — else R0. */
  headerOk: boolean;
  /** §7.2 `bypass:true` (thb:/main: synthetic members ⇒ R1). */
  bypass: boolean;
  /** after lazy validation (§5.3) the thread still has ≥1 live subscriber. */
  hasLiveSubscriber: boolean;
  /** §6.2 addressing guard hit `addressed_other` ⇒ R3 (slow path, never re-addressed). */
  addressedOther: boolean;
  /** §6.3 R4: this thread's rolling-hour routed count already ≥ routedPerThreadPerHour. */
  hourlyCapReached: boolean;
  /** §6.5 the thread's lane wait queue is full. */
  laneWaitFull: boolean;
  /** §6.7 the EventRecord table is full with nothing evictable ⇒ new events take the R5 path. */
  recordsFull: boolean;
  /** budget source for R6 (§6.5). */
  steerTimeoutMs: number;
  frameDeadlineMs: number;
}

export type NativeRule = "R0" | "R1" | "R2" | "R3" | "R4" | "R5" | "R6";
export type RouteRule = NativeRule | "R7";

export type RouteDecision =
  | {
      rule: "R0";
      route: "native";
      reason: "feature_off" | "untrusted_origin" | "no_thread_meta" | "invalid_thread_meta" | "header_mismatch";
    }
  | { rule: "R1"; route: "native"; reason: "bypass" }
  | { rule: "R2"; route: "native"; reason: "no_live_subscriber" }
  | { rule: "R3"; route: "native"; reason: "addressed_other" }
  | { rule: "R4"; route: "native"; reason: "routed_hourly_cap" }
  | { rule: "R5"; route: "native"; reason: "lane_wait_full" | "records_full" }
  | { rule: "R6"; route: "native"; reason: "budget_invalid" }
  | { rule: "R7"; route: "lane" };

/** The ordered table. Pure: no side effects, no counters — the engine owns those. */
export function decideRoute(input: RouteDecisionInput): RouteDecision {
  // R0 — 功能关闭、非飞书可信来源、没有 thread、字段非法、首行不是 hub header
  if (!input.featureEnabled) return { rule: "R0", route: "native", reason: "feature_off" };
  if (!input.trustedOrigin) return { rule: "R0", route: "native", reason: "untrusted_origin" };
  if (!input.hasThreadMeta) return { rule: "R0", route: "native", reason: "no_thread_meta" };
  if (!input.threadMetaValid) return { rule: "R0", route: "native", reason: "invalid_thread_meta" };
  if (!input.headerOk) return { rule: "R0", route: "native", reason: "header_mismatch" };
  // R1 — bypass
  if (input.bypass) return { rule: "R1", route: "native", reason: "bypass" };
  // R2 — 没有 live 订阅（lazy 校验后）
  if (!input.hasLiveSubscriber) return { rule: "R2", route: "native", reason: "no_live_subscriber" };
  // R3 — 寻址守卫命中 addressed_other
  if (input.addressedOther) return { rule: "R3", route: "native", reason: "addressed_other" };
  // R4 — 本 Thread 本小时直投数已达上限
  if (input.hourlyCapReached) return { rule: "R4", route: "native", reason: "routed_hourly_cap" };
  // R5 — lane 等待队列已满（§6.5）；records 表满同走本行（§6.7）
  if (input.laneWaitFull) return { rule: "R5", route: "native", reason: "lane_wait_full" };
  if (input.recordsFull) return { rule: "R5", route: "native", reason: "records_full" };
  // R6 — 绝对截止预算无效（clampSpanMs ⇒ undefined，或 span < 500ms）
  if (steerSpanMs(input.steerTimeoutMs, input.frameDeadlineMs) === undefined) {
    return { rule: "R6", route: "native", reason: "budget_invalid" };
  }
  // R7 — 入 lane
  return { rule: "R7", route: "lane" };
}
