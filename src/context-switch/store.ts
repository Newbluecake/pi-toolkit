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
