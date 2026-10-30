// Error classification, process-level health/bucket tables, availability
// status summarization, notification verdicts and tag coverage (jev-arch
// §5.2/§5.3, jev-plan J2).
//
// I4: the only module-scope mutable state allowed anywhere in the jev tree is
// the two `Symbol.for("pi-subagent:memory-jev-*")` process-level tables —
// both live here, lazily created on `globalThis`, surviving `/reload`
// (`clearHealthTable` is the only thing that resets the health table; the
// settings-driven cases that matter are tested against it directly).
//
// Pi-free root; no pi imports.

import {
  HEALTH_TABLE_MAX,
  TOKEN_BUCKET_CAPACITY,
  TOKEN_BUCKET_WINDOW_MS,
  type EntryHash,
  type HealthEntry,
  type HealthTable,
  type JevIndexV1,
  type JevStatus,
  type MemEntry,
  type NotifyKind,
  type TokenBucket,
} from "./contracts.js";

// ───────────────────────────── error classification (§5.2) ─────────────────────────────

// `max_tokens_exceeded`: measured opencode System One wording (E0 C-J8, 2026-10-31):
// HTTP 400 `{"detail":{"error_type":"max_tokens_exceeded"}}` for an oversized state.
const CONTEXT_RE = /context|too many tokens|maximum context|max_tokens_exceeded/i;
const UNAVAILABLE_KEYWORD_RE = /FreeTierError|Insufficient|unavailable/i;
const RATE_LIMIT_KEYWORD_RE = /rate limit/i;
const API_ERROR_MARKER = "API error (";

/** `<Provider> API error (<status>): …` status-code extraction, keyword
 *  fallback, `proxy error:` priority-transient (§5.2). Never throws. */
export function classifyError(msg: string): "unavailable" | "transient" | "context" {
  const text = typeof msg === "string" ? msg : "";
  if (CONTEXT_RE.test(text)) return "context";
  if (text.startsWith("proxy error:")) return "transient";
  const idx = text.indexOf(API_ERROR_MARKER);
  if (idx !== -1) {
    const codeStr = text.slice(idx + API_ERROR_MARKER.length, idx + API_ERROR_MARKER.length + 3);
    if (/^\d{3}$/.test(codeStr)) {
      const code = Number(codeStr);
      if (code === 401 || code === 402 || code === 403 || code === 451) return "unavailable";
      return "transient"; // 429, 5xx, and any other numeric code fail safe as transient
    }
  }
  if (UNAVAILABLE_KEYWORD_RE.test(text)) return "unavailable";
  if (RATE_LIMIT_KEYWORD_RE.test(text)) return "transient";
  return "transient";
}

/** Best-effort status-code label for display (`/mem jev` model notes); `""`
 *  when none can be found. */
export function errorCode(msg: string): string {
  const text = typeof msg === "string" ? msg : "";
  const idx = text.indexOf(API_ERROR_MARKER);
  if (idx === -1) return "";
  const codeStr = text.slice(idx + API_ERROR_MARKER.length, idx + API_ERROR_MARKER.length + 3);
  return /^\d{3}$/.test(codeStr) ? codeStr : "";
}

// ───────────────────────────── process-level health table (§5.3) ─────────────────────────────

const HEALTH_SYMBOL = Symbol.for("pi-subagent:memory-jev-health");

interface GlobalHealthState {
  map: Map<string, HealthEntry>;
}

function globalHealthState(): GlobalHealthState {
  const g = globalThis as unknown as Record<symbol, GlobalHealthState | undefined>;
  let state = g[HEALTH_SYMBOL];
  if (state === undefined) {
    state = { map: new Map() };
    g[HEALTH_SYMBOL] = state;
  }
  return state;
}

/** Process-level model health table (≤32 entries, LRU eviction on overflow).
 *  Every `createJevClient` instance and `/reload` share the SAME table. */
export function getHealthTable(): HealthTable {
  const state = globalHealthState();
  return {
    get: (model) => state.map.get(model),
    set: (model, entry) => {
      if (state.map.has(model)) state.map.delete(model); // move-to-end (LRU)
      state.map.set(model, entry);
      while (state.map.size > HEALTH_TABLE_MAX) {
        const oldest = state.map.keys().next();
        if (oldest.done === true) break;
        state.map.delete(oldest.value);
      }
    },
    entries: () => [...state.map.entries()],
    clear: () => state.map.clear(),
  };
}

/** `/reload` hook — clears the shared health table. */
export function clearHealthTable(): void {
  globalHealthState().map.clear();
}

// ───────────────────────────── child-session token bucket (§5.5) ─────────────────────────────

const BUCKET_SYMBOL = Symbol.for("pi-subagent:memory-jev-bucket");

interface GlobalBucketState {
  windowStart: number;
  count: number;
}

/** Process-level fixed-window bucket: `TOKEN_BUCKET_CAPACITY` takes per
 *  `TOKEN_BUCKET_WINDOW_MS`, shared by every child session in the process. */
