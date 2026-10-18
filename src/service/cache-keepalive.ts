/**
 * Prompt-cache keepalive scheduler — stack service (plan.md §2/§8).
 *
 * Owns everything pi-facing about the keepalive feature: the self-arming
 * timer (`systemClock.setTimer`, already unref'd — AGENTS.md's "ref'd timers
 * wedge `pi -p`" rule), session/instance identity guards (I-K6/I-K9), the
 * window-generation guard (I-K8), the auth resolution + actual HTTP ping,
 * and the proven-hit-only breaker bookkeeping (I-K7). Constructed once per
 * `buildSessionStack` call and disposed at the top of the next build /
 * `session_shutdown` (see src/stack.ts and src/index.ts).
 *
 * Pure decision logic lives in ../cache-ttl/keepalive-state.ts and
 * ../cache-ttl/ping-client.ts — this file only wires them to a live clock,
 * `fetch`, and the pi `ExtensionContext`.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import {
  TICK_INTERVAL_MS,
  TTL_SAFETY_MARGIN_MS,
  cacheReadCostUsd,
  cacheWriteCostUsd,
  compareFingerprint,
  computeWindowCap,
  FALLBACK_WINDOW_CAP,
  type WindowCap,
  type KeepaliveCostModel,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  invalidate as invalidateReducer,
  onPingStarted,
  onProvenHit,
  onRealRequest,
  onRequestSettled,
  onSuccessfulRealRequest,
  countOpenLines,
  lineKeyOf,
  resetAllBreakers,
  sanitizeHttpStatus,
  type BreakerResetSummary,
  type LineRef,
  onUnproven,
  renderCacheStatus,
  readCacheStatusTheme,
  renderKeepaliveReportLines,
  KEEPALIVE_AUDIT_CUSTOM_TYPE,
  type CacheDisplayMode,
  type CapturedRequest,
  type CaptureFingerprint,
  type InvalidateReason,
  type KeepaliveConfig,
  type KeepalivePingDiagnostics,
  type KeepaliveReport,
  type SessionTotals,
  type TickSkipReason,
  type WindowState,
} from "../cache-ttl/keepalive-state.js";
import {
  buildPingRequest,
  preparePingPayload,
  sendKeepalivePing,
  stripCacheControlTtl,
  type PingOutcome,
} from "../cache-ttl/ping-client.js";
import type { ProviderEvidenceStore } from "../cache-ttl/provider-evidence.js";
import type { ChildKeepaliveLedger, Lease } from "../cache-ttl/ping-ledger.js";
import type { CacheTtlSettings } from "../config/settings.js";
import type { Millis } from "../core/types.js";

/** pi-free-ish subset of what this module needs from `ctx.model` (structurally satisfied by pi-ai's `Model`). */
interface KeepaliveModelInfo {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  cost?:
    | {
        cacheRead?: number;
        /** child-ka-core: pi-ai's cache-WRITE rate ($ per million tokens), used to charge `proven-write` / possibly-billed unproven outcomes against the child $ budgets. */
        cacheWrite?: number;
        tiers?: { inputTokensAbove: number; cacheRead?: number; cacheWrite?: number }[];
      }
    | undefined;
  /** Anthropic-messages compat flag (pi's own default is `true` when unset). See `report()`'s `supportsLongCacheRetention`. */
  compat?: { supportsLongCacheRetention?: boolean } | undefined;
  /** child-ka-core: presence (any retention key) means pi's own native `CacheWarmer` is already eligible for this model/route — see `safeNativeWarmerActive()`. */
  promptCache?: Record<string, unknown> | undefined;
}

/**
 * Ping retry policy (user requirement, 2026-09-26 — see docs/dev/cache-ttl-keepalive/plan.md's
 * appended "ping 重试" section). Only outcomes where the server provably did NOT process the
 * request (no cache billing possible) are retried: `network` (no response headers at all) and
 * these HTTP statuses (rate-limited / transient upstream — never a 4xx that means "this request
 * is wrong", and never `accepted-then-lost`, which got a 200 and may already have been billed).
 * Two retries max (three attempts total), backed off 2s then 5s.
 */
/** Max time one blocking UI-prompt episode (nothing else running) keeps the cache warm — nobody may answer for hours. */
export const UI_PROMPT_KEEPALIVE_MAX_MS = 60 * 60_000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
/**
 * r2 (2026-10-14, plan.md "ping 重试 r2"): retry until the cache window runs out — 2s → 5s → 10s
 * → 20s → 30s, then a constant 30s — bounded by `aliveUntil − TTL_SAFETY_MARGIN_MS`. When
 * `aliveUntil` is unknown, fall back to the legacy 3-attempt cap.
 */
const PING_RETRY_DELAYS_MS: readonly Millis[] = [2_000, 5_000, 10_000, 20_000, 30_000];
const PING_RETRY_STEADY_DELAY_MS: Millis = 30_000;
const PING_MAX_ATTEMPTS_UNKNOWN_WINDOW = 3;

function pingRetryDelayMs(attempt: number): Millis {
  return PING_RETRY_DELAYS_MS[attempt - 1] ?? PING_RETRY_STEADY_DELAY_MS;
}

function isRetryablePingOutcome(outcome: PingOutcome): boolean {
  if (outcome.kind === "network") return true;
  if (outcome.kind === "http") return RETRYABLE_HTTP_STATUSES.has(outcome.status);
  return false;
}

/**
 * child-ka-core (plan.md §2.4 "计费"): whether the server provably never
 * processed a ping request — no cache read OR write could have happened, so
 * the budget charge for it is 0. Per §2.4's literal wording ("经重试最终仍是
 * 『服务端未处理』类（network / 可重试状态码）计 0"), this is EXACTLY the same
 * kind set that `isRetryablePingOutcome()` uses to decide whether to retry —
 * only network (no response headers received at all) and the retryable HTTP
 * statuses (`RETRYABLE_HTTP_STATUSES`) qualify. `"no-usage"` is a 200
 * response: the server DID process the request, so a missing/zero `usage`
 * object is not proof of no billing (a proxy/relay route can omit cache
 * fields on an already-billed response) — it is charged the conservative
 * upper bound below, same as `"accepted-then-lost"` / `"malformed"` / a
 * non-retryable HTTP status. Confirmed against plan intent (author consult,
 * 2026 review): the plan never meant to special-case `"no-usage"` as $0.
 */
function isNeverProcessedOutcome(outcome: PingOutcome): boolean {
  return isRetryablePingOutcome(outcome);
}

const EMPTY_FINGERPRINT: CaptureFingerprint = {
  sessionId: "",
  provider: "",
  api: "",
  modelId: "",
  ctxModelId: "",
  baseUrl: "",
  authHeaderKeys: "",
  breakpointPath: "",
  thinkingDigest: "",
  systemDigest: "",
  toolsDigest: "",
  messageCount: 0,
};

/** plan.md §2.3: the KeepalivePort interface `src/cache-ttl/cache-ttl.ts` (activate-level, pi-free-ish) talks to. */
export interface KeepalivePort {
  /** I-K9: this instance's unique, non-reusable id; captured into `CapturedRequest.instance`. */
  readonly instanceId: string;
  noteRequest(captured: CapturedRequest): void;
  noteRequestSettled(
    sessionId: string,
    instance: string,
    successful?: boolean,
    settledRoute?: { provider: string; modelId: string },
    inputTokens?: number,
  ): void;
  invalidate(reason: InvalidateReason, sessionId?: string, instance?: string): void;
  report(): KeepaliveReport;
  /**
   * D1: start time of the most recent PROVEN cache read in the CURRENT window
   * (`WindowState.lastProvenPingStartedAt`), or `undefined` when nothing has
   * been proven or the window was invalidated / stopped by an unproven ping
   * (both clear `capture`, which is the liveness guard used here).
   *
   * Consumed by the warmth port as proven evidence. Reports this instance's own state.
   */
  provenCacheReadAt(): Millis | undefined;
  setEnabled(on: boolean): void;
  /**
   * plan.md merge note (UI cleanup): `cache-ttl.ts` owns the mode/dirty
   * state (the on/off/auto switch + unsaved-changes flag); this service
   * owns ping/window/session state but renders BOTH into the single merged
   * status key. `cache-ttl.ts` calls this whenever its mode/dirty state
   * changes (and once per `before_provider_request`, so a freshly rebuilt
   * service catches up quickly) so the service's own self-triggered
   * `publishVisibility()` calls (after a ping resolves, etc.) render with
   * the CURRENT mode rather than a stale/default one.
   */
  syncModeState(mode: CacheDisplayMode, dirty: boolean): void;
}

