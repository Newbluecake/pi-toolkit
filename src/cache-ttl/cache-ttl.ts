import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  persistSettingOverride,
  type AgentSettings,
  type CacheTtlMode,
  type CacheTtlSettings,
} from "../config/settings.js";
import {
  buildFingerprint,
  inspectPayload,
  renderCacheStatus,
  readCacheStatusTheme,
  renderKeepaliveReportLines,
  isSuccessfulRealRequest,
  realRequestInputTokens,
  realRequestReportedCacheUsage,
  cacheReadCostUsd,
  cacheWriteCostUsd,
  type CacheDisplayMode,
  type CapturedRequest,
  type FingerprintContextInput,
  type KeepaliveCostModel,
  type PrefixEstimate,
} from "./keepalive-state.js";
import { anyLongWriteSince, prefixFromLedger, readLatestAssistantUsage } from "./usage-ledger.js";
import { observeUsageIntoEvidence, type ProviderEvidenceStore } from "./provider-evidence.js";
import { PROBE_TOTAL_TIMEOUT_MS, runCacheProbe, type ProbeResult } from "./probe.js";
import { assessWarmth, MAX_TTL_MS, type CacheWarmth, type WarmthEvidence } from "./warmth.js";
import type { CacheKeepaliveService, KeepalivePort } from "./keepalive-service.js";
import { wireMeasureCommand, type MeasureCommandDeps } from "./measure-command.js";

// Moved to ./usage-ledger.js — re-exported so
// any external importer of this module keeps working.
export { readLatestAssistantCacheTokens } from "./usage-ledger.js";

type RecordValue = Record<string, unknown>;
export interface CacheTtlDeps {
  persist?: (mode: CacheTtlMode) => string | undefined;
  /**
   * holder read-through (plan.md §2.3): `index.ts` passes `() => holder.current?.keepalive`.
   * Typed as the full `CacheKeepaliveService` (a superset of `KeepalivePort`) because
   * `wireCacheEvents` below also needs the armed-signal / drift-event forwarder
   * methods (`noteToolStart`, etc.) that aren't part of the narrower port surface.
   */
  keepalive?: () => CacheKeepaliveService | undefined;
  /**
   * O1/O3/O4 (2026-10-12): the shared provider-route evidence store (`provider-evidence.ts`).
   * Absent ⇒ no evidence gating/recording at all (tests stay hermetic; production wires the
   * process-wide singleton from `src/index.ts`). Read failures inside the store degrade to
   * "no evidence" (the conservative cold judgement), so an absent store is behaviourally the
   * same as an unreadable one.
   */
  evidence?: ProviderEvidenceStore | undefined;
  /** O4: injectable fetch for `/cache-ttl probe` (tests); defaults to `globalThis.fetch`. */
  probeFetch?: typeof fetch | undefined;
  /** Measurement wiring seams; production uses the main-session registry, process claim and agent-dir store. */
  measurement?: MeasureCommandDeps;
}

/**
 * topic-switch plan.md P2 (#12): the read-only cache-warmth judgement surfaced by `wireCacheTtl`'s
 * return value. `assess` never throws — any failure while gathering evidence (a stale/degraded
 * `ctx`, a `sessionManager` that throws, etc.) degrades to `{state:"unknown", reason:"read-error"}`.
 */
export interface CacheWarmthPort {
  assess(ctx: ExtensionContext, now: number, opts: { slackMs: number; ttlOverrideMs?: number }): CacheWarmth;
}

/** `wireCacheTtl`'s return value (plan.md P2 #12; was `void`, line 321 pre-change). */
export interface CacheTtlWiring {
  readonly warmth: CacheWarmthPort;
  /** Read-only snapshot of the authoritative display mode / dirty flag (web-hub keepalive panel, D7). */
  status(): { mode: CacheDisplayMode; dirty: boolean };
}

