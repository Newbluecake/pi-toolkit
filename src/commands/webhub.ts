/**
 * `/webhub` — web-hub 控制面（plan §包 I + lan-plan.md §9.3, S1-W3 LI）。仅在
 * `webHub.enabled` 时注册（src/index.ts 的 if 内），所以这里不需要再判断开关。
 *
 *   /webhub          —— 同 /webhub status
 *   /webhub status   —— state / agentKey / hub 版本 / URL（不含 token）+
 *                       （若已配置 LAN）lan=on/off 行、初始密码提醒（仅 TUI）
 *   /webhub open     —— 打印含 `#t=` 的 URL 并 best-effort 打开浏览器
 *                       （xdg-open/open：detached、stdio ignore、unref；
 *                       3s 内收到 error 才提示，之后忽略）+（若 LAN 为 on）
 *                       完整的直连 URL 列表与对外 origin（不截断，与 status
 *                       行的 "+N 个地址" 摘要互补）
 *   /webhub passwd   —— 仅 TUI；不接受任何参数；用户名 → 掩码密码两次 →
 *                       `lan_req passwd`（两次不一致或太短由 LE 的
 *                       `runPasswdPrompt` 拒绝）
 *   /webhub unlock   —— 清空登录限流（收紧/饱和状态解除）
 *   /webhub restart  —— 见 plan §8.2；`control.lan.restart()` 已经实现两条路径
 *
 * control 经 holder 式 getter 惰性读取（/reload 后指向新 activate 的实例）。
 */
import { spawn } from "node:child_process";
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { LanAdminResult, WebHubControl, WebHubStatusView } from "../web-hub/agent/index.js";
import { formatPasswdOutcomeMessage, type PasswdOutcome } from "../web-hub/agent/passwd-prompt.js";
import type { RestartOutcome } from "../web-hub/agent/restart.js";
import {
  formatInitialPasswordLines,
  formatInvalidExtraHostsLine,
  formatProxyMismatchLine,
  type UiMode,
} from "../web-hub/agent/lan-status.js";
import type { LanInfoPayload } from "../web-hub/protocol/messages.js";
import type { InvalidHostToken } from "../web-hub/protocol/lan.js";

/**
 * Settings-level LAN validation warnings (plan §9.1/§2.4: `webHub.lan.extraHosts` 的非法项、
 * `trustProxyFrom`/`externalOrigins` 只设置一半的 fail-closed 提示) — computed once at settings
 * load time (`src/config/settings.ts`'s `parseWebHubLanValidation`, same validator
 * `parseWebHubSettings` itself uses) and handed to this command as a plain snapshot: `webHub.*`
 * is non-live (captured at activate; change → /reload), so there is nothing to recompute per call.
 * Optional: a caller that does not wire it simply gets no extra status lines here — the settings
 * parser itself still enforces fail-closed behavior (invalid extraHosts dropped, mismatched proxy
 * config zeroed) regardless of whether this snapshot is wired for display.
 */
export interface WebHubLanSettingsWarnings {
  invalidExtraHosts: readonly InvalidHostToken[];
  proxyMismatch: boolean;
}

export interface WebHubCommandDeps {
  control(): WebHubControl | undefined;
  /** Test seam: browser opener. Default spawns xdg-open/open detached. */
  open?: (url: string) => void;
  now?: () => number;
  /** See `WebHubLanSettingsWarnings`'s docstring. */
  lanSettingsWarnings?: () => WebHubLanSettingsWarnings;
}

const USAGE = "用法：/webhub [status|open|passwd|unlock|restart]";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // best effort
  }
}

function notifyAll(ctx: ExtensionCommandContext, lines: readonly string[], level: "info" | "warning" = "info"): void {
  for (const line of lines) notify(ctx, line, level);
}

function uiModeOf(ctx: ExtensionCommandContext): UiMode {
  switch (ctx.mode) {
    case "tui":
    case "rpc":
    case "print":
    case "json":
      return ctx.mode;
    default:
      return "print";
  }
}

/** status 行：state、agentKey、hub 版本、URL（剥掉 `#t=` fragment，不含 token）。 */
export function formatStatus(view: WebHubStatusView, url: { url: string } | { hint: string }): string {
  const parts = [`web-hub: state=${view.state}${view.attached ? " attached" : " detached"}`];
  if (view.agentKey !== undefined) parts.push(`agentKey=${view.agentKey}`);
  if (view.hubVersion !== undefined) parts.push(`hub=${view.hubVersion}`);
  if (view.lastError !== undefined) parts.push(`lastError=${view.lastError}`);
  if ("url" in url) parts.push(`url=${url.url.split("#")[0]!}`);
  else parts.push(url.hint);
  return parts.join(" ");
}

/**
 * `/webhub open`'s LAN section (plan §9.3 "open" row): the *full*, untruncated direct-URL list
 * (unlike `/webhub status`'s "+N 个地址，/webhub open 查看" summary line) plus, when configured,
 * the external origin reachable via a trusted proxy. `undefined`/`state !== "on"` ⇒ no lines
 * (LAN off, or the admin socket isn't live — `open` degrades silently, same as its existing
 * loopback-URL behavior when the hub is unreachable).
 */
export function formatLanOpenLines(info: LanInfoPayload | undefined): string[] {
  if (info === undefined || info.lan.state !== "on") return [];
  const { port, hosts, proxy } = info.lan;
  const lines = hosts.map((host) => `http://${host}:${port}/`);
  if (proxy !== undefined) {
    for (const origin of proxy.externalOrigins) lines.push(`${origin}/（经受信任代理）`);
  }
  return lines;
}

