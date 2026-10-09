/**
 * topic-switch · `/topic-switch` command (plan.md §P3b.6 "会话切换与 PONR" + §P3b.9).
 *
 * `__go <nonce>` is the hop trampoline's landing command (arch §6.2 / S3: a slash command sent
 * via `pi.sendUserMessage(..., {expandPromptTemplates:true})` never reaches the `input` event
 * handlers, so it cannot be mistaken for a newcomer that should end the hold). Everything from
 * here on implements the PONR contract (plan §0 I3/I4, §6b r3 N2/N3): the moment `ctx.newSession`
 * is called is the point of no return — any failure BEFORE it (invalid/stale nonce, a failed
 * preflight) routes back to the CURRENT session via the reducer; any failure or ambiguity AFTER
 * it never re-delivers into the old session, only notifies + offers `/topic-switch last --send`.
 *
 * The `taken`/`cancelled` race is arbitrated by the transfer record's own CAS (`TransferState`:
 * `pending → delivering → resolved`, bypass `pending → cancelled | manual`) — never a local
 * boolean — so the watchdog (armed by `wire.ts` right after `onPonr`), a late `withSession`
 * callback, and `/topic-switch last --send` can never double-deliver (r3 N3).
 */
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { toContent, type HoldRuntime } from "./hold.js";
import { ENTRY_TYPE, makePayload } from "./records.js";
import type { TransferLike, TransferState } from "./types.js";

export interface TopicSwitchCommandDeps {
  now(): number;
  /** `pi.appendEntry` bound to the ENTRY_TYPE custom-entry channel. */
  appendEntryRaw(customType: string, data: unknown): void;
  /** `pi.sendUserMessage` bound (CURRENT session at call time). */
  sendUserMessage(content: ReturnType<typeof toContent>, deliverAs: "steer" | "followUp"): void;
  /** Looks up a nonce; consumes it (removes + clears its timer) IFF it still points at a hold in
   *  the "hopping" phase. `undefined` ⇒ caller shows "链接已失效" (expired/consumed/wrong phase). */
  consumeHopNonce(nonce: string): HoldRuntime | undefined;
  onPreflightFailed(ctx: ExtensionCommandContext, hold: HoldRuntime): void;
  onPonr(ctx: ExtensionCommandContext, hold: HoldRuntime): void;
  onSwitchEntered(hold: HoldRuntime): void;
  onSwitchCancelled(ctx: ExtensionCommandContext, hold: HoldRuntime): void;
  /** B1: clears the dedicated mid-switch marker `onPonr` set, in every path that ends the PONR
   *  window WITHOUT going through `onSwitchEntered`/`onSwitchCancelled` (those two already clear
   *  it themselves). Until cleared, `pickTransferForRecovery` ignores this holdId's transfer
   *  entirely, so a new/resumed/forked activation's `session_start` recovery never races a
   *  mid-flight switch (the false "editor + 未能送达" warning this fixes). */
  clearInFlight(holdId: string): void;
  /** M1: persists the terminal `outcome:"switched"` record using the OLD (calling) activation's
   *  own `pi.appendEntry` — i.e. into the OLD session, the one place this activation can still
   *  reliably write after the switch (the NEW session belongs to a different, already-separate
   *  `wireTopicSwitch()` activation; `rctx` exposes no `appendEntry`). Disclosed limitation: once
   *  the user has moved on, `/topic-switch status`'s "recent outcomes" in the NEW session will
   *  never show this record — it lives where the switch originated, not where it landed. */
  recordSwitched(hold: HoldRuntime): void;
  setTransfer(entry: TransferLike): void;
  casTransfer(holdId: string, from: readonly TransferState[], to: TransferState): boolean;
  /** Most relevant known transfer for `/topic-switch last`: same-session pending first, else the
   *  latest pending/manual transfer overall (plan §P3b.7's "≤10 分钟"窗口 already enforced by the
   *  transfer store's own TTL eviction). */
  pickTransfer(sessionId: string): TransferLike | undefined;
  /** Snapshot of the shutdown-event counter, taken right before `ctx.newSession(...)` (r3 N2's
   *  "本 activation 是否已收到 session_shutdown" test). */
  markShutdownSeq(): number;
  shutdownHappenedSince(markSeq: number): boolean;
  statusText(ctx: ExtensionCommandContext): string;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    /* best-effort */
  }
}

