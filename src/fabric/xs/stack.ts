import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "../../core/clock.js";
import {
  agentEnd as unreadAgentEnd,
  count as unreadCount,
  createUnreadTap,
  turnEnd as unreadTurnEnd,
  turnStart as unreadTurnStart,
} from "./unread.js";
import { type CausalLevel } from "../wake-level.js";
import { RootWakeController, type OrphanAbortPort, type RootWakeAudit } from "../root-wake.js";
import { createSessionFence, type FencePorts, type SessionFence } from "./fence.js";
import {
  XsMembership,
  readXsMembershipEntry,
  XS_MEMBERSHIP_CUSTOM_TYPE,
  type XsMembershipEntryData,
} from "./membership.js";
import { channelsFieldToWrite, isDefaultOnly, XS_DEFAULT_CHANNEL } from "./channel.js";
import { createXsAliasDecided, XS_ALIAS_DECIDED_CUSTOM_TYPE, type XsAliasDecidedPort } from "./alias-decided.js";
import { XsInbox } from "./inbox.js";
import { createXsDirectoryCache, type XsDirectoryCache, type XsDirectoryRow } from "./directory.js";
import { XsReceiver } from "./receiver.js";
import { createXsActivationReceiver, type XsActivationReceiver } from "./session-activation.js";
import { getXsWakeLedger } from "./wake-ledger.js";
import { createXsAskRedirect, type XsAskRedirect, type XsAskRedirectSendArgs } from "./ask-redirect.js";
import {
  XS_REPLY_ENTRY_TYPE,
  XsReplyDueScheduler,
  createXsReplyInboxPort,
  getXsReplyLedger,
  parseXsReplyEntry,
  planReplyRestartInvalidation,
  type XsReplyEntryRecord,
  type XsReplyLedger,
} from "./reply-ledger.js";
import { XsReplyNoticeGate, buildInvalidationNoticeContent } from "./reply-notice.js";
import type { XsStackPort, XsStackProgressPort } from "../../web-hub/agent/xs.js";
import type { AgentSettings } from "../../config/settings.js";
import {
  XsProgressBag,
  XS_PROGRESS_CAP,
  type XsActivationClaimView,
  type XsProgressFields,
  type XsProgressWrite,
} from "./progress.js";
import type { XsPhase, XsProgress } from "../../web-hub/protocol/xs-activation.js";
import { XS_TRACK_DEFAULT_MS } from "../../web-hub/protocol/xs-activation.js";

/** Late-bound main-session ports; neither the web bridge nor topic-switch owns a stack. */
export interface StackXsInput {
  /** #20: late-bound synchronous read-only source mirror (never a hub round trip). */
  progressPhaseOf?: (sessionId: string, requestId: string) => XsPhase | undefined;
  ports?: FencePorts;
  memberChanged?: () => void;
  /** Reply-plan §9.2 (MW): the directory cache's data source — one hub `list` round trip for the
   *  given identity; `undefined` on any failure (the cache keeps its old rows). Late-bound: the
   *  web-hub agent bridge may not exist yet / may be offline. */
  listRows?: (origin: { sessionId: string; epoch: number }) => Promise<readonly XsDirectoryRow[] | undefined>;
  /** Channel-plan §12 (IBW): the unread inbox count may have changed (tap write / turn event). Display only. */
  unreadChanged?: () => void;
  /** Channel-plan §2.3 (CHW): does the LIVE hub link declare `xs.channel.v1` (and local channels are on)?
   *  Late-bound (the bridge may be offline / absent). Absent or throwing ⇒ no cap (fail closed: a
   *  named-channel-only session reads as not joined on this link; default-only is unaffected). */
  hubChannelCap?: () => boolean;
  /** Alias-plan §3.6/§6 (ALW): local `alias.enabled` ∧ the LIVE hub declared `xs.alias.v1`. Absent or throwing ⇒
   *  not usable: a hub-stamped `from.alias` is dropped before the receiver formats the header, so an alias-off
   *  agent's model-visible content stays byte-identical even facing a non-conforming hub. */
  aliasUsable?: () => boolean;
  /** /new handoff (new-session-channels-fix): the outgoing session's explicit membership snapshot,
   *  present only for a `session_start{reason:"new"}` that had one stashed at shutdown. Adopted
   *  only when the new branch has no entry of its own; suppresses autoJoin like a restored entry. */
  membershipHandoff?: XsMembershipEntryData;
  /** Alias-force-default §5.3 (AFW): build the per-stack "human already decided the alias" port. Set only
   *  while the LOCAL alias mode is on (frozen per activate); absent ⇒ `StackXs.aliasDecided` stays absent and
   *  nothing is read from the session file (alias off ⇒ byte-identical stack). */
  aliasDecided?: boolean;
  /** Alias-force-default AF7 (§5.5): the `/new` predecessor carried the I8 mark. Written for THIS session id as
   *  `via:"inherit"` right at stack build (so a `/reload` keeps it) unless the new session already has its own mark.
   *  Only meaningful together with `aliasDecided`; the caller sets it for `reason:"new"` only (fork/resume never). */
  aliasDecidedInherit?: boolean;
  /** AF7: a HUMAN alias decision (`set`/`clear`/`take`/`force`, never `inherit`) was just marked on this session — the
   *  pending `/new` handoff must not undo it. Never throws into the marker. */
  aliasHumanDecided?: () => void;
  /** wake-unknown-optimistic §1.4: the activation-level RootWakeOrphanWatch port — every orphan
   *  abort this controller's guards issue (BAS or context) goes through it, so even a controller
   * path never leaves an unsupervised abort behind. Absent ⇒ raw aborts (tests, recovery stacks). */
  abortOrphan?: OrphanAbortPort;
  /** #21 ask-redirect §2 (B1): the redirect's late-bound ports, injected by `createXsActivation`
   *  only while `askRedirectOn` (xs ∧ reply ∧ wake ∧ askRedirect.enabled). Absent ⇒ no
   *  `StackXs.askRedirect` and the stack is byte-identical to the pre-#21 build (I9). */
  askRedirect?: {
    /** `(a) => xsSender?.message(a)` — the sender may not exist yet (late-bound). */
    send(args: XsAskRedirectSendArgs): Promise<import("./sender.js").XsSendOutcome> | undefined;
    /** Local `hopAllowed(levelOfRoot())` pre-check (U level_limit). */
    wakeHopAllowed(): boolean;
    /** Live attach probe (U detached). */
    attached(): boolean;
  };
}

