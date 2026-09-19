import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  effectiveThresholdPercentWithTokens,
  maxThresholdPercent,
  thresholdLineTokens,
  tokenLineExceedsWindow,
} from "../compact-hint/threshold.js";
import type { CompactHintState } from "../stack.js";

export const SetCompactThresholdParams = Type.Object({
  percent: Type.Optional(
    Type.Number({ description: "0 to disable, or an integer threshold from 1 to 100; omit to query." }),
  ),
  force: Type.Optional(
    Type.Number({
      description: "0 to disable forced compaction, or a force threshold from 1 to 100; omit to leave unchanged.",
    }),
  ),
  tokens: Type.Optional(
    Type.Number({
      description:
        "Absolute hint threshold in units of k used tokens (e.g. 300 = 300k); 0 to disable, omit to leave unchanged. Combined with percent: whichever fires first wins.",
    }),
  ),
  forceTokens: Type.Optional(
    Type.Number({
      description:
        "Absolute force threshold in units of k used tokens; 0 to disable, omit to leave unchanged. Must exceed the effective hint token line.",
    }),
  ),
});
export type SetCompactThresholdParams = Static<typeof SetCompactThresholdParams>;

export interface SetCompactThresholdToolDeps {
  getState: () => CompactHintState | undefined;
  compactToolEnabled: () => boolean;
}

function result(text: string, reason: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: { ok: false as const, reason, ...extra } };
}

/** Display helper: `75%` stays `75%`; with an absolute line configured it
 *  shows `75%/500k`, annotated when the line currently auto-disables because
 *  it exceeds the model's context window. */
function formatThreshold(percent: number, tokensK: number, window?: number): string {
  if (tokensK <= 0) return `${percent}%`;
  const inactive = window !== undefined && tokenLineExceedsWindow(tokensK, window);
  return `${percent}%/${tokensK}k${inactive ? " (absolute line inactive: exceeds window)" : ""}`;
}

