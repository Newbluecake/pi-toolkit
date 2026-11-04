import { Type } from "@sinclair/typebox";
import type { XsFenceName } from "./xs.js";

/**
 * fabric-xs-activation plan §3 P0 (arch §4.1/§4.4/§4.5/§4.7): the FROZEN wire contract of the
 * cross-session request-progress axis (`xs.state.v1`) and the idempotent activation ops
 * (`xs.activate.v1`). This module only DECLARES shapes, enums, caps and pure helpers — nothing
 * routes a frame until P1 (xs_state) / P3 (xs_activate / xs_activate_ack / the new xs_req ops).
 *
 * Boundary: `src/web-hub/protocol/**` stays pi-free and dependency-free
 * (tests/web-hub/boundary.test.ts) — node:* + typebox only; `./xs.js` is imported TYPE-ONLY so
 * `xs.ts` may value-import this module (field schemas, deadline constants) without a runtime
 * import cycle.
 *
 * I10 (append-only wire): every schema here is strict (`additionalProperties:false`) and every
 * field is new — old ops/frames/key orders are untouched. The new `xs_req` ops (`receipt` /
 * `activate`) and their payload fields are sent ONLY to a peer that declared the matching cap:
 * an old hub's strict `XsReqSchema` would silently drop such a frame (the alias-op precedent,
 * AL0b). Reasons are append-only tokens: the wire fields stay bounded strings so an unknown
 * reason displays generically and never drops the frame (arch §4.7).
 *
 * Hygiene (arch §4.7): no state frame ever carries body text, hashes, wake tokens, IPs or raw
 * exceptions — ids/enums/timestamps only. frame ≤16 KiB (the `xs_` prefix check in messages.ts
 * decode), id ≤64, sessionId ≤128, reason tokens ≤64 (wake reasons ≤48), integers safe
 * non-negative.
 */

// ----------------------------------------------------------------- caps (plan §1; arch §3.2)

/** Hub-side state cap: advertised on BOTH hub cap surfaces iff `HubConfig.crossSession` exists
 *  ∧ the `crossSession.activation` key is present (key absence IS off — the agent writes the key
 *  only while effective; P1 threads the dual-surface advertisement). */
export const XS_STATE_HUB_CAP = "xs.state.v1";
/** Agent-side state cap: appended after the frozen `XS_AGENT_CAPS` tail in `hello.caps` iff
 *  effective (`xsOn ∧ fabric.crossSession.activation.enabled`; P1 wires it). Declared even while
 *  local wake is off — the phase/reason axis explains a downgrade without waking anyone. */
export const XS_STATE_AGENT_CAP = "xs.state.v1";
/** Hub-side activate cap: same key-presence condition as {@link XS_STATE_HUB_CAP}. */
export const XS_ACTIVATE_HUB_CAP = "xs.activate.v1";
/** Agent-side activate cap: effective ∧ local wake on (`fabric.wake.enabled`; the hub may still
 *  refuse at policy time — the cap is the schema gate, never authorization). */
export const XS_ACTIVATE_AGENT_CAP = "xs.activate.v1";

// ----------------------------------------------------------------- xs_req ops: shape + deadlines (arch §4.4/§4.7)

/** The two new `xs_req` ops. `receipt` is a strictly read-only progress query (3s); `activate`
 *  carries NO text ever (8s) — it targets an already-delivered messageId bound to an
 *  activationKey (U6). Sent only to a hub advertising the matching cap. */
export type XsActivationReqOp = "receipt" | "activate";
/** Agent-side `connection.request` deadline for `xs_req{op:"receipt"}` — a pure read (list-tier). */
export const XS_RECEIPT_DEADLINE_MS = 3_000;
/** Agent-side `connection.request` deadline for `xs_req{op:"activate"}` — hub admission + the
 *  5s target relay + headroom (same budget derivation as `send`). */
export const XS_ACTIVATE_REQ_DEADLINE_MS = 8_000;
/** Hub stamps `xs_activate.expiresAt = hubNow + XS_ACTIVATE_RELAY_EXPIRY_MS`; receivers judge
 *  with their own clock (same machine, same uid — one clock domain, `XS_EXPIRES_MS` posture). */
