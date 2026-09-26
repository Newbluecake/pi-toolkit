/**
 * context-switch · 子会话 turn_end 边界草稿构造（plan §2.1，V1-V6 结构校验 + V6 副本预演）。
 *
 * 依赖 pi 运行时导出（`SessionManager.inMemory` / `findCutPoint` / `estimateTokens` /
 * `convertToLlm`），不属于 handoff.ts 那种"零 pi import"的纯层——但仍然是 pure function:
 * 不读 `ctx`/`pi`，所有输入都以参数显式传入，方便在没有真实 AgentSession 的情况下单测
 * （真实 pi 上的行为回归交给 T-C1/T-C2 conformance 测试）。
 *
 * V6 副本预演逐字复刻 pi 自己的 `_createBoundaryPreviewManager` /
 * `_buildBoundaryContext`（agent-session.js:452-482）：`SessionManager.inMemory(cwd, undefined,
 * [header, ...branch])` 上按 `appendCompaction` / `appendCustomMessageEntry` / `appendCustomEntry`
 * 追加同样的草稿序列，再用 `buildSessionProjection()` + `convertToLlm()` 复算
 * `canContinue`（§0 事实 2(c)：非 system 消息存在且末条不是 assistant）。这只是一次"结果上下文
 * 可运行"的健全性检查——真正的 continue 语义已经不需要它（v3 从不返回 continue），抛错或算出
 * false 都一律拒绝，绝不把半成品交给 pi。
 */