/**
 * The last payload shape this module itself sent on the current session, written at the end of
 * `before_provider_request` (plan.md P2): `ttl1h` is true when we forced 1h or the payload already
 * carried it; `cached` reflects whether the payload had any ephemeral cache_control breakpoint at
 * all. Reset to `undefined` on every `session_start` (new session / resume never inherits a prior
 * session's lastSent) and filtered by `sessionId` on read (never trusted across sessions).
 */
interface LastSent {
  at: number;
  sessionId: string;
  provider: string;
  modelId: string;
  ttl1h: boolean;
  cached: boolean;
}

/**
 * Builds the `CacheWarmthPort` from the live closures `wireCacheTtl` owns (mode, lastSent,
 * keepalive holder read-throughs — re-fetched on every `assess` call so a stack rebuild
 * after this port was handed out is picked up automatically, plan.md P2).
 */
function createWarmthPort(
  deps: CacheTtlDeps,
  getMode: () => CacheTtlMode,
  getLastSent: () => LastSent | undefined,
): CacheWarmthPort {
  return {
    assess(ctx, now, opts) {
      try {
        const model = ctx?.model as { api?: string; provider?: string; id?: string } | undefined;
        const route = { api: model?.api ?? "", provider: model?.provider ?? "", modelId: model?.id ?? "" };
        const sessionId = readSessionId(ctx);
        const store = deps.evidence;

        const ledgerUsage = readLatestAssistantUsage(ctx);
        const ledger: WarmthEvidence["ledger"] =
          ledgerUsage.source === "usage"
            ? {
                ...(ledgerUsage.at !== undefined ? { at: ledgerUsage.at } : {}),
                ...(ledgerUsage.providerId !== undefined ? { provider: ledgerUsage.providerId } : {}),
                modelId: ledgerUsage.modelId,
                cacheRead: ledgerUsage.cacheRead,
                cacheWrite: ledgerUsage.cacheWrite,
                ...(ledgerUsage.cacheWrite1h !== undefined ? { cacheWrite1h: ledgerUsage.cacheWrite1h } : {}),
              }
            : undefined;

        // O1: a `cacheWrite1h > 0` observation IS landing evidence — record it on sight so the
        // 30d rolling record survives this entry scrolling out of the session ledger. Mode-
        // independent on purpose (user ruling 2026-10-12): mode=off stops OUR ttl intents, it
        // doesn't make an observed fact less true.
        if (store && ledgerUsage.source === "usage" && (ledgerUsage.cacheWrite1h ?? 0) > 0) {
          store.noteWrite1hLanded(
            ledgerUsage.providerId ?? route.provider,
            ledgerUsage.modelId !== "" ? ledgerUsage.modelId : route.modelId,
            now,
          );
        }

        const sent = getLastSent();
        const lastSentEvidence: WarmthEvidence["lastSent"] =
          sent && sent.sessionId === sessionId
            ? { at: sent.at, provider: sent.provider, modelId: sent.modelId, ttl1h: sent.ttl1h, cached: sent.cached }
            : undefined;

        const port = deps.keepalive?.();
        const report = port?.report();
        const provenReadAt = port?.provenCacheReadAt();
        const keepalive: NonNullable<WarmthEvidence["keepalive"]> = {
          ...(provenReadAt !== undefined ? { provenReadAt } : {}),
          ...(report?.window.lastReadStartedAt !== undefined
            ? { lastReadStartedAt: report.window.lastReadStartedAt }
            : {}),
          ...(report?.window.pingStartedAt !== undefined ? { pingStartedAt: report.window.pingStartedAt } : {}),
          pingInFlight: report?.window.pingInFlight ?? false,
          pingScheduled: (report?.armed ?? false) && report?.window.nextPingAt !== undefined,
        };

        const recent1hWrite = anyLongWriteSince(ctx, now - MAX_TTL_MS);
        // O1: `recent1hWrite === true` is also landing evidence — but `anyLongWriteSince` scans
        // entries without route attribution, so only record it when the latest entry is anchored
        // to the CURRENT route (otherwise the sighting could belong to a previous model's route).
        if (
          store &&
          recent1hWrite === true &&
          ledger !== undefined &&
          ledger.modelId === route.modelId &&
          (ledger.provider === undefined || ledger.provider === route.provider)
        ) {
          store.noteWrite1hLanded(route.provider, route.modelId, now);
        }

        const evidence: WarmthEvidence = {
          now,
          route,
          ledger,
          ...(lastSentEvidence !== undefined ? { lastSent: lastSentEvidence } : {}),
          keepalive,
          recent1hWrite,
          write1hEvidence: store?.hasWrite1hEvidence(route.provider, route.modelId, now) ?? false,
          mode: getMode(),
          slackMs: opts.slackMs,
          ...(opts.ttlOverrideMs !== undefined ? { ttlOverrideMs: opts.ttlOverrideMs } : {}),
        };
        return assessWarmth(evidence);
      } catch {
        return { state: "unknown", reason: "read-error" };
      }
    },
  };
}