export interface StackXs extends XsStackPort {
  membership: XsMembership;
  fence: SessionFence;
  inbox: XsInbox;
  receiver: XsReceiver;
  controller?: RootWakeController;
  /** fabric-xs-activation P1: receiver-side progress evidence (present iff
   *  `fabric.crossSession.activation.enabled` — frozen at stack build; off ⇒ absent ⇒ the
   *  receiver gets no evidence port and nothing is recorded or pushed). */
  progress?: StackXsProgress;
  /** Reply-plan RXW: present iff `fabric.crossSession.reply.enabled` (frozen at stack build). */
  reply?: StackXsReply;
  /** Reply-plan §9.2 (MW): @mention session directory cache (closure-owned per stack). */
  directory: XsDirectoryCache;
  /** Alias-force-default §5.3 (AFW): the I8 "human decided" marker of THIS stack's session id (present iff
   *  `StackXsInput.aliasDecided`). `decided()` feeds the auto-claim gate; `markDecided` is the `/fabric alias`
   *  write hook (memory first, then a best-effort `appendEntry`). */
  aliasDecided?: XsAliasDecidedPort;
  /** fabric-xs-activation P3: the receiver half of `xs_activate` (present iff activation is
   *  effective at stack build — frozen, non-live; the bridge still gates the frame on the cap). */
  activation?: XsActivationReceiver;
  audit: Partial<Record<RootWakeAudit, number>>;
  /** #21 ask-redirect (B1): present iff controller ∧ replyLedger ∧ `askRedirect.enabled` ∧
   *  `input.askRedirect` — the ask_user host-redirect port for this stack. */
  askRedirect?: XsAskRedirect;
  beforeAgentStart(event: unknown): void;
  /** wake-unknown-optimistic: forward the host `context` event (before every LLM call). */
  context(event: unknown): void;
  settled(): void;
  /** Channel-plan §12.3 (IBW): extension turn events, forwarded by `src/index.ts`. Never throw. */
  unreadTurnStart(): void;
  unreadTurnEnd(): void;
  unreadAgentEnd(): void;
  dispose(): void;
}

/** Reply-plan RXW: the requester/receiver-side reply wiring one stack owns. */
export interface StackXsReply {
  ledger: XsReplyLedger;
  replyInbox: XsInbox;
  maxPending: number;
  /** The owning session (ledger stats key) — read by `/agent status` (RX6). */
  sessionId: string;
  /** Sender `receivable` precheck (§4.2): joined ∧ effective receive ≠ off ∧ senderAllowed. */
  receivable(targetSessionId: string): "ok" | "receive_off" | "blocked" | "not_joined";
  /** Sender `inbound` lookup (§4.2): newest-first `getBranch()` scan, ≤2000 entries. */
  inbound(requestId: string): { fromSessionId: string } | undefined;
  /** §7.2 event-driven NoticeGate flush point (never throws). */
  flush(): void;
  gate: XsReplyNoticeGate;
}

const XS_REPLY_INBOUND_SCAN_CAP = 2000;
/** fabric-xs-activation P1 (arch §4.2): backwards message scan cap of the started observation. */
const XS_PROGRESS_CONTEXT_SCAN_CAP = 2000;

/** fabric-xs-activation P1: the receiver-side progress surface on {@link StackXs} (the
 *  web-hub bridge consumes the `XsStackProgressPort` subset through `XsStackPort.progress`). */
export interface StackXsProgress extends XsStackProgressPort {
  /** The context observation point (arch §4.2 `started`): a legal model-turn context whose raw
   *  messages contain the original body's xid. Bounded (≤2000 backwards, ≤256 tracked ids);
   *  never throws, never mutates the event. */
  observeContext(event: unknown): void;
  /** queued→delivered confirmation: ONE bounded branch scan at an existing flush point
   *  (beforeAgentStart/settled); over budget ⇒ stays `unknown` (never fabricated). */
  flushBranch(): void;
}

/** I4: same-session `/reload` hands the bag's PURE rows to the next stack through a
 *  `Symbol.for("pi-subagent:xs-progress")` park — cap 8 sessions FIFO, TTL the plain tracking
 *  window (30 min). New/fork/switch sids never adopt (keyed by sessionId). */
const XS_PROGRESS_PARK_KEY = Symbol.for("pi-subagent:xs-progress");
const XS_PROGRESS_PARK_SESSIONS = 8;
interface XsProgressParkSlot {
  rows: XsProgress[];
  at: number;
}

