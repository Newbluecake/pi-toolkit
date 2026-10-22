import { systemClock, type Clock } from "../../core/clock.js";
import type { CausalLevel } from "../wake-level.js";
import type { RootWakeController } from "../root-wake.js";
import type { SessionFence } from "./fence.js";
import { formatXsMessage, formatXsReply } from "./format.js";
import type { XsReplyLedger, XsReplyTicket } from "./reply-ledger.js";
import type { XsInboxMode } from "./inbox.js";
import type { XsInbox } from "./inbox.js";
import type { XsMembership } from "./membership.js";
import { getXsDedup, type XsAckVerdict, type XsDedup } from "./dedup.js";
import { shares, viaOrDefault } from "./channel.js";
import type { XsBroadcastMark } from "./types-channel.js";
import type { XsWakeDowngraded } from "../../web-hub/protocol/xs.js";

/**
 * fabric phase-2 X4 (phase2-plan §8.4 + §6.3 evidence table + §6.6 level table + §4.5 truth
 * table + r3 主会话裁定 M2/N2/S3): the RECEIVER pipeline — everything between the hub's
 * `xs_deliver` frame and the exactly-one `xs_ack` verdict, executed in ONE synchronous block
 * (no await anywhere in `deliver()`; XI8). Any stage failure settles the verdict and returns;
 * the verdict is stored in the dedup table so a duplicate replays the FIRST ack verbatim (§9).
 *
 * Ordered stages (§8.4):
 *   1. `expiresAt` not past ⇒ else `none{expired}`
 *   2. dedup — replay hit ⇒ replay; table full ⇒ `none{dedup_full}` (never evict)
 *   3. membership — joined ∧ receive≠off ∧ allowFrom ∧ not blocked ⇒ else `none{rejected}`;
 *      channel-plan §4.4 (CH3): the SAME gate re-checks the hub-stamped channel scope —
 *      `chs = bc ? [bc.channel] : (via ?? [default])` must share a channel with the local
 *      `linkChannels`. This is the linearization point of a local leave (§4.5): a leave before
 *      stage 3 ⇒ `none{rejected}` (no reply credential is reserved, Q4); after dispatch the
 *      effect stands (no rollback).
 *   3b. reply ledger classification: invalid credentials / unsolicited in replies mode reject.
 *   4. `to.sessionId`/`to.epoch` match the current stack ⇒ else `none{session_changed}`
 *   5. fence `check()` — a rejecting window ⇒ `none{fenced:<name>}`; `wakeOnly` (goal) only
 *      downgrades a wake, delivery proceeds
 *   6. inbound `recvPerHour` (⇒ `none{inbound_rate}`, charged on passage) and `inboxCap`
 *      (⇒ `none{inbox_full}`). Valid replies bypass both and reserve an independent replyInbox
 *      slot through the ledger before any host/Controller call; finish/catch commit or release it.
 *   7+8. §4.5 decision: Controller dispatch or deliver-only, then the §6.3 evidence ⇒ ack;
 *      level per §6.6; inbox accounting.
 *
 * r3 M2 (receiver side): an exception BEFORE the dispatch call is `none{receiver_error}` —
 * provably nothing happened; AFTER it is `unknown{receiver_error}` — the write may have landed.
 * r3 N2: deliver-only while the receiver streams is `unknown{queued}` (pi keeps the message in
 * its in-memory flush queue, Fpi7) — the tool text tells the model not to blindly resend.
 *
 * The Controller is injected (R1's `RootWakeController`); its `dispatch` owns every wake-path
 * truth-table row (wake_disabled / controller_disabled / host_unverified / host_unsupported /
 * receiver_policy / busy / goal / level_limit / inbound_wake_rate / ledger_full) and its own
 * level commits (S1). The receiver owns
 * the deliver-only rows and the carry (`raise(root, L_s)`) for deliver-only and downgraded
 * wakes. `fence.beginDispatch()/verifyDispatch()` (T1) wraps the actual send in both paths;
 * a failed post-dispatch verify discards `applied` evidence (T1: "gen_changed/fenced ⇒ 证据
 * 不可记 applied") ⇒ conservative `unknown{accept_unverified}`, `woke:false`. Pi-free.
 */

export const XS_RECEIVE_CUSTOM_TYPE = "subagent:xs";