export interface CacheKeepaliveService extends KeepalivePort {
  /** Armed-signal / drift-event forwarders (index.ts activate-level hooks call these). All go through the same identity guard as the port methods. */
  noteToolStart(sessionId: string, instance: string): void;
  noteToolEnd(sessionId: string, instance: string): void;
  noteUiPromptStart(sessionId: string, instance: string): void;
  noteUiPromptEnd(sessionId: string, instance: string): void;
  /** `agent_settled`: force `activeTools`/`uiPrompts` back to 0 (self-heals a leaked start/end pair). */
  noteAgentSettled(sessionId: string, instance: string): void;
  /**
   * O3: a real request's usage showed `cacheRead > 0` on this session's route. Clears the
   * session-local `no-cache-value` latch (the cross-session ledger reset already happened at
   * the observation site — `provider-evidence.ts`'s `observeUsageIntoEvidence`).
   */
  noteUsageCacheRead(sessionId: string, instance: string): void;
  /** Manual breaker reset (`/cache-ttl keepalive reset`): clears every breaker incl. economic ones + the current line's no-cache-value evidence. */
  resetBreakers(): BreakerResetSummary & { evidenceCleared: boolean };
  dispose(): void;
}

export interface CacheKeepaliveDeps {
  /** Defaults to `systemClock` (already unref'd); tests inject `FakeClock`. */
  clock?: Clock;
  ctx: ExtensionContext;
  sessionId: string;
  /** Reference, not a snapshot — numeric knobs are re-read every tick so `/agent settings` changes apply live. */
  settings: CacheTtlSettings;
  /** stack's own `query.list()` + `bashJobs.backgroundJobCount()` (plan.md §2.2) — never `readBackgroundStatus()`. */
  backgroundBusy: () => boolean;
  /** I-K9: whether `self` is still the holder's current instance (stack.ts passes `(self) => holder.current?.keepalive === self`). */
  isCurrent: (self: CacheKeepaliveService) => boolean;
  fetchImpl?: typeof fetch;
  appendEntry?: (customType: string, data: unknown) => void;
  emit?: (channel: string, payload: unknown) => void;
  // -- child-ka-core (docs/dev/child-context-switch/plan.md §2.4/§7 P1) -------
  // Every field below defaults to "off" (undefined/false) ⇒ the main session's
  // existing behavior is byte-identical unless a caller (P3's `src/cache-ttl/
  // child.ts`) explicitly opts in. None of these are read from `settings`
  // (`CacheTtlSettings`) directly — they are runtime/wiring decisions, not
  // persisted user settings (the persisted `cacheTtl.child*` keys exist so
  // that wiring layer can derive these values, see settings.ts).
  /** Feeds `KeepaliveConfig.allowHeadless` (gate #4/G2's extra `"print"` allowance). */
  allowHeadless?: boolean;
  /** Feeds `KeepaliveConfig.maxSessionPings` (per-run proven-hit cap across all windows). */
  maxSessionPings?: number;
  /**
   * Process-wide ping admission ledger (concurrency slot + rolling-24h $
   * budget, `src/cache-ttl/ping-ledger.ts`). Absent ⇒ no budget/concurrency
   * gating is EVER applied — `runBudgetUsd`/`processBudgetUsd`/`maxConcurrentPings`
   * below are only consulted when this is set.
   */
  pingLedger?: ChildKeepaliveLedger;
  /** This run's own $ spend cap, checked before `pingLedger.tryAcquire` using the running total of actually-charged `budgetChargeUsd` (seeded by `runSpentSeedUsd`). `0` = never ping (this run). Absent ⇒ unbounded. */
  runBudgetUsd?: number;
  /** Seeds the run-level $ spend counter — resume continuity (summing a resumed session's prior audit entries) is the wiring layer's job, not this service's. Default 0. */
  runSpentSeedUsd?: number;
  /** Session-level keepalive state read back from this branch across /reload (main session only). */
  restoredState?: SessionTotals | undefined;
  /** Main-session-only transient breaker recovery; child keepalive remains byte-compatible. */
  recoverTransientFailures?: boolean | undefined;
  /** Main-session-only session snapshot persistence; child audit entries remain byte-compatible. */
  persistSessionState?: boolean | undefined;
  /** Rolling 24h process-wide $ budget, passed to `pingLedger.tryAcquire` on every call (so `/agent settings` changes apply live). Only meaningful together with `pingLedger`. */
  processBudgetUsd?: number;
  /** Process-wide concurrent-ping slot cap, passed to `pingLedger.tryAcquire` on every call. Only meaningful together with `pingLedger`. */
  maxConcurrentPings?: number;
  /** Races the auth-resolution await against this timeout (ms); on timeout the reservation/budget are refunded/released and nothing is counted — the request never left. Absent (main session) ⇒ unbounded (today's behavior). */
  authTimeoutMs?: number;
  /** `audit()` additionally carries `costUsd`/`budgetChargeUsd`/`runSpentUsd`/`processSpentUsd24h` fields. Default false — the main session's audit entries stay byte-identical. */
  reportCost?: boolean;
  /** `false` ⇒ never call `ctx.ui.setStatus` (child sessions have no status bar to write). Default true (main session unaffected). */
  statusBar?: boolean;
  /**
   * O2/O3 (provider-evidence, 2026-10-12): the shared provider-route evidence store
   * (`src/cache-ttl/provider-evidence.ts`). Used for two things:
   *   - O2: when a captured payload carries `cache_control.ttl:"1h"`, the replay keeps `ttl`
   *     only when this store has PROVEN 1h landing evidence for the route (otherwise gate #7's
   *     分流 lets the window through and `stripCacheControlTtl` degrades it to a 5m ping).
   *   - O3: the `no-cache-value` breaker — routes fused off by the store are skipped at tick
   *     time (and latched into `session.disabled`), and at `dispose()` this session's
   *     keepalive-active-but-zero-read verdict is folded back into the store.
   * Absent ⇒ neither behaviour (byte-identical to before; tests stay hermetic).
   */
  evidence?: ProviderEvidenceStore | undefined;
}

/** The wire model must be CERTAINLY mapped to this exact route. Anthropic normally sends
 * payload.model === model.id; aliases not registered under that exact id fall back, never guess.
 */
export function resolveCapModel(
  registry: Pick<ExtensionContext["modelRegistry"], "find"> | undefined,
  fp: Pick<CaptureFingerprint, "provider" | "modelId" | "api" | "baseUrl">,
): Pick<KeepaliveModelInfo, "cost"> | undefined {
  try {
    const model = registry?.find(fp.provider, fp.modelId);
    if (!model || model.api !== fp.api || model.baseUrl !== fp.baseUrl) return undefined;
    // Snapshot rates, including whole tiers: a models.json refresh (even in-place) must not
    // reprice a capture between its request hook and its response's usage arriving.
    const cost = model.cost;
    return {
      cost: cost ? { ...cost, ...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}) } : undefined,
    };
  } catch {
    return undefined;
  }
}

function safeSetStatus(ctx: ExtensionContext, text: string | undefined): void {
  try {
    // Merged status key (task's UI cleanup): the ping/window/session segment
    // used to live under its own "cache-keepalive" key, fighting the mode/
    // dirty segment ("cache-ttl") for status-bar real estate. Both writers
    // now share this one key — `renderCacheStatus` is the single place that
    // formats the merged text (see keepalive-state.ts).
    if (ctx.ui && typeof ctx.ui.setStatus === "function") ctx.ui.setStatus("cache-ttl", text);
  } catch {
    // ui not ready / stale ctx — never let visibility break the scheduler.
  }
}

