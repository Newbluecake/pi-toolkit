/** Droid auth failures can arrive as RPC errors, error notifications, or early-exit stderr.
 * Only fixed classifications reach provider availability — never raw CLI output/credentials.
 * Bare model_usage_exhausted is quota exhaustion, NOT provider-wide auth unavailability.
 */
import type { ErrorInfo } from "../../core/types.js";
import type { ExternalAvailabilitySource, ExternalFrameworkDeps } from "../types.js";
import { msgAuthFailure } from "../messages.js";

/** Require HTTP/error context, not an arbitrary timestamp/port/version containing 401–403. */
const HTTP_AUTH_STATUS_RE =
  /\b(?:HTTP(?:\/\d+(?:\.\d+)?)?|status(?:Code)?|code|error)\b[\s"'=:]+(40[123])\b(?!\.\d)|(?<![\w.])(40[123])\s+(?:Unauthorized|Payment\s+Required|Forbidden)\b/i;
const AUTH_CREDENTIAL_RE =
  /\bno\s+(?:access\s+)?token\b|\b(?:not authenticated|unauthenticated|unauthorized|authentication failed)\b|\b(?:invalid|expired|missing)\s+(?:access\s+|refresh\s+|auth\s+)?(?:token|credentials?|api[ _-]?key)\b|\b(?:access[ _-]?token|refresh[ _-]?token|api[ _-]?key|credentials?)\b.{0,32}\b(?:invalid|expired|missing)\b/i;
export const DROID_AUTH_ERROR_RE = new RegExp(`${HTTP_AUTH_STATUS_RE.source}|${AUTH_CREDENTIAL_RE.source}`, "i");

export function droidAuthFailureDetail(text: string): string | undefined {
  const http = HTTP_AUTH_STATUS_RE.exec(text);
  const status = http?.[1] ?? http?.[2];
  if (status !== undefined) return `Factory HTTP ${status}`;
  if (/\bno\s+(?:access\s+)?token\b/i.test(text)) return "No access token";
  return DROID_AUTH_ERROR_RE.test(text) ? "authentication failed (missing, expired or invalid credentials)" : undefined;
}

/** Classify before redaction (which can obscure the error), then redact the run's detail too. */
export function observeDroidAuthFailure(
  deps: ExternalFrameworkDeps,
  text: string,
  source: Exclude<ExternalAvailabilitySource, "quota"> = "run",
): ErrorInfo | undefined {
  const detail = droidAuthFailureDetail(text);
  if (detail === undefined) return undefined;
  deps.observeAvailability?.({ source, authError: detail });
  return { kind: "auth", retryable: false, message: msgAuthFailure(deps.redact(text).slice(0, 300)) };
}