const MODE_LABEL: Record<CacheTtlMode, string> = {
  auto: "auto (follow PI_CACHE_RETENTION)",
  on: "on (force 1h)",
  off: "off (provider default 5m)",
};

/** O4: race an auth-resolution promise against a bounded, unref'd timeout (never leaves a dangling timer). */
function withTimeoutMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** O4: render the probe verdict lines (and the M5-compliant cost line) for `/cache-ttl probe`. */
function renderProbeReport(
  model: { provider?: string; id?: string; cost?: KeepaliveCostModel | undefined },
  result: ProbeResult,
): string {
  const lines: string[] = [];
  lines.push(`probe ${model.provider ?? "?"}/${model.id ?? "?"} — ${result.requests} request(s) sent (real billing)`);
  if (result.requests > 0) {
    lines.push(
      `cache write (5m): ${result.cacheAlive ? `alive (${result.tokens.write5m} tok written)` : "DEAD — provider registered no cache write"}`,
    );
  }
  if (result.phases.reread.outcome === "usage") {
    lines.push(
      `immediate re-read: ${result.immediateHit ? `hit (${result.tokens.read} tok)` : "MISS — the 5m namespace does not read back"}`,
    );
  }
  if (result.phases.write1h.outcome === "usage") {
    lines.push(
      result.write1hLanded
        ? `1h landing: yes (${result.tokens.write1h} tok into the 1h namespace)`
        : `1h landing: NO — ttl:"1h" accepted but ephemeral_1h_input_tokens stayed 0 (collapsed to 5m)`,
    );
  }
  if (result.error !== undefined) lines.push(`stopped early: ${result.error}`);

  // M5: never print "$0" for an unknown rate — if any billed piece has no price, the whole
  // probe's cost is "unknown".
  const billed: { tokens: number; rate: number | undefined }[] = [
    { tokens: result.phases.write.usage?.cacheWrite ?? 0, rate: cacheWriteCostUsd(model.cost, 1) },
    { tokens: result.phases.reread.usage?.cacheRead ?? 0, rate: cacheReadCostUsd(model.cost, 1) },
    { tokens: result.phases.write1h.usage?.cacheWrite ?? 0, rate: cacheWriteCostUsd(model.cost, 1) },
  ];
  const unknownCost = billed.some((piece) => piece.tokens > 0 && piece.rate === undefined);
  if (unknownCost) {
    lines.push("cost: unknown (model has no cache rate data)");
  } else {
    const total =
      (cacheWriteCostUsd(model.cost, result.phases.write.usage?.cacheWrite ?? 0) ?? 0) +
      (cacheReadCostUsd(model.cost, result.phases.reread.usage?.cacheRead ?? 0) ?? 0) +
      (cacheWriteCostUsd(model.cost, result.phases.write1h.usage?.cacheWrite ?? 0) ?? 0);
    lines.push(`cost: ≈$${total.toFixed(4)} (estimated; 1h writes priced at the 5m write rate)`);
  }
  lines.push(
    "evidence: recorded to the provider-evidence store (30d rolling; drives warmth 1h horizon + ping ttl gating)",
  );
  return lines.join("\n");
}

