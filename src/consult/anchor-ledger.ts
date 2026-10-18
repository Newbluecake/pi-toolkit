import { createHash } from "node:crypto";
import type { ConsultWarmPrediction, Millis, RunId } from "../core/types.js";

/**
 * consult warm/cold prediction ledger (docs/dev/consult/cache-thread-plan.md §5.1,
 * plan-author ruling on first consults).
 *
 * Pi-free, closure state (one ledger per `wireConsult`). It records only PROVEN
 * touches of an expert's cached prefix — a real consult request that carried a
 * verified anchor (`added|relocated`) and whose response covered ≥90 % of the
 * expert's measured request size — keyed by (expertRunId, route, snapDigest).
 * `snapDigest` is computed at dispatch from the expert's reconstructed loadout
 * (tools + system sections), the consult cwd and the expert session file's
 * identity, so a FIRST consult by a different asker can match a touch left by an
 * earlier consult of the same expert (its request bytes do not exist yet).
 *
 * Prediction is O(1)-ish and evidence-bound: anything unprovable is `unknown`.
 * TTL is the 5-minute default — no 1h survival claim is ever made here; when
 * the touching request carried `ttl:"1h"` only the COLD threshold is relaxed
 * to 60 minutes (a 1h landing cannot be ruled out). No timers.
 */

export const PREDICT_TTL_MS = 5 * 60 * 1000;
export const PREDICT_TTL_1H_MS = 60 * 60 * 1000;
export const PREDICT_SAFETY_MARGIN_MS = 15 * 1000;
const MAX_ENTRIES = 256;

export interface LedgerRoute {
  provider: string;
  model: string;
}

export interface LedgerTouch {
  expertRunId: RunId;
  route: LedgerRoute;
  snapDigest: string;
  anchor: "added" | "relocated";
  degraded?: boolean;
  /** Request START time of the touching real request. */
  touchedAt: Millis;
  /** The touching request carried `cache_control.ttl === "1h"`. */
  ttl1h?: boolean;
}

export interface PredictQuery {
  /** The reserved `main` expert is never predicted. */
  isMain?: boolean;
  expertRunId: RunId;
  /** Snapshot model; absent ⇒ `no-snapshot`. */
  route?: LedgerRoute;
  /** pi-ai api of that route; absent ⇒ `no-snapshot`, not `anthropic-messages` ⇒ `non-anthropic`. */
  api?: string;
  snapDigest?: string;
  /** Known OAuth route (4-breakpoint limit) ⇒ `oauth-limit`. */
  oauth?: boolean;
  /** A follow-up whose thread has no trusted base identity (degraded/skipped first anchor). */
  followUpWithoutBase?: boolean;
  /** Expert's `settledAt` (live diag or ExpertIndex). */
  settledAt?: Millis;
}

export interface AnchorLedger {
  noteTouch(touch: LedgerTouch): void;
  predict(query: PredictQuery): ConsultWarmPrediction;
  size(): number;
  close(): void;
}

/** sha256 over the expert's loadout + cwd + session-file identity (the dispatch-time identity digest). */
export function snapDigestOf(input: {
  tools: unknown;
  systemSections: unknown;
  cwd: string;
  /** e.g. `${size}:${mtimeMs}` of the expert's original session file. */
  sourceKey?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tools: input.tools,
        systemSections: input.systemSections,
        cwd: input.cwd,
        sourceKey: input.sourceKey ?? "",
      }),
      "utf8",
    )
    .digest("hex");
}

function sameRoute(a: LedgerRoute, b: LedgerRoute): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function createAnchorLedger(deps: { now: () => Millis }): AnchorLedger {
  let closed = false;
  /** Insertion-ordered; re-touching moves the entry to the end (FIFO eviction of the stalest). */
  const entries = new Map<string, LedgerTouch>();

  const keyOf = (t: { expertRunId: RunId; route: LedgerRoute; snapDigest: string }): string =>
    `${t.expertRunId}\u0000${t.route.provider}/${t.route.model}\u0000${t.snapDigest}`;

  function noteTouch(touch: LedgerTouch): void {
    if (closed || !Number.isFinite(touch.touchedAt)) return;
    const key = keyOf(touch);
    const prev = entries.get(key);
    // Delayed deliveries must never move the window backwards.
    if (prev !== undefined && prev.touchedAt > touch.touchedAt) return;
    entries.delete(key);
    entries.set(key, { ...touch });
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function unknown(reason: string): ConsultWarmPrediction {
    return { state: "unknown", reason };
  }

  function predict(q: PredictQuery): ConsultWarmPrediction {
    if (q.isMain === true) return unknown("main");
    if (closed) return unknown("no-evidence");
    if (q.route === undefined || q.api === undefined) return unknown("no-snapshot");
    if (q.api !== "anthropic-messages") return unknown("non-anthropic");
    if (q.oauth === true) return unknown("oauth-limit");
    if (q.followUpWithoutBase === true) return unknown("degraded-anchor");
    const now = deps.now();
    const forExpert = [...entries.values()].filter((e) => e.expertRunId === q.expertRunId);
    const matching = forExpert
      .filter((e) => sameRoute(e.route, q.route!) && q.snapDigest !== undefined && e.snapDigest === q.snapDigest)
      .sort((a, b) => b.touchedAt - a.touchedAt);
    const e = matching[0];
    if (e !== undefined) {
      if (e.degraded === true) return unknown("degraded-anchor");
      const evidence = {
        source: "anchor-ledger" as const,
        ttlMs: PREDICT_TTL_MS,
        lastProvenTouchAt: e.touchedAt,
      };
      if (now < e.touchedAt + PREDICT_TTL_MS - PREDICT_SAFETY_MARGIN_MS) return { state: "warm", evidence };
      const coldAfter = e.touchedAt + (e.ttl1h === true ? PREDICT_TTL_1H_MS : PREDICT_TTL_MS);
      if (now >= coldAfter) return { state: "cold", evidence: { ...evidence, ttlMs: coldAfter - e.touchedAt } };
      return { ...unknown("ttl-margin"), evidence };
    }
    if (forExpert.length > 0) return unknown("digest-mismatch");
    if (q.settledAt !== undefined && Number.isFinite(q.settledAt) && now >= q.settledAt + PREDICT_TTL_MS) {
      return {
        state: "cold",
        evidence: { source: "expert-settle", ttlMs: PREDICT_TTL_MS, settledAt: q.settledAt },
      };
    }
    return unknown("no-evidence");
  }

  return {
    noteTouch,
    predict,
    size: () => entries.size,
    close() {
      closed = true;
      entries.clear();
    },
  };
}
