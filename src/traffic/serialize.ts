import { broadcast } from "./sse.js";
import { state, type PendingRequest } from "./state.js";
import type { RewriteRule } from "./rewrite.js";

export type ReleaseReason =
  "settled" | "blocked" | "aborted" | "failed" | "no-fetch" | "retry-grace" | "max-hold" | "drain";

export interface GateSettings {
  jqPath?: string;
  timeoutMs?: number;
  handoffMs?: number;
  retryGraceMs?: number;
  maxHoldMs?: number;
  queueWaitMs?: number;
}

export interface SlotMeta {
  sessionId?: string;
  baseUrl?: string | null;
  model?: string | null;
  modelApi?: string | null;
  rules?: RewriteRule[];
  settings?: Partial<GateSettings>;
  pending?: PendingRequest | null;
  /** Direct timing fields are accepted for small callers and tests. */
  handoffMs?: number;
  retryGraceMs?: number;
  maxHoldMs?: number;
  queueWaitMs?: number;
}

export interface BlockedInfo {
  error: Error;
}

export interface GateSlot {
  readonly id: number;
  readonly sessionId: string;
  readonly baseUrl: string | null;
  readonly model: string | null;
  readonly modelApi: string | null;
  rules: RewriteRule[];
  settings: GateSettings;
  pending: PendingRequest | null;
  attempts: number;
  blocked: BlockedInfo | null;
  state: "queued" | "held" | "attached" | "released";
  acquiredAt: number;
  degraded: boolean;
  /** Exposed for the capture layer's finally guard. */
  retryGraceArmed?: boolean;
  /** 闸门最后一次释放原因，供 V12 运行时诊断。T1 严格化：显式 undefined 可赋（exactOptionalPropertyTypes）。 */
  releaseReason?: ReleaseReason | undefined;
}

export interface GateStats {
  active: boolean;
  queueDepth: number;
  holderId: number | null;
  holderAgeMs: number | null;
  gateAcquired: number;
  gateTimeouts: number;
  gateNoFetch: number;
  gateBypassed: number;
  gateMaxQueueDepth: number;
}

