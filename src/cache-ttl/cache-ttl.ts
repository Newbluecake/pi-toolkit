import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  defaultSettingsPath,
  persistSettingOverride,
  type AgentSettings,
  type CacheTtlMode,
} from "../config/settings.js";
import {
  buildFingerprint,
  inspectPayload,
  payloadLineageKey,
  renderAdaptiveReportLines,
  renderCacheStatus,
  readCacheStatusTheme,
  renderKeepaliveReportLines,
  isSuccessfulRealRequest,
  type CapturedRequest,
  type FingerprintContextInput,
  type PrefixEstimate,
} from "./keepalive-state.js";
import { anyLongWriteSince, prefixFromLedger, readLatestAssistantUsage } from "./usage-ledger.js";
import { assessWarmth, MAX_TTL_MS, type CacheWarmth, type WarmthEvidence } from "./warmth.js";
import type { AdaptiveDecision } from "./adaptive.js";
import type { CacheAdaptiveService } from "../service/cache-adaptive.js";
import type { CacheKeepaliveService, KeepalivePort } from "../service/cache-keepalive.js";

// Moved to ./usage-ledger.js (adaptive plan.md §10.1 step 1) — re-exported so
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
   * adaptive plan.md §9.3: holder read-through for the adaptive service, same
   * pattern as `keepalive`. Absent ⇒ adaptive mode behaves exactly like auto
   * (passthrough; I-A1), so the extension still works before the stack wiring lands.
   */
  adaptive?: () => CacheAdaptiveService | undefined;
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
 * keepalive/adaptive holder read-throughs — re-fetched on every `assess` call so a stack rebuild
 * after this port was handed out is picked up automatically, plan.md P2).
 */
