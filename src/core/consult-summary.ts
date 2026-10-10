/**
 * consult A/B instrumentation plan (docs/dev/consult/ab-instrumentation-plan.md
 * §2/§5 P1a): pure classification + fold of consult tool calls into a
 * per-run rollup (`RunDiagnostics.consults`). Pi-free, no I/O; does not
 * depend on `src/consult/` (core stays the dependency sink, not a source).
 */

/** `details.outcome` vocabulary the consult tool itself can report (src/consult/tool.ts's `ConsultOutcome`). */
export const CONSULT_OUTCOMES = [
  "completed",
  "unavailable",
  "still_running",
  "busy",
  "context_too_large",
  "cost_too_high",
  "timeout",
  "turn_cap",
  "cost_cap",
  "failed",
  "aborted",
] as const;

/**
 * Full classification vocabulary: the tool's own outcomes, plus three
 * classifier-only values for calls that never produced a `details.outcome`
 * at all — `bad_ref` (the asking model named an expert outside its
 * whitelist; `matchExpertRef` throws), `invalid` (any other throw — empty
 * question, or a validation failure pi turned into an error tool result),
 * and `unknown` (a non-error result whose `details.outcome` is missing or
 * not one of `CONSULT_OUTCOMES` — defensive: a future tool version adding an
 * outcome must not crash this classifier).
 */
export type ConsultCallResult = (typeof CONSULT_OUTCOMES)[number] | "bad_ref" | "invalid" | "unknown";

/**
 * Substring of `matchExpertRef`'s throw message (src/consult/tool.ts) that
 * distinguishes a whitelist mismatch (`bad_ref`) from every other throw
 * (`invalid`, e.g. an empty question). `tool.ts`'s throw text must keep
 * referencing this constant so the two sides never drift apart.
 */
export const CONSULT_NOT_IN_WHITELIST_MARK = "is not in this run's expert whitelist";

export interface ConsultCallFact {
  result: ConsultCallResult;
  expertRunId?: string;
  costUsd?: number;
  truncated?: true;
  partial?: true;
}

export interface ConsultSummary {
  calls: number;
  byResult: Partial<Record<ConsultCallResult, number>>;
  truncated: number;
  partial: number;
  /**
   * Sum of each call's `details.costUsd`. This is already included in the
   * asking run's `diag.usage` via X12 (consult cost rides the absorbed-run
   * mechanism) — this field is a display-only breakdown and must never be
   * added to `usage` a second time.
   */
  costUsd: number;
  /** Calls that reached a spawned consult run (a post-spawn outcome) but reported no/zero cost (e.g. a pool with flat pricing). */
  unpricedCalls: number;
  /** Sum of each call's observed tool wall-clock time (tool_start -> tool_end); a call with no determinable start contributes 0 here and increments `latencyUnknown` instead. */
  latencyMs: number;
  /** The largest single call's latency observed so far (0 when none had a determinable start). */
  maxLatencyMs: number;
  /** Count of calls whose tool_start could not be found (ring-evicted toolHistory and no matching currentTool either). */
  latencyUnknown: number;
  /**
   * Per-expert call counts, keyed by `expertRunId`. Review §8 M3 (frozen cap
   * is total, not "real keys plus overflow"): at most 16 keys in this object
   * TOTAL, `"_other"` included — the first 15 distinct experts each get
   * their own key, everything after that folds into `"_other"` (which then
   * occupies the 16th and last slot).
   */
  byExpert?: Record<string, number>;
}

/** Review §8 M3: total key budget for `ConsultSummary.byExpert`, `"_other"` key name included. */
const BY_EXPERT_MAX_TOTAL_KEYS = 16;
const BY_EXPERT_OTHER_KEY = "_other";

/** Post-spawn outcomes: the tool actually started a consult run and (when `outcome.usage` was present) reported its cost. */
const POST_SPAWN_RESULTS: ReadonlySet<ConsultCallResult> = new Set([
  "completed",
  "failed",
  "timeout",
  "turn_cap",
  "cost_cap",
  "aborted",
]);

function isConsultOutcome(value: unknown): value is (typeof CONSULT_OUTCOMES)[number] {
  return typeof value === "string" && (CONSULT_OUTCOMES as readonly string[]).includes(value);
}

