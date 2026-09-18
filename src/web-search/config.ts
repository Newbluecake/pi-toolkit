/**
 * Web search configuration: provider credentials from the process environment
 * or a fallback env file (default ~/.config/pi/web-search.env).
 *
 * Merged from the standalone web-search extension
 * (~/.pi/agent/extensions/web-search.ts); behavior preserved verbatim.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type SearchProvider = "codex" | "serpapi" | "bocha" | "tavily";
export type ProviderPreference = "auto" | SearchProvider;

export interface SearchResult {
  title: string;
  url?: string | undefined;
  snippet?: string | undefined;
  source?: string | undefined;
  date?: string | undefined;
  score?: number | undefined;
}

export interface SearchResponse {
  provider: SearchProvider;
  answer?: string | undefined;
  answerUrl?: string | undefined;
  knowledgeGraph?:
    | {
        title?: string | undefined;
        type?: string | undefined;
        description: string;
        url?: string | undefined;
      }
    | undefined;
  results: SearchResult[];
}

export interface WebSearchConfig {
  keys: Record<SearchProvider, string>;
  codex: {
    baseUrl: string;
    model: string;
    insecureTls: boolean;
  };
}

export const DEFAULT_CREDENTIALS_FILE = "~/.config/pi/web-search.env";
export const DEFAULT_CODEX_SEARCH_MODEL = "gpt-5.6-sol";

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
  return resolve(filePath);
}

function parseCredentialsFile(): Record<string, string> {
  const configuredPath = process.env.PI_WEB_SEARCH_ENV_FILE?.trim() || DEFAULT_CREDENTIALS_FILE;

  try {
    const content = readFileSync(expandHome(configuredPath), "utf8");
    const values: Record<string, string> = {};

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      const rawValue = match[2];
      if (key === undefined || rawValue === undefined) continue;

      let value = rawValue.trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }

    return values;
  } catch {
    return {};
  }
}

export function getSearchConfig(): WebSearchConfig {
  const fileValues = parseCredentialsFile();
  const value = (name: string): string => process.env[name]?.trim() || fileValues[name]?.trim() || "";
  const insecureTls = /^(?:1|true|yes)$/i.test(value("CODEX_SEARCH_TLS_INSECURE"));

  return {
    keys: {
      codex: value("CODEX_SEARCH_API_KEY"),
      serpapi: value("SERPAPI_API_KEY"),
      bocha: value("BOCHA_API_KEY"),
      tavily: value("TAVILY_API_KEY"),
    },
    codex: {
      baseUrl: value("CODEX_SEARCH_BASE_URL"),
      model: value("CODEX_SEARCH_MODEL") || DEFAULT_CODEX_SEARCH_MODEL,
      insecureTls,
    },
  };
}
