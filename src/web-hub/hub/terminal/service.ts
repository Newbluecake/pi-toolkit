/** Hub control plane only. All shell/PTY effects belong to the agent-owned backend. */
import type { TerminalAuditRecord } from "../audit.js";
import { createHash, randomBytes } from "node:crypto";
import type { AuthIdentity } from "../auth-identity.js";
import type { AuthRevokeBus } from "../auth-revoke.js";
import type { TerminalIngressMeta, TerminalIngressPort } from "../ports.js";
import { createTerminalCommandIngress } from "../commands.js";
import type { CmdFrame } from "../../protocol/messages.js";
import {
  terminalFrameOk,
  canonicalBase64Bytes,
  TERMINAL_LIMITS as L,
  type TerminalHubConfig,
  type TerminalChallenge,
  type TerminalHttpRequests,
  type TerminalHttpResults,
  type TerminalOwnerBinding,
  type TerminalProcessIdentity,
  type TermReq,
  type TermRes,
  type TermEvent,
} from "../../protocol/terminal.js";
import { TerminalLimits, TerminalFault, bounded, clampSpanMs, terminalClock, sameTerminalMeta } from "./limits.js";
import { TerminalCreationTickets } from "./creation-ticket.js";
import { TerminalRevocationFence, matches } from "./revocation-fence.js";
import { TerminalSseBindings, type LiveTerminalBinding } from "./sse-binding.js";
import { TerminalResourceFence } from "./resource-fence.js";
export const terminalId = () => randomBytes(24).toString("base64url");
export type TerminalAgentTarget = {
  meta: TerminalIngressMeta;
  processIdentity: TerminalProcessIdentity;
  allowed: boolean;
};
type Scope = {
  limits: TerminalHubConfig;
  target: TerminalAgentTarget;
  owner: TerminalOwnerBinding;
  channelId: string;
  binding: LiveTerminalBinding;
};
type Writer = {
  binding: LiveTerminalBinding;
  attachmentId: string;
  lease: string;
  expiresAt: number;
  inputPending: number;
  inputBusy: boolean;
  lastInput?: { seq: number; digest: string; acceptedThrough: number };
  unacked: number;
  sentThrough: number;
  ackedThrough: number;
  lastOutputAt: number;
  replay: boolean;
  replayAt?: number;
  streamEpoch?: string;
  resizeSeq: number;
  resizeAccepted: number;
  off: () => void;
};
type RecordRow = {
  ticketExpiresAt: number;
  cleanupAt?: number;
  createdAt: number;
  sessionOrdinal: number;
  displayAllowed: boolean;
  scope: Scope;
  termId: string;
  reservationId: string;
  openId: string;
  revision: number;
  state: "starting" | "live" | "closing" | "exited" | "failed" | "reap_incomplete";
  writer?: Writer;
  fact?: TerminalHttpResults["open"];
  expiresAt: number;
  idleAt: number;
  open?: Promise<TerminalHttpResults["open"]>;
  closeIntent?: string;
};
export interface TerminalServiceDeps {
  config: TerminalHubConfig;
  now: () => number;
  /** Trusted assembly closure, not status/UI strings. Includes current plain/main guard. */
  target: (agentKey: string) => TerminalAgentTarget | undefined;
  targets?: () => readonly TerminalAgentTarget[];
  send: (meta: TerminalIngressMeta, frame: TermReq | CmdFrame) => boolean;
  /** Actual current UDS userland pending bytes, NOT trySend acknowledgement. */
  pendingBytes: (meta: TerminalIngressMeta) => number;
  resourceFence: TerminalResourceFence;
  privacy: { denied: (sessionId: string) => boolean; onChange: (fn: () => void) => () => void };
  audit: (record: TerminalAuditRecord) => boolean | void;
}
export function createTerminalService(deps: TerminalServiceDeps) {
  const now = deps.now;
  let auditFailures = 0;
  const note = (record: TerminalAuditRecord) => {
    try {
      if (deps.audit(record) === false) auditFailures = Math.min(Number.MAX_SAFE_INTEGER, auditFailures + 1);
    } catch {
      auditFailures = Math.min(Number.MAX_SAFE_INTEGER, auditFailures + 1);
    }
  };
  const auth = new TerminalRevocationFence(now);
  const bindings = new TerminalSseBindings(auth, now);
  const tickets = new TerminalCreationTickets(now);
  const limits = new TerminalLimits(deps.config, now);
  const records = new Map<string, RecordRow>();
  const ordinals = new Map<string, number>();
  const offRelease = deps.resourceFence.onRelease((id) => {
    limits.releaseProven(id);
    note({ op: "reap", ok: true, reap: "reaped" });
    for (const r of records.values())
      if (r.reservationId === id) {
        r.state = "exited";
        dropWriter(r);
        tickets.exited(r.openId);
        clearDisplay(r);
        r.cleanupAt = Math.max(r.ticketExpiresAt, now() + L.exitedMs);
      }
  });
  const channels = new Map<string, Promise<Scope>>();
  const resourceChannels = new Map<
    string,
    {
      scope: Scope;
      challenge: TerminalChallenge;
      id: AuthIdentity;
      timer: ReturnType<ReturnType<typeof terminalClock>["setTimer"]>;
    }
  >();
  const offResolved = deps.resourceFence.onResolved((ack, meta, ownerInstance) => {
    const context = resourceChannels.get(ack.challengeId);
    if (
      !context ||
      !sameTerminalMeta(context.scope.target.meta, meta) ||
      context.scope.owner.ownerInstance !== ownerInstance ||
      context.challenge.hubBootId !== ack.hubBootId ||
      context.challenge.linkGen !== ack.linkGen ||
      now() >= context.challenge.deadlineAt
    )
      return;
    const send = (identities: typeof ack.identities) => {
      admit(context.id, context.scope.binding, context.scope.target, new AbortController().signal);
      const frame: TermReq = {
        t: "term_req",
        v: 1,
        rid: terminalId(),
        sessionId: meta.sessionId,
        epoch: meta.epoch,
        ownerInstance,
        channelId: context.scope.channelId,
        op: "resolved_ack",
        resolved: { ...ack, identities },
      };
      if (!terminalFrameOk(frame)) return false;
      return deps.send(meta, frame);
    };
    // Metadata batches may have long identities; cap the ACTUAL dedicated frame too.
    let batch: typeof ack.identities = [];
    for (const identity of ack.identities) {
      const proposed = [...batch, identity];
      const probe = {
        t: "term_req",
        v: 1,
        rid: "x".repeat(32),
        sessionId: meta.sessionId,
        epoch: meta.epoch,
        ownerInstance,
        channelId: context.scope.channelId,
        op: "resolved_ack",
        resolved: { ...ack, identities: proposed },
      };
      if (batch.length && !terminalFrameOk(probe)) {
        if (!send(batch)) return;
        batch = [];
      }
      batch.push(identity);
    }
    if (batch.length) send(batch);
  });
  const waits = new Map<
    string,
    { meta: TerminalIngressMeta; guard: () => void; resolve: (r: TermRes) => void; reject: (e: unknown) => void }
  >();
  const inventoryWaits = new Map<
    string,
    { meta: TerminalIngressMeta; accept: (r: Extract<TermRes, { op: "inventory"; ok: true }>) => void }
  >();
  const offers = new Map<
    string,
    { meta: TerminalIngressMeta; guard: () => void; resolve: (id: string) => void; reject: (e: unknown) => void }
  >();
  let disposed = false;
  const safeTarget = (agentKey: string) => {
    try {
      return deps.target(agentKey);
    } catch {
      return undefined;
    }
  };
  const privacyDenied = (sessionId: string) => {
    try {
      return deps.privacy.denied(sessionId);
    } catch {
      return true;
    }
  };
  const current = (meta: TerminalIngressMeta) => {
    const t = safeTarget(meta.agentKey);
    return !disposed && t?.allowed === true && sameTerminalMeta(t.meta, meta);
  };
  const commandIngress = createTerminalCommandIngress({
    current,
    onOffer: (meta, id, offer) => {
      const p = offers.get(id);
      if (!p || !sameTerminalMeta(meta, p.meta)) return;
      offers.delete(id);
      if (offer) p.resolve(offer.offerId);
      else p.reject(new TerminalFault("E_UNSUPPORTED"));
    },
    onDedicated: (meta, raw) => {
      if (!terminalFrameOk(raw) || !current(meta)) return;
      const r = raw as TermRes | TermEvent;
      if (r.sessionId !== meta.sessionId || r.epoch !== meta.epoch) return;
      if (r.t === "term_res") {
        const inventory = inventoryWaits.get(r.rid);
        if (inventory && r.ok && r.op === "inventory" && sameTerminalMeta(inventory.meta, meta)) {
          inventory.accept(r);
          return;
        }
        const p = waits.get(r.rid);
        if (p && sameTerminalMeta(p.meta, meta)) {
          waits.delete(r.rid);
          p.resolve(r);
        }
        return;
      }
      if (r.t === "term_event") event(meta, r);
    },
  });
  const ingress: TerminalIngressPort = {
    ...commandIngress,
    retireLink: (meta) => {
      commandIngress.retireLink(meta);
      deps.resourceFence.retireLink(meta);
      cancelLink(meta);
    },
    onIngressFailure: (meta) => {
      commandIngress.onIngressFailure?.(meta);
      cancelLink(meta);
    },
  };
  function cancelLink(meta: TerminalIngressMeta) {
    for (const r of records.values())
      if (r.scope.target.meta.agentKey === meta.agentKey && r.scope.target.meta.linkGen === meta.linkGen) closeRow(r);
    for (const [k, p] of waits)
      if (p.meta.agentKey === meta.agentKey) {
        waits.delete(k);
        p.reject(new TerminalFault("E_SESSION_CHANGED", "unknown"));
      }
    for (const [k, p] of offers)
      if (p.meta.agentKey === meta.agentKey) {
        offers.delete(k);
        p.reject(new TerminalFault("E_SESSION_CHANGED"));
      }
    channels.clear();
  }
  function admit(id: AuthIdentity, b: LiveTerminalBinding, target: TerminalAgentTarget, signal: AbortSignal) {
    if (disposed || signal.aborted) throw new TerminalFault("E_DEADLINE");
    auth.proof(id);
    if (
      !b.metadata.live ||
      !b.active ||
      b.identity.listener !== id.listener ||
      b.identity.principal !== id.principal ||
      b.identity.sidTag !== id.sidTag ||
      now() >= b.metadata.parentExpiresAt
    )
      throw new TerminalFault("E_AUTH");
    if (!current(target.meta)) throw new TerminalFault("E_SESSION_CHANGED");
    if (privacyDenied(target.meta.sessionId)) throw new TerminalFault("E_PRIVACY_LOCKED");
  }
  async function exchange(
    meta: TerminalIngressMeta,
    request: TermReq,
    at: number,
    signal: AbortSignal,
    guard: () => void,
  ): Promise<TermRes> {
    if (waits.size >= (request.op === "input" ? 128 : 256)) throw new TerminalFault("E_LIMIT");
    let resolve!: (r: TermRes) => void, reject!: (e: unknown) => void;
    const p = new Promise<TermRes>((a, b) => {
      resolve = a;
      reject = b;
    });
    waits.set(request.rid, { meta, guard, resolve, reject });
    try {
      guard();
      if (
        request.op === "input" &&
        deps.pendingBytes(meta) + Buffer.byteLength(JSON.stringify(request)) + 1 > L.udsPendingBytes
      )
        throw new TerminalFault("E_RATE");
      if (!terminalFrameOk(request) || !deps.send(meta, request))
        throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
      let r: TermRes;
      try {
        r = await bounded(p, now, at, signal);
        guard();
      } catch (e) {
        if (e instanceof TerminalFault && (request.op === "input" || request.op === "open"))
          throw new TerminalFault(e.code, "unknown");
        throw e;
      }
      if (!r.ok) throw new TerminalFault(r.code, r.effect);
      if ("ownerInstance" in request && r.ownerInstance !== request.ownerInstance)
        throw new TerminalFault("E_SESSION_CHANGED", "unknown");
      return r;
    } finally {
      waits.delete(request.rid);
    }
  }
  async function negotiate(
    id: AuthIdentity,
    b: LiveTerminalBinding,
    target: TerminalAgentTarget,
    mode: "interactive" | "resource-only",
    signal: AbortSignal,
  ): Promise<Scope> {
    target = structuredClone(target);
    const at = now() + L.bootstrapMs,
      meta = target.meta,
      commandId = terminalId(),
      rid = terminalId();
    const guard = () => admit(id, b, target, signal);
    guard();
    if (offers.size >= L.offers || !commandIngress.register(meta, { rid, commandId }))
      throw new TerminalFault("E_LIMIT");
    let resolve!: (id: string) => void, reject!: (e: unknown) => void;
    const p = new Promise<string>((a, b) => {
      resolve = a;
      reject = b;
    });
    offers.set(commandId, { meta, guard, resolve, reject });
    try {
      guard();
      const frame: CmdFrame = {
        t: "cmd",
        rid,
        id: commandId,
        deadlineMs: clampSpanMs(at - now()),
        origin: { listener: id.listener, user: id.principal, ip: "terminal", reqId: rid },
        cmd: {
          expect: { sessionId: meta.sessionId },
          op: "command",
          name: "webhub",
          args: `__terminal ${JSON.stringify({ v: 1, action: mode === "interactive" ? "negotiate" : "resource_inventory", requestNonce: terminalId() })}`,
        },
      };
      if (!deps.send(meta, frame)) throw new TerminalFault("E_UNSUPPORTED");
      const offerId = await bounded(p, now, at, signal);
      guard();
      const hubNonce = terminalId();
      const challenge = await exchange(
        meta,
        {
          t: "term_req",
          v: 1,
          rid: terminalId(),
          sessionId: meta.sessionId,
          epoch: meta.epoch,
          op: "prepare_protocol",
          offerId,
          hubNonce,
        },
        at,
        signal,
        guard,
      );
      if (
        !challenge.ok ||
        challenge.op !== "protocol_challenge" ||
        challenge.offerId !== offerId ||
        challenge.hubNonce !== hubNonce ||
        !commandIngress.bindOwner(meta, commandId, challenge.ownerInstance)
      )
        throw new TerminalFault("E_UNSUPPORTED");
      const owner: TerminalOwnerBinding = {
        listener: id.listener,
        principal: id.principal,
        sidTag: id.sidTag,
        agentKey: meta.agentKey,
        sessionId: meta.sessionId,
        epoch: meta.epoch,
        ownerInstance: challenge.ownerInstance,
      };
      const readyFields = { offerId, hubNonce, agentChallenge: challenge.agentChallenge };
      const scopeFields = { sessionId: meta.sessionId, epoch: meta.epoch, ownerInstance: owner.ownerInstance };
      const ready = await exchange(
        meta,
        { t: "term_req", v: 1, rid: terminalId(), ...scopeFields, op: "protocol_ready", ...readyFields },
        at,
        signal,
        guard,
      );
      if (
        !ready.ok ||
        ready.op !== "protocol_ready" ||
        ready.mode !== mode ||
        ready.offerId !== offerId ||
        ready.hubNonce !== hubNonce ||
        ready.agentChallenge !== challenge.agentChallenge
      )
        throw new TerminalFault("E_UNSUPPORTED");
      if (ready.mode === "resource-only")
        return { limits: deps.config, target, owner, channelId: ready.channelId, binding: b };
      if (now() >= ready.expiresAt) throw new TerminalFault("E_DEADLINE");
      const channelId = terminalId();
      const bound = await exchange(
        meta,
        {
          t: "term_req",
          v: 1,
          rid: terminalId(),
          ...scopeFields,
          op: "bind",
          ...readyFields,
          proposedChannelId: channelId,
          grant: ready.grant,
        },
        at,
        signal,
        guard,
      );
      if (!bound.ok || bound.op !== "bind" || bound.channelId !== channelId) throw new TerminalFault("E_UNSUPPORTED");
      const intersection = Object.fromEntries(
        Object.entries(deps.config).map(([k, v]) => [k, Math.min(v, ready.limits[k as keyof TerminalHubConfig])]),
      ) as TerminalHubConfig;
      return { limits: intersection, target, owner, channelId, binding: b };
    } finally {
      offers.delete(commandId);
      commandIngress.expire(meta, commandId);
    }
  }
  async function scope(id: AuthIdentity, b: LiveTerminalBinding, target: TerminalAgentTarget, signal: AbortSignal) {
    const key = JSON.stringify([b.metadata.connectionInstance, target.meta]);
    let p = channels.get(key);
    if (!p) {
      if (channels.size >= 64) throw new TerminalFault("E_LIMIT");
      p = negotiate(id, b, target, "interactive", signal);
      channels.set(key, p);
      const off = b.onRevoke(() => {
        channels.delete(key);
        off();
      });
      p.catch(() => {
        channels.delete(key);
        off();
      });
    }
    const s = await bounded(p, now, now() + L.bootstrapMs, signal);
    admit(id, b, target, signal);
    return s;
  }
  function clearDisplay(r: RecordRow) {
    r.displayAllowed = false;
    if (r.fact) {
      const {
        shellName: _,
        userLabel: __,
        hostLabel: ___,
        cwd: ____,
        sessionOrdinal: _____,
        createdAt: ______,
        writerPresent: _______,
        ownerLabel: ________,
        ...fact
      } = r.fact;
      r.fact = fact;
    }
  }
  function project(r: RecordRow, panel = false) {
    if (!r.fact) throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
    const f = r.fact;
    const facts = {
      termId: f.termId,
      reservationId: f.reservationId,
      revision: r.revision,
      state: r.state,
      nextInputSeq: f.nextInputSeq,
      baseOffset: f.baseOffset,
      nextOffset: f.nextOffset,
      deadlines: {
        inputIdleAt: r.idleAt,
        lifetimeAt: r.expiresAt,
        parentExpiresAt: r.scope.binding.metadata.parentExpiresAt,
      },
    };
    const metadata = r.displayAllowed
      ? {
          sessionOrdinal: r.sessionOrdinal,
          createdAt: r.createdAt,
          writerPresent: r.writer !== undefined && now() < r.writer.expiresAt,
          ownerLabel: "本登录",
        }
      : {};
    if (!panel) return { ...facts, ...metadata };
    return {
      ok: true as const,
      ...facts,
      attachmentId: f.attachmentId,
      writerLease: f.writerLease,
      replayMode: f.replayMode,
      ...metadata,
      ...(r.displayAllowed
        ? {
            ...(f.shellName === undefined ? {} : { shellName: f.shellName }),
            ...(f.userLabel === undefined ? {} : { userLabel: f.userLabel }),
            ...(f.hostLabel === undefined ? {} : { hostLabel: f.hostLabel }),
            ...(f.cwd === undefined ? {} : { cwd: f.cwd }),
          }
        : {}),
    };
  }
  function closeRow(r: RecordRow) {
    if (r.state === "exited") return;
    dropWriter(r);
    r.state = "closing";
    // Cleanup is not a new user admission. It remains allowed after revoke/timeout.
    try {
      if (safeTarget(r.scope.target.meta.agentKey)?.meta.linkGen === r.scope.target.meta.linkGen)
        deps.send(r.scope.target.meta, {
          t: "term_req",
          v: 1,
          rid: terminalId(),
          sessionId: r.scope.owner.sessionId,
          epoch: r.scope.owner.epoch,
          ownerInstance: r.scope.owner.ownerInstance,
          channelId: r.scope.channelId,
          op: "close",
          termId: r.termId,
          reservationId: r.reservationId,
          closeId: terminalId(),
          expectedRevision: r.revision,
        });
    } catch {
      note({ op: "close", ok: false, code: "E_UNAVAILABLE" });
    }
  }
  function dropWriter(r: RecordRow) {
    const w = r.writer;
    if (!w) return;
    delete r.writer;
    w.off();
    w.inputPending = 0;
    w.inputBusy = false;
    delete w.lastInput;
    limits.drop(r.termId);
  }
  function writer(r: RecordRow, b: LiveTerminalBinding, attachmentId: string, lease: string, replayReserved = false) {
    if (r.writer && now() >= r.writer.expiresAt) dropWriter(r);
    if (r.writer) throw new TerminalFault("E_WRITER_BUSY");
    if (!replayReserved) limits.beginReplay(r.termId);
    const w: Writer = {
      binding: b,
      attachmentId,
      lease,
      expiresAt: Math.min(now() + L.leaseMs, b.metadata.parentExpiresAt),
      inputPending: 0,
      inputBusy: false,
      unacked: 0,
      sentThrough: 0,
      ackedThrough: 0,
      lastOutputAt: now(),
      replay: true,
      resizeSeq: -1,
      resizeAccepted: -1,
      off: () => {},
    };
    r.writer = w;
    w.off = b.onRevoke(() => {
      if (r.writer === w) {
        clearDisplay(r);
        dropWriter(r);
      }
    });
    return w;
  }
  function requireWriter(r: RecordRow, b: LiveTerminalBinding, attachmentId: string, lease: string) {
    const w = r.writer;
    if (!w || now() >= w.expiresAt) {
      dropWriter(r);
      throw new TerminalFault("E_LEASE_EXPIRED");
    }
    if (w.binding !== b || w.attachmentId !== attachmentId || w.lease !== lease)
      throw new TerminalFault("E_LEASE_EXPIRED");
    return w;
  }
  function event(meta: TerminalIngressMeta, e: TermEvent) {
    const r = records.get(e.termId),
      w = r?.writer;
    if (
      !r ||
      r.scope.target.meta.agentKey !== meta.agentKey ||
      r.scope.target.meta.linkGen !== meta.linkGen ||
      r.scope.owner.ownerInstance !== e.ownerInstance ||
      r.scope.channelId !== e.channelId ||
      e.revision < r.revision
    )
      return;
    r.revision = e.revision;
    if (e.kind === "state") r.state = e.state;
    // exit is a UI fact, NEVER a physical resource proof or reservation release.
    if (e.kind === "exit") {
      r.state = e.reap === "reaped" ? "exited" : "reap_incomplete";
      note({
        op: e.reap === "reaped" ? "exit" : "reap-incomplete",
        ok: e.reap === "reaped",
        reap: e.reap === "reaped" ? "reaped" : "reap_incomplete",
        ...(e.exitCode === undefined ? {} : { exitCode: e.exitCode }),
      });
    }
    if (!w) return;
    const send = () => {
      try {
        admit(w.binding.identity, w.binding, r.scope.target, new AbortController().signal);
        if (r.writer !== w || now() >= w.expiresAt || (w.replayAt !== undefined && w.replay && now() >= w.replayAt))
          return false;
        if (now() >= r.expiresAt || now() >= r.idleAt) {
          closeRow(r);
          return false;
        }
      } catch {
        dropWriter(r);
        return false;
      }
      const { t: _, channelId: __, ...event } = e;
      if (
        !w.binding.send("terminal", {
          agentKey: meta.agentKey,
          attachmentId: w.attachmentId,
          connectionInstance: w.binding.metadata.connectionInstance,
          event,
        })
      ) {
        dropWriter(r);
        return false;
      }
      if (e.kind === "cutover") {
        w.replay = false;
        w.streamEpoch = e.newLiveEpoch;
        w.unacked = 0;
        w.sentThrough = e.liveFrom;
        w.ackedThrough = e.liveFrom;
        w.lastOutputAt = now();
        delete w.replayAt;
        limits.endReplay(r.termId);
      }
      return true;
    };
    if (e.kind === "output") {
      const bytes = canonicalBase64Bytes(e.bytesB64) ?? L.outputChunkBytes + 1;
      if (
        w.unacked + bytes > (w.replay ? L.replayBytes : L.liveWindowBytes) ||
        (w.unacked > 0 && now() - w.lastOutputAt >= L.viewerMs)
      ) {
        dropWriter(r);
        return;
      }
      if (r.fact) r.fact.nextOffset = Math.max(r.fact.nextOffset, e.offset + bytes);
      w.unacked += bytes;
      w.sentThrough = Math.max(w.sentThrough, e.offset + bytes);
      w.lastOutputAt = now();
      if (!limits.enqueue(r.termId, bytes, send, w.replay)) dropWriter(r);
      else limits.drain();
    } else {
      if (e.kind === "replay_begin") {
        w.replay = true;
        w.replayAt = Math.min(e.deadlineAt, now() + L.replayMs);
      }
      if (e.kind === "gap" && r.fact) {
        r.fact.baseOffset = e.baseOffset;
        r.fact.nextOffset = e.nextOffset;
      }
      // Preserve replay-output → cutover order. Cleanup/revocation uses a separate priority path.
      if (!limits.enqueue(r.termId, 0, send)) dropWriter(r);
      else limits.drain();
    }
  }
  const offRevoke = auth.subscribe((s) => {
    channels.clear();
    for (const [k, p] of waits) {
      try {
        p.guard();
      } catch (e) {
        waits.delete(k);
        p.reject(e);
      }
    }
    for (const [k, p] of offers) {
      try {
        p.guard();
      } catch (e) {
        offers.delete(k);
        p.reject(e);
      }
    }
    for (const r of records.values())
      if (matches(s, r.scope.binding.identity)) {
        clearDisplay(r);
        closeRow(r);
        note({ op: "auth-revoked", ok: true });
      }
  });
  const offPrivacy = deps.privacy.onChange(() => {
    for (const r of records.values())
      if (privacyDenied(r.scope.owner.sessionId)) {
        clearDisplay(r);
        closeRow(r);
      }
    channels.clear();
  });
  const clock = terminalClock(now);
  let timer: ReturnType<typeof clock.setTimer> | undefined;
  function sweep() {
    if (disposed) return;
    for (const r of records.values()) {
      if (r.cleanupAt !== undefined && now() > r.cleanupAt) {
        records.delete(r.termId);
        continue;
      }
      if (
        now() >= r.expiresAt ||
        now() >= r.idleAt ||
        privacyDenied(r.scope.owner.sessionId) ||
        !current(r.scope.target.meta)
      ) {
        if (r.state !== "closing" && r.state !== "exited") {
          clearDisplay(r);
          closeRow(r);
          note({ op: now() >= r.expiresAt ? "lifetime-expired" : "idle-expired", ok: true });
        }
      }
      if (
        r.writer &&
        (now() >= r.writer.expiresAt ||
          (r.writer.replay && r.writer.replayAt !== undefined && now() >= r.writer.replayAt) ||
          (r.writer.unacked > 0 && now() - r.writer.lastOutputAt >= L.viewerMs))
      )
        dropWriter(r);
    }
    limits.drain();
    timer = clock.setTimer(100, sweep);
  }
  timer = clock.setTimer(100, sweep);
  async function request<K extends keyof TerminalHttpRequests>(
    op: K,
    body: TerminalHttpRequests[K],
    id: AuthIdentity,
    b: LiveTerminalBinding,
    signal: AbortSignal,
  ): Promise<TerminalHttpResults[K]> {
    const liveTarget = safeTarget(body.agentKey);
    const target = liveTarget === undefined ? undefined : structuredClone(liveTarget);
    if (!target?.allowed) throw new TerminalFault("E_UNSUPPORTED");
    if (target.meta.sessionId !== body.expect.sessionId || target.meta.epoch !== body.expect.epoch)
      throw new TerminalFault("E_SESSION_CHANGED");
    admit(id, b, target, signal);
    if (deps.resourceFence.snapshot().state !== "cleared" && (op === "prepare" || op === "open")) {
      deps.resourceFence.startCollection();
      await Promise.all(
        (deps.targets?.() ?? [target])
          .slice(0, 32)
          .filter((t) => t.allowed)
          .map((t) => collect(id, b, t, signal).catch(() => {})),
      );
      deps.resourceFence.assertOpen();
    }
    const s = await scope(id, b, target, signal);
    admit(id, b, target, signal);
    const owner = s.owner;
    // The generic discriminant is rechecked below; the HTTP parser already validated closed schemas.
    const req = body as TerminalHttpRequests[keyof TerminalHttpRequests];
    if (op === "prepare" && "cols" in req) {
      deps.resourceFence.assertOpen();
      const ticket = tickets.prepare(owner, req.cols, req.rows);
      return { ok: true, openId: ticket.ticketId, createTicket: ticket } as unknown as TerminalHttpResults[K];
    }
    if (op === "list") {
      const rows = [...records.values()]
        .filter((r) => sameOwner(r.scope.owner, owner) && r.fact && r.state !== "exited")
        .map((r) => project(r));
      return { ok: true, revision: deps.resourceFence.records().revision, rows } as TerminalHttpResults[K];
    }
    if (op === "open" && "createTicket" in req && "cols" in req) {
      const termId = terminalId(),
        reservationId = terminalId();
      if (req.openId !== req.createTicket.ticketId) throw new TerminalFault("E_STALE_CREATION");
      const ticketRow = tickets.verify(req.createTicket, owner, req.cols, req.rows)!;
      if (ticketRow.phase !== "issued") {
        const old = records.get(ticketRow.termId!);
        if (!old) throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
        if (old.scope.binding !== b || old.writer?.binding !== b) throw new TerminalFault("E_WRITER_BUSY");
        if (old.open) return old.open as Promise<TerminalHttpResults[K]>;
        if (old.fact) return project(old, true) as TerminalHttpResults[K];
        throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
      }
      deps.resourceFence.assertOpen();
      const ordinal = (ordinals.get(owner.sessionId) ?? 0) + 1;
      if (!Number.isSafeInteger(ordinal) || (!ordinals.has(owner.sessionId) && ordinals.size >= 2048))
        throw new TerminalFault("E_LIMIT");
      // All fallible logical admissions precede the one physical reservation/ticket CAS.
      limits.beginReplay(termId);
      try {
        limits.reserve(reservationId, owner.sessionId, `${owner.listener}:${owner.principal}`, s.limits);
      } catch (e) {
        limits.endReplay(termId);
        throw e;
      }
      tickets.redeem(req.createTicket, owner, req.cols, req.rows, termId);
      ordinals.set(owner.sessionId, ordinal);
      const r: RecordRow = {
        ticketExpiresAt: req.createTicket.expiresAt,
        createdAt: now(),
        sessionOrdinal: ordinal,
        displayAllowed: true,
        scope: s,
        termId,
        reservationId,
        openId: req.openId,
        state: "starting",
        revision: 0,
        expiresAt: Math.min(now() + s.limits.maxLifetimeMs, b.metadata.parentExpiresAt),
        idleAt: now() + s.limits.inputIdleMs,
      };
      records.set(termId, r);
      const w = writer(r, b, terminalId(), terminalId(), true);
      const work = (async () => {
        try {
          await deps.resourceFence.reserve(
            {
              identity: {
                agentSessionId: owner.sessionId,
                epoch: owner.epoch,
                ownerInstance: owner.ownerInstance,
                termId,
                reservationId,
              },
              agentProcessIdentity: target.processIdentity,
              managed: [],
              spawnState: "pending",
              state: "reserved",
            },
            signal,
          );
          admit(id, b, target, signal);
          const response = await exchange(
            target.meta,
            {
              t: "term_req",
              v: 1,
              rid: terminalId(),
              sessionId: owner.sessionId,
              epoch: owner.epoch,
              ownerInstance: owner.ownerInstance,
              channelId: s.channelId,
              op: "open",
              openId: req.openId,
              createTicket: req.createTicket,
              cols: req.cols,
              rows: req.rows,
              termId,
              reservationId,
              ownerKey: createHash("sha256").update(JSON.stringify(owner)).digest("hex"),
              attachmentId: w.attachmentId,
              writerLease: w.lease,
            },
            now() + L.startupMs,
            signal,
            () => admit(id, b, target, signal),
          );
          if (
            !response.ok ||
            response.op !== "open" ||
            response.termId !== termId ||
            response.reservationId !== reservationId ||
            response.attachmentId !== w.attachmentId ||
            response.writerLease !== w.lease ||
            r.writer !== w
          )
            throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
          const {
            t: _,
            v: __,
            rid: ___,
            sessionId: ____,
            epoch: _____,
            ownerInstance: ______,
            channelId: _______,
            op: ________,
            ...fact
          } = response;
          r.fact = fact;
          r.state = response.state;
          r.revision = response.revision;
          return project(r, true) as TerminalHttpResults["open"];
        } catch (e) {
          closeRow(r);
          throw e;
        }
      })();
      r.open = work;
      work
        .finally(() => {
          delete r.open;
        })
        .catch(() => {});
      return work as Promise<TerminalHttpResults[K]>;
    }
    if (op === "state" && "target" in req && "openId" in req.target) {
      try {
        tickets.verify(req.target.createTicket, owner);
      } catch (e) {
        if (e instanceof TerminalFault && e.code === "E_EXPIRED")
          return {
            ok: true,
            fact: { state: "expired", effect: "unknown", code: "E_EXPIRED" },
          } as TerminalHttpResults[K];
        throw e;
      }
    }
    const termId =
      "termId" in req
        ? req.termId
        : "target" in req && "termId" in req.target
          ? req.target.termId
          : "target" in req && "openId" in req.target
            ? [...records.values()].find((r) => r.openId === (req.target as { openId: string }).openId)?.termId
            : undefined;
    const r = termId ? records.get(termId) : undefined;
    if (!r || !sameOwner(r.scope.owner, owner)) throw new TerminalFault("E_AUTH");
    if (op !== "state" && op !== "close" && (now() >= r.expiresAt || now() >= r.idleAt)) {
      closeRow(r);
      throw new TerminalFault("E_EXPIRED");
    }
    if (op === "state") {
      if (!r.fact) return { ok: true, fact: { state: "unknown", effect: "unknown" } } as TerminalHttpResults[K];
      return { ok: true, fact: project(r) } as TerminalHttpResults[K];
    }
    let w: Writer | undefined;
    if (op === "attach" && "attachId" in req) {
      w = writer(r, b, terminalId(), terminalId());
    } else if (op !== "close" && "attachmentId" in req) w = requireWriter(r, b, req.attachmentId, req.writerLease);
    const raw: Record<string, unknown> = { ...req };
    for (const k of ["agentKey", "expect", "clientId", "connectionInstance", "connectionToken", "tabId"]) delete raw[k];
    if (op === "close" && "closeId" in req) {
      if (r.closeIntent !== undefined)
        return { ok: true, state: "closing", revision: r.revision } as TerminalHttpResults[K];
      if (req.expectedRevision !== r.revision) throw new TerminalFault("E_SESSION_CHANGED");
      r.closeIntent = req.closeId;
      r.state = "closing";
      dropWriter(r);
      raw.reservationId = r.reservationId;
    }
    if (op === "attach") {
      raw.attachmentId = w!.attachmentId;
      raw.writerLease = w!.lease;
    }
    if (op === "input" && "inputSeq" in req) {
      const digest = createHash("sha256").update(req.bytesB64).digest("hex");
      if (w!.lastInput?.seq === req.inputSeq) {
        if (w!.lastInput.digest !== digest) throw new TerminalFault("E_INPUT_SEQUENCE");
        return { ok: true, acceptedThrough: w!.lastInput.acceptedThrough } as TerminalHttpResults[K];
      }
      const bytes = canonicalBase64Bytes(req.bytesB64) ?? L.inputBytes + 1;
      if (w!.replay) throw new TerminalFault("E_REPLAY_BUSY");
      if (req.streamEpoch !== w!.streamEpoch) throw new TerminalFault("E_INPUT_SEQUENCE");
      if (w!.inputBusy || bytes + w!.inputPending > L.inputPendingBytes) throw new TerminalFault("E_RATE");
      w!.inputBusy = true;
      w!.inputPending += bytes;
    }
    if (op === "resize" && "resizeSeq" in req) {
      if (req.resizeSeq < w!.resizeSeq || req.resizeSeq === w!.resizeAccepted)
        return { ok: true, revision: r.revision } as TerminalHttpResults[K];
      if (req.resizeSeq === w!.resizeSeq) throw new TerminalFault("E_RATE");
      w!.resizeSeq = req.resizeSeq;
    }
    try {
      const response = await exchange(
        target.meta,
        {
          t: "term_req",
          v: 1,
          rid: terminalId(),
          sessionId: owner.sessionId,
          epoch: owner.epoch,
          ownerInstance: owner.ownerInstance,
          channelId: r.scope.channelId,
          ...raw,
          op,
        } as TermReq,
        now() + L.controlMs,
        signal,
        () => {
          admit(id, b, target, signal);
          if (w && (r.writer !== w || now() >= w.expiresAt)) {
            dropWriter(r);
            throw new TerminalFault("E_LEASE_EXPIRED");
          }
        },
      );
      if (!response.ok || response.op !== op || !("channelId" in response) || response.channelId !== r.scope.channelId)
        throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
      if ("revision" in response) r.revision = Math.max(r.revision, response.revision);
      if (op === "attach" && response.op === "attach") {
        if (response.attachmentId !== w!.attachmentId || response.writerLease !== w!.lease)
          throw new TerminalFault("E_UNKNOWN_EFFECT", "unknown");
        const {
          t: _,
          v: __,
          rid: ___,
          sessionId: ____,
          epoch: _____,
          ownerInstance: ______,
          channelId: _______,
          op: ________,
          ...fact
        } = response;
        r.fact = fact;
        r.displayAllowed = true;
        return project(r, true) as TerminalHttpResults[K];
      }
      if (op === "input" && "inputSeq" in req && response.op === "input") {
        w!.lastInput = {
          seq: req.inputSeq,
          digest: createHash("sha256").update(req.bytesB64).digest("hex"),
          acceptedThrough: response.acceptedThrough,
        };
        if (req.inputKind === "user" && (canonicalBase64Bytes(req.bytesB64) ?? 0) > 0)
          r.idleAt = Math.min(r.expiresAt, now() + r.scope.limits.inputIdleMs);
        if (r.fact) r.fact.nextInputSeq = response.acceptedThrough + 1;
      }
      if (op === "resize" && "resizeSeq" in req) w!.resizeAccepted = req.resizeSeq;
      if (op === "detach") dropWriter(r);
      if (op === "renew") w!.expiresAt = Math.min(now() + L.leaseMs, b.metadata.parentExpiresAt);
      if (op === "ack" && "ack" in req && req.ack.phase === "live") {
        const through = req.ack.renderedThrough;
        if (through < w!.ackedThrough || through > w!.sentThrough) throw new TerminalFault("E_INPUT_SEQUENCE");
        w!.unacked = Math.max(0, w!.unacked - (through - w!.ackedThrough));
        w!.ackedThrough = through;
      }
      if (op === "close") {
        r.state = "closing";
        dropWriter(r);
      }
      const {
        t: _,
        v: __,
        rid: ___,
        sessionId: ____,
        epoch: _____,
        ownerInstance: ______,
        channelId: _______,
        op: ________,
        ...result
      } = response;
      return result as unknown as TerminalHttpResults[K];
    } catch (e) {
      if (op === "attach") dropWriter(r);
      throw e;
    } finally {
      if (w && op === "input") {
        w.inputBusy = false;
        w.inputPending = 0;
      }
    }
  }
  function sameOwner(a: TerminalOwnerBinding, b: TerminalOwnerBinding) {
    return (
      a.listener === b.listener &&
      a.principal === b.principal &&
      a.sidTag === b.sidTag &&
      a.agentKey === b.agentKey &&
      a.sessionId === b.sessionId &&
      a.epoch === b.epoch &&
      a.ownerInstance === b.ownerInstance
    );
  }
  async function collect(id: AuthIdentity, b: LiveTerminalBinding, target: TerminalAgentTarget, signal: AbortSignal) {
    if (inventoryWaits.size >= L.unresolvedResources || resourceChannels.size >= L.unresolvedResources)
      throw new TerminalFault("E_LIMIT");
    const totalAt = now() + L.httpMs;
    const s = await negotiate(id, b, target, "resource-only", signal),
      rid = terminalId();
    if (inventoryWaits.size >= L.unresolvedResources || resourceChannels.size >= L.unresolvedResources)
      throw new TerminalFault("E_LIMIT");
    const challenge = deps.resourceFence.begin(target.meta, s.owner.ownerInstance, target.processIdentity);
    const expiry = clock.setTimer(clampSpanMs(challenge.deadlineAt - now()), () =>
      resourceChannels.delete(challenge.challengeId),
    );
    resourceChannels.set(challenge.challengeId, { scope: s, challenge, id, timer: expiry });
    let resolve!: () => void, reject!: (e: unknown) => void;
    const done = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    let chain = Promise.resolve();
    inventoryWaits.set(rid, {
      meta: target.meta,
      accept: (r) => {
        if (r.channelId !== s.channelId || r.ownerInstance !== s.owner.ownerInstance) {
          reject(new TerminalFault("E_SESSION_CHANGED"));
          return;
        }
        chain = chain
          .then(async () => {
            admit(id, b, target, signal);
            const status = await deps.resourceFence.page(target.meta, r.page, signal);
            if (status !== "accepted") throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
            if (r.page.phase === "end") resolve();
          })
          .catch(reject);
      },
    });
    try {
      admit(id, b, target, signal);
      if (
        !deps.send(target.meta, {
          t: "term_req",
          v: 1,
          rid,
          sessionId: s.owner.sessionId,
          epoch: s.owner.epoch,
          ownerInstance: s.owner.ownerInstance,
          channelId: s.channelId,
          op: "inventory",
          challenge,
        })
      )
        throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
      await bounded(done, now, Math.min(totalAt, challenge.deadlineAt), signal);
    } finally {
      inventoryWaits.delete(rid);
    }
  }
  return {
    auth,
    bindings,
    ingress,
    limits,
    tickets,
    request,
    collect,
    connectAuth: (bus: AuthRevokeBus) => auth.connect(bus),
    auditHealth: () => ({ failures: auditFailures }),
    /** Pure-data activation handoff; includes an ambiguous pre-dispatch journal commit.
     * No fd, callback, capability or live owner can cross reload through this object. */
    unresolvedResources() {
      const entries = deps.resourceFence
        .records()
        .resources.filter((r) => r.status === "unresolved")
        .map((r) => r.entry);
      for (const r of records.values())
        if (r.cleanupAt === undefined && !entries.some((e) => e.identity.reservationId === r.reservationId))
          entries.push({
            identity: {
              agentSessionId: r.scope.owner.sessionId,
              termId: r.termId,
              epoch: r.scope.owner.epoch,
              ownerInstance: r.scope.owner.ownerInstance,
              reservationId: r.reservationId,
            },
            agentProcessIdentity: r.scope.target.processIdentity,
            managed: [],
            spawnState: "pending",
            state: "poison",
          });
      if (entries.length > L.unresolvedResources) throw new TerminalFault("E_RESOURCE_QUARANTINED", "unknown");
      return structuredClone(entries);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clock.clearTimer(timer);
      offPrivacy();
      offRevoke();
      offRelease();
      offResolved();
      for (const c of resourceChannels.values()) clock.clearTimer(c.timer);
      resourceChannels.clear();
      bindings.dispose();
      for (const r of records.values()) closeRow(r);
      for (const p of waits.values()) p.reject(new TerminalFault("E_DISABLED"));
      for (const p of offers.values()) p.reject(new TerminalFault("E_DISABLED"));
      waits.clear();
      offers.clear();
      channels.clear();
      auth.dispose();
    },
  };
}
export type TerminalService = ReturnType<typeof createTerminalService>;
