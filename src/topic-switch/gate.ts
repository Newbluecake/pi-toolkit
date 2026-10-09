/**
 * topic-switch · ordered synchronous gates (plan.md §P1 "gate.ts", arch §3.3).
 *
 * Gate order (cheapest/most-selective first; thunks only run once their turn
 * comes — the `branch()` scan is deferred until after gate 2c):
 *   1a disabled / no-ui · 1b busy-turn · compacting · draining · cooldown ·
 *   background · goal · 2a source · 2b prefix/short · 2c continuation ·
 *   (branch() NOW) todo · first-turn · asked · 3a warm / warmth-unknown ·
 *   3b no-usage / unpriced / cheap.
 * Whole body wrapped in try/catch ⇒ `fact-error` (fail-open: I6 判不清就不问).
 */

import { estimateNextRequestUsd, type CostEstimate } from "./economics.js";
import { assistantAsked, classifyText, sourceAllowed } from "./filters.js";
import type { TopicSwitchSettings } from "./settings.js";
import type { GateFacts, SkipReason, WarmthView } from "./types.js";

export type PricedEstimate = Extract<CostEstimate, { kind: "priced" }>;

export type GateVerdict =
  { pass: true; estimate: PricedEstimate; warmth: WarmthView } | { pass: false; reason: SkipReason };

export function evaluateSyncGates(facts: GateFacts, s: TopicSwitchSettings): GateVerdict {
  try {
    // ── 1a 开关 / 主会话 UI ─────────────────────────────────────────────
    if (!s.enabled) return { pass: false, reason: "disabled" };
    if (!(facts.hasUI && (facts.mode === "tui" || facts.mode === "rpc"))) {
      return { pass: false, reason: "no-ui" };
    }
    // ── 1b 空闲新一轮（streamingBehavior===undefined 编码了「非流式」）────
    if (facts.streamingBehavior !== undefined || !facts.idle || facts.pendingMessages) {
      return { pass: false, reason: "busy-turn" };
    }
    if (facts.compacting) return { pass: false, reason: "compacting" };
    if (facts.draining) return { pass: false, reason: "draining" };
    if (facts.cooldownActive) return { pass: false, reason: "cooldown" };
    if (facts.activeRuns > 0 || facts.backgroundBash > 0) return { pass: false, reason: "background" };
    if (facts.goalBusy) return { pass: false, reason: "goal" };
    // ── 2 来源 / 文本 ──────────────────────────────────────────────────
    if (!sourceAllowed(facts.origin, facts.source)) return { pass: false, reason: "source" };
    const textClass = classifyText(facts.text, facts.imageCount, s.minChars);
    if (textClass === "prefix") return { pass: false, reason: "prefix" };
    if (textClass === "short") return { pass: false, reason: "short" };
    if (textClass === "continuation") return { pass: false, reason: "continuation" };
    // ── 1e/2d/2e 会话级占用（branch() 首次求值）────────────────────────
    const branch = facts.branch();
    if (branch.todoInProgress) return { pass: false, reason: "todo" };
    if (!branch.hasAssistant) return { pass: false, reason: "first-turn" };
    if (assistantAsked(branch.lastAssistantText, branch.lastTurnAskedUser)) {
      return { pass: false, reason: "asked" };
    }
    // ── 3a 冷热：warm/unknown 都不问（I6）──────────────────────────────
    const warmth = facts.warmth();
    if (warmth.state === "warm") return { pass: false, reason: "warm" };
    if (warmth.state === "unknown") return { pass: false, reason: "warmth-unknown" };
    // ── 3b 足够贵 ─────────────────────────────────────────────────────
    const estimate = estimateNextRequestUsd({
      prefixTokens: facts.prefixTokens(),
      newText: facts.text,
      imageCount: facts.imageCount,
      cost: facts.modelCost(),
      writeTtl: warmth.nextWriteTtl ?? "5m",
    });
    if (estimate.kind === "unknown") return { pass: false, reason: "no-usage" };
    if (estimate.kind === "unpriced") return { pass: false, reason: "unpriced" };
    if (estimate.usd <= s.costThresholdUsd) return { pass: false, reason: "cheap" };
    return { pass: true, estimate, warmth };
  } catch {
    return { pass: false, reason: "fact-error" };
  }
}
