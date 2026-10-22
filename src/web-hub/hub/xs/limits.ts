/**
 * fabric phase-2 X1 (phase2-plan §4.6/§5.2): hub-side sender rate limits with RESERVE → SETTLE.
 *
 * Counters live in hub memory only (a hub restart clears them — acceptable: these caps only stop
 * storms; the receiver's inbound limits are agent-side and survive a hub restart). Everything is
 * lazy sliding windows over timestamps: no timers (nothing to unref), bounded maps (swept when
 * they grow, never grown by an attacker past a few thousand keys — same-uid peers only anyway).
 *
 * Admission RESERVES (one atomic commit after every check passed; a rejected admission consumes
 * nothing):
 *   sendsOutPerMin/Hour +1 · inFlight +1 · pair interval stamp · hubSendsPerMin +1
 *   Replies skip the pair-interval CHECK (not the send/in-flight/hub counters), force wake off,
 *   and otherwise use the identical reservation/settlement path.
 *   and, iff the request asked for a wake and BOTH wakesOutPerHour and pairWakesPerHour have room,
 *   one wake in each window; otherwise the wake is dropped here (`outbound_wake_rate` /
 *   `pair_wake_rate`) and the message continues as deliver-only.
 *
 * Settlement (`xs_ack` arrival or the hub's own deadline):
 *   - `inFlight` is ALWAYS released;
 *   - every send counter is kept in every case (a refusing/unknown peer must not be probe-able for
 *     free — §4.6 step 2);
 *   - the receiver's ack said `woke:false` AND its effect is `applied`/`none` ⇒ ONLY the wake
 *     reservation is refunded (channel-plan §5.2 NQ2: an `unknown` ack — e.g. the Controller
 *     already dispatched but verify failed — may have woken someone, so it never refunds);
 *   - no ack (deadline, disconnect, hub teardown) ⇒ nothing refunded: unknown is conservative.
 *
 * Channel broadcasts (channel-plan §5.2, `admitBroadcast` / `settleBroadcast`): admission is
 * per-head (N sends against every send window), all-or-nothing, plus the sender's own broadcast
 * windows; the broadcast settlement ONLY releases the in-flight slot — no send count and no wake
 * reservation is ever refunded (CR5: simple ⇒ unbreakable).
 */
import type { XsEffect, XsMemberLimitsWire } from "../../protocol/xs.js";
import {
  XS_BROADCAST_MAX_RECIPIENTS_DEFAULT,
  XS_BROADCAST_WAKE_MAX_RECIPIENTS_DEFAULT,
  XS_BROADCAST_WAKE_RECIPIENTS_HARD_MAX,
  XS_BROADCAST_WAKES_PER_HOUR_HARD_MAX,
  XS_CHANNEL_RESULT_MAX_ROWS,
} from "../../protocol/xs.js";
import { broadcastLimitsOf } from "./members.js";

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const SENDER_SWEEP_AT = 256;
const PAIR_SWEEP_AT = 1_024;

export type XsAdmitRefusal =
  "rate_in_flight" | "rate_pair_interval" | "rate_sends_min" | "rate_sends_hour" | "rate_hub";

export interface XsTicket {
  readonly agentKey: string;
  readonly pairKey: string;
  readonly at: number;
  /** A wake reservation is held in BOTH the sender's and the pair's wake windows. */
  readonly wakeReserved: boolean;
  settled: boolean;
}

export type XsAdmit =
  | { ok: true; ticket: XsTicket; wake: boolean; wakeDowngraded?: "outbound_wake_rate" | "pair_wake_rate" }
  | { ok: false; reason: XsAdmitRefusal };

export interface XsSettleInput {
  /** The receiver's own `xs_ack` arrived. */
  acked: boolean;
  /** The ack's `woke` (only meaningful when `acked`). */
  woke?: boolean;
  /** The ack's `effect` (only meaningful when `acked`). Channel-plan §5.2 NQ2: the wake refund
   *  needs `applied`/`none` — `unknown` or a missing effect never refunds. */
  effect?: XsEffect;
}