export const XS_ACTIVATE_RELAY_EXPIRY_MS = 5_000;

/** `xs_req.messageId` — the ORIGINAL body's hub xid (never a q-id/rid/wakeToken/runId; arch
 *  §4.1). Mounted as a trailing optional prop on `XsReqSchema` (xs.ts, alias-op precedent):
 *  only the `receipt`/`activate` ops ever carry it. */
export const XsReqMessageIdSchema = Type.String({ minLength: 1, maxLength: 64 });
/** `xs_req.activationKey` — the key the original receipt issued; NOT a bearer authorization (the
 *  hub re-validates source process/sid, target, channel and the receiver's stamped `from`). */
export const XsReqActivationKeySchema = Type.String({ minLength: 1, maxLength: 64 });

// ----------------------------------------------------------------- progress axis (arch §4.1)

/** Remote-body progress phases (U1) — monotone: a snapshot keeps the furthest proven fact;
 *  `offline`/miss/stale-revision never regress a phase (P1's merge rules, pinned there). */
export const XS_PHASES = ["queued", "delivered", "started", "replied"] as const;
export type XsPhase = (typeof XS_PHASES)[number];
/** Delivery-evidence triple for a progress snapshot — same vocabulary as `XsEffect` but a
 *  DISTINCT axis: `unknown` may later rise to `applied`; a timeout never rewrites it to `none`. */
export const XS_EVIDENCES = ["none", "unknown", "applied"] as const;
export type XsEvidence = (typeof XS_EVIDENCES)[number];
/** Where the wake story stopped being a plain deliver (arch §4.8 — the stage rides the reason). */
export type XsWakeStage = "sender" | "hub" | "receiver" | "host";
/** The wake-execution axis (arch §3.2/§4.1) — independent of the body's phase/evidence. */
export const XS_WAKE_DECISIONS = ["deliver_only", "downgraded", "dispatch_accepted", "unknown"] as const;
export type XsWakeDecision = (typeof XS_WAKE_DECISIONS)[number];
/** Terminal wake-run outcomes (root-wake ended states; arch §4.1). */
export const XS_WAKE_ENDINGS = ["settled", "aborted", "deadline", "stuck"] as const;
export type XsWakeEnding = (typeof XS_WAKE_ENDINGS)[number];

/** The wake view of ONE original send: what was requested, what the first real stopper was
 *  (stage + decision + reason), and how the authorized run ended. `defaulted` is a SOURCE-private
 *  fact (U2's human-delegated default) a remote peer must never overwrite. */
export interface XsWakeView {
  requested: boolean;
  defaulted?: boolean;
  stage?: XsWakeStage;
  decision: XsWakeDecision;
  reason?: string;
  authorizedAt?: number;
  ended?: XsWakeEnding;
  /** Only an authoritative quota source fills this — unknown stays absent, never 0. */
  retryAfterAt?: number;
}

/** Reply-ticket state mirrored onto a progress snapshot (pending until the reply is confirmed
 *  WRITTEN into the requester's session; late/timed_out/invalidated stay independent, arch §4.1). */
export const XS_REPLY_STATES = ["pending", "timed_out", "late", "invalidated"] as const;
export type XsReplyState = (typeof XS_REPLY_STATES)[number];
/** Observation continuity of the reporter (arch §4.1): `unavailable` (hub restart / tracking
 *  full / scan over budget) never fabricates evidence — activate fail-closes on it. */
export const XS_OBSERVATIONS = ["live", "offline", "expired", "unavailable"] as const;
export type XsObservation = (typeof XS_OBSERVATIONS)[number];

const IdSchema = Type.String({ minLength: 1, maxLength: 64 });
const SessionIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const EpochSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const TsSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const RevisionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ReasonSchema = Type.String({ minLength: 1, maxLength: 64 });
const WakeReasonSchema = Type.String({ minLength: 1, maxLength: 48 });

