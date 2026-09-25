/**
 * pi-hud 移植：footer 安装与全部 render* 函数（TUI 重代码，真机验证不测单测）。
 * 通过 ctx.ui.setFooter 整体替换 pi 内置 footer；footerData.getExtensionStatuses()
 * 聚合渲染其他扩展 status（cache-ttl / goal / feishu-notify 的状态行继续可见）。
 */
import { resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  formatCwdForFooter,
  formatDuration,
  formatSpeed,
  formatStartTime,
  formatTokens,
  sanitizeStatusText,
} from "./format.js";
import type { GitState, WorktreeInfo } from "./git.js";
import type { HudSession } from "./index.js";
import type { PluginInfo } from "./plugin-info.js";

const MAX_VISIBLE_WORKTREES = 10;

function renderRepoState(ctx: ExtensionContext, state: GitState, label?: string): string {
  const theme = ctx.ui.theme;
  const local = `${state.branch}${state.localOid ? `@${state.localOid}` : ""}`;
  const ahead = state.ahead > 0 ? ` ${theme.fg("warning", `↑${state.ahead}`)}` : "";
  const behind = state.behind > 0 ? ` ${theme.fg("error", `↓${state.behind}`)}` : "";
  const dirty = state.dirty > 0 ? ` ${theme.fg("warning", `±${state.dirty}`)}` : "";
  return `${theme.fg("dim", label ? `${label} ${local}` : local)}${ahead}${behind}${dirty}`;
}

function renderGitState(ctx: ExtensionContext, state: GitState): string {
  return renderRepoState(ctx, state, "git");
}

function renderWorktreeLines(session: HudSession, ctx: ExtensionContext, width: number): string[] {
  const worktrees = session.worktrees;
  if (!worktrees || worktrees.length < 2) return [];
  const theme = ctx.ui.theme;
  const cwd = resolve(ctx.cwd);
  const home = process.env.HOME || process.env.USERPROFILE;
  const isCurrent = (wt: WorktreeInfo) => cwd === wt.path || cwd.startsWith(`${wt.path}${sep}`);
  // 当前 worktree 已在 pwdLine（cwd + git 状态）里展示过，列表里只列其余 worktree，
  // 避免 "~/repo | git dev@xxx" 与 "● ~/repo dev@xxx" 两行信息重复。
  const others = worktrees.filter((wt) => !isCurrent(wt));
  if (others.length === 0) return [];
  const lines = others.slice(0, MAX_VISIBLE_WORKTREES).map((wt) => {
    const marker = theme.fg("dim", "○");
    const wtPath = theme.fg("muted", formatCwdForFooter(wt.path, home));
    let refPart: string;
    if (wt.state) {
      refPart = ` ${renderRepoState(ctx, wt.state)}`;
    } else {
      const ref = wt.branch ?? (wt.oid ? `@${wt.oid}` : undefined);
      refPart = ref ? ` ${theme.fg("dim", ref)}` : "";
    }
    return truncateToWidth(`${marker} ${wtPath}${refPart}`, width, theme.fg("dim", "..."));
  });
  if (others.length > MAX_VISIBLE_WORKTREES) {
    lines.push(theme.fg("dim", `… +${others.length - MAX_VISIBLE_WORKTREES} more`));
  }
  return lines;
}

export function renderConversationStats(session: HudSession, ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  return `${theme.fg("dim", "input ")}${theme.fg("text", String(session.userInputs))}${theme.fg("dim", " · rounds ")}${theme.fg("text", String(session.llmRequests))}`;
}

function renderSessionStart(session: HudSession, ctx: ExtensionContext): string | undefined {
  const sessionStartedAt = session.timing.sessionStartedAt;
  if (sessionStartedAt === undefined) return undefined;
  const theme = ctx.ui.theme;
  return `${theme.fg("dim", "start ")}${theme.fg("muted", formatStartTime(sessionStartedAt))}`;
}

/**
 * 插件自身信息段：`toolkit v0.2.1@b5edde5* 2026-09-25 14:16`（`*` = 工作树有未提交改动）。
 * 缺哪段省哪段；全缺返回 undefined（整段不占位）。纯函数，可单测。
 */