async function handleGo(nonce: string, ctx: ExtensionCommandContext, deps: TopicSwitchCommandDeps): Promise<void> {
  const hold = deps.consumeHopNonce(nonce);
  if (hold === undefined) {
    notify(ctx, "这个切换链接已失效。", "warning");
    return;
  }
  // Preflight (plan §6 step 2): any failure here is still before PONR ⇒ routes back to "当前会话".
  if (!ctx.isIdle() || ctx.model === undefined || !ctx.hasUI) {
    deps.onPreflightFailed(ctx, hold);
    return;
  }

  const payload = hold.payload;
  const sessionId = ctx.sessionManager.getSessionId();
  // Step 3: write the handoff record + the in-process transfer into the OLD (current) session
  // BEFORE calling newSession — pi.appendEntry always targets whatever session is bound at call
  // time, which at this exact point is still the session this command is running in.
  deps.appendEntryRaw(ENTRY_TYPE, {
    v: 1,
    kind: "handoff",
    at: deps.now(),
    holdId: hold.id,
    payload: makePayload(payload.text, payload.images),
  });
  deps.setTransfer({
    holdId: hold.id,
    payload,
    fromSessionId: sessionId,
    reason: "switch",
    state: "pending",
    at: deps.now(),
  });
  deps.onPonr(ctx, hold); // hopping → switching; arms the PONR watchdog (wire.ts)

  const markSeq = deps.markShutdownSeq();
  let taken = false;
  const enterSwitched = (): void => {
    deps.clearInFlight(hold.id); // B1: no longer mid-switch — recovery may act on this holdId again
    deps.recordSwitched(hold); // M1: best-effort "switched" outcome, into the OLD session
    deps.onSwitchEntered(hold);
  };
  try {
    const result = await ctx.newSession({
      withSession: async (rctx) => {
        if (!deps.casTransfer(hold.id, ["pending"], "delivering")) {
          // m1: a late withSession lost the CAS (the PONR watchdog already gave up and moved the
          // transfer to "manual", or something else already advanced it) — the user must not be
          // left silently guessing where their request went (plan §6.6). Notify through `rctx`,
          // not the stale old-session `ctx` — the user is looking at the NEW session by now.
          notify(rctx, "请求已转为手动取回（/topic-switch last）。", "warning");
          return;
        }
        taken = true;
        try {
          await rctx.sendUserMessage(toContent(payload));
        } catch {
          try {
            rctx.ui.notify("原请求未能在新会话送达，输入 /topic-switch last --send 重发。", "warning");
          } catch {
            /* best-effort */
          }
        }
      },
    });
    if (taken) {
      enterSwitched();
      return;
    }
    // r3 N2: pi only returns {cancelled:true} from the session_before_switch phase, strictly
    // before teardown — the OLD session is intact, so rolling the transfer back is always safe.
    if (result.cancelled && deps.casTransfer(hold.id, ["pending"], "cancelled")) {
      deps.clearInFlight(hold.id);
      deps.onSwitchCancelled(ctx, hold);
    }
  } catch {
    if (taken) {
      enterSwitched();
      return;
    }
    if (!deps.shutdownHappenedSince(markSeq)) {
      // Teardown had not yet fired when this activation threw ⇒ same guarantee as `cancelled`.
      if (deps.casTransfer(hold.id, ["pending"], "cancelled")) {
        deps.clearInFlight(hold.id);
        deps.onSwitchCancelled(ctx, hold);
      }
    } else {
      // Past PONR (shutdown already happened) — never go back to the old session. TUI already
      // routes this to pi's own fatal-error path (R9); RPC reaches this notify.
      deps.clearInFlight(hold.id); // the transfer stays "pending" — still reachable via /topic-switch last
      notify(ctx, "切换未完成，原请求已保存，可用 /topic-switch last 取回。", "warning");
    }
  }
}

const TRANSFER_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pending: "待投递",
  delivering: "已发出",
  resolved: "已送达",
  cancelled: "已取消",
  manual: "待手动取回",
});

async function handleLast(rest: string, ctx: ExtensionCommandContext, deps: TopicSwitchCommandDeps): Promise<void> {
  const send = rest.trim() === "--send";
  const transfer = deps.pickTransfer(ctx.sessionManager.getSessionId());
  if (transfer === undefined) {
    notify(ctx, "没有已知的待取回请求。");
    return;
  }
  const imageNote =
    transfer.payload.images && transfer.payload.images.length > 0
      ? `（含 ${transfer.payload.images.length} 张图片）`
      : transfer.payload.imagesOmitted
        ? `（${transfer.payload.imagesOmitted} 张图片因超出大小上限未保存）`
        : "";
  if (!send) {
    const preview = Array.from(transfer.payload.text).slice(0, 200).join("");
    // Live acceptance 2026-10-10: a successful switch leaves the in-process state at "delivering"
    // (there is no separate delivered state), which read as "still in flight" — show user labels.
    const label = TRANSFER_STATE_LABELS[transfer.state] ?? transfer.state;
    notify(ctx, `[${label}] ${preview}${imageNote}`);
    return;
  }
  if (!deps.casTransfer(transfer.holdId, ["pending", "manual"], "delivering")) {
    notify(ctx, "该请求已经送达或正在送达中，无需重发。", "warning");
    return;
  }
  deps.sendUserMessage(toContent(transfer.payload), "followUp");
  notify(ctx, `已重发到当前会话${imageNote}。`);
}

export function createTopicSwitchCommand(deps: TopicSwitchCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "topic-switch 状态与取回：/topic-switch 查看判定开关/阈值/冷却/统计；/topic-switch last [--send] 查看或重发上次截留的请求。",
    getArgumentCompletions: (argumentPrefix: string) =>
      [
        { value: "status", label: "status", description: "查看当前判定状态" },
        { value: "last", label: "last", description: "查看上次截留/转移的请求" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim())),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const parts = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
      const [sub, ...rest] = parts;
      try {
        if (sub === "__go") {
          await handleGo(rest[0] ?? "", ctx, deps);
          return;
        }
        if (sub === "last") {
          await handleLast(rest.join(" "), ctx, deps);
          return;
        }
        notify(ctx, deps.statusText(ctx));
      } catch {
        // The command handler itself must never throw past this point (zero-hang invariant).
        notify(ctx, "topic-switch 命令执行出错。", "error");
      }
    },
  };
}