/** O4: `/cache-ttl probe` — three real requests against the current route; see probe.ts. */
async function runProbeCommand(ctx: ExtensionContext, deps: CacheTtlDeps): Promise<void> {
  const notify = (message: string, level: "info" | "warning" | "error"): void => {
    try {
      ctx.ui.notify(message, level);
    } catch {
      // stale ctx — never let the probe report break anything.
    }
  };
  const model = ctx?.model as
    | { api?: string; provider?: string; id?: string; baseUrl?: string; cost?: KeepaliveCostModel | undefined }
    | undefined;
  if (!model || typeof model.id !== "string" || model.id === "") {
    notify("probe: no active model in this session", "warning");
    return;
  }
  if (model.api !== "anthropic-messages") {
    notify(
      `probe: only anthropic-messages routes carry cache_control semantics (current api: ${model.api ?? "unknown"}) — nothing sent`,
      "warning",
    );
    return;
  }
  let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>> | undefined;
  try {
    auth = await withTimeoutMs(ctx.modelRegistry.getApiKeyAndHeaders(model as never), 10_000);
  } catch {
    auth = undefined;
  }
  if (!auth || !auth.ok) {
    notify("probe: auth resolution failed — nothing sent", "error");
    return;
  }
  const baseUrl = auth.baseUrl ?? model.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl === "") {
    notify("probe: this model has no baseUrl — nothing sent", "error");
    return;
  }
  // ProviderHeaders values may be `null` (header deletion markers in pi's contract) — only
  // string values can go on the wire.
  const authHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") authHeaders[key] = value;
  }
  notify(
    `probing ${model.provider ?? "?"}/${model.id} — up to 3 REAL billed requests, ${Math.round(PROBE_TOTAL_TIMEOUT_MS / 1000)}s budget…`,
    "info",
  );
  const result = await runCacheProbe({
    baseUrl,
    model: model.id,
    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
    authHeaders,
    ...(deps.probeFetch !== undefined ? { fetchImpl: deps.probeFetch } : {}),
  });
  // Write the verdict back into the shared evidence store (O1/O2/O3's evidence source):
  // a landed 1h write refreshes the 30d record, an immediate hit resets the no-cache-value
  // breaker (provider-evidence.ts's noteProbe does both folds).
  const store = deps.evidence;
  if (store && result.requests > 0) {
    store.noteProbe(
      model.provider ?? "",
      model.id,
      { cacheAlive: result.cacheAlive, immediateHit: result.immediateHit, write1hLanded: result.write1hLanded },
      Date.now(),
    );
  }
  notify(renderProbeReport(model, result), result.ok ? "info" : "warning");
}

function isObjectRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Single writer of the merged status key from this module's side (the other
 * writer is `cache-keepalive.ts`'s own `publishVisibility()`, driven by ping/
 * window/session changes) — both go through `renderCacheStatus` so the text
 * format never disagrees, only the timing does (last-writer-wins on a fresh
 * render, not a stale cached string). Also syncs the service's `modeState`
 * mirror so its OWN self-triggered renders stay accurate between calls here.
 */
function updateStatus(ctx: ExtensionContext, mode: CacheTtlMode, dirty: boolean, deps: CacheTtlDeps): void {
  const port = deps.keepalive?.();
  port?.syncModeState(mode, dirty);
  if (!ctx?.ui || typeof ctx.ui.setStatus !== "function") return;
  ctx.ui.setStatus("cache-ttl", renderCacheStatus({ mode, dirty, report: port?.report() }, readCacheStatusTheme(ctx)));
}

/** The action the current request needs — "force-1h" writes ttl, "strip-ttl" deletes it, "passthrough" never reaches here. */
type RewriteAction = "force-1h" | "strip-ttl";

function rewrite(node: unknown, action: RewriteAction, seen: WeakSet<object>): void {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) rewrite(item, action, seen);
    return;
  }
  const object = node as RecordValue;
  const control = object.cache_control;
  if (isObjectRecord(control) && control.type === "ephemeral") {
    if (action === "force-1h") control.ttl = "1h";
    else delete control.ttl;
  }
  for (const value of Object.values(object)) rewrite(value, action, seen);
}

