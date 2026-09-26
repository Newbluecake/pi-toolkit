/**
 * context-switch · L3(c) 自证判定的纯函数（plan §3.1，v3.1 复审条件 1）。
 *
 * 提交切换时（`boundary.ts` 的 `buildChildSwitchDrafts`，同一次同步调用）从分支算出被丢弃
 * 条目集合 D，并用 `computeDroppedFingerprints` 记下 D 里每条会产出上下文消息的条目
 * （`message` / `custom_message` / `branch_summary` / `compaction`，经 pi 导出的
 * `sessionEntryToContextMessages` 展开）的消息指纹。调用方（P3 的 turn_end/context 接线）把
 * 这份 `DroppedFingerprintSet` 存在 `pendingCommit` 上，等下一次 `context` 事件到来时连同
 * 当时的消息、`buildSessionProjection().entries[].sourceEntry.id` 集合、期望的交接摘要一起
 * 交给 `checkSwitchSelfCheck` 做 c1/c2/c3 判定。
 *
 * 职责分离（2026-09-27 复审确认）：`capability.ts` 只做状态机转移，不认识指纹；
 * `checkSwitchSelfCheck` 的返回值形状与 `capability.ts` 的 `ProbeResult` 完全一致
 * ——这就是"状态机入口"：调用方只需要 `capability.noteL3(checkSwitchSelfCheck(...))` /
 * `capability.noteRecheck(checkSwitchSelfCheck(...))` 一行接线，不做任何格式转换。单次失败记
 * `uncommitted`、连续 2 次才禁用、`verifying` 阶段失败立即禁用——这些规则都在 `capability.ts`
 * 里按当前状态决定，本文件只给结论。
 *
 * token 总和是否下降只做弱检查（plan §3.1："token 总和 < tokensBefore 降为附加的弱检查，
 * 不再是充分条件"）：`tokensDecreased` 只进诊断，不参与 ok/fail 的判定——「仍含一条被丢弃消息
 * 但总 token 下降」必须判失败（T-D3 v3.1 新增用例）。
 */
import { createHash } from "node:crypto";
import type { ProbeResult } from "./capability.js";

/** `sessionEntryToContextMessages` 展开出来的 AgentMessage 形状，只取指纹算法用得到的字段。
 *  不同角色的实际载荷字段不同（多数是 `content`；`compactionSummary`/`branchSummary` 是
 *  `summary`；`bashExecution` 是 `command`/`output`），全部按 `[key: string]: unknown` 兜底。 */
