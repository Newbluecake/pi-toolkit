/**
 * fabric-thread P1 (arch r3 §11.1): the agent-side PURE-LOGIC vocabulary shared by the thread
 * package — ids, Outcome (§6.4), subscription lifecycle (§5.2), EventRecord handback states,
 * host-supplied run facts and the engine settings slice.
 *
 * Boundary: pi-free, node-free. `RunStatus` is a type-only import from core (the single
 * vocabulary for run states, D-15). No module-scope mutable state (I4).
 */
import type { RunStatus } from "../../core/types.js";

/** §3.1 D2 Thread handle — hub-minted (`fs:` + b64url(HMAC)[0:12]); wire-validated by
 *  `THREAD_HANDLE_RE` (protocol/thread.ts). */
export type ThreadHandle = string;

/** §3.1 ThreadEvent id (review #2): the Feishu request id = cmdId = the cmd frame's `id`
 *  (`fs…`, `THREAD_EVENT_ID_RE`). The agent NEVER synthesizes one. */
export type ThreadEventId = string;

/** Direct-dispatch run id (`r_…`, `THREAD_RUN_ID_RE`). */
export type ThreadRunId = string;

/** §6.4 Outcome — one subscriber's delivery result for one event.
 *  `buffered → flushing → queued / unknown / none`; the three terminal values are absorbing
 *  (a late `queued` settle after `unknown` upgrades the DISPLAY state only, §6.5). */
export type Outcome = "buffered" | "flushing" | "queued" | "unknown" | "none";

/** §5.2 endReason vocabulary — ENDED is absorbing; a re-subscribe creates a new subId. */
export const SUBSCRIPTION_END_REASONS = [
  "run_terminal",
  "unsubscribed",
  "handback",
  "thread_closed",
  "start_timeout",
  "stack_disposed",
  "stale",
] as const;
export type SubscriptionEndReason = (typeof SUBSCRIPTION_END_REASONS)[number];

/** §5.2 states: ACTIVE → ENDED(endReason). */
export type SubscriptionState = "active" | "ended";

/** §3.1 EventRecord.handback — the agent-side view of ONE (explicit or system) handback attempt;
 *  whether the hub still retains the original is decided ONLY by the hub (r3-7). */
export type HandbackState = "pending" | "done" | "gone" | "unknown";

/**
 * §5.1/§6.4 host-supplied run facts. The engine is pure logic: it never touches the run
 * registry — the P3 wiring resolves these per call (admission + lazy validation + pre-steer
 * checks all go through this one shape).
 */
export interface ThreadRunFacts {
  /** Direct dispatch of THIS main session; workflow-internal / external-droid / caller-owned ⇒
   *  `false` (§5.1 rejects all three). */
  direct: boolean;
  status: RunStatus;
  /** §6.4 「没有 active handle」— status running but no steerable session handle ⇒ the steer is
   *  refused BEFORE calling pi ⇒ `none` (safe fallback). */
  steerable: boolean;
}

/** Run statuses that may hold an ACTIVE subscription (§5.1). */
export const SUBSCRIBABLE_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "starting", "running"]);

/** §5.1 statuses that make a run BUFFER events instead of steering (§6.5 缓冲). */
export const BUFFERING_STATUSES: ReadonlySet<RunStatus> = new Set(["queued", "starting"]);

/** The engine-relevant `fabric.threads.*` leaves (§11.1 P0 defaults). P0's parser
 *  (src/fabric/settings.ts) clamps every leaf before the stack is built; the engine trusts but
 *  re-floors defensively so a hostile construction cannot wedge the state machines. */
export interface ThreadEngineSettings {
  /** §5.1 per-run ceiling (default 4). */
  maxSubsPerRun: number;
  /** §5.1 per-thread ceiling (default 4). */
  maxSubsPerThread: number;
  /** §5.1 per-session ceiling (default 32). */
  maxSubs: number;
  /** §6.3 R4 per-thread direct-routing events per rolling hour (default 60; 0 ⇒ R4 always). */
  routedPerThreadPerHour: number;
  /** §6.5 per-thread lane wait-queue length (default 8; in-flight is always 1). */
  laneWait: number;
  /** §6.5 single-steer budget source (default 4000 ms). */
  steerTimeoutMs: number;
  /** §6.5 buffer TTL S (default 8 min) — from each buffered event's own deliveredAt. */
  startTimeoutMin: number;
  /** §5.5 handback window H (default 10 min) — from the event's deliveredAt (routed-reply time). */
  handbackWindowMin: number;
}

/** §11.1 P0 frozen defaults (mirror DEFAULT_FABRIC_SETTINGS.threads / THREAD_WINDOW_DEFAULTS). */
export const DEFAULT_THREAD_ENGINE_SETTINGS: ThreadEngineSettings = {
  maxSubsPerRun: 4,
  maxSubsPerThread: 4,
  maxSubs: 32,
  routedPerThreadPerHour: 60,
  laneWait: 8,
  steerTimeoutMs: 4_000,
  startTimeoutMin: 8,
  handbackWindowMin: 10,
};

/** Rolling-hour window for the R4 per-thread routed cap. */
export const THREAD_ROUTED_WINDOW_MS = 3_600_000;

/** Counters surfaced for `/agent status` (§6.7: `thread subs n · routed a · slow b · handback c ·
 *  unknown d`) plus the remaining decision/lane counters from §6.3/§6.5. */
export interface ThreadStats {
  /** live (ACTIVE) subscriptions. */
  activeSubs: number;
  /** routed first replies (§6.7 首次回复 routed 分支). */
  routed: number;
  /** R2 counter. */
  slow: number;
  /** R5 counter (lane wait full OR records table full, §6.7). */
  laneFull: number;
  /** R6 counter. */
  budget: number;
  /** §6.5 lane-wait deadline removals. */
  laneTimeout: number;
  /** handback attempts (explicit Worker handbacks + system auto-returns). */
  handback: number;
  /** `unknown` outcomes recorded (post-call, never safe-fallback, §6.4). */
  unknown: number;
  /** duplicate eventIds answered from the existing record (§6.5 dedup). */
  deduped: number;
  /** system auto-returns actually requested (≤1 per event — property-pinned). */
  autoReturned: number;
  /** after dispose() — absorbing; every later entry-point is a no-op. */
  disposed: boolean;
}
