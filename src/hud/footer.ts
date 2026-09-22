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
        let liveSubCost = 0;
        let liveSubActive = false;
        for (const [rid, u] of session.subUsage) {
          if (subAccounted.has(rid)) continue;
          liveSubCost += u.costUsd;
          if (!u.terminal) liveSubActive = true;
        }
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

        let statsLeft = statsParts.join(theme.fg("dim", " │ "));
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const modelName = ctx.model?.id || "no-model";
        let rightSide = modelName;
        if (ctx.model?.reasoning) {
          rightSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`;
          if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
        }

        const rightWidth = visibleWidth(rightSide);
        let statsLine: string;
        if (statsLeftWidth + 2 + rightWidth <= width) {
          statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + theme.fg("dim", rightSide);
        } else {
          const availableForRight = width - statsLeftWidth - 2;
          const truncatedRight = availableForRight > 0 ? truncateToWidth(rightSide, availableForRight, "") : "";
          statsLine =
            statsLeft +
            " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
            theme.fg("dim", truncatedRight);
        }

        const extensionStatuses = footerData.getExtensionStatuses();
        const statusLine = Array.from(extensionStatuses.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeStatusText(text))
          .join(" ");
        const lines = [
          truncateToWidth(pwdLine, width, theme.fg("dim", "...")),
          ...renderWorktreeLines(session, ctx, width),
          statsLine,
        ];
        const timeParts = [
          renderSessionStart(session, ctx),
          renderLlmTiming(session, ctx),
          renderBgAgents(session, ctx),
        ].filter((part): part is string => Boolean(part));
        if (timeParts.length > 0) {
          lines.push(truncateToWidth(timeParts.join(theme.fg("dim", " │ ")), width, ""));
        }
        if (statusLine) lines.push(...wrapTextWithAnsi(statusLine, width));
        return lines;
      },
    };
  });
}
