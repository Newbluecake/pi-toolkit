// 投票（plan.md v3.2 §4）：同源归并 → 跨源 noisy-OR → 合并模型/缓存 →
// 最终修饰（否定/只读/取消全局最高优先级）。pi-free；无模块级可变状态。

import { CONFIDENCE_VALUE, DECISIVE_SCORE, SOURCE_WEIGHT } from "./contracts.js";
import type { Modifier, ScoredHit, SignalSource, TagScore } from "./contracts.js";

/** 单个命中的原始分：decisive 生效时固定 0.9；承接（C）命中自带 `score`
 *  （已含重验证衰减）；其余 = `w(source) × c(conf)`（§4.1 第 1 步）。 */
function hitScore(hit: ScoredHit): number {
  if (hit.score !== undefined) return hit.score;
  if (hit.decisive === true) return DECISIVE_SCORE;
  return SOURCE_WEIGHT[hit.source] * CONFIDENCE_VALUE[hit.conf];
}

/** 投票用的"同源"分组键：C 与 U 视为同源（§4.1 第 2 步）。 */
function voteSource(source: SignalSource): SignalSource {
  return source === "C" ? "U" : source;
}

export interface ModelHit {
  readonly tag: string;
  /** 0..1，调用方已过滤到 `p ≥ model.threshold` 且最多 3 个（§4.1 第 4 步）。 */
  readonly p: number;
}

export interface VoteInput {
  readonly hits: readonly ScoredHit[];
  readonly modifiers: readonly Modifier[];
  /** source M（deepseek 或缓存命中）；不在本包范围内调用，由上游包传入。 */
  readonly modelHits?: readonly ModelHit[];
}

const TOP_N = 6;
const MIN_SCORE = 0.3;

/** §4.1-§4.2：对全部命中打分、合并、施加最终修饰，输出降序 TagScore[]
 *  （score ≥0.3，至多 6 个）。 */
export function tally(input: VoteInput): readonly TagScore[] {
  // 第 2 步：同一 (source, tag) 取 max（C 并入 U 桶）。
  const perTagSource = new Map<string, Map<SignalSource, number>>();
  const rulesByTag = new Map<string, Set<string>>();
  const sourcesByTag = new Map<string, Set<SignalSource>>();

  const record = (tag: string, source: SignalSource, score: number, rule?: string): void => {
    let bySource = perTagSource.get(tag);
    if (bySource === undefined) {
      bySource = new Map();
      perTagSource.set(tag, bySource);
    }
    const key = voteSource(source);
    bySource.set(key, Math.max(bySource.get(key) ?? 0, score));
    let rules = rulesByTag.get(tag);
    if (rules === undefined) {
      rules = new Set();
      rulesByTag.set(tag, rules);
    }
    if (rule !== undefined) rules.add(rule);
    let sources = sourcesByTag.get(tag);
    if (sources === undefined) {
      sources = new Set();
      sourcesByTag.set(tag, sources);
    }
    sources.add(source);
  };

  for (const hit of input.hits) record(hit.tag, hit.source, hitScore(hit), hit.rule);
  if (input.modelHits !== undefined) {
    for (const m of input.modelHits) record(m.tag, "M", SOURCE_WEIGHT.M * m.p, "model");
  }

  // 第 3 步：跨源 noisy-OR。
  const finalScore = new Map<string, number>();
  for (const [tag, bySource] of perTagSource) {
    let survive = 1;
    for (const score of bySource.values()) survive *= 1 - score;
    finalScore.set(tag, 1 - survive);
  }

  // 第 5 步：最终修饰（negate/readonly/cancel 全局最高优先级，覆盖全部来源）。
  for (const modifier of input.modifiers) {
    if (modifier.kind === "question") continue; // 已在命中打分阶段生效（decisive 取消），不再置 0。
    const targets = modifier.tags === "all" ? [...finalScore.keys()] : modifier.tags;
    for (const tag of targets) finalScore.set(tag, 0);
  }

  const out: TagScore[] = [];
  for (const [tag, score] of finalScore) {
    if (score < MIN_SCORE) continue;
    out.push({
      tag,
      score,
      sources: [...(sourcesByTag.get(tag) ?? [])],
      rules: [...(rulesByTag.get(tag) ?? [])],
    });
  }
  out.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return out.slice(0, TOP_N);
}
