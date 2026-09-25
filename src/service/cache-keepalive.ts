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
  ANTHROPIC_MESSAGES_API,
  ASSUMED_TTL_MS,
  PING_DENY_PROVIDERS,
  TICK_INTERVAL_MS,
  TTL_SAFETY_MARGIN_MS,
  cacheReadCostUsd,
  compareFingerprint,
  consumeUpgrade as consumeUpgradeReducer,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  invalidate as invalidateReducer,
  keepaliveGapHorizonMs,
  keepaliveModeAllowsPing,
  onPingStarted,
  onProvenHit,
  onRealRequest,
  onRequestSettled,
  onUnproven,
  renderCacheStatus,
  readCacheStatusTheme,
  renderKeepaliveReportLines,
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
import { buildPingRequest, preparePingPayload, sendKeepalivePing, type PingOutcome } from "../cache-ttl/ping-client.js";
import type { CacheTtlSettings } from "../config/settings.js";
import type { AdaptiveSnapshot } from "../cache-ttl/adaptive.js";
import type { Millis } from "../core/types.js";

/** pi-free-ish subset of what this module needs from `ctx.model` (structurally satisfied by pi-ai's `Model`). */
interface KeepaliveModelInfo {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  cost?: { cacheRead?: number; tiers?: { inputTokensAbove: number; cacheRead?: number }[] } | undefined;
  /** Anthropic-messages compat flag (pi's own default is `true` when unset). See `report()`'s `supportsLongCacheRetention`. */
  compat?: { supportsLongCacheRetention?: boolean } | undefined;
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
  noteRequestSettled(sessionId: string, instance: string): void;
  invalidate(reason: InvalidateReason, sessionId?: string, instance?: string): void;
  /**
   * plan.md §6.3: consumes the one-shot 1h-upgrade permit if the window has one
   * pending, identity checks pass, and the cache is presumed dead by now.
   * Deliberately does NOT gate on `cacheTtl.mode` — callers must additionally
   * require `mode === "auto"` themselves (I-K5); this keeps the service
   * mode-agnostic.
   */
  consumeUpgrade(sessionId: string, instance: string, now?: number): boolean;
  report(): KeepaliveReport;
  /**
   * D1: start time of the most recent PROVEN cache read in the CURRENT window
   * (`WindowState.lastProvenPingStartedAt`), or `undefined` when nothing has
   * been proven or the window was invalidated / stopped by an unproven ping
   * (both clear `capture`, which is the liveness guard used here).
   *
   * Consumed by the adaptive predictor's warm/cold split so a window kept
   * alive by pings is never mistaken for a dead one. Identity-free on purpose:
   * it reports this instance's own state and the caller (stack wiring) already
   * holds the current instance.
   */
  provenCacheReadAt(): Millis | undefined;
  /**
   * F1 (adaptive verification-2026-09-25): the longest gap this pinger can bridge
   * after a request whose measured prefix is `prefixTokens` (0 when unproven), or
   * `undefined` when it cannot ping that window at all — disabled, session-disabled
   * breaker, headless run mode, non-anthropic / denied route, or a prefix below
   * `keepaliveMinPrefixTokens` (gate #8, review R1).
   *
   * Contract (review rounds 2–3): this is the pinger's capability for the window the
   * NEXT real request opens. Whether that request itself can be replayed — it must be
   * streaming (gate #7.5) — is only known to the caller holding the outgoing payload,
   * so the adaptive caller checks it (R7) and must not ask for a non-streaming one.
   * The per-window ping budget and a single unproven ping are deliberately NOT
   * checked: both reset with that new window; repeated failures trip the session
   * breaker (⇒ `undefined`). Identity-free like `provenCacheReadAt`.
   */
  gapHorizonMs(prefixTokens: number): Millis | undefined;
  setEnabled(on: boolean): void;
  /**
   * plan.md merge note (UI cleanup): `cache-ttl.ts` owns the mode/dirty
   * state (the on/off/auto switch + unsaved-changes flag); this service
   * owns ping/window/session state but renders BOTH into the single merged
   * status key. `cache-ttl.ts` calls this whenever its mode/dirty state
   * changes (and once per `before_provider_request`, so a freshly rebuilt
   * service catches up quickly) so the service's own self-triggered
   * `publishVisibility()` calls (after a ping resolves, etc.) render with
   * the CURRENT mode rather than a stale/default one — this is what keeps
   * the `capped →1h` hint honest (I-K5: only true when mode is `"auto"`).
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
  /**
   * Both services write the one merged status key, so a keepalive-triggered
   * publish must be able to re-render the adaptive segments too — otherwise
   * every ping/window change would blank them until the next request.
   */
  adaptiveSnapshot?: () => AdaptiveSnapshot | undefined;
  /**
   * F1: whether the adaptive predictor's settled 1h entry covers the current
   * prefix (`CacheAdaptiveService.coversPrefix`). Lazily read (adaptive is built
   * after keepalive). Absent / throwing ⇒ false ⇒ pinging is unchanged.
   */
  adaptiveCoversPrefix?: (horizonMs: Millis) => boolean;
  /**
   * task #14: compact-hint's switch-imminent flag. `true` ⇒ the one-shot 1h upgrade after
   * budget exhaustion is skipped (it would rewrite at 2x a prefix the next switch discards).
   * Absent / throwing ⇒ false ⇒ unchanged. Plain pings are never affected.
   */
  switchImminent?: () => boolean;
  appendEntry?: (customType: string, data: unknown) => void;
  emit?: (channel: string, payload: unknown) => void;
}