/** Wire schema of {@link XsWakeView} (strict). */
export const XsWakeViewSchema = Type.Object(
  {
    requested: Type.Boolean(),
    defaulted: Type.Optional(Type.Boolean()),
    stage: Type.Optional(
      Type.Union([Type.Literal("sender"), Type.Literal("hub"), Type.Literal("receiver"), Type.Literal("host")]),
    ),
    decision: Type.Union([
      Type.Literal("deliver_only"),
      Type.Literal("downgraded"),
      Type.Literal("dispatch_accepted"),
      Type.Literal("unknown"),
    ]),
    reason: Type.Optional(WakeReasonSchema),
    authorizedAt: Type.Optional(TsSchema),
    ended: Type.Optional(
      Type.Union([Type.Literal("settled"), Type.Literal("aborted"), Type.Literal("deadline"), Type.Literal("stuck")]),
    ),
    retryAfterAt: Type.Optional(TsSchema),
  },
  { additionalProperties: false },
);

/** One original send's progress snapshot (arch §4.1, field-for-field). `messageId` is the
 *  original body's hub xid; `revision` is monotone per receiver process × messageId; `entryId`
 *  is display-only (the branch entry a real xid match found). No body/hash/token ever rides it. */
export interface XsProgress {
  messageId: string;
  revision: number;
  deliveryEffect: XsEvidence;
  phase?: XsPhase;
  queuedAt?: number;
  deliveredAt?: number;
  startedAt?: number;
  repliedAt?: number;
  requestId?: string;
  replyState?: XsReplyState;
  observation: XsObservation;
  /** Body/observation reason — independent of the wake reason (`wake.reason`). */
  reason?: string;
  wake: XsWakeView;
  activationKey?: string;
  activationUntil?: number;
  entryId?: string;
}

const PhaseSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("delivered"),
  Type.Literal("started"),
  Type.Literal("replied"),
]);
const EvidenceSchema = Type.Union([Type.Literal("none"), Type.Literal("unknown"), Type.Literal("applied")]);

/** Wire schema of {@link XsProgress} (strict). */
export const XsProgressSchema = Type.Object(
  {
    messageId: IdSchema,
    revision: RevisionSchema,
    deliveryEffect: EvidenceSchema,
    phase: Type.Optional(PhaseSchema),
    queuedAt: Type.Optional(TsSchema),
    deliveredAt: Type.Optional(TsSchema),
    startedAt: Type.Optional(TsSchema),
    repliedAt: Type.Optional(TsSchema),
    requestId: Type.Optional(IdSchema),
    replyState: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("timed_out"),
        Type.Literal("late"),
        Type.Literal("invalidated"),
      ]),
    ),
    observation: Type.Union([
      Type.Literal("live"),
      Type.Literal("offline"),
      Type.Literal("expired"),
      Type.Literal("unavailable"),
    ]),
    reason: Type.Optional(ReasonSchema),
    wake: XsWakeViewSchema,
    activationKey: Type.Optional(IdSchema),
    activationUntil: Type.Optional(TsSchema),
    entryId: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);

// ----------------------------------------------------------------- xs_state (arch §4.7, receiver→hub / hub→source)

/**
 * The progress frame — BOTH directions: receiver→hub (the receiver's evidence; the hub verifies
 * socket/xid/sid/revision and NEVER trusts a receiver-reported source) and hub→source (the
 * mirrored snapshot; `sourceRid` is the hub-relation-linked request id, absent receiver-side).
 * Sent only between peers that both declared `xs.state.v1`; inert until P1 routes it.
 */
export const XsStateSchema = Type.Object(
  {
    t: Type.Literal("xs_state"),
    ...XsProgressSchema.properties,
    sourceRid: Type.Optional(IdSchema),
  },
  { additionalProperties: false },
);
export interface XsStateFrame extends XsProgress {
  t: "xs_state";
  /** hub→source only: the hub relation's source rid (never receiver-written). */
  sourceRid?: string;
}

// ----------------------------------------------------------------- activate status/reason enums (arch §4.4)

/** `xs_activate_ack.status` / the wake_session outcome status (closed, arch §4.4 verbatim).
 *  `accepted` = the CONTROL action was submitted (the body may still be only `delivered`);
 *  `already_started`/`already_replied` are none no-ops; `unsupported` = a peer lacks the cap
 *  (old hub / old agent — never simulated with body text). */
