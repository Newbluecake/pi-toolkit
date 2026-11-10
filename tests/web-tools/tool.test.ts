import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { createWebFetchTool, createWebSearchTool, registerWebSearchTool } from "../../src/web-tools/index.js";

const transport = vi.hoisted(() => ({ httpsRequest: vi.fn(), httpsBodies: [] as string[] }));
vi.mock("node:https", () => ({ request: transport.httpsRequest }));
// Synthetic env only: do not load the credentials parser or read any real file.
vi.mock("../../src/web-tools/config.js", () => ({
  getSearchConfig: () => ({
    keys: {
      codex: process.env.CODEX_SEARCH_API_KEY ?? "",
      serpapi: process.env.SERPAPI_API_KEY ?? "",
      deepseek: process.env.DEEPSEEK_API_KEY ?? "",
      bocha: process.env.BOCHA_API_KEY ?? "",
      tavily: process.env.TAVILY_API_KEY ?? "",
    },
    codex: {
      baseUrl: process.env.CODEX_SEARCH_BASE_URL ?? "",
      model: process.env.CODEX_SEARCH_MODEL ?? "gpt-5.6-sol",
      insecureTls: process.env.CODEX_SEARCH_TLS_INSECURE === "true",
    },
  }),
}));

const ENV_KEYS = [
  "CODEX_SEARCH_API_KEY",
  "CODEX_SEARCH_BASE_URL",
  "CODEX_SEARCH_MODEL",
  "CODEX_SEARCH_TLS_INSECURE",
  "SERPAPI_API_KEY",
  "DEEPSEEK_API_KEY",
  "BOCHA_API_KEY",
  "TAVILY_API_KEY",
  "PI_WEB_SEARCH_ENV_FILE",
] as const;

const savedEnv = new Map<string, string | undefined>();

function clearSearchEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  // Isolate from the developer machine's real credentials file.
  process.env.PI_WEB_SEARCH_ENV_FILE = "/nonexistent/pi-web-search-test.env";
}

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  clearSearchEnv();
  // Both transports fail closed, including tests without explicit responses.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected mocked fetch request");
    }),
  );
  transport.httpsBodies.length = 0;
  transport.httpsRequest.mockReset().mockImplementation(() => {
    throw new Error("Unexpected mocked HTTPS request");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const key of ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(status === 200 ? {} : { statusText: "Error" }),
    headers: { "Content-Type": "application/json" },
  });
}

type Update = { content: Array<{ type: string; text: string }> };

function collectUpdates(): { updates: Update[]; onUpdate: (update: Update) => void } {
  const updates: Update[] = [];
  return { updates, onUpdate: (update: Update) => updates.push(update) };
}

async function executeTool(params: Record<string, unknown>, onUpdate?: (update: Update) => void) {
  const tool = createWebSearchTool();
  // ExtensionContext is unused by this tool; cast mirrors other tool tests in the repo.
  return tool.execute("call-1", params as never, undefined, onUpdate as never, {} as never);
}

