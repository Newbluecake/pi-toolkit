/** Per-activation/session owner (r4 §§5–6). No live shell in the process-global connection.
 * wireWebHub owns dispose; Stack and pi hooks must NOT acquire a second owner. */
import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { Value } from "@sinclair/typebox/value";
import { systemClock, type Clock, type TimerHandle } from "../../../core/clock.js";
import { clampSpanMs } from "../../../core/deadline.js";
import { createTerminalNegotiator } from "../commands.js";
import type { CmdFrame } from "../../protocol/messages.js";
import {
  TERMINAL_LIMITS as L,
  TermReqSchema,
  canonicalTerminalInventory,
  terminalFrameOk,
  terminalIdentityKey,
  type TermReq,
  type TermRes,
  type TermEvent,
  type TerminalHubConfig,
  type TerminalNegotiation,
  type TerminalProtocolReadyProof,
  type TerminalResourceIdentity,
  type TerminalResourceEntry,
  type TerminalProcessIdentity,
  type TerminalReapProof,
  type TerminalInventoryPage,
} from "../../protocol/terminal.js";
import {
  createTerminalBackend,
  type TerminalBackend,
  type TerminalBackendOptions,
  type TerminalPhysicalResult,
} from "./backend.js";
import { TerminalBackendError } from "./environment.js";
import { readTerminalIdentity, TerminalReaper } from "./reaper.js";

export class TerminalTail {
  private buffer = Buffer.alloc(0);
  base = 0;
  next = 0;
  get droppedBytes(): number {
    return this.base;
  }
  append(bytes: Buffer): number {
    if (!Number.isSafeInteger(this.next + bytes.length)) throw new TerminalBackendError("E_LIMIT");
    const offset = this.next;
    if (!bytes.length) return offset;
    if (bytes.length && this.buffer.length === 0) this.buffer = Buffer.alloc(L.ringBytes);
    const data = bytes.subarray(Math.max(0, bytes.length - L.ringBytes));
    const start = (this.next + bytes.length - data.length) % L.ringBytes;
    const n = Math.min(data.length, L.ringBytes - start);
    data.copy(this.buffer, start, 0, n);
    data.copy(this.buffer, 0, n);
    this.next += bytes.length;
    this.base = Math.max(this.base, this.next - L.ringBytes);
    return offset;
  }
  suffix(max = L.replayBytes): { S: number; N0: number; bytes: Buffer } {
    const S = Math.max(this.base, this.next - Math.min(max, L.replayBytes));
    const bytes = Buffer.alloc(this.next - S);
    if (!bytes.length) return { S, N0: this.next, bytes };
    const start = S % L.ringBytes;
    const n = Math.min(bytes.length, L.ringBytes - start);
    this.buffer.copy(bytes, 0, start, start + n);
    this.buffer.copy(bytes, n, 0, bytes.length - n);
    return { S, N0: this.next, bytes };
  }
  clear(): void {
    this.buffer.fill(0);
    this.buffer = Buffer.alloc(0); // Exited ticket tombstones must not pin a 1MiB ring each.
    this.base = this.next;
  }
}

type Current = { localConnectionInstance: string; sessionId: string; epoch: string };
export interface TerminalOwnerOptions {
  sessionId: string;
  epoch: string;
  cwd: string;
  limits: TerminalHubConfig;
  /** Actual plain/main/live secure-domain check. Missing/throw ⇒ false. */
  allowed(): boolean;
  current(): Current | undefined;
  /** Dedicated only; false means NOT sent. Never enqueue in generic slots or event bus. */
  send(frame: TermRes | TermEvent): boolean;
  /** Test clock is internal DI, not settings/wire. */
  clock?: Clock;
  /** Trusted private backend factory for isolated harnesses. Production omits it. */
  backend?: (options: TerminalBackendOptions) => TerminalBackend;
}
interface Attachment {
  id: string;
  lease: string;
  channelId: string;
  until: number;
  phase: "replaying" | "writable";
  attemptId: string;
  replayEpoch: string;
  liveEpoch: string;
  N0: number;
  sentThrough: number;
  ackThrough: number;
  replayTimer?: TimerHandle;
  viewerTimer?: TimerHandle;
}
interface Row {
  identity: TerminalResourceIdentity;
  openId: string;
  ownerKey: string;
  payload: string;
  ticketExpiresAt: number;
  parentExpiresAt: number;
  inputIdleAt: number;
  lifetimeAt: number;
  retired?: true;
  resolved?: true;
  revision: number;
  state: "starting" | "live" | "closing" | "exited" | "failed" | "reap_incomplete";
  tail: TerminalTail;
  backend?: TerminalBackend;
  physical?: TerminalPhysicalResult;
  attachment?: Attachment;
  nextInputSeq: number;
  resizeSeq: number;
  backendResizeSeq: number;
  resizePromise?: Promise<void>;
  cols: number;
  rows: number;
  input?: { seq: number; bytesB64: string; kind: string; promise: Promise<void> };
  lastInput?: { seq: number; bytesB64: string; kind: string };
  resizeMarks: Array<{ offset: number; cols: number; rows: number }>;
  reaper?: TerminalReaper;
}
interface TerminalReapReceipt {
  entry: TerminalResourceEntry;
  physical: TerminalPhysicalResult;
}
const RECEIPTS_KEY = Symbol.for("pi-subagent:web-hub:terminal-reap-receipts-v1");
/** ≤32 plain, physically proven receipts. No TTL/eviction before trusted durable confirmation. */
function receiptStore(): TerminalReapReceipt[] {
  const g = globalThis as Record<symbol, unknown>;
  return (g[RECEIPTS_KEY] ??= []) as TerminalReapReceipt[];
}
const HANDOFF_KEY = Symbol.for("pi-subagent:web-hub:terminal-resource-fence-v1");
/** Plain data only; ≤32; no timers, fd, closure, env, cwd, shell bytes or TTL. */
function handoffStore(): TerminalResourceEntry[] {
  const g = globalThis as Record<symbol, unknown>;
  return (g[HANDOFF_KEY] ??= []) as TerminalResourceEntry[];
}
export function terminalResourceHandoff(): TerminalResourceEntry[] {
  return structuredClone(handoffStore());
}

