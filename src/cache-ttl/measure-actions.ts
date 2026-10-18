/**
 * THE single outcome → action table of `/cache-ttl measure` (measure-plan.md r4 §4.2), used by the runner and read by
 * the tests row by row. Pure and pi-free.
 *
 * Flow: a transport `PipelineOutcome` (+ the strict reader's `UsageReading`) is mapped to a {@link MeasureOutcomeClass}
 * by {@link classifyMeasureOutcome}; the class and the request kind index {@link MEASURE_ACTION_TABLE}; the runner
 * then calls {@link resolveMeasureAction} so the two data-dependent failure reasons (`payload:<code>`, `http-<status>`)
 * are filled in. Table cells for those two reasons hold a template reason (`payload:*` / `http-*`) that
 * `resolveMeasureAction` always replaces.
 */

import type { PipelineOutcome } from "./pipeline-ping-types.js";
import {
  MEASURE_TIMING,
  type MeasureAction,
  type MeasureActionTable,
  type MeasureFailReason,
  type MeasureOutcomeClass,
  type MeasureRequestKind,
  type UsageReading,
} from "./measure-types.js";

/** Template failure reasons stored in the table; always replaced by {@link resolveMeasureAction}. */
export const PAYLOAD_REASON_TEMPLATE = "payload:*" as unknown as MeasureFailReason;
export const HTTP_REASON_TEMPLATE = "http-*" as unknown as MeasureFailReason;

const failedAll = (reason: MeasureFailReason): MeasureAction => ({ kind: "failed", reason });
const failedRow = (reason: MeasureFailReason) =>
  ({
    write: failedAll(reason),
    control: failedAll(reason),
    probe: failedAll(reason),
    renewal: failedAll(reason),
  }) as const;

const NOT_SENT_REPLACEMENT: MeasureAction = { kind: "replacement", possiblyBilled: false, nonceBurned: false };

export const MEASURE_ACTION_TABLE: MeasureActionTable = {
  // not-sent guard/deadline/aborted/provider-error
  "not-sent-transient": {
    write: NOT_SENT_REPLACEMENT,
    control: { kind: "retry-control", possiblyBilled: false },
    probe: { kind: "inconclusive", reason: "not-sent", possiblyBilled: false },
    renewal: { kind: "renewal-unknown", reason: "not-sent", possiblyBilled: false },
  },
  // the lateness guard refused a timed send (zero cost). A write is not timed, so its cell is the transient one.
  "not-sent-late": {
    write: NOT_SENT_REPLACEMENT,
    control: { kind: "retry-control", possiblyBilled: false },
    probe: { kind: "inconclusive", reason: "late", possiblyBilled: false },
    renewal: { kind: "renewal-unknown", reason: "late", possiblyBilled: false },
  },
  "not-sent-auth": failedRow("auth"),
  // capability + `measured.rejection`: only a build-mode write can produce one
  "not-sent-rejected": {
    write: failedAll(PAYLOAD_REASON_TEMPLATE),
    control: failedAll("route"),
    probe: failedAll("route"),
    renewal: failedAll("route"),
  },
  // capability + route/model mismatch
  "not-sent-route": failedRow("route"),
  "http-redirect": failedRow("redirect"),
  "http-auth": failedRow("auth-http"),
  "http-429": {
    write: { kind: "replacement", possiblyBilled: false, nonceBurned: false, waitMs: MEASURE_TIMING.rateLimitWaitMs },
    control: { kind: "retry-control", possiblyBilled: false, flagRateLimited: true },
    probe: { kind: "inconclusive", reason: "rate-limited", possiblyBilled: false, flagRateLimited: true },
    renewal: { kind: "renewal-unknown", reason: "rate-limited", possiblyBilled: false },
  },
  "http-4xx": {
    write: failedAll(HTTP_REASON_TEMPLATE),
    control: failedAll(HTTP_REASON_TEMPLATE),
    probe: failedAll(HTTP_REASON_TEMPLATE),
    renewal: { kind: "renewal-unknown", reason: "http", possiblyBilled: false },
  },
  "http-5xx": {
    write: NOT_SENT_REPLACEMENT,
    control: { kind: "retry-control", possiblyBilled: false },
    probe: { kind: "inconclusive", reason: "http-5xx", possiblyBilled: false },
    renewal: { kind: "renewal-unknown", reason: "http", possiblyBilled: false },
  },
  // network / accepted-then-lost / malformed / deadline after send: the server may have processed (and billed) it
  "sent-lost": {
    write: { kind: "replacement", possiblyBilled: true, nonceBurned: true },
    control: { kind: "retry-control", possiblyBilled: true },
    probe: { kind: "inconclusive", reason: "sent-lost", possiblyBilled: true },
    renewal: { kind: "renewal-unknown", reason: "sent-lost", possiblyBilled: true },
  },
  // a usage frame arrived but `cacheEvidence` is invalid: billed, but proves nothing
  "usage-invalid": {
    write: { kind: "replacement", possiblyBilled: true, nonceBurned: true },
    control: { kind: "retry-control", possiblyBilled: true },
    probe: { kind: "inconclusive", reason: "no-usage", possiblyBilled: true },
    renewal: { kind: "renewal-unknown", reason: "no-usage", possiblyBilled: true },
  },
  "usage-valid": {
    write: { kind: "anchor" },
    control: { kind: "classify" },
    probe: { kind: "classify" },
    renewal: { kind: "evaluate-renewal" },
  },
};

