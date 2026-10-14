/**
 * 用量账本（external-agent plan §3.3 L1–L8）。pi-free，provider 无关：字段归一由 provider 侧完成。
 * 一个 beginTurn 打开一个 turn；completeTurn 每个 turn 只处理一次（重复调用 ⇒ undefined）。
 */
import type { ExternalPricing, ExternalPricingDiag, UsageDelta } from "../core/types.js";
import { priceUsage } from "./pricing.js";
import type { CreateUsageLedger, ExternalTokenCounts, UsageLedger, UsageLedgerTotals } from "./types.js";

const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "thinking", "credits"] as const;

const zero = (): ExternalTokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, credits: 0 });

function clean(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}
function sanitize(c: ExternalTokenCounts | undefined): ExternalTokenCounts | undefined {
  if (c === undefined) return undefined;
  const o = zero();
  for (const f of FIELDS) o[f] = clean(c[f]);
  return o;
}
const isZero = (c: ExternalTokenCounts): boolean => FIELDS.every((f) => c[f] === 0);

export const createUsageLedger: CreateUsageLedger = (pricing: ExternalPricing, opts) => {
  let prev: ExternalTokenCounts | undefined;
  let inTurn = false;
  let emitted = zero(); // 本 turn 已发的原始字段增量
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  let credits = 0;
  let thinking = 0;
  let childTokens = 0;
  let overcount = false;
  let partial = false; // 出现无法定价的子 agent / 含子 agent 用量

  /** 原始字段增量 → UsageDelta（L5 thinking 折入 output；L7 计价）。 */
  function toDelta(d: ExternalTokenCounts, requestInput: number | undefined, unpricedPartial: boolean) {
    const tokens = {
      input: d.input,
      output: opts.thinkingInOutput ? d.output : d.output + d.thinking,
      cacheRead: d.cacheRead,
      cacheWrite: d.cacheWrite,
    };
    let costUsd = 0;
    if (pricing.status === "priced") costUsd = priceUsage(tokens, pricing.table, requestInput);
    const delta: UsageDelta = { ...tokens, costUsd };
    if (pricing.status === "unpriced") delta.unpriced = "all";
    else if (unpricedPartial) delta.unpriced = "partial";
    return delta;
  }

  function book(delta: UsageDelta): void {
    total.input += delta.input;
    total.output += delta.output;
    total.cacheRead += delta.cacheRead;
    total.cacheWrite += delta.cacheWrite;
    total.costUsd += delta.costUsd;
  }

  const ledger: UsageLedger = {
    beginTurn(baseline) {
      prev = sanitize(baseline);
      inTurn = true;
      emitted = zero();
    },
    observeCumulative(cumIn, lastCallIn) {
      const cum = sanitize(cumIn);
      if (cum === undefined) return undefined;
      if (!inTurn || prev === undefined) {
        prev = prev === undefined ? cum : maxOf(prev, cum);
        return undefined;
      }
      const d = zero();
      for (const f of FIELDS) d[f] = Math.max(0, cum[f] - prev[f]);
      prev = maxOf(prev, cum);
      if (isZero(d)) return undefined;
      for (const f of FIELDS) emitted[f] += d[f];
      credits += d.credits;
      thinking += d.thinking;
      const lc = sanitize(lastCallIn);
      const req = lc === undefined ? undefined : lc.input + lc.cacheRead + lc.cacheWrite;
      if (d.input + d.output + d.cacheRead + d.cacheWrite + d.thinking === 0) return undefined;
      const delta = toDelta(d, req !== undefined && req > 0 ? req : undefined, false);
      book(delta);
      return delta;
    },
    completeTurn(turnTotalIn, childIn) {
      if (!inTurn) return undefined;
      inTurn = false;
      const tt = sanitize(turnTotalIn) ?? zero();
      const child = sanitize(childIn);
      const childSum = child === undefined ? 0 : child.input + child.output + child.cacheRead + child.cacheWrite;
      const target = { ...tt };
      if (child !== undefined && opts.cumulativeIncludesChild) {
        for (const f of FIELDS) target[f] += child[f];
      }
      const rem = zero();
      for (const f of FIELDS) {
        if (emitted[f] > target[f]) overcount = true;
        rem[f] = Math.max(0, target[f] - emitted[f]);
      }
      credits += rem.credits;
      thinking += rem.thinking;
      let childDelta: ExternalTokenCounts | undefined;
      if (child !== undefined && childSum > 0) {
        childTokens += childSum;
        partial = true;
        if (!opts.cumulativeIncludesChild) childDelta = { ...child, thinking: 0, credits: 0 };
      }
      const tokenRem = rem.input + rem.output + rem.cacheRead + rem.cacheWrite + rem.thinking;
      if (tokenRem === 0 && childDelta === undefined) return undefined;
      const delta = toDelta(rem, undefined, childSum > 0);
      if (childDelta !== undefined) {
        // L6：子 agent token 计入、成本不计
        delta.input += childDelta.input;
        delta.output += childDelta.output;
        delta.cacheRead += childDelta.cacheRead;
        delta.cacheWrite += childDelta.cacheWrite;
        if (pricing.status === "priced") delta.unpriced = "partial";
      }
      book(delta);
      return delta;
    },
    lastCumulative() {
      return prev === undefined ? undefined : { ...prev };
    },
    totals(): UsageLedgerTotals {
      const usage: UsageDelta = { ...total };
      let diag: ExternalPricingDiag;
      if (pricing.status === "unpriced") {
        usage.unpriced = "all";
        diag = { status: "unpriced", reason: pricing.reason };
        if (pricing.detail !== undefined) diag.detail = pricing.detail;
      } else {
        diag = { status: partial ? "partial" : "priced", source: pricing.source, basis: pricing.basis };
        if (pricing.approx) diag.approx = true;
        if (partial) {
          usage.unpriced = "partial";
          diag.reason = "child_usage";
        }
      }
      return { usage, credits, thinking, childTokens, overcount, pricing: diag };
    },
  };
  return ledger;
};

function maxOf(a: ExternalTokenCounts, b: ExternalTokenCounts): ExternalTokenCounts {
  const o = zero();
  for (const f of FIELDS) o[f] = Math.max(a[f], b[f]);
  return o;
}