export const XS_ACTIVATE_STATUSES = [
  "accepted",
  "already_active",
  "already_started",
  "already_replied",
  "refused",
  "unknown",
  "unsupported",
] as const;
export type XsActivateStatus = (typeof XS_ACTIVATE_STATUSES)[number];

/**
 * Known `reason` tokens for a refused/unknown activate (append-only documentation union — the
 * WIRE field stays a bounded string so new tokens display generically, never drop the frame).
 * Quota refusals ride `wakeDowngraded` + `retryAfterAt`, not this list.
 */
export type XsActivateReason =
  | "expired" // trackUntil passed / the key's ticket lapsed before quota recovered (arch §4.6)
  | "not_tracked" // no relation record for the messageId (tracking full at send / hub restart)
  | "not_delivered" // the original body was never confirmed delivered — nothing to activate (U6)
  | "stale_key" // the key does not match the relation's issued key
  | `fenced:${XsFenceName}` // a mutation fence rejected the ingress (goal only downgrades wake)
  | "receiver_policy" // receive/allowFrom/block/channel re-validation refused
  | "host_unsupported"; // the host shape cannot take the control marker

// ----------------------------------------------------------------- xs_activate / xs_activate_ack (arch §4.4/§4.5/§4.7)

/**
 * hub→receiver control relay for `xs_req{op:"activate"}` (inert until P3). `from` is STAMPED by
 * the hub (mirrors `xs_deliver.from` minus the alias field — activate addresses a pinned full
 * sessionId, never a name) and must match the relation's original source. NEVER carries text —
 * the fixed marker content is host-side (arch §4.5), so the schema has no text field at all.
 */
export const XsActivateSchema = Type.Object(
  {
    t: Type.Literal("xs_activate"),
    rid: IdSchema,
    to: Type.Object({ sessionId: SessionIdSchema, epoch: EpochSchema }, { additionalProperties: false }),
    from: Type.Object(
      {
        sessionId: SessionIdSchema,
        ref: Type.String({ minLength: 1, maxLength: 16 }),
        name: Type.Optional(Type.String({ maxLength: 120 })),
        cwdLabel: Type.String({ maxLength: 120 }),
        agentId: Type.String({ maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    messageId: IdSchema,
    activationKey: IdSchema,
    expiresAt: TsSchema,
    level: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })),
  },
  { additionalProperties: false },
);
export interface XsActivateFrame {
  t: "xs_activate";
  rid: string;
  to: { sessionId: string; epoch: number };
  from: { sessionId: string; ref: string; name?: string; cwdLabel: string; agentId: string };
  messageId: string;
  activationKey: string;
  expiresAt: number;
  /** The CALLER's current causal level — never the original human's old 0 (arch §4.6). */
  level?: number;
}

/**
 * receiver→hub settlement of one `xs_activate` — EXACTLY ONE ack per relay, matched by the
 * pending `rid` (a late ack without a pending only counts a diagnostic, `xs_ack` posture).
 * `effect` is the CONTROL action's effect (none/unknown/applied), never the body's; `progress`
 * is the latest snapshot the receiver had (arch §4.4's `XsActivateOutcome.progress`).
 */
export const XsActivateAckSchema = Type.Object(
  {
    t: Type.Literal("xs_activate_ack"),
    rid: IdSchema,
    messageId: IdSchema,
    activationKey: IdSchema,
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("already_active"),
      Type.Literal("already_started"),
      Type.Literal("already_replied"),
      Type.Literal("refused"),
      Type.Literal("unknown"),
      Type.Literal("unsupported"),
    ]),
    effect: EvidenceSchema,
    reason: Type.Optional(ReasonSchema),
    wakeDowngraded: Type.Optional(WakeReasonSchema),
    retryable: Type.Boolean(),
    retryAfterAt: Type.Optional(TsSchema),
    dup: Type.Optional(Type.Literal(true)),
    progress: Type.Optional(XsProgressSchema),
  },
  { additionalProperties: false },
);
export interface XsActivateAckFrame {
  t: "xs_activate_ack";
  rid: string;
  messageId: string;
  activationKey: string;
  status: XsActivateStatus;
  effect: XsEvidence;
  reason?: string;
  wakeDowngraded?: string;
  retryable: boolean;
  retryAfterAt?: number;
  /** True when this ack settled an idempotent repeat (no new attempt was made). */
  dup?: true;
  progress?: XsProgress;
}

