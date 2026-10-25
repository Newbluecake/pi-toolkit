/**
 * droid 用量字段归一（plan §3.3：droid 侧只做字段归一，账本规则在 P2 usage-ledger）。
 *
 * droid 的 camelCase tokenUsage 对象（session_token_usage_changed.tokenUsage /
 * agent_turn_completed.tokenUsage / cumulativeTokenUsage / childTokenUsage /
 * ~/.factory/sessions 的 .settings.json tokenUsage 全是同一形状，droid-protocol §5/§13 S10）：
 *   inputTokens / outputTokens / cacheCreationTokens / cacheReadTokens / thinkingTokens / factoryCredits
 * → ExternalTokenCounts：input / output / cacheRead / cacheWrite / thinking / credits。
 * 非有限/负值字段钳 0（与 session-driver mapUsage 同口径）；非对象 ⇒ undefined。
 */
import type { ExternalTokenCounts } from "../types.js";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function droidTokenCounts(u: unknown): ExternalTokenCounts | undefined {
  if (u === null || typeof u !== "object" || Array.isArray(u)) return undefined;
  const r = u as Record<string, unknown>;
  return {
    input: num(r.inputTokens),
    output: num(r.outputTokens),
    cacheRead: num(r.cacheReadTokens),
    cacheWrite: num(r.cacheCreationTokens),
    thinking: num(r.thinkingTokens),
    credits: num(r.factoryCredits),
  };
}