/** try/catch read of the current session id (I-K6): a stale/degraded host returns "" rather than throwing. */
function readSessionId(ctx: ExtensionContext): string {
  try {
    return (ctx?.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * plan.md §3.4 (M3): only an actually-measured lower bound counts. The reader
 * itself now lives in ./usage-ledger.js (re-exported above) — the same official
 * ledger the HUD footer reads (`src/hud/footer.ts`), never an estimate.
 */

function buildFingerprintContext(ctx: ExtensionContext, sessionId: string): FingerprintContextInput {
  const model = ctx?.model as { provider?: string; api?: string; id?: string; baseUrl?: string } | undefined;
  return {
    sessionId,
    provider: model?.provider ?? "",
    api: model?.api ?? "",
    ctxModelId: model?.id ?? "",
    baseUrl: model?.baseUrl ?? "",
    // INERT (capture-pairing-plan r7 §3.4): always "" on both the capture and the service's tick-time side.
    authHeaderKeys: "",
  };
}

/**
 * Builds the `CapturedRequest` for one `before_provider_request` (P). Payload-only capture (capture-pairing-plan
 * r7 §3.1): the request headers are not captured — pings replay through pi's own provider pipeline, which resolves
 * auth and headers itself. Exported (child-ka-core, plan.md §2.4) so `src/cache-ttl/child.ts` reuses the identical
 * shape.
 */
export function captureRequest(
  payload: RecordValue,
  ctx: ExtensionContext,
  sessionId: string,
  port: KeepalivePort,
  prefix: PrefixEstimate,
): CapturedRequest {
  return {
    sessionId,
    instance: port.instanceId,
    payload,
    fingerprint: buildFingerprint(payload, buildFingerprintContext(ctx, sessionId)),
    shape: inspectPayload(payload),
    prefix,
    capturedAt: Date.now(),
  };
}

/** Status-only migration: presence, including invalid/zero, NEVER affects the cap or switch. */
export function legacyCapNote(settings: CacheTtlSettings): string | undefined {
  const value = settings.legacyKeepaliveMaxPings;
  if (value === undefined) return undefined;
  return `note: cacheTtl.keepaliveMaxPings is deprecated and ignored — the per-window cap now comes from the model's cache prices; use "cacheTtl.keepalive": false to turn keepalive off, and remove the old key\nlegacy value: ${value === "invalid" ? "(invalid)" : value}`;
}

/** Route (provider + model id) of a settled assistant message; undefined when either is missing. */
export function settledRouteOf(message: unknown): { provider: string; modelId: string } | undefined {
  const m = message as { provider?: unknown; model?: unknown } | null | undefined;
  return typeof m?.provider === "string" && m.provider !== "" && typeof m.model === "string" && m.model !== ""
    ? { provider: m.provider, modelId: m.model }
    : undefined;
}

/**
 * plan.md §4: activate-level forwarders for the armed signals (tool/ui-prompt
 * in-flight) and drift-invalidation events. All go through the service's
 * `accept()` identity guard (I-K6/I-K9), so a stale holder read or a
 * cross-session leftover is a silent no-op.
 *
 * M2 fix: this state-semantics wiring used to live in `src/index.ts` (assembly-
 * only per AGENTS.md); moved here verbatim (no behavior change) so the pi-facing
 * cache-ttl module owns it end to end — `index.ts` now only calls `wireCacheTtl`.
 */
function wireCacheEvents(pi: ExtensionAPI, deps: CacheTtlDeps): void {
  pi.on("tool_execution_start", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteToolStart(sessionId, ka.instanceId);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteToolEnd(sessionId, ka.instanceId);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteUiPromptStart(sessionId, ka.instanceId);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteUiPromptEnd(sessionId, ka.instanceId);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) {
      ka.noteAgentSettled(sessionId, ka.instanceId);
      ka.noteRequestSettled(sessionId, ka.instanceId);
    }
  });
  pi.on("message_end", (event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka)
      ka.noteRequestSettled(
        sessionId,
        ka.instanceId,
        isSuccessfulRealRequest(event.message),
        settledRouteOf(event.message),
        realRequestInputTokens(event.message),
        realRequestReportedCacheUsage(event.message),
      );
    // O1/O3 evidence observation (mode-independent, user ruling 2026-10-12 — see
    // `observeUsageIntoEvidence`'s doc comment): fold this message's usage into the provider-
    // route evidence store, and forward a cache-read sighting to the keepalive service so its
    // end-of-session O3 accounting knows this session DID see cache hits.
    const store = deps.evidence;
    if (store) {
      const model = ctx?.model as { provider?: string; id?: string } | undefined;
      const observed = observeUsageIntoEvidence(
        ctx,
        { provider: model?.provider ?? "", modelId: model?.id ?? "" },
        store,
        Date.now(),
      );
      if (observed.cacheReadObserved && ka) ka.noteUsageCacheRead(sessionId, ka.instanceId);
    }
  });
  pi.on("turn_end", (event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka)
      ka.noteRequestSettled(
        sessionId,
        ka.instanceId,
        isSuccessfulRealRequest(event.message),
        settledRouteOf(event.message),
        realRequestInputTokens(event.message),
        realRequestReportedCacheUsage(event.message),
      );
  });
  pi.on("agent_end", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteRequestSettled(sessionId, ka.instanceId);
  });
  const invalidateKeepalive = (reason: Parameters<CacheKeepaliveService["invalidate"]>[0], ctx: ExtensionContext) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.invalidate(reason, sessionId, ka.instanceId);
  };
  pi.on("model_select", (_event, ctx) => invalidateKeepalive("model-select", ctx));
  pi.on("thinking_level_select", (_event, ctx) => invalidateKeepalive("thinking-level-select", ctx));
  pi.on("session_compact", (_event, ctx) => invalidateKeepalive("session-compact", ctx));
  pi.on("session_compact_failed", (_event, ctx) => invalidateKeepalive("session-compact-failed", ctx));
  pi.on("session_tree", (_event, ctx) => invalidateKeepalive("session-tree", ctx));
  pi.on("resources_discover", (_event, ctx) => {
    invalidateKeepalive("resources-changed", ctx);
    return undefined;
  });
  pi.on("session_info_changed", (_event, ctx) => invalidateKeepalive("session-changed", ctx));
}

