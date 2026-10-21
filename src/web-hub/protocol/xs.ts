import { Type, type TSchema } from "@sinclair/typebox";

/**
 * fabric phase-2 XS0 (phase2-plan §4.2/§8.1/§8.2): the FROZEN cross-session frame contract —
 * schemas, cap constants, deadline constants, error codes and the effect/reason/downgrade
 * enums. Everything routing-shaped (hub dispatch, registry `xs_ack` settlement, agent-side
 * `xs_res`/`xs_deliver` handling) belongs to X1/X2; this module only declares the wire.
 *
 * Reply association (§8.2, frozen here — implemented by X1/X2):
 *   - `xs_req{rid}` → `xs_res{rid}` on the SAME socket; agent-side `connection.request()`
 *     settles the pending by `rid` in its `xs_res` case; deadline per op (below).
 *   - `xs_deliver{rid}` → exactly ONE `xs_ack{rid}`; the hub's `registry.request` settles its
 *     pending in the registry `onFrame`'s `xs_ack` case. An ack without a pending (hub already
 *     timed out) only counts `xs_late_ack`, never logs the body.
 *   - `xs_member` is a SLOT frame (no reply; replayed on reconnect by the slot machinery).
 *
 * Boundary: `src/web-hub/protocol/**` stays pi-free and dependency-free
 * (tests/web-hub/boundary.test.ts) — node:* + typebox only.
 */

// ----------------------------------------------------------------- caps (§4.5/E1, P9: cap only, no PROTO bump)

/** Hub-side cap: advertised on BOTH hub cap surfaces iff `HubConfig.crossSession` exists (key
 *  absence IS off — same pattern as every other gated HubConfig feature). */
export const XS_HUB_CAP = "xs.v1";
/** Agent-side cap: advertised in `hello.caps` iff `xsOn` (fabric ∧ crossSession ∧ webHub ∧ control). */
export const XS_AGENT_CAPS = ["xs.v1"] as const;
/** The slot kind the `xs_member` frame rides (X2 appends it to SLOT_ORDER right after "session"). */
export const XS_SLOT_KIND = "xs" as const;

// ----------------------------------------------------------------- deadlines & sizes (§8.2/XI7)

/** Hub stamps `xs_deliver.expiresAt = hubNow + XS_EXPIRES_MS`; receivers judge with their own
 *  clock (same machine, same uid — one clock domain). Constant, not a setting. */
export const XS_EXPIRES_MS = 5_000;
/** The hub-side `registry.request` deadline for one `xs_deliver` (§8.2). */
export const XS_HUB_DELIVER_MS = 5_000;
/**
 * Agent-side `connection.request` deadlines per `xs_req` op (§8.2): send's 8s = hub admission
 * (synchronous, <1s) + XS_HUB_DELIVER_MS 5s + 2s headroom, so a healthy hub's `xs_res` always
 * beats the client deadline; the client deadline only fires on a dead/wedged hub and yields
 * `unknown{client_deadline}`.
 */
export const XS_REQ_DEADLINE_MS = { list: 3_000, resolve: 3_000, info: 3_000, send: 8_000 } as const;

/** Per-frame hard byte cap for every `xs_*` frame (§5.2): the hub REJECTS oversize sends with
 *  `E_XS_TOO_LARGE` — no truncation (the sender owns `fabric.maxChars` truncation). */
export const XS_MAX_FRAME_BYTES = 16 * 1024;

/** list projection row cap (§5.1). */
export const XS_LIST_MAX_ROWS = 20;
/** resolve: shortest accepted sessionId prefix (§5.1/#14). */
export const XS_RESOLVE_PREFIX_MIN = 8;
/** resolve: max ambiguity candidates (§5.1). */
export const XS_RESOLVE_MAX_CANDIDATES = 5;

/** `xs_req` op set (§8.2). */
export type XsReqOp = "list" | "resolve" | "send" | "info";

/** Deadline lookup for `connection.request()` (X2 wires this into its deadline table). */
export function xsReqDeadlineMs(op: XsReqOp): number {
  return XS_REQ_DEADLINE_MS[op];
}

