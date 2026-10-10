import { topUnitsAvailable } from "./top.js";
import type { LoadLevel, LoadTopRow, TopSnapshot, LoadVerdict } from "./types.js";

export interface LoadMessageContext {
  readonly nested?: boolean;
  readonly top?: TopSnapshot;
  readonly ownRuns?: readonly string[];
  readonly now?: number;
}

const levelLabel = (level: LoadLevel): string => (level === "unknown" ? "unknown" : level);
const topRows = (rows: readonly LoadTopRow[], unitsAvailable = true): string =>
  rows.length === 0
    ? "unavailable"
    : !unitsAvailable
      ? rows.map((r) => `${r.comm}×${r.count} n/a`).join(" · ")
      : rows.map((r) => `${r.comm}×${r.count} ${Math.round(r.cpuPct)}%`).join(" · ");

export function buildLoadEscalationText(verdict: LoadVerdict, context: LoadMessageContext = {}): string {
  const runs =
    context.ownRuns !== undefined && context.ownRuns.length > 0
      ? ` · own runs: ${context.ownRuns.slice(0, 8).join(", ")}`
      : "";
  const top =
    context.top === undefined
      ? "top unavailable"
      : `top cpu: ${topRows(context.top.byCpu, topUnitsAvailable(context.top))} ｜ top rss: ${topRows(context.top.byRss, topUnitsAvailable(context.top))}`;
  const intro = context.nested
    ? "请不要再委派：自己完成剩余工作，或带着现状说明交回上层。"
    : "可二选一：① 排查负载来源；② 等待回落——v1 不会自动唤醒，可先做不需派发的工作。";
  return `[load] ${levelLabel(verdict.level)} · 系统负载过高${verdict.gating ? "，已暂停派发新子 agent" : "（仅提示，闸门已关闭，派发不受限）"}${runs}\n${top}\n${intro}`;
}

export function buildLoadRecoveryText(verdict: LoadVerdict, gateEnabled = true): string {
  return `[load] ${levelLabel(verdict.level)} · 负载已回落${gateEnabled ? "，可以继续派发" : "（仅提示，闸门已关闭，派发不受限）"}`;
}

export function buildLoadNotice(verdict: LoadVerdict, context: LoadMessageContext = {}): string {
  return buildLoadEscalationText(verdict, context);
}

export const buildLoadHintText = buildLoadEscalationText;
export const buildLoadRejectText = buildLoadEscalationText;
export const buildLoadRecoveryNotice = buildLoadRecoveryText;
