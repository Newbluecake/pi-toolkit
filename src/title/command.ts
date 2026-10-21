/**
 * `/title` 命令——会话标题自动生成的用户控制面：
 *
 *   /title [status] —— 查看状态（默认）：是否开启、当前标题、归属（自动生成/
 *                     用户所有/未命名）、刷新额度用量、距下次刷新的输入积累。
 *   /title auto     —— 把标题交回自动生成：追加一条回收记录（`{v:1,name,at,
 *                     reclaim:true}`，name = 当前会话名，shape 与正常自有记录一致，
 *                     只恢复所有权、不占刷新额度，见 records.ts），并武装下一次
 *                     agent_settled 的 one-shot 绕过（与 session_compact 同一
 *                     pendingRefreshBypass 机制），下一轮结束后无视输入/时长/额度
 *                     阈值重新生成一次标题。
 *
 * 硬安全门（与核心不变量同向）：
 * - title.enabled=false：命令仍注册（如实告知），auto 拒绝、不写记录；
 * - 在途互斥：有一次生成在途时 auto 拒绝（不写记录、不武装绕过），请用户稍后再试；
 * - 子会话不可达：装配在 src/index.ts post-guard 区 + wireTitle 的 isChildSession
 *   早退，本命令只在主会话注册。
 *
 * 未命名会话无需回收：首标本来就会在（下一次）before_agent_start 自动生成，
 * auto 如实说明、不写记录。
 */

import type { ExtensionCommandContext, RegisteredCommand, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readTitleRecords } from "./records.js";
import type { TitleTriggerSnapshot } from "./title.js";

export interface TitleCommandDeps {
  /** settings.title.enabled；false 时 auto 拒绝、status 如实标注（命令仍注册）。 */
  enabled: boolean;
  /** 刷新里程碑/额度配置快照（status 渲染用）。 */
  options: {
    refreshEveryInputs: number;
    refreshAfterMinutes: number;
    refreshWindowMinutes: number;
    maxRefreshes: number;
  };
  /** pi.getSessionName（与 ctx 无关，共享安全）。 */
  getSessionName(): string | undefined;
  /** 追加回收记录 {v:1,name,at,reclaim:true}（pi.appendEntry 绑定）。 */
  recordReclaimTitle(name: string): void;
  /** 触发器只读快照；disabled（未接事件钩子）时 undefined。 */
  snapshot(): TitleTriggerSnapshot | undefined;
  /** 武装下一次 agent_settled 的 one-shot 绕过；disabled 时 no-op。 */
  armRefreshBypass(): void;
  now(): number;
}

const USAGE = "用法：/title [status] 查看标题自动生成状态；/title auto 恢复自动生成标题（下一轮结束后自动刷新）。";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // best effort
  }
}

/** 读会话全部条目（所有权/额度判定用，与核心的 getEntries 口径一致）；失败按空历史处理。 */
function safeEntries(ctx: ExtensionCommandContext): readonly SessionEntry[] {
  try {
    return ctx.sessionManager.getEntries();
  } catch {
    return [];
  }
}

function safeName(getSessionName: () => string | undefined): string | undefined {
  try {
    return getSessionName();
  } catch {
    return undefined;
  }
}

function runAuto(deps: TitleCommandDeps, ctx: ExtensionCommandContext): void {
  if (!deps.enabled) {
    notify(ctx, "标题自动生成已禁用（title.enabled=false），无法恢复。可在 /agent settings 中开启。", "warning");
    return;
  }
  const snap = deps.snapshot();
  if (snap?.inFlight) {
    notify(ctx, "标题生成正在进行中，请等本轮结束后再试。", "warning");
    return;
  }
  const name = safeName(deps.getSessionName);
  if (!name) {
    notify(ctx, "会话尚未命名：首标本来就会在下一条消息自动生成，无需恢复。");
    return;
  }
  const records = readTitleRecords(safeEntries(ctx));
  const alreadyAuto = records.latestName !== undefined && records.latestName === name;
  try {
    deps.recordReclaimTitle(name);
  } catch {
    notify(ctx, "写入标题所有权记录失败（会话可能正在关闭），未做任何改动。", "error");
    return;
  }
  deps.armRefreshBypass();
  notify(
    ctx,
    alreadyAuto
      ? "标题已是自动生成状态；已安排本轮对话结束后自动刷新一次标题（不占用刷新额度）。"
      : "已恢复自动生成标题：当前名字已登记为自动生成，本轮对话结束后将自动刷新一次（不占用刷新额度）。",
  );
}

function runStatus(deps: TitleCommandDeps, ctx: ExtensionCommandContext): void {
  const lines: string[] = [];
  lines.push(deps.enabled ? "标题自动生成：开启" : "标题自动生成：关闭（title.enabled=false）");

  const name = safeName(deps.getSessionName);
  lines.push(name ? `当前标题：${name}` : "当前标题：（未命名）");

  const records = readTitleRecords(safeEntries(ctx));
  if (!name) {
    lines.push("归属：无（未命名，首标将自动生成）");
  } else if (records.latestName !== undefined && records.latestName === name) {
    lines.push("归属：自动生成（可自动刷新）");
  } else {
    lines.push("归属：用户所有（/name 或旧版标题，不再自动更新；/title auto 可交回）");
  }

  // 额度口径与核心刷新门检一致：窗口模式统计滚动窗口内的刷新次数；legacy 模式
  // 统计全会话生命周期（count-1，首标不算）；回收记录两者都不算（records.ts）。
  if (deps.options.maxRefreshes <= 0) {
    lines.push("刷新额度：已关闭（maxRefreshes=0，只生成首标）");
  } else if (deps.options.refreshWindowMinutes > 0) {
    const windowMs = deps.options.refreshWindowMinutes * 60_000;
    const nowTs = deps.now();
    const inWindow = (records.refreshTimestamps ?? []).filter((at) => nowTs - at < windowMs).length;
    lines.push(
      `刷新额度：${deps.options.refreshWindowMinutes} 分钟窗口内已用 ${inWindow}/${deps.options.maxRefreshes}`,
    );
  } else {
    lines.push(`刷新额度：已用 ${Math.max(0, records.count - 1)}/${deps.options.maxRefreshes}（终身）`);
  }

  const snap = deps.snapshot();
  const inputs = snap?.inputsSinceGen ?? 0;
  if (deps.options.refreshEveryInputs > 0) {
    lines.push(`距下次刷新：自上次生成已积累 ${inputs}/${deps.options.refreshEveryInputs} 条输入`);
  } else {
    lines.push(`距下次刷新：输入条件已关闭（refreshEveryInputs=0；已积累 ${inputs} 条）`);
  }
  if (snap?.inFlight) lines.push("当前有一次标题生成在途。");
  if (snap?.pendingRefreshBypass) lines.push("已安排下一次对话结束时无视阈值刷新一次。");

  notify(ctx, lines.join("\n"));
}

export function createTitleCommand(deps: TitleCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "会话标题自动生成控制：/title [status] 查看状态（是否开启/当前标题/归属/刷新额度/输入积累），/title auto 把用户改过的标题交回自动生成并安排下一轮结束后刷新一次。",
    getArgumentCompletions: (argumentPrefix: string) =>
      [
        { value: "auto", label: "auto", description: "恢复自动生成标题" },
        { value: "status", label: "status", description: "查看标题自动生成状态" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim())),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub === "auto") {
        runAuto(deps, ctx);
        return;
      }
      if (sub === "" || sub === "status") {
        runStatus(deps, ctx);
        return;
      }
      notify(ctx, `未知子命令「${sub}」。${USAGE}`, "warning");
    },
  };
}
