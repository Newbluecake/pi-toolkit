/**
 * `/webhub` — web-hub 控制面（plan §包 I）。仅在 `webHub.enabled` 时注册
 * （src/index.ts 的 if 内），所以这里不需要再判断开关。
 *
 *   /webhub          —— 同 /webhub status
 *   /webhub status   —— state / agentKey / hub 版本 / URL（不含 token）
 *   /webhub open     —— 打印含 `#t=` 的 URL 并 best-effort 打开浏览器
 *                       （xdg-open/open：detached、stdio ignore、unref；
 *                       3s 内收到 error 才提示，之后忽略）
 *
 * control 经 holder 式 getter 惰性读取（/reload 后指向新 activate 的实例）。
 */
import { spawn } from "node:child_process";
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { WebHubControl, WebHubStatusView } from "../web-hub/agent/index.js";

export interface WebHubCommandDeps {
  control(): WebHubControl | undefined;
  /** Test seam: browser opener. Default spawns xdg-open/open detached. */
  open?: (url: string) => void;
  now?: () => number;
}

const USAGE = "用法：/webhub [status|open]";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // best effort
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

export function createWebHubCommand(deps: WebHubCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "web-hub 浏览器 UI：/webhub status 查看 hub 连接状态；/webhub open 打印并在浏览器打开带 token 的 URL。",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "";
      if (sub !== "" && sub !== "status" && sub !== "open") {
        notify(ctx, USAGE, "warning");
        return;
      }
      const control = deps.control();
      if (control === undefined) {
        notify(ctx, "web-hub 未启用（webHub.enabled=false）或尚未初始化；启用后 /reload 生效。", "warning");
        return;
      }
      if (sub === "open") {
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
        return;
      }
      notify(ctx, formatStatus(control.status(), control.url()), "info");
    },
  };
}
