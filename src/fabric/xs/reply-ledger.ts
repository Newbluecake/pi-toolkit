import { randomBytes } from "node:crypto";
import type { Clock } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import { XsInbox, type XsInboxMode } from "./inbox.js";
import { XS_REPLY_REQUEST_ID_RE } from "../../web-hub/protocol/xs.js";

/**
 * fabric cross-session reply association — the requester-side ticket ledger (reply-plan §3/§6.3,
 * RX1). THE one authoritative source of receivability (r2, Blocker #1 closure): a ticket can
 * become/may remain receivable ONLY in this process's memory. Disk (`subagent:xs-reply` session
 * entries, §3.3) exists solely to generate the post-restart "already invalidated" notice — no
 * code path ever rebuilds a receivable ticket from it, so `/tree` rollback, tombstone eviction
 * and process restart can all only REFUSE (fail closed).
 *
 * Process-level: one instance behind `Symbol.for("pi-subagent:xs-reply-ledger")`, surviving
 * `/reload`, `/tree` and session switches (same contract as the wake ledger). Per-stack pieces
 * (the replyInbox port + the best-effort entry sinks) attach via `bindSession` and detach on
 * stack dispose — the ticket table itself never dies with a stack.
 *
 * §3.4 state table (authoritative):
 *
 * | state                          | receivable      | quota | slot | sweep-delete          |
 * |--------------------------------|-----------------|-------|------|-----------------------|
 * | pending                        | yes (on time)   | yes   | yes  | no                    |
 * | consuming                      | no (invalid)    | yes   | yes  | no                    |
 * | timed_out (now < lateUntil)    | yes (late)      | yes   | yes  | no                    |
 * | replied / late_replied         | no (tombstone)  | no    | yes  | now >= lateUntil      |
 * | send_failed                    | no              | no    | yes  | immediately           |
 *
 * Full ledger (cap 64) refuses new issues (`reply_ledger_full`) — never evicts a
 * non-deletable entry (B1 spirit); every entry is deletable once past `lateUntil`
 * (≤ maxTimeoutS + lateGraceS ≤ ~25h), so a full ledger self-heals through `sweep`.
 *
 * Consumption state machine (§6.3): `reserve` happens BEFORE any re-entrant host call and
 * flips the ticket to `consuming` (a duplicate reply — including synchronous re-entry —
 * classifies `invalid`); only a provably-ineffective dispatch `release`s back to `priorState`,
 * everything else `commit`s to a tombstone. That yields the r2 core invariant: per requestId
 * at most ONE possibly-effective dispatch, with no dependence on persistence at all.
 *
 * Pi-free by construction (source-scan gate: `src/fabric/xs/**` must not import pi).
 */

/** §3.4: total in-process ticket slots. Full ⇒ refuse to issue (after one sweep), never evict. */
export const XS_REPLY_LEDGER_CAP = 64;
/** §3.3: session-entry customType carrying issue/settle records (restart notification only). */
export const XS_REPLY_ENTRY_TYPE = "subagent:xs-reply";
/** §3.4: `droppedNotices` per-session counter map cap (FIFO over sessions). */
export const XS_REPLY_DROPPED_SESSIONS_CAP = 32;
/** Status counters (rejected classify verdicts) share the same per-session FIFO cap. */
export const XS_REPLY_REJECTED_SESSIONS_CAP = 32;
/** One restart-invalidation scan per (process, session); bounded memory for the marker set. */
export const XS_REPLY_RESTART_SCANNED_CAP = 256;
/** §3.3: the restart-invalidation notice lists at most 16 requests, the rest as 「另有 N 条」. */
export const XS_REPLY_RESTART_NOTICE_MAX = 16;
/** Defensive mirrors of RX0's parse-time bounds (FABRIC_XS_REPLY_*_S × 1000). */
export const XS_REPLY_TIMEOUT_MS_MIN = 60_000;
export const XS_REPLY_TIMEOUT_MS_MAX = 86_400_000;
export const XS_REPLY_LATE_GRACE_MS_MIN = 0;
export const XS_REPLY_LATE_GRACE_MS_MAX = 3_600_000;

export type XsReplyState =
  | "pending" // receivable (on time)
  | "consuming" // reserved; a dispatch is in flight (transient inside ONE sync block, §6.3)
  | "timed_out" // receivable (late, now < lateUntil); timeout notice sent or owed
  | "replied" // consumed (tombstone)
  | "late_replied" // consumed (tombstone)
  | "send_failed"; // send proven not delivered

/** §3.3 terminal states a `settle` entry may record (also silences future restart scans). */
export type XsReplySettleState = "replied" | "late_replied" | "send_failed" | "invalidated";

