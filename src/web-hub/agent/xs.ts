/**
 * fabric phase-2 X2 (phase2-plan §8.1/§8.2/§4.6/§5.3): the agent-side cross-session bridge.
 *
 * Everything pi-/hub-facing about xs frames that is not the raw connection machine:
 *
 *  - `xs_member` slot publishing (§8.1) — the authoritative membership frame, stored through
 *    `connection.setSlot("xs", …)` so the slot machinery replays it on every `hello_ack`
 *    (X1-report §6 note 6: a member is only revived by a NEW `xs_member`; reconnects, hub
 *    restarts and post-detach re-attach all ride the replay). `epoch`/`joined`/`receive` come
 *    from X4's membership via the late-bound {@link XsStackPort}; the 7 sender limits are
 *    re-clamped defensively before the wire (X1-report §6 note 2: an out-of-bounds member
 *    frame is DROPPED by the hub's decoder — the settings parser already clamps, this is the
 *    second gate).
 *  - the `XsHubPort` adapter X3's sender needs (X3-report「端口」) — builds the `xs_req` frame
 *    (adding `t`/`rid`, passing `origin` through verbatim), rides `connection.request(frame,
 *    "xs.v1")` with the §8.2 deadline table (list/resolve/info 3s, send 8s), and normalizes
 *    transport failures to `{deadline|link_lost|off}`. X3 owns every effect decision — this
 *    module never fabricates an `xs_res`.
 *  - the `xs_deliver` hand-off to X4's receiver (§8.2) — synchronous, answering EXACTLY ONE
 *    `xs_ack` per deliver even when the stack is gone (`none{session_changed}`) or the
 *    receiver throws (`none{receiver_error}` — X4 guarantees a verdict, this is the belt).
 *  - `StatusInfo.xs` projection (§4.4 — display only), the `crossSession` HubConfig key
 *    (§4.6 global row), the agent `xs.v1` cap, and the two small ports X4's `/fabric` command
 *    needs (`resolveBlock` for `/fabric block`, `hubInfo` for the status view's hub-limits line).
 *
 * Boundary: `deps.xs` UNSET (xs off — the only state before XW wires it) ⇒ this module is never
 * constructed and the agent is byte-identical to the pre-xs shape (fabric-xs-off-golden.json).
 * No timers of its own (requests ride connection's unref'd deadline timers); never throws into
 * the connection machinery.
 */
import { effectiveReceive, isValidXsSessionId } from "../../config/settings.js";
import type { XsAckVerdict } from "../../fabric/xs/dedup.js";
import type {
  XsHubPort,
  XsPortListArgs,
  XsPortReply,
  XsPortResolveArgs,
  XsPortSendArgs,
} from "../../fabric/xs/sender.js";
import type { XsBlockResolve } from "../../commands/fabric-xs.js";
import { XS_AGENT_CAPS, XS_HUB_CAP, XS_REPLY_AGENT_CAP, XS_REPLY_HUB_CAP, XS_SLOT_KIND } from "../protocol/xs.js";
import type {
  XsDeliverFrame,
  XsHubLimitsWire,
  XsMemberFrame,
  XsMemberLimitsWire,
  XsReqFrame,
  XsResFrame,
  XsStatusWire,
} from "../protocol/xs.js";
import { newAdminRid, type HubConnection, type SlotFlush } from "./connection.js";

/** `XsHubPort` + the reply capability probe the sender consults before issuing `expectReply`. */
export interface XsReplyHubPort extends XsHubPort {
  send(args: XsPortSendArgs): Promise<XsPortReply>;
  /** True iff local reply is enabled AND the live hub link declared `xs.reply.v1`. */
  replyCapable(): boolean;
}

// --------------------------------------------------------------------- ports (XW threads these)

/** The per-stack view XW owns: X4's membership + receiver, re-read on EVERY call (the stack
 *  swaps on every session boundary; a captured instance would answer for a dead session). */
