// 承接（plan.md v3.2 §3.3）：触发短语判定、重新验证、清空条件、
// 只从 final 恢复的持久化记录形状。pi-free；无模块级可变状态（I4）。
//
// 实际的 `subagent:memory-predict` 读写、session_start 恢复属于 wire.ts 接线
// （P1b，不在本包范围），本文件只提供其纯函数内核。

import type { CarryState, Evidence, PredictInput, ScoredHit, TagScore } from "./contracts.js";

/** 连续承接上限（§3.3）。 */
export const MAX_CARRIES = 3;

/** 承接触发短语 = `ACK_PHRASES`（jev/wire.ts 定义）去掉
 *  谢谢/thanks/thankyou/收到/lgtm（§3.3）。与 `passesPromptGate` 同一规范化
 *  （lowercase + 去标点符号/空白）后做集合比对；此处独立复制该集合——
 *  wire.ts 非 pi-free，predict/* 不能从它 import（I8）。 */
const CARRY_PHRASES = new Set([
  "继续",
  "继续吧",
  "好",
  "好的",
  "好吧",
  "嗯",
  "嗯嗯",
  "是",
  "是的",
  "对",
  "对的",
  "行",
  "可以",
  "开始",
  "开始吧",
  "ok",
  "okay",
  "yes",
  "go",
  "goon",
  "goahead",
  "continue",
  "proceed",
  "sure",
  "soundsgood",
]);

function normalize(prompt: string): string {
  const compact = prompt.replace(/\s+/g, "");
  return compact.toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
}

/** 当前 prompt 是否为承接短语（§3.3 触发条件）。 */
export function isCarryPhrase(prompt: string): boolean {
  return CARRY_PHRASES.has(normalize(prompt));
}

// ───────────────────────────── 重新验证（§3.3） ─────────────────────────────

function sourceStillValid(
  entry: TagScore & { evidence: Evidence },
  input: Pick<PredictInput, "todo" | "git">,
): boolean {
  const inProgressIds = new Set(input.todo.filter((t) => t.status === "in_progress").map((t) => t.id));
  if (entry.sources.includes("T") && entry.evidence.todoIds.some((id) => inProgressIds.has(id))) return true;
  if (entry.sources.includes("W")) {
    if (entry.tag === "git-commit" && input.git?.dirty === true) return true;
    if (entry.tag === "git-push" && (input.git?.branch === "master" || input.git?.branch === "main")) return true;
  }
  // 只有 U/M：保留（分数衰减在调用方应用）。
  if (entry.sources.every((s) => s === "U" || s === "M")) return true;
  return false;
}

/** §3.3 重新验证：按 evidence 逐 tag 校验；全部来源失效 ⇒ 丢弃该 tag；
 *  仅 U/M ⇒ 分数 ×0.95；连续承接达到上限 ⇒ 整体过期（返回 undefined）。 */
export function revalidateCarry(carry: CarryState, input: Pick<PredictInput, "todo" | "git">): CarryState | undefined {
  if (carry.carries >= MAX_CARRIES) return undefined;
  const survivors = carry.tags
    .filter((entry) => sourceStillValid(entry, input))
    .map((entry) =>
      entry.sources.every((s) => s === "U" || s === "M") ? { ...entry, score: entry.score * 0.95 } : entry,
    );
  if (survivors.length === 0) return undefined;
  return { tags: survivors, carries: carry.carries + 1 };
}

/** 承接命中以 source C 进入投票（evidence 含×0.95 衰减后的分数，§3.3）。 */
export function carryHits(carry: CarryState | undefined): readonly ScoredHit[] {
  if (carry === undefined) return [];
  return carry.tags.map((entry) => ({
    rule: "carry",
    source: "C" as const,
    tag: entry.tag,
    conf: "high" as const,
    baseConf: "high" as const,
    score: entry.score,
    evidence: entry.evidence,
  }));
}

// ───────────────────────────── 清空条件（§3.3） ─────────────────────────────

export type CarryClearReason = "cancel" | "compaction" | "todo-replaced" | "empty";

export interface CarryClearInputs {
  readonly cancelled: boolean;
  readonly compacted: boolean;
  /** 当前 in_progress todo id 集合与上一轮承接 tag 的 todoIds 并集的交集是否为空
   *  （todo 被整组替换，§3.3）。没有任何来源为 T 的承接 tag 时恒 false。 */
  readonly todoReplaced: boolean;
  readonly finalTagsEmpty: boolean;
}

/** 本轮承接是否应被清空，以及原因（供 final 记录，§3.3）。 */
export function detectCarryClear(inputs: CarryClearInputs): CarryClearReason | undefined {
  if (inputs.cancelled) return "cancel";
  if (inputs.compacted) return "compaction";
  if (inputs.todoReplaced) return "todo-replaced";
  if (inputs.finalTagsEmpty) return "empty";
  return undefined;
}

/** todo 被整组替换：上一轮承接证据里的 todoId 集合非空，且与当前 in_progress
 *  集合没有交集（§3.3）。 */
export function isTodoReplaced(prevTodoIds: readonly number[], currentInProgressIds: readonly number[]): boolean {
  if (prevTodoIds.length === 0) return false;
  const cur = new Set(currentInProgressIds);
  return !prevTodoIds.some((id) => cur.has(id));
}

// ───────────────────────────── final 记录（§3.3 持久化） ─────────────────────────────

export interface FinalRecord {
  readonly v: 1;
  readonly kind: "final";
  readonly turnSeq: number;
  readonly tags: readonly (TagScore & { evidence: Evidence })[];
  readonly carries: number;
  readonly cleared?: CarryClearReason;
}

/** 构造一轮的 final 记录（§3.3：有 tag 或"从有变空"时才写；由调用方决定是否
 *  跳过连续空轮，本函数只负责形状）。 */
export function buildFinalRecord(
  turnSeq: number,
  tags: readonly (TagScore & { evidence: Evidence })[],
  carries: number,
  cleared?: CarryClearReason,
): FinalRecord {
  return { v: 1, kind: "final", turnSeq, tags, carries, ...(cleared === undefined ? {} : { cleared }) };
}

/** 只从 final 恢复（§3.3）：`kind:"call"` 记录从不参与；空 final（cleared 或
 *  tags 为空）恢复为 undefined。 */
export function carryFromFinal(record: FinalRecord | undefined): CarryState | undefined {
  if (record === undefined || record.cleared !== undefined || record.tags.length === 0) return undefined;
  return { tags: record.tags, carries: record.carries };
}