/** Serialized-length guard for xs frames (stricter than the global ndjson frame budget). */
export function xsFrameBytesOk(raw: unknown): boolean {
  try {
    return JSON.stringify(raw).length <= XS_MAX_FRAME_BYTES;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- error codes (§8)

/** Stable error codes for `xs_res{ok:false}` / tool refusals. Details ride `code`'s brace
 *  suffix convention (`E_XS_OFF{hub}`) where the plan names one. */
export type XsErrorCode =
  | "E_XS_OFF" // the surface is off on this side (detail `{hub}`: hub lacks/lost the cap)
  | "E_XS_BAD_FRAME" // structurally invalid xs frame (incl. `from.run` — phase-3 field, §4.2)
  | "E_XS_BAD_TARGET" // reserved address form (root/system/main/r_…/@…/wf_…, §4.3)
  | "E_XS_NO_TARGET" // unknown / not-an-effective-member target (indistinguishable, XI5)
  | "E_XS_AMBIGUOUS" // two effective members hold the same sessionId (XR5)
  | "E_XS_STALE_ORIGIN" // origin{sessionId,epoch} does not match the socket's current member (§8.1)
  | "E_XS_TOO_LARGE" // frame exceeds XS_MAX_FRAME_BYTES
  | "E_XS_INTERNAL"; // handler exception (X1's catch-all; logs carry no body)

// ----------------------------------------------------------------- effect / reason / downgrade enums

/** Delivery outcome triple (phase-1 W4 vocabulary; evidence table §6.3/§8.3, XI11). */
export type XsEffect = "applied" | "none" | "unknown";

/** Fence names carried by `none{fenced:<name>}` (§7.2). */
export type XsFenceName = "compaction" | "tree" | "switch" | "web_exec" | "topic_switch" | "goal";

/**
 * `effect:"none"` reasons — the action provably did NOT happen (r3 M2: a reason lands here ONLY
 * when observed BEFORE the send/dispatch point; everything after is `unknown`).
 */
export type XsNoneReason =
  | "rejected" // receiver policy: not joined / receive off / allowFrom / blocklist (§8.4.3)
  | "expired" // expiresAt already past (§8.4.1)
  | "dedup_full" // dedup table full — refuse, never evict a live entry (§9)
  | "session_changed" // to.sessionId/epoch mismatch at the receiver (§8.4.4)
  | `fenced:${XsFenceName}` // session-change fence window open (§7)
  | "inbound_rate" // recvPerHour exhausted (§8.4.6)
  | "inbox_full" // cross-session inbox at inboxCap (§8.4.6)
  | "host_rejected" // pi.sendMessage threw synchronously — proof of no effect (§6.3)
  | "origin_changed" // sender guard failed BEFORE the send frame left (§8.1)
  | "receiver_error"; // receiver pipeline threw BEFORE dispatch (M2 — post-dispatch is unknown)

/**
 * `effect:"unknown"` reasons — the message may have taken effect; the tool text must tell the
 * model NOT to blindly resend.
 */
export type XsUnknownReason =
  | "queued" // receiver streaming; message sits in pi's in-memory queue (Fpi7, N2)
  | "start_deferred" // Controller dispatched but pi deferred the run start (Fpi5)
  | "accept_unverified" // deliver-only: leaf entry was not this message (§6.3)
  | "origin_changed_after_send" // sender's origin changed AFTER the send — keep the remote result if any (r3 M2)
  | "receiver_error" // receiver pipeline threw AFTER dispatch (M2)
  | "client_deadline" // agent-side request deadline fired (hub dead/wedged)
  | "link_lost"; // agent socket link torn down with the request pending

/**
 * Why a `wake:true` degraded to deliver-only (§4.5 truth table, §4.6 hub-side reservations,
 * N1, r3 B1). English tokens only — these surface in tool results verbatim.
 */
export type XsWakeDowngraded =
  | "wake_disabled" // receiver's fabric.wake.enabled false
  | "controller_disabled" // rootRunMaxS === 0
  | "host_unverified" // capability unknown (N1: first prompt not yet seen)
  | "host_unsupported" // capability absent (pi 1.0/1.1 shape)
  | "receiver_policy" // session receive is "deliver" (or off ⇒ none{rejected} instead)
  | "busy" // receiver not idle / Controller slot occupied
  | "goal" // /goal loop running on the receiver (wake-only downgrade)
  | "level_limit" // hop not allowed at this maxLevel
  | "inbound_wake_rate" // receiver wakesInPerHour exhausted
  | "outbound_wake_rate" // sender wakesOutPerHour exhausted (hub reservation)
  | "pair_wake_rate" // pairWakesPerHour exhausted (hub reservation)
  | "sender_wake_disabled" // SENDER's fabric.wake.enabled false (local downgrade, §4.5)
  | "ledger_full"; // wake ledger at capacity — refuse new wakes, never evict (r3 B1)

// ----------------------------------------------------------------- wire shapes

/** Receive policy as carried on `xs_member` / `StatusInfo.xs` (P2: joined default is wake). */
export type XsReceiveWire = "off" | "deliver" | "wake";

/**
 * Sender-side limits that ride `xs_member.limits` (§4.6 发送方会话 row). The schema's
 * min/max ARE the clamping bounds the hub applies to a member's declared limits (same uid
 * processes are trusted; clamping only contains config accidents). Receiver-side and
 * hub-global limits never ride the wire.
 */
export const XsMemberLimitsSchema = Type.Object(
  {
    sendsOutPerMin: Type.Integer({ minimum: 1, maximum: 60 }),
    sendsOutPerHour: Type.Integer({ minimum: 1, maximum: 600 }),
    wakesOutPerHour: Type.Integer({ minimum: 0, maximum: 60 }),
    pairMinIntervalMs: Type.Integer({ minimum: 5_000, maximum: 600_000 }),
    pairWakesPerHour: Type.Integer({ minimum: 0, maximum: 20 }),
    inFlightPerSession: Type.Integer({ minimum: 1, maximum: 16 }),
    listPerMin: Type.Integer({ minimum: 1, maximum: 60 }),
  },
  { additionalProperties: false },
);
export interface XsMemberLimitsWire {
  sendsOutPerMin: number;
  sendsOutPerHour: number;
  wakesOutPerHour: number;
  pairMinIntervalMs: number;
  pairWakesPerHour: number;
  inFlightPerSession: number;
  listPerMin: number;
}

const SessionIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const IdSchema = Type.String({ minLength: 1, maxLength: 64 });
const EpochSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ReceiveSchema = Type.Union([Type.Literal("off"), Type.Literal("deliver"), Type.Literal("wake")]);
const EffectSchema = Type.Union([Type.Literal("applied"), Type.Literal("none"), Type.Literal("unknown")]);
const ReasonSchema = Type.String({ minLength: 1, maxLength: 64 });
const WakeDowngradedSchema = Type.String({ minLength: 1, maxLength: 48 });
const OriginSchema = Type.Object({ sessionId: SessionIdSchema, epoch: EpochSchema }, { additionalProperties: false });

/** §8.1: authoritative membership slot (agent→hub, replayed on reconnect; epoch bumps on
 *  attach/join/leave — NOT on receive changes, so in-flight requests keep their epoch). */
export const XsMemberSchema = Type.Object(
  {
    t: Type.Literal("xs_member"),
    sessionId: SessionIdSchema,
    epoch: EpochSchema,
    joined: Type.Boolean(),
    receive: ReceiveSchema,
    limits: XsMemberLimitsSchema,
  },
  { additionalProperties: false },
);
export interface XsMemberFrame {
  t: "xs_member";
  sessionId: string;
  epoch: number;
  joined: boolean;
  receive: XsReceiveWire;
  limits: XsMemberLimitsWire;
}

/** §8.2: agent→hub request. `origin` is re-validated by the hub against the socket's CURRENT
 *  member record (three-way bind, XI4); every other identity field the frame might carry is
 *  ignored. `level` is the sender's root causal level (absent ⇒ sender wake off). */
export const XsReqSchema = Type.Object(
  {
    t: Type.Literal("xs_req"),
    rid: IdSchema,
    op: Type.Union([Type.Literal("list"), Type.Literal("resolve"), Type.Literal("send"), Type.Literal("info")]),
    origin: OriginSchema,
    query: Type.Optional(Type.String({ maxLength: 128 })),
    scope: Type.Optional(Type.Union([Type.Literal("hub"), Type.Literal("cwd")])),
    to: Type.Optional(Type.String({ maxLength: 128 })),
    text: Type.Optional(Type.String({ maxLength: 16_384 })), // the 16 KiB frame byte cap (XS_MAX_FRAME_BYTES) is the operative limiter; schema stays permissive so oversize is a byte-cap reject, not a silent schema drop
    wake: Type.Optional(Type.Boolean()),
    level: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })),
  },
  { additionalProperties: false },
);
export interface XsReqFrame {
  t: "xs_req";
  rid: string;
  op: XsReqOp;
  origin: { sessionId: string; epoch: number };
  query?: string;
  scope?: "hub" | "cwd";
  to?: string;
  text?: string;
  wake?: boolean;
  level?: number;
}