function createWarmthPort(
  deps: CacheTtlDeps,
  getAdaptive: () => CacheAdaptiveService | undefined,
  getMode: () => CacheTtlMode,
  getLastSent: () => LastSent | undefined,
): CacheWarmthPort {
  return {
    assess(ctx, now, opts) {
      try {
        const model = ctx?.model as { api?: string; provider?: string; id?: string } | undefined;
        const route = { api: model?.api ?? "", provider: model?.provider ?? "", modelId: model?.id ?? "" };
        const sessionId = readSessionId(ctx);

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

        const adaptiveSvc = getAdaptive();
        const adaptiveSnapshot = adaptiveSvc?.snapshot();
        const adaptive: NonNullable<WarmthEvidence["adaptive"]> = {
          covers: adaptiveSvc?.coversPrefix(0) ?? false,
          any1hWrites: adaptiveSnapshot
            ? adaptiveSnapshot.confirmed1hWrites + adaptiveSnapshot.unconfirmed1hWrites > 0
            : false,
        };

        const recent1hWrite = anyLongWriteSince(ctx, now - MAX_TTL_MS);

        const evidence: WarmthEvidence = {
          now,
          route,
          ledger,
          ...(lastSentEvidence !== undefined ? { lastSent: lastSentEvidence } : {}),
          keepalive,
          adaptive,
          recent1hWrite,
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
  adaptive: "adaptive (predict 1h before long gaps)",
};

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
function updateStatus(
  ctx: ExtensionContext,
  mode: CacheTtlMode,
  dirty: boolean,
  deps: CacheTtlDeps,
  getAdaptive: () => CacheAdaptiveService | undefined,
): void {
  const port = deps.keepalive?.();
  port?.syncModeState(mode, dirty);
  if (!ctx?.ui || typeof ctx.ui.setStatus !== "function") return;
  ctx.ui.setStatus(
    "cache-ttl",
    renderCacheStatus(
      { mode, dirty, report: port?.report(), adaptive: getAdaptive()?.snapshot() },
      readCacheStatusTheme(ctx),
    ),
  );
}

/** adaptive plan.md §10.2: the action the current request needs — "force-1h" writes ttl, "strip-ttl" deletes it, "passthrough" never reaches here. */
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
    // Locked in by the service after the first ping resolves real auth (plan.md §3.3) — capture-time is always "".
    authHeaderKeys: "",
  };
}

/**
 * The `headers` field is deliberately absent here — it isn't known yet at
 * `before_provider_request` time (see `RequestCapture` below). Callers must
 * only turn this into a real `CapturedRequest` once the paired
 * `before_provider_headers` snapshot has arrived. Exported (child-ka-core,
 * plan.md §2.4) so `src/cache-ttl/child.ts` (a later package) can reuse the
 * identical shape.
 */
export type CapturedRequestBase = Omit<CapturedRequest, "headers">;

/** Exported (child-ka-core, plan.md §2.4) for reuse by the future child-session capture wiring — see `CapturedRequestBase`'s doc comment. */
export function captureRequest(
  payload: RecordValue,
  ctx: ExtensionContext,
  sessionId: string,
  port: KeepalivePort,
  prefix: PrefixEstimate,
): CapturedRequestBase {
  return {
    sessionId,
    instance: port.instanceId,
    payload,
    fingerprint: buildFingerprint(payload, buildFingerprintContext(ctx, sessionId)),
    shape: inspectPayload(payload),
    // adaptive plan.md §3.1 step 5/9: derived from the one ledger read the
    // caller already did for the adaptive decision — no second scan.
    prefix,
    capturedAt: Date.now(),
  };
}

/**
 * Pairing state for the two-hook capture (root-cause fix, plan.md §7.3
 * follow-up; extracted into a reusable helper for child-ka-core, plan.md
 * §2.4 — "capture helper 抽取"): `before_provider_request` fires first and
 * knows the payload; `before_provider_headers` fires shortly after, for the
 * exact same HTTP call, and knows the verbatim headers pi is about to send.
 * Neither half is useful to the keepalive service alone — a payload-only
 * capture has no headers to replay (the original bug), and a headers-only
 * capture has no request to replay them with.
 *
 * Pairing strategy: a single mutable slot INSIDE the returned object (one
 * instance per host session, exactly like the old inline `pendingCapture`
 * closure variable it replaces — no behavior change, verified by
 * `cache-ttl.test.ts`). The caller's `before_provider_request` handler must
 * call `clear()` first, unconditionally, before possibly calling `stage()` —
 * so a previous half-capture whose `before_provider_headers` never arrived
 * (e.g. the previous request errored out before reaching the HTTP stage) is
 * discarded rather than incorrectly paired with a *different* request's
 * headers. `consumeHeaders()` always consumes (reads-and-clears) the slot
 * exactly once: if it's empty (no matching stage — e.g. keepalive was
 * disabled when the payload capture ran, or the payload was
 * invalid/uncloneable), the headers are simply dropped with no ping
 * capture. This relies on pi firing the two hooks strictly sequentially for
 * one request (payload assembled, then headers assembled, then the HTTP
 * call) with no interleaving from a second in-flight request on the same
 * session — true for a single agent loop's one in-flight LLM call at a time.
 *
 * `port` is fixed at construction (mirrors the old code's per-request `const
 * port = deps.keepalive?.()` read — the caller re-creates a `RequestCapture`
 * whenever the port identity changes, e.g. after a stack rebuild).
 */
export interface RequestCapture {
  /** `before_provider_request`: stage a (possibly already-rewritten) capture, replacing any previous not-yet-paired stage. */
  stage(base: CapturedRequestBase): void;
  /** `before_provider_request`, error/no-port paths: discard without staging (nothing to pair). */
  clear(): void;
  /** `before_provider_headers`: consume (read-and-clear) the staged base and, if present, pair it with these headers and forward to `port.noteRequest`. */
  consumeHeaders(headers: unknown): void;
}

export function createRequestCapture(port: KeepalivePort): RequestCapture {
  let pending: CapturedRequestBase | undefined;
  return {
    stage(base) {
      pending = base;
    },
    clear() {
      pending = undefined;
    },
    consumeHeaders(headers) {
      const base = pending;
      pending = undefined;
      if (!base) return; // headers with no matching stage — half-capture, never ping (see doc comment above).
      if (!isObjectRecord(headers)) return;
      const snapshot: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === "string") snapshot[key] = value;
      }
      port.noteRequest({ ...base, headers: snapshot });
    },
  };
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
function wireCacheEvents(
  pi: ExtensionAPI,
  deps: CacheTtlDeps,
  getAdaptive: () => CacheAdaptiveService | undefined,
): void {
  pi.on("tool_execution_start", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteToolStart(sessionId, ka.instanceId);
    const ad = getAdaptive();
    if (ad) ad.noteToolStart(sessionId, ad.instanceId); // audit/status only (plan.md §3.3: never a decision input)
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteToolEnd(sessionId, ka.instanceId);
    const ad = getAdaptive();
    if (ad) ad.noteToolEnd(sessionId, ad.instanceId);
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteUiPromptStart(sessionId, ka.instanceId);
    const ad = getAdaptive();
    if (ad) ad.noteUiPromptStart(sessionId, ad.instanceId); // S3
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteUiPromptEnd(sessionId, ka.instanceId);
    const ad = getAdaptive();
    if (ad) ad.noteUiPromptEnd(sessionId, ad.instanceId);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) {
      ka.noteAgentSettled(sessionId, ka.instanceId);
      ka.noteRequestSettled(sessionId, ka.instanceId);
    }
    const ad = getAdaptive();
    if (ad) ad.noteAgentSettled(sessionId, ad.instanceId);
  });
  // adaptive plan.md §9.4: ledger reconcile on every request-settle event —
  // the m2 watermark makes the triple-fire idempotent.
  pi.on("message_end", (event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteRequestSettled(sessionId, ka.instanceId, isSuccessfulRealRequest(event.message));
    const ad = getAdaptive();
    if (ad) ad.reconcile(sessionId, ad.instanceId);
  });
  pi.on("turn_end", (event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteRequestSettled(sessionId, ka.instanceId, isSuccessfulRealRequest(event.message));
    const ad = getAdaptive();
    if (ad) ad.reconcile(sessionId, ad.instanceId);
  });
  pi.on("agent_end", (_event, ctx) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.noteRequestSettled(sessionId, ka.instanceId);
    const ad = getAdaptive();
    if (ad) ad.reconcile(sessionId, ad.instanceId);
  });
  const invalidateBoth = (reason: Parameters<CacheAdaptiveService["invalidateAdaptive"]>[0], ctx: ExtensionContext) => {
    const sessionId = readSessionId(ctx);
    const ka = deps.keepalive?.();
    if (ka) ka.invalidate(reason, sessionId, ka.instanceId);
    const ad = getAdaptive();
    if (ad) ad.invalidateAdaptive(reason, sessionId, ad.instanceId);
  };
  pi.on("model_select", (_event, ctx) => invalidateBoth("model-select", ctx));
  pi.on("thinking_level_select", (_event, ctx) => invalidateBoth("thinking-level-select", ctx));
  pi.on("session_compact", (_event, ctx) => invalidateBoth("session-compact", ctx));
  pi.on("session_compact_failed", (_event, ctx) => invalidateBoth("session-compact-failed", ctx));
  pi.on("session_tree", (_event, ctx) => invalidateBoth("session-tree", ctx));
  pi.on("resources_discover", (_event, ctx) => {
    invalidateBoth("resources-changed", ctx);
    return undefined;
  });
  pi.on("session_info_changed", (_event, ctx) => invalidateBoth("session-changed", ctx));
}

