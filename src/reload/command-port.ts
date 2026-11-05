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
import { webCmdIdOf } from "../commands/capture.js";
import { newReloadExec, newReloadLife, type ReloadPhaseEvent, type ReloadPhaseFact } from "./phase.js";

/** pi 1.3 TUI refuses ctx.reload while streaming; settling must never hang the command. */
export const RELOAD_SETTLE_MS = 5_000;

export interface ReloadCommandPort {
  readonly pending: boolean;
  arm(activeCount: number, ctx: ExtensionCommandContext): void;
  cancel(ctx: ExtensionCommandContext): boolean;
  /** Register a non-blocking natural-idle wait; true means defer this command. */
  deferFire(ctx: ExtensionCommandContext): boolean;
  /** #30 reload-result plan §1 D3: the host cannot reload — emits `failed
   * E_RELOAD_UNAVAILABLE` (closing the tracked lifecycle) and notifies the user. */
  unavailable(ctx: ExtensionCommandContext): void;
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

/** #30 D1: facts that may open (or reopen) a lifecycle — a request entering the port. */
const ENTRY_FACTS: ReadonlySet<ReloadPhaseFact["kind"]> = new Set(["deferred", "unavailable", "exec"]);

/** Late-bound facade: index.ts only assembles it; all command lifecycle logic lives here. */
export function createReloadCommandPort(
  current: () => DeferredReloadController | undefined,
  pi: Pick<ExtensionAPI, "sendMessage">,
  onPhase?: (event: ReloadPhaseEvent) => void,
): ReloadCommandPort {
  let turnAtArm: ReloadTurnSnapshot | undefined;
  // #30 reload-result plan §1 D1 — the port-level lifecycle: ONE open `life` at a time; it ends
  // on cancel, unavailable or `ctx.reload()` returning. Every real reload attempt rotates the
  // execution token `execId`; asynchronously-captured continuations re-check both before
  // emitting so a superseded attempt can never speak for (or after) a newer one.
  let life: string | undefined;
  let lifeOpen = false;
  let execId = "";
  let lastDeferredKey: string | undefined;
  const notifyModel = (ctx: ExtensionCommandContext, content: string) => {
    pi.sendMessage(
      { customType: "subagent:reload-pending", display: true, content },
      { deliverAs: isReloadStreaming(ctx) ? "steer" : "nextTurn" },
    );
  };
  const openLife = (): void => {
    life = newReloadLife();
    execId = newReloadExec();
    lifeOpen = true;
    lastDeferredKey = undefined;
  };
  /** Entry facts open a fresh lifecycle when none is open; continuation facts need an open one. */
  const emit = (fact: ReloadPhaseFact, ctx: ExtensionCommandContext): void => {
    if (onPhase === undefined) return;
    if (!lifeOpen) {
      if (!ENTRY_FACTS.has(fact.kind)) return;
      openLife();
    }
    const by = webCmdIdOf(ctx);
    onPhase({ life: life!, execId, ...(by !== undefined ? { by } : {}), ...fact });
  };
  /** Execution-scoped emission for awaited continuations: only the captured attempt may speak. */
  const emitFrom = (
    attempt: { life: string; execId: string },
    fact: ReloadPhaseFact,
    ctx: ExtensionCommandContext,
  ): void => {
    if (onPhase === undefined) return;
    if (attempt.life !== life || attempt.execId !== execId || !lifeOpen) return;
    const by = webCmdIdOf(ctx);
    onPhase({ ...attempt, ...(by !== undefined ? { by } : {}), ...fact });
  };
  return {
    get pending() {
      return current()?.pending ?? false;
    },
    arm(activeCount, ctx) {
      const ctl = current();
      if (!ctl || !canReload(ctx)) return;
      const first = ctl.arm(activeCount, isReloadStreaming(ctx));
      // #30 D3: arm OR refresh ⇒ deferred{runs|idle, activeRuns} — after every ctl.arm call; a
      // refresh with an unchanged shape emits nothing (the projection would not change, D6).
      const waitingFor = activeCount > 0 ? ("runs" as const) : ("idle" as const);
      // The memo carries the ATTRIBUTION key too: a TUI-sourced fact about an untracked life is
      // dropped by the tracker (Q1), so it must never suppress a later WEB fact of the same
      // shape (that one establishes the record).
      const key = `${webCmdIdOf(ctx) ?? ""}|${waitingFor}:${activeCount}`;
      if (key !== lastDeferredKey) {
        emit({ kind: "deferred", waitingFor, ...(activeCount > 0 ? { activeRuns: activeCount } : {}) }, ctx);
        lastDeferredKey = key; // after emit: a freshly opened life resets the memo inside
      }
      if (!first) return; // refresh: count updated, no re-notify, first snapshot kept
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
      emit({ kind: "cancel" }, ctx); // #30 D3: any-source cancel ⇒ cancelled user, open:false
      lifeOpen = false;
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
        (reason) => {
          ctx.ui.notify(reason, "warning");
          // #30 D3: the natural-idle wait failed/timed out — the request stays parked (open).
          emit({ kind: "idleWait" }, ctx);
        },
      );
      const idleKey = `${webCmdIdOf(ctx) ?? ""}|idle`;
      if (lastDeferredKey !== idleKey) {
        emit({ kind: "deferred", waitingFor: "idle" }, ctx);
        lastDeferredKey = idleKey; // after emit: a freshly opened life resets the memo inside
      }
      return true;
    },
    unavailable(ctx) {
      // #30 D3: `failed E_RELOAD_UNAVAILABLE, open:false` — closes whatever lifecycle this is.
      emit({ kind: "unavailable" }, ctx);
      lifeOpen = false;
      notifyReloadUnavailable(ctx);
    },
    async reload(ctx, mode = "force") {
      if (lifeOpen) execId = newReloadExec(); // #30 D1: each attempt gets a fresh execId…
      emit({ kind: "exec" }, ctx); // …opening a lifecycle when none is open (entry fact)
      const attempt = { life: life!, execId };
      if (!canReload(ctx)) {
        emit({ kind: "unavailable" }, ctx);
        lifeOpen = false;
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
          emitFrom(attempt, { kind: "settle", open: ctl?.pending ?? false }, ctx);
          return;
        }
        // A user cancellation during the bounded wait also invalidates this fire/now.
        if (wasPending && !ctl?.pending) return; // the cancel fact already closed the lifecycle
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
      emitFrom(attempt, { kind: "started" }, ctx); // #30 D3/D4: the only marker-writing fact
      try {
        await ctx.reload();
        emitFrom(attempt, { kind: "returned" }, ctx); // tracker judges E_RELOAD_REFUSED
      } catch (error) {
        rollback?.();
        emitFrom(attempt, { kind: "threw", message: error instanceof Error ? error.message : String(error) }, ctx);
        throw error;
      } finally {
        // D1: the lifecycle ends when ctx.reload() returned or threw (success and refusal
        // alike) — the finally also runs on the rethrow, so a failed attempt cannot leak its
        // life into the next request (A13).
        lifeOpen = false;
      }
    },
  };
}
