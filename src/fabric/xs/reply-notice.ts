import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import type { FenceDispatchVerdict } from "./fence.js";
import type { XsReplyLedger, XsReplyTicket } from "./reply-ledger.js";

/**
 * fabric cross-session reply association — the NoticeGate (reply-plan §7.2, RX1): admission for
 * the requester-side timeout/invalidation notices. The Controller itself never checks
 * `joined` (phase-1 contract) — EVERY local caller owns admission; for these notices that
 * caller is this gate.
 *
 * One synchronous block per flush: all checks AND the write happen with no awaits in between
 * (XI8 posture). Any unmet condition ⇒ NO write, the owed notice stays owed, and the event
 * driven retry points (stack restore, `beforeAgentStart`/`settled`, fence-close events,
 * `/fabric join|receive|fence reset` — wired by RXW) plus the 30s fallback timer here retry
 * until the ticket's `lateUntil`, where the ledger's sweep drops it (`droppedNotices`).
 * Quiet-during-fence fallback (r1's approach) is FORBIDDEN — a fence hit keeps the notice owed.
 *
 * Notices merged: all of one session's owed tickets go out in ONE write. The restart
 * invalidation notice (§3.3) and the away-period expiry summary (§3.4) ride the same admission
 * (`emitQuiet`, always quiet — they never wake).
 *
 * Pi-free: every pi touchpoint is an injected port. All timers ride the injected Clock
 * (systemClock is segmented + unref'd; a ref'd timer would wedge `pi -p`).
 */

/** §7.2 quiet-write customType; `display:true` + `triggerTurn:false` (workflow-notice precedent). */
export const XS_REPLY_NOTICE_TYPE = "subagent:xs-reply";
/** §7.2 fallback retry cadence while any notice is owed (unref'd). */
export const XS_REPLY_NOTICE_RETRY_MS = 30_000;
/** §7.2 controller dispatch `expiresAt` horizon. */
export const XS_REPLY_NOTICE_WAKE_EXPIRES_MS = 5_000;

/** The quiet write payload handed to the host port (never the provider payload — XI10). */
export interface XsReplyQuietWrite {
  customType: typeof XS_REPLY_NOTICE_TYPE;
  display: true;
  content: string;
  details: { requestIds: string[] };
}

/** §6.5/§7.2 wake dispatch request — `solicited:true`, level = `returnLevel` (R3, no +1). */
export interface XsReplyNoticeWakeRequest {
  xid: string;
  from: { kind: "local"; reason: "reply_timeout" };
  content: string;
  expiresAt: number;
  solicited: true;
  returnLevel: number;
}

/** Mirror of `RootWakeDispatchResult`'s three shapes (the controller port never throws in-spec). */
export type XsReplyNoticeWakeResult =
  | { dispatched: true }
  | { dispatched: false; wakeDowngraded: string }
  | { dispatched: false; effect: "none"; reason: string };

export interface XsReplyNoticePorts {
  ledger: XsReplyLedger;
  /** The requester session this gate serves (its stack). */
  sessionId: string;
  /** Current stack session (RXW: `ctx.sessionManager.getSessionId()`); mismatch ⇒ not admitted. */
  getSessionId(): string;
  /** Stack disposed ⇒ never write again. */
  disposed(): boolean;
  /** Membership `joined` (admission #2). */
  joined(): boolean;
  /** EFFECTIVE receive (§8.1 `effectiveReceive`); `off` ⇒ not admitted. */
  receive(): "off" | "deliver" | "wake" | "replies";
  /** The stack's session fence — dispatch-point protocol, same as the receiver pipeline. */
  fence: {
    beginDispatch(): FenceDispatchVerdict;
    verifyDispatch(gen: number): FenceDispatchVerdict;
  };
  /** Optional solicited wake port (RX5's Controller with `solicited`/`returnLevel`); absent ⇒ quiet only. */
  controller?: { dispatch(request: XsReplyNoticeWakeRequest): XsReplyNoticeWakeResult };
  /** Quiet write: `pi.sendMessage(write, { triggerTurn:false })`; a synchronous throw keeps owed. */
  host: { sendMessage(write: XsReplyQuietWrite): void };
  clock?: Clock;
}

