/**
 * pi-hud 移植：纯格式化函数（无 pi 依赖，可单测）。
 * 来源：~/.pi/agent/extensions/pi-hud.ts（用户自有插件，融合进本仓库）。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatDuration(durationMs: number): string {
  if (durationMs <= 0) return "0s";
  if (durationMs < 1_000) return "<1s";

  const totalSeconds = Math.floor(durationMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m${seconds.toString().padStart(2, "0")}s`;
  if (totalMinutes > 0) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatSpeed(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "0t/s";
  if (tokensPerSecond < 10) return `${tokensPerSecond.toFixed(1)}t/s`;
  return `${Math.round(tokensPerSecond)}t/s`;
}

export function formatStartTime(epochMs: number): string {
  const date = new Date(epochMs);
  const yyyy = date.getFullYear();
  const MM = (date.getMonth() + 1).toString().padStart(2, "0");
  const dd = date.getDate().toString().padStart(2, "0");
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${hh}:${mm}`;
}
