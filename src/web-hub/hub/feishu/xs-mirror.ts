/**
 * Feishu mirror of cross-session messages that did NOT wake the receiving session
 * (`docs/dev/feishu-xs-mirror/plan.md` §4.3). pi-free, closure state, no timers.
 *
 * One bounded FIFO + ONE serial worker: capacity/byte checks and `enqueueNotice`'s synchronous
 * `store.add` share a single synchronous section, so no other producer can interleave between
 * "check" and "insert". Best-effort by design (§0.3): never retries/resends the original message.
 */
import { FEISHU_CAPS } from "../../protocol/feishu.js";
import { renderXsMirror, XS_MIRROR_CARD_MAX_BYTES } from "./render.js";
import type { EnqueueNoticeInput, EnqueueResult, OutboxTarget } from "./outbox.js";
import { feishuKey } from "./runtime.js";
import { FEISHU_OUTBOX_FINAL_RESERVE } from "./state.js";
import type { FeishuBinding, StateUsage } from "./state.js";

/** Same shape as P2's `XsQuietDelivered` (plan §2.2, frozen). */
export interface FeishuXsMirrorEvent {
  sessionId: string;
  agentKey: string;
  xid: string;
  kind: "message" | "broadcast" | "reply";
  from: { ref: string; name?: string; alias?: string };
  channel?: string;
  late?: true;
  queued?: true;
  wakeDowngraded?: string;
  text: string;
}

export const XSM_PER_BINDING_PER_MIN = 6;
export const XSM_PER_BINDING_PER_HOUR = 60;
export const XSM_GLOBAL_CARDS_PER_MIN = 30;
export const XSM_QUEUE_MAX = 16;
export const XSM_MAX_QUEUED = 16;
export const XSM_OUTBOX_HEADROOM = 128;
export const XSM_MAX_CARD_BYTES = XS_MIRROR_CARD_MAX_BYTES;
export const XSM_RECORD_OVERHEAD = 512;
export const XSM_BYTE_HEADROOM = 262_144;
export const XSM_WORK_HEADROOM = 64;
export const XSM_WORK_CAP = 256;
export const XSM_MAX_AGE_MS = 600_000;
export const XSM_TAG_PREFIX = "xsm:";
const SEEN_MAX = 512;
const SEEN_TTL_MS = 30 * 60_000;
const AUDIT_GAP_MS = 10 * 60_000;
const MIN = 60_000;
const HOUR = 3_600_000;

export interface FeishuXsMirrorDeps {
  state: {
    bindings: { list(): FeishuBinding[]; get(key: string): FeishuBinding | undefined };
    outbox: {
      list(filter?: { state?: "queued" | "sent" | "failed" }): { kind: string; requestId?: string }[];
      readonly size: number;
    };
    usage(): Pick<StateUsage, "bytes" | "budget" | "reserve">;
  };
  now(): number;
  label(sid: string): string;
  link(agentKey: string): string;
  target(b: FeishuBinding): OutboxTarget | undefined;
  enqueue(input: EnqueueNoticeInput): Promise<EnqueueResult>;
  /** runtime `work.run`: `false` = the task was NOT executed */
  run(task: () => Promise<unknown>): boolean;
  workSize(): number;
  log(e: { event: "xs-mirror"; reason: string; code?: string }): void;
  count(reason: string): void;
}

interface Card {
  binding: string;
  chatId: string;
  event: FeishuXsMirrorEvent;
  queuedAt: number;
}

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

