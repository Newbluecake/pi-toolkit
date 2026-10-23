/**
 * Durable Feishu outbox (bot plan §6.2 + R1 #12 + §5.8, package F7) over `state.ts`'s `outbox` store.
 *
 * What it guarantees (pinned by `tests/web-hub/hub/feishu/outbox.test.ts`):
 * - **Intent before effect.** `enqueueFinal`/`enqueueNotice` persist the whole group synchronously in memory and
 *   resolve only after `state.commit()`; a part is never sent before its `queued` record is durable.
 * - **One logical send ⇒ one Feishu `uuid`.** `sendId = "fo" + b64url(sha256(requestId|part|variant))[0:40]` is
 *   deterministic and reused on EVERY retry and after a crash, so the platform's uuid dedup (≈1 h) turns
 *   at-least-once delivery into exactly-once-ish. Because that window is finite, a part that ever had an
 *   *unknown-effect* attempt is retried only inside {@link FeishuOutboxPolicy.uuidSafeWindowMs} of its creation;
 *   after that it is failed `expired-uncertain` ("may have been delivered") instead of risking a duplicate.
 * - **Never widen a target.** The target is a closed typed union; a topic reply is persisted as
 *   `reply`+`reply_in_thread:true` and sent exactly as stored — there is NO code path from a reply to a `send`,
 *   and `send` to a group chat does not exist at all. A deleted/withdrawn target fails `target-gone`.
 * - **Finals are never silently dropped.** At the cap/budget `enqueueFinal` refuses LOUDLY (`{ok:false}` ⇒ the
 *   caller marks the request `reply-failed`); a queued final only leaves the queue as `sent` or as an explicit
 *   `failed(<code>)` reported through `onSettled` (expiry included).
 * - **Bounded.** ≤3 tries per cycle (frozen `maxRetries`), 30 s task budget per cycle, per-lane ≥250 ms gap,
 *   global ≤20 sends/s, ≤4 in flight; later cycles back off on a ladder until the max age (final 24 h, notice
 *   10 min). All timers go through the injected clock (unref'd by default).
 *
 * Pi-free; no module-scope mutable state; never throws.
 */

import { createHash, randomBytes } from "node:crypto";

import { FEISHU_OPEN_ID_RE, FEISHU_REPLY_LIMITS } from "../../protocol/feishu.js";
import type { FeishuApi, FeishuMsgType } from "./api.js";
import { FEISHU_SEND_MSG_TYPES } from "./api.js";
import { systemFeishuClock } from "./http.js";
import type { FeishuClock, FeishuFailure } from "./http.js";
import type { FeishuOutboxPart, FeishuState } from "./state.js";

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

export interface FeishuOutboxPolicy {
  /** extra tries after the first, per cycle (frozen `FEISHU_REPLY_LIMITS.maxRetries`) */
  maxRetries: number;
  /** a cycle stops retrying once it has been running this long */
  taskBudgetMs: number;
  /** waits between tries inside a cycle */
  inCycleBackoffMs: readonly number[];
  /** waits between cycles (the last value repeats) */
  cycleLadderMs: readonly number[];
  /** hard max age (⇒ `failed(expired)`) */
  finalMaxAgeMs: number;
  noticeMaxAgeMs: number;
  /** parts with an unknown-effect attempt are retried only while `now − createdAt` is below this (Feishu uuid dedup ≈ 1 h) */
  uuidSafeWindowMs: number;
  perLaneMinGapMs: number;
  globalPerSecond: number;
  maxInFlight: number;
  /** while paused (auth), probe one part this often */
  pauseProbeMs: number;
  /** re-invoke a failed `onSettled` handler after this */
  settleRetryMs: number;
}

export const FEISHU_OUTBOX_POLICY: FeishuOutboxPolicy = Object.freeze({
  maxRetries: FEISHU_REPLY_LIMITS.maxRetries,
  taskBudgetMs: FEISHU_REPLY_LIMITS.taskBudgetMs,
  inCycleBackoffMs: Object.freeze([1_000, 3_000]),
  cycleLadderMs: Object.freeze([30_000, 120_000, 600_000, 1_800_000, 3_600_000]),
  finalMaxAgeMs: 24 * 3_600_000,
  noticeMaxAgeMs: 10 * 60_000,
  uuidSafeWindowMs: 50 * 60_000,
  perLaneMinGapMs: FEISHU_REPLY_LIMITS.perChatMinGapMs,
  globalPerSecond: FEISHU_REPLY_LIMITS.globalPerSecond,
  maxInFlight: 4,
  pauseProbeMs: 60_000,
  settleRetryMs: 60_000,
});

