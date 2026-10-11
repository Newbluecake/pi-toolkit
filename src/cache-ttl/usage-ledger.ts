/**
 * Usage ledger readers — pi-free (structural duck type over ExtensionContext).
 *
 * Hard rule: never throw — a stale/degraded ctx degrades to `source: "unknown"`.
 */

import type { PrefixEstimate } from "./keepalive-state.js";

/** Structural subset of pi's ExtensionContext this module reads (never imports pi). */
export interface LedgerCtxLike {
  sessionManager?: { getEntries?: () => unknown } | undefined;
}

export interface LedgerUsage {
  source: "usage" | "unknown";
  cacheRead: number;
  cacheWrite: number;
  /** Subset of `cacheWrite` written with 1h retention; `undefined` when the route doesn't report the split (distinct from a reported 0, plan.md §5.2). */
  cacheWrite1h: number | undefined;
  /** M1 anchor: `entry.message.model` ("" when unreadable); compared against `ctx.model.id`. */
  modelId: string;
  /** Review round 2 (R9): `entry.message.provider` — with `modelId` it identifies the ROUTE of the observed usage. Optional (older entries / test fixtures). */
  providerId?: string;
  /** topic-switch plan.md P2: `entry.message.timestamp` (pi-ai's own wall-clock stamp), when finite. Absent on
   *  older entries / test fixtures — never guessed. Feeds `warmth.ts`'s proven-touch and elapsed-time checks. */
  at?: number;
}

const UNKNOWN_LEDGER: LedgerUsage = {
  source: "unknown",
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: undefined,
  modelId: "",
};

interface LedgerEntryLike {
  type?: string;
  message?: {
    role?: string;
    model?: string;
    provider?: string;
    usage?: Record<string, unknown>;
    /** topic-switch plan.md P2: pi-ai's wall-clock stamp on the message, when present. */
    timestamp?: unknown;
  };
}

/**
 * plan.md §3.4 (keepalive M3): only an actually-measured lower bound counts.
 * Scans from the most recent entry backward and stops at the first assistant
 * message carrying usage — this is the same official ledger the HUD footer
 * reads (`src/hud/footer.ts`), not an estimate. Unreadable/absent ⇒
 * "unknown" (⇒ the keepalive tick's G6 gate refuses to ping).
 */
export function readLatestAssistantUsage(ctx: LedgerCtxLike | undefined): LedgerUsage {
  try {
    const raw = ctx?.sessionManager?.getEntries?.();
    if (!Array.isArray(raw)) return UNKNOWN_LEDGER;
    const entries = raw as LedgerEntryLike[];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
        const usage = entry.message.usage;
        const finite = (v: unknown): number | undefined =>
          typeof v === "number" && Number.isFinite(v) ? v : undefined;
        const at = finite(entry.message.timestamp);
        return {
          source: "usage",
          cacheRead: finite(usage.cacheRead) ?? 0,
          cacheWrite: finite(usage.cacheWrite) ?? 0,
          cacheWrite1h: finite(usage.cacheWrite1h),
          modelId: typeof entry.message.model === "string" ? entry.message.model : "",
          ...(typeof entry.message.provider === "string" ? { providerId: entry.message.provider } : {}),
          ...(at !== undefined ? { at } : {}),
        };
      }
    }
    return UNKNOWN_LEDGER;
  } catch {
    // fall through to "unknown" — never let a stale/degraded ctx throw here.
  }
  return UNKNOWN_LEDGER;
}

/** Derive the keepalive-facing prefix estimate from a full ledger read (single read, two consumers — plan.md §3.1 step 5/9). */
export function prefixFromLedger(ledger: LedgerUsage): PrefixEstimate {
  return ledger.source === "usage"
    ? { tokens: ledger.cacheRead + ledger.cacheWrite, source: "usage" }
    : { tokens: 0, source: "unknown" };
}

/** Keepalive-facing narrow view; behavior identical to the pre-extraction version in cache-ttl.ts. */
export function readLatestAssistantCacheTokens(ctx: LedgerCtxLike | undefined): PrefixEstimate {
  return prefixFromLedger(readLatestAssistantUsage(ctx));
}

/**
 * topic-switch plan.md P2: a longer-range "has there been a 1h write" signal than
 * `readLatestAssistantUsage(ctx).cacheWrite1h` alone (which only reflects the single most recent
 * assistant entry). Scans assistant-usage entries newest-to-oldest: a `cacheWrite1h > 0` entry
 * proves `true`; a timestamped entry older than `sinceMs` proves `false` (nothing newer carried
 * the evidence, so none exists in range); exhausting the `maxEntries` traversal budget (bounding
 * the scan for zero-hang, regardless of how many entries are assistant-usage ones) or an
 * unreadable ledger degrades to `"unknown"` — never a guess either way.
 */
export function anyLongWriteSince(
  ctx: LedgerCtxLike | undefined,
  sinceMs: number,
  maxEntries = 400,
): boolean | "unknown" {
  try {
    const raw = ctx?.sessionManager?.getEntries?.();
    if (!Array.isArray(raw)) return "unknown";
    const entries = raw as LedgerEntryLike[];
    const floor = Math.max(-1, entries.length - 1 - maxEntries);
    for (let i = entries.length - 1; i > floor; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
      const usage = entry.message.usage;
      const cacheWrite1h =
        typeof usage.cacheWrite1h === "number" && Number.isFinite(usage.cacheWrite1h) ? usage.cacheWrite1h : 0;
      if (cacheWrite1h > 0) return true;
      const ts = entry.message.timestamp;
      if (typeof ts === "number" && Number.isFinite(ts) && ts < sinceMs) return false;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}
