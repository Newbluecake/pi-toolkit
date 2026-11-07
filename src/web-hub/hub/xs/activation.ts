/**
 * fabric-xs-activation plan §3 P1 (arch §3.1/§4.5/§4.7): the hub-side RELATION BAG — the
 * activation authority for every tracked original send.
 *
 * One relation per original body xid (`messageId`), registered by the router's send path ONLY
 * under three-end `xs.state.v1` negotiation (hub `crossSession.activation` key present ∧ the
 * source AND the target socket both declared the agent cap — the router checks the registry's
 * hello caps). The relation carries NO body text, ever: xid/messageId, the issued
 * `activationKey`, source process/sid/rid, target process/sid, createdAt/trackUntil, the reply
 * requestId of an `expectReply` send and the latest merged progress snapshot.
 *
 * `trackUntil = createdAt + xsTrackUntilMs(...)` — the expect span (the frame's own
 * `expect.timeoutMs` + the protocol late-grace default; the hub cannot know the AGENT's
 * `fabric.crossSession.reply.*` knobs, HubConfig carries only the boolean — an accepted
 * approximation: tracking may outlive a shorter ticket, never cut a longer one) capped by the
 * protocol ceiling (`maxTimeoutS + lateGraceS` defaults), plain sends 30 min (arch §4.5).
 *
 * Capacity (arch §4.5): cap `XS_RELATION_CAP` (1024); FULL ⇒ `registerSend` refuses and the
 * send proceeds on the OLD path (tracking unavailable, no key — never a send failure); a live
 * entry is never evicted. Expiry is lazy: an expired packet is refused FIRST and pruned by
 * later writes ("过期包先拒绝才 lazy清理"), a fresh key never extends it.
 *
 * `onState` (receiver→hub `xs_state`): the hub NEVER trusts a receiver-reported source (the
 * frame carries none) — it verifies the socket (relation.targetAgentKey), the session id (the
 * member table's CURRENT effective record) and the revision (monotone per receiver process ×
 * messageId; stale ⇒ ignored with a diagnostic). A verified snapshot overwrites the relation's
 * `lastProgress` (relation-stable fields — activationKey/activationUntil/requestId — are
 * re-overlaid so a receiver frame can never erase them) and is forwarded to the ORIGINAL source
 * socket with `sourceRid` (the original send's request id — hub-written, never receiver-written).
 *
 * `receipt` (`xs_req{op:"receipt"}`, arch §4.4): a strictly read-only query. The requester must
 * BE the relation's source (socket + sid); an unknown/foreign/expired messageId answers
 * `E_XS_NOT_TRACKED` (indistinguishable — anti-enumeration, XI5 posture), a mismatched key
 * `E_XS_STALE_KEY`. A found relation answers `ok` and pushes the current snapshot as an
 * `xs_state` frame (sourceRid = the relation's source rid); the agent-side waiter correlates
 * by messageId. Zero side effects beyond list-tier reads.
 *
 * pi-free, no timers (all expiry is lazy — I5), no I/O. In-memory only: a hub restart forgets
 * every relation ⇒ later receipts answer NOT_TRACKED (arch §4.5 "hub restart ⇒ unavailable,
 * 不从磁盘恢复凭证").
 */
import { randomBytes } from "node:crypto";
import type { HubLog } from "../ports.js";
import type { Registry } from "../registry.js";
import { hubIntersect, type XsEffectiveMember, type XsMembers } from "./members.js";
import type { XsLimits, XsActivateTicket } from "./limits.js";
import {
  XS_ACTIVATE_AGENT_CAP,
  XS_ACTIVATE_RELAY_EXPIRY_MS,
  XS_TRACK_DEFAULT_MS,
  xsTrackUntilMs,
  type XsActivateAckFrame,
  type XsActivateFrame,
  type XsActivateResWire,
  type XsProgress,
  type XsStateFrame,
} from "../../protocol/xs-activation.js";

/** Relation-bag capacity (arch §4.5: hub cap 1024; full ⇒ old-path send, never a live eviction). */
export const XS_RELATION_CAP = 1024;