// ----------------------------------------------------------------- StatusInfo.xsRequests (arch §4.7/§4.9)

/** Row cap of the status slot = the per-side progress-bag cap (receiver/source cap256, arch
 *  §1.2) — the slot never grows past the bag it projects. */
export const XS_REQUESTS_MAX_ROWS = 256;

/** The open top-level `StatusInfo.xsRequests` slot: this session's tracked request rows, merged
 *  by session/process/messageId/revision. Written ONLY by a state-capable live link while this
 *  session has records — absent ⇒ byte-equal to the pre-feature status frame (P1's publish gate).
 *  `omitted` counts rows dropped for the cap (display hint, never a correctness claim). */
export const XsRequestsStatusSchema = Type.Object(
  {
    sessionId: SessionIdSchema,
    revision: RevisionSchema,
    rows: Type.Array(XsProgressSchema, { maxItems: XS_REQUESTS_MAX_ROWS }),
    omitted: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
  { additionalProperties: false },
);
export interface XsRequestsStatusWire {
  sessionId: string;
  /** Monotone per publishing process — ordering scope for out-of-order HTTP/ctl merges. */
  revision: number;
  rows: XsProgress[];
  omitted?: number;
}

// ----------------------------------------------------------------- trackUntil pure helpers (arch §4.5)

/** Plain (non-expect) tracking window: 30 min from the relay. */
export const XS_TRACK_DEFAULT_MS = 30 * 60_000;

/** Inputs of {@link xsTrackUntilMs} — the hub relation's tracking deadline (pure computation;
 *  the relation store itself is P1's `hub/xs/activation.ts`). */
export interface XsTrackUntilArgs {
  /** Relation creation time (= the original send's relay admission). */
  createdAt: number;
  /** Present iff the original send carried `expectReply` — the ticket span rides the relation. */
  expect?: { timeoutMs: number; lateGraceMs: number };
  /** Frozen `fabric.crossSession.reply.maxTimeoutS` in ms — the tracking ceiling. */
  replyMaxTimeoutMs: number;
  /** Frozen `fabric.crossSession.reply.lateGraceS` in ms (ceiling component). */
  replyLateGraceMs: number;
}

const finiteNonNeg = (n: number): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * `trackUntil = createdAt + clampSpanMs(expect ? timeoutMs + lateGraceMs : 30min)`, ceiling
 * `reply.maxTimeoutS + lateGraceS` (arch §4.5) — `activationUntil` equals it (no separate TTL).
 * Pure and total: malformed inputs never yield NaN — a malformed span falls back to the plain
 * 30-min window, a malformed ceiling is ignored (uncapped), timestamps floor at 0. This mirrors
 * `clampSpanMs` (core/deadline.ts) locally: protocol cannot import it (I8 boundary).
 */
export function xsTrackUntilMs(args: XsTrackUntilArgs): number {
  const at = finiteNonNeg(args.createdAt);
  const ceiling =
    finiteNonNeg(args.replyMaxTimeoutMs) > 0
      ? finiteNonNeg(args.replyMaxTimeoutMs) + finiteNonNeg(args.replyLateGraceMs)
      : Number.POSITIVE_INFINITY;
  let span = XS_TRACK_DEFAULT_MS;
  if (args.expect !== undefined) {
    const spanRaw = finiteNonNeg(args.expect.timeoutMs) + finiteNonNeg(args.expect.lateGraceMs);
    if (spanRaw > 0) span = spanRaw;
  }
  return at + Math.floor(Math.min(span, ceiling));
}

/** Expiry judgment: an expired packet is refused FIRST, then lazily cleaned (arch §4.5) — a
 *  fresh key does not extend it. Pure, total. */
export function xsTrackOpen(trackUntil: number, now: number): boolean {
  return finiteNonNeg(now) < finiteNonNeg(trackUntil);
}
