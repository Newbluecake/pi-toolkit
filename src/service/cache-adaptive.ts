/**
 * Adaptive 1h predictor — stack service (adaptive plan.md §9).
 *
 * Owns everything pi-facing about the adaptive cache-TTL mode: the four-way
 * identity guard (I-A7, mirrored from cache-keepalive.ts — see R6: extract a
 * shared accept() factory only if a third copy ever appears), the signal
 * collectors (subagent runs / background bash via an injected closure, UI gates
 * and tool activity via its own counters), ledger reconcile on turn events,
 * audit entries, and the status snapshot. Constructed once per
 * `buildSessionStack` and disposed at the top of the next build /
 * `session_shutdown` (same lifecycle as the keepalive service).
 *
 * I-A8: this service holds ZERO timers and zero in-flight work — it is purely
 * event-driven, so there is nothing to wedge `pi -p` and no window-epoch
 * guard is needed (the only cross-moment correlation is the pending probe,
 * bounded by requestSeq + ADAPTIVE_PENDING_TTL_MS, plan.md §6.1a).
 *
 * All decision logic lives in ../cache-ttl/adaptive.ts (pure) — this file only
 * wires it to `ExtensionContext`, the clock, and the audit sink.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock, type Clock } from "../core/clock.js";
import {
  ADAPTIVE_PROBE_WRITE_FACTOR,
  ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS,
  buildAdaptiveSnapshot,
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  endArmedEpisode,
  invalidateAdaptive as invalidateReducer,
  noteDecision,
  onLedgerObserved,
  type AdaptiveConfig,
  type AdaptiveDecision,
  type AdaptiveSignals,
  type AdaptiveSnapshot,
  type AdaptiveState,
} from "../cache-ttl/adaptive.js";
import type { InvalidateReason, PayloadShape } from "../cache-ttl/keepalive-state.js";
import { readLatestAssistantUsage, type LedgerUsage } from "../cache-ttl/usage-ledger.js";
import type { CacheTtlSettings } from "../config/settings.js";
import { isTerminalStatus } from "../core/status.js";
import type { Millis, RunStatus } from "../core/types.js";

/** pi-free-ish subset of what this module needs from `ctx.model` (same structural echo as cache-keepalive.ts). */
interface AdaptiveModelInfo {
  provider: string;
  api: string;
  id: string;
  /** Anthropic-messages compat flag (pi's own default is `true` when unset). */
  compat?: { supportsLongCacheRetention?: boolean } | undefined;
}

/** External signals the stack injects as a closure (same pattern as keepalive's `backgroundBusy`, plan.md §3.2). */
export interface AdaptiveExternalSignals {
  subagentRuns: number;
  maxSubagentHorizonMs: number | undefined;
  backgroundBashJobs: number;
}

/**
 * The two long-horizon signals, derived from live run snapshots. Extracted out
 * of `buildSessionStack` so the only real computation in the assembly is
 * unit-testable without an `ExtensionContext` (AGENTS.md: the stack builder is
 * assembly, logic lives in modules).
 *
 * Terminal runs are filtered with `isTerminalStatus` rather than a hardcoded
 * status list, so a future `RunStatus` member cannot silently be counted as
 * live. A run with no deadline at all contributes to the count but not to the
 * horizon — it is busy, but tells us nothing about *how long*.
 */
export function computeAdaptiveSignals(
  runs: readonly {
    status: RunStatus;
    deadlines: { readonly deadlineAt: Millis | undefined; readonly hardDeadlineAt?: Millis };
  }[],
  backgroundBashJobs: number,
  now: Millis,
): AdaptiveExternalSignals {
  let subagentRuns = 0;
  let maxSubagentHorizonMs: number | undefined;
  for (const run of runs) {
    if (isTerminalStatus(run.status)) continue;
    subagentRuns += 1;
    // The hard deadline is the one the reaper actually enforces, so it bounds
    // the run's real horizon; fall back to the soft deadline when unset.
    const at = run.deadlines.hardDeadlineAt ?? run.deadlines.deadlineAt;
    if (at === undefined) continue;
    const remaining = at - now;
    if (maxSubagentHorizonMs === undefined || remaining > maxSubagentHorizonMs) maxSubagentHorizonMs = remaining;
  }
  return { subagentRuns, maxSubagentHorizonMs, backgroundBashJobs };
}

/** What `cache-ttl.ts` hands to `decide()` per `before_provider_request` (plan.md §3.1 step 6). */
export interface AdaptiveDecideRequest {
  /** Read-only inspection of the OUTGOING (pre-rewrite) payload. */
  shape: PayloadShape;
  /** The one ledger read of this request (also reused for the keepalive capture prefix). */
  ledger: LedgerUsage;
}

