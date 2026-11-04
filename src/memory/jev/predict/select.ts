// 选条目（plan.md v3.2 §5.1 选条目 / §5.4 40 槽配额）。pi-free；无模块级可
// 变状态（I4）。
//
// §5.1 的真实实现依赖 `MemEntry`/`effectiveMeta`/`segment` 等 jev 内部状态
// （wire.ts，非 pi-free，I8 不能在此 import）。本文件提供其纯函数内核：
// 调用方（P1b 已落地的 wire 接线，wire.ts `predictCandidatesFor`/`commitParts`）
// 把条目摊平成下面的 `Candidate` 形状后再调用。排除 private/secret/injected/staticCore/冷却、pending 默认
// importance=2 跳过 type 检查、`authority=user` 加成、`fitPicks` 字节/条目
// 预算，均按 §5.1 公式逐字实现。

import type { StateConstraint, TagScore } from "./contracts.js";

// ───────────────────────────── fastPathEligibleTags（§5.1） ─────────────────────────────

export interface TagRiskInfo {
  readonly id: string;
  readonly risk?: "normal" | "high";
}

export interface FastPathTagConfig {
  readonly allowTags: readonly string[];
  readonly denyTags: readonly string[];
}

/** 高危 tag 并 allow 减 deny（与 A 层 `fastPathEligibleTags` 同口径，§5.1；
 *  independently re-derived here — wire.ts 非 pi-free，不能共享实现，I8）。 */
export function fastPathEligibleTags(tags: readonly TagRiskInfo[], config: FastPathTagConfig): ReadonlySet<string> {
  const allow = new Set(config.allowTags);
  const deny = new Set(config.denyTags);
  const out = new Set<string>();
  for (const t of tags) {
    if ((t.risk === "high" || allow.has(t.id)) && !deny.has(t.id)) out.add(t.id);
  }
  return out;
}

// ───────────────────────────── 条目候选（§5.1） ─────────────────────────────

export interface Candidate {
  readonly hash: string;
  readonly isPrivate: boolean;
  readonly isSecret: boolean;
  readonly isInjected: boolean;
  readonly isStaticCore: boolean;
  /** `pInjectedAt` 冷却命中（§10 `cooldownH`，由调用方按当前时间算好）。 */
  readonly coolingDown: boolean;
  /** `meta.tags === undefined`（无 sidecar 记录）。 */
  readonly pending: boolean;
  /** pending 时可省略（视为 2）。 */
  readonly importance?: number;
  readonly type?: "rule" | "pitfall" | "procedure" | string;
  readonly authority?: "user" | "model" | "none";
  /** tag → p(e,t)，仅含该条目实际共享的 tag。 */
  readonly tagP: Readonly<Record<string, number>>;
  readonly byteLength: number;
}

export interface SelectPInput {
  readonly tags: readonly TagScore[];
  readonly eligibleTags: ReadonlySet<string>;
  readonly candidates: readonly Candidate[];
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface SelectedPEntry {
  readonly hash: string;
  readonly score: number;
  readonly byteLength: number;
}

function excludedByFlags(c: Candidate): boolean {
  return c.isPrivate || c.isSecret || c.isInjected || c.isStaticCore || c.coolingDown;
}

function passesTypeGate(c: Candidate): boolean {
  if (c.pending) return true; // pending ⇒ importance=2，跳过 type 检查（§5.1）。
  const importance = c.importance ?? 0;
  return importance >= 2 && (c.type === "rule" || c.type === "pitfall" || c.type === "procedure");
}

function effectiveImportance(c: Candidate): number {
  return c.pending ? 2 : (c.importance ?? 0);
}

/** `eligibleTags = { t | finalScore(t) ≥ 0.85 ∧ t ∈ fastPathEligibleTags }`
 *  （§5.1 第 1 行）。 */
export function eligibleTagsOf(tags: readonly TagScore[], fastPathEligible: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of tags) {
    if (t.score >= 0.85 && fastPathEligible.has(t.tag)) out.add(t.tag);
  }
  return out;
}

/** 单个条目在 eligibleTags 下的分数：`max_t(finalScore(t) × p(e,t)) ×
 *  importance × (authority=user ? 1.25 : 1)`（§5.1）；不存在共享 tag 时
 *  返回 undefined（调用方应跳过）。 */