/**
 * API codes that mean "the message/chat we reply to no longer exists or the bot is out of it": 230011 (message
 * withdrawn), 231003 (message not found), 230002 (bot not in chat). **Not verified against a live tenant** (the probe
 * never deleted a message) — hence injectable (`deps.targetGoneCodes`); real-tenant acceptance must confirm them.
 */
export const FEISHU_TARGET_GONE_CODES: readonly number[] = Object.freeze([230_011, 231_003, 230_002]);

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

/**
 * Where a message goes. Closed on purpose: `topic` is ONLY a threaded reply; a group chat can never be a `send`
 * target; only a p2p conversation may be addressed proactively.
 */
export type OutboxTarget =
  | { scope: "p2p"; via: "reply"; messageId: string }
  | { scope: "p2p"; via: "send"; receiveIdType: "open_id" | "chat_id"; receiveId: string }
  | { scope: "topic"; messageId: string }
  | { scope: "group-root"; messageId: string; inThread?: boolean };

export interface OutboxMessage {
  msgType: FeishuMsgType;
  /** serialized platform `content` (render.ts output, or `{"file_key":…}` for an uploaded attachment) */
  content: string;
}

export interface EnqueueFinalInput {
  /** the request (cmdId) this reply belongs to */
  requestId: string;
  target: OutboxTarget;
  /** ordered messages of ONE reply (`render.ts` parts, then an optional file message) */
  messages: readonly OutboxMessage[];
  /** a NEW logical send for the same request (e.g. a p2p proactive resend after `target-gone`) */
  variant?: string;
  /** rate-limit lane (e.g. chat_id); not persisted — after a restart the lane is the target id */
  laneKey?: string;
}

export interface EnqueueNoticeInput {
  target: OutboxTarget;
  message: OutboxMessage;
  /** dedup key: the same key (while its record exists) is the same notice */
  key?: string;
  /**
   * Durable origin marker (`xsm:<id>`, xs-mirror): persisted as the record's optional `requestId`
   * (already part of the strict outbox schema) so a restart can recognise the notice. Absent ⇒
   * byte-identical to the legacy notice.
   */
  tag?: string;
  laneKey?: string;
}

export type EnqueueRefusal =
  | "cap"
  | "budget"
  | "invalid-target"
  | "invalid-message"
  | "invalid-request"
  | "too-many-parts"
  | "unavailable"
  | "disposed";

export type EnqueueResult =
  | {
      ok: true;
      sendIds: string[];
      /** `state.commit()` succeeded before resolving */ durable: boolean;
      duplicate: boolean;
    }
  | { ok: false; refused: EnqueueRefusal };

/** Failure codes a part can settle with (`FeishuOutboxPart.code`, ≤64 chars). */
export const OUTBOX_FAIL_CODES = {
  targetGone: "target-gone",
  capabilityDenied: "capability-denied",
  expired: "expired",
  expiredUncertain: "expired-uncertain",
  rejectedPrefix: "rejected:",
  skippedPrefix: "skipped:",
  localPrefix: "local:",
} as const;

export interface SettledPart {
  part: number;
  sendId: string;
  state: "sent" | "failed";
  /** failure code (`target-gone`, `capability-denied`, `rejected:api-code-N`, `expired`, `expired-uncertain`, `skipped:<code>`, `local:<reason>`) */
  code?: string;
  /** in-process only (lost across a restart): ids returned by the platform */
  messageId?: string;
  threadId?: string;
  chatId?: string;
  /** in-process only: the content of a failed part, so the caller may re-enqueue it under a new `variant` */
  undelivered?: OutboxMessage;
}

export interface SettledGroup {
  kind: "final" | "notice";
  /** finals only (the id given to `enqueueFinal`) */
  requestId?: string;
  variant?: string;
  outcome: "delivered" | "failed" | "partial";
  /** first failure code */
  code?: string;
  /** a final that failed/partially failed is `reply-failed` for the request state machine */
  replyFailed: boolean;
  target: { route: "reply" | "send"; targetId: string; inThread?: boolean; receiveIdType?: "chat_id" | "open_id" };
  parts: SettledPart[];
  /** true when re-emitted by `start()` for a group that settled before a restart */
  recovered: boolean;
  /**
   * parts of the group whose settled record was already swept by the state's 1 h TTL while siblings were still
   * queued AND whose outcome is not remembered (only after a restart; in-process tombstones remember it). Such a
   * part was delivered or failed long ago and was never reported — failures are rare (a rejected part of a
   * continuing group), so treat it as "presumed sent".
   */
  swept?: number;
}

export type OutboxEvent =
  | { event: "sent"; kind: "final" | "notice"; msgType: FeishuMsgType; attempts: number }
  | { event: "retry"; kind: "final" | "notice"; reason: string; unknownEffect: boolean }
  | { event: "failed"; kind: "final" | "notice"; code: string }
  | { event: "refused"; kind: "final" | "notice"; refused: EnqueueRefusal }
  | { event: "paused"; reason: string }
  | { event: "resumed" }
  | { event: "capability-denied"; msgType: FeishuMsgType }
  | { event: "settle-error" };