export function createSetCompactThresholdTool(
  deps: SetCompactThresholdToolDeps,
): ToolDefinition<typeof SetCompactThresholdParams> {
  return {
    name: "set_compact_threshold",
    label: "Set Compact Threshold",
    description:
      "Query, set, or disable the context-usage percentage (or absolute used-token line, unit k) at which " +
      "pi-subagent reminds you to call compact_context. Calling it with no arguments reports the current " +
      "context usage and thresholds without changing anything.",
    promptSnippet:
      "set_compact_threshold(percent?, tokens?) - query or set the model-triggered compaction reminder threshold",
    promptGuidelines: [
      "This is a reminder threshold, never forced compression; use compact_context when you decide to compact.",
      "Use 0 to disable, omit percent to query, or use a value of at least 1; the effective value stays below pi's automatic line.",
      "tokens/forceTokens are absolute used-token lines in units of k (default hint line 500 = 500k); 0 disables them, and a line exceeding the model's context window auto-disables. When both percent and tokens apply, whichever fires first wins.",
    ],
    parameters: SetCompactThresholdParams,
    async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
      if (ctx.mode === "print" || ctx.mode === "json")
        return result(
          "set_compact_threshold is unavailable in non-interactive (print/json) mode.",
          "non_interactive_mode",
        );
      if (!deps.compactToolEnabled())
        return result("Compact threshold reminders are disabled by settings.", "compact_tool_disabled");
      const state = deps.getState();
      if (!state) return result("No active session is available.", "no_session");
      const usage = ctx.getContextUsage();
      const current = usage?.percent == null ? "unknown" : `${Math.round(usage.percent)}%`;
      const usageNote = usage?.contextWindow === undefined ? "; 读侧钳制可能生效" : "";
      const window = usage?.contextWindow;
      const effectiveOf = (percent: number, tokensK: number) =>
        window === undefined
          ? percent
          : effectiveThresholdPercentWithTokens(percent, tokensK, window, state.reserveTokens);
      const effective = effectiveOf(state.thresholdPercent, state.thresholdTokens);
      const effectiveForce = effectiveOf(state.forceAtPercent, state.forceAtTokens);
      if (
        params.percent === undefined &&
        params.force === undefined &&
        params.tokens === undefined &&
        params.forceTokens === undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Compact hint threshold: ${formatThreshold(state.thresholdPercent, state.thresholdTokens, window)} (effective ${effective}%), force: ${formatThreshold(state.forceAtPercent, state.forceAtTokens, window)} (effective ${effectiveForce}%), current usage ${current}${usageNote}.`,
            },
          ],
          details: {
            ok: true as const,
            action: "query",
            thresholdPercent: state.thresholdPercent,
            thresholdTokens: state.thresholdTokens,
            effectivePercent: effective,
            forceAtPercent: state.forceAtPercent,
            forceAtTokens: state.forceAtTokens,
            effectiveForcePercent: effectiveForce,
            usage: usage?.percent ?? null,
          },
        };
      }
      const value = params.percent;
      const force = params.force;
      const tokens = params.tokens;
      const forceTokens = params.forceTokens;
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100 || (value > 0 && value < 1)))
        return result("Invalid threshold. Use 0 to disable or a number from 1 to 100.", "invalid");
      if (force !== undefined && (!Number.isFinite(force) || force < 0 || force > 100 || (force > 0 && force < 1)))
        return result("Invalid force threshold. Use 0 to disable or a number from 1 to 100.", "invalid");
      if (tokens !== undefined && (!Number.isFinite(tokens) || tokens < 0))
        return result("Invalid token threshold. Use 0 to disable or a non-negative number (unit: k).", "invalid");
      if (forceTokens !== undefined && (!Number.isFinite(forceTokens) || forceTokens < 0))
        return result("Invalid force token threshold. Use 0 to disable or a non-negative number (unit: k).", "invalid");
      const nextPercent = value === undefined ? state.thresholdPercent : Math.floor(value);
      const nextForce = force === undefined ? state.forceAtPercent : Math.floor(force);
      const nextTokens = tokens === undefined ? state.thresholdTokens : Math.floor(tokens);
      const nextForceTokens = forceTokens === undefined ? state.forceAtTokens : Math.floor(forceTokens);
      if (nextForce > 0 && nextForce <= nextPercent)
        return result("Invalid force threshold. It must be greater than the warning threshold.", "invalid");
      const hintLine = thresholdLineTokens(nextPercent, nextTokens, window);
      if (nextForceTokens > 0 && (hintLine <= 0 || nextForceTokens * 1000 <= hintLine))
        return result(
          "Invalid force token threshold. It must be greater than the effective warning token line.",
          "invalid",
        );
      if (
        value !== undefined &&
        window !== undefined &&
        Math.floor(nextPercent) > maxThresholdPercent(window, state.reserveTokens)
      )
        return result(
          `Threshold exceeds the current dynamic cap of ${maxThresholdPercent(window, state.reserveTokens)}%.`,
          "above_cap",
        );
      if (force !== undefined && window !== undefined && nextForce > maxThresholdPercent(window, state.reserveTokens))
        return result(
          `Force threshold exceeds the current dynamic cap of ${maxThresholdPercent(window, state.reserveTokens)}%.`,
          "above_cap",
        );
      state.thresholdPercent = nextPercent;
      state.forceAtPercent = nextForce;
      state.thresholdTokens = nextTokens;
      state.forceAtTokens = nextForceTokens;
      state.hintedAt = undefined;
      state.lastHintAt = 0;
      const action = state.thresholdPercent === 0 && state.thresholdTokens === 0 ? "off" : "set";
      const nextEffective = effectiveOf(state.thresholdPercent, state.thresholdTokens);
      const nextEffectiveForce = effectiveOf(state.forceAtPercent, state.forceAtTokens);
      return {
        content: [
          {
            type: "text" as const,
            text: `Compact thresholds ${action === "off" ? "disabled" : `set to ${formatThreshold(state.thresholdPercent, state.thresholdTokens, window)} (effective ${nextEffective}%), force ${formatThreshold(state.forceAtPercent, state.forceAtTokens, window)} (effective ${nextEffectiveForce}%)`}; current usage ${current}${usageNote}.`,
          },
        ],
        details: {
          ok: true as const,
          action,
          thresholdPercent: state.thresholdPercent,
          thresholdTokens: state.thresholdTokens,
          effectivePercent: nextEffective,
          forceAtPercent: state.forceAtPercent,
          forceAtTokens: state.forceAtTokens,
          effectiveForcePercent: nextEffectiveForce,
          usage: usage?.percent ?? null,
        },
      };
    },
  };
}