function firstText(result: Awaited<ReturnType<typeof executeTool>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("registerWebSearchTool", () => {
  it("registers web_search and web_fetch on the pi extension API", () => {
    const registered: ToolDefinition[] = [];
    const fakePi = {
      registerTool(tool: ToolDefinition): void {
        registered.push(tool);
      },
    } as unknown as ExtensionAPI;
    registerWebSearchTool(fakePi);
    expect(registered.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
    expect(registered[0]?.promptSnippet).toContain("provider failover");
  });
});

describe("web_search execute", () => {
  it("fails fast when no provider credentials are configured", async () => {
    await expect(executeTool({ query: "anything" })).rejects.toThrow("No web search provider is configured");
  });

  it("returns results from the preferred provider on success", async () => {
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        answer: "short answer",
        results: [{ title: "T1", url: "https://t1.example", content: "c1", score: 0.9 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { updates, onUpdate } = collectUpdates();
    const result = await executeTool({ query: "q", num: 3 }, onUpdate);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.tavily.com/search");
    const text = firstText(result);
    expect(text).toContain('Top 1 result(s) for "q" via Tavily:');
    expect(text).toContain("1. T1");
    expect(result.details).toMatchObject({ provider: "tavily", failover: false });
    expect(updates[0]?.content[0]?.text).toBe("Searching via Tavily.");
  });

  it("fails over to the next configured provider after a 401", async () => {
    process.env.SERPAPI_API_KEY = "serp-key";
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Invalid API key", { status: 401, statusText: "Unauthorized" }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ title: "T1", url: "https://t1.example", content: "c1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const { updates, onUpdate } = collectUpdates();
    const result = await executeTool({ query: "q" }, onUpdate);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("serpapi.com");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.tavily.com/search");

    const text = firstText(result);
    expect(text.startsWith("Automatic failover: SerpAPI failed; results are from Tavily.")).toBe(true);
    expect(text).not.toContain("serp-key");
    expect(result.details).toMatchObject({ provider: "tavily", failover: true });

    const updateTexts = updates.map((update) => update.content[0]?.text);
    expect(updateTexts).toContain("SerpAPI failed; switching to Tavily.");
    // A 401 is not retryable: no retry update for SerpAPI.
    expect(updateTexts.some((t) => t?.includes("retrying in"))).toBe(false);
  });

  it("aggregates per-provider errors when every configured provider fails", async () => {
    process.env.SERPAPI_API_KEY = "serp-key";
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("serpapi.com")) {
        return new Response("bad key serp-key", { status: 401, statusText: "Unauthorized" });
      }
      return new Response("Server exploded", { status: 500, statusText: "Internal Server Error" });
    });
    vi.stubGlobal("fetch", fetchMock);

    // Tavily's 500 IS retryable — retries sleep via backoffDelay; run with fake
    // timers advanced concurrently so the test stays fast.
    vi.useFakeTimers();
    const pending = executeTool({ query: "q" });
    const assertion = expect(pending).rejects.toThrow("Web search failed with all configured providers");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    await pending.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("SerpAPI: auth (HTTP 401): Check the provider API credentials and permissions.");
      expect(message).toContain("Tavily: transient (HTTP 500): Try again later or use another configured provider.");
      expect(message).not.toContain("serp-key");
      expect(message).not.toContain("Server exploded");
    });
    // 1 SerpAPI (no retry on 401) + 3 Tavily attempts (initial + 2 retries).
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("maps DeepSeek results onto the model-facing summary field and rerank score", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          {
            rerank_score: 0.97,
            title: "D1",
            url: "https://d1.example",
            snippet: "short ui snippet",
            summary: "long model-facing summary",
            content: "",
            site_name: "d1.example",
            date: "2026-11-01T00:00:00Z",
          },
          { title: "D2", url: "https://d2.example", snippet: "only snippet", date: null },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool({ query: "q", num: 2, provider: "deepseek" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer deepseek-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "q", count: 2, need_content: false });

    expect(result.details).toMatchObject({ provider: "deepseek", failover: false });
    const results = (result.details as { results: Array<Record<string, unknown>> }).results;
    // summary (not the UI snippet) is what the model sees.
    expect(results[0]).toMatchObject({
      title: "D1",
      snippet: "long model-facing summary",
      source: "d1.example",
      date: "2026-11-01T00:00:00Z",
      score: 0.97,
    });
    // Falls back to snippet when summary is absent; null date becomes undefined.
    expect(results[1]).toMatchObject({ title: "D2", snippet: "only snippet" });
    expect(results[1]?.date).toBeUndefined();
    const text = firstText(result);
    expect(text).toContain('Top 2 result(s) for "q" via DeepSeek:');
    expect(text).toContain("long model-facing summary");
    expect(text).not.toContain("deepseek-key");
  });

  it("auto chain fails over serpapi → deepseek → bocha → tavily by key availability", async () => {
    // No codex configured; deepseek must be attempted after serpapi and before bocha.
    process.env.SERPAPI_API_KEY = "serp-key";
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    process.env.BOCHA_API_KEY = "bocha-key";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("serpapi.com")) return new Response("bad", { status: 401, statusText: "Unauthorized" });
      if (url.includes("api.deepseek.com")) return new Response("bad", { status: 401, statusText: "Unauthorized" });
      return jsonResponse({ code: 200, data: { webPages: { value: [{ name: "B1", url: "https://b1.example" }] } } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTool({ query: "q" });

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).toHaveLength(3);
    expect(calledUrls[0]).toContain("serpapi.com");
    expect(calledUrls[1]).toBe("https://api.deepseek.com/v1/tools/search");
    expect(calledUrls[2]).toBe("https://api.bochaai.com/v1/web-search");
    const text = firstText(result);
    expect(text.startsWith("Automatic failover: SerpAPI, DeepSeek failed; results are from Bocha.")).toBe(true);
  });

  it("rejects an explicit deepseek preference when no key is configured, without any request", async () => {
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    // deepseek has no key ⇒ it drops out of the chain and tavily serves.
    const result = await executeTool({ query: "q", provider: "deepseek" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.tavily.com/search");
    expect(result.details).toMatchObject({ provider: "tavily", preferredProvider: "deepseek" });
  });
});

async function executeFetchTool(params: Record<string, unknown>, onUpdate?: (update: Update) => void) {
  const tool = createWebFetchTool();
  return tool.execute("call-1", params as never, undefined, onUpdate as never, {} as never);
}

describe("web_fetch execute", () => {
  it("fails fast without any fetch key and never issues a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeFetchTool({ url: "https://example.com" })).rejects.toThrow(
      "DEEPSEEK_API_KEY and/or TAVILY_API_KEY",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid and non-http(s) URLs before any request", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeFetchTool({ url: "not a url" })).rejects.toThrow("Invalid URL");
    await expect(executeFetchTool({ url: "file:///etc/passwd" })).rejects.toThrow("http(s)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the page title and Markdown content", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ title: "Example Page", content: "# Hello\n\nMarkdown body." }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFetchTool({ url: "https://example.com/page" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer deepseek-key");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://example.com/page" });

    expect(firstText(result)).toBe("# Example Page\n\n# Hello\n\nMarkdown body.");
    expect(result.details).toMatchObject({
      url: "https://example.com/page",
      title: "Example Page",
      truncated: false,
    });
  });

  it("propagates a sanitized provider error after non-retryable failure", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("bad key deepseek-key", { status: 401, statusText: "Unauthorized" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = executeFetchTool({ url: "https://example.com" });
    const assertion = expect(pending).rejects.toThrow(
      "Web fetch failed with all configured providers. DeepSeek: auth (HTTP 401)",
    );
    await assertion;
    await pending.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("deepseek-key");
      expect(message).toContain("Check the provider API credentials and permissions.");
      expect(message).not.toContain("bad key");
    });
    // 401 is not retryable: exactly one attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Tavily directly when only TAVILY_API_KEY is set", async () => {
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ results: [{ url: "https://example.com", raw_content: "# Hi\n\nBody." }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFetchTool({ url: "https://example.com" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.tavily.com/extract");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tavily-key");
    expect(JSON.parse(String(init.body))).toEqual({ urls: ["https://example.com"], format: "markdown" });
    expect(firstText(result)).toBe("# Hi\n\nBody.");
    expect(result.details).toMatchObject({ provider: "tavily", failover: false });
  });

  it("falls back to Tavily when DeepSeek returns a non-retryable 404", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        return jsonResponse({ error: { message: "failed to fetch URL" } }, 404);
      }
      if (url.includes("api.tavily.com")) {
        return jsonResponse({
          results: [{ url: "https://example.com/wiki/X", raw_content: "# X\n\nTavily body." }],
        });
      }
      throw new Error(`unexpected fetch target: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeFetchTool({ url: "https://example.com/wiki/X" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstText(result)).toBe("# X\n\nTavily body.");
    expect(result.details).toMatchObject({
      provider: "tavily",
      failover: true,
      failures: [{ provider: "deepseek" }],
    });
  });

  it("surfaces Tavily failed_results as a non-retryable error and reports both providers", async () => {
    process.env.DEEPSEEK_API_KEY = "deepseek-key";
    process.env.TAVILY_API_KEY = "tavily-key";
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        return jsonResponse({ error: { message: "failed to fetch URL" } }, 404);
      }
      return jsonResponse({
        results: [],
        failed_results: [{ url: "https://example.com/x", error: "upstream timeout" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(executeFetchTool({ url: "https://example.com/x" })).rejects.toThrow(
      /DeepSeek: unknown \(HTTP 404\).*Tavily: unknown \(HTTP 422\)/s,
    );
    // 404 deepseek + 422 tavily: both non-retryable, one attempt each.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Include credentials in userinfo and a nonstandard sensitive query key: these
// must not depend on a regex guessing which URL fragments are secrets.
const SENSITIVE_URL = "https://url-user:url-password@target.invalid/private?ticket=query-secret&key=x#fragment";
const SHORT_SENTINEL = "z8Q";
const LONG_PAYLOAD = `body-sentinel ${SENSITIVE_URL} ${SHORT_SENTINEL} ${"界🙂\u0000\u001b[31m\r\n\t".repeat(20_000)}`;
const AUTH_SUMMARY = "auth (HTTP 401): Check the provider API credentials and permissions.";
const UNKNOWN_GUIDANCE = "Check provider availability and request settings; try another configured provider.";

function assertSafeDiagnostics(output: unknown): void {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  for (const secret of [
    SENSITIVE_URL,
    "url-user",
    "url-password",
    "query-secret",
    SHORT_SENTINEL,
    "body-sentinel",
    "界",
    "🙂",
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(Buffer.byteLength(text)).toBeLessThan(3_000);
}

async function failureMessage(pending: Promise<unknown>): Promise<string> {
  // Attach the rejection handler before advancing fake timers.
  const observed = pending.then(
    () => {
      throw new Error("Expected the tool to fail");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      return (error as Error).message;
    },
  );
  await vi.advanceTimersByTimeAsync(10_000);
  return observed;
}

function mockHttpsResponse(status: number, body: string, networkError?: string): void {
  transport.httpsRequest.mockImplementation(
    (_url: URL, _options: unknown, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter();
      Object.assign(request, {
        end: vi.fn((body: string) => {
          transport.httpsBodies.push(body);
          queueMicrotask(() => {
            if (networkError !== undefined) {
              request.emit("error", new Error(networkError));
              return;
            }
            const response = Object.assign(new EventEmitter(), {
              statusCode: status,
              statusMessage: SHORT_SENTINEL,
              headers: {},
            });
            callback(response as IncomingMessage);
            response.emit("data", Buffer.from(body));
            response.emit("end");
          });
        }),
      });
      return request;
    },
  );
}

function configureCodex(): void {
  process.env.CODEX_SEARCH_API_KEY = "codex-test-key";
  process.env.CODEX_SEARCH_BASE_URL = SENSITIVE_URL;
  process.env.CODEX_SEARCH_TLS_INSECURE = "true";
}

describe("web tool diagnostic allowlist", () => {
  it.each(["not a url " + LONG_PAYLOAD, "ftp://url-user:url-password@target.invalid/?ticket=query-secret"])(
    "does not echo invalid/unsupported URL input (%#)",
    async (url) => {
      const { updates, onUpdate } = collectUpdates();
      const message = await executeFetchTool({ url }, onUpdate).then(
        () => {
          throw new Error("Expected URL validation failure");
        },
        (error: unknown) => (error as Error).message,
      );
      expect(message).toBe(
        url.startsWith("ftp:") ? "Only http(s) URLs can be fetched." : "Invalid URL. Provide an absolute http(s) URL.",
      );
      assertSafeDiagnostics(message);
      expect(updates).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(transport.httpsRequest).not.toHaveBeenCalled();
    },
  );

  describe.each(["search", "fetch"] as const)("%s HTTP failures", (kind) => {
    it.each([
      [401, "auth", 1],
      [403, "auth", 1],
      [402, "quota", 1],
      [429, "quota", 3],
      [408, "transient", 3],
      [425, "transient", 3],
      [500, "transient", 3],
      [501, "transient", 1],
      [502, "transient", 3],
      [503, "transient", 3],
      [504, "transient", 3],
      [599, "transient", 1],
      [400, "unknown", 1],
      [404, "unknown", 1],
      [422, "unknown", 1],
    ])("HTTP %i uses %s without exposing bodies; preserves %i attempts", async (status, category, attempts) => {
      vi.useFakeTimers();
      process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
      const fetchMock = vi.fn<typeof fetch>(
        async () =>
          new Response(LONG_PAYLOAD, {
            status: Number(status),
            statusText: SHORT_SENTINEL,
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { updates, onUpdate } = collectUpdates();
      const pending =
        kind === "search"
          ? executeTool({ query: SENSITIVE_URL, num: 7, provider: "deepseek" }, onUpdate)
          : executeFetchTool({ url: SENSITIVE_URL }, onUpdate);
      const message = await failureMessage(pending);
      expect(message).toContain(`DeepSeek: ${category} (HTTP ${status}):`);
      expect(updates[0]?.content[0]?.text).toBe(
        kind === "search" ? "Searching via DeepSeek." : "Fetching via DeepSeek.",
      );
      expect(updates.filter((update) => update.content[0]?.text.includes("retrying in"))).toHaveLength(
        Number(attempts) - 1,
      );
      assertSafeDiagnostics(message);
      assertSafeDiagnostics(updates);
      expect(fetchMock).toHaveBeenCalledTimes(Number(attempts));
      expect(transport.httpsRequest).not.toHaveBeenCalled();
      for (const [url, init] of fetchMock.mock.calls) {
        expect(url).toBe(`https://api.deepseek.com/v1/tools/${kind}`);
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer deepseek-test-key");
        expect(JSON.parse(String(init?.body))).toEqual(
          kind === "search" ? { query: SENSITIVE_URL, count: 7, need_content: false } : { url: SENSITIVE_URL },
        );
      }
    });
  });

  it.each(["search", "fetch"] as const)(
    "%s keeps exhausted-quota retry suppression without echoing reset/body",
    async (kind) => {
      vi.useFakeTimers();
      process.env.DEEPSEEK_API_KEY = "test-key";
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response(`quota exceeded reset tomorrow ${LONG_PAYLOAD}`, { status: 429 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { updates, onUpdate } = collectUpdates();
      const message = await failureMessage(
        kind === "search"
          ? executeTool({ query: SENSITIVE_URL }, onUpdate)
          : executeFetchTool({ url: SENSITIVE_URL }, onUpdate),
      );
      expect(message).toContain(
        "quota (HTTP 429): Check the provider quota or billing; try another configured provider.",
      );
      expect(message).not.toContain("reset");
      assertSafeDiagnostics(message);
      assertSafeDiagnostics(updates);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("aggregates all five search providers safely and preserves the full failover order", async () => {
    vi.useFakeTimers();
    configureCodex();
    process.env.SERPAPI_API_KEY = "serp-test-key";
    process.env.DEEPSEEK_API_KEY = "deepseek-test-key";
    process.env.BOCHA_API_KEY = "bocha-test-key";
    process.env.TAVILY_API_KEY = "tavily-test-key";
    const order: string[] = [];
    mockHttpsResponse(401, LONG_PAYLOAD);
    const httpsImpl = transport.httpsRequest.getMockImplementation()!;
    transport.httpsRequest.mockImplementation((...args: unknown[]) => {
      order.push("codex");
      return httpsImpl(...args);
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      order.push(url.hostname);
      return new Response(LONG_PAYLOAD, { status: 401, statusText: SHORT_SENTINEL });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { updates, onUpdate } = collectUpdates();
    const message = await failureMessage(
      executeTool({ query: SENSITIVE_URL, num: 4, hl: "zh-cn", gl: "cn" }, onUpdate),
    );
    expect(order).toEqual(["codex", "serpapi.com", "api.deepseek.com", "api.bochaai.com", "api.tavily.com"]);
    expect(message).toBe(
      `Web search failed with all configured providers. ${["Codex (claude2api)", "SerpAPI", "DeepSeek", "Bocha", "Tavily"].map((label) => `${label}: ${AUTH_SUMMARY}`).join("; ")}`,
    );
    assertSafeDiagnostics(message);
    assertSafeDiagnostics(updates);
    expect(updates).toHaveLength(9); // five starts + four switches; no auth retries
    expect(transport.httpsRequest).toHaveBeenCalledTimes(1);
    const [codexUrl, options] = transport.httpsRequest.mock.calls[0]!;
    expect(codexUrl.username).toBe("url-user");
    expect(codexUrl.password).toBe("url-password");
    expect(codexUrl.searchParams.get("ticket")).toBe("query-secret");
    expect(options).toMatchObject({
      rejectUnauthorized: false,
      method: "POST",
      headers: { Authorization: "Bearer codex-test-key" },
    });
    const serpUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(serpUrl.searchParams)).toEqual({
      engine: "google",
      q: SENSITIVE_URL,
      num: "4",
      api_key: "serp-test-key",
      hl: "zh-cn",
      gl: "cn",
    });
  });

  it("aggregates both fetch providers without echoing a per-URL extraction error", async () => {
    vi.useFakeTimers();
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.TAVILY_API_KEY = "test-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(SHORT_SENTINEL, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({ results: [], failed_results: [{ url: SENSITIVE_URL, error: LONG_PAYLOAD }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { updates, onUpdate } = collectUpdates();
    const message = await failureMessage(executeFetchTool({ url: SENSITIVE_URL }, onUpdate));
    expect(message).toBe(
      `Web fetch failed with all configured providers. DeepSeek: unknown (HTTP 404): ${UNKNOWN_GUIDANCE}; Tavily: unknown (HTTP 422): ${UNKNOWN_GUIDANCE}`,
    );
    assertSafeDiagnostics(message);
    assertSafeDiagnostics(updates);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.deepseek.com/v1/tools/fetch",
      "https://api.tavily.com/extract",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      urls: [SENSITIVE_URL],
      format: "markdown",
    });
  });

  it.each(["search", "fetch"] as const)("%s keeps safe failure details when failover succeeds", async (kind) => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.TAVILY_API_KEY = "test-key";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(LONG_PAYLOAD, { status: 401 }))
      .mockResolvedValueOnce(
        jsonResponse(kind === "search" ? { results: [] } : { results: [{ raw_content: "page content" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { updates, onUpdate } = collectUpdates();
    const result =
      kind === "search"
        ? await executeTool({ query: SENSITIVE_URL }, onUpdate)
        : await executeFetchTool({ url: SENSITIVE_URL }, onUpdate);
    expect(result.details).toMatchObject({
      provider: "tavily",
      failover: true,
      failures: [{ provider: "deepseek", error: AUTH_SUMMARY }],
    });
    assertSafeDiagnostics((result.details as { failures: unknown }).failures);
    assertSafeDiagnostics(updates);
    // Successful content/details remain the data surface, not diagnostic output.
    expect(result.details).toMatchObject(kind === "search" ? { query: SENSITIVE_URL } : { url: SENSITIVE_URL });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["fetch", "https"] as const)(
    "suppresses short/long network exception text on the %s transport without changing retries",
    async (transportKind) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${SHORT_SENTINEL} ${LONG_PAYLOAD}`));
      vi.stubGlobal("fetch", fetchMock);
      if (transportKind === "https") {
        configureCodex();
        mockHttpsResponse(200, "", `${SHORT_SENTINEL} ${LONG_PAYLOAD}`);
      } else {
        process.env.DEEPSEEK_API_KEY = "test-key";
      }
      const { updates, onUpdate } = collectUpdates();
      const message = await failureMessage(executeTool({ query: SENSITIVE_URL }, onUpdate));
      expect(message).toContain(`unknown: ${UNKNOWN_GUIDANCE}`);
      assertSafeDiagnostics(message);
      assertSafeDiagnostics(updates);
      expect(transportKind === "https" ? transport.httpsRequest : fetchMock).toHaveBeenCalledTimes(3);
      expect(transportKind === "https" ? fetchMock : transport.httpsRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["codex", "serpapi", "bocha"] as const)(
    "does not infer auth/quota from %s API payload text at HTTP 200",
    async (provider) => {
      vi.useFakeTimers();
      const poison = `HTTP 401 quota exceeded reset tomorrow ${LONG_PAYLOAD}`;
      const payload = provider === "bocha" ? { code: 401, msg: poison } : { error: poison };
      if (provider === "codex") {
        configureCodex();
        mockHttpsResponse(200, JSON.stringify(payload));
      } else {
        process.env[provider === "serpapi" ? "SERPAPI_API_KEY" : "BOCHA_API_KEY"] = "test-key";
        vi.stubGlobal(
          "fetch",
          vi.fn<typeof fetch>(async () => jsonResponse(payload)),
        );
      }
      const { updates, onUpdate } = collectUpdates();
      const message = await failureMessage(executeTool({ query: SENSITIVE_URL }, onUpdate));
      expect(message).toContain(`unknown: ${UNKNOWN_GUIDANCE}`);
      expect(message).not.toContain("reset");
      assertSafeDiagnostics(message);
      assertSafeDiagnostics(updates);
      expect(provider === "codex" ? transport.httpsRequest : fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe.each(["fetch", "https"] as const)("Codex %s diagnostics", (transportKind) => {
  it.each([
    [401, "auth", 1],
    [429, "quota", 3],
    [503, "transient", 3],
    [404, "unknown", 1],
  ])("keeps HTTP %i authoritative (%s) on both request paths", async (status, category, attempts) => {
    vi.useFakeTimers();
    configureCodex();
    process.env.CODEX_SEARCH_TLS_INSECURE = String(transportKind === "https");
    if (transportKind === "https") {
      mockHttpsResponse(Number(status), LONG_PAYLOAD);
    } else {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(
          async () =>
            new Response(LONG_PAYLOAD, {
              status: Number(status),
              statusText: SHORT_SENTINEL,
            }),
        ),
      );
    }
    const { updates, onUpdate } = collectUpdates();
    const message = await failureMessage(executeTool({ query: SENSITIVE_URL }, onUpdate));
    expect(message).toContain(`Codex (claude2api): ${category} (HTTP ${status}):`);
    assertSafeDiagnostics(message);
    assertSafeDiagnostics(updates);
    const active = transportKind === "https" ? transport.httpsRequest : vi.mocked(fetch);
    expect(active).toHaveBeenCalledTimes(Number(attempts));
    expect(transportKind === "https" ? fetch : transport.httpsRequest).not.toHaveBeenCalled();
    // The public diagnostic must not change the outbound query or URL credentials.
    for (const [index, call] of active.mock.calls.entries()) {
      expect(String(call[0])).toContain("url-user:url-password@");
      const body: unknown = JSON.parse(
        String(transportKind === "https" ? transport.httpsBodies[index] : call[1]?.body),
      );
      expect(body).toMatchObject({ commands: { search_query: [{ q: SENSITIVE_URL }] } });
    }
  });

  it("does not expose invalid JSON response bytes", async () => {
    vi.useFakeTimers();
    configureCodex();
    process.env.CODEX_SEARCH_TLS_INSECURE = String(transportKind === "https");
    if (transportKind === "https") mockHttpsResponse(200, LONG_PAYLOAD);
    else
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(LONG_PAYLOAD)),
      );
    const { updates, onUpdate } = collectUpdates();
    const message = await failureMessage(executeTool({ query: SENSITIVE_URL }, onUpdate));
    expect(message).toBe(
      `Web search failed with all configured providers. Codex (claude2api): unknown: ${UNKNOWN_GUIDANCE}`,
    );
    assertSafeDiagnostics(message);
    assertSafeDiagnostics(updates);
    expect(transportKind === "https" ? transport.httpsRequest : fetch).toHaveBeenCalledTimes(1);
  });
});