export interface XsStackPort {
  /** The stack's live session id — must equal the connection's current binding for a slot
   *  publish to make sense (the hub invalidates membership on any session change, §8.1). */
  sessionId(): string;
  /** Current membership state; `epoch` is X4's process-global counter (bumped at stack
   *  attach/join/leave — NOT at receive changes). */
  member(): { epoch: number; joined: boolean; receive: XsStatusWire["receive"] };
  /** X4's receiver pipeline — synchronous, returns the ack verdict even on internal failure. */
  deliver(frame: XsDeliverFrame): XsAckVerdict;
  /** `StatusInfo.xs` projection body (display only, §4.4). */
  status(): XsStatusWire;
  /** channel-plan §12 (IBP): unread inbox events of the stack's CURRENT session (IB1 `count`).
   *  Optional: absent ⇒ `StatusInfo.xsInbox` is never written. */
  unread?(): number;
}

/** What `wireWebHub` threads as `deps.xs` — presence IS `xsOn` (XW computes the switch at
 *  activate with XS0's `xsOn()`; unset ⇒ no xs surface anywhere on the agent). */
export interface XsAgentPort {
  /** The live stack, if any (undefined outside a session / before XW's stack build). */
  stack(): XsStackPort | undefined;
  /** Sender-side limits for `xs_member.limits` (§4.6 发送方会话 row) — already clamped by the
   *  settings parser; re-clamped here before the wire. */
  memberLimits(): XsMemberLimitsWire;
  /** Hub-global `hubSendsPerMin` (1..600) for `HubConfig.crossSession` (§4.6 全局 row). */
  hubSendsPerMin(): number;
  /** Reply-plan §5.1: `fabric.crossSession.reply.enabled` — unset ⇒ false (agent byte-identical
   *  to the pre-reply shape; the agent never advertises `xs.reply.v1`). */
  replyEnabled?(): boolean;
}

export interface XsAgentBridgeDeps {
  port: XsAgentPort;
  /** Late-bound connection accessor (agent/index.ts's `conn` closure variable). */
  conn(): HubConnection | undefined;
  /** Republishes the status slot (agent/index.ts's `publishStatus`); driven by
   *  `notifyUnreadChanged()` so IBW only has to say "the count changed". */
  publishStatus?(): void;
}

export interface XsAgentBridge {
  /** The agent-side caps to advertise in `hello.caps` while xs on (XS_AGENT_CAPS). */
  caps(): readonly string[];
  /** The `HubConfig.crossSession` value for `buildHubConfig` (never `undefined` — the port's
   *  `hubSendsPerMin` is clamped to its schema bounds before use). */
  hubCrossSessionConfig(): { limits: { hubSendsPerMin: number } };
  /** Connection `BindingPort.onXsDeliver` — answers EXACTLY ONE `xs_ack`, never throws. */
  onDeliver(frame: XsDeliverFrame): void;
  /** (Re)publish the `xs_member` slot for the CURRENT stack (attach, join/leave/receive
   *  changes, and the `onHubCaps` fresh-caps hook). No-op without a live connection object or
   *  a stack — the next attach/hello_ack republishes from fresh state. */
  publishMember(): void;
  /** `StatusInfo.xs` body, or undefined while there is no stack (field stays absent). */
  statusProjection(): XsStatusWire | undefined;
  /** `StatusInfo.xsInbox` body (§12.6): `{unread}` only while the stack port reports n>0
   *  (floored, saturated at 9999); undefined otherwise — the key must stay absent. */
  inboxProjection(): { unread: number } | undefined;
  /** IBW hook: call whenever the unread count may have changed; republishes status. Never throws. */
  notifyUnreadChanged(): void;
  /** X3's `XsHubPort` (list/resolve/send; one `xs_req` per call, no retry path) + reply probe. */
  hubPort(): XsReplyHubPort;
  /** Reply-plan §5.2/§r2#9: per-write slot transform for the `xs` and `status` slots — the stored
   *  frame stays raw; every write (live + hello_ack replay) downgrades `receive:"replies"` to
   *  `"off"` unless local reply is enabled AND the CURRENT hub declared `xs.reply.v1`. */
  slotFlush: SlotFlush;
  /** X4's `/fabric block` resolve port: hub `xs_req{op:"resolve"}` round trip mapped onto
   *  `XsBlockResolve` (see the class doc for the full-id derivation rules). */
  resolveBlock(query: string): Promise<XsBlockResolve>;
  /** X4's `/fabric status` hub-limits port: `xs_req{op:"info"}` (§4.6 — the hub's frozen
   *  effective globals); undefined when there is no stack or the hub did not answer. */
  hubInfo(): Promise<XsHubLimitsWire | undefined>;
}

