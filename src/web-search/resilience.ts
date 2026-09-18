/**
 * Retry/timeout/secret-redaction primitives for the web_search tool.
 * Pure logic plus timers — every timer is unref'd (pi print-mode rule).
 */

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries

/** Error carrying an HTTP status so the caller can decide whether to retry. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number | undefined,
    readonly responseBody?: string | undefined,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// Quota exhaustion is permanent within the billing window — retrying only wastes time.
const QUOTA_EXHAUSTION_PATTERN = /run out of searches|quota exceeded|insufficient (balance|quota)|searches.*limit/i;

export function isRetryableError(
  error: unknown,
  status: number | undefined,
  responseBody: string | undefined,
): boolean {
  if (error instanceof Error && /Web search cancelled/.test(error.message)) return false;
  if (status !== undefined) {
    if (status === 401 || status === 403) return false; // auth problems never resolve by retrying
    if (status === 429) return !QUOTA_EXHAUSTION_PATTERN.test(responseBody ?? "");
    return RETRYABLE_HTTP_STATUSES.has(status);
  }
  // Network-level failures (fetch failed, DNS, ECONN, timeout) are often transient.
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network request failed|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|read ECONN/i.test(
    message,
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error("Web search cancelled."));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function backoffDelay(attempt: number): number {
  // attempt is 1-based: ~500ms then ~1000ms, with jitter to avoid thundering herd.
  return 500 * 2 ** (attempt - 1) + Math.random() * 200;
}

export async function withRequestTimeout<T>(
  parentSignal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("request timeout"));
  }, REQUEST_TIMEOUT_MS);
  timeout.unref();

  try {
    return await action(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function redactSecrets(message: string, secrets: string[]): string {
  let redacted = message
    .replace(/([?&](?:api_key|apikey|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");

  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function errorMessage(error: unknown, secrets: string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message, secrets);
}
