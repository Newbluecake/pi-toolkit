import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool, createWebSearchTool, registerWebSearchTool } from "../../src/web-tools/index.js";

// NOTE (merge-plan N4): the Codex insecureTls branch goes through node:https
// instead of fetch, so vi.stubGlobal("fetch") cannot intercept it. The Codex
// provider is intentionally not exercised here; these tests cover the
// fetch-based providers (SerpAPI/Tavily/Bocha) and the failover orchestration.

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
    const fetchMock = vi.fn(async () =>
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
    const text = result.content[0]?.text ?? "";
    expect(text).toContain('Top 1 result(s) for "q" via Tavily:');
    expect(text).toContain("1. T1");
    expect(result.details).toMatchObject({ provider: "tavily", failover: false });
    expect(updates[0]?.content[0]?.text).toBe("Searching via Tavily: q");
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

    const text = result.content[0]?.text ?? "";
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
      expect(message).toContain("SerpAPI: request failed: 401");
      expect(message).toContain("Tavily:");
      // Secrets must be redacted from the aggregated error.
      expect(message).not.toContain("serp-key");
      expect(message).toContain("[REDACTED]");
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
    const text = result.content[0]?.text ?? "";
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
    const text = result.content[0]?.text ?? "";
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

    expect(result.content[0]?.text).toBe("# Example Page\n\n# Hello\n\nMarkdown body.");
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
      "Web fetch failed with all configured providers. DeepSeek: request failed: 401",
    );
    await assertion;
    await pending.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("deepseek-key");
      expect(message).toContain("[REDACTED]");
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
    expect(result.content[0]?.text).toBe("# Hi\n\nBody.");
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
    expect(result.content[0]?.text).toBe("# X\n\nTavily body.");
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
      /DeepSeek: request failed: 404.*Tavily: extract failed: upstream timeout/s,
    );
    // 404 deepseek + 422 tavily: both non-retryable, one attempt each.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
