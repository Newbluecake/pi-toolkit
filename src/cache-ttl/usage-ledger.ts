/**
 * Usage ledger readers — pi-free (structural duck type over ExtensionContext).
 *
 * Moved out of cache-ttl.ts (adaptive plan.md §10.1 step 1, pure refactor) and
 * extended with the M1 anchoring fields: pi's compaction APPENDS a compaction
 * entry and never deletes the older assistant entries
 * (dist/core/compaction/compaction.js `getMessageFromEntryForCompaction`
 * returns undefined for `type === "compaction"`), so an unanchored reverse scan
 * would keep reading the pre-compact ledger forever. `entrySeq` (the index
 * inside `getEntries()`) and `modelId` (`entry.message.model`) let the adaptive
 * predictor tell such a stale ledger apart from a fresh one (plan.md §3.4).
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
  /** `usage.cost.total` of the same entry, when present. */
  costTotalUsd: number | undefined;
  /** `usage.cost.cacheWrite` of the same entry, when present — the USD input of the
   *  adaptive write-budget gate. `undefined` ⇒ no cost data ⇒ the gate falls back to
   *  tokens only (never guess a cost). */
  cacheWriteUsd: number | undefined;
  /** M1 anchor: index of the assistant entry within `getEntries()`; -1 when unknown. */
  entrySeq: number;
  /** `getEntries().length` at read time (0 when unreadable) — pending records snapshot it as `minEntrySeq`. */
  entriesLength: number;
  /** M1 anchor: `entry.message.model` ("" when unreadable); compared against `ctx.model.id`. */
  modelId: string;
  /** Review round 2 (R9): `entry.message.provider` — with `modelId` it identifies the ROUTE whose 1h
   *  lifetime the adaptive survival evidence describes. Optional (older entries / test fixtures). */
  providerId?: string;
}

const UNKNOWN_LEDGER: LedgerUsage = {
  source: "unknown",
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: undefined,
  costTotalUsd: undefined,
  cacheWriteUsd: undefined,
  entrySeq: -1,
  entriesLength: 0,
  modelId: "",
};

interface LedgerEntryLike {
  type?: string;
  message?: { role?: string; model?: string; provider?: string; usage?: Record<string, unknown> };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * plan.md §3.4 (keepalive M3): only an actually-measured lower bound counts.
 * Scans from the most recent entry backward and stops at the first assistant
 * message carrying usage — this is the same official ledger the HUD footer
 * reads (`src/hud/footer.ts`), not an estimate. Unreadable/absent ⇒
 * "unknown" (⇒ the keepalive tick's G6 gate refuses to ping, and the adaptive
 * predictor judges cold).
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
        return {
          source: "usage",
          cacheRead: finite(usage.cacheRead) ?? 0,
          cacheWrite: finite(usage.cacheWrite) ?? 0,
          cacheWrite1h: finite(usage.cacheWrite1h),
          costTotalUsd: finite(isObjectRecord(usage.cost) ? usage.cost.total : undefined),
          cacheWriteUsd: finite(isObjectRecord(usage.cost) ? usage.cost.cacheWrite : undefined),
          entrySeq: i,
          entriesLength: entries.length,
          modelId: typeof entry.message.model === "string" ? entry.message.model : "",
          ...(typeof entry.message.provider === "string" ? { providerId: entry.message.provider } : {}),
        };
      }
    }
    // Entries exist but none carry an assistant usage yet (fresh session) — the
    // length is still real and usable as a pending snapshot anchor.
    return { ...UNKNOWN_LEDGER, entriesLength: entries.length };
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