import type { SessionBoundaryDraft, SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
// child-context-switch plan §3.1 条件 2：命名空间导入 + 运行时访问。旧版 pi 缺这些导出时，具名
// 导入会在模块链接期直接抛错（ESM `does not provide an export named 'X'`），拖垮整个扩展的
// activate()；命名空间导入永远不会抛——缺项只是 `pi.SessionManager` 等于 `undefined`，本文件
// `buildChildSwitchDrafts` 开头的运行时存在性检查把它变成一个普通的 `preview-invalid` 拒绝，
// L0（`probeBoundaryStatic`，`src/adapters/pi-compat.ts`）负责在真正调用这条路径之前先判 unavailable。
import * as pi from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { composeHandoff, fileListsFromBranch, type HandoffAppendix } from "./handoff.js";
import { computeDroppedFingerprints, type DroppedFingerprintSet, type FingerprintableMessage } from "./selfcheck.js";
import { CHILD_SWITCH_SOURCE } from "./store.js";

/** 子会话切换的 resume 消息 customType；不进模型上下文的可读标记（自证探针另有自己的 type）。 */
export const CHILD_SWITCH_RESUME_CUSTOM_TYPE = "subagent:switch-context-resume";

export const CHILD_SWITCH_RESUME_TEXT =
  "[switch_context] Context switched: the history before this point has been replaced by the " +
  "handoff you just wrote. Continue the task from it; if a detail is missing, read the listed " +
  "files or the previous session file instead of assuming. Do not call switch_context again unless " +
  "context usage climbs high once more.";

export type SwitchRejectReason =
  | "unpersisted"
  | "order"
  | "concurrent-compaction"
  | "boundary-conflict"
  | "cut-point"
  | "preview-invalid"
  | "cannot-continue";

export interface SwitchDroppedRange {
  fromEntryId: string | undefined;
  toEntryId: string | undefined;
  entries: number;
  tokensBefore: number;
  tokensAfterEstimate: number;
}

export interface SwitchDiag {
  seq: number;
  nonce: string;
  keepRecent: boolean;
  dropped: SwitchDroppedRange;
}

export interface BuildChildSwitchDraftsInput {
  header: SessionHeader | null | undefined;
  branch: readonly SessionEntry[];
  cwd: string;
  turn: {
    messageEntryId: string;
    toolResultEntryIds: readonly string[];
    toolResults: readonly ToolResultMessage[];
    /** 前序扩展在同一 turn_end 已经返回的草稿（契约 (a)：我们必须在它之上组合，不能吞掉）。 */
    priorDrafts: readonly SessionBoundaryDraft[];
  };
  staged: {
    toolCallId: string;
    core: string;
    keepRecent: boolean;
    seq: number;
    nonce: string;
  };
  /** pi-settings 读取，缺省 DEFAULT_COMPACTION_SETTINGS.keepRecentTokens。 */
  keepRecentTokens: number;
  facts: Pick<HandoffAppendix, "sessionFile" | "runs" | "bashJobs" | "todos">;
  /** ctx.getContextUsage()?.tokens。 */
  tokensBefore: number | undefined;
}

export type BuildChildSwitchDraftsResult =
  | {
      ok: true;
      entries: SessionBoundaryDraft[];
      diag: SwitchDiag;
      /** v3.1 条件 1（plan §3.1 L3(c)）：提交时算好的 D 条目 id 集合 + 消息指纹，调用方
       *  （P3）存到 pendingCommit 上，供下一次 context 事件时传给 `selfcheck.ts` 的
       *  `checkSwitchSelfCheck`。 */
      commitProof: DroppedFingerprintSet;
    }
  | { ok: false; reason: SwitchRejectReason };

function reject(reason: SwitchRejectReason): BuildChildSwitchDraftsResult {
  return { ok: false, reason };
}

/** SessionEntryBase 只保证 type/id/parentId/timestamp——这里只取我们用得到的部分做结构判断。 */
type BranchLike = Pick<SessionEntry, "type" | "id"> & { message?: { role?: string } };

export function buildChildSwitchDrafts(input: BuildChildSwitchDraftsInput): BuildChildSwitchDraftsResult {
  const { header, branch, cwd, turn, staged, keepRecentTokens, facts, tokensBefore } = input;

  // 运行时防御（plan §3.1 条件 2）：命名空间导入在缺项时只会让下面这些属性变成 undefined，
  // 不会像具名导入那样在模块链接期直接抛错拖垮整个扩展；调用方（能力状态机的 L0）本该在
  // 缺项时就不放行到这条路径，这里是防御性的第二道门——缺项一律降级为 preview-invalid，
  // 绝不让 TypeError 从下面的 SessionManager.inMemory / findCutPoint / convertToLlm /
  // estimateTokens / sessionEntryToContextMessages 调用里冒出来。
  if (
    typeof pi.SessionManager?.inMemory !== "function" ||
    typeof pi.convertToLlm !== "function" ||
    typeof pi.estimateTokens !== "function" ||
    typeof pi.findCutPoint !== "function" ||
    typeof pi.sessionEntryToContextMessages !== "function"
  ) {
    return reject("preview-invalid");
  }

  // V1: toolResultEntryIds 与 toolResults 必须等长，否则 flatMap 丢结果导致下标不可信（pi 侧证据见 plan §2.1）。
  if (turn.toolResultEntryIds.length !== turn.toolResults.length) return reject("unpersisted");

  const idIndex = new Map<string, number>();
  (branch as readonly BranchLike[]).forEach((entry, i) => idIndex.set(entry.id, i));

  const msgIdx = idIndex.get(turn.messageEntryId);
  if (msgIdx === undefined) return reject("order");

  // V2: 每个 toolResultEntryIds[i] 都在 branch 里、位于 messageEntryId 之后、下标严格递增。
  let lastToolResultIdx = msgIdx;
  for (const id of turn.toolResultEntryIds) {
    const idx = idIndex.get(id);
    if (idx === undefined || idx <= lastToolResultIdx) return reject("order");
    lastToolResultIdx = idx;
  }

  // V3: messageEntryId 之后没有并发压缩。
  for (let i = msgIdx + 1; i < branch.length; i++) {
    if ((branch[i] as BranchLike | undefined)?.type === "compaction") return reject("concurrent-compaction");
  }

  // V4: priorDrafts 只接受 custom / custom_message（compaction / context_edit 视为边界冲突）。
  for (const draft of turn.priorDrafts) {
    if (draft.type !== "custom" && draft.type !== "custom_message") return reject("boundary-conflict");
  }

  // 最近一次 compaction 之后的第一条 branch 下标（0 = 从头开始）。
  let lastCompactionIdx = -1;
  for (let i = 0; i < branch.length; i++) {
    if ((branch[i] as BranchLike).type === "compaction") lastCompactionIdx = i;
  }
  const startAfterCompaction = lastCompactionIdx + 1;

  let firstKeptEntryId: string | null;
  let dropFromIdx: number;
  let dropToIdx: number;
  if (staged.keepRecent) {
    // V5: 切点必须落在 [startAfterCompaction, msgIdx] 内，且不是一条孤立的 toolResult。
    const cut = pi.findCutPoint(branch as SessionEntry[], startAfterCompaction, branch.length, keepRecentTokens);
    const idx = cut.firstKeptEntryIndex;
    if (idx < startAfterCompaction || idx > msgIdx) return reject("cut-point");
    const cutEntry = branch[idx] as BranchLike | undefined;
    if (!cutEntry || (cutEntry.type === "message" && cutEntry.message?.role === "toolResult")) {
      return reject("cut-point");
    }
    firstKeptEntryId = cutEntry.id;
    dropFromIdx = startAfterCompaction;
    dropToIdx = idx - 1;
  } else {
    firstKeptEntryId = null;
    dropFromIdx = startAfterCompaction;
    // plan §2.1: the dropped range runs to the turn's LAST branch entry, not just its last
    // toolResult — another extension may already have appended a custom entry after it.
    dropToIdx = branch.length - 1;
  }

  const { modifiedFiles, readFiles } = fileListsFromBranch(
    branch as readonly { type?: unknown; message?: { role?: unknown; content?: readonly unknown[] } }[],
    dropFromIdx,
    dropToIdx,
  );
  const appendix: HandoffAppendix = {
    ...facts,
    ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
    ...(readFiles.length > 0 ? { readFiles } : {}),
    ...(tokensBefore != null && Number.isFinite(tokensBefore) && tokensBefore > 0 ? { tokensBefore } : {}),
    ...(staged.keepRecent ? {} : { droppedEverything: true }),
  };
  const summary = composeHandoff(staged.core, appendix);
  const droppedEntries = Math.max(0, dropToIdx - dropFromIdx + 1);
  // dropped 区间取「最近一次 compaction 之后的首条」到「切点前一条」（keep_recent:false 时到
  // 本 turn 的 branch 末条——plan §2.1 的「turn 末条」，含其它扩展追加在最后一个 toolResult 之后的条目）。
  // tokensAfterEstimate 先占位为 0，V6 副本预演算出真实值后原地写回（details 与 diag 共用同
  // 一个 dropped 对象，见下）——这样它既进 diag（供 §2.3.1 的诊断），也随 compactionDraft.details
  // 一起被 pi 持久化进会话文件（plan §2.1：「并持久化该字段」）。
  const dropped: SwitchDroppedRange = {
    fromEntryId: droppedEntries > 0 ? (branch[dropFromIdx] as BranchLike | undefined)?.id : undefined,
    toEntryId: droppedEntries > 0 ? (branch[dropToIdx] as BranchLike | undefined)?.id : undefined,
    entries: droppedEntries,
    tokensBefore: tokensBefore ?? 0,
    tokensAfterEstimate: 0,
  };
  const details = {
    source: CHILD_SWITCH_SOURCE,
    seq: staged.seq,
    nonce: staged.nonce,
    keepRecent: staged.keepRecent,
    dropped,
  };

  // v3.1 条件 1（plan §3.1 L3(c)）：D 的条目 id 集合 + 消息指纹，供调用方（P3）存到
  // pendingCommit 上，供下一次 context 事件时喂给 selfcheck.ts 的 checkSwitchSelfCheck。
  const commitProof: DroppedFingerprintSet = computeDroppedFingerprints(
    branch as readonly { id: string; type: string }[],
    dropFromIdx,
    dropToIdx,
    (entry) => pi.sessionEntryToContextMessages(entry as SessionEntry) as unknown as readonly FingerprintableMessage[],
  );

  const compactionDraft: SessionBoundaryDraft = {
    type: "compaction",
    summary,
    firstKeptEntryId,
    details,
  };
  const resumeDraft: SessionBoundaryDraft = {
    type: "custom_message",
    customType: CHILD_SWITCH_RESUME_CUSTOM_TYPE,
    content: CHILD_SWITCH_RESUME_TEXT,
    display: false,
    details: { seq: staged.seq, nonce: staged.nonce },
  };
  const entries: SessionBoundaryDraft[] = [compactionDraft, ...turn.priorDrafts, resumeDraft];

  // V6: 副本预演——逐字复刻 pi 的 _buildBoundaryContext，抛错或 canContinue=false 一律拒绝。
  if (!header) return reject("preview-invalid");
  let tokensAfterEstimate = 0;
  try {
    const preview = pi.SessionManager.inMemory(cwd, undefined, [header, ...(branch as SessionEntry[])]);
    preview.appendCompaction(summary, firstKeptEntryId, tokensBefore ?? 0, details, true);
    for (const draft of turn.priorDrafts) {
      if (draft.type === "custom_message") {
        preview.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
      } else if (draft.type === "custom") {
        preview.appendCustomEntry(draft.customType, draft.data);
      }
    }
    preview.appendCustomMessageEntry(
      resumeDraft.customType,
      resumeDraft.content,
      resumeDraft.display,
      resumeDraft.details,
    );
    const projection = preview.buildSessionProjection();
    const llmMessages = pi.convertToLlm(projection.messages);
    const finalRole = llmMessages[llmMessages.length - 1]?.role;
    const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
    const canContinue = hasNonSystemContext && finalRole !== "assistant";
    if (!canContinue) return reject("cannot-continue");
    for (const message of projection.messages) tokensAfterEstimate += pi.estimateTokens(message);
  } catch {
    return reject("preview-invalid");
  }

  // 持久化该字段（plan §2.1）：直接写回共享的 dropped 对象，compactionDraft.details.dropped
  // 和下面 diag.dropped 都是同一个引用，不需要另外拷一份。
  dropped.tokensAfterEstimate = tokensAfterEstimate;

  return {
    ok: true,
    entries,
    diag: {
      seq: staged.seq,
      nonce: staged.nonce,
      keepRecent: staged.keepRecent,
      dropped,
    },
    commitProof,
  };
}
