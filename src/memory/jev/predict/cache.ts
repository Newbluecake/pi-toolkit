// 会话内缓存（plan.md v3.2 §7）——精确键 LRU + `pendingModel` 单槽。
// pi-free、无模块级可变状态（I4）：全部状态在 `PredictCache` 实例闭包里，
// 时钟/容量/时长由构造参数注入；wire 闭包持有一个实例（每 activation 新建）。
//
// 边界（§7.2）：最终否定/只读修饰不在缓存里处理——兑现出的 tags 照常交给
// vote.ts 走 §4.2（negate/readonly 依然置 0）；缓存不另造优先级。

import { createHash } from "node:crypto";
import type { Evidence, Modifier, TagScore } from "./contracts.js";
import { isCarryPhrase } from "./carry.js";
import { PROMPT_VERSION } from "./llm.js";
import { serializePredictOutbound } from "./outbound.js";
import type { PredictOutboundV1 } from "./outbound.js";
import { RULES_VERSION } from "./rules.js";
import type { ModelHit } from "./vote.js";

// ───────────────────────────── 精确键（§7.1） ─────────────────────────────

export interface TurnKeyComponents {
  readonly dto: PredictOutboundV1;
  /** 模型链（provider/id 列表）。 */
  readonly models: readonly string[];
  readonly taxonomyRev: string;
  /** `predict.model.threshold`。 */
  readonly threshold: number;
}

/** `sha1(canonicalJson(dto) ∥ 模型链 ∥ PROMPT_VERSION ∥ RULES_VERSION ∥
 *  taxonomyRev ∥ threshold)`。键直接哈希外发 DTO 的规范化序列化（键序固定、
 *  标点与大小写原样保留——不做事前规范化），覆盖模型看到的全部字段与全部
 *  判定输入。命中场景：重试、resume 后重发、相同指令。 */
export function turnKey(components: TurnKeyComponents): string {
  const canonical = serializePredictOutbound(components.dto);
  const parts = [
    canonical,
    JSON.stringify(components.models),
    `prompt:${PROMPT_VERSION}`,
    `rules:${RULES_VERSION}`,
    `taxonomy:${components.taxonomyRev}`,
    `threshold:${components.threshold}`,
  ];
  return createHash("sha1").update(parts.join("\u0000"), "utf8").digest("hex");
}

// ───────────────────────────── PredictCache（§7.1/§7.2） ─────────────────────────────

/** LRU 容量（§7.1）。 */
export const CACHE_CAPACITY = 64;

/** 新指令兑现时的 M 分值封顶（§7.2 表）。 */
export const PENDING_CAP_P = 0.6;

export interface PredictCacheOptions {
  /** TTL，ms（`predict.cacheTtlMin` 换算；精确键与 pendingModel 共用）。 */
  readonly ttlMs: number;
  /** 时钟注入（测试用假时钟；缺省 Date.now）。 */
  readonly clock?: () => number;
  /** LRU 容量，缺省 64（测试可缩小）。 */
  readonly capacity?: number;
}

interface CacheEntry {
  readonly tags: readonly ModelHit[];
  readonly at: number;
}

/** §7.2 `pendingModel` 单槽：模型在等待窗口结束后才返回、flight 仍有效时的
 *  未及时结果（不投递，只在下一轮做意图兼容检查）。 */
export interface PendingModel {
  readonly tags: readonly ModelHit[];
  readonly evidence?: Evidence;
  readonly turnSeq: number;
  readonly at: number;
}

export interface RedeemPendingInput {
  /** 当前轮序号（须与 pending.turnSeq 相邻才可兑现）。 */
  readonly turnSeq: number;
  /** 新 prompt（承接短语判定用，原样传入）。 */
  readonly prompt: string;
  /** 当轮规则结果（tally 输出，含全部来源）——"当轮规则也命中"的判定依据。 */
  readonly currentTags: readonly TagScore[];
  /** 当轮修饰（cancel ⇒ 丢弃；negate/readonly 不在此处理）。 */
  readonly modifiers: readonly Modifier[];
  /** T/W 状态来源支撑的 tag（规则命中之外的状态证据，如进行中的发版 job）；
   *  缺省只看规则命中。 */
  readonly stateSupportedTags?: ReadonlySet<string>;
}