interface SlotTimers {
  handoff: ReturnType<typeof setTimeout> | null;
  maxHold: ReturnType<typeof setTimeout> | null;
  retryGrace: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  slot: GateSlot;
  resolve: (slot: GateSlot) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULTS = {
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
} as const;

let nextSlotId = 0;
let holder: GateSlot | null = null;
let waiters: Waiter[] = [];
let warnedAt = -Infinity;
let warningHandler: (event: Record<string, unknown>) => void = broadcast;
const timers = new WeakMap<GateSlot, SlotTimers>();
const kinds = new WeakMap<GateSlot, "hook" | "orphan">();

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function slotTimings(
  meta: SlotMeta,
): Required<Pick<GateSettings, "handoffMs" | "retryGraceMs" | "maxHoldMs" | "queueWaitMs">> {
  const settings = meta.settings ?? {};
  return {
    handoffMs: positive(meta.handoffMs ?? settings.handoffMs, DEFAULTS.handoffMs),
    retryGraceMs: positive(meta.retryGraceMs ?? settings.retryGraceMs, DEFAULTS.retryGraceMs),
    maxHoldMs: positive(meta.maxHoldMs ?? settings.maxHoldMs, DEFAULTS.maxHoldMs),
    queueWaitMs: positive(meta.queueWaitMs ?? settings.queueWaitMs, DEFAULTS.queueWaitMs),
  };
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

let releaseHandler: ((slot: GateSlot, reason: ReleaseReason) => void) | null = null;

export function setGateReleaseHandler(handler: ((slot: GateSlot, reason: ReleaseReason) => void) | null): void {
  releaseHandler = handler;
}

function clearSlotTimers(slot: GateSlot): void {
  const slotTimers = timers.get(slot);
  if (!slotTimers) return;
  clearTimer(slotTimers.handoff);
  clearTimer(slotTimers.maxHold);
  clearTimer(slotTimers.retryGrace);
  slotTimers.handoff = null;
  slotTimers.maxHold = null;
  slotTimers.retryGrace = null;
  slot.retryGraceArmed = false;
}

function emitWarning(reason: string, slot: GateSlot, message: string): void {
  const now = Date.now();
  if (now - warnedAt < 10_000) return;
  warnedAt = now;
  try {
    warningHandler({ type: "gate_warn", reason, slot_id: slot.id, message });
  } catch {
    // Warning delivery must never affect the provider request.
  }
}

function removeWaiter(slot: GateSlot): Waiter | null {
  const index = waiters.findIndex((waiter) => waiter.slot === slot);
  if (index < 0) return null;
  const [waiter] = waiters.splice(index, 1);
  if (!waiter) return null;
  clearTimer(waiter.timer);
  waiter.timer = null;
  return waiter;
}

function startMaxHold(slot: GateSlot, maxHoldMs: number): void {
  const slotTimers = timers.get(slot);
  if (!slotTimers || slotTimers.maxHold !== null) return;
  slotTimers.maxHold = setTimeout(() => {
    if (slot.state === "released") return;
    state.gateTimeouts++;
    emitWarning("max-hold", slot, `串行化闸门持有超过 ${maxHoldMs}ms，已释放`);
    releaseSlot(slot, "max-hold");
  }, maxHoldMs);
  unref(slotTimers.maxHold);
}

function startHandoff(slot: GateSlot, handoffMs: number): void {
  const slotTimers = timers.get(slot);
  if (!slotTimers || slotTimers.handoff !== null) return;
  slotTimers.handoff = setTimeout(() => {
    if (slot.state === "released" || slot.state === "attached") return;
    state.gateNoFetch++;
    emitWarning("no-fetch", slot, `串行化闸门 ${handoffMs}ms 内未观察到 fetch，已释放`);
    releaseSlot(slot, "no-fetch");
  }, handoffMs);
  unref(slotTimers.handoff);
}

function promoteNext(): void {
  const next = waiters.shift();
  if (!next) return;
  clearTimer(next.timer);
  next.timer = null;
  holder = next.slot;
  next.slot.state = "held";
  const timing = slotTimings({ settings: next.slot.settings });
  if (kinds.get(next.slot) === "hook") startHandoff(next.slot, timing.handoffMs);
  next.resolve(next.slot);
}

function bypassWaiter(waiter: Waiter, countAsBypass: boolean): void {
  clearTimer(waiter.timer);
  waiter.timer = null;
  if (waiter.slot.state === "released") return;
  waiter.slot.degraded = true;
  waiter.slot.state = "attached";
  clearSlotTimers(waiter.slot);
  if (countAsBypass) state.gateBypassed++;
  waiter.resolve(waiter.slot);
}

export function setGateWarningHandler(handler: ((event: Record<string, unknown>) => void) | null): void {
  warningHandler = handler ?? broadcast;
}

export function acquireSlot(meta: SlotMeta, kind: "hook" | "orphan"): Promise<GateSlot> {
  const settings = { ...(meta.settings ?? {}) };
  const timing = slotTimings({ ...meta, settings });
  const slot: GateSlot = {
    id: ++nextSlotId,
    sessionId: meta.sessionId ?? "",
    baseUrl: meta.baseUrl ?? null,
    model: meta.model ?? null,
    modelApi: meta.modelApi ?? null,
    rules: meta.rules ?? [],
    settings: { ...settings, ...timing },
    pending: meta.pending ?? null,
    attempts: 0,
    blocked: null,
    state: "queued",
    acquiredAt: Date.now(),
    degraded: false,
    retryGraceArmed: false,
    releaseReason: undefined,
  };
  timers.set(slot, { handoff: null, maxHold: null, retryGrace: null });
  kinds.set(slot, kind);
  state.gateAcquired++;
  startMaxHold(slot, timing.maxHoldMs);

  if (holder === null) {
    holder = slot;
    slot.state = "held";
    if (kind === "hook") startHandoff(slot, timing.handoffMs);
    return Promise.resolve(slot);
  }

  return new Promise<GateSlot>((resolve) => {
    const waiter: Waiter = { slot, resolve, timer: null };
    waiters.push(waiter);
    state.gateMaxQueueDepth = Math.max(state.gateMaxQueueDepth, waiters.length);
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index < 0 || slot.state === "released") return;
      waiters.splice(index, 1);
      emitWarning("queue-wait", slot, `串行化闸门等待超过 ${timing.queueWaitMs}ms，已旁路放行`);
      bypassWaiter(waiter, true);
    }, timing.queueWaitMs);
    unref(waiter.timer);
  });
}