export function formatRestartOutcomeMessage(outcome: RestartOutcome): {
  message: string;
  level: "info" | "warning" | "error";
} {
  switch (outcome.kind) {
    case "restarted":
      return { message: "hub 已重启（旧进程已退出，新进程已启动）。", level: "info" };
    case "signalled":
      return { message: "旧 hub 身份校验通过，已发送 SIGTERM；新进程将自动拉起。", level: "info" };
    case "manual":
      return { message: outcome.message, level: "warning" };
    case "failed":
      return { message: outcome.message, level: "error" };
  }
}

function formatUnlockResult(res: LanAdminResult<void>): { message: string; level: "info" | "warning" | "error" } {
  if (res.ok) return { message: "已清空登录限流；收紧/饱和状态已解除。", level: "info" };
  if (res.reason === "unavailable") {
    return { message: "web-hub 未连接或当前 hub 不支持 LAN（缺少 lan.v1 能力）。", level: "warning" };
  }
  return { message: `unlock 失败：${res.message}`, level: "error" };
}

/** 默认浏览器打开：detached + stdio ignore + unref；3s 内的 error 回调经 onError 上报，之后忽略。 */
function defaultOpen(url: string, onError: (message: string) => void): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    const guard = setTimeout(() => child.removeAllListeners("error"), 3_000);
    guard.unref();
    child.on("error", (err) => {
      clearTimeout(guard);
      onError(`${cmd} 启动失败：${err.message}`);
    });
    child.unref();
  } catch (err) {
    onError(`${cmd} 启动失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function runStatus(ctx: ExtensionCommandContext, control: WebHubControl, deps: WebHubCommandDeps): Promise<void> {
  notify(ctx, formatStatus(control.status(), control.url()), "info");
  const lanLines = control.lan.statusLines();
  notifyAll(ctx, lanLines, lanLines[0]?.startsWith("lan=on") ? "info" : "warning");
  const warnings = deps.lanSettingsWarnings?.();
  if (warnings !== undefined) {
    const invalidLine = formatInvalidExtraHostsLine(warnings.invalidExtraHosts);
    if (invalidLine !== undefined) notify(ctx, invalidLine, "warning");
    if (warnings.proxyMismatch) notify(ctx, formatProxyMismatchLine(), "warning");
  }
  const infoRes = await control.lan.info();
  if (infoRes.ok && infoRes.value !== undefined) {
    notifyAll(ctx, formatInitialPasswordLines(infoRes.value, uiModeOf(ctx)), "warning");
  }
}

async function runOpen(ctx: ExtensionCommandContext, control: WebHubControl, deps: WebHubCommandDeps): Promise<void> {
  const res = control.url();
  if ("hint" in res) {
    notify(ctx, res.hint, "warning");
    return;
  }
  notify(ctx, res.url, "info");
  const open = deps.open ?? ((url: string) => defaultOpen(url, (m) => notify(ctx, m, "warning")));
  try {
    open(res.url);
  } catch (err) {
    notify(ctx, `打开浏览器失败：${err instanceof Error ? err.message : String(err)}`, "warning");
  }
  // best-effort: LAN section degrades silently when the admin socket isn't live (plan §9.3 "open").
  const infoRes = await control.lan.info();
  if (infoRes.ok) notifyAll(ctx, formatLanOpenLines(infoRes.value), "info");
}

async function runPasswd(ctx: ExtensionCommandContext, control: WebHubControl): Promise<void> {
  if (ctx.mode !== "tui") {
    notify(ctx, "/webhub passwd 仅支持在 TUI 中执行。", "warning");
    return;
  }
  const outcome: PasswdOutcome = await control.lan.changePasswordInteractive();
  notify(ctx, formatPasswdOutcomeMessage(outcome), outcome.ok ? "info" : "warning");
}

async function runUnlock(ctx: ExtensionCommandContext, control: WebHubControl): Promise<void> {
  const res = await control.lan.unlock();
  const { message, level } = formatUnlockResult(res);
  notify(ctx, message, level);
}

async function runRestart(ctx: ExtensionCommandContext, control: WebHubControl): Promise<void> {
  const outcome = await control.lan.restart();
  const { message, level } = formatRestartOutcomeMessage(outcome);
  notify(ctx, message, level);
}

const SUBCOMMANDS = new Set(["status", "open", "passwd", "unlock", "restart"]);

export function createWebHubCommand(deps: WebHubCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "web-hub 浏览器 UI：/webhub status 查看状态；/webhub open 打开浏览器；" +
      "/webhub passwd|unlock|restart 管理局域网访问（LAN，plan §9.3）。",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim() === "" ? [] : args.trim().split(/\s+/);
      const sub = tokens[0] ?? "status";
      if (sub !== "status" && !SUBCOMMANDS.has(sub)) {
        notify(ctx, USAGE, "warning");
        return;
      }
      if (sub === "passwd" && tokens.length > 1) {
        notify(ctx, "/webhub passwd 不接受任何参数。", "warning");
        return;
      }
      const control = deps.control();
      if (control === undefined) {
        notify(ctx, "web-hub 未启用（webHub.enabled=false）或尚未初始化；启用后 /reload 生效。", "warning");
        return;
      }
      switch (sub) {
        case "open":
          await runOpen(ctx, control, deps);
          return;
        case "passwd":
          await runPasswd(ctx, control);
          return;
        case "unlock":
          await runUnlock(ctx, control);
          return;
        case "restart":
          await runRestart(ctx, control);
          return;
        default:
          await runStatus(ctx, control, deps);
      }
    },
  };
}
