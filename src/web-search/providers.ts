/**
 * Search provider implementations: Codex (claude2api), SerpAPI, Tavily, Bocha.
 * Each returns a normalized SearchResponse or throws (HttpError for HTTP
 * failures so the caller can decide whether to retry/fail over).
 */

import { request as httpsRequest } from "node:https";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { SearchProvider, SearchResponse, WebSearchConfig } from "./config.js";
import { HttpError, errorMessage, redactSecrets, withRequestTimeout } from "./resilience.js";
import { truncateField } from "./format.js";

const MAX_CODEX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface SerpOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  date?: string;
}

interface SerpResponse {
  error?: string;
  answer_box?: {
    answer?: string;
    snippet?: string;
    link?: string;
  };
  knowledge_graph?: {
    title?: string;
    type?: string;
    description?: string;
    source?: { link?: string };
  };
  organic_results?: SerpOrganicResult[];
}

interface TavilyResponse {
  answer?: string;
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    published_date?: string;
  }>;
}

interface CodexSearchResult {
  type?: string;
  domain?: string;
  ref_id?: string;
  title?: string;
  url?: string;
  snippet?: string;
}

interface CodexSearchResponse {
  output?: string;
  results?: CodexSearchResult[];
  error?: { message?: string } | string;
  // encrypted_output is intentionally neither parsed nor returned to the model.
}

interface BochaWebPage {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  siteName?: string;
  dateLastCrawled?: string;
}

interface BochaResponse {
  code?: number | string;
  msg?: string | null;
  message?: string;
  data?: { webPages?: { value?: BochaWebPage[] } };
  webPages?: { value?: BochaWebPage[] };
}

async function readErrorBody(response: Response, apiKey: string): Promise<string> {
  const body = await response.text().catch(() => "");
  return redactSecrets(body.slice(0, 300), [apiKey]);
}

export function codexSearchEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/v1\/alpha\/search$/i.test(normalized)) return new URL(normalized);
  if (/\/v1$/i.test(normalized)) return new URL(`${normalized}/alpha/search`);
  return new URL(`${normalized}/v1/alpha/search`);
}

/**
 * Node fetch has no standard per-request TLS verification switch. Keep the
 * exception scoped to the explicitly configured Codex endpoint instead of
 * weakening TLS globally with NODE_TLS_REJECT_UNAUTHORIZED=0.
 */
async function postCodexJson(
  url: URL,
  body: Record<string, unknown>,
  apiKey: string,
  insecureTls: boolean,
  signal: AbortSignal,
): Promise<Response> {
  const serialized = JSON.stringify(body);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (!insecureTls || url.protocol !== "https:") {
    return fetch(url, { method: "POST", headers, body: serialized, signal });
  }

  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(serialized) },
        rejectUnauthorized: false,
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_CODEX_RESPONSE_BYTES) {
            response.destroy(new Error(`Codex search response exceeded ${formatSize(MAX_CODEX_RESPONSE_BYTES)}`));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", reject);
        response.once("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, String(value));
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              // exactOptionalPropertyTypes: statusMessage is string | undefined.
              ...(response.statusMessage !== undefined ? { statusText: response.statusMessage } : {}),
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.once("error", reject);
    request.end(serialized);
  });
}

export async function searchCodex(
  query: string,
  num: number,
  apiKey: string,
  config: WebSearchConfig["codex"],
  signal: AbortSignal | undefined,
): Promise<SearchResponse> {
  const url = codexSearchEndpoint(config.baseUrl);
  const body = {
    id: `pi-web-search-${crypto.randomUUID()}`,
    model: config.model,
    commands: { search_query: [{ q: query }] },
    settings: { allowed_callers: ["direct"], external_web_access: true },
  };
  const response = await withRequestTimeout(signal, (attemptSignal) =>
    postCodexJson(url, body, apiKey, config.insecureTls, attemptSignal),
  ).catch((error) => {
    throw new Error(`network request failed: ${errorMessage(error, [apiKey])}`);
  });

  if (!response.ok) {
    const responseBody = await readErrorBody(response, apiKey);
    throw new HttpError(
      `request failed: ${response.status} ${response.statusText}${responseBody ? ` — ${responseBody}` : ""}`,
      response.status,
      responseBody,
    );
  }

  let data: CodexSearchResponse;
  try {
    data = (await response.json()) as CodexSearchResponse;
  } catch {
    throw new Error("returned invalid JSON");
  }
  if (data.error) {
    const message = typeof data.error === "string" ? data.error : data.error.message;
    throw new Error(`API error: ${message ?? "unknown Codex search error"}`);
  }
  if (!Array.isArray(data.results)) throw new Error("returned an invalid results payload");

  return {
    provider: "codex",
    answer: truncateField(data.output, 4_000),
    results: data.results.slice(0, num).map((result) => ({
      title: result.title ?? "(untitled)",
      url: result.url,
      snippet: truncateField(result.snippet, 2_000),
      source: result.domain,
    })),
  };
}

