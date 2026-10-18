/** Strict measurement-only usage reader (§5.2). Never use the zero-filling keepalive reader here. */
import type {
  BillingItem,
  CacheEvidenceInvalidReason,
  MeasureApi,
  RequestedRetention,
  UsageReading,
} from "./measure-types.js";

/** `rawUsage` is the terminal frame's bounded usage object, not pi's normalised usage. */
export function readMeasureUsage(
  profile: MeasureApi,
  rawUsage: unknown,
  requestedRetention: RequestedRetention = "short",
): UsageReading {
  switch (profile) {
    case "anthropic-messages":
      return readAnthropicUsage(rawUsage, requestedRetention);
    case "openai-responses":
    case "openai-completions":
      return readOpenAiUsage(profile, rawUsage);
  }
}

function readOpenAiUsage(profile: "openai-responses" | "openai-completions", raw: unknown): UsageReading {
  if (!isRecord(raw)) return invalid("no-terminal-frame");
  const responses = profile === "openai-responses";
  const details = responses ? raw.input_tokens_details : raw.prompt_tokens_details;
  // A null details container means the provider did not report details, not an invalid
  // numeric counter. Completions may still provide a top-level cache-read alias.
  if (details !== undefined && details !== null && !isRecord(details)) return invalid("not-integer");
  const P = responses ? raw.input_tokens : raw.prompt_tokens;
  const cached = isRecord(details) ? details.cached_tokens : undefined;
  // First PRESENT, never first truthy: an explicit 0 is evidence; an invalid first alias
  // must not be hidden by a later valid alias.
  const C = responses
    ? cached
    : cached !== undefined
      ? cached
      : raw.prompt_cache_hit_tokens !== undefined
        ? raw.prompt_cache_hit_tokens
        : raw.cached_tokens;
  const W = isRecord(details) ? details.cache_write_tokens : undefined;
  const output = responses ? raw.output_tokens : raw.completion_tokens;
  const counters = [P, C, W, output, cached, ...(responses ? [] : [raw.prompt_cache_hit_tokens, raw.cached_tokens])];
  for (const value of counters) {
    if (value === undefined) continue;
    if (typeof value === "number" && value < 0) return invalid("negative");
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return invalid("not-integer");
  }
  if (P === undefined) return invalid("missing-prompt");
  if (C === undefined) return invalid("missing-cached");
  const prompt = P as number;
  const read = C as number;
  const write = W as number | undefined;
  if (read > prompt) return invalid("cached-exceeds-prompt");
  if (write !== undefined && write > prompt - read) return invalid("cached-plus-write-exceeds-prompt");
  const items: BillingItem[] = [];
  if (output === undefined) items.push("output");
  if (write === undefined) items.push("write");
  return {
    usage: {
      P: prompt,
      C: read,
      ...(write === undefined ? {} : { W: write }),
      ...(output === undefined ? {} : { output: output as number }),
    },
    cacheEvidence: { kind: "valid" },
    billing: items.length ? { kind: "unknown", items } : { kind: "complete" },
  };
}

function readAnthropicUsage(raw: unknown, retention: RequestedRetention): UsageReading {
  if (!isRecord(raw)) return invalid("no-terminal-frame");
  const split = raw.cache_creation;
  if (split !== undefined && !isRecord(split)) return invalid("not-integer");
  const counters = [
    raw.input_tokens,
    raw.cache_read_input_tokens,
    raw.cache_creation_input_tokens,
    raw.output_tokens,
    isRecord(split) ? split.ephemeral_1h_input_tokens : undefined,
    isRecord(split) ? split.ephemeral_5m_input_tokens : undefined,
  ];
  // Validate every reported counter, even output_tokens (which at message_start is NOT a
  // final output reading). Missing values stay missing; null/string/fraction/NaN are invalid.
  for (const value of counters) {
    if (value === undefined) continue;
    if (typeof value === "number" && value < 0) return invalid("negative");
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return invalid("not-integer");
  }
  if (raw.cache_read_input_tokens === undefined) return invalid("missing-cached");
  if (raw.input_tokens === undefined || raw.cache_creation_input_tokens === undefined) return invalid("missing-prompt");
  // The checks above narrow values at runtime; retain the raw values rather than defaulting to 0.
  const input = raw.input_tokens as number;
  const C = raw.cache_read_input_tokens as number;
  const W = raw.cache_creation_input_tokens as number;
  const W1h = isRecord(split) ? (split.ephemeral_1h_input_tokens as number | undefined) : undefined;
  const P = input + C + W;
  if (!Number.isSafeInteger(P)) return invalid("not-integer");
  if (C > P) return invalid("cached-exceeds-prompt");
  if (C + W > P) return invalid("cached-plus-write-exceeds-prompt");
  if (W1h !== undefined && W1h > W) return invalid("write1h-exceeds-write");
  const items: BillingItem[] = ["output"];
  if (retention === "long" && W1h === undefined) items.push("write1h-split");
  return {
    usage: { P, C, W, ...(W1h === undefined ? {} : { W1h }) },
    cacheEvidence: { kind: "valid" },
    billing: { kind: "unknown", items },
  };
}

function invalid(reason: CacheEvidenceInvalidReason): UsageReading {
  return { cacheEvidence: { kind: "invalid", reason }, billing: { kind: "unknown", items: ["all"] } };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
