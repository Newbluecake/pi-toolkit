import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { SearchResponse } from "../../src/web-search/config.js";
import { formatResponse, providerLabel, providerOrder, truncateField } from "../../src/web-search/format.js";
import { codexSearchEndpoint } from "../../src/web-search/providers.js";

describe("providerLabel", () => {
  it("labels all four providers", () => {
    expect(providerLabel("codex")).toBe("Codex (claude2api)");
    expect(providerLabel("serpapi")).toBe("SerpAPI");
    expect(providerLabel("bocha")).toBe("Bocha");
    expect(providerLabel("tavily")).toBe("Tavily");
  });
});

describe("providerOrder", () => {
  it("returns the default order for auto", () => {
    expect(providerOrder("auto")).toEqual(["codex", "serpapi", "bocha", "tavily"]);
  });

  it("pins the preferred provider first and keeps the rest as fallback", () => {
    expect(providerOrder("tavily")).toEqual(["tavily", "codex", "serpapi", "bocha"]);
    expect(providerOrder("bocha")).toEqual(["bocha", "codex", "serpapi", "tavily"]);
  });
});

describe("codexSearchEndpoint", () => {
  it("keeps a fully-qualified search path", () => {
    expect(codexSearchEndpoint("https://gw.example/v1/alpha/search").toString()).toBe(
      "https://gw.example/v1/alpha/search",
    );
  });

  it("appends /alpha/search to a /v1 base", () => {
    expect(codexSearchEndpoint("https://gw.example/v1").toString()).toBe("https://gw.example/v1/alpha/search");
  });

  it("appends /v1/alpha/search to a bare host and tolerates trailing slashes", () => {
    expect(codexSearchEndpoint("https://gw.example").toString()).toBe("https://gw.example/v1/alpha/search");
    expect(codexSearchEndpoint("https://gw.example/").toString()).toBe("https://gw.example/v1/alpha/search");
    expect(codexSearchEndpoint("https://gw.example/v1/").toString()).toBe("https://gw.example/v1/alpha/search");
  });
});

describe("truncateField", () => {
  it("returns undefined for missing input", () => {
    expect(truncateField(undefined, 10)).toBeUndefined();
    expect(truncateField("", 10)).toBeUndefined();
  });

  it("keeps values within the limit and truncates longer ones with an ellipsis", () => {
    expect(truncateField("short", 10)).toBe("short");
    expect(truncateField("0123456789", 10)).toBe("0123456789");
    expect(truncateField("0123456789X", 10)).toBe("0123456789…");
  });
});

describe("formatResponse", () => {
  const baseResponse: SearchResponse = {
    provider: "tavily",
    results: [
      {
        title: "Result One",
        url: "https://one.example",
        snippet: "first snippet",
        source: "one.example",
        date: "2026-01-01",
      },
      { title: "Result Two" },
    ],
  };

  it("renders results with url, metadata, and snippet", () => {
    const text = formatResponse("query", baseResponse, []);
    expect(text).toContain('Top 2 result(s) for "query" via Tavily:');
    expect(text).toContain("1. Result One\n   https://one.example\n   one.example · 2026-01-01\n   first snippet");
    expect(text).toContain("2. Result Two");
  });

  it("renders the no-results message", () => {
    expect(formatResponse("q", { provider: "bocha", results: [] }, [])).toBe('No results found for "q" via Bocha.');
  });

  it("renders the failover preamble naming failed and serving providers", () => {
    const text = formatResponse("q", baseResponse, [{ provider: "serpapi", error: "request failed: 401" }]);
    expect(text.startsWith("Automatic failover: SerpAPI failed; results are from Tavily.")).toBe(true);
  });

  it("renders answer (with url) and knowledge graph sections", () => {
    const response: SearchResponse = {
      provider: "serpapi",
      answer: "The answer",
      answerUrl: "https://answer.example",
      knowledgeGraph: {
        title: "KG Title",
        type: "Company",
        description: "KG description",
        url: "https://kg.example",
      },
      results: [{ title: "R" }],
    };
    const text = formatResponse("q", response, []);
    expect(text).toContain("Answer (SerpAPI): The answer\n  https://answer.example");
    expect(text).toContain("Knowledge graph — KG Title (Company): KG description\n  https://kg.example");
  });

  it("appends a truncation footnote when output exceeds the caps", () => {
    const big: SearchResponse = {
      provider: "codex",
      results: Array.from({ length: DEFAULT_MAX_LINES + 50 }, (_, i) => ({
        title: `line-${i}-${"x".repeat(20)}`,
      })),
    };
    const text = formatResponse("q", big, []);
    expect(text).toMatch(/\[Output truncated to \d+ lines or [\d.]+[KMG]?B\.\]$/);
    expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 200);
  });
});