class CacheKeepaliveServiceImpl implements CacheKeepaliveService {
  readonly instanceId: string;
  private readonly clock: Clock;
  private readonly ownSessionId: string;
  private disposed = false;
  private enabledOverride: boolean | undefined;
  private timer: TimerHandle | undefined;
  /** todo #28: precise one-shot timer for `window.nextPingAt` — see `syncExactTimer`'s doc comment. */
  private exactTimer: TimerHandle | undefined;
  /** The `nextPingAt` value `exactTimer` is currently scheduled for, or `undefined` when none is pending. */
  private exactTimerFor: Millis | undefined;
  /** todo #28: the `windowEpoch` a terminal-skip diagnostic was already recorded for — one per window. */
  private terminalSkipAuditedEpoch: number | undefined;
  /** See `KeepaliveReport.lastTerminalSkip`. */
  private lastTerminalSkip: { reason: TickSkipReason; at: Millis; windowEpoch: number } | undefined;
  private abortController: AbortController | undefined;
  /** Ping-retry backoff wait (user requirement 2026-09-26) — cleared/resolved by `dispose()` so a pending retry never wedges past teardown. */
  private pendingRetry: { timer: TimerHandle; resolve: () => void } | undefined;
  /** child-ka-core: pending `withTimeout` auth-race timer, so `dispose()` can reject it immediately (same convention as `pendingRetry`). */
  private pendingAuthTimeout: { timer: TimerHandle; reject: () => void } | undefined;
  private lockedAuthHeaderKeys: string | undefined;
  private activeTools = 0;
  private uiPrompts = 0;
  /** Clock time the current UI-prompt episode began (`uiPrompts` 0→1); undefined while no prompt is pending. */
  private uiPromptEpisodeStart: Millis | undefined;
  private window: WindowState = createInitialWindowState();
  private session: SessionTotals;
  private dropped = { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 };
  private lastSkip: TickSkipReason | undefined;
  /** See `KeepaliveReport.lastPingDiagnostics`. */
  private lastPingDiagnostics: KeepalivePingDiagnostics | undefined;
  /** Mirrors `cache-ttl.ts`'s mode/dirty closure (see `syncModeState`'s doc comment). */
  private modeState: { mode: CacheDisplayMode; dirty: boolean } = { mode: "auto", dirty: false };
  /** child-ka-core: this run's cumulative ACTUALLY-CHARGED $ spend (never includes reservations that were later revoked). Seeded by `deps.runSpentSeedUsd` so a resumed session continues its prior total. */
  private runSpentUsd: number;
  /** child-ka-core: the ledger lease currently held for an in-flight ping, if any — `dispose()`'s defensive backstop settles it if `runPing`'s own `finally` somehow never ran. */
  private currentLease: Lease | undefined;
  /** O3: the route of the most recent capture (fingerprint provider + wire modelId) — kept past `capture` clearing so dispose-time accounting still knows which route this session ran on. */
  private lastRoute: { provider: string; modelId: string } | undefined;
  /** Line (provider/ctxModelId/baseUrl) of the most recent capture — the precise attribution source for a settled success. */
  private inflightLine: { provider: string; ctxModelId: string; baseUrl: string } | undefined;
  /** Dedup for `line-reset-skipped` audits (bounded). */
  private readonly unresolvedAudited = new Set<string>();
  /** O3: true once any cache read was observed this session (proven-hit ping or a real request's usage via `noteUsageCacheRead`). */
  private observedCacheRead = false;
  /** O3: ping attempts actually issued this session (the "keepalive was active" half of the zero-read verdict). */
  private pingAttempts = 0;

  constructor(private readonly deps: CacheKeepaliveDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ownSessionId = deps.sessionId;
    this.instanceId = `${deps.sessionId}#${this.clock.now()}#${randomUUID().slice(0, 8)}`;
    this.session = deps.restoredState ?? createInitialSessionTotals();
    this.runSpentUsd = Math.max(0, deps.runSpentSeedUsd ?? 0);
  }

  // -- I-K6 + I-K9: unified entry guard ------------------------------------

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

  // -- I-K8: window-generation guard for anything writing back into state --

  private sameEpoch(pingEpoch: number): boolean {
    if (this.disposed || pingEpoch !== this.window.windowEpoch) {
      this.dropped.epochMismatch += 1;
      return false;
    }
    return true;
  }

  /** One snapshot per capture: models.json changes never retroactively reprice an open window.
   * Usage arrives later, from that capture's OWN real response; only the cap is then recomputed.
   */
  private capMemo:
    { capture: CapturedRequest; cost: KeepaliveCostModel | undefined; mapped: boolean; cap: WindowCap } | undefined;

  private windowCap(): WindowCap {
    const capture = this.window.capture;
    if (capture !== undefined && this.capMemo?.capture === capture) return this.capMemo.cap;
    if (capture === undefined) this.capMemo = undefined;
    let mapped: ReturnType<typeof resolveCapModel>;
    try {
      const model = capture === undefined ? this.safeModel() : undefined;
      const fp =
        capture?.fingerprint ??
        (model
          ? {
              provider: model.provider,
              modelId: model.id,
              api: model.api,
              baseUrl: model.baseUrl,
            }
          : undefined);
      mapped = fp ? resolveCapModel(this.deps.ctx.modelRegistry, fp) : undefined;
    } catch {
      // ctx/registry can be stale, just like safeModel(). Unknown prices are not a crash.
    }
    const cap: WindowCap = mapped
      ? // No capture means no window-opening real response usage either. Tiered models
        // must stay tier-uncertain here, not promise a base-tier price before the request.
        computeWindowCap(mapped.cost)
      : { cap: FALLBACK_WINDOW_CAP, source: "fallback", reason: "wire-model-unmapped" };
    if (capture !== undefined) this.capMemo = { capture, cost: mapped?.cost, mapped: mapped !== undefined, cap };
    return cap;
  }

  private config(): KeepaliveConfig {
    const s = this.deps.settings;
    const cap = this.windowCap();
    return {
      enabled: this.enabledOverride ?? s.keepalive,
      intervalMs: s.keepaliveIntervalMs,
      maxPings: cap.cap,
      maxPingsSource: cap.source,
      ...(cap.rawCap !== undefined ? { maxPingsRaw: cap.rawCap } : {}),
      ...(cap.reason !== undefined ? { maxPingsReason: cap.reason } : {}),
      minPrefixTokens: s.keepaliveMinPrefixTokens,
      ...(this.deps.allowHeadless !== undefined ? { allowHeadless: this.deps.allowHeadless } : {}),
      ...(this.deps.maxSessionPings !== undefined ? { maxSessionPings: this.deps.maxSessionPings } : {}),
    };
  }

  private safeModel(): KeepaliveModelInfo | undefined {
    try {
      return this.deps.ctx.model as unknown as KeepaliveModelInfo | undefined;
    } catch {
      this.dispose();
      return undefined;
    }
  }

  private safeMode(): string {
    try {
      return this.deps.ctx.mode;
    } catch {
      return "";
    }
  }