/** What the receiver writes into the session tree (deliver-only form — no wake marker). */
export interface XsDeliverHostMessage {
  customType: typeof XS_RECEIVE_CUSTOM_TYPE;
  content: string;
  display: boolean;
  details: {
    xid: string;
    from: unknown;
    reply?: { requestId: string; dueAt: number };
    inReplyTo?: string;
    late?: true;
    /** Channel-plan §5.3: present iff this delivery is a channel broadcast. Never in `content`'s provider projection beyond the header line. */
    bc?: XsBroadcastMark;
  };
}

/** The XW-bound host surface. Same object can serve the Controller's host deps. */
export interface XsDeliverHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendMessage(message: XsDeliverHostMessage, options: { triggerTurn: boolean }): void;
  /** Leaf-entry evidence for §6.3 deliver-only applied (Fpi7 sync append). */
  getLeafEntry(): { type: string; customType?: string; details?: unknown } | undefined;
}

/** The `xs_deliver` payload minus the wire frame's own `t`/`rid` (XS0 shapes). */
export interface XsDeliverInput {
  xid: string;
  to: { sessionId: string; epoch: number };
  /** `alias` (alias-plan §6): hub-stamped only for an `aliasUsable` recipient; rides into the header verbatim. */
  from: { sessionId: string; ref: string; name?: string; cwdLabel: string; agentId: string; alias?: string };
  text: string;
  wake: boolean;
  reply?: { requestId: string; dueAt: number };
  inReplyTo?: string;
  /** Sender's root causal level; absent ⇒ sender wake off ⇒ never tracked (§6.6). */
  level?: number;
  expiresAt: number;
  /** Channel-plan §3.3: hub-stamped shared channels; ABSENT ≡ `["default"]` (§3.4). */
  via?: readonly string[];
  /** Channel-plan §3.3: hub-stamped broadcast marker (never `default`, Q2). */
  bc?: XsBroadcastMark;
}

export interface XsReceiverDeps {
  sessionId: string;
  membership: XsMembership;
  fence: SessionFence;
  inbox: XsInbox;
  /** RXW binds this ledger to the independent replyInbox via createXsReplyInboxPort. */
  replyLedger?: XsReplyLedger;
  /** `fabric.crossSession.limits.recvPerHour`. */
  recvPerHour: number;
  /** `fabric.crossSession.limits.wakesInPerHour`. */
  wakesInPerHour: number;
  /**
   * Wired iff the receiver's `fabric.wake.enabled` is on (XW builds the Controller first and
   * hands it here, or calls `setController` right after). Absent ⇒ `wake:true` degrades
   * `wake_disabled` (§4.5) and no level tracking.
   */
  controller?: Pick<RootWakeController, "dispatch">;
  /** The stack's CausalLevel; present iff receiver wake is on (§6.6 last row). */
  level?: CausalLevel;
  host: XsDeliverHost;
  /**
   * Channel-plan §2.3/§4.4: does the CURRENT hub link advertise `xs.channel.v1`? Feeds
   * `membership.link(hubCap)` at stage 3. Absent / throwing ⇒ false (fail closed: only
   * `#default` can be on the link) — except that a frame carrying a hub-stamped `via`/`bc` is
   * itself evidence of a channel-capable hub (only such a hub ever writes those keys).
   */
  hubChannelCap?: () => boolean;
  dedup?: XsDedup;
  clock?: Clock;
  warn?: (message: string) => void;
}

/** Sliding-window hourly counter (§4.6): at most `cap` charges inside any 3600s window. */
class HourlyWindow {
  private readonly times: number[] = [];
  constructor(
    private readonly cap: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isInteger(cap) || cap < 0) throw new RangeError("invalid hourly window cap");
  }
  get used(): number {
    this.prune();
    return this.times.length;
  }
  available(): boolean {
    this.prune();
    return this.times.length < this.cap;
  }
  charge(): void {
    this.times.push(this.clock.now());
  }
  private prune(): void {
    const horizon = this.clock.now() - 3_600_000;
    while (this.times.length > 0 && this.times[0]! <= horizon) this.times.shift();
  }
}

export interface XsWakeQuotaView {
  recvUsed: number;
  recvCap: number;
  wakesUsed: number;
  wakesCap: number;
}