/** §3.1: the reply ticket. `requestId` correlates; it is NOT a secret (§3.2/RR10). */
export interface XsReplyTicket {
  requestId: string; // "q" + 18 hex
  requesterSessionId: string;
  /** Full sessionId — also the send's pinned address (§4.2); `/reload`/restore on B keeps it valid. */
  replierSessionId: string;
  replierRef: string;
  replierName?: string;
  origin: "model" | "human";
  /** Fixed at issue: model ⇒ true, human ⇒ false (R4). Never re-derived later. */
  wakeOnReply: boolean;
  /** The causal level the reply/timeout returns the requester's root to (R3: no +1). */
  requesterLevel: number;
  issuedAt: number;
  dueAt: number;
  lateUntil: number; // dueAt + lateGraceMs
  state: XsReplyState;
  /** Only set while consuming; `release` restores it (§6.3). */
  priorState?: "pending" | "timed_out";
  sendEffect?: "applied" | "none" | "unknown";
  /** The reply xid that consumed this ticket. */
  consumedBy?: string;
  /** The timeout notice has not passed NoticeGate admission yet (§7.2). */
  noticeOwed?: "timeout";
  /** The timeout notice already passed NoticeGate (clearOwed) — a later release must not re-owe it. */
  noticeSent?: boolean;
}

export interface XsReplyIssueInput {
  requesterSessionId: string;
  replierSessionId: string;
  replierRef: string;
  replierName?: string;
  origin: "model" | "human";
  wakeOnReply: boolean;
  requesterLevel: number;
  /** Clamped into [60s, 24h] (RX0 bounds, defensive — the sender/hub already validate). */
  timeoutMs: number;
  /** Clamped into [0, 3600s] (RX0 bounds). */
  lateGraceMs: number;
  /** §3.4 quota: receivable-or-consuming tickets + replyInbox occupancy ≤ maxPending. */
  maxPending: number;
  /** §3.4 quota: receivable-and-consuming tickets towards ONE replier ≤ maxPendingPerTarget. */
  maxPendingPerTarget: number;
}

export type XsReplyIssueResult =
  { ok: true; ticket: XsReplyTicket } | { ok: false; code: "reply_quota" | "reply_ledger_full"; perTarget?: boolean };

/** §6.2 stage-3b classification. `unsolicited` = no `inReplyTo` at all (original path decides). */
export type XsReplyClassify =
  | { kind: "unsolicited" }
  | { kind: "reply"; ticket: XsReplyTicket } // valid, on time
  | { kind: "late"; ticket: XsReplyTicket } // valid, inside the late grace window
  | { kind: "invalid"; reason: "unknown_id" | "not_requester" | "wrong_replier" | "state" };

export type XsReplyReserveResult = { ok: true } | { ok: false; reason: "missing" | "state" | "inbox_full" };

export interface XsReplySweepResult {
  /** requestIds transitioned pending → timed_out by this sweep (each now owes a timeout notice). */
  timedOut: string[];
  /** Entries removed (tombstones past lateUntil, send_failed, timed_out past lateUntil). */
  deleted: number;
  /** Deleted entries whose timeout notice was still owed (droppedNotices counters bumped). */
  dropped: number;
}

/**
 * §6.3/§6.4: the per-stack replyInbox adapter the ledger drives. Reservations are held OUTSIDE
 * the XsInbox (a reserved slot is not an entry yet), so the quota formula never double-counts a
 * consuming ticket: `receivable-or-consuming tickets + inbox.occupied() ≤ maxPending` while
 * `free()` separately subtracts live reservations. `createXsReplyInboxPort` is the canonical
 * implementation over the unchanged `XsInbox` class.
 */
export interface XsReplyInboxPort {
  /** Unreleased accepted entries (the quota formula's inbox term; reservations excluded). */
  occupied(): number;
  /** Slots free right now — reservations included; reserve refuses at 0 (§6.4, theoretically impossible). */
  free(): number;
  /** Hold one slot for `xid` (reserve). */
  preoccupy(xid: string): void;
  /** Promote the reservation to a real accepted entry (commit); false = anomaly (still counted). */
  settle(xid: string, mode: XsInboxMode): boolean;
  /** Drop the reservation without accepting (release). */
  unoccupy(xid: string): void;
}

/** Canonical `XsReplyInboxPort` over the unchanged per-stack `XsInbox(reply.maxPending)`. */
export function createXsReplyInboxPort(inbox: XsInbox): XsReplyInboxPort {
  let reserved = 0;
  return {
    occupied: () => inbox.occupied,
    free: () => inbox.cap - inbox.occupied - reserved,
    preoccupy: () => {
      reserved += 1;
    },
    settle: (xid: string, mode: XsInboxMode): boolean => {
      reserved = Math.max(0, reserved - 1);
      return inbox.accept(xid, mode);
    },
    unoccupy: () => {
      reserved = Math.max(0, reserved - 1);
    },
  };
}