/** Join every text content block of a tool result (works for pi's thrown-error shape: `content[0].text = message`). */
function extractResultText(result: unknown): string {
  if (result === null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

function extractDetails(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object") return {};
  const details = (result as { details?: unknown }).details;
  return details !== null && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : {};
}

/**
 * Classify one observed consult `tool_end` (driver-mapped `isError` +
 * pi's raw tool result) into a `ConsultCallFact`.
 *
 * - `isError` and the result text contains `CONSULT_NOT_IN_WHITELIST_MARK` -> `bad_ref`.
 * - `isError` otherwise (e.g. an empty question) -> `invalid`.
 * - Not an error: `details.outcome` when it is one of `CONSULT_OUTCOMES`, else `unknown`.
 */
export function classifyConsultToolEnd(isError: boolean, result: unknown): ConsultCallFact {
  if (isError) {
    const text = extractResultText(result);
    return { result: text.includes(CONSULT_NOT_IN_WHITELIST_MARK) ? "bad_ref" : "invalid" };
  }
  const details = extractDetails(result);
  const outcome: ConsultCallResult = isConsultOutcome(details.outcome) ? details.outcome : "unknown";
  const fact: ConsultCallFact = { result: outcome };
  if (typeof details.expertRunId === "string" && details.expertRunId.length > 0) fact.expertRunId = details.expertRunId;
  if (typeof details.costUsd === "number" && Number.isFinite(details.costUsd)) fact.costUsd = details.costUsd;
  if (details.truncated === true) fact.truncated = true;
  if (details.partial === true) fact.partial = true;
  return fact;
}

function foldByExpert(
  prev: Record<string, number> | undefined,
  expertRunId: string | undefined,
): Record<string, number> | undefined {
  if (expertRunId === undefined) return prev;
  const byExpert = { ...(prev ?? {}) };
  if (Object.prototype.hasOwnProperty.call(byExpert, expertRunId)) {
    byExpert[expertRunId] = byExpert[expertRunId]! + 1;
    return byExpert;
  }
  // Review §8 M3: "_other" itself occupies one of the 16 total slots, so real
  // (non-"_other") keys are capped at 15 — the 16th slot is reserved for
  // "_other" the moment it is first needed, guaranteeing
  // `Object.keys(byExpert).length <= BY_EXPERT_MAX_TOTAL_KEYS` forever.
  const realKeyCount = Object.keys(byExpert).filter((k) => k !== BY_EXPERT_OTHER_KEY).length;
  const key = realKeyCount < BY_EXPERT_MAX_TOTAL_KEYS - 1 ? expertRunId : BY_EXPERT_OTHER_KEY;
  byExpert[key] = (byExpert[key] ?? 0) + 1;
  return byExpert;
}

function emptySummary(): ConsultSummary {
  return {
    calls: 0,
    byResult: {},
    truncated: 0,
    partial: 0,
    costUsd: 0,
    unpricedCalls: 0,
    latencyMs: 0,
    maxLatencyMs: 0,
    latencyUnknown: 0,
  };
}

/**
 * Fold one `ConsultCallFact` (plus its resolved tool wall-clock latency,
 * when determinable) into the run's running `ConsultSummary`. Pure,
 * immutable — never mutates `prev`.
 */
export function foldConsultCall(
  prev: ConsultSummary | undefined,
  f: ConsultCallFact,
  latencyMs: number | undefined,
): ConsultSummary {
  const base = prev ?? emptySummary();
  const byResult = { ...base.byResult };
  byResult[f.result] = (byResult[f.result] ?? 0) + 1;
  const costAdd = typeof f.costUsd === "number" && Number.isFinite(f.costUsd) ? f.costUsd : 0;
  const isPostSpawn = POST_SPAWN_RESULTS.has(f.result);
  const unpriced = isPostSpawn && (f.costUsd === undefined || f.costUsd === 0) ? 1 : 0;
  const hasLatency = typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0;
  const latencyAdd = hasLatency ? latencyMs : 0;
  const summary: ConsultSummary = {
    calls: base.calls + 1,
    byResult,
    truncated: base.truncated + (f.truncated === true ? 1 : 0),
    partial: base.partial + (f.partial === true ? 1 : 0),
    costUsd: base.costUsd + costAdd,
    unpricedCalls: base.unpricedCalls + unpriced,
    latencyMs: base.latencyMs + latencyAdd,
    maxLatencyMs: hasLatency ? Math.max(base.maxLatencyMs, latencyMs) : base.maxLatencyMs,
    latencyUnknown: base.latencyUnknown + (hasLatency ? 0 : 1),
  };
  const byExpert = foldByExpert(base.byExpert, f.expertRunId);
  if (byExpert !== undefined) summary.byExpert = byExpert;
  return summary;
}