/** Receiver audit counters (English tokens; surfaced by `/fabric status` + X5's `/agent status`). */
export interface XsReceiverCounters {
  expired: number;
  dedupReplay: number;
  dedupFull: number;
  rejected: number;
  sessionChanged: number;
  fenced: number;
  inboundRate: number;
  inboxFull: number;
  applied: number;
  queued: number;
  unverified: number;
  wakeDispatched: number;
  wakeDowngraded: number;
  receiverError: number;
}

const ZERO_COUNTERS: XsReceiverCounters = {
  expired: 0,
  dedupReplay: 0,
  dedupFull: 0,
  rejected: 0,
  sessionChanged: 0,
  fenced: 0,
  inboundRate: 0,
  inboxFull: 0,
  applied: 0,
  queued: 0,
  unverified: 0,
  wakeDispatched: 0,
  wakeDowngraded: 0,
  receiverError: 0,
};

export class XsReceiver {
  private readonly clock: Clock;
  private readonly dedup: XsDedup;
  private readonly recvWindow: HourlyWindow;
  private readonly wakeWindow: HourlyWindow;
  private readonly counters: XsReceiverCounters = { ...ZERO_COUNTERS };
  private controller: Pick<RootWakeController, "dispatch"> | undefined;

  constructor(private readonly deps: XsReceiverDeps) {
    this.clock = deps.clock ?? systemClock;
    this.dedup = deps.dedup ?? getXsDedup();
    this.recvWindow = new HourlyWindow(deps.recvPerHour, this.clock);
    this.wakeWindow = new HourlyWindow(deps.wakesInPerHour, this.clock);
    this.controller = deps.controller;
  }

  /** XW late binding: the stack builds the Controller with this receiver's wake-quota ports. */
  setController(controller: Pick<RootWakeController, "dispatch"> | undefined): void {
    this.controller = controller;
  }

  /** §4.6 receiver-side wake quota — wire these into the Controller's deps (R1 report #3). */
  wakeAvailable(): boolean {
    return this.wakeWindow.available();
  }

  chargeWake(): void {
    this.wakeWindow.charge();
  }

  wakeQuota(): XsWakeQuotaView {
    return {
      recvUsed: this.recvWindow.used,
      recvCap: this.deps.recvPerHour,
      wakesUsed: this.wakeWindow.used,
      wakesCap: this.deps.wakesInPerHour,
    };
  }

  countersSnapshot(): XsReceiverCounters {
    return { ...this.counters };
  }

  /**
   * THE pipeline (§8.4). Synchronous by contract; X2 calls this straight from its
   * `xs_deliver` case and answers exactly one ack with the returned verdict.
   */
  deliver(input: XsDeliverInput): XsAckVerdict {
    const transaction: { requestId?: string; mode: XsInboxMode } = { mode: "appended" };
    let dispatched = false; // r3 M2 boundary — flips just before the host/Controller send
    try {
      return this.pipeline(input, (value) => (dispatched = value), transaction);
    } catch (error) {
      this.counters.receiverError++;
      this.warnError("receiver_error", error);
      const verdict: XsAckVerdict = {
        effect: dispatched ? "unknown" : "none",
        reason: "receiver_error",
        woke: false,
      };
      this.settleReply(transaction, verdict.effect !== "none");
      this.dedup.settle(input.xid, verdict);
      return verdict;
    }
  }

  /** Per-call transaction (never shared across synchronous reentry); only provable none releases. */
  private settleReply(transaction: { requestId?: string; mode: XsInboxMode }, commit: boolean): void {
    const requestId = transaction.requestId;
    if (requestId === undefined) return;
    delete transaction.requestId;
    if (commit) this.deps.replyLedger!.commit(requestId, transaction.mode);
    else this.deps.replyLedger!.release(requestId);
  }