/** §7.2 admission refusals — every one of these keeps the owed notice owed (except as noted). */
export type XsReplyNoticeRefusal =
  | "disposed" // stack gone — stop retrying
  | "session_changed" // current session is not this gate's requester
  | "not_joined"
  | "receive_off" // effective receive off — the human closed the xs entrance (RR12)
  | "fenced" // fence window open — quiet-during-fence is FORBIDDEN (r2 #2)
  | "wake_none" // controller provably did not dispatch
  | "host_threw"; // sync host/controller throw (§7.2 step 5/6)

export type XsReplyNoticeFlushResult =
  | { written: "wake" | "quiet"; requestIds: string[]; unverified?: boolean }
  | {
      written: false;
      /** `nothing_owed` is success-shaped (nothing to do); the rest keep owed (see reasons). */
      reason: XsReplyNoticeRefusal | "nothing_owed";
      requestIds?: string[];
    };

export interface XsReplyNoticeStatus {
  owed: number;
  /** verifyDispatch failures after a successful write — counted, never re-sent (NQ3). */
  noticeUnverified: number;
  writes: { wake: number; quiet: number };
  retryArmed: boolean;
}

/**
 * One per stack (RXW constructs on build, disposes on teardown). Holds only closure state —
 * the owed tickets themselves live in the process ledger.
 */
export class XsReplyNoticeGate {
  private readonly ports: XsReplyNoticePorts;
  private readonly clock: Clock;
  private retryHandle: ReturnType<Clock["setTimer"]> | undefined;
  private unverifiedCount = 0;
  private wakeWrites = 0;
  private quietWrites = 0;
  private disposed = false;

  constructor(ports: XsReplyNoticePorts) {
    this.ports = ports;
    this.clock = ports.clock ?? systemClock;
  }

  /**
   * §7.2 flush: sweep → collect owed → admit (disposed/session/joined/receive/fence) → write
   * (wake or quiet) → verify + clear owed. NOTHING is awaited; a `none`/throw keeps the owed
   * notice and arms the 30s fallback timer. The `wakeOnly` (goal) fence verdict permits the
   * QUIET path only. The wake path is chosen when at least one owed ticket has `wakeOnReply`
   * and the effective receive admits wakes; `returnLevel` = the MINIMUM requester level of the
   * wake-eligible tickets (conservative).
   */
  flush(): XsReplyNoticeFlushResult {
    if (this.disposed) return { written: false, reason: "disposed" };
    const now = this.clock.now();
    this.ports.ledger.sweep(now);
    const owed = [...this.ports.ledger.owedNotices(this.ports.sessionId)];
    if (owed.length === 0) {
      this.disarm();
      return { written: false, reason: "nothing_owed" };
    }
    const requestIds = owed.map((ticket) => ticket.requestId).sort();
    const admission = this.admit();
    if (admission !== undefined) {
      if (admission !== "disposed")
        this.armRetry(owed); // a disposed stack must not keep timers
      else this.disarm();
      return { written: false, reason: admission, requestIds };
    }
    // beginDispatch verdict decides wake vs quiet: a rejecting window forbids BOTH (no
    // quiet-during-fence fallback); `wakeOnly` (goal) downgrades to quiet.
    const guard = this.ports.fence.beginDispatch();
    if (!guard.ok && !guard.wakeOnly) {
      this.armRetry(owed);
      return { written: false, reason: "fenced", requestIds };
    }
    const receive = this.ports.receive();
    const wakeEligible = owed.filter((ticket) => ticket.wakeOnReply);
    const controller = this.ports.controller;
    const guardOk = guard.ok === true ? guard : undefined;
    const wake =
      guardOk !== undefined &&
      wakeEligible.length > 0 &&
      (receive === "wake" || receive === "replies") &&
      controller !== undefined;
    const content = buildTimeoutNoticeContent(owed);
    if (wake && guardOk !== undefined && controller !== undefined) {
      const request: XsReplyNoticeWakeRequest = {
        xid: `t_${requestIds[0]!}`,
        from: { kind: "local", reason: "reply_timeout" },
        content,
        expiresAt: now + XS_REPLY_NOTICE_WAKE_EXPIRES_MS,
        solicited: true,
        returnLevel: Math.min(...wakeEligible.map((ticket) => ticket.requesterLevel)),
      };
      let result: XsReplyNoticeWakeResult;
      try {
        result = controller.dispatch(request);
      } catch {
        this.armRetry(owed);
        return { written: false, reason: "host_threw", requestIds };
      }
      if (!result.dispatched && "effect" in result && result.effect === "none") {
        // Provably no dispatch — keep owed, retry later (§7.2 step 5 "none").
        this.armRetry(owed);
        return { written: false, reason: "wake_none", requestIds };
      }
      if (result.dispatched) {
        this.wakeWrites += 1;
        this.finishWrite(guardOk.gen, requestIds);
        return { written: "wake", requestIds };
      }
      // Downgraded (busy/goal/rate/…) ⇒ quiet write in the SAME synchronous block.
      return this.quietWrite(content, requestIds, guardOk.gen);
    }
    return this.quietWrite(content, requestIds, guardOk?.gen ?? 0);
  }

