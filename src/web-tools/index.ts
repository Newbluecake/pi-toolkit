/**
 * web-tools module: the web_search tool (Codex + SerpAPI + DeepSeek + Bocha +
 * Tavily with automatic failover) and the web_fetch tool (DeepSeek fetch API,
 * URL ⇒ Markdown).
 *
 * Merged from the standalone web-search extension
 * (~/.pi/agent/extensions/web-search.ts); web_search behavior, tool name,
 * promptSnippet/promptGuidelines and the credentials file path
 * (~/.config/pi/web-search.env, overridable via PI_WEB_SEARCH_ENV_FILE)
 * are preserved verbatim. The module directory was renamed web-search →
 * web-tools when DeepSeek + web_fetch were added; the settings key stays
 * `webSearch.*` and the credentials file keeps its old name on purpose
 * (I7-style: user-facing/runtime identifiers never move).
 *
 * Entry contract (merge-plan D6, package A): `registerWebSearchTool(pi)`
 * registers BOTH tools; settings gating happens on the caller side
 * (assembly package) — this module reads no settings.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { getSearchConfig, type ProviderPreference, type SearchProvider, type SearchResponse } from "./config.js";
import { providerLabel, providerOrder, formatResponse } from "./format.js";
import {
  deepseekFetch,
  searchBocha,
  searchCodex,
  searchDeepseek,
  searchSerpApi,
  searchTavily,
  tavilyExtract,
  type WebFetchResult,
} from "./providers.js";
import { HttpError, MAX_ATTEMPTS, backoffDelay, errorMessage, isRetryableError, sleep } from "./resilience.js";

const webSearchParameters = Type.Object({
  query: Type.String({ description: "The search query." }),
  num: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Number of results to return (default 5).",
    }),
  ),
  provider: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("codex"),
        Type.Literal("serpapi"),
        Type.Literal("deepseek"),
        Type.Literal("bocha"),
        Type.Literal("tavily"),
      ],
      {
        description: "Preferred provider (default auto). Other configured providers remain automatic fallbacks.",
      },
    ),
  ),
  engine: Type.Optional(
    Type.Union([Type.Literal("google"), Type.Literal("bing"), Type.Literal("duckduckgo"), Type.Literal("baidu")], {
      description: "SerpAPI search engine (default google; ignored by Codex, DeepSeek, Tavily, and Bocha).",
    }),
  ),
  hl: Type.Optional(Type.String({ description: "SerpAPI UI language code, e.g. 'en', 'zh-cn'." })),
  gl: Type.Optional(Type.String({ description: "SerpAPI country code, e.g. 'us', 'cn'." })),
});

type WebSearchParams = Static<typeof webSearchParameters>;

export function createWebSearchTool(): ToolDefinition<typeof webSearchParameters> {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web through Codex, SerpAPI, DeepSeek, Bocha, or Tavily with automatic provider failover. " +
      "The preferred provider is attempted first; retryable failures (network, timeout, 429, 5xx) " +
      "are retried with exponential backoff, then fall back to the other configured providers. " +
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Search the web for current or external information with provider failover",
    promptGuidelines: [
      "Use web_search when the user needs current, external, or up-to-date information that may be beyond training data (news, versions, docs, prices, etc.).",
      "Prefer specific, keyword-rich queries with web_search; cite the returned URLs in your answer.",
      "Use web_search provider=auto unless the user explicitly requests a specific provider; auto tries Codex, then SerpAPI, DeepSeek, Bocha, and Tavily.",
    ],
    parameters: webSearchParameters,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const config = getSearchConfig();
      const keys = config.keys;
      const preference: ProviderPreference = params.provider ?? "auto";
      const configuredProviders = providerOrder(preference).filter(
        (provider) => Boolean(keys[provider]) && (provider !== "codex" || Boolean(config.codex.baseUrl)),
      );

      if (configuredProviders.length === 0) {
        throw new Error(
          "No web search provider is configured. Set CODEX_SEARCH_API_KEY + CODEX_SEARCH_BASE_URL, SERPAPI_API_KEY, DEEPSEEK_API_KEY, BOCHA_API_KEY and/or TAVILY_API_KEY in the environment or ~/.config/pi/web-search.env.",
        );
      }

      const num = params.num ?? 5;
      const engine = params.engine ?? "google";
      const failures: Array<{ provider: SearchProvider; error: string }> = [];

      const dispatch = (
        provider: SearchProvider,
        dispatchParams: WebSearchParams,
        dispatchSignal: AbortSignal | undefined,
      ): Promise<SearchResponse> => {
        switch (provider) {
          case "codex":
            return searchCodex(dispatchParams.query, num, keys.codex, config.codex, dispatchSignal);
          case "serpapi":
            return searchSerpApi(
              dispatchParams.query,
              num,
              engine,
              dispatchParams.hl,
              dispatchParams.gl,
              keys.serpapi,
              dispatchSignal,
            );
          case "deepseek":
            return searchDeepseek(dispatchParams.query, num, keys.deepseek, dispatchSignal);
          case "bocha":
            return searchBocha(dispatchParams.query, num, keys.bocha, dispatchSignal);
          case "tavily":
            return searchTavily(dispatchParams.query, num, keys.tavily, dispatchSignal);
        }
      };

      for (const provider of configuredProviders) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Searching via ${providerLabel(provider)}: ${params.query}`,
            },
          ],
          details: {},
        });

        let lastError: unknown;
        let lastStatus: number | undefined;
        let lastBody: string | undefined;
        let providerFailed = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const response = await dispatch(provider, params, signal);
            return {
              content: [
                {
                  type: "text",
                  text: formatResponse(params.query, response, failures),
                },
              ],
              details: {
                query: params.query,
                provider: response.provider,
                preferredProvider: preference,
                engine: response.provider === "serpapi" ? engine : undefined,
                failover: failures.length > 0,
                failures,
                answer: response.answer,
                knowledgeGraph: response.knowledgeGraph,
                results: response.results,
              },
            };
          } catch (error) {
            if (signal?.aborted) throw new Error("Web search cancelled.");
            lastError = error;
            lastStatus = error instanceof HttpError ? error.status : undefined;
            lastBody = error instanceof HttpError ? error.responseBody : undefined;

            if (attempt < MAX_ATTEMPTS && isRetryableError(error, lastStatus, lastBody)) {
              const delay = Math.round(backoffDelay(attempt));
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `${providerLabel(provider)} attempt ${attempt} failed (${errorMessage(error, Object.values(keys))}); retrying in ${delay}ms...`,
                  },
                ],
                details: {},
              });
              await sleep(delay, signal);
              continue;
            }
            providerFailed = true;
            break;
          }
        }

        if (providerFailed) {
          const safeError = errorMessage(lastError, Object.values(keys));
          failures.push({ provider, error: safeError });

          const nextProvider = configuredProviders[failures.length];
          if (nextProvider) {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `${providerLabel(provider)} failed; switching to ${providerLabel(nextProvider)}.`,
                },
              ],
              details: {},
            });
          }
        }
      }

      const summary = failures.map((failure) => `${providerLabel(failure.provider)}: ${failure.error}`).join("; ");
      throw new Error(`Web search failed with all configured providers. ${summary}`);
    },
  };
}

const webFetchParameters = Type.Object({
  url: Type.String({ description: "The http(s) URL to fetch." }),
});

type WebFetchProvider = "deepseek" | "tavily";

const WEB_FETCH_PROVIDER_ORDER: readonly WebFetchProvider[] = ["deepseek", "tavily"];

const WEB_FETCH_PROVIDER_LABEL: Record<WebFetchProvider, string> = {
  deepseek: "DeepSeek",
  tavily: "Tavily",
};

export function createWebFetchTool(): ToolDefinition<typeof webFetchParameters> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page through DeepSeek or Tavily (with automatic failover) and return its content as Markdown. " +
      "Requires DEEPSEEK_API_KEY and/or TAVILY_API_KEY (environment or ~/.config/pi/web-search.env). " +
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Fetch a URL and read its content as Markdown",
    promptGuidelines: [
      "Use web_fetch to read the full content of a specific URL (e.g. a promising result from web_search); it returns the page as Markdown.",
      "web_fetch tries DeepSeek first and falls back to Tavily when DeepSeek fails or has no key; if both providers reject the URL, work from web_search summaries instead.",
    ],
    parameters: webFetchParameters,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Only http(s) URLs can be fetched: ${params.url}`);
      }

      const { keys } = getSearchConfig();
      const allKeys = Object.values(keys);
      const providers = WEB_FETCH_PROVIDER_ORDER.filter((provider) => Boolean(keys[provider]));
      if (providers.length === 0) {
        throw new Error(
          "web_fetch needs a DeepSeek or Tavily API key. Set DEEPSEEK_API_KEY and/or TAVILY_API_KEY in the environment or ~/.config/pi/web-search.env.",
        );
      }

      const dispatch = (
        provider: WebFetchProvider,
        dispatchSignal: AbortSignal | undefined,
      ): Promise<WebFetchResult> =>
        provider === "deepseek"
          ? deepseekFetch(params.url, keys.deepseek, dispatchSignal)
          : tavilyExtract(params.url, keys.tavily, dispatchSignal);

      const failures: Array<{ provider: WebFetchProvider; error: string }> = [];
      for (const provider of providers) {
        const label = WEB_FETCH_PROVIDER_LABEL[provider];
        const providerKeys = [keys[provider]];
        onUpdate?.({
          content: [{ type: "text", text: `Fetching via ${label}: ${params.url}` }],
          details: {},
        });

        let lastError: unknown;
        let providerFailed = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            const result = await dispatch(provider, signal);
            const output = result.title ? `# ${result.title}\n\n${result.content}` : result.content;
            const truncation = truncateHead(output, {
              maxLines: DEFAULT_MAX_LINES,
              maxBytes: DEFAULT_MAX_BYTES,
            });
            const text = truncation.truncated
              ? `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} lines or ${formatSize(truncation.outputBytes)}.]`
              : truncation.content;
            return {
              content: [{ type: "text", text }],
              details: {
                url: params.url,
                title: result.title,
                provider,
                failover: failures.length > 0,
                failures,
                truncated: truncation.truncated,
              },
            };
          } catch (error) {
            if (signal?.aborted) throw new Error("Web fetch cancelled.");
            lastError = error;
            const status = error instanceof HttpError ? error.status : undefined;
            const body = error instanceof HttpError ? error.responseBody : undefined;
            if (attempt < MAX_ATTEMPTS && isRetryableError(error, status, body)) {
              const delay = Math.round(backoffDelay(attempt));
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `${label} fetch attempt ${attempt} failed (${errorMessage(error, providerKeys)}); retrying in ${delay}ms...`,
                  },
                ],
                details: {},
              });
              await sleep(delay, signal);
              continue;
            }
            providerFailed = true;
            break;
          }
        }

        if (providerFailed) {
          failures.push({ provider, error: errorMessage(lastError, allKeys) });
          const next = providers[failures.length];
          if (next) {
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `${label} failed; switching to ${WEB_FETCH_PROVIDER_LABEL[next]}.`,
                },
              ],
              details: {},
            });
          }
        }
      }

      const summary = failures
        .map((failure) => `${WEB_FETCH_PROVIDER_LABEL[failure.provider]}: ${failure.error}`)
        .join("; ");
      throw new Error(`Web fetch failed with all configured providers. ${summary}`);
    },
  };
}

export function registerWebSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createWebSearchTool());
  pi.registerTool(createWebFetchTool());
}