export function renderPluginInfo(
  info: PluginInfo | undefined,
  theme: { fg(color: string, text: string): string },
): string | undefined {
  if (!info) return undefined;
  let ident = info.version ? `v${info.version}` : "";
  if (info.commit) ident += `@${info.commit}${info.dirty ? "*" : ""}`;
  const time = info.commitTime === undefined ? "" : formatStartTime(info.commitTime);
  if (!ident && !time) return undefined;
  const identPart = ident ? theme.fg("muted", ident) : "";
  const timePart = time ? theme.fg("dim", time) : "";
  return `${theme.fg("dim", "toolkit ")}${[identPart, timePart].filter(Boolean).join(" ")}`;
}

/**
 * 首行布局（纯函数，可单测）：左 cwd │ git [• 会话名] [│ toolkit …]，右对齐模型。
 * 宽度不够时的降级顺序：先去掉 provider 前缀 → 再去掉插件信息 → 最后左侧截断优先、
 * 模型名截断到剩余宽度（与旧 stats 行右侧模型的截断语义一致）。
 */
export function layoutTopLine(
  parts: { left: string; plugin?: string; model: string; modelWithProvider?: string },
  width: number,
  theme: { fg(color: string, text: string): string },
): string {
  const sep = theme.fg("dim", " │ ");
  const leftWithPlugin = parts.plugin ? `${parts.left}${sep}${parts.plugin}` : parts.left;
  const candidates: Array<[string, string]> = [];
  if (parts.modelWithProvider) candidates.push([leftWithPlugin, parts.modelWithProvider]);
  candidates.push([leftWithPlugin, parts.model]);
  if (parts.plugin) candidates.push([parts.left, parts.model]);
  for (const [left, right] of candidates) {
    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    if (lw + 2 + rw <= width) return left + " ".repeat(width - lw - rw) + theme.fg("dim", right);
  }
  const left = truncateToWidth(parts.left, width, theme.fg("dim", "..."));
  const lw = visibleWidth(left);
  const available = width - lw - 2;
  const right = available > 0 ? truncateToWidth(parts.model, available, "") : "";
  if (!right) return left;
  return left + " ".repeat(Math.max(0, width - lw - visibleWidth(right))) + theme.fg("dim", right);
}

