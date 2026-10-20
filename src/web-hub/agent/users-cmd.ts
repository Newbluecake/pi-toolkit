/** Local-TUI-only LAN account management over the trusted, deadline-bounded agent socket. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LanReqFrame, LanResFrame } from "../protocol/messages.js";
import { isWebInvocation } from "./command-capture.js";
import { newAdminRid } from "./connection.js";

export interface LanUsersPort {
  hasCap(cap: string): boolean;
  request(frame: LanReqFrame, cap: string): Promise<LanResFrame>;
}

export async function runUsersCommand(
  args: string[],
  ctx: ExtensionCommandContext,
  port: LanUsersPort | undefined,
): Promise<void> {
  if (ctx.mode !== "tui" || isWebInvocation(ctx)) {
    ctx.ui.notify("/webhub user 仅允许在本地 TUI 中执行。", "warning");
    return;
  }
  const [op, username] = args;
  if (!(op === "list" && args.length === 1) && !(op === "delete" && args.length === 2)) {
    ctx.ui.notify("用法：/webhub user list | delete <username>（仅 TUI）", "warning");
    return;
  }
  if (!port?.hasCap("lan.v1")) {
    ctx.ui.notify("web-hub 未连接或不支持 LAN。", "warning");
    return;
  }
  if (
    op === "delete" &&
    !(await ctx.ui.confirm("删除局域网账号", `删除账号 ${username} 并撤销其全部局域网会话，确认？`))
  ) {
    ctx.ui.notify("已取消。", "info");
    return;
  }
  const res = await port.request(
    op === "list"
      ? { t: "lan_req", rid: newAdminRid(), op: "users" }
      : { t: "lan_req", rid: newAdminRid(), op: "user_delete", username: username! },
    "lan.v1",
  );
  if (!res.ok) {
    ctx.ui.notify(`账号操作失败：${res.code} ${res.message}`, "warning");
    return;
  }
  if (op === "delete") {
    ctx.ui.notify(`已删除局域网账号 ${username}；该账号的会话与页面全部失效。`, "info");
    return;
  }
  if (res.users === undefined) {
    ctx.ui.notify("hub 版本过旧，请 /webhub restart。", "warning");
    return;
  }
  ctx.ui.notify(
    res.users.length === 0
      ? "暂无局域网账号。"
      : res.users
          .map(
            (u) =>
              `${u.username}${u.primary ? "（主账号）" : ""}  2FA ${u.twofa ? "on" : "off"}  在线会话 ${u.liveSessions}`,
          )
          .join("\n"),
    "info",
  );
}