  /**
   * One-shot quiet notice through the same admission (§3.3 restart invalidation, §3.4 away
   * summary). Never wakes, never arms the retry timer — the caller decides whether to retry
   * (the restart scan runs once per process+session; a not-admitted invalidation simply does
   * not append its settle entries, so a later restart retries).
   */
  emitQuiet(content: string, requestIds: readonly string[]): XsReplyNoticeFlushResult {
    if (this.disposed) return { written: false, reason: "disposed" };
    const admission = this.admit();
    if (admission !== undefined) return { written: false, reason: admission, requestIds: [...requestIds] };
    const guard = this.ports.fence.beginDispatch();
    if (!guard.ok) {
      // Any rejecting window (wakeOnly included) blocks a one-shot write too — it can retry.
      return { written: false, reason: "fenced", requestIds: [...requestIds] };
    }
    return this.quietWrite(content, [...requestIds], guard.gen);
  }

  /** §3.4 switch-back: the away-period expiry summary (always quiet, always one-shot). */
  emitDroppedSummary(dropped: number): XsReplyNoticeFlushResult {
    return this.emitQuiet(buildDroppedSummaryContent(dropped), []);
  }

  status(): XsReplyNoticeStatus {
    return {
      owed: this.ports.ledger.owedNotices(this.ports.sessionId).length,
      noticeUnverified: this.unverifiedCount,
      writes: { wake: this.wakeWrites, quiet: this.quietWrites },
      retryArmed: this.retryHandle !== undefined,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  // ------------------------------------------------------------------ internals

  /** Admission #1–#3 (§7.2): disposed / session identity / joined / effective receive. */
  private admit(): XsReplyNoticeRefusal | undefined {
    if (this.ports.disposed()) return "disposed";
    if (this.ports.getSessionId() !== this.ports.sessionId) return "session_changed";
    if (!this.ports.joined()) return "not_joined";
    if (this.ports.receive() === "off") return "receive_off";
    return undefined;
  }

  private quietWrite(content: string, requestIds: string[], gen: number): XsReplyNoticeFlushResult {
    const write: XsReplyQuietWrite = {
      customType: XS_REPLY_NOTICE_TYPE,
      display: true,
      content,
      details: { requestIds },
    };
    try {
      this.ports.host.sendMessage(write);
    } catch {
      this.armRetry();
      return { written: false, reason: "host_threw", requestIds };
    }
    this.quietWrites += 1;
    this.finishWrite(gen, requestIds);
    return { written: "quiet", requestIds };
  }

  /** §7.2 step 6: clear owed regardless of verifyDispatch; a failure only counts (NQ3). */
  private finishWrite(gen: number, requestIds: readonly string[]): void {
    let unverified = false;
    try {
      const verify = this.ports.fence.verifyDispatch(gen);
      // A wakeOnly verdict (goal) never invalidates an already-written quiet notice (receiver.ts parity).
      unverified = !verify.ok && !verify.wakeOnly;
    } catch {
      unverified = true;
    }
    if (unverified) this.unverifiedCount += 1;
    this.ports.ledger.clearOwed(requestIds);
    // A successful write may have emptied the owed set — drop the fallback timer if so.
    if (this.ports.ledger.owedNotices(this.ports.sessionId).length === 0) this.disarm();
  }

  /** 30s fallback while owed exists — the owed tickets die at lateUntil (ledger sweep), which
   *  naturally ends the loop: sweep drops them, flush sees nothing_owed and disarms. */
  private armRetry(owed?: readonly XsReplyTicket[]): void {
    if (this.disposed || this.retryHandle !== undefined) return;
    if (owed !== undefined && owed.length === 0) return;
    if (owed === undefined && this.ports.ledger.owedNotices(this.ports.sessionId).length === 0) return;
    this.retryHandle = this.clock.setTimer(XS_REPLY_NOTICE_RETRY_MS, () => {
      this.retryHandle = undefined;
      this.flush();
    });
  }

  private disarm(): void {
    if (this.retryHandle === undefined) return;
    try {
      this.clock.clearTimer(this.retryHandle);
    } catch {
      /* best-effort */
    }
    this.retryHandle = undefined;
  }
}

// ----------------------------------------------------------------- notice copy (prose blocks; §8.3 marker tokens stay English)

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * §7.2 timeout notice — ONE write for every owed ticket of the session. States the exact
 * promise: a reply inside the grace window still lands (quietly); after it the ticket is gone
 * and the peer's resend will be refused.
 */
export function buildTimeoutNoticeContent(tickets: readonly XsReplyTicket[]): string {
  const lines = tickets
    .slice()
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((ticket) => `- ${ticket.requestId} → ${ticket.replierRef}（截止 ${iso(ticket.dueAt)}）`);
  const head =
    tickets.length === 1
      ? `你发往 ${tickets[0]!.replierRef} 的跨会话请求 ${tickets[0]!.requestId} 已超时未收到回复（截止 ${iso(tickets[0]!.dueAt)}）。`
      : `你有 ${tickets.length} 个跨会话请求已超时未收到回复：`;
  return (
    `[fabric xs reply-timeout] ${head}\n${lines.join("\n")}\n` +
    `宽限期（默认 10 分钟）内到达的回复仍会送达（不唤醒，无需轮询）；宽限期过后凭证失效，对方的补发将被拒收。`
  );
}

/** §3.3 restart invalidation — ≤16 listed, 「另有 N 条」 for the rest; false positives acknowledged. */
export function buildInvalidationNoticeContent(
  invalid: readonly { requestId: string; replierRef: string }[],
  more: number,
): string {
  const lines = invalid.map((item) => `- ${item.requestId} → ${item.replierRef}`);
  if (more > 0) lines.push(`- 另有 ${more} 条`);
  return (
    `[fabric xs reply-invalidated] 以下跨会话请求在 pi 重启前未确认收到回复，凭证已失效，对方的回复将被拒收：\n` +
    `${lines.join("\n")}\n` +
    `若其中个别请求其实已收到回复（持久化记录不全时会误列），请忽略对应条目。未决请求不支持跨 pi 重启。`
  );
}

/** §3.4 away-period expiry summary. */
export function buildDroppedSummaryContent(dropped: number): string {
  return (
    `[fabric xs reply-timeout] 会话离开期间有 ${dropped} 个跨会话请求超时并已过期（超时通知未能送达，凭证已失效）。` +
    `如仍需要结果，请重新发起请求。`
  );
}