// ----------------------------------------------------------------- broadcast (channel-plan §5.2)
//
// Structural copies of the CH0-frozen port types in `src/fabric/xs/types-channel.ts` (the hub
// boundary forbids even type-only imports from outside {protocol,hub}). Kept field-for-field
// identical; `tests/web-hub/hub/xs-broadcast.test.ts` assigns this implementation to the frozen
// `XsLimitsBroadcast` type.

export type XsBroadcastAdmitRefusal =
  | "rate_in_flight"
  | "rate_sends_min"
  | "rate_sends_hour"
  | "rate_hub"
  | "rate_broadcast_hour"
  | "rate_broadcast_interval";

export type XsBroadcastWakeDowngrade =
  "sender_wake_disabled" | "level_limit" | "broadcast_wake_fanout" | "broadcast_wake_rate" | "outbound_wake_rate";

export interface XsBroadcastAdmitRecipient {
  pairKey: string;
}

export interface XsBroadcastAdmitArgs {
  agentKey: string;
  /** N = |S| (ambiguous rows included); order = row order. */
  recipients: readonly XsBroadcastAdmitRecipient[];
  limits: XsMemberLimitsWire;
  /** The frame asked for wake AND passed step 5.1 (level 0, sender wake on). */
  wantWake: boolean;
  /** Hub-global (hard ≤ 4, clamped again here). */
  wakeMaxRecipients: number;
}

export interface XsBroadcastTicket {
  readonly agentKey: string;
  readonly at: number;
  readonly recipients: number;
  /** NEVER refunded. */
  readonly wakeReserved: boolean;
  settled: boolean;
}

export type XsBroadcastAdmit =
  | {
      ok: true;
      ticket: XsBroadcastTicket;
      wake: boolean;
      wakeDowngraded?: XsBroadcastWakeDowngrade;
      rows: ReadonlyArray<{ wake: boolean; wakeDowngraded?: "pair_wake_rate" }>;
    }
  | { ok: false; reason: XsBroadcastAdmitRefusal };

export interface XsLimitsBroadcast {
  admitBroadcast(args: XsBroadcastAdmitArgs): XsBroadcastAdmit;
  settleBroadcast(ticket: XsBroadcastTicket): void;
}

export interface XsLimitsSnapshot {
  senders: number;
  pairs: number;
  hubLastMin: number;
}

export interface XsLimits extends XsLimitsBroadcast {
  /** list/resolve budget (`listPerMin`, combined). */
  admitList(agentKey: string, limits: Pick<XsMemberLimitsWire, "listPerMin">): boolean;
  admitSend(args: {
    agentKey: string;
    pairKey: string;
    limits: XsMemberLimitsWire;
    wantWake: boolean;
    isReply?: boolean;
  }): XsAdmit;
  /** Idempotent: a ticket settles at most once. */
  settle(ticket: XsTicket, input: XsSettleInput): void;
  snapshot(): XsLimitsSnapshot;
}

interface SenderState {
  list: number[];
  min: number[];
  hour: number[];
  wakes: number[];
  inFlight: number;
  /** Channel-plan §5.2: admitted broadcasts (1 h window) and the broadcast-wake reservations. */
  bcasts: number[];
  bcastWakes: number[];
}
interface PairState {
  lastAt: number;
  wakes: number[];
}

function prune(arr: number[], now: number, windowMs: number): void {
  let i = 0;
  while (i < arr.length && now - arr[i]! >= windowMs) i++;
  if (i > 0) arr.splice(0, i);
}

function removeOne(arr: number[], value: number): void {
  const i = arr.indexOf(value);
  if (i !== -1) arr.splice(i, 1);
}