const AUDIT_CUSTOM_TYPE = "subagent:cache-keepalive";

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
  private abortController: AbortController | undefined;
  private lockedAuthHeaderKeys: string | undefined;
  private activeTools = 0;
  private uiPrompts = 0;
  private window: WindowState = createInitialWindowState();
  private session: SessionTotals = createInitialSessionTotals();
  private dropped = { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 };
  private lastSkip: TickSkipReason | undefined;
  /** See `KeepaliveReport.lastPingDiagnostics`. */
  private lastPingDiagnostics: KeepalivePingDiagnostics | undefined;
  /** Mirrors `cache-ttl.ts`'s mode/dirty closure (see `syncModeState`'s doc comment). "auto" is a safe default: it never renders the `→1h` upgrade hint on its own. */
  private modeState: { mode: CacheDisplayMode; dirty: boolean } = { mode: "auto", dirty: false };

  constructor(private readonly deps: CacheKeepaliveDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ownSessionId = deps.sessionId;
    this.instanceId = `${deps.sessionId}#${this.clock.now()}#${randomUUID().slice(0, 8)}`;
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

  private config(): KeepaliveConfig {
    const s = this.deps.settings;
    return {
      enabled: this.enabledOverride ?? s.keepalive,
      intervalMs: s.keepaliveIntervalMs,
      maxPings: s.keepaliveMaxPings,
      minPrefixTokens: s.keepaliveMinPrefixTokens,
      upgradeAfterBudget: s.keepaliveUpgradeAfterBudget,
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

  /** F1: never let the adaptive port break a tick — absent/throwing ⇒ not covered. */
  private safeAdaptiveCovers(): boolean {
    try {
      return this.deps.adaptiveCoversPrefix?.(keepaliveGapHorizonMs(this.config())) === true;
    } catch {
      return false;
    }
  }

  private armed(): boolean {
    try {
      return this.deps.backgroundBusy() || this.activeTools > 0 || this.uiPrompts > 0;
    } catch {
      return false;
    }
  }

  /**
   * Corrective fix (audit pass, unrelated to the header bug): `false` only
   * when we positively know the model/route rejects `cache_control.ttl:"1h"`
   * (compat flag explicitly `false`) — pi's own default is `true` when the
   * flag is unset, so an absent flag still counts as supported. If `ctx.model`
   * can't be read at all, fall back to `false` (conservative: never promise a
   * `→1h` transition we can't confirm is possible).
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
    safeSetStatus(
      this.deps.ctx,
      renderCacheStatus(
        {
          mode: this.modeState.mode,
          dirty: this.modeState.dirty,
          report: this.report(),
          ...(this.deps.adaptiveSnapshot?.() ? { adaptive: this.deps.adaptiveSnapshot() } : {}),
        },
        readCacheStatusTheme(this.deps.ctx),
      ),
    );
  }

  private audit(kind: string, extra: Record<string, unknown> = {}): void {
    try {
      this.deps.appendEntry?.(AUDIT_CUSTOM_TYPE, {
        kind,
        at: this.clock.now(),
        windowEpoch: this.window.windowEpoch,
        sessionPings: this.session.pings,
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

  // -- timer (UsageBroadcaster self-arming/self-stopping pattern) ---------

  private arm(): void {
    if (this.disposed) return;
    this.timer = this.clock.setTimer(TICK_INTERVAL_MS, () => {
      this.timer = undefined;
      this.onTick();
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
      config: this.config(),
      session: this.session,
      window: this.window,
      currentFingerprint: capture ? this.currentFingerprintFor(capture) : EMPTY_FINGERPRINT,
      adaptiveCovered: this.safeAdaptiveCovers(),
    });
    this.window = result.window;
    switch (result.decision.kind) {
      case "invalidate":
        this.lastSkip = undefined;
        this.audit("invalidate", { reason: result.decision.reason });
        return;
      case "skip":
        this.lastSkip = result.decision.reason;
        if (!result.decision.terminal) this.arm();
        return;
      case "ping": {
        const pingStartedAt = now;
        this.window = onPingStarted(this.window, pingStartedAt);
        const pingEpoch = this.window.windowEpoch;
        this.arm(); // keep ticking while the ping is in flight (plan.md §8.3)
        void this.runPing(pingEpoch, capture!);
        return;
      }
    }
  }

  private async runPing(pingEpoch: number, capture: CapturedRequest): Promise<void> {
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
      auth = await this.deps.ctx.modelRegistry.getApiKeyAndHeaders(model as never);
    } catch {
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
      }
      return;
    }

    // m2: re-check the TTL margin after the (possibly slow) auth await.
    const now = this.clock.now();
    if (this.window.aliveUntil !== undefined && now >= this.window.aliveUntil - TTL_SAFETY_MARGIN_MS) {
      refundBudget();
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    const body = preparePingPayload(capture.payload);
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
    const { request, headerSource, filledAuthKeys } = buildPingRequest(body, baseUrl, capture.headers, {
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
    };
    let outcome: PingOutcome;
    try {
      outcome = await sendKeepalivePing(request, {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        signal: controller.signal,
      });
    } finally {
      if (this.abortController === controller) this.abortController = undefined;
    }

    // I-K8: await return point #2 — the one that matters most (§7.5 "abort 与迟到返回").
    if (!this.sameEpoch(pingEpoch)) return;

    if (outcome.kind === "proven-hit") {
      const applied = onProvenHit(this.window, this.session, pingEpoch, outcome, this.config().intervalMs);
      if (applied.applied) {
        this.window = applied.window;
        this.session = applied.session;
        this.lastPingDiagnostics = {
          ...diagnostics,
          at: this.clock.now(),
          outcomeKind: outcome.kind,
          cacheReadInputTokens: outcome.cacheReadTokens,
          cacheCreationInputTokens: 0,
        };
        this.audit("proven-hit", {
          ...diagnostics,
          cacheReadTokens: outcome.cacheReadTokens,
          cacheReadInputTokens: outcome.cacheReadTokens,
          cacheCreationInputTokens: 0,
        });
      }
    } else {
      const applied = onUnproven(this.window, this.session, pingEpoch, outcome.kind, this.clock.now());
      if (applied.applied) {
        this.window = applied.window;
        this.session = applied.session;
        const cacheCreationInputTokens = outcome.kind === "proven-write" ? outcome.cacheWriteTokens : undefined;
        this.lastPingDiagnostics = {
          ...diagnostics,
          at: this.clock.now(),
          outcomeKind: outcome.kind,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens,
        };
        this.audit("unproven", {
          ...diagnostics,
          unprovenKind: outcome.kind,
          disabled: applied.session.disabled !== undefined,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens,
        });
      }
    }
    this.publishVisibility();
  }

  // -- KeepalivePort --------------------------------------------------------

  noteRequest(captured: CapturedRequest): void {
    if (!this.accept(captured.sessionId, captured.instance)) return;
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
    this.publishVisibility();
  }

  noteRequestSettled(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.window = onRequestSettled(this.window);
  }

  invalidate(reason: InvalidateReason, sessionId?: string, instance?: string): void {
    const sid = sessionId ?? this.ownSessionId;
    const inst = instance ?? this.instanceId;
    if (!this.accept(sid, inst)) return;
    this.window = invalidateReducer(this.window, reason);
  }

  private safeSwitchImminent(): boolean {
    try {
      return this.deps.switchImminent?.() === true;
    } catch {
      return false;
    }
  }

  consumeUpgrade(sessionId: string, instance: string, now?: number): boolean {
    if (!this.accept(sessionId, instance)) return false;
    const result = consumeUpgradeReducer(this.window, {
      sessionMatches: true, // accept() already verified identity above (I-K6/I-K9).
      mode: "auto", // service is mode-agnostic; caller (cache-ttl.ts) enforces I-K5's `mode === "auto"` gate itself.
      upgradeAfterBudgetEnabled: this.config().upgradeAfterBudget,
      now: now ?? this.clock.now(),
      assumedTtlMs: ASSUMED_TTL_MS,
      // Lazy: the predicate reads live context usage (a session projection), and it only
      // matters on the rare request that carries a pending one-shot upgrade.
      switchImminent: this.window.upgradePending && this.safeSwitchImminent(),
    });
    this.window = result.window;
    return result.consumed;
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
      prefixSource: this.window.capture?.prefix.source,
      supportsLongCacheRetention: this.supportsLongCacheRetention(),
      lastPingDiagnostics: this.lastPingDiagnostics,
    };
  }

  provenCacheReadAt(): Millis | undefined {
    // `capture === undefined` means the window was invalidated (prefix drift)
    // or stopped by an unproven ping — in both cases an older proven hit is no
    // longer evidence about the CURRENT prefix, so report nothing.
    if (this.window.capture === undefined) return undefined;
    return this.window.lastProvenPingStartedAt;
  }

  gapHorizonMs(prefixTokens: number): Millis | undefined {
    if (this.disposed) return undefined;
    const config = this.config();
    if (!config.enabled || config.maxPings <= 0) return undefined;
    if (!(prefixTokens >= config.minPrefixTokens)) return undefined;
    if (this.session.disabled !== undefined) return undefined;
    if (!keepaliveModeAllowsPing(this.safeMode())) return undefined;
    let model: KeepaliveModelInfo | undefined;
    try {
      model = this.deps.ctx.model as unknown as KeepaliveModelInfo | undefined;
    } catch {
      return undefined;
    }
    if (model?.api !== ANTHROPIC_MESSAGES_API || PING_DENY_PROVIDERS.has(model.provider)) return undefined;
    // Streamability is judged on the CURRENT request by the caller (review R7): the
    // previous window's capture says nothing about the window the next request opens.
    return keepaliveGapHorizonMs(config);
  }

  setEnabled(on: boolean): void {
    this.enabledOverride = on;
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
    this.uiPrompts += 1;
    if (this.timer === undefined) this.arm();
  }

  noteUiPromptEnd(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.uiPrompts = Math.max(0, this.uiPrompts - 1);
  }

  noteAgentSettled(sessionId: string, instance: string): void {
    if (!this.accept(sessionId, instance)) return;
    this.activeTools = 0;
    this.uiPrompts = 0;
  }

  // -- lifecycle --------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    try {
      this.abortController?.abort();
    } catch {
      // best-effort.
    }
    this.abortController = undefined;
    safeSetStatus(this.deps.ctx, undefined);
  }
}

export function createCacheKeepaliveService(deps: CacheKeepaliveDeps): CacheKeepaliveService {
  return new CacheKeepaliveServiceImpl(deps);
}
