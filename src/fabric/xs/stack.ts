import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  agentEnd as unreadAgentEnd,
  count as unreadCount,
  createUnreadTap,
  turnEnd as unreadTurnEnd,
  turnStart as unreadTurnStart,
} from "./unread.js";
import { type CausalLevel } from "../wake-level.js";
import { RootWakeController, type RootWakeAudit } from "../root-wake.js";
import { createSessionFence, type FencePorts, type SessionFence } from "./fence.js";
import { XsMembership, readXsMembershipEntry, XS_MEMBERSHIP_CUSTOM_TYPE } from "./membership.js";
import { channelsFieldToWrite, isDefaultOnly, XS_DEFAULT_CHANNEL } from "./channel.js";
import { XsInbox } from "./inbox.js";
import { createXsDirectoryCache, type XsDirectoryCache, type XsDirectoryRow } from "./directory.js";
import { XsReceiver } from "./receiver.js";
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
import type { XsStackPort } from "../../web-hub/agent/xs.js";
import type { AgentSettings } from "../../config/settings.js";
import type { GoalSessionStartReason } from "../../goal/state.js";

/** Late-bound main-session ports; neither the web bridge nor goal/topic-switch owns a stack. */
export interface StackXsInput {
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
}

export interface StackXs extends XsStackPort {
  membership: XsMembership;
  fence: SessionFence;
  inbox: XsInbox;
  receiver: XsReceiver;
  controller?: RootWakeController;
  /** Reply-plan RXW: present iff `fabric.crossSession.reply.enabled` (frozen at stack build). */
  reply?: StackXsReply;
  /** Reply-plan §9.2 (MW): @mention session directory cache (closure-owned per stack). */
  directory: XsDirectoryCache;
  audit: Partial<Record<RootWakeAudit, number>>;
  beforeAgentStart(event: unknown): void;
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

/** XW: all pi-facing adaptation stays here; the receiver/controller/fence remain pi-free. */
export function buildStackXs(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  reason: GoalSessionStartReason,
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
  // Explicit persisted leave wins over autoJoin; fork/copy never inherits the parent's opt-in.
  // Channel-plan §2.4 (CHW): the boolean `autoJoin` stays the master switch; it joins
  // `channels.autoJoin` (default ["default"] ⇒ the legacy join). All entries invalid ⇒ join nothing
  // (`/fabric status` says so). Channels off ⇒ only `#default` may be auto-joined (named entries are
  // never folded into default; with no default entry nothing is joined).
  if (config.autoJoin && reason !== "fork" && restored === undefined && !config.channels.autoJoinInvalid) {
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
      const xid = (message as { details?: { xid?: unknown } } | undefined)?.details?.xid;
      unreadTap.written(typeof xid === "string" ? xid : undefined);
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
    },
    getLeafEntry: () => ctx.sessionManager.getLeafEntry() ?? undefined,
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
        goalRunning: () => {
          const verdict = fence.check();
          return !verdict.ok && verdict.wakeOnly === true;
        },
        inboundWakeAvailable: () => receiver.wakeAvailable(),
        chargeInboundWake: () => receiver.chargeWake(),
        ...(level ? { level } : {}),
        audit: (event) => {
          audit[event] = (audit[event] ?? 0) + 1;
        },
      })
    : undefined;
  if (controller) {
    receiver.setController(controller);
    controller.recover(); // the caller has already disposed the old owner
  }
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
  return {
    sessionId: () => sessionId,
    directory,
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
      if (frame.from.alias !== undefined && !aliasUsable()) {
        const { alias: _dropped, ...from } = frame.from;
        return receiver.deliver({ ...frame, from });
      }
      return receiver.deliver(frame);
    },
    membership,
    fence,
    inbox,
    receiver,
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
    beforeAgentStart: (event) => {
      inbox.onRunStart();
      replyInbox?.onRunStart();
      controller?.beforeAgentStart(event);
      releaseTrigger();
      reply?.flush();
    },
    settled: () => {
      controller?.settled();
      inbox.onRunSettled();
      replyInbox?.onRunSettled();
      releaseTrigger();
      reply?.flush();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      directory.dispose();
      replyScheduler.current?.dispose();
      reply?.gate.dispose();
      replyLedger?.unbindSession(sessionId);
      controller?.dispose();
      fence.dispose();
      inbox.clear();
      replyInbox?.clear();
    },
  };
}