function parkedProgressSlots(): Map<string, XsProgressParkSlot> {
  const g = globalThis as unknown as Record<symbol, Map<string, XsProgressParkSlot> | undefined>;
  let slots = g[XS_PROGRESS_PARK_KEY];
  if (slots === undefined) {
    slots = new Map<string, XsProgressParkSlot>();
    g[XS_PROGRESS_PARK_KEY] = slots;
  }
  return slots;
}

function takeParkedXsProgress(sessionId: string, ttlMs: number, now: number): XsProgress[] {
  const slots = parkedProgressSlots();
  const slot = slots.get(sessionId);
  if (slot === undefined) return [];
  slots.delete(sessionId);
  return now - slot.at <= ttlMs ? slot.rows : [];
}

function parkXsProgress(sessionId: string, rows: XsProgress[], now: number): void {
  const slots = parkedProgressSlots();
  if (rows.length === 0) {
    slots.delete(sessionId);
    return;
  }
  if (!slots.has(sessionId) && slots.size >= XS_PROGRESS_PARK_SESSIONS) {
    const first = slots.keys().next().value;
    if (first !== undefined) slots.delete(first);
  }
  slots.set(sessionId, { rows, at: now });
}

/** fabric-xs-activation P3 (I4): the activation state that must survive a same-session `/reload`
 *  — the original-source map (source authenticity) and the BOUND claims (at-most-once control
 *  trigger: a reload must not reopen a consumed claim). `Symbol.for("pi-subagent:xs-activation-park")`,
 *  pure data, cap 8 sessions FIFO × 256 entries, TTL the plain tracking window. New/fork/switch
 *  sids never adopt (keyed by sessionId). */
const XS_ACTIVATION_PARK_KEY = Symbol.for("pi-subagent:xs-activation-park");
interface XsActivationParkSlot {
  origins: Array<[string, string]>;
  claims: Array<{ messageId: string; view: XsActivationClaimView }>;
  at: number;
}
function parkedActivationSlots(): Map<string, XsActivationParkSlot> {
  const g = globalThis as unknown as Record<symbol, Map<string, XsActivationParkSlot> | undefined>;
  let slots = g[XS_ACTIVATION_PARK_KEY];
  if (slots === undefined) {
    slots = new Map<string, XsActivationParkSlot>();
    g[XS_ACTIVATION_PARK_KEY] = slots;
  }
  return slots;
}
function takeParkedActivation(sessionId: string, ttlMs: number, now: number): XsActivationParkSlot | undefined {
  const slots = parkedActivationSlots();
  const slot = slots.get(sessionId);
  if (slot === undefined) return undefined;
  slots.delete(sessionId);
  return now - slot.at <= ttlMs ? slot : undefined;
}
function parkActivation(sessionId: string, slot: Omit<XsActivationParkSlot, "at">, now: number): void {
  const slots = parkedActivationSlots();
  if (slot.origins.length === 0 && slot.claims.length === 0) {
    slots.delete(sessionId);
    return;
  }
  if (!slots.has(sessionId) && slots.size >= XS_PROGRESS_PARK_SESSIONS) {
    const first = slots.keys().next().value;
    if (first !== undefined) slots.delete(first);
  }
  slots.set(sessionId, { ...slot, at: now });
}

/**
 * Alias-force-default §5.3 (AFW): the decided marker is read from ALL session entries (`getEntries`, never
 * `getBranch`) — a `/tree` rewind must not undo a human decision, and entries a fork copied carry the parent's
 * sid so `readXsAliasDecidedEntry` ignores them. Writes go through the synchronous `appendEntry` adapter and are
 * dropped (memory flag still set) once the stack is disposed or the session id moved on. A session file that
 * cannot be read fails CLOSED: decided reads true (never auto-claim on unknown history) while writes still work.
 */
function buildAliasDecided(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string,
  isDisposed: () => boolean,
  inherit: boolean,
  onHuman: (() => void) | undefined,
): XsAliasDecidedPort {
  const persist = (data: Parameters<Parameters<typeof createXsAliasDecided>[0]["persist"]>[0]): void => {
    if (isDisposed() || ctx.sessionManager.getSessionId() !== sessionId) return;
    pi.appendEntry(XS_ALIAS_DECIDED_CUSTOM_TYPE, data);
  };
  const withHook = (port: XsAliasDecidedPort): XsAliasDecidedPort => ({
    decided: port.decided,
    markDecided: (via) => {
      if (via !== "inherit") {
        try {
          onHuman?.();
        } catch {
          /* the marker itself must never fail */
        }
      }
      port.markDecided(via);
    },
  });
  try {
    const port = withHook(createXsAliasDecided({ sessionId, entries: ctx.sessionManager.getEntries(), persist }));
    // AF7: the /new predecessor was decided ⇒ so is this session (a session that already has its own mark keeps it).
    if (inherit && !port.decided()) port.markDecided("inherit");
    return port;
  } catch {
    const port = createXsAliasDecided({ sessionId, entries: [], persist });
    return { decided: () => true, markDecided: withHook(port).markDecided };
  }
}