// ----------------------------------------------------------------- session entries (§3.3)

/** Issue record — appended best-effort right after the in-memory issue; restart-scan input. */
export interface XsReplyIssueEntry {
  v: 1;
  op: "issue";
  requestId: string;
  requesterSessionId: string;
  replierRef: string;
  dueAt: number;
  lateUntil: number;
}

/** Settle record — terminal state marker; silences future restart scans for that request. */
export interface XsReplySettleEntry {
  v: 1;
  op: "settle";
  requestId: string;
  requesterSessionId: string;
  state: XsReplySettleState;
}

export type XsReplyEntryRecord = XsReplyIssueEntry | XsReplySettleEntry;

export function buildReplyIssueEntry(ticket: XsReplyTicket): XsReplyIssueEntry {
  return {
    v: 1,
    op: "issue",
    requestId: ticket.requestId,
    requesterSessionId: ticket.requesterSessionId,
    replierRef: ticket.replierRef,
    dueAt: ticket.dueAt,
    lateUntil: ticket.lateUntil,
  };
}

export function buildReplySettleEntry(
  requestId: string,
  requesterSessionId: string,
  state: XsReplySettleState,
): XsReplySettleEntry {
  return { v: 1, op: "settle", requestId, requesterSessionId, state };
}

/**
 * Tolerant read-back (RXW feeds `getBranch()` raw entries). Fork/copy protection (P10): a
 * record whose `requesterSessionId` differs from the CURRENT session is ignored. Malformed
 * shapes return undefined — never throw, never resurrect anything.
 */
export function parseXsReplyEntry(raw: unknown, currentSessionId: string): XsReplyEntryRecord | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) return undefined;
  const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
  const requester = typeof value.requesterSessionId === "string" ? value.requesterSessionId : undefined;
  if (requestId === undefined || !XS_REPLY_REQUEST_ID_RE.test(requestId)) return undefined;
  if (requester === undefined || requester !== currentSessionId) return undefined;
  if (value.op === "issue") {
    if (typeof value.replierRef !== "string" || value.replierRef.length === 0) return undefined;
    if (typeof value.dueAt !== "number" || !Number.isFinite(value.dueAt)) return undefined;
    if (typeof value.lateUntil !== "number" || !Number.isFinite(value.lateUntil)) return undefined;
    return {
      v: 1,
      op: "issue",
      requestId,
      requesterSessionId: requester,
      replierRef: value.replierRef,
      dueAt: value.dueAt,
      lateUntil: value.lateUntil,
    };
  }
  if (value.op === "settle") {
    const state = value.state;
    if (state !== "replied" && state !== "late_replied" && state !== "send_failed" && state !== "invalidated") {
      return undefined;
    }
    return { v: 1, op: "settle", requestId, requesterSessionId: requester, state };
  }
  return undefined;
}

// ----------------------------------------------------------------- restart invalidation (§3.3)

export interface XsReplyRestartPlan {
  /** Unsettled, ledger-absent, not-yet-expired requests, in entry order (≤ …max listed). */
  invalid: { requestId: string; replierRef: string; dueAt: number }[];
  /** How many more matched beyond the listing cap (「另有 N 条」). */
  more: number;
  /** `settle{invalidated}` entries for EVERY matched request (listed, overflow and expired
   *  alike) — appending them best-effort prevents repeat notifications on later restarts. */
  settles: XsReplySettleEntry[];
}

/**
 * The post-restart scan (§3.3): from this session's issue/settle records, find requests that
 * were still open when the previous process died — no terminal settle, absent from the live
 * (empty-after-restart) ledger, and `lateUntil` not yet passed (expired ones get a settle so
 * they never reappear). PURE: it reads, never mutates the ledger, never resurrects a ticket.
 */
export function planReplyRestartInvalidation(
  records: readonly XsReplyEntryRecord[],
  ledger: XsReplyLedger,
  now: number,
  max = XS_REPLY_RESTART_NOTICE_MAX,
): XsReplyRestartPlan {
  const settled = new Set<string>();
  const issues: {
    requestId: string;
    requesterSessionId: string;
    replierRef: string;
    dueAt: number;
    lateUntil: number;
  }[] = [];
  for (const record of records) {
    if (record.op === "settle") settled.add(record.requestId);
    else
      issues.push({
        requestId: record.requestId,
        requesterSessionId: record.requesterSessionId,
        replierRef: record.replierRef,
        dueAt: record.dueAt,
        lateUntil: record.lateUntil,
      });
  }
  const invalid: XsReplyRestartPlan["invalid"] = [];
  const settles: XsReplySettleEntry[] = [];
  for (const issue of issues) {
    if (settled.has(issue.requestId)) continue;
    if (ledger.get(issue.requestId) !== undefined) continue; // live in THIS process — untouched
    settles.push(buildReplySettleEntry(issue.requestId, issue.requesterSessionId, "invalidated"));
    if (issue.lateUntil > now)
      invalid.push({ requestId: issue.requestId, replierRef: issue.replierRef, dueAt: issue.dueAt });
  }
  return { invalid: invalid.slice(0, max), more: Math.max(0, invalid.length - max), settles };
}