export function currentSlot(): GateSlot | null {
  return holder;
}

export function attachAttempt(slot: GateSlot): void {
  if (slot.blocked !== null) throw slot.blocked.error;
  if (slot.state === "released") return;
  if (slot.degraded) {
    slot.state = "attached";
    slot.attempts++;
    return;
  }
  if (holder !== slot) return;
  const slotTimers = timers.get(slot);
  if (slotTimers) {
    clearTimer(slotTimers.handoff);
    slotTimers.handoff = null;
  }
  slot.state = "attached";
  slot.attempts++;
}

export function armRetryGrace(slot: GateSlot): void {
  if (slot.state === "released") return;
  const slotTimers = timers.get(slot);
  if (!slotTimers) return;
  clearTimer(slotTimers.handoff);
  slotTimers.handoff = null;
  clearTimer(slotTimers.retryGrace);
  slot.retryGraceArmed = true;
  const timing = slotTimings(slot.settings as SlotMeta);
  slotTimers.retryGrace = setTimeout(() => {
    slot.retryGraceArmed = false;
    releaseSlot(slot, "retry-grace");
  }, timing.retryGraceMs);
  unref(slotTimers.retryGrace);
}

export function armPoison(slot: GateSlot, error: Error): void {
  if (slot.state === "released") return;
  slot.blocked = { error };
  armRetryGrace(slot);
}

export function releaseSlot(slot: GateSlot, _reason: ReleaseReason): void {
  if (slot.state === "released") return;

  const queued = removeWaiter(slot);
  if (queued && holder !== slot) {
    slot.releaseReason = _reason;
    slot.state = "released";
    clearSlotTimers(slot);
    queued.resolve(slot);
    try {
      releaseHandler?.(slot, _reason);
    } catch {}
    return;
  }

  clearSlotTimers(slot);
  if (holder !== slot) {
    slot.releaseReason = _reason;
    slot.state = "released";
    try {
      releaseHandler?.(slot, _reason);
    } catch {}
    return;
  }
  slot.releaseReason = _reason;
  slot.state = "released";
  holder = null;
  try {
    releaseHandler?.(slot, _reason);
  } catch {}
  promoteNext();
}

export function drainGate(_reason: ReleaseReason): void {
  if (holder !== null) {
    const oldHolder = holder;
    holder = null;
    clearSlotTimers(oldHolder);
    oldHolder.releaseReason = _reason;
    oldHolder.state = "released";
    try {
      releaseHandler?.(oldHolder, _reason);
    } catch {}
  }
  const pending = waiters;
  waiters = [];
  for (const waiter of pending) bypassWaiter(waiter, false);
}

export function gateStats(): GateStats {
  return {
    active: holder !== null || waiters.length > 0,
    queueDepth: waiters.length,
    holderId: holder?.id ?? null,
    holderAgeMs: holder === null ? null : Math.max(0, Date.now() - holder.acquiredAt),
    gateAcquired: state.gateAcquired,
    gateTimeouts: state.gateTimeouts,
    gateNoFetch: state.gateNoFetch,
    gateBypassed: state.gateBypassed,
    gateMaxQueueDepth: state.gateMaxQueueDepth,
  };
}

export function resetGate(): void {
  drainGate("drain");
  waiters = [];
  holder = null;
  nextSlotId = 0;
  warnedAt = -Infinity;
  state.gateAcquired = 0;
  state.gateTimeouts = 0;
  state.gateNoFetch = 0;
  state.gateBypassed = 0;
  state.gateMaxQueueDepth = 0;
  setGateWarningHandler(null);
}