export function renderToolStats(session: HudSession, ctx: ExtensionContext): string {
  const theme = ctx.ui.theme;
  const sorted = [...session.toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  const visible = sorted
    .slice(0, 4)
    .map(([name, count]) => `${theme.fg("dim", name)}${theme.fg("muted", `×${count}`)}`)
    .join(" ");
  const hidden = sorted.length > 4 ? theme.fg("dim", ` +${sorted.length - 4}`) : "";
  const active = session.activeToolCalls > 0 ? ` ${theme.fg("accent", `●${session.activeToolCalls}`)}` : "";
  const failed = session.failedToolCalls > 0 ? ` ${theme.fg("error", `!${session.failedToolCalls}`)}` : "";
  const breakdown = visible ? `${theme.fg("dim", " · ")}${visible}${hidden}` : "";
  return `${theme.fg("dim", "tools Σ")}${theme.fg("text", String(session.totalToolCalls))}${breakdown}${active}${failed}`;
}

function renderBgAgents(session: HudSession, ctx: ExtensionContext): string | undefined {
  if (session.bgAgents.size === 0) return undefined;
  const theme = ctx.ui.theme;
  const oldest = Math.min(...session.bgAgents.values());
  const elapsed = formatDuration(Math.max(0, performance.now() - oldest));
  return `${theme.fg("dim", "bg ")}${theme.fg("accent", `●${session.bgAgents.size}`)}${theme.fg("muted", ` ${elapsed}`)}`;
}

/**
 * 扩展状态行组装（纯函数，可单测）：
 * - quota 条目独占一行，放在最后（多 provider + stale 标记的宽度随时间增长，
 *   挤在 status 行里会把 cache 等状态押到折行外；且额度是调度参考值，
 *   与 keepalive 心跳不是同一关注面）。
 * - 其余条目按 key localeCompare 排序、sanitize 后 join(" ") 合并为一行。
 * - feishu-notify 条目用 theme.fg("muted", ...) 包裹，与其余 footer 状态标签同色调。
 * - 空文本条目跳过；两行都可能缺席（返回数组不含空串）。
 */
/**
 * Statuses rendered on the time line (after start / LLM timing / bg agents,
 * separated by " │ ") instead of the extension status line, in this order:
 * the feishu-notify watch marker, then the HUD's own input · rounds counter.
 */
const TIME_LINE_STATUS_KEYS = ["feishu-notify", "pi-hud"] as const;

/**
 * Status keys kept off the shared status line. `pi-subagent:web-hub` mirrors
 * WEB_HUB_STATUS_KEY in src/web-hub/agent/index.ts (a literal here so the HUD
 * never loads the web-hub module graph); it gets its own line, or shares the
 * quota line when both fit. `quota` always comes last.
 */
const WEB_HUB_STATUS_KEY = "pi-subagent:web-hub";
const OWN_LINE_STATUS_KEYS = [WEB_HUB_STATUS_KEY, "quota"] as const;

export function renderTimeLineStatusParts(
  entries: readonly [string, string][],
  theme: { fg(color: string, text: string): string },
): string[] {
  const parts: string[] = [];
  for (const key of TIME_LINE_STATUS_KEYS) {
    const text = entries.find(([k]) => k === key)?.[1];
    const sanitized = text === undefined ? "" : sanitizeStatusText(text);
    if (!sanitized) continue;
    // feishu-notify supplies plain status text; keep its active marker in the
    // same subdued palette as the other footer labels.
    parts.push(key === "feishu-notify" ? theme.fg("muted", sanitized) : sanitized);
  }
  return parts;
}

export function renderExtensionStatusLines(
  entries: readonly [string, string][],
  theme: { fg(color: string, text: string): string },
  /** Footer width. When given and web-hub fits after the quota text, the two share the quota line. */
  width?: number,
): string[] {
  const timeLineKeys: readonly string[] = TIME_LINE_STATUS_KEYS;
  const ownLineKeys: readonly string[] = OWN_LINE_STATUS_KEYS;
  const others = entries
    .filter(([key]) => !ownLineKeys.includes(key) && !timeLineKeys.includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text) || undefined)
    .filter((part): part is string => part !== undefined);
  const lines: string[] = [];
  if (others.length > 0) lines.push(others.join(" "));
  const own = (key: string): string | undefined => {
    const text = entries.find(([k]) => k === key)?.[1];
    return text === undefined ? undefined : sanitizeStatusText(text) || undefined;
  };
  const web = own(WEB_HUB_STATUS_KEY);
  const quota = own("quota");
  // web-hub is short (`web ●`): ride on the quota line when both fit in one
  // row; otherwise (or without a width) each keeps a line of its own.
  const sep = theme.fg("dim", " │ ");
  if (web !== undefined && quota !== undefined && width !== undefined) {
    if (visibleWidth(quota) + visibleWidth(sep) + visibleWidth(web) <= width) {
      lines.push(quota + sep + web);
      return lines;
    }
  }
  if (web !== undefined) lines.push(web);
  if (quota !== undefined) lines.push(quota);
  return lines;
}

/**
 * One broadcast entry of the `subagent:usage` map (runId → cost/terminal),
 * as kept by the HUD session and folded by computeLiveSubagentCost().
 * `absorbed` marks a run whose lifetime spend already rode into its parent
 * run's accumulator on a usage-bearing toolResult (nested Agent /
 * get_subagent_result / consult) — see usage-broadcast.ts.
 */
export interface SubUsageEntry {
  costUsd: number;
  terminal: boolean;
  absorbed?: boolean;
}

/**
 * Fold the broadcast map into the footer's `+agents` component: the spend of
 * every run NOT yet accounted on a session toolResult (subAccounted) and not
 * absorbed into another tracked run's accumulator (X12 — nested Agent /
 * consult / get_subagent_result spend rides the parent's toolResult usage;
 * counting both would double-bill). Returns the total and whether any counted
 * run is still burning money (yellow vs grey).
 */
export function computeLiveSubagentCost(
  subUsage: ReadonlyMap<string, SubUsageEntry>,
  subAccounted: ReadonlySet<string>,
): { costUsd: number; anyActive: boolean } {
  let costUsd = 0;
  let anyActive = false;
  for (const [rid, u] of subUsage) {
    if (subAccounted.has(rid)) continue;
    if (u.absorbed) continue;
    costUsd += u.costUsd;
    if (!u.terminal) anyActive = true;
  }
  return { costUsd, anyActive };
}