// ----------------------------------------------------------------- per-stack binding

/** What a live stack attaches for its session (RXW binds at build, unbinds at dispose). */
export interface XsReplySessionBinding {
  sessionId: string;
  /** §6.4 replyInbox adapter; absent ⇒ issuance quota treats inbox occupancy as 0 and reserve
   *  fails closed (`inbox_full` — a receiver always binds before classifying replies). */
  inbox?: XsReplyInboxPort;
  /** Best-effort `appendEntry(issue)` (§3.3) — failures only affect the restart notice. */
  appendIssue?: (entry: XsReplyIssueEntry) => void;
  /** Best-effort `appendEntry(settle)` on terminal states. */
  appendSettle?: (entry: XsReplySettleEntry) => void;
}

// ----------------------------------------------------------------- ledger

export interface XsReplyLedgerOptions {
  capacity?: number;
  clock?: Clock;
  /** Injectable id source (tests); default `"q" + randomBytes(9).hex`. */
  newRequestId?: () => string;
}

export interface XsReplyLedgerStats {
  /** Receivable (pending + timed_out) plus consuming tickets — the `a` of `a/maxPending`. */
  pending: number;
  /** Bound replyInbox occupancy (0 when no stack is bound). */
  inbox: number;
  timedOut: number;
  /** Consumed-late tombstones still retained (before lateUntil). */
  late: number;
  /** Invalid classify verdicts counted for this session (FIFO-capped diagnostics). */
  rejected: number;
  /** Timeout notices still owed (not yet through NoticeGate). */
  owed: number;
  /** Notices dropped at lateUntil without ever passing admission. */
  dropped: number;
  /** Whole-process slot usage `size/capacity`. */
  ledger: { size: number; capacity: number };
  /** §6.4 reserve-time inbox anomalies (theoretically impossible; surfaced for /fabric status). */
  replyInboxAnomaly: number;
}

/** One `/fabric replies` row (§8.3). */
export interface XsReplyViewRow {
  requestId: string;
  replierRef: string;
  state: XsReplyState;
  /** Seconds until dueAt (receivable) or since (terminal); rounded up. */
  remainingS: number;
  owed: boolean;
}

function clampTimeout(ms: number): number {
  return Math.min(XS_REPLY_TIMEOUT_MS_MAX, Math.max(XS_REPLY_TIMEOUT_MS_MIN, Math.floor(ms)));
}

function clampLateGrace(ms: number): number {
  return Math.min(XS_REPLY_LATE_GRACE_MS_MAX, Math.max(XS_REPLY_LATE_GRACE_MS_MIN, Math.floor(ms)));
}

type MutableTicket = Omit<XsReplyTicket, "priorState" | "sendEffect" | "consumedBy" | "noticeOwed"> & {
  priorState?: "pending" | "timed_out";
  sendEffect?: "applied" | "none" | "unknown";
  consumedBy?: string;
  noticeOwed?: "timeout";
};

/** States that occupy the per-session / per-target quota (§3.4: receivable or consuming). */
const QUOTA_STATES: readonly XsReplyState[] = ["pending", "consuming", "timed_out"];

export class XsReplyLedger {
  private readonly tickets = new Map<string, MutableTicket>();
  private readonly sessions = new Map<string, XsReplySessionBinding>();
  private readonly droppedNotices = new Map<string, number>();
  private readonly rejectedCounts = new Map<string, number>();
  private readonly restartScanned = new Set<string>();
  private anomalies = 0;
  private readonly capacity: number;
  private readonly clock: Clock;
  private readonly newRequestId: () => string;