  private pipeline(
    input: XsDeliverInput,
    setDispatched: (value: boolean) => void,
    transaction: { requestId?: string; mode: XsInboxMode },
  ): XsAckVerdict {
    const finish = (verdict: XsAckVerdict): XsAckVerdict => {
      this.settleReply(transaction, verdict.effect !== "none");
      this.dedup.settle(input.xid, verdict);
      return verdict;
    };

    // ---- stage 1: expiry (§8.4.1) ----
    const now = this.clock.now();
    if (!Number.isFinite(input.expiresAt) || now >= input.expiresAt) {
      this.counters.expired++;
      return finish({ effect: "none", reason: "expired", woke: false });
    }

    // ---- stage 2: dedup (§9) — BEFORE dispatch, at-most-once ----
    const admit = this.dedup.admit(input.xid, input.expiresAt);
    if (admit.kind === "replay") {
      this.counters.dedupReplay++;
      return finish(admit.verdict);
    }
    if (admit.kind === "full") {
      this.counters.dedupFull++;
      return finish({ effect: "none", reason: "dedup_full", woke: false });
    }

    // ---- stage 3: membership + policy (§8.4.3) — uniform none{rejected} (no policy leak) ----
    // Channel-plan §4.4: scope re-check against the hub-stamped `via`/`bc` (same gate as block).
    if (
      !this.channelScopeOk(input) ||
      this.deps.membership.receive === "off" ||
      !this.deps.membership.senderAllowed(input.from.sessionId)
    ) {
      this.counters.rejected++;
      return finish({ effect: "none", reason: "rejected", woke: false });
    }

    // Stage 3b: an unknown, consumed or wrong-sender credential NEVER becomes unsolicited.
    const classified = this.deps.replyLedger?.classify(
      input.inReplyTo,
      input.from.sessionId,
      this.deps.sessionId,
      now,
    ) ?? { kind: input.inReplyTo === undefined ? "unsolicited" : "invalid" };
    const ticket: XsReplyTicket | undefined = "ticket" in classified ? classified.ticket : undefined;
    const late = classified.kind === "late";
    if (
      classified.kind === "invalid" ||
      (classified.kind === "unsolicited" && this.deps.membership.receive === "replies")
    ) {
      this.counters.rejected++;
      return finish({ effect: "none", reason: "rejected", woke: false });
    }
    const content = (wake: boolean): string =>
      ticket === undefined
        ? formatXsMessage(
            {
              xid: input.xid,
              from: input.from,
              wake,
              ...(input.reply === undefined ? {} : { reply: input.reply }),
              ...(input.bc === undefined ? {} : { bc: { channel: input.bc.channel } }),
            },
            input.text,
          )
        : formatXsReply({ xid: input.xid, from: input.from, requestId: ticket.requestId, late }, input.text);
    const accept = (mode: XsInboxMode): void => {
      transaction.mode = mode;
      if (ticket === undefined) this.deps.inbox.accept(input.xid, mode);
    };

    // ---- stage 4: target identity (§8.4.4) ----
    if (input.to.sessionId !== this.deps.sessionId || input.to.epoch !== this.deps.membership.epoch) {
      this.counters.sessionChanged++;
      return finish({ effect: "none", reason: "session_changed", woke: false });
    }

    // ---- stage 5: fence (§7) — goal only downgrades a wake (wakeOnly) ----
    const fenceCheck = this.deps.fence.check();
    let wakeDowngrade: XsWakeDowngraded | undefined;
    if (!fenceCheck.ok && !fenceCheck.wakeOnly) {
      this.counters.fenced++;
      return finish({ effect: "none", reason: fenceCheck.reason, woke: false });
    }
    if (!fenceCheck.ok && fenceCheck.wakeOnly) wakeDowngrade = "goal";

    // ---- stage 6: inbound rate + inbox (§8.4.6) — rate charged on passage ----
    if (ticket === undefined) {
      if (!this.recvWindow.available()) {
        this.counters.inboundRate++;
        return finish({ effect: "none", reason: "inbound_rate", woke: false });
      }
      this.recvWindow.charge();
      if (this.deps.inbox.isFull()) {
        this.counters.inboxFull++;
        return finish({ effect: "none", reason: "inbox_full", woke: false });
      }
    } else {
      const reserved = this.deps.replyLedger!.reserve(ticket.requestId, input.xid);
      if (!reserved.ok)
        return finish({
          effect: "none",
          reason: reserved.reason === "inbox_full" ? "inbox_full" : "rejected",
          woke: false,
        });
      transaction.requestId = ticket.requestId;
    }

    // ---- stages 7+8: dispatch + evidence (§4.5 / §6.3 / §6.6) ----
    const wantWake = ticket === undefined ? input.wake === true : !late && ticket.wakeOnReply;
    if (ticket !== undefined && wantWake && this.deps.membership.receive === "deliver")
      wakeDowngrade = "receiver_policy";
    const carry = (): void => {
      // §6.6 deliver-only / downgraded rows: raise(root, L_s) — carry without counting.
      const carryLevel = ticket?.requesterLevel ?? input.level;
      if (carryLevel !== undefined && this.deps.level !== undefined) this.deps.level.raise("root", carryLevel);
    };

    if (wantWake && wakeDowngrade === undefined && this.controller !== undefined) {
      // Controller path — R1's dispatch owns every wake truth-table row and the level commit.
      const guard = this.deps.fence.beginDispatch();
      if (!guard.ok) {
        if (!guard.wakeOnly) {
          this.counters.fenced++;
          return finish({ effect: "none", reason: guard.reason, woke: false });
        }
        wakeDowngrade = "goal"; // goal active at the dispatch point ⇒ wake-only downgrade
      } else {
        transaction.mode = "trigger";
        const request = {
          xid: input.xid,
          from: input.from,
          content: content(true),
          ...(ticket === undefined ? {} : { solicited: true as const, returnLevel: ticket.requesterLevel }),
          expiresAt: input.expiresAt,
          ...(input.reply === undefined ? {} : { reply: input.reply }),
          ...(ticket === undefined ? {} : { inReplyTo: ticket.requestId }),
          ...(input.level === undefined ? {} : { level: input.level }),
          ...(input.bc === undefined ? {} : { bc: { channel: input.bc.channel } }),
        };
        setDispatched(true); // r3 M2 boundary: from here an exception may follow a host send
        const result = this.controller.dispatch(request);
        if (result.dispatched) {
          this.counters.wakeDispatched++;
          accept("trigger");
          // T1 §7.4 post-dispatch re-verify: gen moved / fence re-opened ⇒ applied 不可记.
          // A wakeOnly verify (goal) never invalidates an already-dispatched delivery.
          const verify = this.deps.fence.verifyDispatch(guard.gen);
          if (!verify.ok && !verify.wakeOnly) {
            this.counters.unverified++;
            return finish({ effect: "unknown", reason: "accept_unverified", woke: false });
          }
          if (result.effect === "applied") {
            this.counters.applied++;
            return finish({ effect: "applied", woke: true });
          }
          this.counters.unverified++;
          return finish({ effect: "unknown", reason: "start_deferred", woke: true });
        }
        // A non-dispatch verdict proves the Controller had no effect. Quiet fallback has
        // not called its host yet: a subsequent guard/carry exception must release the ticket.
        setDispatched(false);
        if ("effect" in result && result.effect === "none") {
          return finish({ effect: "none", reason: result.reason, woke: false });
        }
        wakeDowngrade = result.wakeDowngraded; // fall through: deliver-only with the downgrade
      }
    } else if (wantWake && wakeDowngrade === undefined && this.controller === undefined) {
      // §4.5 row: receiver's fabric.wake.enabled=false ⇒ no Controller, no CausalLevel.
      wakeDowngrade = "wake_disabled";
    }

    if (wantWake && wakeDowngrade !== undefined) this.counters.wakeDowngraded++;
    carry(); // §6.6: every path reaching here is a deliver-only (plain or downgraded wake) ⇒ carry L_s

    // ---- deliver-only (§6.3 rows 2–5) ----
    transaction.mode = "appended";
    const idleBefore = this.safeIsIdle(); // Fpi7/Fpi8: streaming classifies BEFORE the send
    const guard = this.deps.fence.beginDispatch();
    if (!guard.ok && !guard.wakeOnly) {
      this.counters.fenced++;
      return finish({ effect: "none", reason: guard.reason, woke: false });
    }
    // A wakeOnly guard (goal) has no gen snapshot — fall back to the raw generation counter;
    // goal deactivating mid-block cannot invalidate the write (only gen/fence rejections can).
    const dispatchGen = guard.ok ? guard.gen : this.deps.fence.generation();
    setDispatched(true); // r3 M2 boundary
    try {
      this.deps.host.sendMessage(
        {
          customType: XS_RECEIVE_CUSTOM_TYPE,
          content: content(false),
          display: true, // RX7 D-display: every received xs message is user-visible
          details: {
            xid: input.xid,
            from: input.from,
            ...(input.reply === undefined ? {} : { reply: input.reply }),
            ...(ticket === undefined ? {} : { inReplyTo: ticket.requestId }),
            ...(late ? { late: true as const } : {}),
            ...(input.bc === undefined ? {} : { bc: { channel: input.bc.channel } }),
          },
        },
        { triggerTurn: false },
      );
    } catch {
      // §6.3 row 1: a synchronous throw (Fpi1) proves no effect.
      return finish({ effect: "none", reason: "host_rejected", woke: false });
    }
    const verify = this.deps.fence.verifyDispatch(dispatchGen);
    if (!verify.ok && !verify.wakeOnly) {
      // T1: the write landed in a session whose identity moved — evidence unusable (M2: post-dispatch).
      this.counters.unverified++;
      accept("appended"); // may be in context — hold a slot (conservative)
      return finish({ effect: "unknown", reason: "accept_unverified", woke: false });
    }
    // A requested wake that degraded rides EVERY deliver-only verdict (`xs_ack.wakeDowngraded`, XS0).
    const downgradeField = wantWake && wakeDowngrade !== undefined ? { wakeDowngraded: wakeDowngrade } : {};
    if (!idleBefore) {
      // N2/Fpi7: streaming — pi keeps the message in its in-memory queue; not provably applied.
      this.counters.queued++;
      accept("queued");
      return finish({ effect: "unknown", reason: "queued", woke: false, ...downgradeField });
    }
    const leaf = this.safeLeaf();
    if (
      leaf !== undefined &&
      leaf.type === "custom_message" &&
      leaf.customType === XS_RECEIVE_CUSTOM_TYPE &&
      this.leafHasXid(leaf.details, input.xid)
    ) {
      this.counters.applied++;
      accept("appended");
      // Evidence reasons (queued/unverified/error) take precedence over the late classification.
      return finish({
        effect: "applied",
        woke: false,
        ...downgradeField,
        ...(late ? { reason: "reply_late" as const } : {}),
      });
    }
    // §6.3 row 3: idle but the leaf is not this message — host swallowed the async error etc.
    this.counters.unverified++;
    accept("appended"); // conservative hold (may be in the tree)
    return finish({ effect: "unknown", reason: "accept_unverified", woke: false, ...downgradeField });
  }