/** One `xs_res{rows}` row (§4.3 list projection — no agentKey, pid, tools or model). */
export interface XsSessionRowWire {
  ref: string;
  name?: string;
  cwdLabel: string;
  kind: string;
  receive: "deliver" | "wake";
  busy: boolean;
  lastActiveAgoS: number;
}

/** One `xs_res{candidates}` entry (ref + optional name only — anti-enumeration, §5.1). */
export interface XsResolveCandidateWire {
  ref: string;
  name?: string;
}

/** §4.6: `xs_req{op:"info"}` reply body — the hub's frozen-at-start effective global limits. */
export interface XsHubLimitsWire {
  hubSendsPerMin: number;
  expiresMs: number;
  deliverMs: number;
}

/** §8.2: hub→agent reply to `xs_req` (settled by rid in connection's `xs_res` case). */
export const XsResSchema = Type.Object(
  {
    t: Type.Literal("xs_res"),
    rid: IdSchema,
    ok: Type.Boolean(),
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    effect: Type.Optional(EffectSchema),
    reason: Type.Optional(ReasonSchema),
    wakeDowngraded: Type.Optional(WakeDowngradedSchema),
    rows: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }), { maxItems: XS_LIST_MAX_ROWS })),
    candidates: Type.Optional(
      Type.Array(Type.Object({}, { additionalProperties: true }), { maxItems: XS_RESOLVE_MAX_CANDIDATES }),
    ),
    target: Type.Optional(Type.Object({}, { additionalProperties: true })),
    hubLimits: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { additionalProperties: false },
);
export interface XsResFrame {
  t: "xs_res";
  rid: string;
  ok: boolean;
  code?: string;
  effect?: XsEffect;
  reason?: string;
  wakeDowngraded?: XsWakeDowngraded;
  rows?: XsSessionRowWire[];
  candidates?: XsResolveCandidateWire[];
  target?: { ref: string; name?: string };
  hubLimits?: XsHubLimitsWire;
}