  constructor(options: XsReplyLedgerOptions = {}) {
    this.capacity = options.capacity ?? XS_REPLY_LEDGER_CAP;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) throw new RangeError("invalid xs reply ledger capacity");
    this.clock = options.clock ?? systemClock;
    this.newRequestId = options.newRequestId ?? defaultRequestId;
  }

  get size(): number {
    return this.tickets.size;
  }

  get ledgerCapacity(): number {
    return this.capacity;
  }

  /** Snapshots are copies — mutating one never touches authorization state. */
  get(requestId: string): XsReplyTicket | undefined {
    const ticket = this.tickets.get(requestId);
    return ticket === undefined ? undefined : { ...ticket };
  }

  entries(): readonly XsReplyTicket[] {
    return [...this.tickets.values()].map((ticket) => ({ ...ticket }));
  }

  // ------------------------------------------------------------------ stack binding

  bindSession(binding: XsReplySessionBinding): void {
    this.sessions.set(binding.sessionId, binding);
  }

  unbindSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  sessionBound(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // ------------------------------------------------------------------ sweep (§3.4 — process-wide, lazy)

  /**
   * Time-passage normalization over EVERY session's tickets (a switched-away session's scheduler
   * is dead; issue/classify/restore/status/the live scheduler all funnel through here). Also the
   * ONLY place entries are deleted: `timed_out`/tombstones past `lateUntil` (an owed-but-unsent
   * notice on a deleted entry bumps that session's `droppedNotices` counter), `send_failed`
   * immediately. `consuming` tickets are never touched — a dispatch block is in flight and
   * commit/release performs its own time normalization.
   */
  sweep(now: number = this.clock.now()): XsReplySweepResult {
    const result: XsReplySweepResult = { timedOut: [], deleted: 0, dropped: 0 };
    for (const [requestId, ticket] of this.tickets) {
      if (ticket.state === "pending" && now >= ticket.dueAt) {
        ticket.state = "timed_out";
        ticket.noticeOwed ??= "timeout";
        result.timedOut.push(requestId);
        // NO continue: a due already past lateUntil must expire in THIS pass too.
      }
      const expirable = ticket.state === "timed_out" || ticket.state === "replied" || ticket.state === "late_replied";
      if ((expirable && now >= ticket.lateUntil) || ticket.state === "send_failed") {
        if (ticket.noticeOwed === "timeout") {
          this.bumpSessionCounter(this.droppedNotices, ticket.requesterSessionId, XS_REPLY_DROPPED_SESSIONS_CAP);
          result.dropped += 1;
        }
        this.tickets.delete(requestId);
        result.deleted += 1;
      }
    }
    return result;
  }

  // ------------------------------------------------------------------ issuance (§4.2)

  /**
   * Quota check + synchronous in-memory issue. Sweeps first (a full ledger must get one chance
   * to self-heal before refusing). On success the issue record goes to the bound sink
   * best-effort — a throwing/absent sink NEVER affects receivability (§3.3).
   */
  issue(input: XsReplyIssueInput): XsReplyIssueResult {
    const now = this.clock.now();
    this.sweep(now);
    const quota = this.quotaUsage(input.requesterSessionId, input.replierSessionId);
    const inboxOccupied = this.sessions.get(input.requesterSessionId)?.inbox?.occupied() ?? 0;
    if (quota.perTarget >= input.maxPendingPerTarget) return { ok: false, code: "reply_quota", perTarget: true };
    if (quota.session + inboxOccupied >= input.maxPending) return { ok: false, code: "reply_quota" };
    if (this.tickets.size >= this.capacity) return { ok: false, code: "reply_ledger_full" };
    const requestId = this.freshRequestId();
    const ticket: MutableTicket = {
      requestId,
      requesterSessionId: input.requesterSessionId,
      replierSessionId: input.replierSessionId,
      replierRef: input.replierRef,
      ...(input.replierName !== undefined ? { replierName: input.replierName } : {}),
      origin: input.origin,
      wakeOnReply: input.wakeOnReply,
      requesterLevel: input.requesterLevel,
      issuedAt: now,
      dueAt: now + clampTimeout(input.timeoutMs),
      lateUntil: now + clampTimeout(input.timeoutMs) + clampLateGrace(input.lateGraceMs),
      state: "pending",
    };
    this.tickets.set(requestId, ticket);
    this.emitIssue(this.sessions.get(input.requesterSessionId), ticket);
    return { ok: true, ticket: { ...ticket } };
  }

  /**
   * §4.2 step 6: `none` ⇒ `send_failed` (immediately sweep-deletable, settle recorded);
   * `applied`/`unknown` ⇒ stays pending. A post-send origin-guard failure maps to `unknown`
   * upstream (r3 M2) and keeps the ticket pending here.
   */
  recordSend(requestId: string, effect: "applied" | "none" | "unknown"): void {
    const ticket = this.tickets.get(requestId);
    if (ticket === undefined) return;
    ticket.sendEffect = effect;
    if (effect !== "none") return;
    if (ticket.state !== "pending" && ticket.state !== "timed_out") return;
    ticket.state = "send_failed";
    this.emitSettle(requestId, ticket.requesterSessionId, "send_failed");
  }

  // ------------------------------------------------------------------ classification (§6.2 stage 3b)

  /**
   * `classify` sweeps first (its verdict must reflect current time). Unforgeability (§3.2):
   * ticket exists ∧ requester is THIS stack ∧ the hub-stamped `from.sessionId` matches the
   * bound replier ∧ state receivable. Anything else is `invalid` — including every
   * restarted-process lookup (empty ledger ⇒ unknown_id ⇒ fail closed).
   */
  classify(
    inReplyTo: string | undefined,
    fromSessionId: string | undefined,
    requesterSessionId: string,
    now: number = this.clock.now(),
  ): XsReplyClassify {
    if (inReplyTo === undefined) return { kind: "unsolicited" };
    this.sweep(now);
    const ticket = this.tickets.get(inReplyTo);
    if (ticket === undefined) return this.invalid(requesterSessionId, "unknown_id");
    if (ticket.requesterSessionId !== requesterSessionId) return this.invalid(requesterSessionId, "not_requester");
    if (fromSessionId === undefined || fromSessionId !== ticket.replierSessionId) {
      return this.invalid(requesterSessionId, "wrong_replier");
    }
    if (ticket.state === "pending" && now < ticket.dueAt) return { kind: "reply", ticket: { ...ticket } };
    if (ticket.state === "timed_out" && now < ticket.lateUntil) return { kind: "late", ticket: { ...ticket } };
    return this.invalid(requesterSessionId, "state");
  }

  // ------------------------------------------------------------------ consumption (§6.3)

  /**
   * Reserve BEFORE any re-entrant host call: `consuming` + `priorState`, one replyInbox slot
   * pre-occupied. Synchronous re-entry with the same requestId classifies `invalid` (state).
   * Fails closed (`inbox_full`, anomaly counted, ticket untouched) when the bound inbox has no
   * free slot — the §6.4 issuance invariant makes that theoretically impossible.
   */
  reserve(requestId: string, xid: string, now: number = this.clock.now()): XsReplyReserveResult {
    const ticket = this.tickets.get(requestId);
    if (ticket === undefined) return { ok: false, reason: "missing" };
    if (ticket.state !== "pending" && ticket.state !== "timed_out") return { ok: false, reason: "state" };
    if (ticket.state === "timed_out" && now >= ticket.lateUntil) return { ok: false, reason: "state" };
    const inbox = this.sessions.get(ticket.requesterSessionId)?.inbox;
    if (inbox === undefined || inbox.free() < 1) {
      this.anomalies += 1;
      return { ok: false, reason: "inbox_full" };
    }
    inbox.preoccupy(xid);
    ticket.priorState = ticket.state;
    ticket.state = "consuming";
    ticket.consumedBy = xid;
    return { ok: true };
  }

  /**
   * The dispatch may have taken effect ⇒ tombstone (ALWAYS — the return value never undoes
   * it; `false` only reports the §6.4 inbox anomaly). `late_replied` iff the ticket had
   * already timed out at reserve time (the ack carries `reply_late`, §6.2 stage 7). Consuming
   * a ticket clears its owed timeout notice — the reply supersedes it. The reservation
   * becomes a real accepted inbox entry (`trigger` for the Controller path,
   * `appended`/`queued` deliver-only).
   */
  commit(requestId: string, mode: XsInboxMode): boolean {
    const ticket = this.tickets.get(requestId);
    if (ticket === undefined || ticket.state !== "consuming") return false;
    const late = ticket.priorState === "timed_out";
    ticket.state = late ? "late_replied" : "replied";
    delete ticket.priorState;
    delete ticket.noticeOwed;
    const xid = ticket.consumedBy; // retained on the tombstone for /fabric replies
    const inbox = this.sessions.get(ticket.requesterSessionId)?.inbox;
    let accepted = true;
    if (inbox !== undefined && xid !== undefined) {
      accepted = inbox.settle(xid, mode);
      if (!accepted) this.anomalies += 1;
    }
    this.emitSettle(requestId, ticket.requesterSessionId, late ? "late_replied" : "replied");
    return accepted;
  }

  /**
   * The dispatch was PROVABLY ineffective (Controller `none`, synchronous host rejection,
   * fenced second guard, receiver error before dispatch) ⇒ restore `priorState`, free the
   * reservation; the ticket stays receivable and B may resend. Time normalization applies
   * immediately (a release past dueAt lands as `timed_out` + owed notice, past lateUntil the
   * ticket is deleted — exactly what the next sweep would have done).
   */
  release(requestId: string, now: number = this.clock.now()): void {
    const ticket = this.tickets.get(requestId);
    if (ticket === undefined || ticket.state !== "consuming") return;
    const xid = ticket.consumedBy;
    delete ticket.consumedBy;
    const prior = ticket.priorState ?? "pending";
    delete ticket.priorState;
    if (xid !== undefined) this.sessions.get(ticket.requesterSessionId)?.inbox?.unoccupy(xid);
    if (prior === "timed_out" || now >= ticket.dueAt) {
      // The request HAS timed out by now — it owes a timeout notice unless one was sent.
      if (ticket.noticeSent !== true) ticket.noticeOwed ??= "timeout";
      if (now >= ticket.lateUntil) {
        // …and the grace window is gone: the owed notice can never be delivered (§3.4).
        if (ticket.noticeSent !== true) {
          this.bumpSessionCounter(this.droppedNotices, ticket.requesterSessionId, XS_REPLY_DROPPED_SESSIONS_CAP);
        }
        this.tickets.delete(requestId);
        return;
      }
      ticket.state = "timed_out";
      return;
    }
    ticket.state = "pending";
  }

  // ------------------------------------------------------------------ notice bookkeeping (§7.2)

  /** Owed timeout notices for a session — consuming tickets excluded (commit/release resolves them). */
  owedNotices(sessionId: string): readonly XsReplyTicket[] {
    return [...this.tickets.values()]
      .filter(
        (ticket) =>
          ticket.requesterSessionId === sessionId && ticket.noticeOwed === "timeout" && ticket.state !== "consuming",
      )
      .map((ticket) => ({ ...ticket }));
  }

  /** After a notice write (§7.2 step 6) — verify result notwithstanding (NQ3: never resend). */
  clearOwed(requestIds: readonly string[]): number {
    let cleared = 0;
    for (const requestId of requestIds) {
      const ticket = this.tickets.get(requestId);
      if (ticket?.noticeOwed === "timeout") {
        delete ticket.noticeOwed;
        ticket.noticeSent = true;
        cleared += 1;
      }
    }
    return cleared;
  }

  droppedNoticeCount(sessionId: string): number {
    return this.droppedNotices.get(sessionId) ?? 0;
  }

  /** Read-and-reset (§3.4 switch-back summary consumes the counter). */
  takeDroppedNotices(sessionId: string): number {
    const count = this.droppedNotices.get(sessionId) ?? 0;
    this.droppedNotices.delete(sessionId);
    return count;
  }

  // ------------------------------------------------------------------ restart scan marker (§3.3)

  /** True exactly once per (process, session): the first stack build must run the restart scan. */
  markRestartScanned(sessionId: string): boolean {
    if (this.restartScanned.has(sessionId)) return false;
    if (this.restartScanned.size >= XS_REPLY_RESTART_SCANNED_CAP) {
      const oldest = this.restartScanned.values().next().value;
      if (oldest !== undefined) this.restartScanned.delete(oldest);
    }
    this.restartScanned.add(sessionId);
    return true;
  }

  // ------------------------------------------------------------------ visibility (§8.3)

  stats(sessionId: string, now: number = this.clock.now()): XsReplyLedgerStats {
    this.sweep(now);
    let pending = 0;
    let timedOut = 0;
    let late = 0;
    let owed = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.requesterSessionId !== sessionId) continue;
      if (ticket.state === "pending" || ticket.state === "consuming") pending += 1;
      else if (ticket.state === "timed_out") {
        timedOut += 1;
        pending += 1;
      } else if (ticket.state === "late_replied") late += 1;
      if (ticket.noticeOwed === "timeout" && ticket.state !== "consuming") owed += 1;
    }
    return {
      pending,
      inbox: this.sessions.get(sessionId)?.inbox?.occupied() ?? 0,
      timedOut,
      late,
      rejected: this.rejectedCounts.get(sessionId) ?? 0,
      owed,
      dropped: this.droppedNotices.get(sessionId) ?? 0,
      ledger: { size: this.tickets.size, capacity: this.capacity },
      replyInboxAnomaly: this.anomalies,
    };
  }

  /** `/fabric replies` rows: receivable + still-retained terminal tickets of this session. */
  repliesView(sessionId: string, now: number = this.clock.now()): readonly XsReplyViewRow[] {
    this.sweep(now);
    const rows: XsReplyViewRow[] = [];
    for (const ticket of this.tickets.values()) {
      if (ticket.requesterSessionId !== sessionId) continue;
      rows.push({
        requestId: ticket.requestId,
        replierRef: ticket.replierRef,
        state: ticket.state,
        remainingS: Math.ceil((ticket.dueAt - now) / 1000),
        owed: ticket.noticeOwed === "timeout",
      });
    }
    return rows;
  }

  get replyInboxAnomaly(): number {
    return this.anomalies;
  }

  // ------------------------------------------------------------------ internals

  private quotaUsage(sessionId: string, replierSessionId: string): { session: number; perTarget: number } {
    let session = 0;
    let perTarget = 0;
    for (const ticket of this.tickets.values()) {
      if (!QUOTA_STATES.includes(ticket.state)) continue;
      if (ticket.requesterSessionId === sessionId) session += 1;
      if (ticket.requesterSessionId === sessionId && ticket.replierSessionId === replierSessionId) perTarget += 1;
    }
    return { session, perTarget };
  }

  private invalid(
    requesterSessionId: string,
    reason: "unknown_id" | "not_requester" | "wrong_replier" | "state",
  ): XsReplyClassify {
    this.bumpSessionCounter(this.rejectedCounts, requesterSessionId, XS_REPLY_REJECTED_SESSIONS_CAP);
    return { kind: "invalid", reason };
  }

  private bumpSessionCounter(map: Map<string, number>, sessionId: string, cap: number): void {
    map.set(sessionId, (map.get(sessionId) ?? 0) + 1);
    if (map.size > cap) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  private freshRequestId(): string {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = this.newRequestId();
      if (XS_REPLY_REQUEST_ID_RE.test(id) && !this.tickets.has(id)) return id;
    }
    throw new Error("unable to generate a unique xs reply request id after 10 attempts");
  }

  private emitIssue(binding: XsReplySessionBinding | undefined, ticket: MutableTicket): void {
    if (binding?.appendIssue === undefined) return;
    try {
      binding.appendIssue(buildReplyIssueEntry({ ...ticket }));
    } catch {
      // §3.3: persistence failure only affects the post-restart notice. Never receivability.
    }
  }

  private emitSettle(requestId: string, requesterSessionId: string, state: XsReplySettleState): void {
    const binding = this.sessions.get(requesterSessionId);
    if (binding?.appendSettle === undefined) return;
    try {
      binding.appendSettle(buildReplySettleEntry(requestId, requesterSessionId, state));
    } catch {
      /* best-effort, same §3.3 posture */
    }
  }
}