export function createXsLimits(deps: { now: () => number; hubSendsPerMin: number }): XsLimits {
  const senders = new Map<string, SenderState>();
  const pairs = new Map<string, PairState>();
  const hubWindow: number[] = [];
  const hubCap = Math.max(1, Math.trunc(deps.hubSendsPerMin));

  function sender(agentKey: string): SenderState {
    let s = senders.get(agentKey);
    if (s === undefined) {
      s = { list: [], min: [], hour: [], wakes: [], inFlight: 0, bcasts: [], bcastWakes: [] };
      senders.set(agentKey, s);
    }
    return s;
  }

  function sweep(now: number): void {
    if (senders.size > SENDER_SWEEP_AT) {
      for (const [k, s] of senders) {
        prune(s.list, now, MIN_MS);
        prune(s.min, now, MIN_MS);
        prune(s.hour, now, HOUR_MS);
        prune(s.wakes, now, HOUR_MS);
        prune(s.bcasts, now, HOUR_MS);
        prune(s.bcastWakes, now, HOUR_MS);
        const used =
          s.list.length + s.min.length + s.hour.length + s.wakes.length + s.bcasts.length + s.bcastWakes.length;
        if (s.inFlight === 0 && used === 0) senders.delete(k);
      }
    }
    if (pairs.size > PAIR_SWEEP_AT) {
      for (const [k, p] of pairs) {
        prune(p.wakes, now, HOUR_MS);
        if (p.wakes.length === 0 && now - p.lastAt >= HOUR_MS) pairs.delete(k);
      }
    }
  }

  return {
    admitList(agentKey, limits) {
      const now = deps.now();
      const s = sender(agentKey);
      prune(s.list, now, MIN_MS);
      if (s.list.length >= limits.listPerMin) return false;
      s.list.push(now);
      return true;
    },

    admitSend({ agentKey, pairKey, limits, wantWake, isReply = false }) {
      const now = deps.now();
      sweep(now);
      const s = sender(agentKey);
      prune(s.min, now, MIN_MS);
      prune(s.hour, now, HOUR_MS);
      prune(s.wakes, now, HOUR_MS);
      prune(hubWindow, now, MIN_MS);
      const pair = pairs.get(pairKey);
      if (pair !== undefined) prune(pair.wakes, now, HOUR_MS);

      if (s.inFlight >= limits.inFlightPerSession) return { ok: false, reason: "rate_in_flight" };
      if (!isReply && pair !== undefined && now - pair.lastAt < limits.pairMinIntervalMs) {
        return { ok: false, reason: "rate_pair_interval" };
      }
      if (s.min.length >= limits.sendsOutPerMin) return { ok: false, reason: "rate_sends_min" };
      if (s.hour.length >= limits.sendsOutPerHour) return { ok: false, reason: "rate_sends_hour" };
      if (hubWindow.length >= hubCap) return { ok: false, reason: "rate_hub" };

      // Every refusal check passed ⇒ commit the reservation atomically.
      let wake = false;
      let wakeDowngraded: "outbound_wake_rate" | "pair_wake_rate" | undefined;
      if (wantWake && !isReply) {
        if (s.wakes.length >= limits.wakesOutPerHour) wakeDowngraded = "outbound_wake_rate";
        else if ((pair?.wakes.length ?? 0) >= limits.pairWakesPerHour) wakeDowngraded = "pair_wake_rate";
        else wake = true;
      }
      s.min.push(now);
      s.hour.push(now);
      s.inFlight++;
      hubWindow.push(now);
      let p = pair;
      if (p === undefined) {
        p = { lastAt: now, wakes: [] };
        pairs.set(pairKey, p);
      }
      p.lastAt = now;
      if (wake) {
        s.wakes.push(now);
        p.wakes.push(now);
      }
      const ticket: XsTicket = { agentKey, pairKey, at: now, wakeReserved: wake, settled: false };
      return { ok: true, ticket, wake, ...(wakeDowngraded === undefined ? {} : { wakeDowngraded }) };
    },

    settle(ticket, input) {
      if (ticket.settled) return;
      ticket.settled = true;
      const s = senders.get(ticket.agentKey);
      if (s !== undefined && s.inFlight > 0) s.inFlight--;
      // NQ2 (channel-plan §5.2 顺带修正): refund only on a PROVABLE no-wake — an ack that says
      // woke:false with a known effect. `unknown` (e.g. dispatched-then-verify-failed) keeps it.
      const provableNoWake =
        input.acked && input.woke === false && (input.effect === "applied" || input.effect === "none");
      if (ticket.wakeReserved && provableNoWake) {
        if (s !== undefined) removeOne(s.wakes, ticket.at);
        const p = pairs.get(ticket.pairKey);
        if (p !== undefined) removeOne(p.wakes, ticket.at);
      }
    },

    admitBroadcast({ agentKey, recipients, limits, wantWake, wakeMaxRecipients }) {
      const now = deps.now();
      sweep(now);
      const s = sender(agentKey);
      prune(s.min, now, MIN_MS);
      prune(s.hour, now, HOUR_MS);
      prune(s.wakes, now, HOUR_MS);
      prune(s.bcasts, now, HOUR_MS);
      prune(s.bcastWakes, now, HOUR_MS);
      prune(hubWindow, now, MIN_MS);
      const n = recipients.length;
      const b = broadcastLimitsOf(limits);

      // Step 4: all-or-nothing per-head admission; a refusal consumes NOTHING.
      if (s.inFlight >= limits.inFlightPerSession) return { ok: false, reason: "rate_in_flight" };
      if (limits.sendsOutPerMin - s.min.length < n) return { ok: false, reason: "rate_sends_min" };
      if (limits.sendsOutPerHour - s.hour.length < n) return { ok: false, reason: "rate_sends_hour" };
      if (hubCap - hubWindow.length < n) return { ok: false, reason: "rate_hub" };
      if (b.broadcastsOutPerHour - s.bcasts.length < 1) return { ok: false, reason: "rate_broadcast_hour" };
      const lastBcast = s.bcasts[s.bcasts.length - 1];
      if (lastBcast !== undefined && now - lastBcast < b.broadcastMinIntervalMs) {
        return { ok: false, reason: "rate_broadcast_interval" };
      }

      // Step 5.2–5.5: the whole-broadcast wake (first unmet condition wins).
      const wakeCap = Math.min(
        XS_BROADCAST_WAKE_RECIPIENTS_HARD_MAX,
        Math.max(0, Math.trunc(Number.isFinite(wakeMaxRecipients) ? wakeMaxRecipients : 0)),
      );
      const bcastWakeCap = Math.min(XS_BROADCAST_WAKES_PER_HOUR_HARD_MAX, b.broadcastWakesOutPerHour);
      let wake = false;
      let wakeDowngraded: XsBroadcastWakeDowngrade | undefined;
      if (wantWake) {
        if (n > wakeCap) wakeDowngraded = "broadcast_wake_fanout";
        else if (bcastWakeCap - s.bcastWakes.length < 1) wakeDowngraded = "broadcast_wake_rate";
        else if (limits.wakesOutPerHour - s.wakes.length < n) wakeDowngraded = "outbound_wake_rate";
        else wake = true;
      }

      // Commit. Pair interval: CHECK skipped, timestamp updated for every recipient (§5.2 step 4).
      for (let i = 0; i < n; i++) {
        s.min.push(now);
        s.hour.push(now);
        hubWindow.push(now);
      }
      s.inFlight++;
      s.bcasts.push(now);
      if (wake) s.bcastWakes.push(now);
      const rows: Array<{ wake: boolean; wakeDowngraded?: "pair_wake_rate" }> = [];
      for (const r of recipients) {
        let p = pairs.get(r.pairKey);
        if (p === undefined) {
          p = { lastAt: now, wakes: [] };
          pairs.set(r.pairKey, p);
        } else prune(p.wakes, now, HOUR_MS);
        p.lastAt = now;
        if (!wake) {
          rows.push({ wake: false });
        } else if (p.wakes.length >= limits.pairWakesPerHour) {
          rows.push({ wake: false, wakeDowngraded: "pair_wake_rate" }); // judged before fan-out: no refund exists
        } else {
          s.wakes.push(now);
          p.wakes.push(now);
          rows.push({ wake: true });
        }
      }
      const ticket: XsBroadcastTicket = { agentKey, at: now, recipients: n, wakeReserved: wake, settled: false };
      return { ok: true, ticket, wake, ...(wakeDowngraded === undefined ? {} : { wakeDowngraded }), rows };
    },

    settleBroadcast(ticket) {
      if (ticket.settled) return;
      ticket.settled = true;
      const s = senders.get(ticket.agentKey);
      if (s !== undefined && s.inFlight > 0) s.inFlight--;
      // §5.2 step 7: nothing else — broadcast send counts and wake reservations are never refunded.
    },

    snapshot() {
      const now = deps.now();
      prune(hubWindow, now, MIN_MS);
      return { senders: senders.size, pairs: pairs.size, hubLastMin: hubWindow.length };
    },
  };
}