export interface FingerprintableMessage {
  readonly role: string;
  readonly timestamp?: unknown;
  readonly toolCallId?: unknown;
  readonly [key: string]: unknown;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function fingerprintPayload(message: FingerprintableMessage): unknown {
  if ("content" in message) return message.content;
  if ("summary" in message) return message.summary;
  if ("command" in message || "output" in message) return { command: message.command, output: message.output };
  return message;
}

/** `role|timestamp|toolCallId|sha1(JSON(payload))`（plan §3.1 L3(c)）。提交时和自证时共用
 *  同一份实现，保证两端算出的指纹可比。 */
export function fingerprintMessage(message: FingerprintableMessage): string {
  const hash = sha1Hex(safeStringify(fingerprintPayload(message)));
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
  const timestamp =
    typeof message.timestamp === "number" || typeof message.timestamp === "string" ? message.timestamp : "";
  return `${message.role}|${timestamp}|${toolCallId}|${hash}`;
}

export interface DroppedFingerprintSet {
  /** D：被丢弃条目的 branch id 集合（c2 用来核对投影来源）。 */
  readonly entryIds: ReadonlySet<string>;
  /** D 中每条条目展开出的非 system 消息指纹（c1 用来核对下一次 context 事件的消息）。 */
  readonly fingerprints: ReadonlySet<string>;
}

export interface DroppedRangeEntry {
  readonly id: string;
  readonly type: string;
}

const EXPANDABLE_ENTRY_TYPES = new Set(["message", "custom_message", "branch_summary", "compaction"]);

/**
 * 从分支的 `[fromIndex, toIndex]` 闭区间（被丢弃条目集合 D）算出条目 id 集合和消息指纹集合。
 * `toContextMessages` 是调用方传入的 pi `sessionEntryToContextMessages`（命名空间访问，L0 已
 * 探测过存在性）；单条展开失败按"宁可漏，不可造假"跳过，不让整个自证判定崩掉——跳过只会让
 * `fingerprints` 少一条，方向仍偏向"更容易判不通过"（c1 少一条指纹不会让残留内容被漏判，
 * 因为 entryIds 仍然完整，c2 兜底）。
 */
export function computeDroppedFingerprints(
  branch: readonly DroppedRangeEntry[],
  fromIndex: number,
  toIndex: number,
  toContextMessages: (entry: DroppedRangeEntry) => readonly FingerprintableMessage[],
): DroppedFingerprintSet {
  const entryIds = new Set<string>();
  const fingerprints = new Set<string>();
  const start = Math.max(0, fromIndex);
  const end = Math.min(branch.length - 1, toIndex);
  for (let i = start; i <= end; i++) {
    const entry = branch[i];
    if (!entry) continue;
    entryIds.add(entry.id);
    if (!EXPANDABLE_ENTRY_TYPES.has(entry.type)) continue;
    let messages: readonly FingerprintableMessage[];
    try {
      messages = toContextMessages(entry);
    } catch {
      continue;
    }
    for (const message of messages) {
      if (!message || message.role === "system") continue;
      fingerprints.add(fingerprintMessage(message));
    }
  }
  return { entryIds, fingerprints };
}

export interface SelfCheckInput {
  /** 提交时用 `computeDroppedFingerprints` 算好的 D。 */
  readonly dropped: DroppedFingerprintSet;
  /** 下一次 `context` 事件里的消息（含 system；本函数自己过滤）。 */
  readonly contextMessages: readonly FingerprintableMessage[];
  /** `buildSessionProjection().entries[].sourceEntry.id` 的集合。 */
  readonly projectionSourceEntryIds: ReadonlySet<string>;
  /** 我们提交的交接摘要，或已按 (a)（分支上有一条排在我们之后的 compaction）确认过的
   *  pi 自动压缩摘要——调用方负责先确认 (a)，本函数不重新判断"是谁的摘要"。 */
  readonly expectedSummary: string;
  /** 弱检查（plan §3.1）：token 总和是否下降，只记录不参与判定。 */
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
}

export type SelfCheckReason = "c1-dropped-in-request" | "c2-dropped-in-projection" | "c3-summary-mismatch";

export type SelfCheckResult =
  | ({ ok: true } & ProbeResult & { tokensDecreased: boolean | undefined })
  | ({ ok: false; reason: SelfCheckReason } & ProbeResult & { tokensDecreased: boolean | undefined });

/**
 * c1/c2/c3（plan §3.1 L3(c)，v3.1 条件 1）。返回值形状与 `capability.ts` 的 `ProbeResult`
 * 一致（"状态机入口"）：调用方只需要 `capability.noteL3(checkSwitchSelfCheck(...))`。
 *
 * - c1：`contextMessages` 里每条非 system 消息的指纹都不在 `dropped.fingerprints` 里。
 * - c2：`projectionSourceEntryIds` 与 `dropped.entryIds` 无交集。
 * - c3：第一条非 system 消息是 `compactionSummary`，且其 `summary` 等于 `expectedSummary`。
 *
 * 三项按顺序短路，任一不成立即判失败；`tokensDecreased` 只是弱检查，附在结果里供诊断，
 * 从不参与 ok/fail（即使 token 总和明显下降，只要还残留一条 D 中的消息或来源条目，仍判失败）。
 */
export function checkSwitchSelfCheck(input: SelfCheckInput): SelfCheckResult {
  const nonSystem = input.contextMessages.filter((m) => m?.role !== "system");
  const tokensDecreased =
    input.tokensBefore !== undefined && input.tokensAfter !== undefined
      ? input.tokensAfter < input.tokensBefore
      : undefined;

  const c1 = nonSystem.every((m) => !input.dropped.fingerprints.has(fingerprintMessage(m)));
  if (!c1) return { ok: false, reason: "c1-dropped-in-request", tokensDecreased };

  let c2 = true;
  for (const id of input.projectionSourceEntryIds) {
    if (input.dropped.entryIds.has(id)) {
      c2 = false;
      break;
    }
  }
  if (!c2) return { ok: false, reason: "c2-dropped-in-projection", tokensDecreased };

  const first = nonSystem[0];
  const c3 = first !== undefined && first.role === "compactionSummary" && first.summary === input.expectedSummary;
  if (!c3) return { ok: false, reason: "c3-summary-mismatch", tokensDecreased };

  return { ok: true, tokensDecreased };
}