/** plan.md §9.2: the surface `src/cache-ttl/cache-ttl.ts` talks to. */
export interface AdaptivePort {
  /** I-A7: this instance's unique, non-reusable id. */
  readonly instanceId: string;
  decide(sessionId: string, instance: string, request: AdaptiveDecideRequest): AdaptiveDecision;
  /** Ledger reconcile (message_end / turn_end / agent_end — idempotent via the m2 watermark). */
  reconcile(sessionId: string, instance: string): void;
  invalidateAdaptive(reason: InvalidateReason, sessionId?: string, instance?: string): void;
  snapshot(): AdaptiveSnapshot;
  dispose(): void;
}

export interface CacheAdaptiveService extends AdaptivePort {
  /** Signal forwarders (wireCacheEvents calls these). All go through the same identity guard. */
  noteToolStart(sessionId: string, instance: string): void;
  noteToolEnd(sessionId: string, instance: string): void;
  noteUiPromptStart(sessionId: string, instance: string): void;
  noteUiPromptEnd(sessionId: string, instance: string): void;
  /** `agent_settled`: force counters back to 0 and close the armed episode. */
  noteAgentSettled(sessionId: string, instance: string): void;
}

export interface CacheAdaptiveDeps {
  /** Defaults to `systemClock`; tests inject `FakeClock`. */
  clock?: Clock;
  ctx: ExtensionContext;
  sessionId: string;
  /** Reference, not a snapshot — knobs are re-read per decision so `/agent settings` changes apply live. */
  settings: CacheTtlSettings;
  signals: () => AdaptiveExternalSignals;
  /** I-A7: whether `self` is still the holder's current instance (stack.ts passes `(self) => previousAdaptive === self`). */
  isCurrent: (self: CacheAdaptiveService) => boolean;
  appendEntry?: (customType: string, data: unknown) => void;
  emit?: (channel: string, payload: unknown) => void;
}

const AUDIT_CUSTOM_TYPE = "subagent:cache-adaptive";

class CacheAdaptiveServiceImpl implements CacheAdaptiveService {
  readonly instanceId: string;
  private readonly clock: Clock;
  private readonly ownSessionId: string;
  private disposed = false;
  private activeTools = 0;
  private uiPrompts = 0;
  private state: AdaptiveState = createInitialAdaptiveState();
  private dropped = { sessionMismatch: 0, instanceMismatch: 0 };

  constructor(private readonly deps: CacheAdaptiveDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ownSessionId = deps.sessionId;
    this.instanceId = `${deps.sessionId}#${this.clock.now()}#${randomUUID().slice(0, 8)}`;
  }

  // -- I-A7: unified entry guard (mirror of cache-keepalive.ts's accept()) --

  private accept(sessionId: string, instance: string): boolean {
    if (this.disposed) return false;
    if (sessionId === "" || sessionId !== this.ownSessionId) {
      this.dropped.sessionMismatch += 1;
      return false;
    }
    if (instance !== this.instanceId || !this.deps.isCurrent(this)) {
      this.dropped.instanceMismatch += 1;
      return false;
    }
    return true;
  }

  private config(): AdaptiveConfig {
    const s = this.deps.settings;
    return {
      writeBudgetTokens: s.adaptiveWriteBudgetTokens,
      maxDeltaTokens: s.adaptiveMaxDeltaTokens,
      refreshAfterTokens: s.adaptiveRefreshAfterTokens,
      coldUpgrades: s.adaptiveColdUpgrades,
      coldCooldownMs: s.adaptiveColdCooldownMs,
      coldMinHorizonMs: s.adaptiveColdMinHorizonMs,
      historyGapSignal: s.adaptiveHistoryGapSignal,
      probeWriteFactor: ADAPTIVE_PROBE_WRITE_FACTOR,
      probeWriteFloorTokens: ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS,
    };
  }

  private safeModel(): AdaptiveModelInfo | undefined {
    try {
      return this.deps.ctx.model as unknown as AdaptiveModelInfo | undefined;
    } catch {
      return undefined;
    }
  }

  /** Same conservative semantics as cache-keepalive.ts: `false` when the flag is explicitly false OR the model can't be read at all. */
  private supportsLongCacheRetention(): boolean {
    const model = this.safeModel();
    if (!model) return false;
    return model.compat?.supportsLongCacheRetention !== false;
  }

  /** signals() throwing (query/basJobs in a degraded path) ⇒ all-zero ⇒ never upgrades (plan.md §15 R7). */
  private safeSignals(): AdaptiveSignals {
    let external: AdaptiveExternalSignals = { subagentRuns: 0, maxSubagentHorizonMs: undefined, backgroundBashJobs: 0 };
    try {
      external = this.deps.signals();
    } catch {
      // fall through with all-zero external signals.
    }
    return { ...external, uiPrompts: this.uiPrompts, activeTools: this.activeTools };
  }