function renderLlmTiming(session: HudSession, ctx: ExtensionContext): string {
  const timing = session.timing;
  const activeLlmDurationMs = timing.llmStartedAt === undefined ? undefined : performance.now() - timing.llmStartedAt;
  const activeRoundDurationMs = timing.roundStartedAt === undefined ? 0 : performance.now() - timing.roundStartedAt;
  const currentDurationMs = activeLlmDurationMs ?? timing.lastLlmDurationMs;
  const current = currentDurationMs === undefined ? "—" : formatDuration(currentDurationMs);
  const total = formatDuration(timing.totalRoundDurationMs + activeRoundDurationMs);
  const active = timing.llmStartedAt === undefined ? "" : `${ctx.ui.theme.fg("accent", "●")} `;
  let speedTps: number | undefined;
  if (session.streamStartedAt !== undefined) {
    speedTps = session.speed.windowSpeed();
  } else {
    speedTps = timing.lastSpeedTps;
  }
  const theme = ctx.ui.theme;
  const speed = speedTps === undefined ? "" : `${theme.fg("dim", " @ ")}${theme.fg("success", formatSpeed(speedTps))}`;
  return `${theme.fg("dim", "llm ")}${active}${theme.fg("text", current)}${speed}${theme.fg("dim", " · Σ")}${theme.fg("muted", total)}`;
}

