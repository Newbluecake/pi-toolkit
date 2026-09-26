/**
 * context-switch · 待交付交接文本的暂存（纯数据，无 pi import）。
 *
 * 为什么需要它：`switch_context` 工具必须 fire-and-forget 地调 `ctx.compact()`
 * （await 压缩会与 abort 死锁，见 src/tools/compact-tool.ts 头注释），真正把文本交给 pi 的是
 * 之后触发的 `session_before_compact` hook。两者之间需要一个带**新鲜度**语义的交接槽：
 * 陈旧的交接文本比 pi 的通用摘要更危险（它会把几十轮之前的状态冒充成现状），所以过期即作废，
 * 消费一次即清空。
 */

export interface PendingHandoff {
  /** 单调递增序号：工具侧可据此确认"自己这次"的暂存是否仍有效。 */
  seq: number;
  /** 模型撰写的交接正文（未拼接机械附录）。 */
  core: string;
  /** false = 丢弃压缩点之前的全部消息（真正的上下文切换）。 */
  keepRecent: boolean;
  /** 压缩完成后是否自动发 resume 消息继续任务。 */
  resume: boolean;
  createdAt: number;
}

/** 默认新鲜期：压缩在工具返回后的数百毫秒内发生，2 分钟已是极宽松的上界。 */
export const DEFAULT_HANDOFF_TTL_MS = 120_000;

export interface PendingHandoffStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export class PendingHandoffStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private pending: PendingHandoff | undefined;
  private seqCounter = 0;

  constructor(options: PendingHandoffStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** 暂存一份交接文本，返回其序号（覆盖任何未消费的旧文本）。 */
  stage(input: { core: string; keepRecent: boolean; resume: boolean }): number {
    this.seqCounter += 1;
    this.pending = {
      seq: this.seqCounter,
      core: input.core,
      keepRecent: input.keepRecent,
      resume: input.resume,
      createdAt: this.now(),
    };
    return this.seqCounter;
  }

  /** 只读窥视：仅在仍新鲜时返回。 */
  peek(): PendingHandoff | undefined {
    if (!this.pending) return undefined;
    if (this.now() - this.pending.createdAt > this.ttlMs) {
      this.pending = undefined;
      return undefined;
    }
    return this.pending;
  }

  /** 取走并清空（只有新鲜的才会被取走）。 */
  consume(): PendingHandoff | undefined {
    const fresh = this.peek();
    this.pending = undefined;
    return fresh;
  }

  /** 清空。给定 seq 时只清除该序号（避免误删后来者的暂存）。 */
  clear(seq?: number): void {
    if (seq !== undefined && this.pending?.seq !== seq) return;
    this.pending = undefined;
  }

  /** 是否有新鲜的待交付文本（force 层据此决定"再等一轮"还是回落通用压缩）。 */
  hasFresh(): boolean {
    return this.peek() !== undefined;
  }
}

/**
 * child-context-switch plan §2.1: boundary 模式（子会话）的暂存槎——不是 TTL 新鲜期，而是
 * **结构化**新鲜度：只有暂存时记下的 `toolCallId` 出现在当前 turn_end 事件的 `toolResults`
 * 里才算命中；命中即消费，不命中（无论是过期还是从未匹配）也一并清空——同一起长工具跑
 * 700s 不会被 TTL 误判过期（旧 store 的 2 分钟窗口在这里不适用），但跨过一个 turn_end 仍未被
 * 采用就永久作废，绝不会被下一次切换尝试捡起来冒充「这次」的交接。
 */
export interface ChildStagedSwitch {
  /** 单调递增序号，写入压缩条目的 details，供 §2.3.1 的诊断与 childMaxSwitches 计数使用。 */
  seq: number;
  /** 每次暂存的随机指纹；L2/L3 自证探针与本次切换的对应关系全靠它，不靠时钟。 */
  nonce: string;
  toolCallId: string;
  core: string;
  keepRecent: boolean;
  createdAt: number;
}

export interface ChildSwitchStoreOptions {
  now?: () => number;
  nonce?: () => string;
}

let fallbackNonceCounter = 0;

export class ChildSwitchStore {
  private readonly now: () => number;
  private readonly makeNonce: () => string;
  private pending: ChildStagedSwitch | undefined;
  private seqCounter = 0;

  constructor(options: ChildSwitchStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.makeNonce =
      options.nonce ??
      (() => {
        fallbackNonceCounter += 1;
        return `${Date.now().toString(36)}-${fallbackNonceCounter.toString(36)}`;
      });
  }

  /** 暂存一次 boundary 切换请求（覆盖任何未消费的旧暂存——同一时刻只应有一个在途请求）。 */
  stageForTool(input: { toolCallId: string; core: string; keepRecent: boolean }): { seq: number; nonce: string } {
    this.seqCounter += 1;
    const nonce = this.makeNonce();
    this.pending = {
      seq: this.seqCounter,
      nonce,
      toolCallId: input.toolCallId,
      core: input.core,
      keepRecent: input.keepRecent,
      createdAt: this.now(),
    };
    return { seq: this.pending.seq, nonce };
  }

  /** 只读窥视：不消费，不清空。 */
  peek(): ChildStagedSwitch | undefined {
    return this.pending;
  }

  /**
   * 结构化新鲜度核对：暂存的 `toolCallId` 在本次 turn 的集合里 ⇒ 消费并返回；否则（包括没有
   * 暂存的情况）清空并返回 undefined——陈旧的暂存绝不会被下一个 turn_end 捡起来。
   */
  take(toolCallIdsInTurn: readonly string[]): ChildStagedSwitch | undefined {
    const staged = this.pending;
    this.pending = undefined;
    if (!staged) return undefined;
    return toolCallIdsInTurn.includes(staged.toolCallId) ? staged : undefined;
  }

  /** 无条件清空（outcome !== "completed" 分支）。 */
  clear(): void {
    this.pending = undefined;
  }

  hasPending(): boolean {
    return this.pending !== undefined;
  }
}

/** 标识子会话 boundary 切换提交过的 compaction 条目的 details.source（plan §2.1）。 */
export const CHILD_SWITCH_SOURCE = "pi-toolkit:switch_context";

/** 最小字段探测：不强要求具体 pi 类型，只看我们自己写下的 details 形状。 */
interface BranchEntryLike {
  type?: unknown;
  fromHook?: unknown;
  details?: unknown;
}

/**
 * 每 run 切换上限（plan §2.1/§4，`compact.childMaxSwitches`）的计数器：当前分支上带
 * `details.source === CHILD_SWITCH_SOURCE` 的 `fromHook` compaction 条数。每次调用从
 * `ctx.sessionManager.getBranch()` 现算，所以 resume 续写同一个会话文件时计数延续，不因
 * 新 activate() 清零。
 */
export function countChildSwitches(branch: readonly BranchEntryLike[]): number {
  let count = 0;
  for (const entry of branch) {
    if (entry?.type !== "compaction" || entry.fromHook !== true) continue;
    const details = entry.details;
    if (details && typeof details === "object" && (details as Record<string, unknown>).source === CHILD_SWITCH_SOURCE) {
      count += 1;
    }
  }
  return count;
}