export async function searchSerpApi(
  query: string,
  num: number,
  engine: string,
  hl: string | undefined,
  gl: string | undefined,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<SearchResponse> {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", engine);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(num));
  url.searchParams.set("api_key", apiKey);
  if (hl) url.searchParams.set("hl", hl);
  if (gl) url.searchParams.set("gl", gl);

  const response = await withRequestTimeout(signal, (attemptSignal) => fetch(url, { signal: attemptSignal })).catch(
    (error) => {
      throw new Error(`network request failed: ${errorMessage(error, [apiKey])}`);
    },
  );

  if (!response.ok) {
    const body = await readErrorBody(response, apiKey);
    throw new HttpError(
      `request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
      response.status,
      body,
    );
  }

  let data: SerpResponse;
  try {
    data = (await response.json()) as SerpResponse;
  } catch {
    throw new Error("returned invalid JSON");
  }
  if (data.error) throw new Error(`API error: ${redactSecrets(data.error, [apiKey])}`);

  const answer = data.answer_box?.answer ?? data.answer_box?.snippet;
  const graph = data.knowledge_graph;
  // truncateField(non-empty string) always returns a string; the truthiness
  // guard below also keeps this free of non-null assertions.
  const graphDescription = graph?.description ? truncateField(graph.description, 4_000) : undefined;
  const knowledgeGraph =
    graph && graphDescription
      ? {
          title: graph.title,
          type: graph.type,
          description: graphDescription,
          url: graph.source?.link,
        }
      : undefined;

  return {
    provider: "serpapi",
    answer: truncateField(answer, 4_000),
    answerUrl: data.answer_box?.link,
    knowledgeGraph,
    results: (data.organic_results ?? []).slice(0, num).map((result) => ({
      title: result.title ?? "(untitled)",
      url: result.link,
      snippet: truncateField(result.snippet, 2_000),
      source: result.source,
      date: result.date,
    })),
  };
}

export async function searchTavily(
  query: string,
  num: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<SearchResponse> {
  const response = await withRequestTimeout(signal, (attemptSignal) =>
    fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: num,
        include_answer: true,
        include_raw_content: false,
      }),
      signal: attemptSignal,
    }),
  ).catch((error) => {
    throw new Error(`network request failed: ${errorMessage(error, [apiKey])}`);
  });

  if (!response.ok) {
    const body = await readErrorBody(response, apiKey);
    throw new HttpError(
      `request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
      response.status,
      body,
    );
  }

  let data: TavilyResponse;
  try {
    data = (await response.json()) as TavilyResponse;
  } catch {
    throw new Error("returned invalid JSON");
  }
  if (!Array.isArray(data.results)) throw new Error("returned an invalid results payload");

  return {
    provider: "tavily",
    answer: truncateField(data.answer, 4_000),
    results: data.results.slice(0, num).map((result) => {
      let source: string | undefined;
      if (result.url) {
        try {
          source = new URL(result.url).hostname;
        } catch {
          // Keep malformed result URLs visible without failing the whole search.
        }
      }
      return {
        title: result.title ?? "(untitled)",
        url: result.url,
        snippet: truncateField(result.content, 2_000),
        source,
        date: result.published_date,
        score: result.score,
      };
    }),
  };
}

export async function searchBocha(
  query: string,
  num: number,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<SearchResponse> {
  const response = await withRequestTimeout(signal, (attemptSignal) =>
    fetch("https://api.bochaai.com/v1/web-search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        freshness: "noLimit",
        summary: true,
        count: num,
      }),
      signal: attemptSignal,
    }),
  ).catch((error) => {
    throw new Error(`network request failed: ${errorMessage(error, [apiKey])}`);
  });

  if (!response.ok) {
    const body = await readErrorBody(response, apiKey);
    throw new HttpError(
      `request failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
      response.status,
      body,
    );
  }

  let payload: BochaResponse;
  try {
    payload = (await response.json()) as BochaResponse;
  } catch {
    throw new Error("returned invalid JSON");
  }

  if (payload.code !== undefined && Number(payload.code) !== 200) {
    throw new Error(`API error: ${payload.msg ?? payload.message ?? `code ${payload.code}`}`);
  }

  const pages = payload.data?.webPages?.value ?? payload.webPages?.value ?? [];
  return {
    provider: "bocha" satisfies SearchProvider,
    results: pages.slice(0, num).map((page) => ({
      title: page.name ?? "(untitled)",
      url: page.url,
      snippet: truncateField(page.summary ?? page.snippet, 2_000),
      source: page.siteName,
      date: page.dateLastCrawled?.slice(0, 10),
    })),
  };
}
