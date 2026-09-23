import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT, QUOTA_MAX_ATTEMPTS, createFetchJson } from "../../src/quota/http.js";

const URL_UNDER_TEST = "https://quota.example.test/api/monitor/usage/quota/limit";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(status === 200 ? {} : { statusText: "Error" }),
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createFetchJson", () => {
  it("returns the parsed object for 200 + JSON", async () => {
    const fetchJson = createFetchJson({
      fetchImpl: async () => jsonResponse({ code: 200, data: { level: "max" } }),
    });
    await expect(fetchJson(URL_UNDER_TEST, { headers: {} })).resolves.toEqual({ code: 200, data: { level: "max" } });
  });

  it("resolves undefined for 200 + non-JSON body, without throwing", async () => {
    const fetchJson = createFetchJson({
      fetchImpl: async () => new Response("<html>not json</html>", { status: 200 }),
    });
    await expect(fetchJson(URL_UNDER_TEST, { headers: {} })).resolves.toBeUndefined();
  });

  it("does not retry a 403 (exactly one fetch call) and resolves undefined", async () => {
    const calls: string[] = [];
    const fetchJson = createFetchJson({
      fetchImpl: async (url) => {
        calls.push(String(url));
        return jsonResponse({ error: "forbidden" }, 403);
      },
    });
    vi.useFakeTimers();
    await expect(fetchJson(URL_UNDER_TEST, { headers: {} })).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("retries a 500 exactly once then gives up (QUOTA_MAX_ATTEMPTS = 1 + 1)", async () => {
    expect(QUOTA_MAX_ATTEMPTS).toBe(2);
    const calls: number[] = [];
    const fetchJson = createFetchJson({
      fetchImpl: async () => {
        calls.push(calls.length + 1);
        return jsonResponse({ error: "boom" }, 500);
      },
    });
    vi.useFakeTimers();
    const pending = fetchJson(URL_UNDER_TEST, { headers: {} });
    await vi.advanceTimersByTimeAsync(60_000); // 覆盖 backoffDelay(~500-700ms) + 第二次尝试
    await expect(pending).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("resolves undefined when the request times out (fake fetch + fake timers)", async () => {
    vi.useFakeTimers();
    const fetchJson = createFetchJson({
      fetchImpl: () => new Promise<Response>(() => {}), // never settles
      timeoutMs: 1_000,
      maxAttempts: 1,
    });
    const pending = fetchJson(URL_UNDER_TEST, { headers: {} });
    const assertion = expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("unrefs the underlying timeout timer (pi print-mode rule)", async () => {
    const unrefCalls: Array<number | undefined> = [];
    const realSetTimeout = globalThis.setTimeout;
    const wrapped = ((handler: TimerHandler, timeout?: number) => {
      const handle = realSetTimeout(handler, timeout);
      if (handle && typeof (handle as { unref?: unknown }).unref === "function") {
        const original = (handle as NodeJS.Timeout).unref.bind(handle);
        (handle as NodeJS.Timeout).unref = () => {
          unrefCalls.push(timeout);
          original();
        };
      }
      return handle;
    }) as typeof setTimeout;
    vi.stubGlobal("setTimeout", wrapped);
    const fetchJson = createFetchJson({
      fetchImpl: () => new Promise<Response>(() => {}), // never settles
      timeoutMs: 20,
      maxAttempts: 1,
    });
    await expect(fetchJson(URL_UNDER_TEST, { headers: {} })).resolves.toBeUndefined();
    expect(unrefCalls.length).toBeGreaterThan(0); // timer 被创建且 unref 过
  });

  it("redacts secrets from the WARN text", async () => {
    const warnings: string[] = [];
    const fetchJson = createFetchJson({
      fetchImpl: async () => {
        throw new Error("connect failed for sk-live-secret-123");
      },
      secrets: ["sk-live-secret-123"],
      warn: (message) => warnings.push(message),
      maxAttempts: 1,
    });
    await expect(fetchJson(URL_UNDER_TEST, { headers: {} })).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("sk-live-secret-123");
    expect(warnings[0]).toContain("[REDACTED]");
  });

  it("resolves undefined when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchJson = createFetchJson({
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    await expect(fetchJson(URL_UNDER_TEST, { headers: {}, signal: controller.signal })).resolves.toBeUndefined();
  });
});

describe("DEFAULT_USER_AGENT", () => {
  it("is a non-empty browser string without node/curl tokens", () => {
    expect(DEFAULT_USER_AGENT.length).toBeGreaterThan(0);
    expect(DEFAULT_USER_AGENT).toMatch(/Mozilla\/5\.0/);
    expect(DEFAULT_USER_AGENT).not.toMatch(/node/i);
    expect(DEFAULT_USER_AGENT).not.toMatch(/curl/i);
  });
});
