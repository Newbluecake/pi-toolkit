/**
 * "Late-usage" lines (docs/dev/cache-ttl-keepalive/plan.md, 2026-10-20 section).
 *
 * Some Anthropic-messages relays (measured: kimi-coding/k3 at `https://api.kimi.com/coding`) report
 * prompt-cache stats ONLY in the stream's final `message_delta.usage`; `message_start.usage` almost
 * always shows `cache_read_input_tokens:0, cache_creation_input_tokens:0, input_tokens:<full>`. A
 * ping that cancels at `message_start` therefore classifies every hit as `no-usage`.
 *
 * For such lines the ping (a) replays the captured payload byte-for-byte except `max_tokens`,
 * clamped to {@link LATE_USAGE_PING_MAX_TOKENS} (thinking is NEVER touched — it is part of the
 * cache key), and (b) reads the stream until the first `message_delta` carrying `usage`.
 *
 * pi-free (types only from `ping-client.ts`; no pi imports).
 */

import { classifyUsage, isMessageStartEvent, rawUsageFrom, type RawScannedUsage } from "./ping-client.js";

/**
 * Output cap of a late-usage ping. Measured: 2/4/8/16 hit the cache and report in `message_delta`;
 * `max_tokens:1` is special-cased by kimi (different input count, NO cache read) — never use 1.
 */
export const LATE_USAGE_PING_MAX_TOKENS = 4;
/** The smallest `max_tokens` a late-usage ping may ever send (1 is special-cased by the relay). */
export const LATE_USAGE_PING_MIN_TOKENS = 2;
/**
 * Scan cap for a late-usage response body (the normal cap is 64 KiB): ≤4 output tokens plus
 * thinking deltas and SSE framing stay far below this, but the read runs past `message_start`.
 */
export const LATE_USAGE_SCAN_LIMIT_BYTES = 256 * 1024;

/** Base-URL hostnames seeded as late-usage lines (exact match; keep this list small). */
export const LATE_USAGE_SEED_HOSTS: readonly string[] = ["api.kimi.com"];

/** Where the classified usage numbers came from (audit field `usageSource`). */
export type UsageSource = "message_start" | "message_delta";

/** Why a line is late-usage (status/audit display). */
export type LateUsageReason = "seeded" | "learned";

/** True iff `baseUrl`'s host is in {@link LATE_USAGE_SEED_HOSTS}. Never throws. */
export function isSeededLateUsageBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return LATE_USAGE_SEED_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/**
 * Late-usage ping body: the captured payload byte-for-byte EXCEPT `max_tokens`, clamped to
 * {@link LATE_USAGE_PING_MAX_TOKENS} only when the captured value is larger (never below
 * {@link LATE_USAGE_PING_MIN_TOKENS}, never 1). A missing / non-numeric `max_tokens` is left
 * untouched. `thinking` and every other field are replayed verbatim (a changed thinking config
 * selects a different cache namespace). Copy-on-write: the capture is shared state.
 */
export function prepareLatePingPayload(captured: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...captured };
  const n = captured.max_tokens;
  if (typeof n === "number" && Number.isFinite(n)) {
    if (n > LATE_USAGE_PING_MAX_TOKENS) body.max_tokens = LATE_USAGE_PING_MAX_TOKENS;
    else if (n < LATE_USAGE_PING_MIN_TOKENS) body.max_tokens = LATE_USAGE_PING_MIN_TOKENS;
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** pi-ai / Anthropic semantics: a present, non-null counter in `message_delta.usage` overrides the earlier one. */
function counter(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Merge `message_delta.usage` (cumulative) over the `message_start` usage. `undefined` when the
 * delta carries no usage object.
 */
export function mergeDeltaUsage(
  start: RawScannedUsage | undefined,
  delta: Record<string, unknown>,
): RawScannedUsage | undefined {
  const usage = delta.usage;
  if (!isRecord(usage)) return undefined;
  const base: RawScannedUsage = start ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: undefined,
  };
  const creation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const split1h = creation?.ephemeral_1h_input_tokens;
  return {
    inputTokens: counter(usage.input_tokens, base.inputTokens),
    outputTokens: counter(usage.output_tokens, base.outputTokens),
    cacheRead: counter(usage.cache_read_input_tokens, base.cacheRead),
    cacheWrite: counter(usage.cache_creation_input_tokens, base.cacheWrite),
    cacheWrite1h: typeof split1h === "number" && Number.isFinite(split1h) ? split1h : base.cacheWrite1h,
  };
}

/** Final answer of a {@link LateUsageScanner}: the usage to classify and where it came from. */
export interface LateUsageScanResult {
  usage: RawScannedUsage | undefined;
  source: UsageSource;
}

export interface LateUsageScanner {
  /** Feed one parsed provider stream event; a non-`undefined` result ends the scan (the caller cancels). */
  feed(event: unknown): LateUsageScanResult | undefined;
  /** A `message_start` was seen. */
  readonly sawStart: boolean;
}

/**
 * Pure late-usage state machine over parsed Anthropic stream events:
 *   - `message_start` that already PROVES a hit/write ⇒ done immediately (`message_start`);
 *   - otherwise remember its usage and keep reading;
 *   - first `message_delta` carrying `usage` ⇒ done with the merged numbers (`message_delta`);
 *   - `message_stop` without such a delta ⇒ done with the start usage (⇒ `no-usage`).
 */
export function createLateUsageScanner(): LateUsageScanner {
  let sawStart = false;
  let start: RawScannedUsage | undefined;
  return {
    get sawStart() {
      return sawStart;
    },
    feed(event) {
      if (!isRecord(event)) return undefined;
      if (isMessageStartEvent(event)) {
        if (sawStart) return undefined;
        sawStart = true;
        start = rawUsageFrom(event);
        const verdict = classifyUsage(start).kind;
        return verdict === "proven-hit" || verdict === "proven-write"
          ? { usage: start, source: "message_start" }
          : undefined;
      }
      if (!sawStart) return undefined;
      if (event.type === "message_delta") {
        const merged = mergeDeltaUsage(start, event);
        return merged !== undefined ? { usage: merged, source: "message_delta" } : undefined;
      }
      if (event.type === "message_stop") return { usage: start, source: "message_start" };
      return undefined;
    },
  };
}