export function installFooter(session: HudSession, ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const requestRender = () => tui.requestRender();
    const unsubscribeBranch = footerData.onBranchChange(requestRender);
    session.footerRequestRender = requestRender;

    return {
      dispose: () => {
        unsubscribeBranch();
        if (session.footerRequestRender === requestRender) session.footerRequestRender = undefined;
      },
      invalidate() {},
      render(width: number): string[] {
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        let latestInput = 0;
        let latestOutput = 0;
        let latestCacheRead = 0;
        let latestCacheWrite = 0;
        let latestCost = 0;
        // 已经 session 入账的子代理 runId（usage 携带在 toolResult 上）。
        const subAccounted = new Set<string>();

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message") continue;
          // 子代理/嵌套 LLM 调用的花费：pi 的 usage accounting 把它们
          // 挂在 toolResult 消息上（如 pi-subagent 的 Agent /
          // get_subagent_result）。计入 total，不计入 req（req 语义为
          // 主会话最近一次 LLM 请求）。
          if (entry.message.role === "toolResult") {
            const tu = (
              entry.message as {
                usage?: {
                  input: number;
                  output: number;
                  cacheRead: number;
                  cacheWrite: number;
                  cost: { total: number };
                };
              }
            ).usage;
            if (tu) {
              totalInput += tu.input;
              totalOutput += tu.output;
              totalCacheRead += tu.cacheRead;
              totalCacheWrite += tu.cacheWrite;
              totalCost += tu.cost.total;
              const det = (entry.message as { details?: { runId?: unknown; runIds?: unknown } }).details;
              const rid = det?.runId;
              if (typeof rid === "string") subAccounted.add(rid);
              // SubagentWorkflow 结果携带批量 runIds（子运行集合）
              if (Array.isArray(det?.runIds))
                for (const r of det.runIds) if (typeof r === "string") subAccounted.add(r);
            }
            continue;
          }
          if (entry.message.role !== "assistant") continue;
          const usage = entry.message.usage;
          totalInput += usage.input;
          totalOutput += usage.output;
          totalCacheRead += usage.cacheRead;
          totalCacheWrite += usage.cacheWrite;
          totalCost += usage.cost.total;
          latestInput = usage.input;
          latestOutput = usage.output;
          latestCacheRead = usage.cacheRead;
          latestCacheWrite = usage.cacheWrite;
          latestCost = usage.cost.total;
        }

        const activeBranch = ctx.sessionManager.getBranch();
        for (const entry of [...activeBranch].reverse()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            latestCost = entry.message.usage.cost.total;
            break;
          }
        }

        let thinkingLevel = "off";
        for (const entry of activeBranch) {
          if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
        }

        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent == null ? "?" : contextPercentValue.toFixed(1);
        const contextDisplay =
          contextPercent === "?"
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
        const contextPercentStr =
          contextPercentValue > 90
            ? theme.fg("error", contextDisplay)
            : contextPercentValue > 70
              ? theme.fg("warning", contextDisplay)
              : theme.fg("dim", contextDisplay);

        const statsParts: string[] = [];
        const totalParts: string[] = [];
        // 实时子代理花费：尚未经 toolResult 入账的 run 的累计成本。
        // 运行中显黄色（还在烧钱），全部终态但未取回时显灰色（残留尾差）。
        const live = computeLiveSubagentCost(session.subUsage, subAccounted);
        const liveSubCost = live.costUsd;
        const liveSubActive = live.anyActive;
        if (totalInput) totalParts.push(theme.fg("success", `↑${formatTokens(totalInput)}`));
        if (totalOutput) totalParts.push(theme.fg("accent", `↓${formatTokens(totalOutput)}`));
        if (totalCacheRead) totalParts.push(theme.fg("dim", `R${formatTokens(totalCacheRead)}`));
        if (totalCacheWrite) totalParts.push(theme.fg("warning", `W${formatTokens(totalCacheWrite)}`));
        if (totalParts.length > 0 || liveSubCost > 0) {
          totalParts.push(`${theme.fg("dim", "Σ")}${theme.fg("text", `$${totalCost.toFixed(3)}`)}`);
          if (liveSubCost > 0)
            totalParts.push(
              `${theme.fg("dim", "+agents ")}${theme.fg(liveSubActive ? "warning" : "muted", `$${liveSubCost.toFixed(3)}`)}`,
            );
          statsParts.push(`${theme.fg("dim", "total ")}${totalParts.join(" ")}`);
        }
        const reqParts: string[] = [];
        if (latestInput) reqParts.push(theme.fg("success", `↑${formatTokens(latestInput)}`));
        if (latestOutput) reqParts.push(theme.fg("accent", `↓${formatTokens(latestOutput)}`));
        if (latestCacheRead) reqParts.push(theme.fg("dim", `R${formatTokens(latestCacheRead)}`));
        if (latestCacheWrite) reqParts.push(theme.fg("warning", `W${formatTokens(latestCacheWrite)}`));
        reqParts.push(theme.fg("text", `$${latestCost.toFixed(3)}`));
        statsParts.push(`${theme.fg("dim", "req ")}${reqParts.join(" ")}`);
        statsParts.push(contextPercentStr);

        const pwdText = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        let pwdLine = theme.fg("muted", pwdText);
        if (session.gitState) {
          pwdLine += `${theme.fg("dim", " │ ")}${renderGitState(ctx, session.gitState)}`;
        } else {
          const branch = footerData.getGitBranch();
          if (branch) pwdLine += `${theme.fg("dim", " (")}${theme.fg("accent", branch)}${theme.fg("dim", ")")}`;
        }
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwdLine += `${theme.fg("dim", " • ")}${theme.fg("muted", sessionName)}`;
        const pluginInfo = renderPluginInfo(session.pluginInfo, theme);

        const modelName = ctx.model?.id || "no-model";
        let modelText = modelName;
        if (ctx.model?.reasoning) {
          modelText = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        const modelWithProvider =
          footerData.getAvailableProviderCount() > 1 && ctx.model ? `(${ctx.model.provider}) ${modelText}` : undefined;

        const statsLine = truncateToWidth(statsParts.join(theme.fg("dim", " │ ")), width, "...");

        const extensionStatuses = footerData.getExtensionStatuses();
        const statusEntries = Array.from(extensionStatuses.entries());
        const lines = [
          layoutTopLine(
            {
              left: pwdLine,
              ...(pluginInfo ? { plugin: pluginInfo } : {}),
              model: modelText,
              ...(modelWithProvider ? { modelWithProvider } : {}),
            },
            width,
            theme,
          ),
          ...renderWorktreeLines(session, ctx, width),
          statsLine,
        ];
        const timeParts = [
          renderSessionStart(session, ctx),
          renderLlmTiming(session, ctx),
          renderBgAgents(session, ctx),
          ...renderTimeLineStatusParts(statusEntries, theme),
        ].filter((part): part is string => Boolean(part));
        if (timeParts.length > 0) {
          // Wrap rather than truncate: the line now also carries the watch
          // marker and input · rounds, which must not vanish on narrow terminals.
          lines.push(...wrapTextWithAnsi(timeParts.join(theme.fg("dim", " │ ")), width));
        }
        // 扩展状态行（status 行 + quota 独占行），随后 tools 统计独占一行。
        for (const statusLine of renderExtensionStatusLines(statusEntries, theme, width)) {
          lines.push(...wrapTextWithAnsi(statusLine, width));
        }
        // tools 统计独占一行：它的宽度随工具种类增长，挤在 status 行里会把
        // 前面的扩展状态（cache 等）押到折行外。
        // 一次工具都没调过时不占行（旧版与 status 合行，空内容不费版面）。
        if (session.totalToolCalls > 0) lines.push(...wrapTextWithAnsi(renderToolStats(session, ctx), width));
        return lines;
      },
    };
  });
}