export interface OutboxStats {
  queued: number;
  inFlight: number;
  sent: number;
  failed: number;
  lastCode?: string;
  paused?: string;
}

export interface FeishuOutboxDeps {
  state: Pick<FeishuState, "outbox" | "commit">;
  api: Pick<FeishuApi, "send" | "reply">;
  clock?: FeishuClock;
  random?: (bytes: number) => Uint8Array;
  /**
   * A group reached its terminal state. If the returned promise RESOLVES, the outbox deletes the group's records
   * (so the handler must have made its own consequence — e.g. the request's `reply-failed` transition — durable
   * first); if it throws/rejects it is invoked again after `policy.settleRetryMs`, and again on every `start()`.
   * Must be idempotent.
   */
  onSettled?: (group: SettledGroup) => void | Promise<void>;
  /** audit/health feed: no bodies, ids or content */
  onEvent?: (event: OutboxEvent) => void;
  targetGoneCodes?: readonly number[];
  policy?: Partial<FeishuOutboxPolicy>;
}

export interface FeishuOutbox {
  /** Load queued parts from the store, re-emit settled groups, begin sending. Idempotent. */
  start(): void;
  enqueueFinal(input: EnqueueFinalInput): Promise<EnqueueResult>;
  enqueueNotice(input: EnqueueNoticeInput): Promise<EnqueueResult>;
  /** Clear a pause (credentials replaced / token healthy) and retry immediately. */
  resume(): void;
  stats(): OutboxStats;
  /**
   * Shutdown step 4: stop sending, wait ≤`drainMs` for in-flight calls, abort the rest (their effect is unknown ⇒
   * they stay `queued` with the same uuid). Unsent parts stay queued ON DISK. Enqueue still persists afterwards.
   */
  stop(drainMs?: number): Promise<{ drained: boolean; aborted: number }>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const VARIANT_RE = /^[A-Za-z0-9_-]{1,16}$/;
const NOTICE_KEY_RE = /^[\x21-\x7e]{1,100}$/;
const NOTICE_TAG_RE = /^xsm:[A-Za-z0-9_-]{1,60}$/;
const TARGET_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_MESSAGES = 8;
const CODE_BUDGET = 64;
const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

/** Deterministic Feishu `uuid` for one part (≤50 chars `[A-Za-z0-9_-]`). */
export function deriveSendId(seed: string, part: number): string {
  return `fo${createHash("sha256").update(`${seed}\n${part}`).digest("base64url").slice(0, 40)}`;
}

const clip = (s: string): string => (s.length > CODE_BUDGET ? s.slice(0, CODE_BUDGET) : s);

interface Mapped {
  route: "reply" | "send";
  targetId: string;
  inThread?: boolean;
  receiveIdType?: "chat_id" | "open_id";
}

const okId = (v: unknown): v is string => typeof v === "string" && TARGET_ID_RE.test(v);

function mapTarget(t: OutboxTarget): Mapped | undefined {
  if (typeof t !== "object" || t === null) return undefined;
  switch (t.scope) {
    case "p2p":
      if (t.via === "reply") return okId(t.messageId) ? { route: "reply", targetId: t.messageId } : undefined;
      if (t.via === "send") {
        if (t.receiveIdType === "open_id" && typeof t.receiveId === "string" && FEISHU_OPEN_ID_RE.test(t.receiveId))
          return { route: "send", targetId: t.receiveId, receiveIdType: "open_id" };
        if (t.receiveIdType === "chat_id" && okId(t.receiveId))
          return { route: "send", targetId: t.receiveId, receiveIdType: "chat_id" };
      }
      return undefined;
    case "topic":
      return okId(t.messageId) ? { route: "reply", targetId: t.messageId, inThread: true } : undefined;
    case "group-root":
      return okId(t.messageId) ? { route: "reply", targetId: t.messageId, inThread: t.inThread === true } : undefined;
    default:
      return undefined;
  }
}

function validMessage(m: OutboxMessage): boolean {
  return (
    typeof m === "object" &&
    m !== null &&
    (FEISHU_SEND_MSG_TYPES as readonly string[]).includes(m.msgType) &&
    typeof m.content === "string" &&
    m.content.length > 0 &&
    utf8(m.content) <= FEISHU_REPLY_LIMITS.maxCardBytes
  );
}

const UNKNOWN_MARK = "u:";
const NONE_MARK = "n:";

type Verdict =
  | { t: "pause"; reason: string }
  | { t: "abort" }
  | { t: "retry"; unknown: boolean; reason: string }
  | { t: "fail"; code: string; abortGroup: boolean };

interface Entry {
  sendId: string;
  group: string;
  part: number;
  kind: "final" | "notice";
  createdAt: number;
  lane: string;
  msgType: FeishuMsgType;
  attempts: number;
  /** a past attempt may have taken effect (⇒ uuid window applies) */
  unknown: boolean;
  nextAt: number;
  cycle: number;
  cycleTries: number;
  cycleStart: number | undefined;
  durable: boolean;
}

interface Group {
  key: string;
  kind: "final" | "notice";
  requestId?: string;
  variant?: string;
  total: number;
  sendIds: string[];
  /** in-process memory of parts that settled (survives the state's 1 h sweep of the record) */
  tomb: Map<string, { part: number; state: "sent" | "failed"; code?: string }>;
  target?: SettledGroup["target"];
  settling: boolean;
  retryAt: number | undefined;
}

export function createFeishuOutbox(deps: FeishuOutboxDeps): FeishuOutbox {
  const clock = deps.clock ?? systemFeishuClock;
  const policy: FeishuOutboxPolicy = { ...FEISHU_OUTBOX_POLICY, ...(deps.policy ?? {}) };
  const goneCodes = deps.targetGoneCodes ?? FEISHU_TARGET_GONE_CODES;
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const store = deps.state.outbox;

  let mode: "idle" | "running" | "stopped" | "disposed" = "idle";
  const entries = new Map<string, Entry>();
  const groups = new Map<string, Group>();
  const active = new Map<string, AbortController>();
  const partNo = new Map<string, number>();
  const partOf = (sendId: string): number => partNo.get(sendId) ?? 1;
  const laneBusy = new Set<string>();
  const groupBusy = new Set<string>();
  const laneLast = new Map<string, number>();
  const starts: number[] = [];
  /** in-process only */
  const sentInfo = new Map<string, { messageId: string; threadId?: string; chatId?: string }>();
  const undelivered = new Map<string, OutboxMessage>();
  let timer: unknown;
  let timerAt = Infinity;
  let pause: { reason: string; probeAt: number } | undefined;
  let durabilityProbe: Promise<void> | undefined;
  let sentCount = 0;
  let failedCount = 0;
  let lastCode: string | undefined;

  const emit = (e: OutboxEvent): void => {
    try {
      deps.onEvent?.(e);
    } catch {
      /* observers never affect delivery */
    }
  };

  // ----- index maintenance -------------------------------------------------

  function indexRecord(rec: FeishuOutboxPart, durable: boolean): void {
    const now = clock.now();
    partNo.set(rec.sendId, rec.part ?? 1);
    const group = rec.requestId ?? rec.sendId;
    const kind = rec.kind;
    let g = groups.get(group);
    if (g === undefined) {
      const tilde = rec.requestId?.indexOf("~") ?? -1;
      g = {
        key: group,
        kind,
        total: rec.parts ?? 1,
        sendIds: [],
        tomb: new Map(),
        settling: false,
        retryAt: undefined,
      };
      if (rec.requestId !== undefined) {
        g.requestId = tilde >= 0 ? rec.requestId.slice(0, tilde) : rec.requestId;
        if (tilde >= 0) g.variant = rec.requestId.slice(tilde + 1);
      }
      g.target = targetOf(rec);
      groups.set(group, g);
    }
    if (!g.sendIds.includes(rec.sendId)) {
      g.sendIds.push(rec.sendId);
      g.sendIds.sort((a, b) => partOf(a) - partOf(b));
    }
    if (rec.state === "queued") {
      const code = rec.code ?? "";
      entries.set(rec.sendId, {
        sendId: rec.sendId,
        group,
        part: rec.part ?? 1,
        kind,
        createdAt: rec.createdAt,
        lane: rec.targetId,
        msgType: rec.msgType,
        attempts: rec.attempts,
        unknown: code.startsWith(UNKNOWN_MARK),
        nextAt: now,
        cycle: 0,
        cycleTries: 0,
        cycleStart: undefined,
        durable,
      });
    }
  }

  // ----- scheduling --------------------------------------------------------

  function arm(at: number): void {
    if (mode !== "running" || !Number.isFinite(at)) return;
    if (timer !== undefined && timerAt <= at) return;
    if (timer !== undefined) clock.clearTimeout(timer);
    timerAt = at;
    timer = clock.setTimeout(
      () => {
        timer = undefined;
        timerAt = Infinity;
        pump();
      },
      Math.max(0, at - clock.now()),
    );
  }

  function trimStarts(now: number): void {
    while (starts.length > 0 && now - starts[0]! >= 1_000) starts.shift();
  }

  function pump(): void {
    if (mode !== "running") return;
    const now = clock.now();
    expireStale(now);
    retrySettles(now);
    trimStarts(now);
    let wake = Infinity;
    const heads = new Map<string, Entry>();
    for (const e of entries.values()) {
      const h = heads.get(e.group);
      if (h === undefined || e.part < h.part) heads.set(e.group, e);
    }
    const ordered = [...heads.values()].sort((a, b) => a.createdAt - b.createdAt || a.part - b.part);
    for (const e of ordered) {
      if (active.size >= policy.maxInFlight) break;
      if (groupBusy.has(e.group) || laneBusy.has(e.lane)) continue;
      if (!e.durable) {
        ensureDurable();
        continue;
      }
      let at = e.nextAt;
      const last = laneLast.get(e.lane);
      if (last !== undefined) at = Math.max(at, last + policy.perLaneMinGapMs);
      if (pause !== undefined) {
        if (active.size > 0) continue;
        at = Math.max(at, pause.probeAt);
      }
      if (at > now) {
        wake = Math.min(wake, at);
        continue;
      }
      if (starts.length >= policy.globalPerSecond) {
        wake = Math.min(wake, starts[0]! + 1_000);
        continue;
      }
      starts.push(now);
      void attempt(e);
    }
    // wake for expiry / settle retries as well (only strictly-future instants: a past one would spin the timer)
    const consider = (at: number): void => {
      if (at > now) wake = Math.min(wake, at);
    };
    for (const e of entries.values()) {
      if (active.has(e.sendId)) continue;
      const maxAge = e.kind === "final" ? policy.finalMaxAgeMs : policy.noticeMaxAgeMs;
      consider(e.createdAt + maxAge + 1);
      if (e.unknown) consider(e.createdAt + policy.uuidSafeWindowMs + 1);
    }
    for (const g of groups.values()) if (g.retryAt !== undefined) consider(g.retryAt);
    arm(wake);
  }

  function ensureDurable(): void {
    if (durabilityProbe !== undefined) return;
    durabilityProbe = deps.state
      .commit()
      .then((ok) => {
        durabilityProbe = undefined;
        if (ok) {
          for (const e of entries.values()) e.durable = true;
          pump();
        } else arm(clock.now() + 1_000);
      })
      .catch(() => {
        durabilityProbe = undefined;
        arm(clock.now() + 1_000);
      });
  }

  function expireStale(now: number): void {
    for (const e of [...entries.values()]) {
      const maxAge = e.kind === "final" ? policy.finalMaxAgeMs : policy.noticeMaxAgeMs;
      if (active.has(e.sendId)) continue;
      if (now - e.createdAt > maxAge) failPart(e, OUTBOX_FAIL_CODES.expired, false);
      else if (e.unknown && now - e.createdAt > policy.uuidSafeWindowMs)
        failPart(e, OUTBOX_FAIL_CODES.expiredUncertain, false);
    }
  }

  // ----- sending -----------------------------------------------------------

  function classify(f: FeishuFailure): Verdict {
    if (f.kind === "aborted") return { t: "abort" };
    if (f.kind === "auth") {
      if (f.auth === "unconfigured" || f.auth === "refused" || f.auth === "auth_failed")
        return { t: "pause", reason: f.auth };
      return { t: "retry", unknown: false, reason: clip(f.reason) };
    }
    if (f.capabilityDenied === true) return { t: "fail", code: OUTBOX_FAIL_CODES.capabilityDenied, abortGroup: true };
    if (f.kind === "destination" || f.kind === "bad-request")
      return { t: "fail", code: clip(`${OUTBOX_FAIL_CODES.localPrefix}${f.reason}`), abortGroup: false };
    if (f.kind === "api" && f.code !== undefined && goneCodes.includes(f.code) && f.effect === "none")
      return { t: "fail", code: OUTBOX_FAIL_CODES.targetGone, abortGroup: true };
    if (f.retryable || f.effect === "unknown")
      return { t: "retry", unknown: f.effect === "unknown", reason: clip(f.reason) };
    return { t: "fail", code: clip(`${OUTBOX_FAIL_CODES.rejectedPrefix}${f.reason}`), abortGroup: false };
  }

  async function attempt(e: Entry): Promise<void> {
    const rec = store.get(e.sendId);
    if (rec === undefined || rec.state !== "queued" || rec.content === undefined) {
      entries.delete(e.sendId);
      pump();
      return;
    }
    const now = clock.now();
    if (e.cycleStart === undefined) e.cycleStart = now;
    laneBusy.add(e.lane);
    groupBusy.add(e.group);
    const ac = new AbortController();
    active.set(e.sendId, ac);
    let verdict: Verdict | undefined;
    let sent: { messageId: string; threadId?: string; chatId?: string } | undefined;
    try {
      const common = {
        msgType: rec.msgType as FeishuMsgType,
        content: rec.content,
        uuid: rec.sendId,
        signal: ac.signal,
      };
      const res =
        rec.route === "reply"
          ? await deps.api.reply({ ...common, messageId: rec.targetId, replyInThread: rec.inThread === true })
          : await deps.api.send({ ...common, receiveIdType: rec.receiveIdType ?? "chat_id", receiveId: rec.targetId });
      if (res.ok) {
        sent = { messageId: res.data.messageId };
        if (res.data.threadId !== undefined) sent.threadId = res.data.threadId;
        if (res.data.chatId !== undefined) sent.chatId = res.data.chatId;
      } else {
        verdict = classify(res);
        if (res.capabilityDenied === true) emit({ event: "capability-denied", msgType: e.msgType });
      }
    } catch {
      verdict = { t: "retry", unknown: true, reason: "exception" };
    } finally {
      active.delete(e.sendId);
      laneBusy.delete(e.lane);
      groupBusy.delete(e.group);
      laneLast.set(e.lane, clock.now());
      if (laneLast.size > 512) for (const [k, v] of laneLast) if (clock.now() - v > 10_000) laneLast.delete(k);
    }

    if (sent !== undefined) {
      onSent(e, sent);
    } else if (verdict !== undefined) {
      onFailure(e, verdict);
    }
    pump();
  }

  function onSent(e: Entry, info: { messageId: string; threadId?: string; chatId?: string }): void {
    const attempts = e.attempts + 1;
    store.update(e.sendId, { state: "sent", attempts });
    entries.delete(e.sendId);
    groups.get(e.group)?.tomb.set(e.sendId, { part: e.part, state: "sent" });
    sentInfo.set(e.sendId, info);
    sentCount++;
    if (pause !== undefined) {
      pause = undefined;
      emit({ event: "resumed" });
    }
    emit({ event: "sent", kind: e.kind, msgType: e.msgType, attempts });
    checkGroup(e.group);
  }

  function onFailure(e: Entry, v: Verdict): void {
    const now = clock.now();
    switch (v.t) {
      case "abort":
        return; // our own abort (stop): effect unknown, stays queued with the same uuid
      case "pause": {
        const first = pause === undefined;
        pause = { reason: v.reason, probeAt: now + policy.pauseProbeMs };
        if (first) emit({ event: "paused", reason: v.reason });
        return;
      }
      case "fail":
        failPart(e, v.code, v.abortGroup);
        return;
      case "retry": {
        e.attempts += 1;
        e.cycleTries += 1;
        if (v.unknown) e.unknown = true;
        const mark = e.unknown ? UNKNOWN_MARK : NONE_MARK;
        store.update(e.sendId, { attempts: e.attempts, code: clip(`${mark}${v.reason}`) });
        emit({ event: "retry", kind: e.kind, reason: v.reason, unknownEffect: v.unknown });
        const inCycle = e.cycleTries <= policy.maxRetries && now - (e.cycleStart ?? now) < policy.taskBudgetMs;
        if (inCycle) {
          const back = policy.inCycleBackoffMs[Math.min(e.cycleTries - 1, policy.inCycleBackoffMs.length - 1)] ?? 1_000;
          e.nextAt = now + back;
        } else {
          const ladder = policy.cycleLadderMs;
          e.nextAt = now + (ladder[Math.min(e.cycle, ladder.length - 1)] ?? 60_000);
          e.cycle += 1;
          e.cycleTries = 0;
          e.cycleStart = undefined;
        }
        return;
      }
    }
  }

  /** Terminal failure of one part (+ optionally the rest of its group). */
  function failPart(e: Entry, code: string, abortGroup: boolean): void {
    const rec = store.get(e.sendId);
    if (rec !== undefined)
      undelivered.set(e.sendId, { msgType: rec.msgType as FeishuMsgType, content: rec.content ?? "" });
    store.update(e.sendId, { state: "failed", code: clip(code) });
    entries.delete(e.sendId);
    groups.get(e.group)?.tomb.set(e.sendId, { part: e.part, state: "failed", code: clip(code) });
    failedCount++;
    lastCode = code;
    emit({ event: "failed", kind: e.kind, code });
    if (abortGroup) {
      for (const other of [...entries.values()]) {
        if (other.group !== e.group || other.sendId === e.sendId || active.has(other.sendId)) continue;
        const r = store.get(other.sendId);
        if (r !== undefined)
          undelivered.set(other.sendId, { msgType: r.msgType as FeishuMsgType, content: r.content ?? "" });
        const skipped = clip(`${OUTBOX_FAIL_CODES.skippedPrefix}${code}`);
        store.update(other.sendId, { state: "failed", code: skipped });
        entries.delete(other.sendId);
        groups.get(other.group)?.tomb.set(other.sendId, { part: other.part, state: "failed", code: skipped });
        failedCount++;
      }
    }
    checkGroup(e.group);
  }

  // ----- settling ----------------------------------------------------------

  function targetOf(r: FeishuOutboxPart): SettledGroup["target"] {
    return {
      route: r.route,
      targetId: r.targetId,
      ...(r.inThread !== undefined ? { inThread: r.inThread } : {}),
      ...(r.receiveIdType !== undefined ? { receiveIdType: r.receiveIdType } : {}),
    };
  }

  function buildSettled(g: Group, recovered: boolean): SettledGroup | undefined {
    const parts: SettledPart[] = [];
    const target = g.target;
    for (const id of g.sendIds) {
      const r = store.get(id);
      if (r?.state === "queued") return undefined;
      let p: SettledPart;
      if (r !== undefined) {
        p = { part: r.part ?? 1, sendId: id, state: r.state };
        if (r.code !== undefined && r.state === "failed") p.code = r.code;
      } else {
        // the record was swept by the state's 1 h settled TTL while siblings were still queued: the in-process
        // tombstone still knows how it ended (after a restart it is unknown ⇒ counted in `swept`)
        const t = g.tomb.get(id);
        if (t === undefined) continue;
        p = { part: t.part, sendId: id, state: t.state };
        if (t.code !== undefined) p.code = t.code;
      }
      const info = sentInfo.get(id);
      if (info !== undefined) Object.assign(p, info);
      const und = undelivered.get(id);
      if (und !== undefined && p.state === "failed") p.undelivered = und;
      parts.push(p);
    }
    if (target === undefined || parts.length === 0) return undefined;
    parts.sort((x, y) => x.part - y.part);
    const failed = parts.filter((p) => p.state === "failed");
    const out: SettledGroup = {
      kind: g.kind,
      outcome: failed.length === 0 ? "delivered" : failed.length === parts.length ? "failed" : "partial",
      replyFailed: failed.length > 0,
      target,
      parts,
      recovered,
    };
    if (g.requestId !== undefined) out.requestId = g.requestId;
    if (g.variant !== undefined) out.variant = g.variant;
    const code = failed[0]?.code;
    if (code !== undefined) out.code = code;
    if (g.kind === "final" && parts.length < g.total) out.swept = g.total - parts.length;
    return out;
  }

  function checkGroup(key: string, recovered = false): void {
    const g = groups.get(key);
    if (g === undefined || g.settling) return;
    for (const id of g.sendIds) if (entries.has(id)) return;
    const ev = buildSettled(g, recovered);
    if (ev === undefined) {
      // every record of the group vanished (state sweep after the 1 h settled TTL) and nothing is remembered
      for (const id of g.sendIds) {
        sentInfo.delete(id);
        undelivered.delete(id);
        partNo.delete(id);
      }
      groups.delete(key);
      return;
    }
    if (deps.onSettled === undefined) return;
    g.settling = true;
    g.retryAt = undefined;
    const handler = deps.onSettled;
    void (async () => {
      try {
        await handler(ev);
      } catch {
        emit({ event: "settle-error" });
        g.settling = false;
        g.retryAt = clock.now() + policy.settleRetryMs;
        arm(g.retryAt);
        return;
      }
      for (const id of g.sendIds) {
        store.remove(id);
        sentInfo.delete(id);
        undelivered.delete(id);
        partNo.delete(id);
      }
      groups.delete(key);
    })();
  }

  function retrySettles(now: number): void {
    for (const g of groups.values()) {
      if (g.retryAt !== undefined && g.retryAt <= now && !g.settling) checkGroup(g.key, true);
    }
  }

  // ----- enqueue -----------------------------------------------------------

  async function enqueueGroup(
    kind: "final" | "notice",
    seed: string,
    storedRequestId: string | undefined,
    mapped: Mapped,
    messages: readonly OutboxMessage[],
    laneKey: string | undefined,
  ): Promise<EnqueueResult> {
    if (mode === "disposed") return { ok: false, refused: "disposed" };
    const total = messages.length;
    const ids = messages.map((_, i) => deriveSendId(seed, i + 1));
    if (store.get(ids[0]!) !== undefined) return { ok: true, sendIds: ids, durable: true, duplicate: true };
    const added: string[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const input: Parameters<typeof store.add>[0] = {
        sendId: ids[i]!,
        kind,
        route: mapped.route,
        targetId: mapped.targetId,
        msgType: m.msgType,
        content: m.content,
        ...(storedRequestId !== undefined ? { requestId: storedRequestId } : {}),
        ...(mapped.receiveIdType !== undefined ? { receiveIdType: mapped.receiveIdType } : {}),
        ...(mapped.route === "reply" ? { inThread: mapped.inThread === true } : {}),
        ...(kind === "final" ? { part: i + 1, parts: total } : {}),
      };
      const res = store.add(input);
      if (!res.ok) {
        for (const id of added) store.remove(id); // same tick ⇒ never persisted half-way
        const refused: EnqueueRefusal =
          res.refused === "cap"
            ? "cap"
            : res.refused === "budget"
              ? "budget"
              : res.refused === "unavailable"
                ? "unavailable"
                : "invalid-message";
        emit({ event: "refused", kind, refused });
        return { ok: false, refused };
      }
      added.push(ids[i]!);
    }
    for (const id of ids) {
      const rec = store.get(id);
      if (rec !== undefined) {
        indexRecord(rec, false);
        const en = entries.get(id);
        if (en !== undefined && laneKey !== undefined) en.lane = laneKey;
      }
    }
    let durable = false;
    try {
      durable = await deps.state.commit();
    } catch {
      durable = false;
    }
    if (durable)
      for (const id of ids) {
        const en = entries.get(id);
        if (en !== undefined) en.durable = true;
      }
    pump();
    return { ok: true, sendIds: ids, durable, duplicate: false };
  }

  const enqueueFinal = async (input: EnqueueFinalInput): Promise<EnqueueResult> => {
    try {
      if (typeof input?.requestId !== "string" || !REQUEST_ID_RE.test(input.requestId) || input.requestId.includes("~"))
        return { ok: false, refused: "invalid-request" };
      if (input.variant !== undefined && !VARIANT_RE.test(input.variant))
        return { ok: false, refused: "invalid-request" };
      const mapped = mapTarget(input.target);
      if (mapped === undefined) return { ok: false, refused: "invalid-target" };
      if (!Array.isArray(input.messages) || input.messages.length === 0)
        return { ok: false, refused: "invalid-message" };
      if (input.messages.length > MAX_MESSAGES) return { ok: false, refused: "too-many-parts" };
      if (!input.messages.every(validMessage)) return { ok: false, refused: "invalid-message" };
      const stored = input.variant === undefined ? input.requestId : `${input.requestId}~${input.variant}`;
      return await enqueueGroup("final", stored, stored, mapped, input.messages, input.laneKey);
    } catch {
      return { ok: false, refused: "unavailable" };
    }
  };

  const enqueueNotice = async (input: EnqueueNoticeInput): Promise<EnqueueResult> => {
    try {
      const mapped = mapTarget(input.target);
      if (mapped === undefined) return { ok: false, refused: "invalid-target" };
      if (!validMessage(input.message)) return { ok: false, refused: "invalid-message" };
      if (input.key !== undefined && !NOTICE_KEY_RE.test(input.key)) return { ok: false, refused: "invalid-request" };
      if (input.tag !== undefined && !NOTICE_TAG_RE.test(input.tag)) return { ok: false, refused: "invalid-request" };
      const key = input.key ?? Buffer.from(random(16)).toString("base64url");
      return await enqueueGroup("notice", `notice\n${key}`, input.tag, mapped, [input.message], input.laneKey);
    } catch {
      return { ok: false, refused: "unavailable" };
    }
  };

  // ----- lifecycle ---------------------------------------------------------

  function load(): void {
    for (const rec of store.list()) {
      if (rec.part !== undefined) partNo.set(rec.sendId, rec.part);
    }
    for (const rec of store.list()) {
      if (groups.get(rec.requestId ?? rec.sendId)?.sendIds.includes(rec.sendId) !== true) indexRecord(rec, true);
    }
    for (const g of [...groups.values()]) checkGroup(g.key, true);
  }

  return {
    start() {
      if (mode === "running" || mode === "disposed") return;
      mode = "running";
      load();
      pump();
    },
    enqueueFinal,
    enqueueNotice,
    resume() {
      if (pause === undefined) return;
      pause.probeAt = clock.now();
      pump();
    },
    stats() {
      const s: OutboxStats = { queued: entries.size, inFlight: active.size, sent: sentCount, failed: failedCount };
      if (lastCode !== undefined) s.lastCode = lastCode;
      if (pause !== undefined) s.paused = pause.reason;
      return s;
    },
    async stop(drainMs = 2_000) {
      if (mode === "disposed") return { drained: true, aborted: 0 };
      if (mode === "running") mode = "stopped";
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      timerAt = Infinity;
      if (active.size === 0) return { drained: true, aborted: 0 };
      let aborted = 0;
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        const poll = (): void => {
          if (active.size === 0) finish();
          else clock.setTimeout(poll, 25);
        };
        clock.setTimeout(() => {
          if (done) return;
          for (const ac of active.values()) {
            aborted++;
            ac.abort();
          }
          // give the aborted calls a tick to unwind, then stop waiting regardless
          clock.setTimeout(finish, 50);
        }, drainMs);
        poll();
      });
      return { drained: aborted === 0, aborted };
    },
    dispose() {
      mode = "disposed";
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
      for (const ac of active.values()) ac.abort();
      active.clear();
      entries.clear();
      groups.clear();
    },
  };
}
