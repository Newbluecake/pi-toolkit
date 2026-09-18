// Ported from the standalone session-nav extension
// (~/.pi/agent/extensions/session-nav/, author is this repository's user) —
// 会话导航增强。Behavior, command names and interception semantics are
// preserved verbatim.
//
// 功能：
// - /clear            开始新会话（/new 的别名）；直接输入 `clear` 回车效果相同
//                     （通过自定义编辑器在提交前把 `clear` 改写为 `/clear`，
//                     走正常命令管道，因此与手动输入 /clear 行为完全一致）
// - /resume           默认只扫描最近 48 小时的会话；直接输入 `resume` 效果相同
//                     Tab、`/resume --all` 或 `resume --all` 加载全部历史
//                     （提交前改写为扩展命令，绕过 pi 内置的全量 /resume 选择器）
// - exit              直接输入 `exit` 回车退出 pi
// - resume 列表标题清洗：skill 启动的会话剥掉 `<skill …>整篇 SKILL.md</skill>` 信封，
//                     显示为 `[dev-flow] 真实输入`（见 skill-titles.ts）
// - 主/sub 会话区分：扫描主会话里的 subagent:run 条目（diag.sessionFile），
//                     subagent 会话显示为 `[sub:verifier] 派单描述`（见 subagent-sessions.ts）
//
// Entry contract: `wireSessionNav(pi)` registers the `resume-recent` / `clear`
// commands, the bare `exit` input interception, and the SessionNavEditor
// submit-time rewriter. It does NOT read settings — gating lives at the call
// site (assembly package).
//
// Intentional behavior difference vs the standalone plugin: the custom editor
// is TUI-only — session_start installs it only when `ctx.mode === "tui"`, so
// child subagent / rpc sessions never replace the editor component (the
// standalone plugin installed it unconditionally). The `/resume-recent`
// handler keeps its own `ctx.mode !== "tui"` early return.
//
// String constants kept verbatim: commands `resume-recent`, `clear`; the
// 48-hour window; cache path `<agent>/cache/session-nav/subagent-marks.json`;
// `[skill名]` / `[sub:type]` title formats. No timers — nothing to unref;
// the marks cache write is fire-and-forget by design.

import {
  CustomEditor,
  SessionManager,
  SessionSelectorComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { listRecentSessions, type SessionListProgress } from "./recent-sessions.js";
import { cleanSkillTitles } from "./skill-titles.js";
import { collectSubagentMarks, listSessionFiles, markSubagentSessions } from "./subagent-sessions.js";

const RECENT_SESSION_HOURS = 48;

export function isExitInput(text: string): boolean {
  return text.trim() === "exit";
}

export function isClearInput(text: string): boolean {
  return text.trim() === "clear";
}

export function rewriteResumeInput(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "/resume" || trimmed === "resume") return "/resume-recent";
  if (/^\/?resume\s+--all$/.test(trimmed)) return "/resume-recent --all";
  return text;
}

/**
 * 自定义编辑器：提交前改写需要扩展命令上下文的输入。
 * 这样命令能使用 newSession/switchSession，且精确的 `/resume` 不会先被 pi 内置处理器消费。
 */
export class SessionNavEditor extends CustomEditor {
  override handleInput(data: string): void {
    // 仅响应普通回车（\r / \n），不影响 Shift+Enter 换行等组合键
    if (data === "\r" || data === "\n") {
      const text = this.getText();
      if (isClearInput(text)) {
        this.setText("/clear");
      } else {
        const rewritten = rewriteResumeInput(text);
        if (rewritten !== text) this.setText(rewritten);
      }
    }
    super.handleInput(data);
  }
}

export function wireSessionNav(pi: ExtensionAPI): void {
  // ── /resume：最近 48 小时优先，按需加载全部历史 ────────────────────────────
  pi.registerCommand("resume-recent", {
    description: "Resume a recent session; use --all for full history",
    getArgumentCompletions: (prefix: string) => {
      const value = "--all";
      return value.startsWith(prefix) ? [{ value, label: value, description: "Load all session history" }] : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Recent resume is only available in TUI mode", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy — press Esc before switching sessions", "warning");
        return;
      }

      const loadAll = args.trim() === "--all";
      const sessionDir = ctx.sessionManager.getSessionDir();
      const allLoader = async (onProgress?: SessionListProgress) => {
        const sessions = await SessionManager.list(ctx.cwd, sessionDir, onProgress).then(cleanSkillTitles);
        const marks = await collectSubagentMarks(await listSessionFiles(sessionDir), sessionDir);
        return markSubagentSessions(sessions, marks);
      };
      const recentLoader = loadAll
        ? allLoader
        : (onProgress?: SessionListProgress) =>
            listRecentSessions(ctx.cwd, sessionDir, RECENT_SESSION_HOURS, onProgress);

      const selectedPath = await ctx.ui.custom<string | null>(
        (tui, _theme, keybindings, done) =>
          new SessionSelectorComponent(
            recentLoader,
            allLoader,
            (path) => done(path),
            () => done(null),
            () => {
              done(null);
              ctx.shutdown();
            },
            () => tui.requestRender(),
            {
              keybindings,
              showRenameHint: true,
              renameSession: async (sessionFilePath, nextName) => {
                const next = nextName?.trim() ?? "";
                if (!next) return;
                SessionManager.open(sessionFilePath, sessionDir).appendSessionInfo(next);
              },
            },
            ctx.sessionManager.getSessionFile(),
          ),
      );

      if (!selectedPath) return;
      await ctx.switchSession(selectedPath, {
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify("Resumed session", "info");
        },
      });
    },
  });

  // ── /clear：新会话 ────────────────────────────────────────────────────────
  async function startNewSession(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.newSession({
      withSession: async (replacementCtx) => {
        replacementCtx.ui.notify("New session started", "info");
      },
    });
  }

  pi.registerCommand("clear", {
    description: "Start a new session (alias for /new; typing bare `clear` also works)",
    handler: async (_args, ctx) => {
      await startNewSession(ctx);
    },
  });

  // ── 裸输入拦截：exit 退出；clear/resume 由 SessionNavEditor 提交前改写 ──
  pi.on("input", (event, ctx) => {
    // 只匹配直接交互输入，程序化/RPC 消息不受影响
    if (event.source === "interactive" && isExitInput(event.text)) {
      ctx.shutdown();
      return { action: "handled" };
    }

    return { action: "continue" };
  });

  pi.on("session_start", (_event, ctx) => {
    // TUI-only（与独立版的有意行为差异，见模块头注释）：安装自定义编辑器，
    // 让裸 `clear` / `resume` + 回车等效于对应斜杠命令。
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new SessionNavEditor(tui, theme, keybindings));
  });
}
