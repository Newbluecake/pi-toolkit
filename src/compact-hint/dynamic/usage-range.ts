/**
 * compact-hint dynamic · 观察窗范围聚合（dynamic-threshold-plan.md §5.5，P0-4 / R2-2 / R2-6）。
 *
 * 为什么不复用 `readLatestAssistantUsage`（src/cache-ttl/usage-ledger.ts）：它只回扫到
 * **最后一条** assistant usage；观察窗要的是「切换点（watermark 条目）**之后**的全部
 * assistant usage 逐条累加」。两者语义不同，误用会把观察窗外的旧账算进来。
 *
 * 纪律（§5.5 / §13）：
 * - 走 `getBranch()`（S14），**绝不用 `getEntries()`**（可能读出陈旧 fork 分支的条目）。
 * - pi-free duck type：只吃结构化的 ctx/branch 形状，零 pi import。
 * - **绝不用 0 冒充未知**：0 是「真的一个 token 都没读」，与「没测到」是两回事；缺失一律 null。
 * - 压缩条目自身的 `CompactionEntry.usage`（切换固定成本 K，R2-6）天然不会被误收：
 *   其 `type` 是 `"compaction"` 而非 `"message"`，不满足累加条件。
 * - 永不抛。
 */

/** pi `ExtensionContext` 的结构化子集（只取本模块用到的字段，never imports pi）。 */
export interface BranchCtxLike {
  sessionManager?: { getBranch?: () => unknown } | undefined;
}

/**
 * R2-2：pi 的 `Usage`（pi-ai types.d.ts:270-291）只有 input/output/cacheRead/cacheWrite/
 * totalTokens/cost——**没有 context 字段**，所以给不出真正的 S0；四元组是可拿到的原始形状。
 */