/** Protocol reply defaults mirrored for the tracking window (the agent's own knobs are not on
 *  the wire — see the header; `XsReqSchema`'s router-side expect bounds are 60s..86400s). */
const REPLY_MAX_TIMEOUT_MS = 86_400_000;
const REPLY_LATE_GRACE_MS = 600_000;

export interface XsRelationRecord {
  /** The original body's hub xid — the progress `messageId` (never a q-id/rid/token). */
  messageId: string;
  activationKey: string;
  sourceAgentKey: string;
  sourceSessionId: string;
  /** The ORIGINAL send's `xs_req.rid` (source correlation of every pushed `xs_state`). */
  sourceRid: string;
  targetAgentKey: string;
  targetSessionId: string;
  createdAt: number;
  trackUntil: number;
  /** Present iff the original send carried `expectReply` (the requester-issued requestId). */
  requestId: string | undefined;
  wakeRequested: boolean;
  lastProgress: XsProgress | undefined;
  /** fabric-xs-activation P3: this relation's activation attempt machine (no body, no timers
   *  except the unref'd relay deadline while an attempt is pending). */
  act: XsActivationAttempt;
}

/** `available → pending → consumed | unknown`; a proven-none ack returns to `available` with a
 *  retry floor (`notBefore`). `consumed`/`unknown` never reopen (at-most-once control trigger). */
export interface XsActivationAttempt {
  state: "available" | "pending" | "consumed" | "unknown";
  notBefore: number;
  /** The reason/quota token that set `notBefore` (re-served while the floor holds). */
  floorReason?: { reason?: string; wakeDowngraded?: string };
  rid?: string;
  ticket?: XsActivateTicket;
  timer?: ReturnType<typeof setTimeout>;
  respond?: (body: XsActivateHubReply) => void;
}

/** What the hub answers an `activate` request with (the router maps it onto `xs_res`). */
export type XsActivateHubReply =
  | { ok: false; code: "E_XS_NOT_TRACKED" | "E_XS_STALE_KEY" | "E_XS_BAD_TARGET" }
  | { ok: true; activation: XsActivateResWire };

export type XsRegisterSendResult = { ok: true; relation: XsRelationRecord } | { ok: false; reason: "full" };

export interface XsActivationService {
  /** Router send path (before the relay): register + issue the key. Never throws. */
  registerSend(args: {
    messageId: string;
    sourceAgentKey: string;
    sourceSessionId: string;
    sourceRid: string;
    targetAgentKey: string;
    targetSessionId: string;
    expect?: { requestId: string; timeoutMs: number };
    wakeRequested: boolean;
  }): XsRegisterSendResult;
  /** The relation's initial synthetic snapshot + its `xs_state` push to the source socket
   *  (sourceRid = the original send's rid) — how the SOURCE learns messageId/activationKey. */
  pushInitial(relation: XsRelationRecord): void;
  /** receiver→hub `xs_state`: verify socket/xid/sid/revision, merge, forward to the source. */
  onState(agentKey: string, frame: XsStateFrame): void;
  /** `xs_activate_ack`: settle the pending attempt matched by rid + socket (late/unmatched ack
   *  only moves `unknown → consumed` on proof of an applied control action — never refunds). */
  onActivateAck(agentKey: string, frame: XsActivateAckFrame): void;
  /**
   * `xs_req{op:"activate"}` (arch §4.4–§4.6): idempotent relation-level activation. Order:
   * relation/key/target pin → known facts (started/replied no-op, pending/consumed/unknown dup,
   * not-yet-delivered refusal) → target eligibility (member/channel/cap) → retry floor →
   * quota reservation (a NEW control cost; dup/query/no-op never reach it) → ONE relay.
   * `res` is called exactly once. Carries no text ever.
   */
  activate(
    agentKey: string,
    self: XsEffectiveMember,
    args: { to?: string; messageId: string; activationKey: string; level?: number },
    res: (body: XsActivateHubReply) => void,
  ): void;
  /** `xs_req{op:"receipt"}` — read-only; `res` answers on the requesting socket. */
  receipt(
    agentKey: string,
    self: XsEffectiveMember,
    args: { messageId: string; activationKey?: string },
    res: (body: { ok: boolean; code?: string }) => void,
  ): void;
  /** Test/diagnostic: stored relation count (expired included until pruned). */
  size(): number;
  dispose(): void;
}

