/**
 * cache-ttl · child-session keepalive wiring (child-context-switch plan.md §2.4, package P3).
 *
 * Lazily builds a `CacheKeepaliveService` per child session (first usable event with a live
 * `ExtensionContext`), capture-only (never rewrites the outgoing payload — child sessions have
 * no TTL rewrite channel at all, plan §2.4 "只做 capture，永不改写 payload"), and forwards the
 * armed-signal / drift-invalidation events the service needs. Everything lives in this
 * `activate()`'s own closure; the only process-wide state touched is the ping ledger
 * (`src/cache-ttl/ping-ledger.ts`, owned by P1) and the dispose registry
 * (`src/cache-ttl/child-registry.ts`, this package) that lets the MAIN session's `onReaped`
 * reach across the process to stop a still-registered service defensively.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import { CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE } from "../runtime/session-driver.js";
import { captureRequest, settledRouteOf } from "./cache-ttl.js";
import { getProviderEvidenceStore, observeUsageIntoEvidence } from "./provider-evidence.js";
import { getChildKeepaliveLedger } from "./ping-ledger.js";
import { getChildKeepaliveDisposeRegistry } from "./child-registry.js";
import { getChildBashRegistry } from "../bash/child-registry.js";
import { createCacheKeepaliveService, type CacheKeepaliveService } from "../service/cache-keepalive.js";
import {
  isSuccessfulRealRequest,
  realRequestInputTokens,
  realRequestReportedCacheUsage,
  type InvalidateReason,
} from "./keepalive-state.js";
import { prefixFromLedger, readLatestAssistantUsage } from "./usage-ledger.js";

export interface ChildKeepaliveHandle {
  /** `src/context-switch/child.ts` calls this right after committing a boundary-draft switch
   *  (plan §2.4: the switch rewrites the prefix exactly like a compaction does). */
  noteContextSwitch(): void;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return "";
  }
}

/** Resume continuity (plan §2.4): seed `runSpentUsd` from this branch's own prior audit entries. */
function seedRunSpentUsd(ctx: ExtensionContext): number {
  try {
    const branch = ctx.sessionManager.getBranch() as unknown as readonly {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    }[];
    let total = 0;
    for (const entry of branch) {
      if (entry?.type !== "custom" || entry.customType !== CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE) continue;
      const charge = (entry.data as { budgetChargeUsd?: unknown } | undefined)?.budgetChargeUsd;
      if (typeof charge === "number" && Number.isFinite(charge)) total += charge;
    }
    return total;
  } catch {
    return 0;
  }
}

