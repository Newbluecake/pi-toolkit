import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  REQUEST_TIMEOUT_MS,
  backoffDelay,
  isRetryableError,
  redactSecrets,
  sleep,
  withRequestTimeout,
} from "../../src/web-search/resilience.js";

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
