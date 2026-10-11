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

const pct = (value: number | undefined): string => (value === undefined ? "—" : `${Math.round(value)}%`);
const bytes = (value: number | undefined): string =>
  value === undefined ? "—" : `${(value / 2 ** 30).toFixed(value >= 2 ** 30 ? 1 : 2).replace(/\.0$/, "")}G`;

/** Compact `[load] <level> · CPU · MEM · DISK` detail (plus a loadavg line when known), shared by the
 * admission rejection and the turn_end escalation hint so both report the same numbers. */
export function loadDetail(verdict: LoadVerdict): string {
  const cpu = verdict.metrics.cpu;
  const mem = verdict.metrics.mem;
  const disk = verdict.metrics.disk[0]?.state;
  const cpuText = `CPU ${pct(cpu.busyPct)}${cpu.psiPct === undefined ? "" : ` (PSI ${pct(cpu.psiPct)})`}`;
  const memText = `MEM ${pct(mem.availPct)} avail`;
  const diskText = disk === undefined ? "DISK —" : `DISK ${disk.mountPath ?? "/"} ${bytes(disk.freeBytes)} free`;
  const avg =
    verdict.loadavg === undefined
      ? ""
      : `\nloadavg ${verdict.loadavg.map((n) => n.toFixed(1)).join(" / ")}${verdict.cores === undefined ? "" : ` (${verdict.cores} cores)`}`;
  const since = verdict.gatingSinceMono === undefined ? "" : ` · since ${formatSince(verdict)}`;
  return `[load] ${verdict.level} · ${cpuText} · ${memText} · ${diskText}${since}${avg}`;
}

function formatSince(verdict: LoadVerdict): string {
  const elapsed = Math.max(0, verdict.mono - (verdict.gatingSinceMono ?? verdict.mono));
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.floor(elapsed / 1_000) % 60;
  const clock = new Date(verdict.at - elapsed).toISOString().slice(11, 16);
  return `${clock} (${minutes > 0 ? `${minutes}m` : `${seconds}s`})`;
}

export function evaluateLoadGate(
  verdict: LoadVerdict,
  settings: LoadSettings,
  request: LoadGateRequest = {},
): LoadGateDecision {
  if (!settings.enabled || !settings.gate || verdict.level === "unknown" || !verdict.gating) return { blocked: false };
  const detail = loadDetail(verdict);
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
