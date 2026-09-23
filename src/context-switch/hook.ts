/**
 * context-switch · `session_before_compact` 钩子：把模型自写的交接文本交给 pi 当压缩摘要。
 *
 * 接缝（docs/dev/context-switch/context-switch-plan.md §0）：
 * - handler 返回 `{ compaction: CompactionResult }` ⇒ pi 跳过默认摘要 LLM，直接
 *   `appendCompaction(summary, firstKeptEntryId, tokensBefore, …, fromHook=true)`
 *   （agent-session.js:1490-1536 手动路径 / :1751-1795 自动路径）。
 * - `firstKeptEntryId` 若不匹配分支上的任何条目，`buildContextEntries`
 *   （session-manager.js:198-226）会丢弃压缩点之前的**全部**内容 ⇒ keep_recent=false 的实现。
 *
 * 新鲜度纪律：只有本次 `switch_context` 刚暂存、尚未被消费的文本才会注入；否则返回 undefined，
 * 让 pi 跑它自己的通用摘要（陈旧交接文本会把旧状态冒充成现状，比通用摘要更危险）。
 */

import { composeHandoff, type HandoffAppendix, fileListsFromFileOps } from "./handoff.js";
import type { PendingHandoffStore } from "./store.js";

/** 不匹配任何会话条目的哨兵 id：等价于"压缩点之前全部丢弃"。 */
export const DROP_ALL_SENTINEL = "__pi_toolkit_switch_context_drop_all__";

/** 事件的结构化视图（只取我们用到的字段，便于无 pi 依赖地单测）。 */
export interface SwitchCompactEventView {
  preparation?: {
    firstKeptEntryId?: string;
    tokensBefore?: number;
    fileOps?: unknown;
  };
  reason?: "manual" | "threshold" | "overflow";
}

export interface SwitchCompactHookResult {
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}

/** 会话侧事实提供者：活跃 run / bash job / todo / 会话文件路径。任何一项失败都必须静默降级。
 *  `ctx` 是 pi 传给 handler 的第二参（ExtensionContext），这里保持结构化以便单测。 */
export type SessionFactsProvider = (
  ctx?: unknown,
) => Pick<HandoffAppendix, "sessionFile" | "runs" | "bashJobs" | "todos">;

export interface SwitchCompactHookDeps {
  store: PendingHandoffStore;
  sessionFacts?: SessionFactsProvider;
  /** 应用成功后的回调（日志 / toast）。 */
  onApplied?: (info: { seq: number; keepRecent: boolean; chars: number; reason: string }) => void;
  debug?: boolean;
}

export function createSwitchContextCompactHook(
  deps: SwitchCompactHookDeps,
): (event: SwitchCompactEventView, ctx?: unknown) => SwitchCompactHookResult | undefined {
  return (event, ctx) => {
    const pending = deps.store.peek();
    if (!pending) return undefined;
    // 消费即清：同一份交接文本绝不注入两次压缩。
    deps.store.clear(pending.seq);

    const preparation = event.preparation ?? {};
    const tokensBefore =
      typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
        ? preparation.tokensBefore
        : 0;
    const firstKeptEntryId = pending.keepRecent
      ? typeof preparation.firstKeptEntryId === "string" && preparation.firstKeptEntryId.length > 0
        ? preparation.firstKeptEntryId
        : DROP_ALL_SENTINEL
      : DROP_ALL_SENTINEL;

    const { modifiedFiles, readFiles } = fileListsFromFileOps(preparation.fileOps);
    let facts: ReturnType<SessionFactsProvider> = {};
    try {
      facts = deps.sessionFacts?.(ctx) ?? {};
    } catch (error) {
      if (deps.debug) console.warn(`[pi-subagent] switch_context session facts failed: ${String(error)}`);
    }

    const appendix: HandoffAppendix = {
      ...facts,
      ...(modifiedFiles.length > 0 ? { modifiedFiles } : {}),
      ...(readFiles.length > 0 ? { readFiles } : {}),
      ...(tokensBefore > 0 ? { tokensBefore } : {}),
      ...(pending.keepRecent ? {} : { droppedEverything: true }),
    };
    const summary = composeHandoff(pending.core, appendix);
    deps.onApplied?.({
      seq: pending.seq,
      keepRecent: pending.keepRecent,
      chars: summary.length,
      reason: event.reason ?? "manual",
    });
    if (deps.debug) {
      console.warn(
        `[pi-subagent] switch_context applied seq=${pending.seq} reason=${event.reason ?? "manual"} ` +
          `keepRecent=${pending.keepRecent} chars=${summary.length}`,
      );
    }
    return { compaction: { summary, firstKeptEntryId, tokensBefore } };
  };
}