// ------------------------------------------------------------- member-limit clamping (defensive)

/** `XsMemberLimitsSchema`'s min/max, mirrored here so the agent clamps exactly what the hub's
 *  decoder would otherwise reject the whole frame for (X1-report §6 note 2). */
const MEMBER_LIMIT_BOUNDS = {
  sendsOutPerMin: [1, 60],
  sendsOutPerHour: [1, 600],
  wakesOutPerHour: [0, 60],
  pairMinIntervalMs: [5_000, 600_000],
  pairWakesPerHour: [0, 20],
  inFlightPerSession: [1, 16],
  listPerMin: [1, 60],
} as const;

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function clampMemberLimits(l: XsMemberLimitsWire): XsMemberLimitsWire {
  return {
    sendsOutPerMin: clampInt(l.sendsOutPerMin, ...MEMBER_LIMIT_BOUNDS.sendsOutPerMin),
    sendsOutPerHour: clampInt(l.sendsOutPerHour, ...MEMBER_LIMIT_BOUNDS.sendsOutPerHour),
    wakesOutPerHour: clampInt(l.wakesOutPerHour, ...MEMBER_LIMIT_BOUNDS.wakesOutPerHour),
    pairMinIntervalMs: clampInt(l.pairMinIntervalMs, ...MEMBER_LIMIT_BOUNDS.pairMinIntervalMs),
    pairWakesPerHour: clampInt(l.pairWakesPerHour, ...MEMBER_LIMIT_BOUNDS.pairWakesPerHour),
    inFlightPerSession: clampInt(l.inFlightPerSession, ...MEMBER_LIMIT_BOUNDS.inFlightPerSession),
    listPerMin: clampInt(l.listPerMin, ...MEMBER_LIMIT_BOUNDS.listPerMin),
  };
}

// --------------------------------------------------------------------- the bridge

/** ref → full sessionId entries learned from `xs_deliver.from` (the one wire place a FULL id
 *  appears — hub resolve deliberately never returns one, X1 anti-enumeration). Bounded FIFO. */
const REF_MAP_CAP = 64;

