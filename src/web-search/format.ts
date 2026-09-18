/**
 * Output formatting for the web_search tool: provider labels, failover order,
 * field truncation, and the final human-readable response text.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ProviderPreference, SearchProvider, SearchResponse } from "./config.js";

export function providerLabel(provider: SearchProvider): string {
  switch (provider) {
    case "codex":
      return "Codex (claude2api)";
    case "serpapi":
      return "SerpAPI";
    case "bocha":
      return "Bocha";
    case "tavily":
      return "Tavily";
  }
}

const DEFAULT_PROVIDER_ORDER: SearchProvider[] = ["codex", "serpapi", "bocha", "tavily"];

export function providerOrder(preference: ProviderPreference): SearchProvider[] {
  if (preference === "auto") return DEFAULT_PROVIDER_ORDER;
  return [preference, ...DEFAULT_PROVIDER_ORDER.filter((p) => p !== preference)];
}

export function truncateField(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

export function formatResponse(
  query: string,
  response: SearchResponse,
  failures: Array<{ provider: SearchProvider; error: string }>,
): string {
  const lines: string[] = [];

  if (failures.length > 0) {
    const failed = failures.map((item) => providerLabel(item.provider)).join(", ");
    lines.push(`Automatic failover: ${failed} failed; results are from ${providerLabel(response.provider)}.`, "");
  }

  if (response.answer) {
    lines.push(`Answer (${providerLabel(response.provider)}): ${response.answer}`);
    if (response.answerUrl) lines.push(`  ${response.answerUrl}`);
    lines.push("");
  }

  if (response.knowledgeGraph) {
    const graph = response.knowledgeGraph;
    lines.push(`Knowledge graph — ${graph.title ?? ""}${graph.type ? ` (${graph.type})` : ""}: ${graph.description}`);
    if (graph.url) lines.push(`  ${graph.url}`);
    lines.push("");
  }

  if (response.results.length === 0 && lines.length === 0) {
    return `No results found for "${query}" via ${providerLabel(response.provider)}.`;
  }

  lines.push(`Top ${response.results.length} result(s) for "${query}" via ${providerLabel(response.provider)}:`, "");
  response.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    if (result.url) lines.push(`   ${result.url}`);
    const metadata = [result.source, result.date].filter(Boolean).join(" · ");
    if (metadata) lines.push(`   ${metadata}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    lines.push("");
  });

  const output = lines.join("\n").trimEnd();
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return truncation.content;

  return `${truncation.content}\n\n[Output truncated to ${truncation.outputLines} lines or ${formatSize(truncation.outputBytes)}.]`;
}