/** `"q" + 18 hex` (§3.1) — correlated openly, never a secret. */
function defaultRequestId(): string {
  return `q${randomBytes(9).toString("hex")}`;
}

const LEDGER_KEY = Symbol.for("pi-subagent:xs-reply-ledger");

/**
 * Process accessor. No reset in production: this same object must survive jiti reloads /
 * session stack replacement (wake-ledger precedent). A restarted process simply starts empty —
 * which is the r2 fail-closed promise itself (RR3), not a bug.
 */
export function getXsReplyLedger(): XsReplyLedger {
  const global = globalThis as Record<symbol, XsReplyLedger | undefined>;
  return (global[LEDGER_KEY] ??= new XsReplyLedger());
}

// ----------------------------------------------------------------- due scheduler (§7.2)

export interface XsReplyDueSchedulerDeps {
  ledger: XsReplyLedger;
  /** The stack's own session — only ITS earliest dueAt arms the one timer. */
  sessionId: string;
  /** Fired at due: the ledger has been swept (pending → timed_out + noticeOwed) FIRST. */
  onDue(): void;
  clock?: Clock;
}

/**
 * Per-stack, exactly ONE timer for this session's earliest pending `dueAt` (§7.2 trigger).
 * Non-current sessions rely on the lazy process-wide sweep. All timers ride the injected Clock
 * (systemClock is segmented + unref'd; a ref'd timer would wedge `pi -p`). Absolute-due arming:
 * `refresh` recomputes the delay from a fresh `now`, so repeated calls never postpone a due.
 */