/** XW: all pi-facing adaptation stays here; the receiver/controller/fence remain pi-free. */
export function buildStackXs(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  reason: "new" | "resume" | "fork" | "reload" | "startup",
  level: CausalLevel | undefined,
  input: StackXsInput,
): StackXs {
  const sessionId = ctx.sessionManager.getSessionId();
  const config = settings.fabric.crossSession;
  let disposed = false;
  const membership = new XsMembership({
    sessionId,
    defaultReceive: config.receive,
    allowFrom: config.allowFrom,
    allowFromDenyAll: config.allowFromDenyAll,
    replyEnabled: config.reply.enabled,
    // Channel-plan §2.3 (CHW): channels off ⇒ named channels suspended (never folded into default).
    channelsEnabled: config.channels.enabled,
    persist: (data) => {
      if (disposed || ctx.sessionManager.getSessionId() !== sessionId) return;
      try {
        pi.appendEntry(XS_MEMBERSHIP_CUSTOM_TYPE, data);
      } catch {
        /* memory sessions still work */
      }
      try {
        input.memberChanged?.();
      } catch {
        /* offline bridge: next attach republishes */
      }
    },
  });
  membership.attach();
  const restored = readXsMembershipEntry(ctx.sessionManager.getBranch());
  membership.restore(restored);
  // /new handoff (new-session-channels-fix): a `/new` (web 「清空」) session starts with an empty
  // branch, so without this the operator's channels would be silently dropped. The outgoing
  // stack's explicit membership was stashed at `session_shutdown{new}`; adopt it (re-persisted
  // under the NEW sessionId) — fork never stashes, so P10 is untouched. Same-session restore
  // (restored !== undefined) always wins over the handoff.
  const handoff =
    reason === "new" && restored === undefined && input.membershipHandoff?.sessionId !== sessionId
      ? input.membershipHandoff
      : undefined;
  if (handoff !== undefined) membership.adopt(handoff);
  // Explicit persisted leave wins over autoJoin; fork/copy never inherits the parent's opt-in.
  // Channel-plan §2.4 (CHW): the boolean `autoJoin` stays the master switch; it joins
  // `channels.autoJoin` (default ["default"] ⇒ the legacy join). All entries invalid ⇒ join nothing
  // (`/fabric status` says so). Channels off ⇒ only `#default` may be auto-joined (named entries are
  // never folded into default; with no default entry nothing is joined). An adopted /new handoff
  // (possibly an explicit leave) suppresses autoJoin exactly like a restored entry does.
  if (
    config.autoJoin &&
    reason !== "fork" &&
    restored === undefined &&
    handoff === undefined &&
    !config.channels.autoJoinInvalid
  ) {
    const names = config.channels.enabled
      ? config.channels.autoJoin
      : config.channels.autoJoin.filter((name) => name === XS_DEFAULT_CHANNEL);
    if (names.length > 0) membership.join(names);
  }
  // Channel-plan §2.3: the link-effective view (receiver stage 3, sender gate, directory, reply
  // receivability) needs the live hub cap; read late, never throws.
  const hubChannelCap = (): boolean => {
    try {
      return input.hubChannelCap?.() === true;
    } catch {
      return false;
    }
  };
  // Alias-plan §6 (ALW): `from.alias` is written by the hub only for an `aliasUsable` recipient; mirror the gate
  // locally (read live, fail closed) so the header's ` alias="…"` field can only appear in alias mode.
  const aliasUsable = (): boolean => {
    try {
      return input.aliasUsable?.() === true;
    } catch {
      return false;
    }
  };
  const aliasDecided =
    input.aliasDecided === true
      ? buildAliasDecided(
          pi,
          ctx,
          sessionId,
          () => disposed,
          reason === "new" && input.aliasDecidedInherit === true,
          input.aliasHumanDecided,
        )
      : undefined;
  const fence = createSessionFence({ ...(input.ports ? { ports: input.ports } : {}) });
  fence.onEvent({ type: "session_start" });
  const inbox = new XsInbox(config.limits.inboxCap);
  // Channel-plan §12.2 (IBW): the only two host write exits (this `host`, shared by receiver + Controller —
  // NoticeGate wakes go through the Controller — and NoticeGate's own quiet host below) feed one tap.
  // Observation only: a synchronous sendMessage throw propagates untouched and counts nothing.
  const unreadTap = createUnreadTap(() => sessionId);
  const unreadChanged = () => {
    try {
      input.unreadChanged?.();
    } catch {
      /* display hint only */
    }
  };
  const tapWritten = (message: unknown) => {
    try {
      const details = (message as { details?: { xid?: unknown; activateFor?: unknown } } | undefined)?.details;
      // P3: a host activation control marker is NOT a message body — never an unread event.
      if (details?.activateFor === undefined)
        unreadTap.written(typeof details?.xid === "string" ? details.xid : undefined);
    } catch {
      /* observation only */
    }
    unreadChanged();
  };
  const host = {
    // Minimal host ctx doubles (and any host lacking these) read as idle / nothing pending,
    // the same convention as `isStreaming` below — recovery must never throw at stack build.
    isIdle: () => (typeof ctx.isIdle === "function" ? ctx.isIdle() : true),
    hasPendingMessages: () => (typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false),
    sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: { triggerTurn: boolean }) => {
      pi.sendMessage(message, options);
      tapWritten(message);
      // #21 ask-redirect D3/D6: the ONE host write exit observation tap (Controller dispatch +
      // receiver deliver) — strictly after the write, observation only, never breaks the exit.
      try {
        askRedirect?.observeWrite(message);
      } catch {
        /* observation only */
      }
    },
    getLeafEntry: () => {
      const entry = ctx.sessionManager.getLeafEntry();
      if (entry === null) return undefined;
      // fabric-xs-activation P1: carry the entry id for the progress row's `entryId`.
      const e = entry as { type: string; customType?: string; details?: unknown; id?: unknown };
      return {
        type: e.type,
        ...(e.customType !== undefined ? { customType: e.customType } : {}),
        ...(e.details !== undefined ? { details: e.details } : {}),
        ...(typeof e.id === "string" ? { id: e.id } : {}),
      };
    },
    abort: () => {
      if (typeof ctx.abort === "function") ctx.abort();
    },
    hasXid: (xid: string) =>
      ctx.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "subagent:xs" &&
            (entry.details as { xid?: unknown } | undefined)?.xid === xid,
        ),
  };
  // ---- fabric-xs-activation P1: the receiver-side progress bag + observation ports ----
  // Frozen at stack build (`fabric.crossSession.activation.enabled`, non-live): off ⇒ no bag,
  // no receiver evidence port, no observer — byte-identical to the pre-feature stack.
  const activationOn = config.activation.enabled;
  const progressBag = activationOn ? new XsProgressBag(XS_PROGRESS_CAP) : undefined;
  if (progressBag !== undefined) {
    // Same-session /reload: pure-data recovery (revision adopted as-is); the park's TTL equals
    // the plain tracking window — a stale park hands over nothing.
    for (const row of takeParkedXsProgress(sessionId, XS_TRACK_DEFAULT_MS, Date.now())) progressBag.merge(row);
  }
  // P3: the original-source map of delivered bodies (source authenticity of a later activate).
  const originOfMessage = new Map<string, string>();
  if (progressBag !== undefined) {
    const parked = takeParkedActivation(sessionId, XS_TRACK_DEFAULT_MS, Date.now());
    for (const [id, from] of parked?.origins ?? []) originOfMessage.set(id, from);
    for (const c of parked?.claims ?? []) progressBag.claimRestore(c.messageId, c.view);
  }
  const progressSubs = new Set<(progress: XsProgress) => void>();
  const replySubs = new Set<(requestId: string, at: number) => void>();
  const notifyProgressWrite = (write: XsProgressWrite): void => {
    if (write.kind !== "created" && write.kind !== "merged") return; // stale/full are invisible
    for (const cb of progressSubs) {
      try {
        cb(write.progress);
      } catch {
        /* a subscriber must never break evidence collection */
      }
    }
  };
  const receiverProgress =
    progressBag !== undefined
      ? {
          observe: (messageId: string, fields: XsProgressFields) =>
            notifyProgressWrite(progressBag.observe(messageId, fields, Date.now())),
          replyWritten: (requestId: string, at: number) => {
            for (const cb of replySubs) {
              try {
                cb(requestId, at);
              } catch {
                /* mirror-side display only */
              }
            }
          },
        }
      : undefined;
  const replyEnabled = config.reply.enabled;
  const replyLedger = replyEnabled ? getXsReplyLedger() : undefined;
  const replyInbox = replyEnabled ? new XsInbox(config.reply.maxPending) : undefined;
  const replyScheduler: { current?: XsReplyDueScheduler } = {};
  if (replyLedger && replyInbox) {
    // Best-effort entry sinks (§3.3): failures only cost the post-restart invalidation notice.
    const append = (entry: unknown) => {
      if (disposed || ctx.sessionManager.getSessionId() !== sessionId) return;
      try {
        pi.appendEntry(XS_REPLY_ENTRY_TYPE, entry);
      } catch {
        /* receivability is unaffected */
      }
    };
    replyLedger.bindSession({
      sessionId,
      inbox: createXsReplyInboxPort(replyInbox),
      appendIssue: (entry) => {
        append(entry);
        replyScheduler.current?.refresh(); // a new pending ticket may be the earliest due
      },
      appendSettle: append,
    });
  }
  const receiver = new XsReceiver({
    sessionId,
    membership,
    fence,
    inbox,
    ...(replyLedger ? { replyLedger } : {}),
    host,
    recvPerHour: config.limits.recvPerHour,
    wakesInPerHour: config.limits.wakesInPerHour,
    hubChannelCap,
    ...(receiverProgress ? { progress: receiverProgress } : {}),
    ...(level ? { level } : {}),
  });
  const audit: Partial<Record<RootWakeAudit, number>> = {};
  const controller = settings.fabric.wake.enabled
    ? new RootWakeController({
        sessionId,
        rootRunMaxS: settings.fabric.wake.rootRunMaxS,
        wakeEnabled: true,
        receive: () => membership.receive,
        host,
        guard: () => {
          if (disposed || ctx.sessionManager.getSessionId() !== sessionId) return "session_changed";
          const verdict = fence.check();
          return !verdict.ok && !verdict.wakeOnly ? verdict.reason : undefined;
        },
        inboundWakeAvailable: () => receiver.wakeAvailable(),
        chargeInboundWake: () => receiver.chargeWake(),
        ...(level ? { level } : {}),
        audit: (event) => {
          audit[event] = (audit[event] ?? 0) + 1;
        },
        ...(input.abortOrphan ? { abortOrphan: input.abortOrphan } : {}),
      })
    : undefined;
  if (controller) {
    receiver.setController(controller);
    controller.recover(); // the caller has already disposed the old owner
  }
  // ---- #21 ask-redirect (B1): created only when the whole gate holds (controller from
  // fabric.wake.enabled, replyLedger from reply.enabled, the settings leaf default-on, and the
  // activation-level wiring) — off/absent ⇒ no port, no tap effect, byte-identical stack (I9).
  const askRedirect =
    controller !== undefined &&
    replyLedger !== undefined &&
    config.askRedirect.enabled &&
    input.askRedirect !== undefined
      ? createXsAskRedirect({
          sessionId,
          clock: systemClock,
          ledger: getXsWakeLedger(),
          controller: () => controller,
          attached: input.askRedirect.attached,
          wakeHopAllowed: input.askRedirect.wakeHopAllowed,
          maxChars: settings.fabric.maxChars,
          pairMinIntervalMs: config.limits.pairMinIntervalMs,
          timeoutS: config.askRedirect.timeoutS,
          maxPerRun: config.askRedirect.maxPerRun,
          send: input.askRedirect.send,
        })
      : undefined;
  const releaseTrigger = () => {
    if (!controller?.busy) {
      inbox.releaseTrigger();
      replyInbox?.releaseTrigger();
    }
  };
  let reply: StackXsReply | undefined;
  if (replyLedger && replyInbox) {
    // RX1 nit (wakeOnly gen): a goal-only (`wakeOnly`) verdict carries no gen, so the gate's quiet
    // path would verify with gen=0 and always fail. Remember the generation at begin and map 0 to it.
    let wakeOnlyGen: number | undefined;
    const gateFence = {
      beginDispatch: () => {
        const verdict = fence.beginDispatch();
        wakeOnlyGen = !verdict.ok && verdict.wakeOnly === true ? fence.generation() : undefined;
        return verdict;
      },
      verifyDispatch: (gen: number) => fence.verifyDispatch(gen === 0 && wakeOnlyGen !== undefined ? wakeOnlyGen : gen),
    };
    const gate = new XsReplyNoticeGate({
      ledger: replyLedger,
      sessionId,
      getSessionId: () => ctx.sessionManager.getSessionId(),
      disposed: () => disposed,
      joined: () => membership.joined,
      receive: () => membership.receive,
      fence: gateFence,
      ...(input.progressPhaseOf ? { progressOf: (id: string) => input.progressPhaseOf?.(sessionId, id) } : {}),
      ...(controller ? { controller } : {}),
      host: {
        sendMessage: (write) => {
          pi.sendMessage(write, { triggerTurn: false });
          tapWritten(write);
        },
      },
    });
    const flush = () => {
      if (disposed) return;
      try {
        gate.flush();
      } catch {
        /* a notice must never break the host event that triggered the flush */
      }
    };
    const scheduler = new XsReplyDueScheduler({ ledger: replyLedger, sessionId, onDue: flush });
    replyScheduler.current = scheduler;
    reply = {
      ledger: replyLedger,
      replyInbox,
      maxPending: config.reply.maxPending,
      sessionId,
      gate,
      flush,
      receivable: (target) => {
        // Channel-plan §2.3: receiver stage 3 judges against the LINK set — mirror it here.
        if (!membership.linkJoined(hubChannelCap())) return "not_joined";
        if (membership.receive === "off") return "receive_off";
        return membership.senderAllowed(target) ? "ok" : "blocked";
      },
      inbound: (requestId) => {
        const branch = ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>;
        let scanned = 0;
        for (let i = branch.length - 1; i >= 0 && scanned < XS_REPLY_INBOUND_SCAN_CAP; i--, scanned++) {
          const entry = branch[i]!;
          if (entry.type !== "custom_message" || entry.customType !== "subagent:xs") continue;
          const details = entry.details as
            { reply?: { requestId?: unknown }; from?: { sessionId?: unknown } } | undefined;
          if (details?.reply?.requestId !== requestId) continue;
          const from = details.from?.sessionId;
          return typeof from === "string" ? { fromSessionId: from } : undefined;
        }
        return undefined;
      },
    };
    // ---- restore (§3.3/§3.4/§7.2): runs once per stack build, never throws.
    try {
      replyLedger.sweep();
      if (replyLedger.markRestartScanned(sessionId)) {
        const records: XsReplyEntryRecord[] = [];
        for (const raw of ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>) {
          if (raw.type !== "custom" || raw.customType !== XS_REPLY_ENTRY_TYPE) continue;
          const record = parseXsReplyEntry(raw.data, sessionId);
          if (record) records.push(record);
        }
        const plan = planReplyRestartInvalidation(records, replyLedger, Date.now());
        let settle = plan.invalid.length === 0;
        if (!settle) {
          const result = gate.emitQuiet(
            buildInvalidationNoticeContent(plan.invalid, plan.more),
            plan.invalid.map((item) => item.requestId),
          );
          settle = result.written !== false; // not admitted ⇒ no settle ⇒ a later restart retries
        }
        if (settle)
          for (const entry of plan.settles) {
            try {
              pi.appendEntry(XS_REPLY_ENTRY_TYPE, entry);
            } catch {
              /* best-effort */
            }
          }
      }
      gate.flush();
      const dropped = replyLedger.droppedNoticeCount(sessionId);
      if (dropped > 0 && gate.emitDroppedSummary(dropped).written !== false) replyLedger.takeDroppedNotices(sessionId);
      scheduler.refresh();
    } catch {
      /* restore is best-effort; the ledger stays authoritative */
    }
  }
  // Reply-plan §9.2 (MW): the identity key changes on epoch bump (attach/join/leave) and on `/new`
  // (a new stack ⇒ a new cache), so any such change clears it; not joined ⇒ no view ⇒ no rows.
  // Channel-plan §2.3/§4.3 (CHW): gated by the LINK set; the link channels fold into the identity so a
  // local channel change (or a hub-cap flip) clears the cache. Default-only ⇒ no `channels` key ⇒ the
  // pre-channel identity key, byte for byte.
  const directoryView = (): { key: string; channels?: readonly string[] } | undefined => {
    if (disposed) return undefined;
    const cap = hubChannelCap();
    if (!membership.linkJoined(cap)) return undefined;
    const key = `${sessionId}#${membership.epoch}`;
    const link = membership.link(cap);
    return isDefaultOnly(link) ? { key } : { key, channels: link };
  };
  const directory = createXsDirectoryCache({
    source: {
      view: directoryView,
      fetch: async () => {
        if (disposed || !membership.linkJoined(hubChannelCap()) || !input.listRows) return undefined;
        return input.listRows({ sessionId, epoch: membership.epoch });
      },
    },
    now: () => Date.now(),
  });
  // fabric-xs-activation P1: the started observation (arch §4.2) — a legal model-turn context
  // whose raw messages contain a tracked xid. Bounded: ≤2000 messages scanned BACKWARDS, ≤256
  // tracked ids (bag cap), set match (never a per-id rescan). Marker / BAS / !isIdle alone are
  // NOT started evidence (arch §4.1) — only this context sight is.
  const progressObserveContext = (event: unknown): void => {
    if (progressBag === undefined || progressBag.size === 0) return;
    try {
      const pending = new Set<string>();
      for (const row of progressBag.rows(Date.now())) {
        if (row.startedAt !== undefined || row.phase === "started" || row.phase === "replied") continue;
        pending.add(row.messageId);
      }
      if (pending.size === 0) return;
      const messages = (event as { messages?: unknown }).messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      const marked = new Set<string>();
      const floor = Math.max(0, messages.length - XS_PROGRESS_CONTEXT_SCAN_CAP);
      for (let i = messages.length - 1; i >= floor; i--) {
        const m = messages[i] as { role?: unknown; customType?: unknown; details?: unknown } | null;
        if (m === null || typeof m !== "object" || m.role !== "custom" || m.customType !== "subagent:xs") continue;
        const xid = (m.details as { xid?: unknown } | null | undefined)?.xid;
        if (typeof xid !== "string" || !pending.has(xid) || marked.has(xid)) continue;
        marked.add(xid);
        notifyProgressWrite(progressBag.observe(xid, { phase: "started", startedAt: Date.now() }, Date.now()));
        if (marked.size >= pending.size) return;
      }
    } catch {
      /* observation only — never breaks the host event */
    }
  };
  // queued→delivered confirmation (arch §4.2 "queued 后 branch 确认"): ONE bounded branch scan at
  // an existing flush point. Over budget ⇒ stays unknown; not a per-message poll.
  const progressFlushBranch = (): void => {
    if (progressBag === undefined || progressBag.size === 0) return;
    try {
      const pending = new Set<string>();
      for (const row of progressBag.rows(Date.now())) {
        if (
          row.deliveredAt !== undefined ||
          row.phase === "delivered" ||
          row.phase === "started" ||
          row.phase === "replied"
        )
          continue;
        if (row.queuedAt !== undefined || row.phase === "queued") pending.add(row.messageId);
      }
      if (pending.size === 0) return;
      const branch = ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>;
      const floor = Math.max(0, branch.length - XS_REPLY_INBOUND_SCAN_CAP);
      for (let i = branch.length - 1; i >= floor; i--) {
        const entry = branch[i]!;
        if (entry.type !== "custom_message" || entry.customType !== "subagent:xs") continue;
        const xid = (entry.details as { xid?: unknown } | undefined)?.xid;
        if (typeof xid !== "string" || !pending.has(xid)) continue;
        pending.delete(xid);
        notifyProgressWrite(
          progressBag.observe(
            xid,
            {
              deliveryEffect: "applied",
              phase: "delivered",
              deliveredAt: Date.now(),
              ...(typeof entry.id === "string" && entry.id !== "" ? { entryId: entry.id } : {}),
            },
            Date.now(),
          ),
        );
        if (pending.size === 0) return;
      }
    } catch {
      /* observation only */
    }
  };
  // ---- fabric-xs-activation P3: the receiver half of `xs_activate` (arch §4.5) ----
  const activation: XsActivationReceiver | undefined =
    progressBag === undefined
      ? undefined
      : createXsActivationReceiver({
          sessionId: () => sessionId,
          epoch: () => membership.epoch,
          disposed: () => disposed || ctx.sessionManager.getSessionId() !== sessionId,
          now: () => Date.now(),
          membership,
          fence,
          bag: progressBag,
          originOf: (id) => originOfMessage.get(id),
          confirmed: (id) => {
            try {
              const branch = ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>;
              const floor = Math.max(0, branch.length - XS_REPLY_INBOUND_SCAN_CAP);
              for (let i = branch.length - 1; i >= floor; i--) {
                const entry = branch[i]!;
                if (entry.type !== "custom_message" || entry.customType !== "subagent:xs") continue;
                const d = entry.details as { xid?: unknown; activateFor?: unknown } | undefined;
                if (d?.xid === id && d.activateFor === undefined) return "present";
              }
              return floor > 0 ? "over_budget" : "absent";
            } catch {
              return "over_budget"; // unreadable branch ⇒ fail closed
            }
          },
          flushBranch: () => progressFlushBranch(),
          hasLiveWake: (id) =>
            getXsWakeLedger()
              .entries()
              .some(
                (r) =>
                  r.sessionId === sessionId &&
                  (r.xid === id || r.activateFor === id) &&
                  (r.state === "live" || r.executionPending),
              ),
          controller: () => controller,
          observe: (id, fields) => notifyProgressWrite(progressBag.observe(id, fields, Date.now())),
        });
  const progress: StackXsProgress | undefined =
    progressBag === undefined
      ? undefined
      : {
          subscribe: (cb) => {
            progressSubs.add(cb);
            return () => {
              progressSubs.delete(cb);
            };
          },
          subscribeReplyWritten: (cb) => {
            replySubs.add(cb);
            return () => {
              replySubs.delete(cb);
            };
          },
          rows: () => progressBag.rows(Date.now()),
          snapshot: (messageId) => progressBag.snapshot(messageId, Date.now()),
          observeContext: progressObserveContext,
          flushBranch: progressFlushBranch,
        };
  return {
    sessionId: () => sessionId,
    directory,
    ...(aliasDecided !== undefined ? { aliasDecided } : {}),
    member: () => ({ epoch: membership.epoch, joined: membership.joined, receive: membership.receive }),
    // Channel-plan §3.2 (CHW): `channels` only when the effective set is not default-only (the
    // per-write slotFlush trims it — and sets `joined ← linkJoined` — for a hub without the cap).
    status: () => {
      const channels = config.channels.enabled ? channelsFieldToWrite(membership.effective(), true) : undefined;
      return {
        joined: membership.joined,
        receive: membership.receive,
        blocked: membership.blockedSnapshot().length,
        ...(channels !== undefined ? { channels } : {}),
      };
    },
    channelView: () => membership,
    deliver: (frame) => {
      if (disposed) return { effect: "none", reason: "session_changed", woke: false };
      // Also reconcile idle-poll/deferred-deadline transitions before the next capacity check.
      releaseTrigger();
      const verdict =
        frame.from.alias !== undefined && !aliasUsable()
          ? (() => {
              const { alias: _dropped, ...from } = frame.from;
              return receiver.deliver({ ...frame, from });
            })()
          : receiver.deliver(frame);
      // P3: remember the hub-stamped source of a body that was (maybe) delivered — bounded FIFO.
      if (activation !== undefined && verdict.effect !== "none" && !originOfMessage.has(frame.xid)) {
        if (originOfMessage.size >= XS_PROGRESS_CAP) {
          const first = originOfMessage.keys().next().value;
          if (first !== undefined) originOfMessage.delete(first);
        }
        originOfMessage.set(frame.xid, frame.from.sessionId);
      }
      return verdict;
    },
    membership,
    fence,
    inbox,
    receiver,
    ...(progress !== undefined ? { progress } : {}),
    ...(activation !== undefined ? { activation } : {}),
    audit,
    unread: () => unreadCount(sessionId),
    unreadTurnStart: () => {
      try {
        unreadTurnStart(sessionId);
      } catch {
        /* display hint only */
      }
      unreadChanged();
    },
    unreadTurnEnd: () => {
      try {
        unreadTurnEnd(sessionId);
      } catch {
        /* display hint only */
      }
      unreadChanged();
    },
    unreadAgentEnd: () => {
      try {
        unreadAgentEnd(sessionId);
      } catch {
        /* display hint only */
      }
      unreadChanged();
    },
    ...(controller ? { controller } : {}),
    ...(reply ? { reply } : {}),
    ...(askRedirect !== undefined ? { askRedirect } : {}),
    beforeAgentStart: (event) => {
      inbox.onRunStart();
      replyInbox?.onRunStart();
      controller?.beforeAgentStart(event);
      releaseTrigger();
      reply?.flush();
      progress?.flushBranch(); // P1: queued→delivered confirmation at an existing flush point
    },
    context: (event) => {
      controller?.context(event);
      progress?.observeContext(event); // P1 started observation (also runs on controller-less stacks via the P2 wiring)
    },
    settled: () => {
      controller?.settled();
      inbox.onRunSettled();
      replyInbox?.onRunSettled();
      releaseTrigger();
      reply?.flush();
      progress?.flushBranch(); // P1: queued→delivered confirmation at an existing flush point
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // fabric-xs-activation P1: same-session /reload parks the PURE rows (I4 global, stated
      // cap/TTL); a different sid (new/fork/switch) never adopts them. Subscribers drop with the
      // stack — the bridge re-subscribes to the next stack it sees.
      progressSubs.clear();
      replySubs.clear();
      if (progressBag !== undefined) {
        parkXsProgress(sessionId, progressBag.rows(Date.now()), Date.now());
        parkActivation(sessionId, { origins: [...originOfMessage], claims: progressBag.claimSnapshots() }, Date.now());
      }
      directory.dispose();
      replyScheduler.current?.dispose();
      reply?.gate.dispose();
      replyLedger?.unbindSession(sessionId);
      // #21 ask-redirect: settle in-flight calls as `disposed` BEFORE the controller goes —
      // billed, never refunded (D4); the ledger's askOrigin/askUsed stay with the record.
      askRedirect?.dispose();
      controller?.dispose();
      fence.dispose();
      inbox.clear();
      replyInbox?.clear();
    },
  };
}
