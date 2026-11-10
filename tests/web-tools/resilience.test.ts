import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  REQUEST_TIMEOUT_MS,
  backoffDelay,
  isRetryableError,
  sleep,
  withRequestTimeout,
  webToolErrorSummary,
} from "../../src/web-tools/resilience.js";
import { redactSecrets } from "../../src/core/redact.js";

describe("isRetryableError", () => {
  it("never retries 401/403 auth failures", () => {
    expect(isRetryableError(new HttpError("unauthorized", 401), 401, "bad key")).toBe(false);
    expect(isRetryableError(new HttpError("forbidden", 403), 403, undefined)).toBe(false);
  });

  it("does not retry 429 when the body says quota is exhausted", () => {
    const bodies = [
      "You have run out of searches for this month",
      "quota exceeded",
      "insufficient balance",
      "Insufficient Quota",
      "searches limit reached",
    ];
    for (const body of bodies) {
      expect(isRetryableError(new HttpError("rate limited", 429, body), 429, body)).toBe(false);
    }
  });

  it("retries plain 429 without quota-exhaustion wording", () => {
    expect(isRetryableError(new HttpError("rate limited", 429, "slow down"), 429, "slow down")).toBe(true);
    expect(isRetryableError(new HttpError("rate limited", 429), 429, undefined)).toBe(true);
  });

  it("retries 5xx and 408/425 statuses", () => {
    for (const status of [408, 425, 500, 502, 503, 504]) {
      expect(isRetryableError(new HttpError("boom", status), status, undefined)).toBe(true);
    }
  });

  it("does not retry other 4xx statuses", () => {
    for (const status of [400, 404, 422]) {
      expect(isRetryableError(new HttpError("boom", status), status, undefined)).toBe(false);
    }
  });

  it("retries transient network-level failures (no HTTP status)", () => {
    const messages = [
      "fetch failed",
      "network request failed: socket hang up",
      "request timed out after 15s",
      "connect ECONNREFUSED 1.2.3.4",
      "getaddrinfo ENOTFOUND example.com",
      "getaddrinfo EAI_AGAIN example.com",
      "read ECONNRESET",
      "network ETIMEDOUT",
    ];
    for (const message of messages) {
      expect(isRetryableError(new Error(message), undefined, undefined)).toBe(true);
    }
    // Non-Error values are stringified before matching.
    expect(isRetryableError("fetch failed", undefined, undefined)).toBe(true);
  });

  it("does not retry unknown errors or cancellations", () => {
    expect(isRetryableError(new Error("returned invalid JSON"), undefined, undefined)).toBe(false);
    expect(isRetryableError(new Error("Web search cancelled."), undefined, undefined)).toBe(false);
    expect(isRetryableError(new Error("boom: Web search cancelled."), 500, undefined)).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially with jitter inside expected ranges", () => {
    for (let i = 0; i < 50; i++) {
      const first = backoffDelay(1);
      expect(first).toBeGreaterThanOrEqual(500);
      expect(first).toBeLessThan(700);
      const second = backoffDelay(2);
      expect(second).toBeGreaterThanOrEqual(1000);
      expect(second).toBeLessThan(1200);
      const third = backoffDelay(3);
      expect(third).toBeGreaterThanOrEqual(2000);
      expect(third).toBeLessThan(2200);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts api key query parameters", () => {
    expect(redactSecrets("GET https://x.test/?q=a&api_key=SECRET123&num=5", [])).toBe(
      "GET https://x.test/?q=a&api_key=[REDACTED]&num=5",
    );
    // The pattern anchors on ?/& — a bare "apikey=" prefix is intentionally not redacted.
    expect(redactSecrets("https://x.test/?apikey=ABC&other=1", [])).toBe("https://x.test/?apikey=[REDACTED]&other=1");
    expect(redactSecrets("https://x.test/?key=K9", [])).toBe("https://x.test/?key=[REDACTED]");
  });

  it("redacts bearer authorization headers", () => {
    expect(redactSecrets("Authorization: Bearer tok-abc-123 failed", [])).toBe(
      "Authorization: Bearer [REDACTED] failed",
    );
  });

  it("redacts literal secret occurrences and skips empty secrets", () => {
    expect(redactSecrets("key sk-live-xyz rejected", ["sk-live-xyz", ""])).toBe("key [REDACTED] rejected");
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the delay (fake timers)", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const pending = sleep(1000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it("rejects with the cancellation error when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Web search cancelled.");
  });
});

describe("withRequestTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through a successful action result", async () => {
    const result = await withRequestTimeout(undefined, async () => "ok");
    expect(result).toBe("ok");
  });

  it("rethrows action errors unchanged when not timed out", async () => {
    await expect(
      withRequestTimeout(undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("converts an aborting action into a timeout error after the budget", async () => {
    vi.useFakeTimers();
    const pending = withRequestTimeout(
      undefined,
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("request timeout")), { once: true });
        }),
    );
    const assertion = expect(pending).rejects.toThrow(`request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it("aborts the inner signal when the parent aborts", async () => {
    const parent = new AbortController();
    const pending = withRequestTimeout(
      parent.signal,
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by parent")), { once: true });
        }),
    );
    parent.abort();
    await expect(pending).rejects.toThrow("aborted by parent");
  });
});

const AUTH_GUIDANCE = "Check the provider API credentials and permissions.";
const QUOTA_GUIDANCE = "Check the provider quota or billing; try another configured provider.";
const TRANSIENT_GUIDANCE = "Try again later or use another configured provider.";
const UNKNOWN_GUIDANCE = "Check provider availability and request settings; try another configured provider.";

describe("webToolErrorSummary public boundary", () => {
  it.each([
    [401, "auth", AUTH_GUIDANCE],
    [403, "auth", AUTH_GUIDANCE],
    [402, "quota", QUOTA_GUIDANCE],
    [429, "quota", QUOTA_GUIDANCE],
    [408, "transient", TRANSIENT_GUIDANCE],
    [425, "transient", TRANSIENT_GUIDANCE],
    [500, "transient", TRANSIENT_GUIDANCE],
    [501, "transient", TRANSIENT_GUIDANCE],
    [502, "transient", TRANSIENT_GUIDANCE],
    [503, "transient", TRANSIENT_GUIDANCE],
    [504, "transient", TRANSIENT_GUIDANCE],
    [599, "transient", TRANSIENT_GUIDANCE],
    [200, "unknown", UNKNOWN_GUIDANCE],
    [400, "unknown", UNKNOWN_GUIDANCE],
    [404, "unknown", UNKNOWN_GUIDANCE],
    [422, "unknown", UNKNOWN_GUIDANCE],
  ])("uses structured HTTP %i, not body or message hints", (status, category, guidance) => {
    const poison = "https://user:password@invalid.test/?ticket=secret auth quota exceeded reset tomorrow z8Q";
    const error = new HttpError(poison, Number(status), poison);
    expect(webToolErrorSummary(error)).toBe(`${category} (HTTP ${status}): ${guidance}`);
    // Keep the original body available for retry decisions, not public diagnostics.
    expect(error.responseBody).toBe(poison);
  });

  it.each([undefined, NaN, Infinity, -1, 99, 600, 401.5])("rejects invalid/missing status %s", (status) => {
    expect(webToolErrorSummary(new HttpError("401 unauthorized", status, "quota exceeded"))).toBe(
      `unknown: ${UNKNOWN_GUIDANCE}`,
    );
  });

  it("does not infer status from strings, object fields, or exception text", () => {
    for (const error of [
      new Error("HTTP 401 quota exceeded network request failed"),
      "HTTP 429",
      { status: 403, message: "Unauthorized" },
      {
        toString: () => {
          throw new Error("must not stringify arbitrary input");
        },
      },
      null,
      undefined,
    ]) {
      expect(webToolErrorSummary(error)).toBe(`unknown: ${UNKNOWN_GUIDANCE}`);
    }
  });

  it("drops short sentinels and arbitrarily long multibyte/control-character payloads entirely", () => {
    for (const payload of ["z8Q", "界🙂\u0000\u001b[31m\r\n\t".repeat(20_000)]) {
      const summary = webToolErrorSummary(new HttpError(payload, 429, payload));
      expect(summary).toBe(`quota (HTTP 429): ${QUOTA_GUIDANCE}`);
      expect(Buffer.byteLength(summary)).toBeLessThan(150);
      expect(summary).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
  });

  it("leaves quota-body retry policy separate from the identical public category", () => {
    const exhausted = new HttpError("untrusted", 429, "quota exceeded z8Q");
    const limited = new HttpError("untrusted", 429, "z8Q");
    expect(webToolErrorSummary(exhausted)).toBe(webToolErrorSummary(limited));
    expect(isRetryableError(exhausted, exhausted.status, exhausted.responseBody)).toBe(false);
    expect(isRetryableError(limited, limited.status, limited.responseBody)).toBe(true);
    // All 5xx classify as transient, but the existing narrower retry allowlist is unchanged.
    expect(isRetryableError(new HttpError("untrusted", 501), 501, undefined)).toBe(false);
  });
});