export type PendingRedeem =
  | { readonly kind: "none" }
  | { readonly kind: "dropped" }
  | { readonly kind: "full"; readonly tags: readonly ModelHit[]; readonly evidence?: Evidence }
  | { readonly kind: "capped"; readonly tags: readonly ModelHit[]; readonly evidence?: Evidence };

/** 会话内缓存：精确键 LRU（键=turnKey，值=tags）+ pendingModel 单槽。 */
export class PredictCache {
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly capacity: number;
  private readonly entries = new Map<string, CacheEntry>(); // 插入序即 LRU 序（get 触碰重插）
  private pending: PendingModel | undefined;

  constructor(options: PredictCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.clock = options.clock ?? Date.now;
    this.capacity = Math.max(1, options.capacity ?? CACHE_CAPACITY);
  }

  /** TTL 内命中返回 tags（并刷新 LRU 新鲜度）；过期则淘汰并返回 undefined。 */
  get(key: string): readonly ModelHit[] | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (this.clock() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.tags;
  }

  /** 写入并盖时间戳；超出容量逐最旧淘汰（get 已把触碰项移到最新端）。 */
  set(key: string, tags: readonly ModelHit[]): void {
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { tags: [...tags], at: this.clock() });
  }

  /** 覆写 pendingModel 单槽（§7.2：late 结果同时写 turnKey 缓存与这里）。 */
  setPending(tags: readonly ModelHit[], evidence: Evidence | undefined, turnSeq: number): void {
    this.pending = {
      tags: [...tags],
      ...(evidence === undefined ? {} : { evidence }),
      turnSeq,
      at: this.clock(),
    };
  }

  /** 当前 pendingModel（只读窥视，不清空；诊断/测试用）。 */
  peekPending(): PendingModel | undefined {
    return this.pending;
  }

  /** §7.2 意图兼容检查 + 兑现。任何兑现尝试（含丢弃/过期/不相邻）都清空
   *  单槽——用过一次即清空：
   *   · turnSeq 不相邻或超 TTL ⇒ `none`；
   *   · cancel 修饰 ⇒ `dropped`；
   *   · 承接短语 ⇒ `full`（全权重，原 p 不变）；
   *   · 其他新指令 ⇒ `capped`：只保留"当轮规则也命中，或有 T/W 状态来源
   *     支撑"的 tag，p 封顶 `PENDING_CAP_P`（0.6，单独不能达到注入门槛）。
   *  最终否定/只读由 vote 路径处理（§7.2 并入后照常过 §4.2），此处不碰。 */
  redeemPending(input: RedeemPendingInput): PendingRedeem {
    const pending = this.pending;
    if (pending === undefined) return { kind: "none" };
    this.pending = undefined; // 用过一次即清空（所有分支同此）
    if (input.turnSeq !== pending.turnSeq + 1) return { kind: "none" };
    if (this.clock() - pending.at > this.ttlMs) return { kind: "none" };
    if (input.modifiers.some((m) => m.kind === "cancel")) return { kind: "dropped" };
    const attach = <T extends object>(result: T): T & { evidence?: Evidence } =>
      pending.evidence === undefined ? result : { ...result, evidence: pending.evidence };
    if (isCarryPhrase(input.prompt)) {
      return attach({ kind: "full", tags: pending.tags });
    }
    const supported = new Set<string>(input.currentTags.map((t) => t.tag));
    for (const tag of input.stateSupportedTags ?? []) supported.add(tag);
    const tags = pending.tags
      .filter((t) => supported.has(t.tag))
      .map((t) => ({ tag: t.tag, p: Math.min(t.p, PENDING_CAP_P) }));
    return attach({ kind: "capped", tags });
  }
}
