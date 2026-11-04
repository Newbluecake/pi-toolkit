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
 * Never throws into the connection machinery. Timers: requests ride connection's unref'd deadline
 * timers; the AF3 auto-claim retry below is the one own timer (unref'd, clampSpanMs-clamped, I1/I5).
 *
 * Alias-force-default plan §5 (AF3, #72), layered on the AL3 alias bridge:
 *  - the `xs.alias.v2` agent cap (immediately after v1, same `aliasEnabled()` condition);
 *  - the `intent` ops (`auto` / `forcePreview` / `handoff`) — `intent`/`prevSessionId` go ONLY to a
 *    hub that declared `xs.alias.v2` (a v1 hub's strict decoder would drop the whole frame, S1);
 *  - the cwd-basename auto-claim engine at the END of a reconcile (attach / hello_ack / join's
 *    refreshAlias): only after an APPLIED `state:"none"` get, gated by AF0's pure `shouldAutoClaim`,
 *    one attempt per `(connGen, sessionId, membershipEpoch)`, one bounded (1–5s) retry on
 *    BUSY{queue|io}; success notifies once via the INDEPENDENT process set
 *    `pi-subagent:xs-alias-auto-noticed` (≤32 sids FIFO — never shares the lost set's 64, r2#10);
 *  - `onAliasEvt` (the hub's `xs_alias_evt` nudge for the CURRENT sid ⇒ reconcile; a `lost{forced}`
 *    rides the existing one-shot lost path with the §7 forced wording).
 */
import { clampSpanMs } from "../../core/deadline.js";
import { effectiveReceive, isValidXsSessionId } from "../../fabric/xs/receive.js";
import { deriveAutoAlias, shouldAutoClaim } from "../../fabric/xs/alias-auto.js";
import type { XsAckVerdict } from "../../fabric/xs/dedup.js";
import { channelsFieldToWrite, linkJoined as channelLinkJoined, XS_DEFAULT_CHANNEL } from "../../fabric/xs/channel.js";
import type { XsChannelView } from "../../fabric/xs/types-channel.js";
import type {
  XsHubPort,
  XsOriginSnapshot,
  XsPortBroadcastArgs,
  XsPortChannelsArgs,
  XsPortListArgs,
  XsPortReply,
  XsPortResolveArgs,
  XsPortSendArgs,
} from "../../fabric/xs/sender.js";
import type { XsBlockResolve } from "../../commands/fabric-xs.js";
import type {
  XsAliasAutoSkipReason,
  XsAliasBridgePortV2,
  XsAliasBridgeResult,
  XsAliasCacheEntry,
  XsAliasCachePort,
} from "../../fabric/xs/types-alias.js";
import {
  XS_AGENT_CAPS,
  XS_ALIAS_AGENT_CAP,
  XS_ALIAS_HUB_CAP,
  XS_ALIAS_TAKE_PREVIEW,
  XS_ALIAS_V2_AGENT_CAP,
  XS_ALIAS_V2_HUB_CAP,
  XS_CHANNEL_AGENT_CAP,
  XS_CHANNEL_HUB_CAP,
  XS_HUB_CAP,
  XS_REPLY_AGENT_CAP,
  XS_REPLY_HUB_CAP,
  XS_SLOT_KIND,
} from "../protocol/xs.js";
import type {
  XsAliasEvtFrame,
  XsAliasIntent,
  XsAliasStateWire,
  XsDeliverFrame,
  XsHubLimitsWire,
  XsMemberFrame,
  XsMemberLimitsWire,
  XsReqFrame,
  XsResFrame,
  XsStatusWire,
} from "../protocol/xs.js";
import type { XsPortActivateReply } from "../../fabric/xs/session-activation.js";
import {
  XS_ACTIVATE_AGENT_CAP,
  XS_ACTIVATE_HUB_CAP,
  XS_RECEIPT_DEADLINE_MS,
  XS_REQUESTS_MAX_ROWS,
  XS_STATE_AGENT_CAP,
  XS_STATE_HUB_CAP,
  type XsProgress,
  type XsWakeView,
  type XsActivateAckFrame,
  type XsActivateFrame,
  type XsRequestsStatusWire,
  type XsStateFrame,
} from "../protocol/xs-activation.js";
import { XsProgressBag, XS_PROGRESS_CAP } from "../../fabric/xs/progress.js";
import { newAdminRid, type HubConnection, type SlotFlush } from "./connection.js";

/** `XsHubPort` + the reply capability probe the sender consults before issuing `expectReply`. */
export interface XsReplyHubPort extends XsHubPort {
  send(args: XsPortSendArgs): Promise<XsPortReply>;
  /** True iff local reply is enabled AND the live hub link declared `xs.reply.v1`. */
  replyCapable(): boolean;
  /** True iff local channels are enabled AND the live hub link declared `xs.channel.v1`. */
  channelCapable?(): boolean;
  /** fabric-xs-activation P1 (arch §4.4): the strictly read-only progress query — one
   *  `xs_req{op:"receipt"}` (3s list-tier deadline, cap-prechecked by `connection.request`);
   *  the hub answers `xs_res` and pushes the snapshot as an `xs_state` frame the waiter here
   *  correlates by messageId. Zero side effects; absent ⇒ the op does not exist yet. */
  receipt?(args: { messageId: string; activationKey?: string }): Promise<XsPortReceipt>;
  /** fabric-xs-activation P3: true iff local activation is effective ∧ local wake on
   *  (`XsAgentPort.activateEnabled`) ∧ the LIVE hub declared `xs.activate.v1`. */
  activateCapable?(): boolean;
  /** fabric-xs-activation P3 (arch §4.4): ONE `xs_req{op:"activate"}` (8s) — never carries text.
   *  `not_sent` ⇒ provably never left (no link / no cap); a deadline/link loss after the frame
   *  left is NOT `none` (the caller maps it to unknown). */
  activate?(args: {
    origin: XsOriginSnapshot;
    to?: string;
    messageId: string;
    activationKey: string;
    level?: number;
  }): Promise<XsPortActivateReply>;
}

/** fabric-xs-activation P1: the receipt result (arch §4.4's `{status, messageId, progress?}` —
 *  `unsupported` = the capability chain is off (local or hub); `unavailable` = not tracked /
 *  expired / link trouble; NEVER a fabricated snapshot). */
export interface XsPortReceipt {
  status: "known" | "unavailable" | "unsupported";
  messageId: string;
  progress?: XsProgress;
}

// --------------------------------------------------------------------- ports (XW threads these)

/** fabric-xs-activation P1: the receiver-side progress surface the bridge consumes through
 *  `XsStackPort.progress` (StackXs implements it in `fabric/xs/stack.ts`; presence IS
 *  `fabric.crossSession.activation.enabled`, frozen at stack build). */
export interface XsStackProgressPort {
  /** Every evidence change (created/merged writes only — stale/full are invisible). */
  subscribe(cb: (progress: XsProgress) => void): () => void;
  /** A solicited reply was confirmed written in this session (requester-side `replied`). */
  subscribeReplyWritten(cb: (requestId: string, at: number) => void): () => void;
  rows(): XsProgress[];
  snapshot(messageId: string): XsProgress | undefined;
}

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
  /** fabric-xs-activation P1: receiver-side progress evidence (absent ⇒ activation off /
   *  pre-feature stack — the bridge pushes and mirrors nothing). */
  progress?: XsStackProgressPort;
  /** fabric-xs-activation P3: the receiver half of `xs_activate` (synchronous, never throws,
   *  exactly one ack). Absent ⇒ activation is not effective on this stack. */
  activation?: { handle(frame: XsActivateFrame): XsActivateAckFrame };
  /** channel-plan §12 (IBP): unread inbox events of the stack's CURRENT session (IB1 `count`).
   *  Optional: absent ⇒ `StatusInfo.xsInbox` is never written. */
  unread?(): number;
  /** channel-plan §2.3 (CH2): the live channel view (CH3's membership). Optional: absent ⇒ the
   *  member/status frames stay byte-identical to the pre-channel shape (effective = joined ? [default] : []). */
  channelView?(): XsChannelView;
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
  /** Channel-plan §3.1: `fabric.crossSession.channels.enabled` — unset ⇒ false (no `xs.channel.v1`
   *  cap, no channel keys anywhere; byte-identical to the pre-channel agent). */
  channelsEnabled?(): boolean;
  /** Channel-plan §3.1: hub-global broadcast params for `HubConfig.crossSession.channels`; only
   *  consulted while `channelsEnabled()`. Absent ⇒ the key is not written (hub defaults, never "off"). */
  channelsHubConfig?(): { maxRecipients: number; wakeMaxRecipients: number } | undefined;
  /** Alias-plan §3.6 (AL3): `fabric.crossSession.alias.enabled` — unset ⇒ false (no `xs.alias.v1` cap, no
   *  alias frames/fields anywhere; byte-identical to the pre-alias agent). Non-live: ALW freezes it at activate. */
  aliasEnabled?(): boolean;
  /** Alias-plan §3.6: hub-global alias params for `HubConfig.crossSession.alias`; only consulted while
   *  `aliasEnabled()`. Absent ⇒ the key is not written (hub defaults, never "off"). */
  aliasHubConfig?(): { offlineLeaseH: number; coolMin: number; takeMinOfflineMin: number } | undefined;
  /** fabric-xs-activation plan §3 P1 (arch §3.2): effective = `xsOn ∧
   *  fabric.crossSession.activation.enabled`, frozen per activate (non-live). ABSENT ⇒ false:
   *  no `xs.state.v1` cap, no `HubConfig.crossSession.activation` key, no state frames — the
   *  agent stays byte-identical to the pre-feature build (key-absence-is-off on the hub). */
  activationEnabled?(): boolean;
  /** fabric-xs-activation P3 (arch §3.2): `activation effective ∧ fabric.wake.enabled`, frozen per
   *  activate (non-live). ABSENT ⇒ false: no `xs.activate.v1` cap is declared and no activate
   *  op/frame is ever sent or answered (byte-identical to the P1/P2 agent). */
  activateEnabled?(): boolean;
  /** Alias-plan §4 (Q3): display-only one-shot notice text (the bridge already de-duplicated it process-wide
   *  by `(sessionId, lost.at)`). ALW wires it to `ctx.ui.notify`. Never throws into the bridge. */
  notifyAliasLost?(text: string): void;
  /** Alias-force-default plan §5.1 (AF3): the cwd-basename auto-claim inputs. ABSENT ⇒ the auto engine
   *  never fires and records nothing (the pre-AFW wiring stays byte-identical). `enabled` is the frozen
   *  `fabric.crossSession.alias.autoFromCwd`; `cwd`/`home`/`tmpdir` feed AF0's `deriveAutoAlias`;
   *  `decided` is the I8 human-decided marker (AF4 writes it before any human alias write op, AFW reads
   *  it back); `handoffPending` is true while AF7's `/new` alias handoff is still pending. Every read is live
   *  and must be cheap and non-throwing — the bridge fail-closes (treats a throw as "do not auto"). */
  aliasAuto?():
    | {
        readonly enabled: boolean;
        readonly cwd: string | undefined;
        readonly home: string | undefined;
        readonly tmpdir: string | undefined;
        decided(sessionId: string): boolean;
        handoffPending(): boolean;
      }
    | undefined;
  /** Alias-force-default AF7 (§5.5): the `/new` alias handoff still owed to the hub for session `sessionId`. `pending`
   *  is `undefined` once expired / consumed / superseded by a human decision on the new session; `settle()` clears it
   *  (called the moment an attempt starts — one attempt per `/new`, whatever the outcome). ABSENT ⇒ no handoff ever
   *  (alias off, child, secure). Independent of `aliasAuto` (works with `autoFromCwd=false`). Never throws into the bridge. */
  aliasHandoff?():
    | {
        pending(sessionId: string): { alias: string; prevSessionId: string } | undefined;
        settle(): void;
      }
    | undefined;
  /** Alias-force-default plan §7 (AF3): display-only one-shot "auto-claimed" notice text (the bridge
   *  de-duplicates process-wide by sessionId in `pi-subagent:xs-alias-auto-noticed`, ≤32 FIFO).
   *  AFW wires it like {@link notifyAliasLost}. Never throws into the bridge. */
  notifyAliasAuto?(text: string): void;
}

export interface XsAgentBridgeDeps {
  port: XsAgentPort;
  /** Late-bound connection accessor (agent/index.ts's `conn` closure variable). */
  conn(): HubConnection | undefined;
  /** agent/index.ts's attach-generation counter (AF3: one leg of the auto-claim dedup key
   *  `(connGen, sessionId, membershipEpoch)`). Absent ⇒ 0 (tests / pre-AF3 wiring). */
  connGen?(): number;
  /** AF3: randomness for the 1–5s BUSY retry delay (defaults to `Math.random`; tests inject). */
  random?(): number;
  /** Republishes the status slot (agent/index.ts's `publishStatus`); driven by
   *  `notifyUnreadChanged()` so IBW only has to say "the count changed". */
  publishStatus?(): void;
}

export interface XsAgentBridge {
  /** The agent-side caps to advertise in `hello.caps` while xs on (XS_AGENT_CAPS). */
  caps(): readonly string[];
  /** The `HubConfig.crossSession` value for `buildHubConfig` (never `undefined` — the port's
   *  `hubSendsPerMin` is clamped to its schema bounds before use). */
  hubCrossSessionConfig(): {
    limits: { hubSendsPerMin: number };
    channels?: { maxRecipients: number; wakeMaxRecipients: number };
    alias?: { offlineLeaseH: number; coolMin: number; takeMinOfflineMin: number };
    /** fabric-xs-activation P1: written ONLY while effective — key-absence-is-off on the hub
     *  (no relation bag, no activation caps, byte-identical hub). */
    activation?: true;
  };
  /** Connection `BindingPort.onXsDeliver` — answers EXACTLY ONE `xs_ack`, never throws. */
  onDeliver(frame: XsDeliverFrame): void;
  /** Connection `BindingPort.onXsActivate` — answers EXACTLY ONE `xs_activate_ack`, never throws.
   *  Inert (no answer, no side effect) unless activation is effective ∧ wake on. */
  onActivate(frame: XsActivateFrame): void;
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
  /** Alias-plan §4/§5 (AL3) + alias-force-default §3.2 (AF3): the `op:"alias"` bridge (bounded 5s; zero
   *  frames unless alias on ∧ hub declared `xs.alias.v1`). Always the same object; `supported` is read
   *  live. The v2 methods (`auto`/`forcePreview`/`handoff`) ADDITIONALLY require the live hub's
   *  `xs.alias.v2` — toward a v1 hub they send nothing and answer `E_XS_OFF{hub-v2}` (§3.4). */
  aliasBridge(): XsAliasBridgePortV2;
  /** Alias-force-default §5.4 (AF3): `xs_alias_evt` handler — a frame for the CURRENT sessionId triggers
   *  a reconcile (the forced `lost` notice rides the one-shot path); any other sid is ignored.
   *  Fire-and-forget, never throws. */
  onAliasEvt(frame: XsAliasEvtFrame): void;
  /** Alias-force-default §7 (AF3): the last recorded `auto skip:<token>` reason for the CURRENT session
   *  (AF4 renders it in `/fabric status`; `undefined` ⇒ no suffix — e.g. autoFromCwd off, alias held, or
   *  never evaluated). Display only. */
  aliasAutoSkip(): XsAliasAutoSkipReason | undefined;
  /** Alias-plan §4: the agent-side alias cache (per bridge = per activate, keyed by sessionId, ≤8 FIFO,
   *  never persisted). Always the same object. */
  aliasCache(): XsAliasCachePort;
  /** `onHubCaps` hook (every hello_ack): reconcile the cache against the hub. Fire-and-forget, never throws. */
  onHubCapsAlias(): void;
  /** fabric-xs-activation P1: hub→source `xs_state` — merge the snapshot into the source-side
   *  mirror, resolve a pending receipt waiter (by messageId) and republish the status slot.
   *  Never throws; a `defaulted` field is never adopted (source-private). */
  onState(frame: XsStateFrame): void;
  /** fabric-xs-activation P1: the `StatusInfo.xsRequests` body — ONLY while effective AND the
   *  mirror holds rows for the CURRENT session (absent ⇒ the status frame stays byte-equal). */
  requestsProjection(): XsRequestsStatusWire | undefined;
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
  broadcastsOutPerHour: [0, 60],
  broadcastMinIntervalMs: [10_000, 3_600_000],
  broadcastWakesOutPerHour: [0, 2],
} as const;

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** `withBroadcast` ⇔ the member frame carries named channels (§3.2: the three broadcast keys are
 *  never written for default-only). */
function clampMemberLimits(l: XsMemberLimitsWire, withBroadcast: boolean): XsMemberLimitsWire {
  const bc: Partial<XsMemberLimitsWire> = {};
  if (withBroadcast) {
    const B = MEMBER_LIMIT_BOUNDS;
    if (l.broadcastsOutPerHour !== undefined)
      bc.broadcastsOutPerHour = clampInt(l.broadcastsOutPerHour, ...B.broadcastsOutPerHour);
    if (l.broadcastMinIntervalMs !== undefined)
      bc.broadcastMinIntervalMs = clampInt(l.broadcastMinIntervalMs, ...B.broadcastMinIntervalMs);
    if (l.broadcastWakesOutPerHour !== undefined)
      bc.broadcastWakesOutPerHour = clampInt(l.broadcastWakesOutPerHour, ...B.broadcastWakesOutPerHour);
  }
  return {
    sendsOutPerMin: clampInt(l.sendsOutPerMin, ...MEMBER_LIMIT_BOUNDS.sendsOutPerMin),
    sendsOutPerHour: clampInt(l.sendsOutPerHour, ...MEMBER_LIMIT_BOUNDS.sendsOutPerHour),
    wakesOutPerHour: clampInt(l.wakesOutPerHour, ...MEMBER_LIMIT_BOUNDS.wakesOutPerHour),
    pairMinIntervalMs: clampInt(l.pairMinIntervalMs, ...MEMBER_LIMIT_BOUNDS.pairMinIntervalMs),
    pairWakesPerHour: clampInt(l.pairWakesPerHour, ...MEMBER_LIMIT_BOUNDS.pairWakesPerHour),
    inFlightPerSession: clampInt(l.inFlightPerSession, ...MEMBER_LIMIT_BOUNDS.inFlightPerSession),
    listPerMin: clampInt(l.listPerMin, ...MEMBER_LIMIT_BOUNDS.listPerMin),
    ...bc,
  };
}

/** The effective channel set a stored member/status frame stands for (§3.2: `channels` absent ≡
 *  `joined ? [default] : []`). */
function frameChannels(channels: readonly string[] | undefined, joined: boolean): string[] {
  return channels !== undefined ? [...channels] : joined ? [XS_DEFAULT_CHANNEL] : [];
}

function hasBroadcastKeys(l: XsMemberLimitsWire): boolean {
  return (
    l.broadcastsOutPerHour !== undefined ||
    l.broadcastMinIntervalMs !== undefined ||
    l.broadcastWakesOutPerHour !== undefined
  );
}

function stripBroadcastKeys(l: XsMemberLimitsWire): XsMemberLimitsWire {
  const { broadcastsOutPerHour: _a, broadcastMinIntervalMs: _b, broadcastWakesOutPerHour: _c, ...rest } = l;
  return rest;
}

// --------------------------------------------------------------------- the bridge

/** ref → full sessionId entries learned from `xs_deliver.from` (the one wire place a FULL id
 *  appears — hub resolve deliberately never returns one, X1 anti-enumeration). Bounded FIFO. */
const REF_MAP_CAP = 64;

/** Alias-plan §4: cache bound and the process-wide "you lost your alias" notice de-dup set. */
const ALIAS_CACHE_CAP = 8;
const ALIAS_LOST_SEEN_CAP = 64;
const ALIAS_LOST_KEY = Symbol.for("pi-subagent:xs-alias-lost");
/** Alias-force-default §5.1 (AF3): the INDEPENDENT process-wide auto-claim notice de-dup set
 *  (r2#10 — never shares the lost set's 64 cap), the per-bridge tried-key bound, the per-bridge
 *  skip-reason bound, and the BUSY retry delay band (clamped through `clampSpanMs`, I1). */
const ALIAS_AUTO_NOTICED_CAP = 32;
const ALIAS_AUTO_NOTICED_KEY = Symbol.for("pi-subagent:xs-alias-auto-noticed");
const ALIAS_AUTO_TRIED_CAP = 64;
const ALIAS_AUTO_SKIP_CAP = 8;
const ALIAS_AUTO_RETRY_MIN_MS = 1_000;
const ALIAS_AUTO_RETRY_SPAN_MS = 4_000;

function aliasAutoNoticed(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let set = g[ALIAS_AUTO_NOTICED_KEY];
  if (set === undefined) {
    set = new Set<string>();
    g[ALIAS_AUTO_NOTICED_KEY] = set;
  }
  return set;
}

/** True the FIRST time this sessionId's auto-claim is noticed in this process (FIFO-bounded, sids only). */
function markAliasAutoNoticed(sessionId: string): boolean {
  const seen = aliasAutoNoticed();
  if (seen.has(sessionId)) return false;
  if (seen.size >= ALIAS_AUTO_NOTICED_CAP) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  seen.add(sessionId);
  return true;
}

function aliasLostSeen(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let set = g[ALIAS_LOST_KEY];
  if (set === undefined) {
    set = new Set<string>();
    g[ALIAS_LOST_KEY] = set;
  }
  return set;
}

/** True the FIRST time `(sessionId, at)` is seen in this process (FIFO-bounded, keys only). */
function markAliasLost(sessionId: string, at: number): boolean {
  const seen = aliasLostSeen();
  const key = `${sessionId}:${at}`;
  if (seen.has(key)) return false;
  if (seen.size >= ALIAS_LOST_SEEN_CAP) {
    const first = seen.values().next().value;
    if (first !== undefined) seen.delete(first);
  }
  seen.add(key);
  return true;
}

function aliasLostText(lost: { alias: string; reason: "taken" | "expired"; forced?: boolean }): string {
  // alias-force-default §7 (AF3): a forced take carries `forced:true` on the tombstone (v2 hubs only).
  if (lost.forced === true)
    return `别名「${lost.alias}」已被其他会话强制抢占（对方已人工确认），可以用 /fabric alias 重新设置`;
  const why = lost.reason === "taken" ? "已被其他会话抢占" : "离线超过保留期后被他人认领";
  return `别名「${lost.alias}」${why}，可以用 /fabric alias 重新设置`;
}

export function createXsAgentBridge(deps: XsAgentBridgeDeps): XsAgentBridge {
  const refMap = new Map<string, string>();
  const replyEnabled = (): boolean => {
    try {
      return deps.port.replyEnabled?.() === true;
    } catch {
      return false;
    }
  };
  const channelsEnabled = (): boolean => {
    try {
      return deps.port.channelsEnabled?.() === true;
    } catch {
      return false;
    }
  };
  const hubHasChannel = (): boolean => deps.conn()?.caps.includes(XS_CHANNEL_HUB_CAP) === true;
  const hubHasReply = (): boolean => deps.conn()?.caps.includes(XS_REPLY_HUB_CAP) === true;
  const aliasEnabled = (): boolean => {
    try {
      return deps.port.aliasEnabled?.() === true;
    } catch {
      return false;
    }
  };
  const hubHasAlias = (): boolean => deps.conn()?.caps.includes(XS_ALIAS_HUB_CAP) === true;
  /** AF3: the live hub declared `xs.alias.v2` (understands `intent`, pushes `xs_alias_evt`). */
  const hubHasAliasV2 = (): boolean => deps.conn()?.caps.includes(XS_ALIAS_V2_HUB_CAP) === true;
  /** fabric-xs-activation P1: effective (frozen per activate — the port is XW/P2 wiring; absent
   *  ⇒ false ⇒ no cap, no hub key, no state frames, byte-identical agent). */
  const activationEnabled = (): boolean => {
    try {
      return deps.port.activationEnabled?.() === true;
    } catch {
      return false;
    }
  };
  /** P3: `activation effective ∧ wake on` (frozen per activate; absent ⇒ false ⇒ no cap/op/frame). */
  const activateEnabled = (): boolean => {
    try {
      return activationEnabled() && deps.port.activateEnabled?.() === true;
    } catch {
      return false;
    }
  };
  /** P3: the live hub link declared `xs.activate.v1`. */
  const hubHasActivate = (): boolean => deps.conn()?.caps.includes(XS_ACTIVATE_HUB_CAP) === true;
  /** P1: the live hub link declared `xs.state.v1`. */
  const hubHasState = (): boolean => deps.conn()?.caps.includes(XS_STATE_HUB_CAP) === true;

  // -------------------------------------------- source-side progress mirror (fabric-xs-activation P1)

  /** The SOURCE-side mirror bag (per bridge = per activate): merged from `xs_state` pushes and
   *  the receiver-stack subscriptions. `defaulted` is source-private — remote merges never set
   *  it (progress.ts guarantees); local marks (P2's U2 default) overlay without changing receiver revision. Replaced
   *  (not cleared) on a session switch — a new session's tracking epoch inherits nothing. */
  let mirror = new XsProgressBag(XS_PROGRESS_CAP);
  /** The sessionId the mirror currently speaks for (a switch replaces the bag, arch §4.2
   *  "new/fork/switch ⇒ not inherited"). */
  let mirrorSessionId: string | undefined;
  /** Monotone projection revision — one per publishing process (arch §4.7). */
  let mirrorRevision = 0;
  /** One-shot receipt waiters by messageId (the hub's answer push correlates on it). */
  // Only live sends, keyed by the EXACT original rid; no text/latest-row correlation.
  const sourceWakeMarks = new Map<string, { sessionId: string; wake: XsWakeView }>();
  const withSourceWake = (row: XsProgress): XsProgress => {
    const mark = sourceWakeMarks.get(row.messageId);
    if (!mark || mark.sessionId !== deps.port.stack()?.sessionId()) return row;
    const stop = mark.wake.reason !== undefined;
    return {
      ...row,
      wake: {
        ...row.wake,
        requested: mark.wake.requested,
        ...(mark.wake.defaulted ? { defaulted: true } : {}),
        ...(stop
          ? {
              ...(mark.wake.reason ? { reason: mark.wake.reason } : {}),
              ...(mark.wake.stage ? { stage: mark.wake.stage } : {}),
              decision: "downgraded" as const,
            }
          : mark.wake.decision === "dispatch_accepted" && row.wake.reason === undefined
            ? { decision: "dispatch_accepted" as const }
            : {}),
      },
    };
  };
  const sendProgress = new Map<string, { origin: XsOriginSnapshot; wake?: XsWakeView; progress?: XsProgress }>();
  const receiptWaiters = new Map<string, (progress: XsProgress) => void>();
  /** The stack whose progress subscriptions are currently wired (re-subscribe on stack swap). */
  let wiredProgressStack: XsStackProgressPort | undefined;
  let unwireProgress: (() => void) | undefined;
  let unwireReplyWritten: (() => void) | undefined;

  /** Push one receiver-side evidence snapshot to the hub (`xs_state`, receiver→hub). Cap-gated
   *  both ways; fire-and-forget — a missed push costs a later re-sync (receipt), never truth. */
  const pushState = (progress: XsProgress): void => {
    const conn = deps.conn();
    if (conn === undefined || !activationEnabled() || !hubHasState()) return;
    const { sourceRid: _never, ...snapshot } = progress as XsProgress & { sourceRid?: string };
    try {
      conn.send({ t: "xs_state", ...snapshot });
    } catch {
      /* link gone — the hub's receipt re-syncs on demand */
    }
  };

  /** Requester-side `replied` (arch §4.1): the stack's reply pipeline confirmed a solicited
   *  reply written HERE — mark every mirror row bound to that requestId. Local observation
   *  (may set source-private facts); never pushed upstream (the hub verifies the sender side
   *  of a relation, and the source socket is not it). */
  const markReplyWritten = (requestId: string, at: number): void => {
    if (!activationEnabled()) return;
    for (const row of mirror.rows(Date.now())) {
      if (row.requestId !== requestId || row.phase === "replied") continue;
      const write = mirror.observe(row.messageId, { phase: "replied", repliedAt: at }, at);
      if (write.kind === "created" || write.kind === "merged") mirrorRevision++;
    }
  };

  /** (Re)wire the stack subscriptions whenever a (possibly new) stack is in view — driven from
   *  `onDeliver`/`publishMember` (both fire per stack attach); idempotent per port instance. */
  const wireProgress = (): void => {
    if (!activationEnabled()) return;
    const stack = deps.port.stack();
    const port = stack?.progress;
    if (port === undefined || port === wiredProgressStack) return;
    unwireProgress?.();
    unwireReplyWritten?.();
    wiredProgressStack = port;
    unwireProgress = port.subscribe(pushState);
    unwireReplyWritten = port.subscribeReplyWritten(markReplyWritten);
    const sid = stack?.sessionId();
    if (sid !== undefined && sid !== mirrorSessionId) {
      // A session SWITCH starts a FRESH tracking epoch — old rows never relabel onto the new
      // sid. The FIRST wiring (no previous sid) adopts without dropping: states may legitimately
      // arrive before the first deliver/attach hook (the hub pushes on its own initiative).
      if (mirrorSessionId !== undefined) {
        mirror = new XsProgressBag(XS_PROGRESS_CAP);
        sourceWakeMarks.clear();
        sendProgress.clear();
      }
      mirrorSessionId = sid;
    }
  };

  /** fabric-xs-activation P1 (arch §4.4): one read-only receipt round trip. The waiter is
   *  registered BEFORE the request (the hub's `xs_state` answer push cannot race past it) and
   *  the total wait stays inside the 3s list-tier deadline; the timer is unref'd (I5). */
  const receiptRoundTrip = async (args: { messageId: string; activationKey?: string }): Promise<XsPortReceipt> => {
    const unsupported: XsPortReceipt = { status: "unsupported", messageId: args.messageId };
    const unavailable: XsPortReceipt = { status: "unavailable", messageId: args.messageId };
    if (!activationEnabled()) return unsupported;
    const conn = deps.conn();
    if (conn === undefined) return unavailable;
    if (!hubHasState()) return conn.status().state === "live" ? unsupported : unavailable;
    const origin = originOf();
    if (origin === undefined) return unavailable;
    const startedAt = Date.now();
    const pushed = new Promise<XsProgress | undefined>((resolve) => {
      receiptWaiters.set(args.messageId, resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res: XsResFrame = await conn.request(
        {
          t: "xs_req",
          rid: newAdminRid(),
          op: "receipt",
          origin,
          messageId: args.messageId,
          ...(args.activationKey !== undefined ? { activationKey: args.activationKey } : {}),
        },
        XS_STATE_HUB_CAP,
      );
      if (!res.ok) return unavailable; // not tracked / expired / stale key — never fabricated
      const remaining = Math.max(0, XS_RECEIPT_DEADLINE_MS - (Date.now() - startedAt));
      const giveUp = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remaining);
        timer.unref(); // I5: a ref'd timer wedges `pi -p`
      });
      const progress = await Promise.race([pushed, giveUp]);
      return progress === undefined ? unavailable : { status: "known", messageId: args.messageId, progress };
    } catch {
      return unavailable; // deadline / link lost / cap lost mid-flight
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      receiptWaiters.delete(args.messageId);
    }
  };

  /** fabric-xs-activation P3 (arch §4.4): one `xs_req{op:"activate"}` round trip (8s, cap-prechecked
   *  by `connection.request`). Pre-send failures are `not_sent` (provably none); after the frame
   *  left, a deadline/link loss is reported as such — the caller maps it to unknown. */
  const activateRoundTrip = async (args: {
    origin: XsOriginSnapshot;
    to?: string;
    messageId: string;
    activationKey: string;
    level?: number;
  }): Promise<XsPortActivateReply> => {
    const conn = deps.conn();
    if (conn === undefined || !activateEnabled()) return { kind: "not_sent" };
    if (!hubHasActivate() || !hubHasState())
      return conn.status().state === "live" ? { kind: "off" } : { kind: "not_sent" };
    try {
      const res: XsResFrame = await conn.request(
        {
          t: "xs_req",
          rid: newAdminRid(),
          op: "activate",
          origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
          ...(args.to !== undefined ? { to: args.to } : {}),
          messageId: args.messageId,
          activationKey: args.activationKey,
          ...(args.level !== undefined ? { level: args.level } : {}),
        },
        XS_ACTIVATE_HUB_CAP,
      );
      return { kind: "res", res };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("E_NO_CAP")) return conn.status().state === "live" ? { kind: "off" } : { kind: "not_sent" };
      if (msg.startsWith("E_TIMEOUT")) return { kind: "deadline" };
      return { kind: "link_lost" };
    }
  };

  /** alias on ∧ the live hub declared the cap (symmetric with the hub's `aliasUsable`). */
  const aliasUsable = (): boolean => aliasEnabled() && deps.conn()?.status().state === "live" && hubHasAlias();

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
    // channel-plan §3.3: channel-only ops / fields go ONLY to a hub that declared xs.channel.v1 —
    // an old hub's strict decoder would drop the whole frame. Nothing is sent.
    if ((["broadcast", "channels"].includes(frame.op as string) || frame.channel !== undefined) && !hubHasChannel()) {
      return conn.status().state === "live" ? { kind: "off" } : { kind: "link_lost" };
    }
    // alias-plan §3.6: the alias op goes ONLY to a hub that declared xs.alias.v1 AND only while local alias is
    // on (an old hub's strict decoder would drop the whole frame). Nothing is sent otherwise.
    if (frame.op === "alias" && !(aliasEnabled() && hubHasAlias())) {
      return conn.status().state === "live" ? { kind: "off" } : { kind: "link_lost" };
    }
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
    // channel-plan §3.3: optional list filter (CH4 adds it to the port args); roundTrip guards the hub cap
    ...(typeof (args as { channel?: unknown }).channel === "string"
      ? { channel: (args as { channel: string }).channel }
      : {}),
  });
  const reqOfResolve = (args: XsPortResolveArgs): XsReqFrame => ({
    t: "xs_req",
    rid: newAdminRid(),
    op: "resolve",
    origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
    query: args.query,
  });
  // channel-plan §5.5/§4.1 (CHW): the two channel ops; roundTrip refuses them (nothing sent) unless the
  // live hub declared xs.channel.v1. `wake`/`level` follow the send rules (sender pre-checked them).
  const reqOfBroadcast = (args: XsPortBroadcastArgs): XsReqFrame => ({
    t: "xs_req",
    rid: newAdminRid(),
    op: "broadcast",
    origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
    channel: args.channel,
    text: args.text,
    ...(args.wake === true ? { wake: true } : {}),
    ...(args.level !== undefined ? { level: args.level } : {}),
  });
  const reqOfChannels = (args: XsPortChannelsArgs): XsReqFrame => ({
    t: "xs_req",
    rid: newAdminRid(),
    op: "channels",
    origin: { sessionId: args.origin.sessionId, epoch: args.origin.epoch },
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
    const hubCap = hubCaps.includes(XS_CHANNEL_HUB_CAP);
    if (frame.t === "xs_member") {
      let m = frame as XsMemberFrame;
      if (m.receive === "replies" && !usable)
        m = { ...m, receive: effectiveReceive(m.receive, false) } as XsMemberFrame;
      if (!hubCap && (m.channels !== undefined || hasBroadcastKeys(m.limits) || m.joined)) {
        // §3.2 old hub: drop channels + the broadcast keys, `joined ← linkJoined` (a session only
        // in named channels is NOT joined on this hub; default-only frames pass through unchanged).
        const { channels, limits, ...rest } = m;
        const joined = channelLinkJoined(frameChannels(channels, m.joined), true, false);
        const out: XsMemberFrame = { ...rest, joined, limits: stripBroadcastKeys(limits) };
        return out;
      }
      return m;
    }
    if (frame.t === "status") {
      const xs = (frame as { xs?: XsStatusWire }).xs;
      if (xs === undefined) return frame;
      let nx: XsStatusWire = xs;
      // alias-plan §7.2: the alias field only rides toward a hub that declared xs.alias.v1 (replay-safe).
      if (nx.alias !== undefined && !hubCaps.includes(XS_ALIAS_HUB_CAP)) {
        const { alias: _alias, ...noAlias } = nx;
        nx = noAlias;
      }
      if (nx.receive === "replies" && !usable) nx = { ...nx, receive: effectiveReceive(nx.receive, false) };
      if (!hubCap && nx.channels !== undefined) {
        const { channels, ...rest } = nx;
        nx = { ...rest, joined: channelLinkJoined(frameChannels(channels, nx.joined), true, false) };
      }
      return nx === xs ? frame : ({ ...frame, xs: nx } as typeof frame);
    }
    return frame;
  };

  // ------------------------------------------------------------ alias cache + bridge (alias-plan §4, AL3)

  /** sessionId → entry; ≤8 FIFO; per bridge (= per activate, so a /reload starts empty). */
  const aliasCache = new Map<string, XsAliasCacheEntry>();
  const aliasEntry = (sessionId: string): XsAliasCacheEntry | undefined => aliasCache.get(sessionId);

  const applyAliasState = (sessionId: string, state: XsAliasStateWire): void => {
    const next: XsAliasCacheEntry = {};
    if (state.state === "held" && state.alias !== undefined) next.alias = state.alias;
    // alias-force-default §7 (AF3): mirror the wire `origin` so AF4 can render `held (auto)`.
    if (state.origin === "auto") next.origin = "auto";
    if (state.lost !== undefined) next.lostAt = state.lost.at;
    const prev = aliasCache.get(sessionId);
    if (prev === undefined && aliasCache.size >= ALIAS_CACHE_CAP) {
      const first = aliasCache.keys().next().value;
      if (first !== undefined) aliasCache.delete(first);
    }
    aliasCache.set(sessionId, next);
    if (state.lost !== undefined && markAliasLost(sessionId, state.lost.at)) {
      try {
        deps.port.notifyAliasLost?.(aliasLostText(state.lost));
      } catch {
        /* display-only */
      }
    }
    if (prev?.alias !== next.alias) {
      try {
        deps.publishStatus?.();
      } catch {
        /* display hint only */
      }
    }
  };

  const isStateWire = (r: unknown): r is XsAliasStateWire =>
    typeof r === "object" &&
    r !== null &&
    ((r as { state?: unknown }).state === "held" || (r as { state?: unknown }).state === "none");

  /** One bounded alias op. The response is applied to the cache iff it is still for the connection
   *  generation (same `HubConnection`, same hello_ack caps array) and the sessionId it was issued for;
   *  otherwise it is returned to the caller but never applied (§4 应用规则). Arrival order = apply order.
   *  AF3: `intent`/`prevSessionId` (alias-force-default §3.2) go ONLY to a hub that declared `xs.alias.v2` —
   *  toward a v1 hub NOTHING is sent (`E_XS_OFF{hub-v2}`, the §3.4 local refusal). `appliedSink`, when
   *  given, receives the state wire IFF it was applied (the auto engine's "本次 get 已应用" gate). */
  const aliasOp = async (
    fields: { alias?: string; clear?: true; take?: string; intent?: XsAliasIntent; prevSessionId?: string },
    kind: "read" | "write",
    appliedSink?: { applied?: XsAliasStateWire },
  ): Promise<XsAliasBridgeResult> => {
    const conn = deps.conn();
    const origin = originOf();
    if (conn === undefined || origin === undefined) return { ok: false, code: "E_XS_OFF", reason: "no_session" };
    if (!aliasEnabled()) return { ok: false, code: "E_XS_OFF", reason: "alias" };
    if ((fields.intent !== undefined || fields.prevSessionId !== undefined) && !hubHasAliasV2()) {
      return { ok: false, code: "E_XS_OFF", reason: "hub-v2" };
    }
    const capsRef = conn.caps;
    const reply = await roundTrip({ t: "xs_req", rid: newAdminRid(), op: "alias", origin, ...fields });
    if (reply.kind === "off") return { ok: false, code: "E_XS_OFF", reason: "hub" };
    if (reply.kind !== "res") {
      // A write whose frame may have reached the hub is effect-unknown (rename may have committed).
      if (kind === "write")
        return {
          ok: false,
          code: "E_XS_ALIAS_UNKNOWN",
          reason: reply.kind === "deadline" ? "client_deadline" : "link_lost",
        };
      return { ok: false, code: reply.kind === "deadline" ? "E_XS_DEADLINE" : "E_XS_LINK_LOST" };
    }
    const res = reply.res;
    if (!res.ok)
      return {
        ok: false,
        code: res.code ?? "E_XS_BAD_FRAME",
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
      };
    if (res.alias === undefined) return { ok: false, code: "E_XS_BAD_FRAME", reason: "no_alias_body" };
    const fresh = deps.conn() === conn && conn.caps === capsRef && deps.port.stack()?.sessionId() === origin.sessionId;
    if (fresh && isStateWire(res.alias)) {
      applyAliasState(origin.sessionId, res.alias);
      if (appliedSink !== undefined) appliedSink.applied = res.alias;
    }
    return { ok: true, res: res.alias };
  };

  const aliasBridge: XsAliasBridgePortV2 = {
    get supported() {
      return aliasUsable();
    },
    get: () => aliasOp({}, "read"),
    set: (rawAlias) => aliasOp({ alias: rawAlias }, "write"),
    clear: () => aliasOp({ clear: true }, "write"),
    takePreview: (rawAlias) => aliasOp({ alias: rawAlias, take: XS_ALIAS_TAKE_PREVIEW }, "read"),
    take: (rawAlias, token) => aliasOp({ alias: rawAlias, take: token }, "write"),
    // alias-force-default §3.2 (AF3): the intent ops — aliasOp itself withholds them from a v1 hub.
    auto: (candidate) => aliasOp({ alias: candidate, intent: "auto" }, "write"),
    forcePreview: (rawAlias) => aliasOp({ alias: rawAlias, take: XS_ALIAS_TAKE_PREVIEW, intent: "force" }, "read"),
    handoff: (alias, prevSessionId) => aliasOp({ alias, intent: "handoff", prevSessionId }, "write"),
  };

  // -------------------------------------------- auto-claim engine (alias-force-default §5.1, AF3)

  /** `(connGen, sessionId, membershipEpoch)` keys already attempted (per bridge, FIFO ≤64). A join/leave
   *  bumps the membership epoch and thus re-arms exactly one new attempt (§5.1 去重键). */
  const autoTried = new Set<string>();
  /** sessionId → last skip reason, for `/fabric status`'s `auto skip:<token>` (AF4 reads it via
   *  `aliasAutoSkip()`). Cleared on a held state / a disabled setting; `handoff-pending` never recorded
   *  (transient, not a status token — AF0 report「契约要点备忘」). */
  const autoSkipBySid = new Map<string, XsAliasAutoSkipReason>();
  let autoRetryTimer: ReturnType<typeof setTimeout> | undefined;

  const recordAutoSkip = (sessionId: string, skip: XsAliasAutoSkipReason): void => {
    if (!autoSkipBySid.has(sessionId) && autoSkipBySid.size >= ALIAS_AUTO_SKIP_CAP) {
      const first = autoSkipBySid.keys().next().value;
      if (first !== undefined) autoSkipBySid.delete(first);
    }
    autoSkipBySid.set(sessionId, skip);
  };

  /** Every port read goes through here: a throwing port must never break the reconcile path, and the
   *  failure direction is always "do not auto" (I8 — a human decision must never lose to a read error). */
  const autoInputs = (): (NonNullable<ReturnType<NonNullable<XsAgentPort["aliasAuto"]>>> & {}) | undefined => {
    try {
      return deps.port.aliasAuto?.();
    } catch {
      return undefined;
    }
  };

  const autoAttempt = async (sessionId: string, candidate: string, isRetry: boolean): Promise<void> => {
    const r = await aliasOp({ alias: candidate, intent: "auto" }, "write");
    if (r.ok) {
      const st = isStateWire(r.res) ? r.res : undefined;
      // §4 row 2: an ok may also be "S already holds y" (no write). Only a held matching OUR candidate
      // is a fresh auto-claim worth the one-shot notice.
      if (st?.state === "held" && st.alias === candidate) {
        autoSkipBySid.delete(sessionId);
        if (deps.port.notifyAliasAuto !== undefined && markAliasAutoNoticed(sessionId)) {
          try {
            deps.port.notifyAliasAuto(
              `已按目录名自动设置别名 @${candidate}；/fabric alias <名> 可改名，/fabric alias --clear 可取消（之后不再自动设置）`,
            );
          } catch {
            /* display-only */
          }
        }
      }
      return;
    }
    // Hub codes carry the detail as a `{…}` brace suffix on `code` (commands/fabric-xs.ts's
    // aliasErrorText parses the same shape); `reason` is the fallback detail.
    const m = /^([A-Z_]+)(?:\{([^}]*)\})?$/.exec(r.code);
    const base = m?.[1] ?? r.code;
    const detail = m?.[2] ?? r.reason;
    if (base === "E_XS_ALIAS_TAKEN") {
      recordAutoSkip(sessionId, "taken");
      return;
    }
    if (base === "E_XS_ALIAS_BUSY") {
      // §5.1: BUSY{queue|io} gets exactly ONE retry after a random 1–5s; anything else busy ⇒ skip.
      if (!isRetry && (detail === "queue" || detail === "io")) {
        scheduleAutoRetry(sessionId, candidate);
        return;
      }
      recordAutoSkip(sessionId, "busy");
      return;
    }
    // UNKNOWN (effect unknown — the write may have committed) / hub refusals: leave the previous skip
    // untouched; the next reconcile's get picks up any committed grant.
  };

  const scheduleAutoRetry = (sessionId: string, candidate: string): void => {
    if (autoRetryTimer !== undefined) return; // one pending retry per bridge; the first wins
    const rand = deps.random?.() ?? Math.random();
    const delay =
      clampSpanMs(ALIAS_AUTO_RETRY_MIN_MS + Math.floor(Math.min(1, Math.max(0, rand)) * ALIAS_AUTO_RETRY_SPAN_MS)) ??
      ALIAS_AUTO_RETRY_MIN_MS;
    const key = autoKey(sessionId);
    autoRetryTimer = setTimeout(() => {
      autoRetryTimer = undefined;
      try {
        // freshness: the dedup key must still be exact (a join/leave/attach/session-switch cancels),
        // the gates must still hold, and the cache must still hold no alias for the session (a human
        // set in the window wins without a fight, I8).
        if (key === undefined || autoKey(sessionId) !== key) return;
        const stack = deps.port.stack();
        if (stack === undefined || stack.sessionId() !== sessionId) return;
        if (!aliasUsable() || !hubHasAliasV2()) return;
        if (aliasCache.get(sessionId)?.alias !== undefined) return;
        const auto = autoInputs();
        if (auto === undefined || !auto.enabled) return;
        if (safeFlag(() => auto.decided(sessionId), true) || safeFlag(() => auto.handoffPending(), true)) return;
        void autoAttempt(sessionId, candidate, true).catch(() => undefined);
      } catch {
        /* never throws */
      }
    }, delay);
    autoRetryTimer.unref(); // I5: a ref'd timer wedges `pi -p`
  };

  const safeFlag = (f: () => boolean, onError: boolean): boolean => {
    try {
      return f() === true;
    } catch {
      return onError;
    }
  };

  const autoKey = (sessionId: string): string | undefined => {
    const stack = deps.port.stack();
    if (stack === undefined) return undefined;
    const epoch = stack.member().epoch;
    return `${deps.connGen?.() ?? 0}|${sessionId}|${epoch}`;
  };

  /** AF7: a `/new` handoff request is on the wire right now (a concurrent reconcile must not auto-claim meanwhile). */
  let handoffBusy = false;

  const handoffInputs = (): ReturnType<NonNullable<XsAgentPort["aliasHandoff"]>> => {
    try {
      return deps.port.aliasHandoff?.();
    } catch {
      return undefined;
    }
  };

  /** §5.1 ①: after an APPLIED `state:"none"`, ask the hub to move the previous session's alias (`/new` only; the port
   *  exists only for a `session_start{new}` that stashed one). ONE attempt per `/new`: settled before the request goes
   *  out. Any failure (stale — hub restarted, edge expired, someone else took it —, BUSY, UNKNOWN, link loss) just falls
   *  through to ② auto; a successful reply is applied to the cache by `aliasOp` itself. A v1 hub gets nothing (the
   *  pending state simply expires). Never throws. */
  const maybeHandoff = async (sessionId: string): Promise<void> => {
    const h = handoffInputs();
    if (h === undefined) return;
    let p: { alias: string; prevSessionId: string } | undefined;
    try {
      p = h.pending(sessionId);
    } catch {
      p = undefined;
    }
    if (p === undefined || !aliasUsable() || !hubHasAliasV2()) return;
    try {
      h.settle();
    } catch {
      /* the attempt proceeds; worst case the port re-offers it once more and the hub answers stale */
    }
    handoffBusy = true;
    try {
      await aliasOp({ alias: p.alias, intent: "handoff", prevSessionId: p.prevSessionId }, "write");
    } catch {
      /* fall through to the auto path */
    } finally {
      handoffBusy = false;
    }
  };

  /** §5.1 ②: evaluated at the END of a reconcile whose get was APPLIED and answered `state:"none"`. */
  const maybeAutoClaim = (sessionId: string): void => {
    const auto = autoInputs();
    if (auto === undefined) return; // pre-AFW wiring: the engine is inert, nothing recorded
    if (!auto.enabled) {
      // §7: autoFromCwd=false renders NO status suffix (byte-identical to the pre-auto shape).
      autoSkipBySid.delete(sessionId);
      return;
    }
    const stack = deps.port.stack();
    const member = stack?.member();
    const verdict = shouldAutoClaim({
      autoFromCwd: true,
      mainSession: true, // the bridge is only constructed for the main session (I6; AF0 keeps the gate explicit)
      aliasUsable: aliasUsable(),
      hubAliasV2: hubHasAliasV2(),
      joined: member?.joined === true,
      decided: safeFlag(() => auto.decided(sessionId), true),
      pendingHandoff: handoffBusy || safeFlag(() => auto.handoffPending(), true),
    });
    if (!verdict.claim) {
      if (verdict.skip !== "handoff-pending") recordAutoSkip(sessionId, verdict.skip);
      return;
    }
    const key = autoKey(sessionId);
    if (key === undefined || autoTried.has(key)) return; // `/fabric status` reconciles re-enter here
    if (autoTried.size >= ALIAS_AUTO_TRIED_CAP) {
      const first = autoTried.values().next().value;
      if (first !== undefined) autoTried.delete(first);
    }
    autoTried.add(key); // one attempt per key, whatever the outcome (BUSY gets its single retry)
    const derived = deriveAutoAlias(auto.cwd, { home: auto.home, tmpdir: auto.tmpdir });
    if (!derived.ok) {
      recordAutoSkip(sessionId, derived.reason);
      return;
    }
    void autoAttempt(sessionId, derived.alias, false).catch(() => undefined);
  };

  const aliasCachePort: XsAliasCachePort = {
    heldFor: (sessionId) => aliasCache.get(sessionId)?.alias,
    current() {
      const sid = deps.port.stack()?.sessionId();
      if (sid === undefined) return undefined;
      const e = aliasCache.get(sid);
      return e === undefined ? undefined : { ...e };
    },
    async reconcile() {
      try {
        if (!aliasUsable()) return;
        const sink: { applied?: XsAliasStateWire } = {};
        await aliasOp({}, "read", sink); // applies itself iff still current; failure waits for the next trigger
        // alias-force-default §5.1 (AF3): the auto tail fires only on an APPLIED `state:"none"` — a
        // stale/discarded get or a hub error never starts a write.
        if (sink.applied === undefined || sink.applied.state !== "none") return;
        const sid = deps.port.stack()?.sessionId();
        if (sid === undefined) return;
        await maybeHandoff(sid);
        // a successful handoff was applied to the cache by aliasOp: the session holds the alias ⇒ no auto
        if (deps.port.stack()?.sessionId() !== sid || aliasCache.get(sid)?.alias !== undefined) return;
        maybeAutoClaim(sid);
      } catch {
        /* never throws */
      }
    },
    get usable() {
      return aliasUsable();
    },
  };

  return {
    slotFlush,

    caps: () => {
      const reply = replyEnabled();
      const ch = channelsEnabled();
      const al = aliasEnabled();
      const act = activationEnabled();
      if (!reply && !ch && !al && !act) return XS_AGENT_CAPS;
      return [
        ...XS_AGENT_CAPS,
        ...(reply ? [XS_REPLY_AGENT_CAP] : []),
        ...(ch ? [XS_CHANNEL_AGENT_CAP] : []),
        // alias-force-default §3.1 (AF3): v2 immediately after v1, declared under the SAME condition.
        ...(al ? [XS_ALIAS_AGENT_CAP, XS_ALIAS_V2_AGENT_CAP] : []),
        // fabric-xs-activation P1: `xs.state.v1` — declared even while local wake is off (the
        // phase/reason axis explains a downgrade without waking anyone, arch §3.2).
        // The separate activate gate below additionally requires local wake enabled.
        ...(act ? [XS_STATE_AGENT_CAP] : []),
        // fabric-xs-activation P3: `xs.activate.v1` — effective ∧ local wake on (the hub may still
        // refuse at policy time; the cap is the schema gate, never authorization).
        ...(act && activateEnabled() ? [XS_ACTIVATE_AGENT_CAP] : []),
      ];
    },

    hubCrossSessionConfig: () => {
      const base: ReturnType<XsAgentBridge["hubCrossSessionConfig"]> = {
        limits: { hubSendsPerMin: clampInt(deps.port.hubSendsPerMin(), 1, 600) },
      };
      if (channelsEnabled()) {
        let c: { maxRecipients: number; wakeMaxRecipients: number } | undefined;
        try {
          c = deps.port.channelsHubConfig?.();
        } catch {
          c = undefined;
        }
        if (c !== undefined) {
          base.channels = {
            maxRecipients: clampInt(c.maxRecipients, 1, 32),
            wakeMaxRecipients: clampInt(c.wakeMaxRecipients, 0, 4),
          };
        }
      }
      if (aliasEnabled()) {
        let a: { offlineLeaseH: number; coolMin: number; takeMinOfflineMin: number } | undefined;
        try {
          a = deps.port.aliasHubConfig?.();
        } catch {
          a = undefined;
        }
        if (a !== undefined) {
          // Same bounds as the settings parser (FABRIC_XS_ALIAS_*); hub/main.ts re-validates and drops the sub-key on any bad leaf.
          base.alias = {
            offlineLeaseH: clampInt(a.offlineLeaseH, 1, 720),
            coolMin: clampInt(a.coolMin, 1, 1_440),
            takeMinOfflineMin: clampInt(a.takeMinOfflineMin, 10, 1_440),
          };
        }
      }
      // fabric-xs-activation P1: the key rides the config ONLY while effective — key-absence-is-off
      // builds no hub relation bag and appends no caps (byte-identical hub).
      if (activationEnabled()) base.activation = true;
      return base;
    },

    onDeliver(frame) {
      // Learn the one full-id mapping the wire ever shows us (used by resolveBlock below).
      learnRef(frame.from.ref, frame.from.sessionId);
      wireProgress(); // P1: the receiver stack may be new in view (subscribe its evidence)
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

    onActivate(frame) {
      // Inert unless effective ∧ wake on: no handler decision, no ack (the hub's own 5s relay
      // deadline settles it as unknown) — an agent that did not declare the cap is never sent one.
      if (!activateEnabled()) return;
      let ack: XsActivateAckFrame;
      try {
        wireProgress();
        const stack = deps.port.stack();
        ack =
          stack?.activation !== undefined
            ? stack.activation.handle(frame)
            : {
                t: "xs_activate_ack",
                rid: frame.rid,
                messageId: frame.messageId,
                activationKey: frame.activationKey,
                status: "refused",
                effect: "none",
                reason: "session_changed",
                retryable: false,
              };
      } catch {
        ack = {
          t: "xs_activate_ack",
          rid: frame.rid,
          messageId: frame.messageId,
          activationKey: frame.activationKey,
          status: "refused",
          effect: "none",
          reason: "receiver_error",
          retryable: false,
        };
      }
      try {
        deps.conn()?.send(ack);
      } catch {
        /* the hub's relay deadline settles the attempt as unknown */
      }
    },

    publishMember() {
      const conn = deps.conn();
      const stack = deps.port.stack();
      if (conn === undefined || stack === undefined) return;
      wireProgress(); // P1: per-attach hook — (re)subscribe the receiver stack's evidence port
      const m = stack.member();
      // §3.2: the STORED frame carries the effective set whenever it is not default-only (the
      // per-write flush trims it for an old hub); default-only/empty ⇒ no `channels`, no broadcast keys.
      let eff: readonly string[] | undefined;
      if (channelsEnabled()) {
        try {
          eff = stack.channelView?.().effective();
        } catch {
          eff = undefined;
        }
      }
      const channels = eff !== undefined ? channelsFieldToWrite(eff, true) : undefined;
      const frame: XsMemberFrame = {
        t: "xs_member",
        sessionId: stack.sessionId(),
        epoch: m.epoch,
        joined: channels !== undefined ? true : m.joined,
        receive: m.receive,
        limits: clampMemberLimits(deps.port.memberLimits(), channels !== undefined),
        ...(channels !== undefined ? { channels } : {}),
      };
      conn.setSlot(XS_SLOT_KIND, frame, slotFlush);
    },

    statusProjection() {
      const stack = deps.port.stack();
      if (stack === undefined) return undefined;
      try {
        const st = stack.status();
        // alias-plan §7.2: held alias from the local cache, only while alias is usable (cap-gated, display only).
        const held = aliasUsable() ? aliasEntry(stack.sessionId())?.alias : undefined;
        return held !== undefined ? { ...st, alias: held } : st;
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
        resolve: async (args) => {
          const out = await roundTrip(reqOfResolve(args));
          // The hub must vouch for the TARGET's cap; local/hub caps alone are insufficient.
          if (out.kind === "res" && activationEnabled() && hubHasState()) {
            const target = out.res.target as typeof out.res.target & { xsState?: boolean };
            if (target?.xsState === true) return { ...out, targetState: true };
          }
          return out;
        },
        send: async (args) => {
          const frame = reqOfSend(args);
          if (!activationEnabled() || !hubHasState()) return roundTrip(frame);
          if (sendProgress.size >= XS_PROGRESS_CAP) return roundTrip(frame);
          const pending: { origin: XsOriginSnapshot; wake?: XsWakeView; progress?: XsProgress } = {
            origin: { ...args.origin },
            ...(args.wakeView ? { wake: { ...args.wakeView } } : {}),
          };
          sendProgress.set(frame.rid, pending);
          try {
            const out = await roundTrip(frame);
            if (pending.progress === undefined) return out;
            if (out.kind !== "res") return { ...out, progress: withSourceWake(pending.progress) };
            if (
              pending.wake &&
              (sourceWakeMarks.has(pending.progress.messageId) || sourceWakeMarks.size < XS_PROGRESS_CAP)
            ) {
              const reason = pending.wake.reason ?? out.res.wakeDowngraded;
              const marked: XsWakeView = {
                ...pending.wake,
                ...(reason
                  ? {
                      reason,
                      decision: "downgraded",
                      stage: pending.wake.reason
                        ? "sender"
                        : ["pair_wake_rate", "outbound_wake_rate"].includes(reason)
                          ? "hub"
                          : "receiver",
                    }
                  : args.wake === true && out.res.effect === "applied"
                    ? { decision: "dispatch_accepted" }
                    : {}),
              };
              sourceWakeMarks.set(pending.progress.messageId, { sessionId: pending.origin.sessionId, wake: marked });
              mirrorRevision++;
              try {
                deps.publishStatus?.();
              } catch {
                /* keep the received delivery verdict */
              }
            }
            return { ...out, progress: withSourceWake(pending.progress) };
          } finally {
            sendProgress.delete(frame.rid);
          }
        },
        requestProgress: () =>
          activationEnabled() && hubHasState() ? mirror.rows(Date.now()).map(withSourceWake) : [],
        stateCapable: () => activationEnabled() && deps.conn()?.status().state === "live" && hubHasState(),
        replyCapable: () => replyEnabled() && deps.conn()?.status().state === "live" && hubHasReply(),
        channelCapable: () => channelsEnabled() && deps.conn()?.status().state === "live" && hubHasChannel(),
        // channel-plan §5.5 (CHW): CH4's sender reads the same probe under the name `hubChannelCap`.
        hubChannelCap: () => channelsEnabled() && deps.conn()?.status().state === "live" && hubHasChannel(),
        // alias-plan §5.2 (ALW): the sender's exact-only switch — the same probe as the agent hello cap ∧ hub cap.
        aliasUsable: () => aliasUsable(),
        broadcast: (args) => roundTrip(reqOfBroadcast(args)),
        channels: (args) => roundTrip(reqOfChannels(args)),
        // fabric-xs-activation P1: the read-only progress query (3s, cap-prechecked). Consumers:
        // wake_session (P3) and the sender's track re-sync (P2).
        receipt: receiptRoundTrip,
        activateCapable: () =>
          activateEnabled() && deps.conn()?.status().state === "live" && hubHasState() && hubHasActivate(),
        activate: activateRoundTrip,
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

    aliasBridge: () => aliasBridge,
    aliasCache: () => aliasCachePort,
    onHubCapsAlias() {
      void aliasCachePort.reconcile();
    },

    onAliasEvt(frame) {
      // alias-force-default §5.4 (AF3): the hub's push is a bare nudge — a matching sessionId re-runs the
      // normal get reconcile (a `lost{forced}` then rides the one-shot notice path and `publishStatus`
      // drops the card's `@alias`); anything else is ignored. Never throws.
      try {
        const sid = deps.port.stack()?.sessionId();
        if (sid === undefined || frame.sessionId !== sid) return;
        void aliasCachePort.reconcile();
      } catch {
        /* never throws */
      }
    },

    aliasAutoSkip() {
      const sid = deps.port.stack()?.sessionId();
      if (sid === undefined) return undefined;
      return autoSkipBySid.get(sid);
    },

    onState(frame) {
      // fabric-xs-activation P1: hub→source `xs_state` — mirror, resolve a receipt waiter,
      // republish the status slot. Never throws; nothing here can loop (frames come from the
      // hub, the status slot is not a frame source).
      try {
        if (!activationEnabled()) return;
        const { sourceRid: _hubOnly, ...snapshot } = frame;
        const write = mirror.merge(snapshot);
        if (frame.sourceRid !== undefined) {
          const pending = sendProgress.get(frame.sourceRid);
          const origin = originOf();
          if (pending && origin?.sessionId === pending.origin.sessionId && origin.epoch === pending.origin.epoch) {
            if (pending.progress === undefined || pending.progress.messageId === snapshot.messageId) {
              if (pending.wake && sourceWakeMarks.size < XS_PROGRESS_CAP)
                sourceWakeMarks.set(snapshot.messageId, { sessionId: pending.origin.sessionId, wake: pending.wake });
              pending.progress = withSourceWake(mirror.snapshot(snapshot.messageId, Date.now()) ?? snapshot);
            }
          }
        }
        if (write.kind === "created" || write.kind === "merged") mirrorRevision++;
        const waiter = receiptWaiters.get(frame.messageId);
        if (waiter !== undefined) {
          receiptWaiters.delete(frame.messageId);
          waiter(
            withSourceWake(
              write.kind === "created" || write.kind === "merged" || write.kind === "stale" ? write.progress : snapshot,
            ),
          );
        }
        deps.publishStatus?.();
      } catch {
        /* never throws into the connection machinery */
      }
    },

    requestsProjection() {
      // Only while effective AND rows exist — absent ⇒ the status frame stays byte-equal to the
      // pre-feature shape (StatusInfoSchema is open: an old hub forwards, an old UI ignores).
      if (!activationEnabled()) return undefined;
      const sid = deps.port.stack()?.sessionId();
      if (sid === undefined) return undefined;
      const rows = mirror.rows(Date.now()).map(withSourceWake);
      if (rows.length === 0) return undefined;
      const capped = rows.slice(0, XS_REQUESTS_MAX_ROWS);
      return {
        sessionId: sid,
        revision: mirrorRevision,
        rows: capped,
        ...(rows.length > capped.length ? { omitted: rows.length - capped.length } : {}),
      };
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
