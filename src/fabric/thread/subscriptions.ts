/**
 * fabric-thread P1 (arch r3 §5): the subscription state machine + registry — admission (§5.1),
 * ACTIVE → ENDED transitions (§5.2, ENDED absorbing), the three ceilings, idempotent
 * (run, thread) re-subscribe, and the per-subscription counters that feed the frozen terminal
 * summary (§5.3 ①). Pure bookkeeping: buffers live on the subscription but the ENGINE owns the
 * drains (ending a subscription hands its buffer back to the caller for the §6.7 none-sweep).
 *
 * Who may create: main-session model (root) or local human — `createdBy` records which; child
 * agents can never call this (§5.1 table, enforced by the tool surface in P3).
 */
import { ThreadBuffer } from "./buffer.js";
import type {
  SubscriptionEndReason,
  SubscriptionState,
  ThreadEngineSettings,
  ThreadHandle,
  ThreadRunFacts,
  ThreadRunId,
} from "./types.js";
import { BUFFERING_STATUSES, SUBSCRIBABLE_STATUSES } from "./types.js";

/** §3.1 Subscription.scope cap (≤200 字), clamped defensively at admission. */
export const THREAD_SCOPE_MAX_CP = 200;

/** Surrogate-pair-aware code-point truncation (same counting rule as THREAD_LABEL_CP_RE). */
export function truncateCodePoints(s: string, maxCp: number): string {
  let cp = 0;
  let cut = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isPair =
      c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff;
    if (cp >= maxCp) {
      cut = i;
      break;
    }
    cp++;
    if (isPair) i++;
    cut = i + 1;
  }
  return s.slice(0, cut);
}

export interface ThreadSubscription {
  readonly subId: string;
  readonly h: ThreadHandle;
  readonly runId: ThreadRunId;
  /** the RUN's display label (@label, ≤32 cp — the wire RunRef cap). */
  label: string;
  /** §3.1 scope (≤200 cp) — the responsibility statement shown in the §9.1 wrapper. */
  scope: string;
  readonly createdBy: "root" | "human";
  readonly createdAt: number;
  /** creation serial — §6.6 fan-out order (订阅创建顺序). */
  readonly serial: number;
  state: SubscriptionState;
  endReason: SubscriptionEndReason | undefined;
  endedAt: number | undefined;
  /** §5.3 ① frozen-summary counters. */
  routed: number;
  replies: number;
  handbacks: number;
  /** §6.5 buffer (only fills while the run is queued/starting). */
  readonly buffer: ThreadBuffer;
}

export type SubscribeDenyReason =
  /** runFacts(runId) === undefined. */
  | "run_not_found"
  /** workflow-internal / external-droid / caller-owned (§5.1). */
  | "run_not_direct"
  /** status ∉ {queued, starting, running} (stopping or terminal). */
  | "run_status"
  /** handle not in the ThreadDirectory. */
  | "thread_unknown"
  /** §5.4 thr_closed. */
  | "thread_closed"
  /** hub offline / no `thr.v1` (§7.1 vocabulary). */
  | "hub_unsupported"
  | "run_limit"
  | "thread_limit"
  | "session_limit";

export type SubscribeResult =
  { ok: true; subId: string; created: boolean } | { ok: false; reason: SubscribeDenyReason };

export interface SubscribeInput {
  runId: ThreadRunId;
  h: ThreadHandle;
  /** run display label; defensively truncated to the 32-cp wire cap. */
  label: string;
  scope: string;
  createdBy: "root" | "human";
}

export interface SubscribeContext {
  now: number;
  settings: ThreadEngineSettings;
  /** directory view: "unknown" (not tracked) / "open" / "closed" (§5.4). */
  directory: { state(h: ThreadHandle): "unknown" | "open" | "closed" };
  runFacts(runId: ThreadRunId): ThreadRunFacts | undefined;
  hubCapable(): boolean;
  newSubId(): string;
}

export class SubscriptionRegistry {
  private readonly byId = new Map<string, ThreadSubscription>();
  private serialNext = 0;

  get size(): number {
    return this.byId.size;
  }

  get(subId: string): ThreadSubscription | undefined {
    return this.byId.get(subId);
  }