export function createTokenBucket(): TokenBucket {
  return {
    tryTake(now: number): boolean {
      const g = globalThis as unknown as Record<symbol, GlobalBucketState | undefined>;
      let state = g[BUCKET_SYMBOL];
      if (state === undefined || now - state.windowStart >= TOKEN_BUCKET_WINDOW_MS) {
        state = { windowStart: now, count: 0 };
        g[BUCKET_SYMBOL] = state;
      }
      if (state.count >= TOKEN_BUCKET_CAPACITY) return false;
      state.count += 1;
      return true;
    },
  };
}

// ───────────────────────────── availability + status summary (§5.3) ─────────────────────────────

export type AvailabilityKind = "available" | "no-auth" | "not-found";

export interface SummarizeStatusInput {
  /** `JevConfig.classifiers`, in configured order. */
  readonly classifiers: readonly string[];
  /** Per-id availability (credentials + catalog), from `resolveAvailability`. */
  readonly availability: ReadonlyMap<string, AvailabilityKind>;
  readonly health: HealthTable;
  readonly now: number;
  /** At least one real classify() call has succeeded this activation. */
  readonly everSucceeded: boolean;
  readonly lastModel?: string;
  /** Per-activation $/call cap reached — latches `partial(budget)`. */
  readonly budgetExhausted: boolean;
  /** Coverage-derived "nothing to show" flag (fed back by the wire layer,
   *  jev-arch §5.3 — J2 does not compute this itself). */
  readonly inactive: boolean;
}

/** Summarize the session-level `JevStatus` from per-model health
 *  (jev-arch §5.3 table). Pure, synchronous. */
export function summarizeStatus(input: SummarizeStatusInput): JevStatus {
  if (input.classifiers.length === 0) return { kind: "off", reason: "empty-list" };
  if (input.budgetExhausted) return { kind: "partial", reason: "budget", inactive: false };

  let anyUsable = false;
  let retryAt: number | undefined;
  let reason: string | undefined;

  for (const id of input.classifiers) {
    const avail = input.availability.get(id);
    if (avail === "not-found" || avail === "no-auth") {
      reason = reason ?? avail;
      continue;
    }
    const h = input.health.get(id);
    if (h !== undefined && (h.state === "unavailable" || h.state === "transient")) {
      if (h.until !== undefined && h.until > input.now) {
        reason = reason ?? h.code ?? h.state;
        retryAt = retryAt === undefined ? h.until : Math.min(retryAt, h.until);
        continue;
      }
    }
    anyUsable = true;
  }

  if (!anyUsable) {
    return {
      kind: "partial",
      reason: reason ?? "all-failed",
      inactive: input.inactive,
      ...(retryAt === undefined ? {} : { retryAt }),
    };
  }
  if (input.everSucceeded) return { kind: "full", model: input.lastModel ?? input.classifiers[0]! };
  return { kind: "probing" };
}

// ───────────────────────────── notification verdicts (§5.3 table) ─────────────────────────────

export interface NotifyContext {
  /** "first-full" already fired once this activation. */
  readonly firstFullNotified: boolean;
  /** "degraded" reasons already notified this activation (full→partial). */
  readonly notifiedPartialReasons: ReadonlySet<string>;
  /** Startup-partial only fires when the user actually has credentials
   *  configured (not the all-no-auth/not-found "inactive" case). */
  readonly hasCredentials: boolean;
}

/** `prev === undefined` means "no prior status this activation" (the very
 *  first `summarizeStatus` call, typically the post-`session_start` probe). */
export function notifyFor(prev: JevStatus | undefined, next: JevStatus, ctx: NotifyContext): NotifyKind | undefined {
  if (next.kind === "full") {
    if (prev?.kind === "full") return undefined;
    if (prev?.kind === "partial" && ctx.firstFullNotified) return "recovered";
    return ctx.firstFullNotified ? undefined : "first-full";
  }
  if (next.kind === "partial") {
    if (next.inactive) return undefined; // §5.3: inactive is never notified
    if (prev === undefined) return ctx.hasCredentials ? "startup-partial" : undefined;
    if (prev.kind === "full" && !ctx.notifiedPartialReasons.has(next.reason)) return "degraded";
    return undefined;
  }
  return undefined;
}

// ───────────────────────────── coverage (§4.4) ─────────────────────────────

export interface Coverage {
  readonly tagged: number;
  readonly total: number;
  readonly pending: number;
}

/** Coverage = tagged ÷ non-private entries (jev-arch §4.4/§5.3). A `pending`
 *  entry is a non-private one whose current hash has no sidecar record. */
export function coverage(entries: readonly MemEntry[], index: JevIndexV1): Coverage {
  let total = 0;
  let tagged = 0;
  for (const entry of entries) {
    if (entry.inline.isPrivate === true) continue;
    total += 1;
    if (hasTag(index, entry.hash)) tagged += 1;
  }
  return { tagged, total, pending: total - tagged };
}

function hasTag(index: JevIndexV1, hash: EntryHash): boolean {
  return Object.prototype.hasOwnProperty.call(index.entries, hash);
}