// ----------------------------------------------------------------- HubConfig.crossSession (§4.6)

/** Frozen-at-start hub-global knob. The schema bounds (1..600) are phase2 §5.2's table row. */
export const XS_HUB_SENDS_PER_MIN_BOUNDS = { min: 1, max: 600 } as const;

export interface HubCrossSessionConfig {
  limits: { hubSendsPerMin: number };
  /** Absent = on; false preserves the pre-reply cap/frame shapes. */
  reply?: boolean;
  /** Channel-plan §3.1: hub-global broadcast params ONLY — absence means the defaults
   *  (16 / 4), NEVER "channels off" (the `xs.channel.v1` cap rides `crossSession` itself). */
  channels?: HubXsChannelsConfig;
}

export interface HubXsChannelsConfig {
  maxRecipients: number;
  wakeMaxRecipients: number;
}

/** Hub-side acceptance bounds of `crossSession.channels` (§6.4; wake hard ≤ 4, Q5). */
export const XS_HUB_CHANNELS_BOUNDS = {
  maxRecipients: { min: 1, max: XS_CHANNEL_RESULT_MAX_ROWS },
  wakeMaxRecipients: { min: 0, max: XS_BROADCAST_WAKE_RECIPIENTS_HARD_MAX },
} as const;

/** The effective hub-global broadcast params (absent/invalid ⇒ defaults). */
export function hubChannelsParams(cfg: HubXsChannelsConfig | undefined): HubXsChannelsConfig {
  return (
    cfg ?? {
      maxRecipients: XS_BROADCAST_MAX_RECIPIENTS_DEFAULT,
      wakeMaxRecipients: XS_BROADCAST_WAKE_MAX_RECIPIENTS_DEFAULT,
    }
  );
}