export function scoreCandidate(
  c: Candidate,
  tags: readonly TagScore[],
  eligibleTags: ReadonlySet<string>,
): number | undefined {
  if (excludedByFlags(c)) return undefined;
  const shared = Object.keys(c.tagP).filter((t) => eligibleTags.has(t));
  if (shared.length === 0) return undefined;
  if (!passesTypeGate(c)) return undefined;
  const byTag = new Map(tags.map((t) => [t.tag, t.score] as const));
  let best = 0;
  for (const t of shared) {
    const finalScore = byTag.get(t) ?? 0;
    best = Math.max(best, finalScore * c.tagP[t]!);
  }
  const importance = effectiveImportance(c);
  const authorityBonus = c.authority === "user" ? 1.25 : 1;
  return best * importance * authorityBonus;
}

/** 贪心按分数取前 `maxEntries` 个、累计 `byteLength` 不超过 `maxBytes`
 *  （§5.1 `fitPicks`；分高者优先，预算不够则跳过换下一个，不是硬截断）。 */
function fitPicks(
  scored: readonly { readonly hash: string; readonly score: number; readonly byteLength: number }[],
  maxEntries: number,
  maxBytes: number,
): readonly SelectedPEntry[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.hash.localeCompare(b.hash));
  const out: SelectedPEntry[] = [];
  let bytes = 0;
  for (const s of sorted) {
    if (out.length >= maxEntries) break;
    if (bytes + s.byteLength > maxBytes) continue;
    out.push(s);
    bytes += s.byteLength;
  }
  return out;
}

/** §5.1 全流程：eligibleTags → 逐条目打分/过滤 → `fitPicks`。 */
export function selectPEntries(input: SelectPInput): readonly SelectedPEntry[] {
  const eligible = eligibleTagsOf(input.tags, input.eligibleTags);
  if (eligible.size === 0) return [];
  const scored: { hash: string; score: number; byteLength: number }[] = [];
  for (const c of input.candidates) {
    const score = scoreCandidate(c, input.tags, eligible);
    if (score !== undefined) scored.push({ hash: c.hash, score, byteLength: c.byteLength });
  }
  return fitPicks(scored, input.maxEntries, input.maxBytes);
}

// ───────────────────────────── S 条目（§3.4 / §5.1） ─────────────────────────────

export interface SCandidate {
  readonly hash: string;
  readonly isPrivate: boolean;
  readonly isSecret: boolean;
  readonly authority?: "user" | "model" | "none";
  readonly type?: "rule" | "pitfall" | "procedure" | string;
  /** 该条目是否带 `release` tag。 */
  readonly hasReleaseTag: boolean;
  readonly byteLength: number;
}

/** 发版进行中（S）至多选 1 条：tag 含 `release` 且 `authority=user` 或
 *  `type=rule`；计入同一字节预算（§3.4、§5.1）。state 为空直接返回
 *  undefined。 */
export function selectSEntry(
  state: readonly StateConstraint[],
  candidates: readonly SCandidate[],
  remainingBytes: number,
): SelectedPEntry | undefined {
  if (state.length === 0) return undefined;
  const eligible = candidates.filter(
    (c) => !c.isPrivate && !c.isSecret && c.hasReleaseTag && (c.authority === "user" || c.type === "rule"),
  );
  if (eligible.length === 0) return undefined;
  eligible.sort((a, b) => {
    const userRank = (c: SCandidate): number => (c.authority === "user" ? 0 : 1);
    return userRank(a) - userRank(b) || a.hash.localeCompare(b.hash);
  });
  const picked = eligible[0]!;
  if (picked.byteLength > remainingBytes) return undefined;
  return { hash: picked.hash, score: 1, byteLength: picked.byteLength };
}

// ───────────────────────────── 40 槽配额（§5.4） ─────────────────────────────

export interface PriorityCandidate {
  readonly hash: string;
  readonly file: string;
  readonly p: number;
  readonly importance: number;
  readonly isUserAuthority: boolean;
}

const PRIORITY_SLOTS = 40;

/** §5.4：eligible 超过 `RECALL_MAX_CANDIDATES`（360，调用方判断）时才生效。
 *  从带预测 tag（score ≥0.5，由调用方预先筛选出 `candidates`）的条目中保留
 *  最多 40 槽，排序为用户令 → `max p × importance` 降序 → file 升序。 */
export function prioritizeCandidates(candidates: readonly PriorityCandidate[]): readonly PriorityCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.isUserAuthority !== b.isUserAuthority) return a.isUserAuthority ? -1 : 1;
    const scoreDiff = b.p * b.importance - a.p * a.importance;
    if (scoreDiff !== 0) return scoreDiff;
    return a.file.localeCompare(b.file);
  });
  return sorted.slice(0, PRIORITY_SLOTS);
}