export function createFeishuXsMirror(deps: FeishuXsMirrorDeps) {
  let disposed = false;
  let pumping = false;
  const queue: Card[] = [];
  const seen = new Map<string, number>();
  const lastServed = new Map<string, number>();
  const dropped = new Map<string, number>();
  const reported = new Map<string, number>();
  const bindMin = new Map<string, number[]>();
  const bindHour = new Map<string, number[]>();
  let globalMin: number[] = [];
  const auditAt = new Map<string, number>();

  const safeLog = (reason: string, code?: string): void => {
    try {
      deps.log({ event: "xs-mirror", reason, ...(code !== undefined ? { code } : {}) });
    } catch {
      /* diagnostic only */
    }
  };
  const safeCount = (reason: string): void => {
    try {
      deps.count(`xs-mirror-${reason}`);
    } catch {
      /* diagnostic only */
    }
  };
  const unreported = (b: string): number => Math.max(0, (dropped.get(b) ?? 0) - (reported.get(b) ?? 0));

  function omit(c: Card, reason: string, code?: string): void {
    dropped.set(c.binding, (dropped.get(c.binding) ?? 0) + 1);
    safeCount(reason);
    const now = deps.now();
    if (now - (auditAt.get(c.binding) ?? -Infinity) >= AUDIT_GAP_MS) {
      auditAt.set(c.binding, now);
      safeLog(reason, code);
    }
  }
  function markReported(b: string, base: number, shown: number): void {
    const d = dropped.get(b) ?? 0;
    reported.set(b, Math.min(d, Math.max(reported.get(b) ?? 0, base + shown)));
  }
  function fresh(win: number[], span: number, now: number): number[] {
    let i = 0;
    while (i < win.length && now - win[i]! >= span) i++;
    return i === 0 ? win : win.slice(i);
  }
  function pruneBindings(live: ReadonlySet<string>): void {
    for (const m of [lastServed, dropped, reported, bindMin, bindHour, auditAt])
      for (const k of m.keys()) if (!live.has(k)) m.delete(k);
  }

  function deliver(e: FeishuXsMirrorEvent): void {
    if (disposed) return;
    try {
      if (
        typeof e?.xid !== "string" ||
        e.xid === "" ||
        typeof e.sessionId !== "string" ||
        e.sessionId === "" ||
        typeof e.agentKey !== "string" ||
        e.agentKey === "" ||
        typeof e.text !== "string" ||
        typeof e.from?.ref !== "string"
      ) {
        safeCount("invalid");
        return;
      }
      const now = deps.now();
      for (const [k, t] of seen) {
        if (now - t > SEEN_TTL_MS || seen.size > SEEN_MAX) seen.delete(k);
        else break;
      }
      const sk = `${e.sessionId}\n${e.xid}`;
      if (seen.has(sk)) {
        safeCount("dup");
        return;
      }
      seen.set(sk, now);
      const all = deps.state.bindings.list();
      const targets = all.filter(
        (b) =>
          b.sessionId === e.sessionId && b.chatType === "p2p" && b.key.startsWith("p2p:") && b.offline === undefined,
      );
      if (targets.length === 0) return;
      pruneBindings(new Set(all.map((b) => b.key)));
      targets.sort((a, b) => {
        const d = (lastServed.get(a.key) ?? 0) - (lastServed.get(b.key) ?? 0);
        return d !== 0 ? d : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      });
      globalMin = fresh(globalMin, MIN, now);
      for (const b of targets) {
        const wm = fresh(bindMin.get(b.key) ?? [], MIN, now);
        const wh = fresh(bindHour.get(b.key) ?? [], HOUR, now);
        bindMin.set(b.key, wm);
        bindHour.set(b.key, wh);
        const card: Card = { binding: b.key, chatId: b.chatId, event: e, queuedAt: now };
        if (wm.length >= XSM_PER_BINDING_PER_MIN || wh.length >= XSM_PER_BINDING_PER_HOUR) {
          omit(card, "rate");
          continue;
        }
        if (globalMin.length >= XSM_GLOBAL_CARDS_PER_MIN) {
          omit(card, "rate");
          continue;
        }
        if (queue.length >= XSM_QUEUE_MAX) {
          omit(card, "cap");
          continue;
        }
        wm.push(now);
        wh.push(now);
        globalMin.push(now);
        lastServed.set(b.key, now);
        queue.push(card);
      }
      pump();
    } catch {
      safeCount("invalid");
    }
  }

  function pump(): void {
    if (pumping || disposed || queue.length === 0) return;
    if (deps.workSize() >= XSM_WORK_CAP - XSM_WORK_HEADROOM) return;
    pumping = true;
    let started = false;
    try {
      started = deps.run(drain);
    } catch {
      started = false;
    }
    if (!started) {
      pumping = false;
      for (const c of queue.splice(0)) omit(c, "work");
    }
  }

  async function drain(): Promise<void> {
    try {
      while (!disposed && queue.length > 0) {
        const c = queue.shift()!;
        await sendOne(c);
      }
    } finally {
      pumping = false;
      if (!disposed && queue.length > 0) pump();
    }
  }

  function queuedMirror(): number {
    let n = 0;
    for (const p of deps.state.outbox.list({ state: "queued" }))
      if (p.kind === "notice" && p.requestId?.startsWith(XSM_TAG_PREFIX)) n++;
    return n;
  }

  async function sendOne(c: Card): Promise<void> {
    // ---- synchronous critical section (no await until `deps.enqueue(...)` has been CALLED) ----
    const now = deps.now();
    if (now - c.queuedAt > XSM_MAX_AGE_MS) return omit(c, "stale");
    const b = deps.state.bindings.get(c.binding);
    if (b === undefined || b.sessionId !== c.event.sessionId || b.offline !== undefined || b.chatType !== "p2p") {
      safeCount("unbound");
      return;
    }
    const target = deps.target(b);
    if (target === undefined) return omit(c, "refused", "target");
    const base = reported.get(c.binding) ?? 0;
    const shown = unreported(c.binding);
    const e = c.event;
    const message = renderXsMirror({
      label: deps.label(e.sessionId),
      kind: e.kind,
      from: e.from,
      ...(e.channel !== undefined ? { channel: e.channel } : {}),
      ...(e.late === true ? { late: true } : {}),
      ...(e.queued === true ? { queued: true } : {}),
      ...(e.wakeDowngraded !== undefined ? { wakeDowngraded: e.wakeDowngraded } : {}),
      text: e.text,
      link: deps.link(e.agentKey),
      omitted: shown,
      maxBytes: XSM_MAX_CARD_BYTES,
    });
    const limit = FEISHU_CAPS.outboxParts - FEISHU_OUTBOX_FINAL_RESERVE - XSM_OUTBOX_HEADROOM;
    if (queuedMirror() >= XSM_MAX_QUEUED || deps.state.outbox.size >= limit) return omit(c, "cap");
    const u = deps.state.usage();
    const cost = utf8(JSON.stringify(message.content)) + XSM_RECORD_OVERHEAD;
    if (u.bytes + u.reserve + cost + XSM_BYTE_HEADROOM > u.budget) return omit(c, "bytes");
    const tag = `${XSM_TAG_PREFIX}${feishuKey(`${c.binding}\n${e.xid}`)}`;
    let p: Promise<EnqueueResult>;
    try {
      p = deps.enqueue({ target, message, key: tag, tag, laneKey: c.chatId });
    } catch {
      return omit(c, "refused", "throw");
    }
    // ---- end of critical section ----
    try {
      const r = await p;
      if (disposed) return;
      if (r.ok) {
        markReported(c.binding, base, shown);
        safeLog(r.durable ? "accepted" : "accepted-nondurable");
      } else omit(c, "refused", r.refused);
    } catch {
      if (disposed) return;
      omit(c, "refused", "throw");
    }
  }

  return {
    deliver,
    pump,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (let i = queue.length; i > 0; i--) safeCount("stopped");
      queue.length = 0;
      seen.clear();
      lastServed.clear();
      dropped.clear();
      reported.clear();
      bindMin.clear();
      bindHour.clear();
      auditAt.clear();
      globalMin = [];
    },
    /** test/diagnostic view (no content) */
    stats: () => ({ queued: queue.length, pumping }),
  };
}
export type FeishuXsMirror = ReturnType<typeof createFeishuXsMirror>;