export async function createTerminalOwner(options: TerminalOwnerOptions): Promise<TerminalOwner> {
  const identity = await readTerminalIdentity(process.pid);
  if (!identity) throw new TerminalBackendError("E_BACKEND_CAPABILITY");
  return new TerminalOwner(options, {
    bootId: identity.bootId,
    pid: identity.pid,
    starttime: identity.starttime,
    uid: identity.uid,
  });
}
export class TerminalOwner {
  readonly ownerInstance = randomUUID();
  readonly negotiator: ReturnType<typeof createTerminalNegotiator>;
  private readonly rows = new Map<string, Row>();
  private readonly channels = new Map<string, Pick<TerminalProtocolReadyProof, "mode" | "localConnectionInstance">>();
  private readonly clock: Clock;
  private tickTimer: TimerHandle | undefined;
  private lostTimer: TimerHandle | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private frozenInventory = 0;
  private revision = 0;
  private linkInstance: string | undefined;
  constructor(
    private readonly options: TerminalOwnerOptions,
    readonly processIdentity: TerminalProcessIdentity,
  ) {
    this.clock = options.clock ?? systemClock;
    this.negotiator = createTerminalNegotiator({
      now: () => this.clock.now(),
      limits: options.limits,
      allowed: () => this.allowed(),
      current: () => {
        const c = this.current();
        return c ? { ...c, ownerInstance: this.ownerInstance } : undefined;
      },
      send: (f) => {
        if (!options.send(f)) this.linkLost();
      },
      onBound: (id, proof) => {
        if (!this.allowed() || this.channels.size >= L.offers) return;
        this.linkInstance = proof.localConnectionInstance;
        this.channels.set(id, { mode: proof.mode, localConnectionInstance: proof.localConnectionInstance });
      },
    });
    // No timer until the first real terminal/resource channel; off/unused stays inert.
  }
  get physicalUsed(): number {
    const own = [...this.rows.values()].filter((r) => r.physical?.outcome !== "reaped").length;
    return own + handoffStore().filter((e) => e.identity.ownerInstance !== this.ownerInstance).length;
  }
  offer(frame: CmdFrame, request: TerminalNegotiation) {
    if (!this.allowed()) {
      this.revoke();
      return undefined;
    }
    return this.negotiator.offer(frame, request);
  }
  private current(): Current | undefined {
    try {
      const c = this.options.current();
      return c?.sessionId === this.options.sessionId && c.epoch === this.options.epoch ? c : undefined;
    } catch {
      return undefined;
    }
  }
  private allowed(): boolean {
    try {
      return !this.disposed && this.options.allowed() && !!this.current();
    } catch {
      return false;
    }
  }
  private scope() {
    return { sessionId: this.options.sessionId, epoch: this.options.epoch, ownerInstance: this.ownerInstance };
  }
  private response(f: TermReq, body: object): void {
    if (!this.allowed()) {
      this.revoke();
      return;
    }
    if (
      "channelId" in f &&
      this.channels.get(f.channelId)?.localConnectionInstance !== this.current()?.localConnectionInstance
    )
      return;
    const result = {
      t: "term_res",
      v: 1,
      ...this.scope(),
      rid: f.rid,
      ...("channelId" in f ? { channelId: f.channelId } : {}),
      op: f.op,
      ...body,
    } as TermRes;
    if (!terminalFrameOk(result)) throw new Error("terminal response contract");
    if (!this.options.send(result)) this.linkLost();
  }
  private error(f: TermReq, code: string, effect: "none" | "unknown" = "none"): void {
    this.response(f, { ok: false, code, effect });
  }
  /** Called ONLY by BindingPort.onTerminalReq on the current live connection. */
  receive(raw: unknown): boolean {
    if (!terminalFrameOk(raw) || !Value.Check(TermReqSchema, raw)) return false;
    const f = raw as TermReq;
    if (!this.allowed()) {
      this.revoke();
      return false;
    }
    if (["prepare_protocol", "protocol_ready", "bind"].includes(f.op)) return this.negotiator.receive(f);
    if (
      !this.allowed() ||
      !("channelId" in f) ||
      !("ownerInstance" in f) ||
      f.ownerInstance !== this.ownerInstance ||
      f.sessionId !== this.options.sessionId ||
      f.epoch !== this.options.epoch
    )
      return false;
    const proof = this.channels.get(f.channelId);
    if (!proof || proof.localConnectionInstance !== this.current()?.localConnectionInstance) return false;
    if (f.op === "inventory") {
      void this.inventory(f);
      return true;
    }
    if (proof.mode !== "interactive") return false;
    this.armTick();
    if (f.op === "open") {
      void this.open(f);
      return true;
    }
    if (f.op === "list") {
      this.response(f, {
        ok: true,
        revision: this.revision,
        rows: [...this.rows.values()].filter((r) => !r.resolved).map((r) => this.facts(r)),
      });
      return true;
    }
    if (f.op === "state") {
      const r = [...this.rows.values()].find((r) =>
        "termId" in f.target
          ? r.identity.termId === f.target.termId
          : "openId" in f.target
            ? r.openId === f.target.openId
            : r.identity.reservationId === f.target.reservationId,
      );
      this.response(f, { ok: true, fact: r ? this.facts(r) : { state: "unknown", effect: "unknown" } });
      return true;
    }
    if (!("termId" in f)) return false;
    const r = this.rows.get(f.termId);
    if (!r) {
      this.error(f, "E_BAD_REQUEST");
      return true;
    }
    if (f.op === "close") {
      if (f.reservationId !== r.identity.reservationId || f.expectedRevision !== r.revision)
        this.error(f, "E_BAD_REQUEST");
      else {
        this.closeRow(r);
        this.response(f, { ok: true, state: "closing", revision: r.revision });
      }
      return true;
    }
    if (f.op === "attach") {
      this.attach(r, f);
      return true;
    }
    const a = r.attachment;
    if (
      !a ||
      a.id !== f.attachmentId ||
      a.lease !== f.writerLease ||
      a.channelId !== f.channelId ||
      this.clock.now() >= a.until
    ) {
      this.error(f, "E_LEASE_EXPIRED");
      return true;
    }
    if (f.op === "detach") {
      this.detach(r);
      this.response(f, { ok: true, revision: r.revision });
      return true;
    }
    if (f.op === "renew") {
      a.until = this.clock.now() + clampSpanMs(L.leaseMs)!;
      this.response(f, { ok: true, revision: r.revision });
      return true;
    }
    if (f.op === "ack") {
      this.ack(r, a, f);
      return true;
    }
    if (r.state !== "live" || a.phase !== "writable") {
      this.error(f, "E_LEASE_EXPIRED");
      return true;
    }
    if (f.op === "input") {
      void this.input(r, a, f);
      return true;
    }
    if (f.op === "resize") {
      void this.resize(r, f);
      return true;
    }
    return false;
  }
  private facts(r: Row) {
    return {
      termId: r.identity.termId,
      reservationId: r.identity.reservationId,
      revision: r.revision,
      state: r.state,
      nextInputSeq: r.nextInputSeq,
      baseOffset: r.tail.base,
      nextOffset: r.tail.next,
      deadlines: { inputIdleAt: r.inputIdleAt, lifetimeAt: r.lifetimeAt, parentExpiresAt: r.parentExpiresAt },
    };
  }
  private event(r: Row, body: object): boolean {
    const a = r.attachment;
    if (!this.allowed()) {
      this.revoke();
      return false;
    }
    if (!a || this.channels.get(a.channelId)?.localConnectionInstance !== this.current()?.localConnectionInstance)
      return false;
    const frame = {
      t: "term_event",
      v: 1,
      ...this.scope(),
      channelId: a.channelId,
      termId: r.identity.termId,
      revision: r.revision,
      ...body,
    } as TermEvent;
    if (!terminalFrameOk(frame)) throw new Error("terminal event contract");
    return this.options.send(frame);
  }
  private bump(r: Row): void {
    r.revision++;
    this.revision++;
  }
  private async open(f: Extract<TermReq, { op: "open" }>): Promise<void> {
    const existing = [...this.rows.values()].find((r) => r.openId === f.openId);
    const payload = JSON.stringify({
      ticket: f.createTicket,
      termId: f.termId,
      reservationId: f.reservationId,
      ownerKey: f.ownerKey,
      attachmentId: f.attachmentId,
      writerLease: f.writerLease,
      cols: f.cols,
      rows: f.rows,
    });
    if (existing) {
      if (existing.payload !== payload) this.error(f, "E_STALE_CREATION");
      else if (existing.state === "live" && !existing.retired && existing.attachment?.channelId === f.channelId)
        this.openResponse(existing, f);
      else this.error(f, "E_UNKNOWN_EFFECT", "unknown");
      return;
    }
    const now = this.clock.now();
    const binding = f.createTicket.ownerBinding;
    if (
      now >= f.createTicket.expiresAt ||
      binding.sessionId !== this.options.sessionId ||
      binding.epoch !== this.options.epoch ||
      binding.ownerInstance !== this.ownerInstance
    ) {
      this.error(f, "E_EXPIRED");
      return;
    }
    // The trusted H validated ticket MAC, principal & reservation before this dedicated request.
    // A still pins the exact identity/payload so replays cannot cause another fork.
    if (
      this.frozenInventory ||
      this.physicalUsed >= this.options.limits.maxPerSession ||
      handoffStore().length >= L.unresolvedResources
    ) {
      this.error(f, "E_RESOURCE_QUARANTINED");
      return;
    }
    // Retain at most 32 resource receipts (including exited ticket tombstones) so a full
    // inventory remains representable; never evict an ACK-lost receipt to admit a new fork.
    if (
      this.rows.size >= L.ticketsPerOwner ||
      this.resourceEntries().length >= L.unresolvedResources ||
      this.rows.has(f.termId) ||
      [...this.rows.values()].some((r) => r.identity.reservationId === f.reservationId)
    ) {
      this.error(f, "E_LIMIT");
      return;
    }
    const r: Row = {
      identity: {
        agentSessionId: this.options.sessionId,
        termId: f.termId,
        epoch: this.options.epoch,
        ownerInstance: this.ownerInstance,
        reservationId: f.reservationId,
      },
      openId: f.openId,
      ownerKey: f.ownerKey,
      payload,
      ticketExpiresAt: f.createTicket.expiresAt,
      parentExpiresAt: Number.MAX_SAFE_INTEGER,
      inputIdleAt: now + clampSpanMs(this.options.limits.inputIdleMs)!,
      lifetimeAt: now + clampSpanMs(this.options.limits.maxLifetimeMs)!,
      revision: 1,
      state: "starting",
      tail: new TerminalTail(),
      nextInputSeq: 0,
      resizeSeq: -1,
      backendResizeSeq: 0,
      cols: f.cols,
      rows: f.rows,
      resizeMarks: [],
    };
    // Synchronous physical reservation BEFORE any helper/probe/fork; never finally-decrement.
    this.rows.set(f.termId, r);
    this.revision++;
    try {
      r.backend = (this.options.backend ?? createTerminalBackend)({
        cwd: this.options.cwd,
        cols: f.cols,
        rows: f.rows,
        inputIdleMs: this.options.limits.inputIdleMs,
        maxLifetimeMs: this.options.limits.maxLifetimeMs,
        onData: (bytes) => this.output(r, bytes),
        onManaged: () => this.persistUnresolved(r),
      });
      void r.backend.done.then((p) => this.physicalDone(r, p));
      await r.backend.ready;
      if (!this.allowed() || r.state !== "starting" || !this.channels.has(f.channelId)) {
        this.closeRow(r);
        return;
      }
      r.state = "live";
      this.bump(r);
      this.startAttachment(r, f.channelId, f.attachmentId, f.writerLease);
      this.openResponse(r, f);
      this.beginReplay(r);
    } catch (error) {
      this.closeRow(r);
      if (!r.backend) {
        // The production factory validates and throws TerminalBackendError BEFORE spawn.
        // An unexpected/custom factory failure is not a proof that nothing was launched.
        const preSpawn = error instanceof TerminalBackendError;
        this.physicalDone(r, {
          outcome: preSpawn ? "reaped" : "reap_incomplete",
          spawnSettled: preSpawn,
          ptyClosed: preSpawn,
          helperReaped: preSpawn,
          managedGroupsGone: preSpawn,
          identitiesChecked: [],
          waited: [],
        });
      }
      this.error(
        f,
        error instanceof TerminalBackendError ? error.code : "E_BACKEND_CAPABILITY",
        r.physical?.outcome === "reaped" ? "none" : "unknown",
      );
    }
  }
  private openResponse(r: Row, f: Extract<TermReq, { op: "open" | "attach" }>): void {
    const a = r.attachment!;
    const body: Record<string, unknown> = {
      ok: true,
      ...this.facts(r),
      attachmentId: a.id,
      writerLease: a.lease,
      replayMode: "cold",
    };
    for (const [key, value] of Object.entries(r.backend?.display ?? {})) {
      const candidate = {
        t: "term_res",
        v: 1,
        ...this.scope(),
        rid: f.rid,
        channelId: f.channelId,
        op: f.op,
        ...body,
        [key]: value,
      };
      if (terminalFrameOk(candidate)) body[key] = value;
    }
    this.response(f, body);
  }
  private startAttachment(r: Row, channelId: string, id: string, lease: string): void {
    r.attachment = {
      id,
      lease,
      channelId,
      until: this.clock.now() + clampSpanMs(L.leaseMs)!,
      phase: "replaying",
      attemptId: randomUUID(),
      replayEpoch: randomUUID(),
      liveEpoch: randomUUID(),
      N0: r.tail.next,
      sentThrough: r.tail.next,
      ackThrough: r.tail.next,
    };
  }
  private attach(r: Row, f: Extract<TermReq, { op: "attach" }>): void {
    if (r.state !== "live" || r.retired) {
      this.error(f, "E_BAD_REQUEST");
      return;
    }
    if (r.attachment && this.clock.now() < r.attachment.until) {
      if (
        r.attachment.id === f.attachmentId &&
        r.attachment.lease === f.writerLease &&
        r.attachment.channelId === f.channelId
      ) {
        this.openResponse(r, f);
        return;
      }
      this.error(f, "E_WRITER_BUSY");
      return;
    }
    this.detach(r);
    r.cols = f.cols;
    r.rows = f.rows;
    this.startAttachment(r, f.channelId, f.attachmentId, f.writerLease);
    this.bump(r);
    this.openResponse(r, f);
    this.beginReplay(r, f.fromOffset);
  }
  private beginReplay(r: Row, requested = 0): void {
    const a = r.attachment!;
    const suffix = r.tail.suffix();
    a.N0 = suffix.N0;
    const deadlineAt = this.clock.now() + clampSpanMs(L.replayMs)!;
    a.replayTimer = this.clock.setTimer(clampSpanMs(L.replayMs)!, () => {
      if (r.attachment === a && a.phase === "replaying") this.detach(r);
    });
    if (requested < suffix.S)
      this.event(r, {
        kind: "gap",
        requestedOffset: requested,
        baseOffset: suffix.S,
        nextOffset: suffix.N0,
        reason: "evicted",
      });
    if (
      !this.event(r, {
        kind: "replay_begin",
        attemptId: a.attemptId,
        replayEpoch: a.replayEpoch,
        S: suffix.S,
        N0: suffix.N0,
        deadlineAt,
      })
    ) {
      this.detach(r);
      return;
    }
    for (let offset = 0; offset < suffix.bytes.length; offset += L.outputChunkBytes) {
      if (
        !this.event(r, {
          kind: "output",
          offset: suffix.S + offset,
          bytesB64: suffix.bytes.subarray(offset, offset + L.outputChunkBytes).toString("base64"),
          streamEpoch: a.replayEpoch,
        })
      ) {
        this.detach(r);
        return;
      }
    }
  }
  private ack(r: Row, a: Attachment, f: Extract<TermReq, { op: "ack" }>): void {
    const ack = f.ack;
    if (ack.phase === "replay_ready") {
      if (
        a.phase !== "replaying" ||
        ack.attemptId !== a.attemptId ||
        ack.replayEpoch !== a.replayEpoch ||
        ack.renderedThrough !== a.N0
      ) {
        this.error(f, "E_REPLAY_DEADLINE");
        return;
      }
      if (a.replayTimer) this.clock.clearTimer(a.replayTimer);
      delete a.replayTimer;
      const N1 = r.tail.next;
      if (
        !this.event(r, {
          kind: "cutover",
          attemptId: a.attemptId,
          newLiveEpoch: a.liveEpoch,
          replayEnd: a.N0,
          liveFrom: N1,
          gap: { from: a.N0, to: N1 },
          resetParser: true,
        })
      ) {
        this.detach(r);
        this.error(f, "E_REPLAY_DEADLINE");
        return;
      }
      // No asynchronous boundary between cutover and the live barrier. No replay staging.
      a.phase = "writable";
      a.sentThrough = N1;
      a.ackThrough = N1;
      void r.backend?.resize(++r.backendResizeSeq, r.cols, r.rows, true).catch(() => this.closeRow(r));
    } else {
      if (a.phase !== "writable" || ack.renderedThrough < a.ackThrough || ack.renderedThrough > a.sentThrough) {
        this.error(f, "E_BAD_REQUEST");
        return;
      }
      a.ackThrough = ack.renderedThrough;
      if (a.viewerTimer) this.clock.clearTimer(a.viewerTimer);
      delete a.viewerTimer;
      if (a.sentThrough > a.ackThrough) this.armViewer(r, a);
    }
    this.response(f, { ok: true, revision: r.revision });
  }
  private armViewer(r: Row, a: Attachment): void {
    if (a.viewerTimer) return;
    a.viewerTimer = this.clock.setTimer(clampSpanMs(L.viewerMs)!, () => {
      if (r.attachment === a) {
        this.event(r, {
          kind: "gap",
          requestedOffset: a.ackThrough,
          baseOffset: r.tail.base,
          nextOffset: r.tail.next,
          reason: "slow-viewer",
        });
        this.detach(r);
      }
    });
  }
  private output(r: Row, bytes: Buffer): void {
    if (r.state !== "live" && r.state !== "starting") return;
    let offset: number;
    try {
      offset = r.tail.append(bytes);
    } catch {
      this.closeRow(r);
      return;
    }
    const a = r.attachment;
    if (!a || a.phase !== "writable") return; // replay has exactly zero live staging
    if (offset + bytes.length - a.ackThrough > L.liveWindowBytes) {
      this.event(r, {
        kind: "gap",
        requestedOffset: a.ackThrough,
        baseOffset: r.tail.base,
        nextOffset: r.tail.next,
        reason: "slow-viewer",
      });
      this.detach(r);
      return;
    }
    for (let n = 0; n < bytes.length; n += L.outputChunkBytes) {
      if (
        !this.event(r, {
          kind: "output",
          offset: offset + n,
          bytesB64: bytes.subarray(n, n + L.outputChunkBytes).toString("base64"),
          streamEpoch: a.liveEpoch,
        })
      ) {
        this.detach(r);
        return;
      }
    }
    a.sentThrough = offset + bytes.length;
    this.armViewer(r, a);
  }
  private async input(r: Row, a: Attachment, f: Extract<TermReq, { op: "input" }>): Promise<void> {
    if (f.streamEpoch !== a.liveEpoch) {
      this.error(f, "E_INPUT_SEQUENCE");
      return;
    }
    const identical = (i: { seq: number; bytesB64: string; kind: string }) =>
      i.seq === f.inputSeq && i.bytesB64 === f.bytesB64 && i.kind === f.inputKind;
    if (r.lastInput && identical(r.lastInput)) {
      this.response(f, { ok: true, acceptedThrough: f.inputSeq });
      return;
    }
    if (r.input) {
      if (!identical(r.input)) {
        this.error(f, "E_INPUT_SEQUENCE");
        return;
      }
      // Do not accumulate unbounded duplicate waiters while a kernel write is pending.
      this.error(f, "E_UNKNOWN_EFFECT", "unknown");
      return;
    }
    if (f.inputSeq !== r.nextInputSeq || !r.backend) {
      this.error(f, "E_INPUT_SEQUENCE");
      return;
    }
    const pending = {
      seq: f.inputSeq,
      bytesB64: f.bytesB64,
      kind: f.inputKind,
      promise: r.backend.input(
        f.inputSeq,
        Buffer.from(f.bytesB64, "base64"),
        f.inputKind === "user" ? "user" : "terminal_response",
      ),
    };
    r.input = pending;
    try {
      await pending.promise;
      r.nextInputSeq++;
      if (r.state === "live" && r.attachment === a) r.lastInput = pending;
      if (f.inputKind === "user" && f.bytesB64.length > 0)
        r.inputIdleAt = this.clock.now() + clampSpanMs(this.options.limits.inputIdleMs)!;
      this.response(f, { ok: true, acceptedThrough: f.inputSeq });
    } catch {
      this.error(f, "E_UNKNOWN_EFFECT", "unknown");
      this.closeRow(r);
    } finally {
      delete r.input;
    }
  }
  private resize(r: Row, f: Extract<TermReq, { op: "resize" }>): void {
    if (f.resizeSeq <= r.resizeSeq) {
      this.response(f, { ok: true, revision: r.revision });
      return;
    }
    r.resizeSeq = f.resizeSeq;
    r.cols = f.cols;
    r.rows = f.rows;
    r.resizeMarks.push({ offset: r.tail.next, cols: f.cols, rows: f.rows });
    if (r.resizeMarks.length > L.resizeMarks) r.resizeMarks.shift();
    try {
      const pending = r.backend?.resize(++r.backendResizeSeq, f.cols, f.rows, f.redraw);
      // ACK is acceptance of latest-wins geometry. Only one observer per shared batch;
      // never retain one async continuation per incoming resize request.
      if (pending && pending !== r.resizePromise) {
        r.resizePromise = pending;
        void pending.catch(() => this.closeRow(r));
      }
      this.response(f, { ok: true, revision: r.revision });
    } catch {
      this.error(f, "E_UNKNOWN_EFFECT", "unknown");
    }
  }
  private detach(r: Row): void {
    const a = r.attachment;
    if (!a) return;
    if (a.replayTimer) this.clock.clearTimer(a.replayTimer);
    if (a.viewerTimer) this.clock.clearTimer(a.viewerTimer);
    delete r.attachment;
    this.bump(r);
    // A write already handed to the kernel cannot be withdrawn; never claim otherwise.
  }
  private closeRow(r: Row): void {
    if (r.physical?.outcome === "reaped" || r.state === "closing" || r.state === "reap_incomplete") return;
    r.state = "closing";
    this.bump(r);
    this.detach(r);
    r.tail.clear();
    delete r.lastInput;
    r.backend?.close();
    this.persistUnresolved(r);
  }
  private entry(r: Row): TerminalResourceEntry {
    return {
      identity: { ...r.identity },
      agentProcessIdentity: { ...this.processIdentity },
      managed: [...(r.backend?.managed ?? r.physical?.identitiesChecked ?? [])],
      spawnState: r.backend?.spawnSettled || r.physical?.spawnSettled ? "settled" : "pending",
      state:
        r.state === "reap_incomplete"
          ? "poison"
          : r.state === "live"
            ? "live"
            : r.state === "starting"
              ? "starting"
              : "closing",
    };
  }
  private persistUnresolved(r: Row): void {
    if (r.resolved) return;
    if (r.physical?.outcome === "reaped") {
      this.retainReceipt(r);
      return;
    }
    if (!this.disposed) return;
    const store = handoffStore();
    const entry = this.entry(r);
    const key = terminalIdentityKey(r.identity);
    const index = store.findIndex((e) => terminalIdentityKey(e.identity) === key);
    if (index >= 0) store[index] = structuredClone(entry);
    else if (store.length < L.unresolvedResources) store.push(structuredClone(entry));
    // Capacity is admission-limited before spawning, never evict an unresolved resource.
  }
  private retainReceipt(r: Row): void {
    if (r.resolved || r.physical?.outcome !== "reaped") return;
    const store = receiptStore();
    const key = terminalIdentityKey(r.identity);
    const index = store.findIndex((e) => terminalIdentityKey(e.entry.identity) === key);
    const receipt = { entry: this.entry(r), physical: structuredClone(r.physical) };
    if (index >= 0) store[index] = receipt;
    else if (store.length < L.unresolvedResources) store.push(receipt);
  }
  /** Trusted-local only; dedicated resolved frame adapter must first validate the current
   * challenge/link/inventory proof set. Never call this from HTTP/cmd/ordinary ACK. */
  forgetResolvedReceipts(identities: readonly TerminalResourceIdentity[]): number {
    const keys = identities.map(terminalIdentityKey);
    const store = receiptStore();
    if (
      !keys.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !store.some((r) => terminalIdentityKey(r.entry.identity) === key))
    )
      return 0;
    for (const key of keys) {
      const index = store.findIndex((r) => terminalIdentityKey(r.entry.identity) === key);
      store.splice(index, 1);
      for (const row of this.rows.values()) if (terminalIdentityKey(row.identity) === key) row.resolved = true;
    }
    this.revision++;
    return keys.length;
  }
  private physicalDone(r: Row, physical: TerminalPhysicalResult): void {
    r.physical = physical;
    if (physical.outcome === "reaped") {
      r.state = "exited";
      r.backend?.close(); // Clear optional display cache even after a natural exit.
      r.reaper?.stop();
      const store = handoffStore();
      const index = store.findIndex((e) => terminalIdentityKey(e.identity) === terminalIdentityKey(r.identity));
      if (index >= 0) store.splice(index, 1);
    } else {
      r.state = "reap_incomplete";
      r.reaper ??= new TerminalReaper(async () => {
        if (!r.backend) return false;
        const next = await r.backend.retryReap();
        if (next.outcome !== "reaped") return false;
        this.physicalDone(r, next);
        return true;
      });
      r.reaper.start();
    }
    this.bump(r);
    this.event(r, {
      kind: "exit",
      reap: physical.outcome,
      ...(physical.exitCode === undefined ? {} : { exitCode: physical.exitCode }),
      ...(physical.signal === undefined ? {} : { signal: physical.signal }),
    });
    this.detach(r);
    r.tail.clear();
    delete r.lastInput;
    this.persistUnresolved(r);
  }
  /** Only produces a proof from actual backend receipt + wait + /proc validation.
   * Caller H still must validate challenge/coverage and durably commit before ITS release CAS. */
  reapProof(
    identity: TerminalResourceIdentity,
    evidence: Pick<TerminalReapProof, "hubBootId" | "challengeId" | "linkGen" | "inventoryId" | "revision">,
  ): TerminalReapProof | undefined {
    const row = this.rows.get(identity.termId);
    const local = row && terminalIdentityKey(row.identity) === terminalIdentityKey(identity) ? row : undefined;
    const retained = receiptStore().find(
      (r) => terminalIdentityKey(r.entry.identity) === terminalIdentityKey(identity),
    );
    const p = local?.physical ?? retained?.physical;
    if (p?.outcome !== "reaped" || !p.spawnSettled || !p.ptyClosed || !p.helperReaped || !p.managedGroupsGone)
      return undefined;
    return {
      ...evidence,
      identity: { ...identity },
      agentProcessIdentity: { ...(local ? this.processIdentity : retained!.entry.agentProcessIdentity) },
      proofId: randomUUID(),
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
      identitiesChecked: structuredClone(p.identitiesChecked),
      outcome: "reaped",
    };
  }
  resourceEntries(): TerminalResourceEntry[] {
    const entries = new Map<string, TerminalResourceEntry>();
    for (const r of receiptStore()) entries.set(terminalIdentityKey(r.entry.identity), structuredClone(r.entry));
    for (const e of handoffStore()) entries.set(terminalIdentityKey(e.identity), structuredClone(e));
    for (const r of this.rows.values()) if (!r.resolved) entries.set(terminalIdentityKey(r.identity), this.entry(r));
    return [...entries.values()];
  }
  private async inventory(f: Extract<TermReq, { op: "inventory" }>): Promise<void> {
    if (this.clock.now() >= f.challenge.deadlineAt || f.challenge.deadlineAt - this.clock.now() > L.inventoryMs) {
      this.error(f, "E_DEADLINE");
      return;
    }
    this.frozenInventory++;
    try {
      // Inventory itself never spawns. Every snapshot gets a fresh revision, including
      // changes from an old owner's reaper mutating the plain-data handoff.
      this.revision++;
      const entries = this.resourceEntries();
      if (entries.length > L.unresolvedResources) {
        this.error(f, "E_RESOURCE_QUARANTINED");
        return;
      }
      const evidence = {
        hubBootId: f.challenge.hubBootId,
        challengeId: f.challenge.challengeId,
        linkGen: f.challenge.linkGen,
        inventoryId: randomUUID(),
        revision: this.revision,
      };
      const digest = createHash("sha256").update(canonicalTerminalInventory(entries), "utf8").digest("hex");
      const chunks: Array<{ entries: TerminalResourceEntry[]; proofs: TerminalReapProof[] }> = [];
      for (const entry of entries) {
        const proof = this.reapProof(entry.identity, evidence);
        const chunk = { entries: [entry], proofs: proof ? [proof] : [] };
        if (Buffer.byteLength(JSON.stringify(chunk)) > L.frameBytes - 2048) {
          this.error(f, "E_RESOURCE_QUARANTINED");
          return;
        }
        chunks.push(chunk);
      }
      if (Buffer.byteLength(JSON.stringify(chunks)) > L.inventoryBytes - 4096) {
        this.error(f, "E_RESOURCE_QUARANTINED");
        return;
      }
      const pages: TerminalInventoryPage[] = [
        {
          ...evidence,
          phase: "begin",
          sender: {
            agentSessionId: this.options.sessionId,
            epoch: this.options.epoch,
            ownerInstance: this.ownerInstance,
            processIdentity: this.processIdentity,
          },
          totalCount: entries.length,
          chunkCount: chunks.length,
          digest,
        },
        ...chunks.map((chunk, index) => ({ ...evidence, phase: "chunk" as const, chunkIndex: index, ...chunk })),
        { ...evidence, phase: "end", totalCount: entries.length, chunkCount: chunks.length, digest, complete: true },
      ];
      for (const page of pages) this.response(f, { ok: true, page });
    } finally {
      this.frozenInventory--;
    }
  }
  /** Live connection incarnation retired: immediate capabilities/input invalidation.
   * Never resurrect old channels on reconnect. Old shells get ≤30s to be reaped. */
  linkLost(): void {
    this.negotiator.invalidate();
    this.channels.clear();
    for (const r of this.rows.values()) {
      r.retired = true;
      this.detach(r);
    }
    if (!this.lostTimer && !this.disposed)
      this.lostTimer = this.clock.setTimer(clampSpanMs(L.linkLossMs)!, () => {
        this.lostTimer = undefined;
        for (const r of this.rows.values()) this.closeRow(r);
      });
  }
  /** Host privacy/secure/auth-domain transition: synchronous revocation, not a detach.
   * This is not a new pi hook; the existing wireWebHub owner must call it. */
  revoke(): void {
    this.negotiator.invalidate();
    this.channels.clear();
    for (const r of this.rows.values()) {
      this.closeRow(r);
      r.backend?.close();
    }
  }
  /** Host invokes synchronously BEFORE detach/shutdown; return promise is bounded by backend.
   * It may resolve with poison. It never promises that timeout means physical release. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.negotiator.dispose();
    this.channels.clear();
    if (this.tickTimer) this.clock.clearTimer(this.tickTimer);
    if (this.lostTimer) this.clock.clearTimer(this.lostTimer);
    this.tickTimer = this.lostTimer = undefined;
    for (const r of this.rows.values()) {
      this.closeRow(r);
      this.persistUnresolved(r);
    }
    this.disposal = Promise.all([...this.rows.values()].map((r) => r.backend?.done)).then(() => undefined);
    return this.disposal;
  }
  private armTick(): void {
    if (this.tickTimer || this.disposed) return;
    this.tickTimer = this.clock.setTimer(clampSpanMs(250)!, () => {
      this.tickTimer = undefined;
      const now = this.clock.now();
      if (!this.allowed()) {
        const c = this.current();
        if (!c) this.linkLost();
        else for (const r of this.rows.values()) this.closeRow(r);
      } else if (this.linkInstance && this.current()?.localConnectionInstance !== this.linkInstance) this.linkLost();
      for (const [id, r] of this.rows) {
        if (r.attachment && now >= r.attachment.until) this.detach(r);
        if (now >= Math.min(r.inputIdleAt, r.lifetimeAt, r.parentExpiresAt)) this.closeRow(r);
        if (r.physical?.outcome === "reaped" && now >= r.ticketExpiresAt + clampSpanMs(L.exitedMs)!)
          this.rows.delete(id);
      }
      if ([...this.rows.values()].some((r) => r.physical?.outcome !== "reaped")) this.armTick();
    });
  }
}
