// Ported from the standalone session-nav extension
// (~/.pi/agent/extensions/session-nav/, author is this repository's user) —
// 会话导航增强。Behavior, command names and interception semantics are
// preserved verbatim, except the subagent-session handling reworked by the
// web-resume plan §2.3 (P1, D1 彻底隐藏).
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
// - sub 会话彻底隐藏（D1，web-resume plan §2.1/§2.3）：`subagent:child` 自标记或
//     provenance 索引（整个会话目录的 subagent:run 反向索引，缓存 v2 + 增量回填）
//     命中的会话在 partial 进度与最终列表里整行丢弃——没有 `--sub` flag、没有开关、
//     没有隐藏计数行；旧的 `[sub:type]` 改标题路径已删除。已知盲区（AGENTS.md）：
//     v0.4.0 之前创建且父会话文件已删除的子会话；超大目录回填完成前的最初几次打开。
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
// 48-hour window. No timers — nothing to unref; the provenance cache write is
// fire-and-forget by design.

import {
  CustomEditor,
  SessionManager,
  SessionSelectorComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { listRecentSessions, type SessionListProgress } from "./recent-sessions.js";
import { cleanSkillTitles } from "./skill-titles.js";
import { collectSubagentSessions, listSessionFiles } from "./subagent-sessions.js";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

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
      // §2.3 pipeline: ① candidates → ② provenance advance + bounded head reads (sub set) →
      // ③ SessionManager.list with a progress wrapper that drops sub rows (partial list too)
      // → ④ cleanSkillTitles → ⑤ final sub filter. The selector's AbortSignal is threaded
      // through every step.
      const allLoader = async (onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]> => {
        const candidates = await listSessionFiles(sessionDir);
        const { sub } = await collectSubagentSessions(candidates, sessionDir, { signal });
        const wrappedProgress: SessionListProgress = (loaded, total, partialSessions) => {
          if (partialSessions === undefined) {
            onProgress?.(loaded, total);
            return;
          }
          onProgress?.(
            loaded,
            total,
            partialSessions.filter((session) => !sub.has(resolve(session.path))),
          );
        };
        const sessions = await SessionManager.list(ctx.cwd, sessionDir, wrappedProgress, signal);
        const cleaned = await cleanSkillTitles(sessions);
        return cleaned.filter((session) => !sub.has(resolve(session.path)));
      };
      const recentLoader = loadAll
        ? allLoader
        : (onProgress?: SessionListProgress, signal?: AbortSignal) =>
            listRecentSessions(ctx.cwd, sessionDir, RECENT_SESSION_HOURS, onProgress, signal);

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