export function wireCacheTtl(pi: ExtensionAPI, settings: AgentSettings, deps: CacheTtlDeps = {}): CacheTtlWiring {
  let mode = settings.cacheTtl.mode;
  let persisted = mode;
  let dirty = false;
  const persist = deps.persist ?? ((value) => persistSettingOverride("cacheTtl.mode", value));
  let lastSent: LastSent | undefined;

  wireCacheEvents(pi, deps);
  const measurement = wireMeasureCommand(pi, deps.measurement);

  pi.on("session_start", async (_event, ctx) => {
    lastSent = undefined;
    updateStatus(ctx, mode, dirty, deps);
  });
  pi.on("before_provider_request", (event, ctx) => {
    const port = deps.keepalive?.();
    port?.syncModeState(mode, dirty);
    const sessionId = readSessionId(ctx);
    if (!isObjectRecord(event.payload) || !Array.isArray(event.payload.messages)) {
      port?.invalidate("payload-shape", sessionId, port.instanceId);
      return undefined;
    }
    const ledger = readLatestAssistantUsage(ctx);
    const shape = inspectPayload(event.payload);
    const action: RewriteAction | "passthrough" =
      mode === "on" ? "force-1h" : mode === "off" ? "strip-ttl" : "passthrough";

    // topic-switch plan.md P2: write lastSent once the payload shape check has passed and `action`
    // is known — every return below this point (passthrough, clone-failed, rewritten) carries it.
    {
      const model = ctx?.model as { provider?: string; id?: string } | undefined;
      lastSent = {
        at: Date.now(),
        sessionId,
        provider: model?.provider ?? "",
        modelId: model?.id ?? "",
        ttl1h: action === "force-1h" || shape.ttl1h,
        cached: shape.ephemeralBreakpoints > 0,
      };
    }

    if (action === "passthrough") {
      // auto: never rewrite the payload — but still capture
      // a private clone for the keepalive replay (pi reuses `event.payload` for
      // `{...params, stream:true}` downstream, so holding onto the live object
      // for minutes is a risk, plan.md §3.1).
      if (port) {
        let cloned: unknown;
        try {
          cloned = structuredClone(event.payload);
        } catch {
          port.invalidate("clone-failed", sessionId, port.instanceId);
          return undefined;
        }
        // Payload-only capture, committed immediately (a strict-tools P′ replaces it).
        port.noteRequest(captureRequest(cloned as RecordValue, ctx, sessionId, port, prefixFromLedger(ledger)));
      }
      return undefined;
    }

    let cloned: unknown;
    try {
      cloned = structuredClone(event.payload);
    } catch (error) {
      console.warn(
        `[pi-subagent] failed to clone provider payload for cache TTL: ${error instanceof Error ? error.message : String(error)}`,
      );
      port?.invalidate("clone-failed", sessionId, port.instanceId);
      return undefined;
    }
    rewrite(cloned, action, new WeakSet<object>());
    // Capture AFTER the rewrite (order is load-bearing): `inspectPayload(cloned)`
    // reflects the bytes actually sent, which is how keepalive gate #7 sees the
    // 1h write and suspends pinging for this window.
    if (port) port.noteRequest(captureRequest(cloned as RecordValue, ctx, sessionId, port, prefixFromLedger(ledger)));
    return cloned as RecordValue;
  });
  const USAGE =
    "usage: /cache-ttl on | off | auto | save | keepalive on|off|reset | status | probe | measure [<provider>/<id>] [--long] [--estimate] [--yes] | measure status|cancel";
  pi.registerCommand("cache-ttl", {
    description: "Prompt-cache TTL: /cache-ttl [on|off|auto|save|keepalive on|off|reset|status|probe|measure]",
    getArgumentCompletions: (argumentPrefix: string) => {
      try {
        const a = (argumentPrefix ?? "").trimStart();
        const tokens = a.split(/\s+/).filter(Boolean);
        const partial = a.endsWith(" ") || a === "" ? "" : (tokens[tokens.length - 1] ?? "");
        if (tokens[0]?.toLowerCase() === "measure" && (tokens.length > 1 || /\s$/.test(a)))
          return measurement.completions(a);
        if (tokens[0] === "keepalive" && (tokens.length > 1 || a.endsWith(" "))) {
          return ["on", "off", "reset"]
            .filter((v) => v.startsWith(partial))
            .map((v) => ({ value: `keepalive ${v}`, label: v, description: "keepalive " + v }));
        }
        return [
          { value: "on", label: "on", description: "强制 1h TTL" },
          { value: "off", label: "off", description: "关闭 TTL 覆写" },
          { value: "auto", label: "auto", description: "自动模式" },
          { value: "save", label: "save", description: "持久化当前模式" },
          { value: "keepalive", label: "keepalive", description: "保活开关（on|off|reset）" },
          { value: "status", label: "status", description: "查看保活状态" },
          { value: "probe", label: "probe", description: "线路体检（≤3 个真实计费请求，30s 预算）" },
          { value: "measure", label: "measure", description: "测量缓存 TTL 与读取续期（最多 17 个真实计费请求）" },
        ].filter((item) => item.value.startsWith(partial));
      } catch {
        return [];
      }
    },
    handler: async (args, ctx) => {
      // Measure model refs are case-sensitive; branch BEFORE the legacy lowercasing.
      if (args.trim().split(/\s+/)[0]?.toLowerCase() === "measure") {
        await measurement.handle(args, ctx);
        return;
      }
      const arg = args.trim().toLowerCase();
      const [head, ...rest] = arg.split(/\s+/).filter(Boolean);

      // O4: route health probe — sends up to 3 REAL billed requests against the current route.
      if (head === "probe") {
        await runProbeCommand(ctx, deps);
        return;
      }

      if (head === "keepalive") {
        const port = deps.keepalive?.();
        const sub = rest[0];
        if (sub === "on" || sub === "off") {
          if (!port) {
            ctx.ui.notify("keepalive service unavailable (no active session, or cacheTtl.keepalive=false)", "warning");
            return;
          }
          port.setEnabled(sub === "on");
          ctx.ui.notify(`keepalive switched to ${sub} (current process only)`, "info");
        } else if (sub === "reset") {
          if (!port) {
            ctx.ui.notify("keepalive service unavailable (no active session, or cacheTtl.keepalive=false)", "warning");
            return;
          }
          const r = port.resetBreakers();
          const parts: string[] = [];
          if (r.sessionDisabled !== undefined) parts.push(`session-disabled(${r.sessionDisabled})`);
          if (r.openLines > 0) parts.push(`${r.openLines} line breaker(s)`);
          if (r.economicCleared) parts.push("proven-write cleared");
          if (r.evidenceCleared) parts.push("evidence(no-cache-value, current line only)");
          if (parts.length === 0) {
            ctx.ui.notify("keepalive reset: nothing to clear (no breaker open)", "info");
          } else {
            parts.splice(parts.length - (r.evidenceCleared ? 1 : 0), 0, "counters zeroed");
            let text = `keepalive reset: cleared ${parts.join(" · ")} · resumes on next real request`;
            if (r.economicCleared) {
              text +=
                "\n注意：已手动清除经济类熔断（proven-write）。若该线路 ping 仍会触发缓存写入，下一次写入会再次熔断该线路保活（该线路下一次真实请求成功或切换模型后恢复）。";
            }
            ctx.ui.notify(text, "info");
          }
        } else {
          ctx.ui.notify("usage: /cache-ttl keepalive on|off|reset", "warning");
        }
        return;
      }

      if (head === "status") {
        const port = deps.keepalive?.();
        const lines: string[] = [];
        if (port) lines.push(...renderKeepaliveReportLines(port.report()));
        if (lines.length === 0)
          lines.push("keepalive service unavailable (no active session, or cacheTtl.keepalive=false)");
        const measurementLine = await measurement.statusLine(ctx);
        if (measurementLine === undefined) return; // session changed while the bounded status read was pending
        lines.push(measurementLine);
        const note = legacyCapNote(settings.cacheTtl);
        if (note !== undefined) lines.push(note);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (arg === "on" || arg === "off" || arg === "auto") {
        mode = arg;
        dirty = mode !== persisted;
        updateStatus(ctx, mode, dirty, deps);
        ctx.ui.notify(
          `cache TTL switched to: ${MODE_LABEL[mode]} (current process only; /cache-ttl save to persist)`,
          "info",
        );
      } else if (arg === "save") {
        if (!dirty) {
          ctx.ui.notify("no unsaved changes", "info");
          return;
        }
        const error = persist(mode);
        if (error) {
          ctx.ui.notify(`cache TTL persist failed: ${error}`, "error");
          return;
        }
        persisted = mode;
        dirty = false;
        updateStatus(ctx, mode, false, deps);
        ctx.ui.notify(`cache TTL persisted as ${MODE_LABEL[mode]}`, "info");
      } else if (arg === "") {
        const saved = dirty ? `\npersisted mode: ${MODE_LABEL[persisted]}` : "";
        ctx.ui.notify(`current cache TTL mode: ${MODE_LABEL[mode]}${dirty ? "*" : ""}${saved}\n${USAGE}`, "info");
      } else {
        ctx.ui.notify(`invalid argument "${arg}", ${USAGE}`, "warning");
      }
    },
  });

  return {
    warmth: createWarmthPort(
      deps,
      () => mode,
      () => lastSent,
    ),
    status: () => ({ mode, dirty }),
  };
}
