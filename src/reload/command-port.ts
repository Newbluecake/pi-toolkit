import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DeferredReloadController } from "./defer.js";
import {
  completedReloadTurn,
  isReloadStreaming,
  needsReloadContinue,
  snapshotReloadTurn,
  writeReloadContinue,
  type ReloadTurnSnapshot,
} from "./continue.js";
import { clampSpanMs, withDeadline } from "../core/deadline.js";
import { systemClock } from "../core/clock.js";

/** pi 1.3 TUI refuses ctx.reload while streaming; settling must never hang the command. */
export const RELOAD_SETTLE_MS = 5_000;

export interface ReloadCommandPort {
  readonly pending: boolean;
  arm(activeCount: number, ctx: ExtensionCommandContext): void;
  cancel(ctx: ExtensionCommandContext): boolean;
  /** Register a non-blocking natural-idle wait; true means defer this command. */
  deferFire(ctx: ExtensionCommandContext): boolean;
  reload(ctx: ExtensionCommandContext, mode?: "force" | "deferred"): Promise<void>;
}

export function canReload(ctx: ExtensionCommandContext): boolean {
  return ctx.mode !== "print" && ctx.mode !== "json" && typeof ctx.reload === "function";
}

export function notifyReloadUnavailable(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    ctx.mode === "print" || ctx.mode === "json"
      ? "print/json 模式不支持 /agent reload，请使用 TUI 或 RPC 会话。"
      : "This pi build cannot reload programmatically — run /reload manually.",
    "warning",
  );
}

/** Late-bound facade: index.ts only assembles it; all command lifecycle logic lives here. */
export function createReloadCommandPort(
  current: () => DeferredReloadController | undefined,
  pi: Pick<ExtensionAPI, "sendMessage">,
): ReloadCommandPort {
  let turnAtArm: ReloadTurnSnapshot | undefined;
  const notifyModel = (ctx: ExtensionCommandContext, content: string) => {
    pi.sendMessage(
      { customType: "subagent:reload-pending", display: true, content },
      { deliverAs: isReloadStreaming(ctx) ? "steer" : "nextTurn" },
    );
  };
  return {
    get pending() {
      return current()?.pending ?? false;
    },
    arm(activeCount, ctx) {
      const ctl = current();
      if (!ctl || !canReload(ctx)) return;
      if (!ctl.arm(activeCount, isReloadStreaming(ctx))) return;
      turnAtArm = snapshotReloadTurn(ctx);
      const waiting = activeCount > 0 ? `正在等待 ${activeCount} 个子 agent/workflow 结束后执行` : "会在本轮结束后执行";
      notifyModel(
        ctx,
        `用户请求了 /reload，${waiting}。reload 完成前不要再派发新的 Agent / SubagentWorkflow（会被拒绝）；正在运行的可继续等其结果。后台 bash 任务会被 reload 后的会话接管，不受影响，可照常使用。reload 完成后会自动通知你继续。`,
      );
    },
    cancel(ctx) {
      const ctl = current();
      if (!ctl?.pending) return false;
      ctl.disarm();
      notifyModel(ctx, "reload 已取消，可恢复派发 Agent / SubagentWorkflow。");
      return true;
    },
    deferFire(ctx) {
      if (!isReloadStreaming(ctx)) return false;
      const ctl = current();
      if (!ctl?.pending) return true;
      turnAtArm ??= snapshotReloadTurn(ctx);
      ctl.waitForIdle(
        () => {
          if (typeof ctx.waitForIdle !== "function") throw new Error("waitForIdle unavailable");
          return ctx.waitForIdle();
        },
        () => !isReloadStreaming(ctx),
        (reason) => ctx.ui.notify(reason, "warning"),
      );
      return true;
    },
    async reload(ctx, mode = "force") {
      if (!canReload(ctx)) {
        notifyReloadUnavailable(ctx);
        return;
      }
      const ctl = current();
      const wasPending = ctl?.pending ?? false;
      ctl?.cancelIdleWait(); // now supersedes a parked fire; late completion is inert
      // Capture BEFORE abort: settling the current turn may clear both streaming and queues.
      const interrupted = needsReloadContinue(
        (ctl?.interruptedAtArm ?? false) || (ctl?.waitedWhileStreaming ?? false),
        ctx,
      );
      if (
        mode === "force" &&
        ctx.mode === "tui" &&
        isReloadStreaming(ctx) &&
        typeof ctx.abort === "function" &&
        typeof ctx.waitForIdle === "function"
      ) {
        ctx.abort();
        const settled = await withDeadline(
          Promise.resolve().then(() => ctx.waitForIdle()),
          clampSpanMs(RELOAD_SETTLE_MS)!,
          systemClock,
          "reload settle",
        );
        if (!settled.ok || isReloadStreaming(ctx)) {
          ctx.ui.notify(
            "Reload could not settle the current response within 5s; retry /agent reload now or cancel.",
            "warning",
          );
          return;
        }
        // A user cancellation during the bounded wait also invalidates this fire/now.
        if (wasPending && !ctl?.pending) return;
      }
      // Deferred calls must be idle; never silently inherit the force/abort behavior.
      if (mode === "deferred" && isReloadStreaming(ctx)) return;
      const noPendingMessages = typeof ctx.hasPendingMessages === "function" && !ctx.hasPendingMessages();
      const naturallyFinished =
        mode === "deferred" &&
        typeof ctx.isIdle === "function" &&
        ctx.isIdle() &&
        noPendingMessages &&
        completedReloadTurn(ctx, turnAtArm);
      const needsContinue = needsReloadContinue(interrupted, ctx) && !naturallyFinished;
      ctl?.disarm();
      const rollback = needsContinue ? writeReloadContinue(ctx) : undefined;
      try {
        await ctx.reload();
      } catch (error) {
        rollback?.();
        throw error;
      }
    },
  };
}