  private audit(kind: string, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.appendEntry?.(AUDIT_CUSTOM_TYPE, { kind, at: this.clock.now(), ...extra });
    } catch {
      // best-effort only — never break a request over an audit write.
    }
    try {
      this.deps.emit?.("subagent:cache-adaptive", { kind, at: this.clock.now() });
    } catch {
      // same as above.
    }
  }

  // -- AdaptivePort ---------------------------------------------------------

  decide(sessionId: string, instance: string, request: AdaptiveDecideRequest): AdaptiveDecision {
    const now = this.clock.now();
    // m6 (accepted v1 limitation): a rejected call reports reason "breaker" —
    // disposed and a real breaker trip are indistinguishable in the audit.
    const declined: AdaptiveDecision = {
      upgrade: false,
      class: undefined,
      reason: "breaker",
      signals: [],
      predictedDeltaTokens: 0,
      at: now,
    };
    if (!this.accept(sessionId, instance)) return declined;

    const model = this.safeModel();
    const signals = this.safeSignals();
    const gapMs = this.state.lastRequestStartedAt !== undefined ? now - this.state.lastRequestStartedAt : undefined;
    const decision = decideAdaptiveTtl({
      now,
      mode: "adaptive", // the caller (cache-ttl.ts) already gated on the mode setting.
      api: model?.api ?? "",
      provider: model?.provider ?? "",
      modelId: model?.id ?? "",
      supportsLongCacheRetention: this.supportsLongCacheRetention(),
      shape: request.shape,
      signals,
      ledger: request.ledger,
      config: this.config(),
      state: this.state,
    });
    const strongSignals = decision.signals.filter((s) => s !== "history-gap").length;
    this.state = noteDecision(this.state, decision, {
      now,
      gapMs,
      entriesLength: request.ledger.entriesLength,
      strongSignals,
    });
    this.audit("decision", {
      upgrade: decision.upgrade,
      class: decision.class,
      reason: decision.reason,
      signals: decision.signals,
      signalCounts: {
        subagentRuns: signals.subagentRuns,
        backgroundBashJobs: signals.backgroundBashJobs,
        uiPrompts: signals.uiPrompts,
        activeTools: signals.activeTools,
        maxSubagentHorizonMs: signals.maxSubagentHorizonMs,
      },
      gapBeforeMs: gapMs,
      predictedDeltaTokens: decision.predictedDeltaTokens,
      budget: {
        upgradeWriteTokens: this.state.upgradeWriteTokens,
        writeBudgetTokens: this.config().writeBudgetTokens,
        coldUpgrades: this.state.coldUpgradesUsed,
        coldUpgradeCap: this.config().coldUpgrades,
      },
    });
    return decision;
  }

  reconcile(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    const now = this.clock.now();
    const ledger = readLatestAssistantUsage(this.deps.ctx);
    const before = this.state;
    this.state = onLedgerObserved(this.state, ledger, now, this.config());
    if (this.state === before) return; // duplicate event or unreadable ledger — nothing accounted.
    const ttl1h =
      ledger.cacheWrite1h !== undefined && ledger.cacheWrite1h > 0
        ? "confirmed"
        : ledger.cacheWrite > 0
          ? "unconfirmed"
          : "n/a";
    this.audit("reconcile", {
      pendingClass: before.pending?.class,
      cacheRead: ledger.cacheRead,
      cacheWrite: ledger.cacheWrite,
      cacheWrite1h: ledger.cacheWrite1h,
      costTotalUsd: ledger.costTotalUsd,
      ttl1h,
      upgradeWriteTokens: this.state.upgradeWriteTokens,
      breaker: this.state.breaker?.reason,
    });
    if (this.state.breaker !== undefined && before.breaker === undefined) {
      // Same noise policy as keepalive: session-level disable earns one console.warn.
      console.warn(`[pi-subagent] cache adaptive disabled for this session: ${this.state.breaker.reason}`);
    }
  }

  invalidateAdaptive(reason: InvalidateReason, sessionId?: string, instance?: string): void {
    const sid = sessionId ?? this.ownSessionId;
    const inst = instance ?? this.instanceId;
    if (!this.accept(sid, inst)) return;
    const entriesLength = readLatestAssistantUsage(this.deps.ctx).entriesLength;
    this.state = invalidateReducer(this.state, reason, entriesLength);
  }

  snapshot(): AdaptiveSnapshot {
    return buildAdaptiveSnapshot(this.state, this.config(), this.clock.now());
  }

  // -- signal forwarders ------------------------------------------------------

  noteToolStart(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools += 1;
  }

  noteToolEnd(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools = Math.max(0, this.activeTools - 1);
  }

  noteUiPromptStart(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.uiPrompts += 1;
  }

  noteUiPromptEnd(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.uiPrompts = Math.max(0, this.uiPrompts - 1);
  }

  noteAgentSettled(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools = 0;
    this.uiPrompts = 0;
    this.state = endArmedEpisode(this.state);
  }

  // -- lifecycle --------------------------------------------------------------

  /** Idempotent; there are no timers/sockets to release (I-A8). The shared status key is cleared by the keepalive service's dispose / cache-ttl.ts, not here. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
  }
}

export function createCacheAdaptiveService(deps: CacheAdaptiveDeps): CacheAdaptiveService {
  return new CacheAdaptiveServiceImpl(deps);
}