export function createXsAgentBridge(deps: XsAgentBridgeDeps): XsAgentBridge {
  const refMap = new Map<string, string>();
  const replyEnabled = (): boolean => {
    try {
      return deps.port.replyEnabled?.() === true;
    } catch {
      return false;
    }
  };
  const hubHasReply = (): boolean => deps.conn()?.caps.includes(XS_REPLY_HUB_CAP) === true;

  const learnRef = (ref: string, sessionId: string): void => {
    if (ref === "" || sessionId === "") return;
    if (refMap.size >= REF_MAP_CAP && !refMap.has(ref)) {
      const first = refMap.keys().next().value;
      if (first !== undefined) refMap.delete(first);
    }
    refMap.set(ref, sessionId);
  };

  /** One `xs_req` round trip normalized to X3's reply union (§8.2 deadline table applied by
   *  `connection.request` itself; classification here is message-shape only). */
  const roundTrip = async (frame: XsReqFrame): Promise<XsPortReply> => {
    const conn = deps.conn();
    if (conn === undefined) return { kind: "link_lost" };
    try {
      const res: XsResFrame = await conn.request(frame, XS_HUB_CAP);
      return { kind: "res", res };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("E_NO_CAP")) {
        // A torn-down link surfaces here too (caps reset on teardown): live-without-the-cap is
        // `off` (E_XS_OFF{hub} — "/webhub restart"), everything else is link_lost.
        return conn.status().state === "live" ? { kind: "off" } : { kind: "link_lost" };
      }
      if (msg.startsWith("E_TIMEOUT")) return { kind: "deadline" };
      return { kind: "link_lost" }; // E_CONN_LOST / E_CLOSED / anything unexpected
    }
  };

  const originOf = (): { sessionId: string; epoch: number } | undefined => {
    const stack = deps.port.stack();
    if (stack === undefined) return undefined;
    const m = stack.member();
    return { sessionId: stack.sessionId(), epoch: m.epoch };
  };

  const reqOfList = (args: XsPortListArgs): XsReqFrame => ({
    t: "xs_req",
    rid: newAdminRid(),
    op: "list",
    origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
    ...(args.query !== undefined ? { query: args.query } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
  });
  const reqOfResolve = (args: XsPortResolveArgs): XsReqFrame => ({
    t: "xs_req",
    rid: newAdminRid(),
    op: "resolve",
    origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
    query: args.query,
  });
  const reqOfSend = (args: XsPortSendArgs): XsReqFrame => ({
    t: "xs_req",
    rid: newAdminRid(),
    op: "send",
    origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
    to: args.to,
    text: args.text,
    ...(args.wake === true ? { wake: true } : {}),
    ...(args.level !== undefined ? { level: args.level } : {}),
    // reply-plan §5.2: new fields only toward a hub that declared xs.reply.v1 (strict decoders drop whole frames)
    ...(args.expect !== undefined && hubHasReply() ? { expect: args.expect } : {}),
    ...(args.replyTo !== undefined && hubHasReply() ? { replyTo: args.replyTo } : {}),
  });

  const slotFlush: SlotFlush = (frame, hubCaps) => {
    const usable = replyEnabled() && hubCaps.includes(XS_REPLY_HUB_CAP);
    if (frame.t === "xs_member") {
      const m = frame as XsMemberFrame;
      if (m.receive !== "replies" || usable) return frame;
      return { ...m, receive: effectiveReceive(m.receive, false) } as XsMemberFrame;
    }
    if (frame.t === "status") {
      const xs = (frame as { xs?: XsStatusWire }).xs;
      if (xs === undefined || xs.receive !== "replies" || usable) return frame;
      return { ...frame, xs: { ...xs, receive: effectiveReceive(xs.receive, false) } } as typeof frame;
    }
    return frame;
  };

  return {
    slotFlush,

    caps: () => (replyEnabled() ? [...XS_AGENT_CAPS, XS_REPLY_AGENT_CAP] : XS_AGENT_CAPS),

    hubCrossSessionConfig: () => ({ limits: { hubSendsPerMin: clampInt(deps.port.hubSendsPerMin(), 1, 600) } }),

    onDeliver(frame) {
      // Learn the one full-id mapping the wire ever shows us (used by resolveBlock below).
      learnRef(frame.from.ref, frame.from.sessionId);
      let verdict: XsAckVerdict;
      const stack = deps.port.stack();
      try {
        verdict =
          stack === undefined
            ? { effect: "none", reason: "session_changed", woke: false } // detached/replaced stack
            : stack.deliver(frame);
      } catch {
        verdict = { effect: "none", reason: "receiver_error", woke: false }; // X4 never throws; belt
      }
      try {
        deps.conn()?.send({
          t: "xs_ack",
          rid: frame.rid,
          xid: frame.xid,
          effect: verdict.effect,
          ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
          ...(verdict.wakeDowngraded !== undefined ? { wakeDowngraded: verdict.wakeDowngraded } : {}),
          woke: verdict.woke,
        });
      } catch {
        /* the hub's own 5s registry deadline settles the in-flight deliver as unknown */
      }
    },

    publishMember() {
      const conn = deps.conn();
      const stack = deps.port.stack();
      if (conn === undefined || stack === undefined) return;
      const m = stack.member();
      const frame: XsMemberFrame = {
        t: "xs_member",
        sessionId: stack.sessionId(),
        epoch: m.epoch,
        joined: m.joined,
        receive: m.receive,
        limits: clampMemberLimits(deps.port.memberLimits()),
      };
      conn.setSlot(XS_SLOT_KIND, frame, slotFlush);
    },

    statusProjection() {
      const stack = deps.port.stack();
      if (stack === undefined) return undefined;
      try {
        return stack.status();
      } catch {
        return undefined;
      }
    },

    inboxProjection() {
      const stack = deps.port.stack();
      if (stack?.unread === undefined) return undefined;
      try {
        const n = stack.unread();
        if (!Number.isFinite(n)) return undefined;
        const u = Math.min(9999, Math.trunc(n));
        return u >= 1 ? { unread: u } : undefined;
      } catch {
        return undefined;
      }
    },

    notifyUnreadChanged() {
      try {
        deps.publishStatus?.();
      } catch {
        /* display hint only */
      }
    },

    hubPort(): XsReplyHubPort {
      return {
        list: (args) => roundTrip(reqOfList(args)),
        resolve: (args) => roundTrip(reqOfResolve(args)),
        send: (args) => roundTrip(reqOfSend(args)),
        replyCapable: () => replyEnabled() && deps.conn()?.status().state === "live" && hubHasReply(),
      };
    },

    async resolveBlock(query) {
      const origin = originOf();
      if (origin === undefined) return { ok: false, kind: "offline" };
      const reply = await roundTrip({
        t: "xs_req",
        rid: newAdminRid(),
        op: "resolve",
        origin,
        query,
      });
      if (reply.kind !== "res") {
        // unreachable hub (link_lost / no connection) ⇒ offline; wedge/cap ⇒ error — X4 treats
        // both identically (fall through to the full-id-only offline rule).
        return { ok: false, kind: reply.kind === "link_lost" ? "offline" : "error" };
      }
      const res = reply.res;
      if (!res.ok) {
        if (res.code === "E_XS_AMBIGUOUS") {
          return {
            ok: false,
            kind: "ambiguous",
            ...(res.candidates !== undefined ? { candidates: res.candidates } : {}),
          };
        }
        return { ok: false, kind: "no_target" }; // NO_TARGET / BAD_TARGET / rate / anything else
      }
      if (res.candidates !== undefined && res.target === undefined) {
        return { ok: false, kind: "ambiguous", candidates: res.candidates };
      }
      if (res.target === undefined) return { ok: false, kind: "no_target" };
      const ref = res.target.ref;
      const name = res.target.name;
      // ① the query itself is the full id and the hub matched it (exact-match precedence) —
      //    the §5.3 main flow: the user copied the full id from the OTHER session's status.
      if (isValidXsSessionId(query) && query.length >= 8 && query.startsWith(ref)) {
        return { ok: true, sessionId: query, ...(name !== undefined ? { name } : {}) };
      }
      // ② a full id learned from a delivery this process received (the "block whoever just
      //    messaged me" path — `xs_deliver.from` is the only wire place a full id appears).
      const learned = refMap.get(ref);
      if (learned !== undefined && learned.startsWith(ref)) {
        return { ok: true, sessionId: learned, ...(name !== undefined ? { name } : {}) };
      }
      // ③ the wire hides the full id (X1's anti-enumeration): fall back to the 12-char ref.
      //    The stored entry matches no sender (senderAllowed compares FULL ids) — ineffective
      //    but harmless, visible in /fabric blocks and unblockable, the same tolerance class
      //    as X4's own offline long-name rule (X4-report deviation 3).
      return { ok: true, sessionId: ref, ...(name !== undefined ? { name } : {}) };
    },

    async hubInfo() {
      const origin = originOf();
      if (origin === undefined) return undefined;
      const reply = await roundTrip({
        t: "xs_req",
        rid: newAdminRid(),
        op: "info",
        origin,
      });
      if (reply.kind !== "res" || !reply.res.ok) return undefined;
      return reply.res.hubLimits;
    },
  };
}
