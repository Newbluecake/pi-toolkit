import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWebSearchTool, registerWebSearchTool } from "../../src/web-search/index.js";

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
  it("registers the web_search tool on the pi extension API", () => {
    let registered: ToolDefinition | undefined;
    const fakePi = {
      registerTool(tool: ToolDefinition): void {
        registered = tool;
      },
    } as unknown as ExtensionAPI;
    registerWebSearchTool(fakePi);
    if (!registered) throw new Error("tool was not registered");
    expect(registered.name).toBe("web_search");
    expect(registered.promptSnippet).toContain("provider failover");
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
});