/** `crossSession.channels` re-validation: a non-integer / out-of-bounds value anywhere drops the
 *  WHOLE sub-key (⇒ defaults); never affects the rest of `crossSession`. */
function normalizeChannelsConfig(raw: unknown): HubXsChannelsConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["maxRecipients", "wakeMaxRecipients"] as const) {
    const v = r[key];
    const { min, max } = XS_HUB_CHANNELS_BOUNDS[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return undefined;
    out[key] = v;
  }
  return out as unknown as HubXsChannelsConfig;
}

/**
 * `hub/main.ts` re-validation: anything but `{ limits: { hubSendsPerMin: integer 1..600 } }`
 * yields `undefined` ⇒ the caller DROPS the whole key ⇒ xs off (no relay, no cap, no frame
 * handling). Optional `reply` is retained only as a boolean (malformed ⇒ false); absent stays
 * absent, meaning on. Optional `channels` (channel-plan §3.1) is kept iff both params are integers
 * in `XS_HUB_CHANNELS_BOUNDS`, else that sub-key alone is dropped (defaults). All other extra keys
 * are ignored. Never throws.
 */
export function normalizeHubCrossSessionConfig(raw: unknown): HubCrossSessionConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const limits = (raw as Record<string, unknown>)["limits"];
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return undefined;
  const v = (limits as Record<string, unknown>)["hubSendsPerMin"];
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  if (v < XS_HUB_SENDS_PER_MIN_BOUNDS.min || v > XS_HUB_SENDS_PER_MIN_BOUNDS.max) return undefined;
  const reply = (raw as Record<string, unknown>)["reply"];
  // Channel-plan §3.1: a malformed `channels` drops only that sub-key (defaults apply).
  const channels = normalizeChannelsConfig((raw as Record<string, unknown>)["channels"]);
  // Fail closed for a malformed reply knob, without disabling the legacy relay.
  return {
    limits: { hubSendsPerMin: v },
    ...(reply === undefined ? {} : { reply: reply === true }),
    ...(channels === undefined ? {} : { channels }),
  };
}
