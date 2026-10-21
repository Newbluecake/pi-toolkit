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
 *   and, iff the request asked for a wake and BOTH wakesOutPerHour and pairWakesPerHour have room,
 *   one wake in each window; otherwise the wake is dropped here (`outbound_wake_rate` /
 *   `pair_wake_rate`) and the message continues as deliver-only.
 *
 * Settlement (`xs_ack` arrival or the hub's own deadline):
 *   - `inFlight` is ALWAYS released;
 *   - every send counter is kept in every case (a refusing/unknown peer must not be probe-able for
 *     free — §4.6 step 2);
 *   - the receiver's ack said `woke:false` ⇒ ONLY the wake reservation is refunded (it provably did
 *     not wake anyone);
 *   - no ack (deadline, disconnect, hub teardown) ⇒ nothing refunded: unknown is conservative.
 */
import type { XsMemberLimitsWire } from "../../protocol/xs.js";

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
}

export interface XsLimitsSnapshot {
  senders: number;
  pairs: number;
  hubLastMin: number;
}

export interface XsLimits {
  /** list/resolve budget (`listPerMin`, combined). */
  admitList(agentKey: string, limits: Pick<XsMemberLimitsWire, "listPerMin">): boolean;
  admitSend(args: { agentKey: string; pairKey: string; limits: XsMemberLimitsWire; wantWake: boolean }): XsAdmit;
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
      s = { list: [], min: [], hour: [], wakes: [], inFlight: 0 };
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
        if (s.inFlight === 0 && s.list.length + s.min.length + s.hour.length + s.wakes.length === 0) senders.delete(k);
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

    admitSend({ agentKey, pairKey, limits, wantWake }) {
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
      if (pair !== undefined && now - pair.lastAt < limits.pairMinIntervalMs) {
        return { ok: false, reason: "rate_pair_interval" };
      }
      if (s.min.length >= limits.sendsOutPerMin) return { ok: false, reason: "rate_sends_min" };
      if (s.hour.length >= limits.sendsOutPerHour) return { ok: false, reason: "rate_sends_hour" };
      if (hubWindow.length >= hubCap) return { ok: false, reason: "rate_hub" };

      // Every refusal check passed ⇒ commit the reservation atomically.
      let wake = false;
      let wakeDowngraded: "outbound_wake_rate" | "pair_wake_rate" | undefined;
      if (wantWake) {
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
      if (ticket.wakeReserved && input.acked && input.woke === false) {
        if (s !== undefined) removeOne(s.wakes, ticket.at);
        const p = pairs.get(ticket.pairKey);
        if (p !== undefined) removeOne(p.wakes, ticket.at);
      }
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
}

/**
 * `hub/main.ts` re-validation: anything but `{ limits: { hubSendsPerMin: integer 1..600 } }`
 * (extra keys ignored, never trusted) yields `undefined` ⇒ the caller DROPS the whole key ⇒ xs off
 * (no relay, no cap, no frame handling). Never throws.
 */
export function normalizeHubCrossSessionConfig(raw: unknown): HubCrossSessionConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const limits = (raw as Record<string, unknown>)["limits"];
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return undefined;
  const v = (limits as Record<string, unknown>)["hubSendsPerMin"];
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  if (v < XS_HUB_SENDS_PER_MIN_BOUNDS.min || v > XS_HUB_SENDS_PER_MIN_BOUNDS.max) return undefined;
  return { limits: { hubSendsPerMin: v } };
}