  /** child-ka-core: true when `ctx.model` declares `promptCache` (pi's own native `CacheWarmer` is eligible for this model/route) — never let a throw/read failure break a tick. */
  private safeNativeWarmerActive(): boolean {
    try {
      const model = this.safeModel();
      return model?.promptCache !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * child-ka-core (plan.md §2.4): the extra child-only admission checks run
   * AFTER `evaluateTick` has already decided "ping" — they need the model's
   * cost data and the process-wide ledger, neither of which the pure
   * `evaluateTick` touches. `deps.pingLedger` absent (main session, or a
   * child session that hasn't opted in) ⇒ always allow, byte-identical to
   * today. Order mirrors plan.md §2.4 exactly: unpriced → run budget →
   * ledger (concurrency slot + process budget).
   */
  private childPingGate(
    capture: CapturedRequest,
    now: Millis,
  ):
    | { allow: true; estimateUsd: number | undefined; lease: Lease | undefined }
    | { allow: false; reason: TickSkipReason; terminal: boolean; estimateUsd: number | undefined } {
    const ledger = this.deps.pingLedger;
    if (!ledger) return { allow: true, estimateUsd: undefined, lease: undefined };

    const model = this.safeModel();
    const estimateUsd = cacheReadCostUsd(model?.cost, capture.prefix.tokens);
    if (estimateUsd === undefined) {
      return { allow: false, reason: "usd-unpriced", terminal: true, estimateUsd: undefined };
    }

    const runBudgetUsd = this.deps.runBudgetUsd ?? Number.POSITIVE_INFINITY;
    if (this.runSpentUsd + estimateUsd > runBudgetUsd) {
      return { allow: false, reason: "usd-run", terminal: true, estimateUsd };
    }

    const acquired = ledger.tryAcquire({
      holderId: this.instanceId,
      estimateUsd,
      maxConcurrent: this.deps.maxConcurrentPings ?? Number.POSITIVE_INFINITY,
      processBudgetUsd: this.deps.processBudgetUsd ?? Number.POSITIVE_INFINITY,
      now,
    });
    if (!acquired.ok) {
      return { allow: false, reason: acquired.reason, terminal: acquired.reason === "usd-process", estimateUsd };
    }
    return { allow: true, estimateUsd, lease: acquired.lease };
  }

  /** child-ka-core: the `budgetChargeUsd`/`runSpentUsd`/`processSpentUsd24h` triad shared by every cost-carrying audit entry. */
  /**
   * child-ka-core: the `budgetChargeUsd`/`runSpentUsd`/`processSpentUsd24h`
   * triad shared by every cost-carrying audit entry. `spent24h` only reflects
   * SETTLED charges — the current ping's own charge is settled into the
   * ledger strictly AFTER this is called (in `runPing`'s outer `finally`), so
   * `chargeUsd` is added explicitly to report the correct "including this
   * one" cumulative figure.
   */
  private budgetFields(chargeUsd: number, now: Millis): Record<string, unknown> {
    return {
      budgetChargeUsd: chargeUsd,
      runSpentUsd: this.runSpentUsd,
      processSpentUsd24h: (this.deps.pingLedger?.spent24h(now) ?? 0) + chargeUsd,
    };
  }

  /**
   * child-ka-core (plan.md §2.4 "计费"): the $ actually charged for a resolved
   * ping outcome, against a $ budget — NEVER against `usage.costUsd` (that
   * field is reserved for known real spend, and this is sometimes a
   * conservative estimate, see `isNeverProcessedOutcome`'s doc comment).
   */
  private budgetChargeForOutcome(
    outcome: PingOutcome,
    capture: CapturedRequest,
    model: KeepaliveModelInfo | undefined,
  ): number {
    if (outcome.kind === "proven-hit") return cacheReadCostUsd(model?.cost, outcome.cacheReadTokens) ?? 0;
    if (outcome.kind === "proven-write") return cacheWriteCostUsd(model?.cost, outcome.cacheWriteTokens) ?? 0;
    if (isNeverProcessedOutcome(outcome)) return 0;
    // "possibly billed" (accepted-then-lost, malformed): conservative upper bound.
    return cacheWriteCostUsd(model?.cost, capture.prefix.tokens) ?? 0;
  }

  private armed(): boolean {
    try {
      if (this.deps.backgroundBusy()) return true;
      if (this.uiPromptExpired()) return false;
      return this.activeTools > 0 || this.uiPrompts > 0;
    } catch {
      return false;
    }
  }

  /**
   * A user-facing prompt (ask_user's `ctx.ui.custom`, any `ctx.ui.*` prompt — pi emits
   * `ui_prompt_start/end` for all of them) has been pending for `UI_PROMPT_KEEPALIVE_MAX_MS` with no
   * background work: stop keeping the cache warm (nobody may answer for hours). Background work
   * (`backgroundBusy()`) always wins and is checked by the caller first.
   */
  private uiPromptExpired(): boolean {
    if (this.uiPrompts <= 0 || this.uiPromptEpisodeStart === undefined) return false;
    try {
      if (this.deps.backgroundBusy()) return false;
    } catch {
      return false;
    }
    return this.clock.now() - this.uiPromptEpisodeStart >= UI_PROMPT_KEEPALIVE_MAX_MS;
  }

  /**
   * Corrective fix (audit pass, unrelated to the header bug): `false` only
   * when we positively know the model/route rejects `cache_control.ttl:"1h"`
   * (compat flag explicitly `false`) — pi's own default is `true` when the
   * flag is unset, so an absent flag still counts as supported. If `ctx.model`
   * can't be read at all, fall back to `false` (conservative: never promise a
   * 1h support we can't confirm is possible).
   */
  private supportsLongCacheRetention(): boolean {
    const model = this.safeModel();
    if (!model) return false;
    return model.compat?.supportsLongCacheRetention !== false;
  }

  /** plan.md §3.3/§9 (M4): safety fields refreshed from `ctx`; payload-derived fields inherited from the capture (they can only drift via an explicit `invalidate()` event). */
  private currentFingerprintFor(capture: CapturedRequest): CaptureFingerprint {
    const model = this.safeModel();
    return {
      ...capture.fingerprint,
      sessionId: this.ownSessionId,
      provider: model?.provider ?? "",
      api: model?.api ?? "",
      ctxModelId: model?.id ?? "",
      baseUrl: model?.baseUrl ?? "",
      authHeaderKeys: this.lockedAuthHeaderKeys ?? capture.fingerprint.authHeaderKeys,
    };
  }

  private publishVisibility(): void {
    if (this.deps.statusBar === false) return;
    safeSetStatus(
      this.deps.ctx,
      renderCacheStatus(
        {
          mode: this.modeState.mode,
          dirty: this.modeState.dirty,
          report: this.report(),
        },
        readCacheStatusTheme(this.deps.ctx),
      ),
    );
  }

  private audit(kind: string, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.appendEntry?.(KEEPALIVE_AUDIT_CUSTOM_TYPE, {
        kind,
        at: this.clock.now(),
        windowEpoch: this.window.windowEpoch,
        sessionPings: this.session.pings,
        ...(this.deps.persistSessionState
          ? {
              session: {
                ...this.session,
                disabled: this.session.disabled ?? null,
                lastUnproven: this.session.lastUnproven ?? null,
              },
            }
          : {}),
        ...extra,
      });
    } catch {
      // best-effort only — never break the scheduler over an audit write.
    }
    try {
      this.deps.emit?.("subagent:keepalive", { kind, at: this.clock.now() });
    } catch {
      // same as above.
    }
  }

  /**
   * Ping-retry backoff wait (user requirement 2026-09-26). Uses the injected
   * `Clock` (unref'd `systemClock.setTimer` in production, `FakeClock` in tests)
   * so retries never keep the process alive and are deterministically testable.
   * `dispose()` resolves any pending wait immediately so `runPing` unwinds
   * through its own `sameEpoch`/disposed checks instead of leaking a timer.
   */
  private sleep(ms: Millis): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.clock.setTimer(ms, () => {
        this.pendingRetry = undefined;
        resolve();
      });
      this.pendingRetry = { timer, resolve };
    });
  }

  private cancelPendingRetry(): void {
    if (this.pendingRetry === undefined) return;
    const { timer, resolve } = this.pendingRetry;
    this.pendingRetry = undefined;
    this.clock.clearTimer(timer);
    resolve();
  }

  /**
   * child-ka-core (plan.md §2.4): races `promise` against `ms` using the
   * injected `Clock` (never a bare `setTimeout` — must be driven by
   * `FakeClock` in tests and stay unref'd in production). On timeout the
   * caller sees a rejection and treats it exactly like an auth failure
   * (refund the reservation, count nothing — the request never left).
   * `dispose()` rejects any pending wait immediately, same convention as
   * `cancelPendingRetry`, so a disposed service never leaves a stray timer.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimer(ms, () => {
        if (settled) return;
        settled = true;
        this.pendingAuthTimeout = undefined;
        reject(new Error("cache-keepalive: auth resolution timed out"));
      });
      this.pendingAuthTimeout = {
        timer,
        reject: () => {
          if (settled) return;
          settled = true;
          reject(new Error("cache-keepalive: disposed while waiting for auth"));
        },
      };
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimer(timer);
          this.pendingAuthTimeout = undefined;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimer(timer);
          this.pendingAuthTimeout = undefined;
          reject(error);
        },
      );
    });
  }

  // -- timer (UsageBroadcaster self-arming/self-stopping pattern) ---------

  private arm(): void {
    // Idempotent (todo #28): the exact-timer's own `onTick()` call can reach
    // here while a periodic tick is ALREADY pending (same `nextPingAt`, tied
    // due time) — without this guard, `this.timer` would be overwritten and
    // the still-pending periodic entry would be orphaned (leaked, and would
    // fire a redundant duplicate `onTick()` later). Safe: every existing
    // caller already only wants "a tick is scheduled", not "a NEW tick".
    if (this.disposed || this.timer !== undefined) return;
    this.timer = this.clock.setTimer(TICK_INTERVAL_MS, () => {
      this.timer = undefined;
      this.onTick();
    });
  }

  /**
   * Precise one-shot timer for `window.nextPingAt` (todo #28 — field incident:
   * at the time of the fix the default/max `keepaliveIntervalMs` left exactly one
   * `TICK_INTERVAL_MS` between `nextPingAt` and the cache-expired cutoff (see
   * `MAX_SAFE_KEEPALIVE_INTERVAL_MS`'s doc comment; the 2026-10-16 margin change
   * 45s→15s widened that to 3 grid steps, but the phase-miss risk stands — only
   * the periodic grid decides WHEN ticks land, so a window can still lose every
   * in-window opportunity to transient not-armed instants). The 15s periodic tick's
   * coarse granularity can miss the window (e.g. every in-window tick happens to land
   * at a moment where `armed()` just flipped false, while an earlier, more precise
   * check would have caught the window while still armed — real-machine
   * repro: 3 windows, 1 hit). This schedules a SECOND, independent
   * `clock.setTimer` landing EXACTLY at `nextPingAt` and reuses `onTick()`
   * verbatim — every gate (armed/budget/fingerprint/...) still
   * applies; this only removes the polling-granularity risk.
   *
   * Rescheduled at every point that changes `window.nextPingAt` or clears
   * `window.capture` (new real request, a resolved ping's next deadline,
   * invalidate, dispose). Deliberately NOT called from the generic
   * terminal-skip path in `onTick()` — `nextPingAt` is unchanged there (still
   * in the past), so rescheduling would compute `delay=0` and refire in the
   * same `FakeClock.advance()`/microtask turn forever.
   *
   * A coincident fire with the periodic tick is deduped by the SAME
   * `pingInFlight` state `onTick()`'s own "ping" branch already checks — see
   * `arm()`'s idempotency guard for the mirror-image protection (no orphaned
   * periodic timer left behind when the exact timer's own `onTick()` call
   * tries to re-arm while a periodic entry is still pending).
   */
  private syncExactTimer(): void {
    if (this.disposed) {
      this.clearExactTimer();
      return;
    }
    const nextPingAt = this.window.nextPingAt;
    if (nextPingAt === undefined || this.window.capture === undefined || !this.config().enabled) {
      this.clearExactTimer();
      return;
    }
    if (this.exactTimerFor === nextPingAt) return; // already scheduled for this exact instant
    this.clearExactTimer();
    this.exactTimerFor = nextPingAt;
    const delay = Math.max(0, nextPingAt - this.clock.now());
    this.exactTimer = this.clock.setTimer(delay, () => {
      this.exactTimer = undefined;
      this.exactTimerFor = undefined;
      this.onTick();
    });
  }

  private clearExactTimer(): void {
    if (this.exactTimer) this.clock.clearTimer(this.exactTimer);
    this.exactTimer = undefined;
    this.exactTimerFor = undefined;
  }

  /**
   * todo #28: a TERMINAL skip on a window that still had a capture means this
   * window just permanently lost its ability to ping (budget exhausted, cache
   * judged dead, fingerprint/route mismatch, ...) — worth one
   * lightweight diagnostic so "why didn't it ping" doesn't need session-file
   * archaeology. Deduped per `windowEpoch`: a window re-armed by
   * `noteToolStart`/`noteUiPromptStart` after the periodic loop already
   * terminally stopped must not spam the audit trail with the same verdict.
   * A globally-disabled feature (`no-capture`/`disabled`/...) has no capture
   * to speak of — not "a window died", just "nothing was happening" — so it's
   * excluded.
   */
  private auditTerminalSkipOnce(reason: TickSkipReason): void {
    if (this.window.capture === undefined) return;
    if (this.terminalSkipAuditedEpoch === this.window.windowEpoch) return;
    this.terminalSkipAuditedEpoch = this.window.windowEpoch;
    this.lastTerminalSkip = { reason, at: this.clock.now(), windowEpoch: this.window.windowEpoch };
    const cap = this.windowCap();
    this.audit("terminal-skip", {
      reason,
      ...(reason === "budget-exhausted"
        ? {
            cap: cap.cap,
            capSource: cap.source,
            ...(cap.rawCap !== undefined ? { capRaw: cap.rawCap } : {}),
            ...(cap.reason !== undefined ? { capReason: cap.reason } : {}),
          }
        : {}),
    });
  }

  private onTick(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    const capture = this.window.capture;
    const result = evaluateTick({
      now,
      mode: this.safeMode(),
      armed: this.armed(),
      uiPromptExpired: this.uiPromptExpired(),
      config: this.config(),
      session: this.session,
      window: this.window,
      currentFingerprint: capture ? this.currentFingerprintFor(capture) : EMPTY_FINGERPRINT,
      nativeWarmerActive: this.safeNativeWarmerActive(),
      // O2 follow-up (gate #7 分流): resolve the route's 1h landing evidence at tick time.
      // Store absent ⇒ undefined ⇒ legacy skip (byte-identical); store present but no record /
      // read failure ⇒ false ⇒ the ttl-1h window falls through to a stripped 5m ping (I6).
      ...(capture !== undefined && this.deps.evidence !== undefined
        ? {
            write1hEvidence: this.deps.evidence.hasWrite1hEvidence(
              capture.fingerprint.provider,
              capture.fingerprint.modelId,
              now,
            ),
          }
        : {}),
    });
    this.window = result.window;
    switch (result.decision.kind) {
      case "invalidate":
        this.capMemo = undefined;
        this.lastSkip = undefined;
        this.audit("invalidate", { reason: result.decision.reason });
        this.syncExactTimer(); // todo #28: capture just got cleared — cancel any pending exact timer.
        return;
      case "skip":
        this.lastSkip = result.decision.reason;
        if (result.decision.terminal) {
          this.auditTerminalSkipOnce(result.decision.reason);
          // todo #28 P1 fix: a terminal skip means this window can never ping again
          // without a new real request (which re-arms via `noteRequest`'s own
          // `syncExactTimer()` call) — cancel any exact timer still pending for the
          // now-moot `nextPingAt` instead of leaving it to fire a redundant, merely
          // idempotent re-evaluation later. `clearExactTimer()`, not `syncExactTimer()`:
          // `nextPingAt` is unchanged here (still in the past relative to `now`), so
          // re-syncing would compute `delay=0` and refire in the same clock turn.
          this.clearExactTimer();
        }
        if (!result.decision.terminal) this.arm();
        return;
      case "ping": {
        // O3 (provider-evidence breaker): a route fused off by the persisted evidence ledger
        // (`no-cache-value`) never pings again until a real cache read resets it. Latched into
        // `session.disabled` so the merged status bar annotates it (`ping off:no-cache-value`)
        // and every later tick short-circuits at evaluateTick #2 — plus the regular session
        // snapshot carries it across /reload.
        if (this.deps.evidence?.isNoCacheValue(capture!.fingerprint.provider, capture!.fingerprint.modelId, now)) {
          this.session = { ...this.session, disabled: { reason: "no-cache-value", at: now } };
          this.lastSkip = "no-cache-value";
          this.auditTerminalSkipOnce("no-cache-value");
          this.clearExactTimer();
          this.publishVisibility();
          return;
        }
        const gate = this.childPingGate(capture!, now);
        if (!gate.allow) {
          this.lastSkip = gate.reason;
          if (
            this.deps.reportCost &&
            (gate.reason === "usd-unpriced" || gate.reason === "usd-run" || gate.reason === "usd-process")
          ) {
            this.audit("budget-stop", {
              reason: gate.reason,
              estimateUsd: gate.estimateUsd,
              ...this.budgetFields(0, now),
            });
          }
          // todo #28 P1 fix: same rationale as the terminal `skip` branch above —
          // a terminal gate denial (budget exhausted, unpriced route) ends this
          // window's ability to ping; drop the stale exact timer with it.
          if (gate.terminal) this.clearExactTimer();
          if (!gate.terminal) this.arm();
          return;
        }
        const pingStartedAt = now;
        this.window = onPingStarted(this.window, pingStartedAt);
        this.pingAttempts += 1; // O3: "keepalive was active" for the dispose-time verdict.
        const pingEpoch = this.window.windowEpoch;
        this.currentLease = gate.lease;
        this.arm(); // keep ticking while the ping is in flight (plan.md §8.3)
        void this.runPing(pingEpoch, capture!, gate.lease);
        return;
      }
    }
  }

  private async runPing(pingEpoch: number, capture: CapturedRequest, lease?: Lease): Promise<void> {
    // child-ka-core: every exit path below — including every existing early
    // `return` — must settle the lease exactly once with whatever charge was
    // actually incurred (default 0 = "never processed" / "nothing left this
    // process"). Wrapping the whole body is simpler and safer than threading a
    // settle-call through each early return individually.
    let chargeUsd = 0;
    try {
      const refundBudget = (): void => {
        if (!this.sameEpoch(pingEpoch)) return;
        this.window = { ...this.window, pingInFlight: false, pings: Math.max(0, this.window.pings - 1) };
      };

      const model = this.safeModel();
      if (!model) {
        refundBudget();
        return;
      }

      let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
      try {
        const authPromise = this.deps.ctx.modelRegistry.getApiKeyAndHeaders(model as never);
        auth =
          this.deps.authTimeoutMs !== undefined
            ? await this.withTimeout(authPromise, this.deps.authTimeoutMs)
            : await authPromise;
      } catch {
        // Covers both a genuine auth rejection AND our own `withTimeout` timeout
        // (child-ka-core, plan.md §2.4's `authTimeoutMs`) — either way the request
        // never left this process, so refund and count nothing (plan.md §8.4).
        refundBudget();
        return;
      }
      // I-K8: await return point #1.
      if (!this.sameEpoch(pingEpoch)) return;

      if (!auth.ok) {
        refundBudget();
        return; // request never left — not counted as unproven (plan.md §8.4).
      }

      const headerKeys = Object.keys(auth.headers ?? {})
        .sort()
        .join(",");
      if (this.lockedAuthHeaderKeys === undefined) this.lockedAuthHeaderKeys = headerKeys;

      // G7 (M4): safety-critical fingerprint recheck now that auth is resolved.
      // M1 fix: refund BEFORE invalidating — `invalidateReducer` bumps windowEpoch,
      // and `refundBudget`'s own `sameEpoch` guard requires the *old* epoch to
      // still match. Invalidating first made the refund unreachable (dead code),
      // permanently leaking `pingInFlight: true` and an already-spent `pings`
      // unit for a request that never left this process.
      const currentFp = this.currentFingerprintFor(capture);
      const diff = compareFingerprint(capture.fingerprint, currentFp);
      if (diff !== undefined) {
        refundBudget();
        if (this.sameEpoch(pingEpoch)) {
          this.window = invalidateReducer(this.window, `fingerprint-drift:${diff.field}`);
          this.syncExactTimer();
        }
        return;
      }

      // m2: re-check the TTL margin after the (possibly slow) auth await.
      const now = this.clock.now();
      if (this.window.aliveUntil !== undefined && now >= this.window.aliveUntil - TTL_SAFETY_MARGIN_MS) {
        refundBudget();
        return;
      }

      const body = preparePingPayload(capture.payload);
      // O2 (provider-evidence TTL gating): if the captured payload carries a `ttl:"1h"` write
      // intent, keep it ONLY when this route has a proven 1h landing on record — otherwise strip
      // `ttl` (and nothing else) so the replay degrades to a plain 5m ephemeral ping. On a
      // collapsing relay the bare `ttl` field buys nothing while billing the 2× 1h write rate,
      // and a 5m ping cannot refresh a real 1h entry anyway (separate cache namespaces).
      // Reachable since the gate #7 分流 (2026-10-12): evidence-less ttl-1h captures fall
      // through to here. `stripCacheControlTtl` is copy-on-write (the capture is shared state)
      // and fingerprint-neutral (ttl values were never fingerprinted — breakpoint paths were).
      // See ping-client.ts's doc comment.
      const pingBody =
        capture.shape.ttl1h === true &&
        this.deps.evidence?.hasWrite1hEvidence(
          capture.fingerprint.provider,
          capture.fingerprint.modelId,
          this.clock.now(),
        ) !== true
          ? stripCacheControlTtl(body)
          : body;
      // O2 follow-up: distinguish a "ttl-1h ⇒ 5m 放行" ping from an ordinary 5m ping in the
      // audit trail / `/cache-ttl status` (copy-on-write ⇒ identity change exactly when stripped).
      const ttlStripped = pingBody !== body;
      const authHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(auth.headers ?? {})) {
        if (typeof value === "string") authHeaders[key] = value;
      }
      // Root-cause fix: replay the request's VERBATIM captured headers
      // (`capture.headers`, from `before_provider_headers` — see `cache-ttl.ts`)
      // and only fill in auth keys that are entirely missing from that capture.
      // No more hand-assembled/hardcoded headers here (see `buildPingRequest`'s
      // doc comment for why that was the actual bug).
      const baseUrl = auth.baseUrl ?? model.baseUrl;
      const { request, headerSource, filledAuthKeys } = buildPingRequest(pingBody, baseUrl, capture.headers, {
        ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
        headers: authHeaders,
      });
      // Diagnostics captured up front (before the network call) so every audit
      // entry below — proven or unproven — carries the same "why did/didn't this
      // ping land" facts, instead of only a bare kind/counter (the original gap
      // that forced session-file archaeology to diagnose the real-environment
      // failure this fix addresses).
      const diagnostics = {
        elapsedSinceCaptureMs: this.clock.now() - capture.capturedAt,
        prefixTokens: capture.prefix.tokens,
        prefixSource: capture.prefix.source,
        headerSource,
        // Key NAMES only — never values, which may carry secrets (auth tokens etc.).
        headerKeyDiff: filledAuthKeys,
        model: model.id,
        baseUrl,
        ...(ttlStripped ? { ttlStripped: true } : {}),
      };

      // Ping retry (user requirement 2026-09-26, docs/dev/cache-ttl-keepalive/plan.md
      // "ping 重试" section): only outcomes that PROVE the server never processed the
      // request (no cache billing possible) are retried — `network` and a fixed set of
      // transient HTTP statuses (`isRetryablePingOutcome`). `accepted-then-lost` and
      // every other unproven kind are final on the first attempt: the server may already
      // have billed a write. Retries until the window's TTL margin runs out, backed off by
      // `PING_RETRY_DELAYS_MS` then a constant 30s; every await return point re-checks `sameEpoch` (I-K8 —
      // covers epoch bump from a real request / invalidate / dispose in one guard) and
      // silently abandons (no proven/unproven counting at all) on mismatch. The whole
      // sequence is also bounded by the window's remaining TTL margin: a retry that
      // would land past `aliveUntil - TTL_SAFETY_MARGIN_MS` is skipped and the LAST
      // outcome is used as final instead.
      let outcome: PingOutcome | undefined;
      let attempts = 0;
      const firstAttemptAt = this.clock.now();
      for (;;) {
        attempts += 1;
        const attemptStartedAt = this.clock.now();
        const controller = new AbortController();
        this.abortController = controller;
        try {
          outcome = await sendKeepalivePing(request, {
            ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
            signal: controller.signal,
          });
        } finally {
          if (this.abortController === controller) this.abortController = undefined;
        }

        // 2026-10-16 field-evidence follow-up: per-attempt wall time (retry-window analysis
        // needs "how long did one attempt take" — the field failures were ~13s attempts that
        // left <2s of the old 45s margin) plus, for `network`, a short sanitized error
        // descriptor (`networkErrorDescriptor` — name/code only, never URLs/headers/bodies).
        this.audit("ping-attempt", {
          attempt: attempts,
          outcomeKind: outcome.kind,
          durationMs: this.clock.now() - attemptStartedAt,
          ...(outcome.kind === "network" && outcome.error !== undefined ? { error: outcome.error } : {}),
        });

        // I-K8: await return point — the one that matters most (§7.5 "abort 与迟到返回").
        if (!this.sameEpoch(pingEpoch)) return;

        if (outcome.kind === "proven-hit" || !isRetryablePingOutcome(outcome)) break;
        if (this.window.aliveUntil === undefined && attempts >= PING_MAX_ATTEMPTS_UNKNOWN_WINDOW) break;

        const delayMs = pingRetryDelayMs(attempts);
        const nowBeforeBackoff = this.clock.now();
        const remainingMs =
          this.window.aliveUntil !== undefined
            ? this.window.aliveUntil - TTL_SAFETY_MARGIN_MS - nowBeforeBackoff
            : undefined;
        if (remainingMs !== undefined && remainingMs < delayMs) {
          // Not enough TTL headroom left for another attempt (req #2) — stop retrying
          // and fall through with this outcome as final; still onUnproven-counted below.
          break;
        }

        await this.sleep(delayMs);
        // I-K8: await return point after the backoff wait.
        if (!this.sameEpoch(pingEpoch)) return;
        // #29 r2: keep the child ping lease alive across a long retry span. A lease already
        // reclaimed by another instance means the slot is no longer ours — stop retrying (never
        // re-acquire) and finalize with the last outcome; charge stays by outcome kind.
        if (lease && !lease.renew(this.clock.now())) break;
      }

      if (outcome.kind === "proven-hit") {
        const applied = onProvenHit(this.window, this.session, pingEpoch, outcome, this.config().intervalMs);
        if (applied.applied) {
          this.window = applied.window;
          this.session = applied.session;
          this.syncExactTimer(); // todo #28: nextPingAt just advanced — reschedule the precise timer.
          // O3: a proven hit IS an observed cache read — reset the route's no-cache-value
          // ledger entry immediately (and mark this session as having seen a hit).
          this.observedCacheRead = true;
          this.deps.evidence?.noteCacheRead(
            capture.fingerprint.provider,
            capture.fingerprint.modelId,
            this.clock.now(),
          );
          this.lastPingDiagnostics = {
            ...diagnostics,
            at: this.clock.now(),
            outcomeKind: outcome.kind,
            cacheReadInputTokens: outcome.cacheReadTokens,
            cacheCreationInputTokens: 0,
            attempts,
          };
          // child-ka-core: charge/report only once the epoch check above has
          // confirmed this result still belongs to the current window.
          chargeUsd = this.budgetChargeForOutcome(outcome, capture, model);
          this.runSpentUsd += chargeUsd;
          const costFields = this.deps.reportCost
            ? {
                costUsd: cacheReadCostUsd(model.cost, outcome.cacheReadTokens),
                ...this.budgetFields(chargeUsd, this.clock.now()),
              }
            : {};
          this.audit("proven-hit", {
            ...diagnostics,
            cacheReadTokens: outcome.cacheReadTokens,
            cacheReadInputTokens: outcome.cacheReadTokens,
            cacheCreationInputTokens: 0,
            attempts,
            ...costFields,
          });
        }
      } else {
        const captureLine = this.window.capture !== undefined ? lineKeyOf(this.window.capture.fingerprint) : undefined;
        const applied = onUnproven(
          this.window,
          this.session,
          pingEpoch,
          outcome.kind,
          this.clock.now(),
          outcome.kind === "http" ? outcome.status : undefined,
        );
        if (applied.applied) {
          this.window = applied.window;
          this.session = applied.session;
          this.syncExactTimer(); // todo #28: window.capture just got cleared — cancels the exact timer.
          const cacheCreationInputTokens = outcome.kind === "proven-write" ? outcome.cacheWriteTokens : undefined;
          // `durationMs` = the whole retry sequence (first attempt send → final outcome); per-attempt
          // times are in the `ping-attempt` entries. `error` = final attempt's sanitized network
          // descriptor (network kind only — see `networkErrorDescriptor`).
          const unprovenDurationMs = this.clock.now() - firstAttemptAt;
          this.lastPingDiagnostics = {
            ...diagnostics,
            at: this.clock.now(),
            outcomeKind: outcome.kind,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens,
            attempts,
            durationMs: unprovenDurationMs,
            ...(outcome.kind === "network" && outcome.error !== undefined ? { error: outcome.error } : {}),
            ...(outcome.kind === "http" ? { httpStatus: sanitizeHttpStatus(outcome.status) } : {}),
          };
          chargeUsd = this.budgetChargeForOutcome(outcome, capture, model);
          this.runSpentUsd += chargeUsd;
          const costFields = this.deps.reportCost
            ? {
                ...(outcome.kind === "proven-write"
                  ? { costUsd: cacheWriteCostUsd(model.cost, outcome.cacheWriteTokens) }
                  : {}),
                ...this.budgetFields(chargeUsd, this.clock.now()),
              }
            : {};
          this.audit("unproven", {
            ...diagnostics,
            unprovenKind: outcome.kind,
            disabled: applied.session.disabled !== undefined,
            lineOpen: countOpenLines(applied.session) > 0,
            ...(captureLine !== undefined ? { lineKey: captureLine.key } : {}),
            ...(outcome.kind === "http" ? { httpStatus: outcome.status } : {}),
            cacheReadInputTokens: 0,
            cacheCreationInputTokens,
            attempts,
            durationMs: unprovenDurationMs,
            ...(outcome.kind === "network" && outcome.error !== undefined ? { error: outcome.error } : {}),
            ...costFields,
          });
        }
      }
      this.publishVisibility();
    } finally {
      if (lease) {
        lease.settle(this.clock.now(), chargeUsd);
        if (this.currentLease === lease) this.currentLease = undefined;
      }
    }
  }

  // -- KeepalivePort --------------------------------------------------------

  noteRequest(captured: CapturedRequest): void {
    if (!this.accept(captured.sessionId, captured.instance)) return;
    // O3: remember the route beyond the capture's own lifetime (dispose-time accounting).
    this.lastRoute = { provider: captured.fingerprint.provider, modelId: captured.fingerprint.modelId };
    this.inflightLine = {
      provider: captured.fingerprint.provider,
      ctxModelId: captured.fingerprint.ctxModelId,
      baseUrl: captured.fingerprint.baseUrl,
    };
    if (this.window.pingInFlight) {
      try {
        this.abortController?.abort();
      } catch {
        // best-effort — sendKeepalivePing never throws regardless.
      }
    }
    const now = this.clock.now();
    const result = onRealRequest(this.window, this.session, captured, now, this.config().intervalMs);
    this.window = result.window;
    this.session = result.session;
    this.lastSkip = undefined;
    if (this.timer === undefined) this.arm();
    this.syncExactTimer();
    this.publishVisibility();
  }

  /** Attribute a settled success to a known line; undefined ⇒ only the wildcard may reset. */
  private resolveSettledLine(route: { provider: string; modelId: string }): LineRef | undefined {
    const inflight = this.inflightLine;
    if (inflight !== undefined) {
      if (inflight.provider === route.provider && inflight.ctxModelId === route.modelId) return lineKeyOf(inflight);
    } else {
      const model = this.safeModel();
      if (model !== undefined && model.provider === route.provider && model.id === route.modelId) {
        return lineKeyOf({ provider: model.provider, ctxModelId: model.id, baseUrl: model.baseUrl });
      }
    }
    const id = `${route.provider}\n${route.modelId}`;
    if (!this.unresolvedAudited.has(id) && this.unresolvedAudited.size < 8) {
      this.unresolvedAudited.add(id);
      this.audit("line-reset-skipped", { reason: "route-unresolved" });
    }
    return undefined;
  }

  noteRequestSettled(
    sessionId: string,
    instance: string,
    successful = false,
    settledRoute?: { provider: string; modelId: string },
    inputTokens?: number,
  ): void {
    if (!this.accept(sessionId, instance)) return;
    const capture = this.window.capture;
    // One in-flight real request per session (same contract as the payload/header pair).
    // Only its own assistant response can supply tier usage; no latest-ledger scan, no prior usage.
    if (
      this.window.requestInFlight &&
      capture !== undefined &&
      settledRoute !== undefined &&
      settledRoute.provider === capture.fingerprint.provider &&
      settledRoute.modelId === capture.fingerprint.ctxModelId &&
      inputTokens !== undefined &&
      Number.isFinite(inputTokens) &&
      inputTokens >= 0
    ) {
      this.windowCap(); // pin the mapping before recomputing against the just-arrived usage
      if (this.capMemo?.capture === capture && this.capMemo.mapped)
        this.capMemo.cap = computeWindowCap(this.capMemo.cost, inputTokens);
    }
    this.window = onRequestSettled(this.window);
    const line = successful && settledRoute !== undefined ? this.resolveSettledLine(settledRoute) : undefined;
    const nextSession = this.deps.recoverTransientFailures
      ? onSuccessfulRealRequest(this.session, successful, { line, now: this.clock.now() })
      : this.session;
    if (nextSession !== this.session) {
      const lineReset = countOpenLines(nextSession) < countOpenLines(this.session);
      this.session = nextSession;
      this.audit(lineReset ? "line-reset" : "real-request-recovered", lineReset ? { lineKey: line?.key ?? "*" } : {});
      if (lineReset) {
        // `line-disabled` is a terminal skip (exact timer cleared, no re-arm) — re-arm now.
        this.lastSkip = undefined;
        this.syncExactTimer();
        if (this.timer === undefined) this.arm();
      }
      this.publishVisibility();
    }
  }

  resetBreakers(): BreakerResetSummary & { evidenceCleared: boolean } {
    if (this.disposed)
      return { sessionDisabled: undefined, openLines: 0, economicCleared: false, evidenceCleared: false };
    const { session, summary } = resetAllBreakers(this.session);
    this.session = session;
    let evidenceCleared = false;
    const route = this.lastRoute ?? this.currentRouteFromModel();
    if (this.deps.evidence !== undefined && route !== undefined && route.provider !== "" && route.modelId !== "") {
      try {
        this.deps.evidence.resetNoCacheValue(route.provider, route.modelId, this.clock.now());
        evidenceCleared = true;
      } catch {
        // best-effort.
      }
    }
    this.lastSkip = undefined;
    this.audit("breaker-reset-manual", { ...summary, evidenceCleared });
    this.syncExactTimer();
    if (this.timer === undefined) this.arm();
    this.publishVisibility();
    return { ...summary, evidenceCleared };
  }

  private currentRouteFromModel(): { provider: string; modelId: string } | undefined {
    const model = this.safeModel();
    return model !== undefined ? { provider: model.provider, modelId: model.id } : undefined;
  }

  invalidate(reason: InvalidateReason, sessionId?: string, instance?: string): void {
    const sid = sessionId ?? this.ownSessionId;
    const inst = instance ?? this.instanceId;
    if (!this.accept(sid, inst)) return;
    this.window = invalidateReducer(this.window, reason);
    this.capMemo = undefined;
    this.syncExactTimer();
  }

  report(): KeepaliveReport {
    const model = this.safeModel();
    return {
      enabled: this.config().enabled,
      armed: this.armed(),
      window: this.window,
      session: this.session,
      config: this.config(),
      costUsd: cacheReadCostUsd(model?.cost, this.session.cacheReadTokens),
      dropped: { ...this.dropped },
      lastSkip: this.lastSkip,
      lastTerminalSkip: this.lastTerminalSkip,
      prefixSource: this.window.capture?.prefix.source,
      supportsLongCacheRetention: this.supportsLongCacheRetention(),
      lastPingDiagnostics: this.lastPingDiagnostics,
      currentLineKey:
        model !== undefined
          ? lineKeyOf({ provider: model.provider, ctxModelId: model.id, baseUrl: model.baseUrl })?.key
          : undefined,
      now: this.clock.now(),
    };
  }

  provenCacheReadAt(): Millis | undefined {
    // `capture === undefined` means the window was invalidated (prefix drift)
    // or stopped by an unproven ping — in both cases an older proven hit is no
    // longer evidence about the CURRENT prefix, so report nothing.
    if (this.window.capture === undefined) return undefined;
    return this.window.lastProvenPingStartedAt;
  }

  setEnabled(on: boolean): void {
    this.enabledOverride = on;
    // todo #28 P1 fix: `config().enabled` is read by `syncExactTimer` itself, so
    // disabling must actively cancel any exact timer already armed for the old
    // `nextPingAt` (it would otherwise still fire once re-enabled lands on a
    // stale instant) and re-enabling must re-arm against the CURRENT window —
    // `syncExactTimer` itself no-ops when the window has since gone stale
    // (`capture === undefined` or `nextPingAt === undefined`).
    if (on) {
      this.syncExactTimer();
    } else {
      this.clearExactTimer();
    }
    this.publishVisibility();
  }

  syncModeState(mode: CacheDisplayMode, dirty: boolean): void {
    this.modeState = { mode, dirty };
    this.publishVisibility();
  }

  // -- armed-signal / drift-event forwarders --------------------------------

  noteToolStart(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools += 1;
    if (this.timer === undefined) this.arm();
  }

  noteToolEnd(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools = Math.max(0, this.activeTools - 1);
  }

  noteUiPromptStart(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    if (this.uiPrompts === 0) this.uiPromptEpisodeStart = this.clock.now();
    this.uiPrompts += 1;
    if (this.timer === undefined) this.arm();
  }

  noteUiPromptEnd(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.uiPrompts = Math.max(0, this.uiPrompts - 1);
    if (this.uiPrompts === 0) this.uiPromptEpisodeStart = undefined;
  }

  noteAgentSettled(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools = 0;
    this.uiPrompts = 0;
    this.uiPromptEpisodeStart = undefined;
  }

  noteUsageCacheRead(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.observedCacheRead = true;
    // O3: the route provably reads cache again — lift a session-local no-cache-value latch
    // immediately ("任一请求观察到 cacheRead>0 立即复位"). Other disable reasons stay sticky.
    if (this.session.disabled?.reason === "no-cache-value") {
      this.session = { ...this.session, disabled: undefined };
      this.audit("no-cache-value-recovered");
      this.publishVisibility();
    }
  }

  // -- lifecycle --------------------------------------------------------------

  /**
   * O3 (provider-evidence breaker): fold this session's outcome into the route's zero-read
   * streak, once per session (`session.noCacheValueCounted` survives /reload via the regular
   * session snapshot, so a rebuilt service never double-counts).
   *
   * Counted only when ALL of:
   *   - the evidence store is wired and the route is known;
   *   - keepalive was actually ACTIVE (`pingAttempts > 0`) — a session with no capture (or one
   *     that never reached a ping) says nothing about the route (「无保活捕获的会话不计入账本」);
   *   - no cache read was ever observed (neither a proven-hit ping nor a real request's usage);
   *   - mode ≠ "off" (user ruling 2026-10-12: mode=off is the user explicitly stripping ttl
   *     intents — cache behaviour on such sessions is treated as already-known, never judged).
   *     Child keepalive services never receive a `syncModeState` call, so their `modeState`
   *     stays at the "auto" default and they remain eligible.
   */
  private accountNoCacheValueSession(): void {
    const store = this.deps.evidence;
    if (!store) return;
    if (this.session.noCacheValueCounted === true) return;
    if (this.pingAttempts === 0 || this.observedCacheRead) return;
    if (this.modeState.mode === "off") return;
    const route = this.lastRoute;
    if (!route || !route.provider || !route.modelId) return;
    this.session = { ...this.session, noCacheValueCounted: true };
    try {
      store.noteZeroReadSession(route.provider, route.modelId, this.clock.now());
      this.audit("no-cache-value-session", { provider: route.provider, modelId: route.modelId });
    } catch {
      // evidence is best-effort — dispose must never throw.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.accountNoCacheValueSession();
    this.disposed = true;
    this.capMemo = undefined;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.clearExactTimer();
    try {
      this.abortController?.abort();
    } catch {
      // best-effort.
    }
    this.abortController = undefined;
    this.cancelPendingRetry();
    if (this.pendingAuthTimeout) {
      const { timer, reject } = this.pendingAuthTimeout;
      this.pendingAuthTimeout = undefined;
      this.clock.clearTimer(timer);
      try {
        reject();
      } catch {
        // best-effort.
      }
    }
    // child-ka-core: defensive backstop — `runPing`'s own `finally` should
    // already have settled this (its abort/reject above ultimately unwinds
    // through the same try/finally), but a lease left held past dispose must
    // never linger and count against the process-wide concurrency cap.
    if (this.currentLease) {
      try {
        this.currentLease.settle(this.clock.now(), 0);
      } catch {
        // best-effort.
      }
      this.currentLease = undefined;
    }
    if (this.deps.statusBar !== false) safeSetStatus(this.deps.ctx, undefined);
  }
}

export function createCacheKeepaliveService(deps: CacheKeepaliveDeps): CacheKeepaliveService {
  return new CacheKeepaliveServiceImpl(deps);
}