export interface RawUsageQuad {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type UsageUnknownReason = "watermark-lost" | "no-usage" | "cost-missing";

export interface UsageRangeAggregate {
  /** 计入的 assistant usage 条目数。 */
  turns: number;
  costUsd: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /**
   * R2-2：区间内**第一条** assistant usage 的 `input + cacheRead + cacheWrite`，作为上下文
   * 规模的**代理**（与研究 §3.1 的口径一致）。pi 没有 context 字段，这不是真正的 S0。
   * null 语义：区间内没有任何 assistant usage（由 unknownReason 表达），或第一条的三个字段
   * 不全为有限数。绝不用 0 冒充。
   */
  firstContextTokens: number | null;
  /** 同一条的原始四元组，便于日后用别的口径重算而不用重跑会话；同样缺失则 null。 */
  firstUsage: RawUsageQuad | null;
  /** 去重后的 model id（出现多个 ⇒ 调用方标 crossModel，不丢弃数据）。 */
  models: readonly string[];
  /** 当前分支末条目 id（调用方可作下一次 watermark）；分支不可读 ⇒ null。 */
  lastEntryId: string | null;
  /** 优先级：watermark-lost > no-usage > cost-missing；全部可知时 null。 */
  unknownReason: UsageUnknownReason | null;
}

/** `SessionEntry` 的结构化子集（session-manager.d.ts:17-22 起，duck type）。 */
interface BranchEntryLike {
  type?: unknown;
  id?: unknown;
  message?: {
    role?: unknown;
    model?: unknown;
    usage?: unknown;
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fin(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 读取分支；不可读 / 缺失 / 抛异常 ⇒ undefined（永不抛）。 */
function readBranch(ctx: BranchCtxLike | undefined): readonly BranchEntryLike[] | undefined {
  try {
    const raw = ctx?.sessionManager?.getBranch?.();
    return Array.isArray(raw) ? (raw as BranchEntryLike[]) : undefined;
  } catch {
    return undefined;
  }
}

function lastIdOf(branch: readonly BranchEntryLike[]): string | null {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const id = branch[i]?.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** 分支末条目 id（§5.5 watermark 的取法：session_compact 后分支最后一条即压缩条目本身）。 */
export function lastBranchEntryId(ctx: BranchCtxLike | undefined): string | null {
  const branch = readBranch(ctx);
  return branch === undefined ? null : lastIdOf(branch);
}

/** watermark 不可用（分支读不出 / watermark 为 null / 不在分支上被 fork 压缩切走）。 */
function lostAggregate(lastEntryId: string | null): UsageRangeAggregate {
  return {
    turns: 0,
    costUsd: null,
    cacheRead: null,
    cacheWrite: null,
    firstContextTokens: null,
    firstUsage: null,
    models: [],
    lastEntryId,
    unknownReason: "watermark-lost",
  };
}

/**
 * 累加 `afterEntryId` **严格之后**的 `type === "message" && message.role === "assistant" &&
 * message.usage` 条目（P0-4：不是只读最后一条）。
 */
export function aggregateAssistantUsageAfter(
  ctx: BranchCtxLike | undefined,
  afterEntryId: string | null,
): UsageRangeAggregate {
  const branch = readBranch(ctx);
  if (branch === undefined) return lostAggregate(null);
  const lastEntryId = lastIdOf(branch);
  if (afterEntryId === null) return lostAggregate(lastEntryId);
  const anchor = branch.findIndex((entry) => typeof entry?.id === "string" && entry.id === afterEntryId);
  if (anchor === -1) return lostAggregate(lastEntryId);

  let turns = 0;
  let costSum = 0;
  let costMissing = false;
  let cacheReadSum = 0;
  let cacheReadKnown = true;
  let cacheWriteSum = 0;
  let cacheWriteKnown = true;
  let firstContextTokens: number | null = null;
  let firstUsage: RawUsageQuad | null = null;
  let firstEntrySeen = false;
  const models: string[] = [];

  for (let i = anchor + 1; i < branch.length; i += 1) {
    const entry = branch[i];
    if (entry?.type !== "message") continue; // compaction 等条目天然不满足累加条件（R2-6）
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue;
    turns += 1;

    const costTotal = fin(isRecord(usage.cost) ? usage.cost.total : undefined);
    if (costTotal === null) costMissing = true;
    else costSum += costTotal;

    const read = fin(usage.cacheRead);
    if (read === null) cacheReadKnown = false;
    else cacheReadSum += read;
    const write = fin(usage.cacheWrite);
    if (write === null) cacheWriteKnown = false;
    else cacheWriteSum += write;

    if (typeof message.model === "string" && message.model.length > 0 && !models.includes(message.model)) {
      models.push(message.model);
    }

    if (!firstEntrySeen) {
      firstEntrySeen = true; // 只看第一条计入条目；缺字段记 null，绝不用后续条目补位
      const input = fin(usage.input);
      const output = fin(usage.output);
      const read2 = fin(usage.cacheRead);
      const write2 = fin(usage.cacheWrite);
      if (input !== null && read2 !== null && write2 !== null) firstContextTokens = input + read2 + write2;
      if (input !== null && output !== null && read2 !== null && write2 !== null) {
        firstUsage = { input, output, cacheRead: read2, cacheWrite: write2 };
      }
    }
  }

  if (turns === 0) {
    // 区间锚定成功但一条 usage 都没有：这是真实的「零条」，数值量记 null + no-usage。
    return {
      turns: 0,
      costUsd: null,
      cacheRead: null,
      cacheWrite: null,
      firstContextTokens: null,
      firstUsage: null,
      models: [],
      lastEntryId,
      unknownReason: "no-usage",
    };
  }
  return {
    turns,
    costUsd: costMissing ? null : costSum,
    cacheRead: cacheReadKnown ? cacheReadSum : null,
    cacheWrite: cacheWriteKnown ? cacheWriteSum : null,
    firstContextTokens,
    firstUsage,
    models,
    lastEntryId,
    unknownReason: costMissing ? "cost-missing" : null,
  };
}