/**
 * §8.1: hub→agent delivery. `from` is STAMPED by the hub (four-way bind, XI4) — a frame
 * carrying any other identity field, or a `from.run` (phase-3 only, §4.2), fails the strict
 * schema and is silently ignored by decode (never routed).
 */
export const XsDeliverSchema = Type.Object(
  {
    t: Type.Literal("xs_deliver"),
    rid: IdSchema,
    xid: IdSchema,
    to: OriginSchema,
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
    text: Type.String({ maxLength: 16_384 }), // see xs_req.text: byte cap governs
    wake: Type.Boolean(),
    level: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })),
    expiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export interface XsDeliverFrame {
  t: "xs_deliver";
  rid: string;
  xid: string;
  to: { sessionId: string; epoch: number };
  from: { sessionId: string; ref: string; name?: string; cwdLabel: string; agentId: string };
  text: string;
  wake: boolean;
  level?: number;
  expiresAt: number;
}

/** §8.2: agent→hub settlement of one `xs_deliver` — the receiver pipeline answers EXACTLY ONE
 *  ack per deliver, synchronously, even on exception (`unknown{receiver_error}`, M2). */
export const XsAckSchema = Type.Object(
  {
    t: Type.Literal("xs_ack"),
    rid: IdSchema,
    xid: IdSchema,
    effect: EffectSchema,
    reason: Type.Optional(ReasonSchema),
    wakeDowngraded: Type.Optional(WakeDowngradedSchema),
    woke: Type.Boolean(),
  },
  { additionalProperties: false },
);
export interface XsAckFrame {
  t: "xs_ack";
  rid: string;
  xid: string;
  effect: XsEffect;
  reason?: string;
  wakeDowngraded?: XsWakeDowngraded;
  woke: boolean;
}

/** Schema-map fragments `messages.ts` folds into its agent/hub decode tables (XS0 wiring:
 * decoding is inert — nothing routes an xs frame until X1/X2). */
export const XS_AGENT_FRAME_SCHEMAS: Readonly<Record<string, TSchema>> = {
  xs_member: XsMemberSchema,
  xs_req: XsReqSchema,
  xs_ack: XsAckSchema,
};
export const XS_HUB_FRAME_SCHEMAS: Readonly<Record<string, TSchema>> = {
  xs_res: XsResSchema,
  xs_deliver: XsDeliverSchema,
};

// ----------------------------------------------------------------- StatusInfo.xs (§4.4, P3: read-only display)

/** Display-only projection riding the status slot; the hub's list/send authorization NEVER
 *  reads it (#4 — authoritative membership is the `xs_member` slot). */
export const XsStatusSchema = Type.Object(
  {
    joined: Type.Boolean(),
    receive: ReceiveSchema,
    blocked: Type.Integer({ minimum: 0, maximum: 64 }),
  },
  { additionalProperties: false },
);
export interface XsStatusWire {
  joined: boolean;
  receive: XsReceiveWire;
  blocked: number;
}