export function wireCacheTtl(pi: ExtensionAPI, settings: AgentSettings, deps: CacheTtlDeps = {}): CacheTtlWiring {
  let mode = settings.cacheTtl.mode;
  let persisted = mode;
  let dirty = false;
  const persist = deps.persist ?? ((value) => persistSettingOverride("cacheTtl.mode", value, defaultSettingsPath()));
  // See `RequestCapture`'s doc comment above for the pairing strategy. Rebuilt
  // whenever the port identity changes (mirrors the old code's per-request
  // `const port = deps.keepalive?.()` read).
  let capturePort: KeepalivePort | undefined;
  let capture: RequestCapture | undefined;

  // topic-switch plan.md P2: the last payload shape this module itself sent on the current
  // session (see `LastSent`'s doc comment). `undefined` on a fresh activation and reset on every
  // `session_start` — a new session or resume never inherits a prior session's lastSent.
  let lastSent: LastSent | undefined;

  // adaptive plan.md §7.1 (default-on revision): the single `adaptiveEnabled`
  // flag gates every adaptive consultation. Flag off ⇒ adaptive mode degrades
  // to passthrough and today's auto/on/off behaviour is byte-for-byte unchanged.
  const getAdaptive = (): CacheAdaptiveService | undefined =>
    settings.cacheTtl.adaptiveEnabled ? deps.adaptive?.() : undefined;

  wireCacheEvents(pi, deps, getAdaptive);

  pi.on("session_start", async (_event, ctx) => {
    lastSent = undefined;
    updateStatus(ctx, mode, dirty, deps, getAdaptive);
  });
  pi.on("before_provider_request", (event, ctx) => {
    const port = deps.keepalive?.();
    port?.syncModeState(mode, dirty);
    const sessionId = readSessionId(ctx);
    if (port !== capturePort) {
      capturePort = port;
      capture = port ? createRequestCapture(port) : undefined;
    }
    // Any capture still pending from a previous `before_provider_request` never
    // got its matching `before_provider_headers` (e.g. the previous request
    // errored out before reaching the HTTP stage) — it is now definitely stale
    // and must never be paired with THIS request's headers. Drop it silently
    // (never turns into a ping — see `RequestCapture`'s doc comment).
    capture?.clear();

    if (!isObjectRecord(event.payload) || !Array.isArray(event.payload.messages)) {
      port?.invalidate("payload-shape", sessionId, port.instanceId);
      return undefined;
    }

    // adaptive plan.md §3.1 step 5: one ledger read, two consumers (the
    // adaptive decision below and the keepalive capture's prefix estimate).
    const ledger = readLatestAssistantUsage(ctx);
    // topic-switch plan.md P2: computed once, reused by the adaptive decision below AND the
    // `lastSent` write further down ("shape 只算一次，adaptive 复用") — a read-only walk of the
    // pre-rewrite payload. `rewrite()` only ever edits an EXISTING `cache_control.ttl` in place,
    // never adds a new breakpoint, so this pre-rewrite shape's `ephemeralBreakpoints`/`ttl1h`
    // accurately describe the payload actually sent regardless of which `action` runs below.
    const shape = inspectPayload(event.payload);

    // §3.1 step 6: adaptive per-request decision. I-A9: mutually exclusive with
    // the §6.3 consumeUpgrade below — `mode` is never both "adaptive" and "auto".
    const adaptiveSvc = mode === "adaptive" ? getAdaptive() : undefined;
    const decision: AdaptiveDecision | undefined = adaptiveSvc?.decide(sessionId, adaptiveSvc.instanceId, {
      shape, // read-only walk of the pre-rewrite payload
      ledger,
      lineageKey: payloadLineageKey(event.payload), // review R4: prefix lineage identity
      streaming: (event.payload as { stream?: unknown }).stream === true, // review R7: can keepalive replay it?
    });

    // §6.3/I-K5: the service is mode-agnostic (it doesn't know about on/off/auto) —
    // this "mode === auto" check is what actually enforces I-K5 here.
    const upgrade =
      decision?.upgrade === true ||
      (port !== undefined && mode === "auto" && port.consumeUpgrade(sessionId, port.instanceId));
    const action: RewriteAction | "passthrough" = upgrade
      ? "force-1h"
      : mode === "on"
        ? "force-1h"
        : mode === "off"
          ? "strip-ttl"
          : "passthrough";
    if (mode === "adaptive") updateStatus(ctx, mode, dirty, deps, getAdaptive); // refresh the ttl-now segment

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
      // auto / adaptive-declined: never rewrite the payload — but still capture
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
        capture?.stage(captureRequest(cloned as RecordValue, ctx, sessionId, port, prefixFromLedger(ledger)));
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
    // 1h write and suspends pinging for this window (adaptive plan.md §6.1).
    if (port) capture?.stage(captureRequest(cloned as RecordValue, ctx, sessionId, port, prefixFromLedger(ledger)));
    return cloned as RecordValue;
  });
  // Second half of the pairing (root-cause fix): fires shortly after
  // `before_provider_request`, for the SAME HTTP call, with the verbatim
  // headers pi is about to send. Consumes (reads-and-clears) the staged
  // capture exactly once, regardless of outcome, so a leftover slot can never
  // bleed into a later request. `event.headers` is `Record<string, string |
  // null>` (`null` deletes a header per pi's contract) — only string values
  // survive into the snapshot handed to the keepalive service (see
  // `RequestCapture.consumeHeaders`).
  pi.on("before_provider_headers", (event) => {
    capture?.consumeHeaders(event.headers);
  });
  const USAGE = "usage: /cache-ttl on | off | auto | adaptive | save | keepalive on|off | status";
  pi.registerCommand("cache-ttl", {
    description: "Toggle Anthropic prompt-cache TTL: /cache-ttl [on|off|auto|adaptive|save|keepalive on|off|status]",
    getArgumentCompletions: (argumentPrefix: string) => {
      try {
        const a = (argumentPrefix ?? "").trimStart();
        const tokens = a.split(/\s+/).filter(Boolean);
        const partial = a.endsWith(" ") || a === "" ? "" : (tokens[tokens.length - 1] ?? "");
        if (tokens[0] === "keepalive" && (tokens.length > 1 || a.endsWith(" "))) {
          return ["on", "off"]
            .filter((v) => v.startsWith(partial))
            .map((v) => ({ value: `keepalive ${v}`, label: v, description: "keepalive " + v }));
        }
        return [
          { value: "on", label: "on", description: "强制 1h TTL" },
          { value: "off", label: "off", description: "关闭 TTL 覆写" },
          { value: "auto", label: "auto", description: "自动模式" },
          { value: "adaptive", label: "adaptive", description: "自适应 TTL" },
          { value: "save", label: "save", description: "持久化当前模式" },
          { value: "keepalive", label: "keepalive", description: "保活开关（on|off）" },
          { value: "status", label: "status", description: "查看保活/自适应状态" },
        ].filter((item) => item.value.startsWith(partial));
      } catch {
        return [];
      }
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const [head, ...rest] = arg.split(/\s+/).filter(Boolean);

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
        } else {
          ctx.ui.notify("usage: /cache-ttl keepalive on|off", "warning");
        }
        return;
      }

      if (head === "status") {
        const port = deps.keepalive?.();
        const adaptiveSvc = getAdaptive();
        const lines: string[] = [];
        if (port) lines.push(...renderKeepaliveReportLines(port.report()));
        if (adaptiveSvc) lines.push(...renderAdaptiveReportLines(adaptiveSvc.snapshot()));
        if (lines.length === 0) {
          ctx.ui.notify("keepalive service unavailable (no active session, or cacheTtl.keepalive=false)", "info");
          return;
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (arg === "on" || arg === "off" || arg === "auto" || arg === "adaptive") {
        mode = arg;
        dirty = mode !== persisted;
        updateStatus(ctx, mode, dirty, deps, getAdaptive);
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
        updateStatus(ctx, mode, false, deps, getAdaptive);
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
      getAdaptive,
      () => mode,
      () => lastSent,
    ),
  };
}
