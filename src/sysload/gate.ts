import { topUnitsAvailable } from "./top.js";
import type { LoadSettings } from "../config/settings.js";
import { levelRank } from "./tracker.js";
import type { LoadLevel, LoadPort, LoadTopRow, TopSnapshot, LoadVerdict } from "./types.js";

export interface LoadGateRequest {
  readonly nested?: boolean;
  readonly top?: TopSnapshot;
  readonly ownRuns?: readonly string[];
}

export interface LoadGateDecision {
  readonly blocked: boolean;
  readonly message?: string;
}

const topText = (rows: readonly LoadTopRow[], unitsAvailable = true): string =>
  rows.length === 0
    ? "top unavailable"
    : !unitsAvailable
      ? rows.map((row) => `${row.comm}×${row.count} n/a`).join(" · ")
      : rows.map((row) => `${row.comm}×${row.count} ${Math.round(row.cpuPct)}%`).join(" · ");

export function evaluateLoadGate(
  verdict: LoadVerdict,
  settings: LoadSettings,
  request: LoadGateRequest = {},
): LoadGateDecision {
  if (!settings.enabled || !settings.gate || verdict.level === "unknown" || !verdict.gating) return { blocked: false };
  const detail = `[load] ${verdict.level} · load gate active`;
  const top = request.top;
  const topBlock =
    top === undefined
      ? "top snapshot unavailable; run `ps -eo pid,comm,%cpu,rss --sort=-%cpu | head`"
      : `top cpu: ${topText(top.byCpu, topUnitsAvailable(top))} ｜ top rss: ${topText(top.byRss, topUnitsAvailable(top))}`;
  const own =
    request.ownRuns !== undefined && request.ownRuns.length > 0
      ? ` · own runs: ${request.ownRuns.slice(0, 8).join(", ")}`
      : "";
  const message = request.nested
    ? `load gate: 系统负载过高（${verdict.level}），本次嵌套派发已拒绝，未创建任何 run / label / worktree。\n${detail}${own}\n${topBlock}\n请不要再委派：自己完成剩余工作，或带着现状说明交回上层。`
    : `load gate: 系统负载过高（${verdict.level}），本次派发已拒绝，未创建任何 run / label / worktree。\n${detail}${own}\n${topBlock}\n可二选一：① 排查负载来源；② 等待回落后在下一轮继续派发。`;
  return { blocked: true, message };
}

export function loadBlocked(port: LoadPort | undefined): boolean {
  try {
    return port?.verdict().gating ?? false;
  } catch {
    return false;
  }
}

export function loadLevelAtLeast(level: LoadLevel, threshold: "warn" | "crit"): boolean {
  return level !== "unknown" && levelRank(level) >= levelRank(threshold);
}

export function summarizeLoad(verdict: LoadVerdict): string {
  return `load ${verdict.level}${verdict.gating ? " · gated" : ""}`;
}