export interface XsActivationDeps {
  registry: Pick<Registry, "send" | "xsView">;
  /** fabric-xs-activation P3: the shared quota windows (attempt admission). */
  limits?: Pick<XsLimits, "admitActivate" | "settleActivate">;
  members: Pick<XsMembers, "effective">;
  log: HubLog;
  now: () => number;
  /** Key material (tests inject); defaults to `randomBytes(9).toString("hex")`. */
  randomHex?: (bytes: number) => string;
}

function initialSnapshotOf(relation: XsRelationRecord): XsProgress {
  return {
    messageId: relation.messageId,
    revision: 0,
    deliveryEffect: "unknown",
    observation: "live",
    ...(relation.requestId !== undefined ? { requestId: relation.requestId, replyState: "pending" as const } : {}),
    wake: {
      requested: relation.wakeRequested,
      decision: relation.wakeRequested ? "unknown" : "deliver_only",
    },
    activationKey: relation.activationKey,
    activationUntil: relation.trackUntil,
  };
}

export function createXsActivationService(deps: XsActivationDeps): XsActivationService {
  const relations = new Map<string, XsRelationRecord>();
  const randomHex = deps.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const diag = (message: string, data: Record<string, unknown>): void => {
    try {
      deps.log.warn(`xs activation: ${message}`, data);
    } catch {
      /* diagnostics only */
    }
  };
  const prune = (now: number): void => {
    for (const [id, rel] of relations) {
      if (now >= rel.trackUntil) relations.delete(id);
    }
  };
  const pushTo = (agentKey: string, progress: XsProgress, sourceRid: string): void => {
    // Hygiene (arch §4.7): ids/enums/timestamps only — the snapshot never carries body/hash/token.
    const frame: XsStateFrame = { t: "xs_state", ...progress, sourceRid };
    try {
      deps.registry.send(agentKey, frame);
    } catch {
      /* socket gone — the relation stays; the source's receipt re-syncs it */
    }
  };

  /** Settle the PENDING attempt of `rel` from the receiver's ack (exactly once). */
  const settleAttempt = (rel: XsRelationRecord, ack: XsActivateAckFrame): void => {
    const act = rel.act;
    const now = deps.now();
    if (act.timer !== undefined) clearTimeout(act.timer);
    const ticket = act.ticket;
    const respond = act.respond;
    delete act.timer;
    delete act.ticket;
    delete act.respond;
    // The receiver's snapshot is evidence: merge it (monotone revision) like an xs_state.
    if (ack.progress !== undefined && ack.progress.messageId === rel.messageId) {
      if ((rel.lastProgress?.revision ?? 0) <= ack.progress.revision) {
        rel.lastProgress = {
          ...ack.progress,
          ...(rel.requestId !== undefined && ack.progress.requestId === undefined ? { requestId: rel.requestId } : {}),
          activationKey: rel.activationKey,
          activationUntil: rel.trackUntil,
        };
        pushTo(rel.sourceAgentKey, rel.lastProgress, rel.sourceRid);
      }
    }
    const applied = ack.status === "accepted";
    const noop = ack.status === "already_started" || ack.status === "already_replied";
    if (applied) {
      if (ticket !== undefined) deps.limits?.settleActivate(ticket, { none: false });
      act.state = "consumed";
    } else if (ack.status === "unknown") {
      if (ticket !== undefined) deps.limits?.settleActivate(ticket, { none: false });
      act.state = "unknown";
    } else {
      // none-effect outcomes (refused / already_active / no-op / unsupported): this attempt
      // changed nothing ⇒ release ITS wake reservation only (never the send/hub counts).
      if (ticket !== undefined) deps.limits?.settleActivate(ticket, { none: true });
      act.state = noop ? "consumed" : "available";
      if (!noop) {
        act.notBefore = ack.retryAfterAt ?? now;
        const floor: { reason?: string; wakeDowngraded?: string } = {};
        if (ack.reason !== undefined) floor.reason = ack.reason;
        if (ack.wakeDowngraded !== undefined) floor.wakeDowngraded = ack.wakeDowngraded;
        act.floorReason = floor;
      }
    }
    const { t: _t, rid: _rid, ...body } = ack;
    respond?.({ ok: true, activation: body });
  };

  return {
    registerSend(args) {
      const now = deps.now();
      prune(now);
      if (relations.has(args.messageId) || relations.size >= XS_RELATION_CAP) {
        if (relations.has(args.messageId)) diag("relation id collision", { code: "E_XS_INTERNAL" });
        return { ok: false, reason: "full" };
      }
      const trackUntil = xsTrackUntilMs({
        createdAt: now,
        ...(args.expect !== undefined
          ? { expect: { timeoutMs: args.expect.timeoutMs, lateGraceMs: REPLY_LATE_GRACE_MS } }
          : {}),
        replyMaxTimeoutMs: REPLY_MAX_TIMEOUT_MS,
        replyLateGraceMs: REPLY_LATE_GRACE_MS,
      });
      const relation: XsRelationRecord = {
        messageId: args.messageId,
        activationKey: `k${randomHex(9)}`,
        sourceAgentKey: args.sourceAgentKey,
        sourceSessionId: args.sourceSessionId,
        sourceRid: args.sourceRid,
        targetAgentKey: args.targetAgentKey,
        targetSessionId: args.targetSessionId,
        createdAt: now,
        trackUntil: Math.max(trackUntil, now + 1), // never a zero-width window
        requestId: args.expect?.requestId,
        wakeRequested: args.wakeRequested,
        lastProgress: undefined,
        act: { state: "available", notBefore: 0 },
      };
      relations.set(args.messageId, relation);
      return { ok: true, relation };
    },

    pushInitial(relation) {
      const snapshot = initialSnapshotOf(relation);
      relation.lastProgress = snapshot;
      pushTo(relation.sourceAgentKey, snapshot, relation.sourceRid);
    },

    onState(agentKey, frame) {
      const now = deps.now();
      const rel = relations.get(frame.messageId);
      if (rel === undefined) return; // untracked (expired+pruned / restart) — ignore silently
      if (rel.targetAgentKey !== agentKey) {
        diag("state from wrong socket", { messageId: frame.messageId });
        return;
      }
      const eff = deps.members.effective(agentKey);
      if (eff === undefined || eff.sessionId !== rel.targetSessionId) {
        diag("state target session moved", { messageId: frame.messageId });
        return;
      }
      if ((rel.lastProgress?.revision ?? 0) > frame.revision) {
        diag("stale state revision", { messageId: frame.messageId });
        return;
      }
      if (now >= rel.trackUntil) {
        // Refuse FIRST, then lazily clean (arch §4.5) — the tracking epoch ended.
        relations.delete(frame.messageId);
        return;
      }
      // Relation-stable fields are re-overlaid: a receiver frame can never erase the issued
      // key/window (nor fabricate a requestId — `?? rel.requestId` keeps the registered one).
      const { sourceRid: _ignored, ...snapshot } = frame;
      rel.lastProgress = {
        ...snapshot,
        ...(rel.requestId !== undefined && snapshot.requestId === undefined ? { requestId: rel.requestId } : {}),
        activationKey: rel.activationKey,
        activationUntil: rel.trackUntil,
      };
      pushTo(rel.sourceAgentKey, rel.lastProgress, rel.sourceRid);
    },

    onActivateAck(agentKey, frame) {
      const rel = relations.get(frame.messageId);
      const act = rel?.act;
      if (
        rel === undefined ||
        act === undefined ||
        act.rid !== frame.rid ||
        rel.targetAgentKey !== agentKey ||
        frame.activationKey !== rel.activationKey
      ) {
        diag("activate ack without pending", { rid: frame.rid, agentKey });
        return;
      }
      if (act.state === "pending") {
        settleAttempt(rel, frame);
        return;
      }
      // Late ack after the hub already settled the attempt as unknown: it may only prove the
      // control action DID land (unknown → consumed); never a refund, never a reopen.
      if (act.state === "unknown" && frame.status === "accepted" && frame.effect === "applied") act.state = "consumed";
      else diag("late activate ack ignored", { rid: frame.rid });
    },

    activate(agentKey, self, args, res) {
      const now = deps.now();
      prune(now);
      const rel = relations.get(args.messageId);
      if (
        rel === undefined ||
        now >= rel.trackUntil ||
        rel.sourceAgentKey !== agentKey ||
        rel.sourceSessionId !== self.sessionId
      ) {
        res({ ok: false, code: "E_XS_NOT_TRACKED" }); // unknown/expired/foreign: indistinguishable (XI5)
        return;
      }
      if (args.activationKey !== rel.activationKey) {
        res({ ok: false, code: "E_XS_STALE_KEY" });
        return;
      }
      if (
        args.to !== undefined &&
        args.to !== rel.targetSessionId &&
        !(args.to.length >= 8 && rel.targetSessionId.startsWith(args.to))
      ) {
        res({ ok: false, code: "E_XS_BAD_TARGET" });
        return;
      }
      const reply = (
        status: XsActivateResWire["status"],
        effect: XsActivateResWire["effect"],
        extra: Partial<XsActivateResWire> = {},
      ): void => {
        const progress = rel.lastProgress;
        res({
          ok: true,
          activation: {
            messageId: rel.messageId,
            activationKey: rel.activationKey,
            status,
            effect,
            retryable: false,
            ...extra,
            ...(progress !== undefined && extra.progress === undefined ? { progress } : {}),
          },
        });
      };
      const lp = rel.lastProgress;
      // Known facts first — no quota, no relay (started/replied are none no-ops).
      if (lp?.phase === "replied") return reply("already_replied", "none");
      if (lp?.phase === "started") return reply("already_started", "none");
      const act = rel.act;
      if (act.state === "pending") return reply("already_active", "none", { dup: true });
      if (act.state === "consumed") return reply("already_active", "none", { dup: true });
      if (act.state === "unknown") return reply("unknown", "unknown", { reason: "activate_unknown", dup: true });
      if (lp === undefined || lp.deliveryEffect === "none" || lp.phase !== "delivered") {
        // U6: only an already-delivered original body can be activated.
        return reply("refused", "none", {
          reason: "not_delivered",
          retryable: lp?.deliveryEffect !== "none" && lp?.observation !== "unavailable",
        });
      }
      if (lp.observation !== "live") return reply("refused", "none", { reason: lp.observation });
      const target = deps.members.effective(rel.targetAgentKey);
      if (
        target === undefined ||
        target.sessionId !== rel.targetSessionId ||
        !target.joined ||
        target.receive === "off" ||
        !self.joined ||
        hubIntersect(self.channels, target.channels).length === 0
      ) {
        return reply("refused", "none", { reason: "receiver_policy" });
      }
      let activateCapable = false;
      try {
        activateCapable = deps.registry.xsView(rel.targetAgentKey)?.caps.includes(XS_ACTIVATE_AGENT_CAP) === true;
      } catch {
        activateCapable = false;
      }
      if (!activateCapable || deps.limits === undefined) return reply("unsupported", "none");
      if (now < act.notBefore) {
        return reply("refused", "none", {
          ...(act.floorReason ?? {}),
          retryable: true,
          retryAfterAt: act.notBefore,
        });
      }
      const admit = deps.limits.admitActivate({
        agentKey,
        pairKey: `${self.sessionId}>${rel.targetSessionId}`,
        limits: self.limits,
      });
      if (!admit.ok) {
        const quotaWake = admit.reason === "outbound_wake_rate" || admit.reason === "pair_wake_rate";
        return reply("refused", "none", {
          ...(quotaWake ? { wakeDowngraded: admit.reason } : { reason: admit.reason }),
          retryable: true,
          ...(admit.retryAfterAt !== undefined ? { retryAfterAt: admit.retryAfterAt } : {}),
        });
      }
      const rid = `a${randomHex(9)}`;
      const frame: XsActivateFrame = {
        t: "xs_activate",
        rid,
        to: { sessionId: target.sessionId, epoch: target.epoch },
        from: {
          sessionId: self.sessionId,
          ref: self.sessionId.slice(0, 12),
          ...(self.name !== undefined ? { name: self.name.slice(0, 120) } : {}),
          cwdLabel: self.cwd.slice(0, 120),
          agentId: agentKey.slice(0, 128),
        },
        messageId: rel.messageId,
        activationKey: rel.activationKey,
        expiresAt: now + XS_ACTIVATE_RELAY_EXPIRY_MS,
        ...(args.level !== undefined ? { level: args.level } : {}),
      };
      act.state = "pending";
      act.rid = rid;
      act.ticket = admit.ticket;
      act.respond = res;
      let sent = false;
      try {
        sent = deps.registry.send(rel.targetAgentKey, frame);
      } catch {
        sent = false;
      }
      if (!sent) {
        // Provably never left the hub: release this attempt's wake reservation, stay available.
        deps.limits.settleActivate(admit.ticket, { none: true });
        act.state = "available";
        delete act.rid;
        delete act.ticket;
        delete act.respond;
        return reply("refused", "none", { reason: "link_lost", retryable: true });
      }
      const timer = setTimeout(() => {
        // The relay deadline passed with no ack: the control action may or may not have landed.
        if (act.state !== "pending" || act.rid !== rid) return;
        deps.limits?.settleActivate(admit.ticket, { none: false });
        act.state = "unknown";
        const respond = act.respond;
        delete act.respond;
        delete act.ticket;
        delete act.timer;
        respond?.({
          ok: true,
          activation: {
            messageId: rel.messageId,
            activationKey: rel.activationKey,
            status: "unknown",
            effect: "unknown",
            reason: "activate_deadline",
            retryable: false,
            ...(rel.lastProgress !== undefined ? { progress: rel.lastProgress } : {}),
          },
        });
      }, XS_ACTIVATE_RELAY_EXPIRY_MS);
      timer.unref(); // I5: a ref'd timer wedges `pi -p`
      act.timer = timer;
    },

    receipt(agentKey, self, args, res) {
      const now = deps.now();
      prune(now);
      const rel = relations.get(args.messageId);
      if (
        rel === undefined ||
        now >= rel.trackUntil ||
        rel.sourceAgentKey !== agentKey ||
        rel.sourceSessionId !== self.sessionId
      ) {
        // Unknown, expired, foreign or not-this-source: one indistinguishable refusal (XI5).
        res({ ok: false, code: "E_XS_NOT_TRACKED" });
        return;
      }
      if (args.activationKey !== undefined && args.activationKey !== rel.activationKey) {
        res({ ok: false, code: "E_XS_STALE_KEY" });
        return;
      }
      res({ ok: true });
      // The snapshot rides the SAME socket as the reply (the requester IS the source); the
      // agent-side waiter correlates by messageId. lastProgress is never absent here —
      // pushInitial ran at registration — but fail soft regardless.
      pushTo(rel.sourceAgentKey, rel.lastProgress ?? initialSnapshotOf(rel), rel.sourceRid);
    },

    size: () => relations.size,

    dispose() {
      for (const rel of relations.values()) {
        if (rel.act.timer !== undefined) clearTimeout(rel.act.timer);
      }
      relations.clear();
    },
  };
}

/** Plain-send tracking window re-export (the router's diagnostics/tests read one constant). */
export { XS_TRACK_DEFAULT_MS };