  /**
   * Channel-plan §4.4: `intersect(chs, linkChannels) ≠ ∅` where `chs = bc ? [bc.channel] :
   * (via ?? [default])`. Default-only sessions on any hub reduce to the pre-channel
   * `joined` check (link = [default], chs = [default]). Never throws (stage-3 failures are a
   * uniform `none{rejected}`; an unreadable cap port reads as "no cap").
   */
  private channelScopeOk(input: XsDeliverInput): boolean {
    let hubCap = input.via !== undefined || input.bc !== undefined;
    if (!hubCap && this.deps.hubChannelCap !== undefined) {
      try {
        hubCap = this.deps.hubChannelCap() === true;
      } catch {
        hubCap = false;
      }
    }
    const link = this.deps.membership.link(hubCap);
    if (link.length === 0) return false;
    const chs = input.bc !== undefined ? [input.bc.channel] : viaOrDefault(input.via);
    return shares(chs, link);
  }

  private safeIsIdle(): boolean {
    try {
      return this.deps.host.isIdle();
    } catch {
      return false; // unreadable ⇒ treat as busy ⇒ unknown{queued} (conservative)
    }
  }

  private safeLeaf(): { type: string; customType?: string; details?: unknown } | undefined {
    try {
      return this.deps.host.getLeafEntry();
    } catch {
      return undefined;
    }
  }

  private leafHasXid(details: unknown, xid: string): boolean {
    if (details === null || typeof details !== "object") return false;
    return (details as { xid?: unknown }).xid === xid;
  }

  private warnError(stage: string, error: unknown): void {
    try {
      (this.deps.warn ?? console.warn)(
        `[pi-subagent] fabric xs receiver: ${stage} (code only, no body)`,
        error instanceof Error ? error.name : typeof error,
      );
    } catch {
      /* diagnostics only */
    }
  }
}