export interface ClassifyOutcomeFlags {
  /** The runner's guard refused the send because it was later than `due + max(30 s, 10 %·gap)`. */
  lateRefused?: boolean;
}

/** Map a transport outcome (+ the strict reader's result for `usage` outcomes) to a table row (§4.2). */
export function classifyMeasureOutcome(
  outcome: PipelineOutcome,
  reading: UsageReading | undefined,
  flags: ClassifyOutcomeFlags = {},
): MeasureOutcomeClass {
  switch (outcome.kind) {
    case "not-sent":
      if (outcome.reason === "auth") return "not-sent-auth";
      if (outcome.reason === "capability") {
        return outcome.measured?.rejection !== undefined ? "not-sent-rejected" : "not-sent-route";
      }
      if (outcome.reason === "guard" && flags.lateRefused === true) return "not-sent-late";
      return "not-sent-transient";
    case "http": {
      const s = outcome.status;
      if (s >= 500) return "http-5xx";
      if (s >= 300 && s < 400) return "http-redirect";
      if (s === 401 || s === 403) return "http-auth";
      if (s === 429) return "http-429";
      if (s >= 400) return "http-4xx";
      return "sent-lost"; // a non-2xx `http` outcome below 300 cannot be trusted either way
    }
    case "usage":
      return reading !== undefined && reading.cacheEvidence.kind === "valid" ? "usage-valid" : "usage-invalid";
    case "accepted-then-lost":
    case "network":
    case "malformed":
      return "sent-lost";
  }
}

/** The base fetch was invoked (the request consumes the cap whatever its outcome — §4.1). */
export function wasSent(outcome: PipelineOutcome): boolean {
  return outcome.kind !== "not-sent" && outcome.diag.baseFetchCalls >= 1;
}

export interface ResolveDetail {
  /** `measured.rejection` of a `not-sent-rejected` outcome. */
  rejection?: string;
  /** HTTP status of an `http-4xx` outcome. */
  httpStatus?: number;
}

/** Table lookup + fill-in of the two data-dependent failure reasons. */
export function resolveMeasureAction(
  cls: MeasureOutcomeClass,
  kind: MeasureRequestKind,
  detail: ResolveDetail = {},
): MeasureAction {
  const cell = MEASURE_ACTION_TABLE[cls][kind];
  if (cell.kind !== "failed") return cell;
  if (cell.reason === PAYLOAD_REASON_TEMPLATE) {
    return { kind: "failed", reason: `payload:${detail.rejection ?? "extra-input"}` as MeasureFailReason };
  }
  if (cell.reason === HTTP_REASON_TEMPLATE) {
    return { kind: "failed", reason: `http-${detail.httpStatus ?? 400}` };
  }
  return cell;
}