export class XsReplyDueScheduler {
  private readonly deps: XsReplyDueSchedulerDeps;
  private readonly clock: Clock;
  private handle: ReturnType<Clock["setTimer"]> | undefined;
  private armedDue: number | undefined;
  private disposed = false;

  constructor(deps: XsReplyDueSchedulerDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? systemClock;
  }

  /** (Re-)arm for the earliest pending dueAt; clears the timer when nothing is pending. */
  refresh(): void {
    if (this.disposed) return;
    const earliest = this.nextDueAt();
    if (earliest === undefined) {
      this.clear();
      return;
    }
    if (this.armedDue !== undefined && this.armedDue <= earliest) return; // a closer due is already armed
    this.clear();
    this.armedDue = earliest;
    this.handle = this.clock.setTimer(Math.max(0, earliest - this.clock.now()), () => {
      this.handle = undefined;
      this.armedDue = undefined;
      try {
        this.deps.ledger.sweep(); // pending → timed_out + noticeOwed (§7.2)
        this.deps.onDue(); // gate.flush() — admission + write, or keep owed
      } finally {
        this.refresh(); // next earliest, if any
      }
    });
  }

  nextDueAt(): number | undefined {
    let earliest: number | undefined;
    for (const ticket of this.deps.ledger.entries()) {
      if (ticket.requesterSessionId !== this.deps.sessionId || ticket.state !== "pending") continue;
      if (earliest === undefined || ticket.dueAt < earliest) earliest = ticket.dueAt;
    }
    return earliest;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private clear(): void {
    if (this.handle !== undefined) {
      try {
        this.clock.clearTimer(this.handle);
      } catch {
        /* best-effort */
      }
      this.handle = undefined;
    }
    this.armedDue = undefined;
  }
}
