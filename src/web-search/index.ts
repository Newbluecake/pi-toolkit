/**
 * web_search tool: Codex + SerpAPI + Bocha + Tavily with automatic failover.
 *
 * Merged from the standalone web-search extension
 * (~/.pi/agent/extensions/web-search.ts); behavior, tool description,
 * promptSnippet/promptGuidelines and the credentials file path
 * (~/.config/pi/web-search.env, overridable via PI_WEB_SEARCH_ENV_FILE)
 * are preserved verbatim.
 *
 * Entry contract (merge-plan D6, package A): `registerWebSearchTool(pi)`.
 * Settings gating happens on the caller side (assembly package) — this
 * module reads no settings.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { getSearchConfig, type ProviderPreference, type SearchProvider, type SearchResponse } from "./config.js";
import { providerLabel, providerOrder, formatResponse } from "./format.js";
import { searchBocha, searchCodex, searchSerpApi, searchTavily } from "./providers.js";
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
      description: "SerpAPI search engine (default google; ignored by Codex, Tavily, and Bocha).",
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
      "Search the web through Codex, SerpAPI, Bocha, or Tavily with automatic provider failover. " +
      "The preferred provider is attempted first; retryable failures (network, timeout, 429, 5xx) " +
      "are retried with exponential backoff, then fall back to the other configured providers. " +
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Search the web for current or external information with provider failover",
    promptGuidelines: [
      "Use web_search when the user needs current, external, or up-to-date information that may be beyond training data (news, versions, docs, prices, etc.).",
      "Prefer specific, keyword-rich queries with web_search; cite the returned URLs in your answer.",
      "Use web_search provider=auto unless the user explicitly requests a specific provider; auto tries Codex, then SerpAPI, Bocha, and Tavily.",
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
          "No web search provider is configured. Set CODEX_SEARCH_API_KEY + CODEX_SEARCH_BASE_URL, SERPAPI_API_KEY, BOCHA_API_KEY and/or TAVILY_API_KEY in the environment or ~/.config/pi/web-search.env.",
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

export function registerWebSearchTool(pi: ExtensionAPI): void {
  pi.registerTool(createWebSearchTool());
}
