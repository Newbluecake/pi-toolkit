// 入口（plan.md v3.2 §1/§4.4 入口）：规则 + 状态约束 + 承接 + 投票的零调用
// 编排。pi-free；无模块级可变状态（I4）。deepseek/flight/ledger/outbound 属
// P2（§11.2），本文件不含、也不预留调用点之外的耦合。

import { carryHits, revalidateCarry } from "./carry.js";
import { runRules, RULES_VERSION } from "./rules.js";
import { detectStateConstraints } from "./state.js";
import { tally } from "./vote.js";
import type { PredictInput, PredictResult } from "./contracts.js";
import type { Taxonomy } from "../contracts.js";

export { RULES_VERSION };

const MIN_PROMPT_CODEPOINTS_FOR_UNCERTAIN = 40;
const DECISIVE_THRESHOLD = 0.85;
const MEDIUM_THRESHOLD = 0.5;

/** 规则 + 承接的零调用编排（§1 架构图 rules.ts/carry.ts/vote.ts 部分；不含
 *  deepseek）。`uncertain` 只覆盖 §4.4 条件 3-5（没有 ≥0.85 的 tag；没有
 *  ≥0.5 的 tag 或 prompt ≥40 码点；没有 cancel 修饰）——条件 1/2/6 是
 *  会话级/预算级门控，属 P2 调用方（wire.ts）判断，不在本函数范围。 */
export function runPredict(input: PredictInput, tax?: Taxonomy): PredictResult {
  const { hits: ruleHits, modifiers } = runRules(input, tax);
  const revalidatedCarry = input.carry === undefined ? undefined : revalidateCarry(input.carry, input);
  const hits = [...ruleHits, ...carryHits(revalidatedCarry)];
  const tags = tally({ hits, modifiers });
  const state = detectStateConstraints(input.bashJobs);

  const hasDecisiveTag = tags.some((t) => t.score >= DECISIVE_THRESHOLD);
  const hasMediumTag = tags.some((t) => t.score >= MEDIUM_THRESHOLD);
  const promptLongEnough = Array.from(input.prompt).length >= MIN_PROMPT_CODEPOINTS_FOR_UNCERTAIN;
  const cancelled = modifiers.some((m) => m.kind === "cancel");
  const uncertain = !hasDecisiveTag && (!hasMediumTag || promptLongEnough) && !cancelled;

  return {
    tags,
    state,
    origin: "rules",
    uncertain,
    modifiers,
  };
}