export function wireChildKeepalive(pi: ExtensionAPI, settings: AgentSettings): ChildKeepaliveHandle | undefined {
  const cfg = settings.cacheTtl;
  if (!cfg.keepalive || !cfg.childKeepalive) return undefined;

  let service: CacheKeepaliveService | undefined;
  let disposed = false;

  function ensureService(ctx: ExtensionContext): CacheKeepaliveService | undefined {
    if (service) return service;
    const sessionId = safeSessionId(ctx);
    if (!sessionId) return undefined;
    const svc = createCacheKeepaliveService({
      ctx,
      sessionId,
      settings: cfg,
      backgroundBusy: () => false,
      isCurrent: (self) => self === service,
      allowHeadless: true,
      maxSessionPings: cfg.childKeepaliveMaxPingsPerRun,
      pingLedger: getChildKeepaliveLedger(),
      // O2/O3 (2026-10-12): child keepalive goes through the SAME provider-evidence gating as
      // the main session (the store is the process-wide singleton, shared with it).
      evidence: getProviderEvidenceStore(),
      runBudgetUsd: cfg.childKeepaliveRunBudgetUsd,
      runSpentSeedUsd: seedRunSpentUsd(ctx),
      processBudgetUsd: cfg.childKeepaliveProcessBudgetUsd,
      maxConcurrentPings: cfg.childKeepaliveMaxConcurrent,
      reportCost: true,
      statusBar: false,
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
    });
    service = svc;
    // P1 review fix (todo #30 follow-up, §3.3/§3.9): this run's own runId, read from the bash
    // registry's host view (attached by `onSessionSeen` well before this lazily-built service
    // ever registers — same ordering invariant `ChildBashRegistry` itself relies on). Lets
    // `disposeSession`'s defensive `onReaped` fan-out (src/stack.ts) tell apart "this run's own
    // dispose" from "a resumed run's dispose callback that has since overwritten this sessionId's
    // entry" — without it, an old run's late-arriving onReaped could dispose a NEWER run's live
    // keepalive service purely because they share the resumed sessionId.
    const runId = getChildBashRegistry().hostView(sessionId)?.runId;
    getChildKeepaliveDisposeRegistry().register(
      sessionId,
      () => {
        disposed = true;
        svc.dispose();
      },
      runId,
    );
    return svc;
  }

  function safeInvalidate(ctx: ExtensionContext, reason: InvalidateReason): void {
    const svc = ensureService(ctx);
    svc?.invalidate(reason);
  }

  pi.on("before_provider_request", (event, ctx) => {
    if (disposed) return undefined;
    const svc = ensureService(ctx);
    if (!svc) return undefined;
    if (!isObjectRecord(event.payload) || !Array.isArray(event.payload["messages"])) {
      svc.invalidate("payload-shape");
      return undefined;
    }
    // Child sessions never rewrite the TTL payload (plan §2.4) — capture a private clone for
    // the keepalive replay only, exactly like the main session's "auto/passthrough" branch.
    let cloned: unknown;
    try {
      cloned = structuredClone(event.payload);
    } catch {
      svc.invalidate("clone-failed");
      return undefined;
    }
    const sessionId = safeSessionId(ctx);
    const ledger = readLatestAssistantUsage(ctx);
    // Payload-only capture, committed immediately (capture-pairing-plan r7 §3.1; a strict-tools P′ replaces it).
    svc.noteRequest(captureRequest(cloned as Record<string, unknown>, ctx, sessionId, svc, prefixFromLedger(ledger)));
    return undefined;
  });

  pi.on("tool_execution_start", (_event, ctx) => {
    const svc = ensureService(ctx);
    svc?.noteToolStart(safeSessionId(ctx), svc.instanceId);
  });
  pi.on("tool_execution_end", (_event, ctx) => {
    const svc = ensureService(ctx);
    svc?.noteToolEnd(safeSessionId(ctx), svc.instanceId);
  });
  pi.on("message_end", (event, ctx) => {
    const svc = ensureService(ctx);
    if (!svc) return undefined;
    svc.noteRequestSettled(
      safeSessionId(ctx),
      svc.instanceId,
      // 2026-10-20: a successful real response lifts the child's proven-write LINE breaker (no other
      // breaker recovers in a child — see `noteRequestSettled`'s non-recovery branch).
      isSuccessfulRealRequest(event.message),
      settledRouteOf(event.message),
      realRequestInputTokens(event.message),
      realRequestReportedCacheUsage(event.message),
    );
    // O1/O3 evidence observation, same as the main session's message_end hook
    // (cache-ttl.ts): fold this message's usage into the shared evidence store and forward a
    // cache-read sighting to the service's O3 accounting.
    const model = ctx?.model as { provider?: string; id?: string } | undefined;
    const observed = observeUsageIntoEvidence(
      ctx,
      { provider: model?.provider ?? "", modelId: model?.id ?? "" },
      getProviderEvidenceStore(),
      Date.now(),
    );
    if (observed.cacheReadObserved) svc.noteUsageCacheRead(safeSessionId(ctx), svc.instanceId);
    return undefined;
  });
  pi.on("turn_end", (event, ctx) => {
    const svc = ensureService(ctx);
    svc?.noteRequestSettled(
      safeSessionId(ctx),
      svc.instanceId,
      // 2026-10-20: a successful real response lifts the child's proven-write LINE breaker (no other
      // breaker recovers in a child — see `noteRequestSettled`'s non-recovery branch).
      isSuccessfulRealRequest(event.message),
      settledRouteOf(event.message),
      realRequestInputTokens(event.message),
      realRequestReportedCacheUsage(event.message),
    );
  });
  pi.on("agent_end", (_event, ctx) => {
    const svc = ensureService(ctx);
    svc?.noteRequestSettled(safeSessionId(ctx), svc.instanceId);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const svc = ensureService(ctx);
    if (!svc) return undefined;
    svc.noteAgentSettled(safeSessionId(ctx), svc.instanceId);
    svc.noteRequestSettled(safeSessionId(ctx), svc.instanceId);
    // plan §2.4 终态 ①: one prompt == one settle for a child session — dispose right away
    // instead of waiting for the (defensive-only) onReaped fan-out.
    disposed = true;
    svc.dispose();
    return undefined;
  });
  pi.on("model_select", (_event, ctx) => safeInvalidate(ctx, "model-select"));
  pi.on("thinking_level_select", (_event, ctx) => safeInvalidate(ctx, "thinking-level-select"));
  pi.on("session_compact", (_event, ctx) => safeInvalidate(ctx, "session-compact"));
  pi.on("session_compact_failed", (_event, ctx) => safeInvalidate(ctx, "session-compact-failed"));

  return {
    noteContextSwitch(): void {
      service?.invalidate("context-switch");
    },
  };
}