  /** §5.1 admission — ordered: run facts → directory → hub cap → idempotent (limits skipped on
   *  the idempotent hit) → the three ceilings. Scope/label clamped defensively. */
  subscribe(input: SubscribeInput, ctx: SubscribeContext): SubscribeResult {
    const facts = ctx.runFacts(input.runId);
    if (!facts) return { ok: false, reason: "run_not_found" };
    if (!facts.direct) return { ok: false, reason: "run_not_direct" };
    if (!SUBSCRIBABLE_STATUSES.has(facts.status)) return { ok: false, reason: "run_status" };
    const dirState = ctx.directory.state(input.h);
    if (dirState !== "open") {
      return { ok: false, reason: dirState === "closed" ? "thread_closed" : "thread_unknown" };
    }
    if (!ctx.hubCapable()) return { ok: false, reason: "hub_unsupported" };
    const existing = this.activeByRunAndThread(input.runId, input.h);
    if (existing) {
      existing.scope = truncateCodePoints(input.scope, THREAD_SCOPE_MAX_CP);
      existing.label = truncateCodePoints(input.label, 32);
      return { ok: true, subId: existing.subId, created: false };
    }
    if (this.activeSubsOfRun(input.runId).length >= ctx.settings.maxSubsPerRun) {
      return { ok: false, reason: "run_limit" };
    }
    if (this.activeSubsOfThread(input.h).length >= ctx.settings.maxSubsPerThread) {
      return { ok: false, reason: "thread_limit" };
    }
    if (this.activeCount() >= ctx.settings.maxSubs) {
      return { ok: false, reason: "session_limit" };
    }
    const sub: ThreadSubscription = {
      subId: ctx.newSubId(),
      h: input.h,
      runId: input.runId,
      label: truncateCodePoints(input.label, 32),
      scope: truncateCodePoints(input.scope, THREAD_SCOPE_MAX_CP),
      createdBy: input.createdBy,
      createdAt: ctx.now,
      serial: this.serialNext++,
      state: "active",
      endReason: undefined,
      endedAt: undefined,
      routed: 0,
      replies: 0,
      handbacks: 0,
      buffer: new ThreadBuffer(),
    };
    this.byId.set(sub.subId, sub);
    return { ok: true, subId: sub.subId, created: true };
  }

  /** §5.2: ACTIVE → ENDED is one-way (ENDED absorbing — a no-op on an ended sub returns
   *  `undefined` so the caller cannot double-drain). The buffer is left INTACT for the caller's
   *  §6.7 none-sweep; per-sub record release happens after judgment (§5.3 ④, engine-side). */
  end(subId: string, reason: SubscriptionEndReason, now: number): ThreadSubscription | undefined {
    const sub = this.byId.get(subId);
    if (!sub || sub.state === "ended") return undefined;
    sub.state = "ended";
    sub.endReason = reason;
    sub.endedAt = now;
    return sub;
  }

  activeByRunAndThread(runId: ThreadRunId, h: ThreadHandle): ThreadSubscription | undefined {
    for (const sub of this.byId.values()) {
      if (sub.state === "active" && sub.runId === runId && sub.h === h) return sub;
    }
    return undefined;
  }

  /** §6.6 fan-out order: creation order (serial). */
  activeSubsOfThread(h: ThreadHandle): ThreadSubscription[] {
    return this.all()
      .filter((s) => s.state === "active" && s.h === h)
      .sort((a, b) => a.serial - b.serial);
  }

  activeSubsOfRun(runId: ThreadRunId): ThreadSubscription[] {
    return this.all()
      .filter((s) => s.state === "active" && s.runId === runId)
      .sort((a, b) => a.serial - b.serial);
  }

  activeCount(): number {
    let n = 0;
    for (const s of this.byId.values()) if (s.state === "active") n++;
    return n;
  }

  /** Insertion order (all states) — teardown/inspection. */
  all(): ThreadSubscription[] {
    return [...this.byId.values()];
  }
}

/** §5.1/§6.4: a live run may hold a subscription, but only a RUNNING, steerable run may take a
 *  steer right now; queued/starting runs buffer instead. */
export function deliveryModeForFacts(facts: ThreadRunFacts): "steer" | "buffer" | "none" {
  if (BUFFERING_STATUSES.has(facts.status)) return "buffer";
  if (facts.status === "running" && facts.steerable) return "steer";
  return "none"; // stopping / terminal / no active handle — §6.4 pre-call, safe fallback
}
