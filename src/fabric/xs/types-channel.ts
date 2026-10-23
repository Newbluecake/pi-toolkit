import type {
  XsBroadcastRowWire,
  XsEffect,
  XsFanoutWire,
  XsMemberLimitsWire,
  XsWakeDowngraded,
} from "../../web-hub/protocol/xs.js";

/**
 * Channel-plan §10 (CH0): the FROZEN cross-package internal port signatures. Types only — no
 * runtime, no pi imports. CH1..CH5/IBW/CHW consume these; changing one is a plan revision.
 */

// ----------------------------------------------------------------- membership view (CH3 implements, CH2/CH3/CH4/CH5 consume)

/**
 * Read-only view of the local session's channel state (§2.3). One implementation (membership
 * store, CH3) — every gate (receiver stage 3, sender local gate, directory `view()`, status
 * projection, mention) reads `link(hubCap)` / `linkJoined(hubCap)`, never `pref()` directly.
 */
export interface XsChannelView {
  /** The persisted preference set (§2.2); may contain suspended named channels. */
  pref(): readonly string[];
  /** `effectiveChannels(pref, channels.enabled)` (§2.3). */
  effective(): readonly string[];
  /** `linkChannels(pref, enabled, hubCap)` for the CURRENT hub link (§2.3). */
  link(hubCap: boolean): readonly string[];
  /** `linkJoined ⇔ link(hubCap) ≠ ∅` (§2.3). A method (the plan lists it without a call shape). */
  linkJoined(hubCap: boolean): boolean;
}

// ----------------------------------------------------------------- unread tap (IB1 implements; IBW wires)

/**
 * §12.2: host-write observation. IBW wraps the two host `sendMessage` exits with it. `id` is
 * `details.xid`; a NoticeGate quiet write has none ⇒ the tap synthesizes `"n:" + seq` in memory
 * only. The tap only OBSERVES: it must swallow its own errors and never alter delivery.
 * The single definition lives in IB1 (`src/fabric/xs/unread.ts`); re-exported here so every
 * package consumes one frozen shape (`id` optional for xid-less notices).
 */
export type { XsUnreadTap } from "./unread.js";

// ----------------------------------------------------------------- Controller (root-wake)

/** §5.3 (评审 #14): the broadcast marker threaded through `RootWakeRequest` into the message
 *  `details.bc` (never into the provider payload — C-X9). `RootWakeRequest` gains `bc?: XsBroadcastMark`. */
export interface XsBroadcastMark {
  channel: string;
}

// ----------------------------------------------------------------- sender (CH4 implements)

/** §5.5 `XsSender.broadcast()` arguments. `wake` omitted = deliver-only. */
export interface XsSenderBroadcastArgs {
  /** Canonical or `#`-prefixed; the sender normalizes. */
  channel: string;
  text: string;
  wake?: boolean;
  signal?: AbortSignal;
}

/** §5.5: classification of a broadcast result (mirrors `XsSendStatus`, plus the channel-only refusals). */
export type XsBroadcastStatus =
  | "sent" // hub answered with a verdict (fanout/results as answered)
  | "unanswered" // frame left, no verdict (client_deadline / link_lost / origin_changed_after_send)
  | "not_joined" // local linkJoined gate (incl. hub-cap) — nothing sent
  | "channel_unsupported" // hub (or local setting) lacks `xs.channel.v1` — nothing sent
  | "bad_channel" // invalid / not in linkChannels — nothing sent
  | "default_channel" // Q2: `#default` cannot broadcast — nothing sent
  | "origin_changed" // local guard failed BEFORE the frame left (none)
  | "stale_origin" // hub rejected origin — provably not relayed
  | "too_large" // sender-side 16 KiB worst-shape pre-check
  | "fanout_too_large" // E_XS_FANOUT_TOO_LARGE — provable none
  | "off" // E_XS_OFF
  | "bad_frame"
  | "error";

/** §5.5 return type of `XsSender.broadcast()`: `{status, effect, reason?, channel, fanout?, results?, wakeDowngraded?}`. */
export interface XsBroadcastOutcome {
  status: XsBroadcastStatus;
  effect: XsEffect;
  reason?: string;
  code?: string;
  /** Canonical channel name (no `#`). */
  channel: string;
  fanout?: XsFanoutWire;
  results?: XsBroadcastRowWire[];
  wakeDowngraded?: XsWakeDowngraded;
  /** True when the sender truncated the body to `fabric.maxChars`. */
  truncated?: boolean;
}

// ----------------------------------------------------------------- hub limits (CH1 implements)

/** Refusal reasons of `admitBroadcast` (§5.2 step 4). Existing sends' `XsAdmitRefusal` names are reused verbatim. */
export type XsBroadcastAdmitRefusal =
  | "rate_in_flight"
  | "rate_sends_min"
  | "rate_sends_hour"
  | "rate_hub"
  | "rate_broadcast_hour"
  | "rate_broadcast_interval";

/** §5.2 step 5: why the WHOLE broadcast lost its wake (first unmet condition, in order). */
export type XsBroadcastWakeDowngrade =
  "sender_wake_disabled" | "level_limit" | "broadcast_wake_fanout" | "broadcast_wake_rate" | "outbound_wake_rate";

export interface XsBroadcastAdmitRecipient {
  /** The pair key to stamp (`sender|recipient`) — interval check is SKIPPED but its timestamp updated (§5.2 step 4). */
  pairKey: string;
}

export interface XsBroadcastAdmitArgs {
  agentKey: string;
  /** N = |S|, ambiguous rows included (§5.2 step 2). Order = row order. */
  recipients: readonly XsBroadcastAdmitRecipient[];
  limits: XsMemberLimitsWire;
  /** The frame asked for wake AND passed step 5.1 (`level === 0`, sender wake on); `false` ⇒ deliver-only. */
  wantWake: boolean;
  /** Hub-global `HubConfig.crossSession.channels.wakeMaxRecipients` (hard ≤ 4). */
  wakeMaxRecipients: number;
}

export interface XsBroadcastTicket {
  readonly agentKey: string;
  readonly at: number;
  /** N reserved sends. */
  readonly recipients: number;
  /** A broadcast-wake reservation was taken (1 broadcast wake + N outbound wakes minus pair-downgraded rows). NEVER refunded. */
  readonly wakeReserved: boolean;
  settled: boolean;
}

export type XsBroadcastAdmit =
  | {
      ok: true;
      ticket: XsBroadcastTicket;
      /** Whole-broadcast wake decision (false after any downgrade). */
      wake: boolean;
      wakeDowngraded?: XsBroadcastWakeDowngrade;
      /** One per recipient, same order as `recipients`; `pair_wake_rate` downgrades a single row. */
      rows: ReadonlyArray<{ wake: boolean; wakeDowngraded?: "pair_wake_rate" }>;
    }
  | { ok: false; reason: XsBroadcastAdmitRefusal };

/** The frozen additions to `XsLimits` (src/web-hub/hub/xs/limits.ts, CH1). */
export interface XsLimitsBroadcast {
  /** All-or-nothing; a refusal consumes NOTHING (§5.2 step 4). */
  admitBroadcast(args: XsBroadcastAdmitArgs): XsBroadcastAdmit;
  /** Idempotent. Releases the in-flight slot ONLY — broadcast send counts and wake reservations are never refunded (§5.2 step 7). */
  settleBroadcast(ticket: XsBroadcastTicket): void;
}
