/**
 * `/thread` — fabric-thread arch r3 §5.1 (P3): the LOCAL-HUMAN surface for thread subscriptions
 * (the model uses the `thread` tool; child workers use their injected closure tool). Registered
 * post-guard by src/index.ts, only while `fabric.enabled ∧ fabric.threads.enabled` — off ⇒ the
 * command does not exist (G2a byte-identical surface).
 *
 * `/thread`            — same as `status`
 * `/thread status`     — threads seen, live subscriptions, counters
 * `/thread drop <subId>` — end one subscription (any creator)
 * `/thread sub <run> <h> [scope…]` — subscribe (createdBy:"human"); `run` accepts a run id,
 *                       a unique id prefix or an @label; `h` accepts `origin` (§4.3).
 */

import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { ThreadMainOps } from "../tools/thread-tool.js";

export interface ThreadCommandDeps {
  /** The live stack surface (holder-forwarded; undefined ⇒ feature off / no stack). */
  current(): ThreadMainOps | undefined;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui?.notify(message, level);
  } catch {
    /* stale/headless UI is inert */
  }
}

export function createThreadCommand(deps: ThreadCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  const USAGE =
    "用法：/thread status · /thread drop <subId> · /thread sub <run> <h|origin> [职责说明]（h 形如 fs:xxxxxxxxxxxx）";
  return {
    description: "Thread 订阅直通：查看/建立/解除「飞书群话题 → 直派 subagent」的事件订阅（fabric.threads）。",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ops = deps.current();
      if (ops === undefined) {
        notify(ctx, "thread 订阅未开启（fabric.threads.enabled=false）或当前无活跃会话栈。", "warning");
        return;
      }
      const trimmed = args.trim();
      if (trimmed === "" || trimmed === "status") {
        notify(ctx, ops.list());
        return;
      }
      if (trimmed === "help") {
        notify(ctx, USAGE);
        return;
      }
      const dropMatch = /^drop\s+(\S+)\s*$/.exec(trimmed);
      if (dropMatch !== null) {
        const result = ops.unsubscribe(dropMatch[1]!);
        notify(
          ctx,
          result.ok ? `已解除订阅 ${dropMatch[1]!}。` : `解除失败：${result.reason}`,
          result.ok ? "info" : "warning",
        );
        return;
      }
      const subMatch = /^sub\s+(\S+)\s+(\S+)(?:\s+([\s\S]*\S))?\s*$/.exec(trimmed);
      if (subMatch !== null) {
        const scope = (subMatch[3] ?? "").trim();
        const result = ops.subscribe({
          run: subMatch[1]!,
          h: subMatch[2]!,
          scope: scope === "" ? "/thread 本地订阅" : scope,
          origin: subMatch[2] === "origin",
        });
        if (result.ok) {
          notify(
            ctx,
            `${result.created ? "已订阅" : "已更新（幂等）"}：${result.subId} · ${result.h}「${result.label}」`,
          );
        } else {
          const detail = result.detail !== undefined ? `（${result.detail}）` : "";
          notify(ctx, `订阅失败：${result.reason}${detail}`, "warning");
        }
        return;
      }
      notify(ctx, USAGE, "warning");
    },
  };
}
