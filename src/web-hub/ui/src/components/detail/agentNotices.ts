/**
 * Agent-level notices (ui-design.md §9, §10, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
 * `components/detail/**`). Builds the `waiting on a dialog` / `stale` / `offline` banner
 * `AgentDetail.vue` renders below the header — reuses `visual-state.ts`'s `agentVisualState`
 * (P1, frozen determination order: down → offline; a non-empty `prompts[]` → waiting; a stale
 * card → stale; else running/idle) as the single source of truth for *which* banner applies,
 * rather than re-deriving the same precedence a second time.
 */
import { agentVisualState } from "../../composables/visual-state.js";
import { clip } from "../../format.js";
import type { I18nHandle } from "../../composables/useI18n.js";
import type { AgentState, Notice } from "../../types.js";

function mostRecentPrompt(prompts: AgentState["prompts"]): { kind: string; title?: string } | undefined {
  if (prompts.length === 0) return undefined;
  return [...prompts].reduce((a, b) => ((b.since ?? 0) >= (a.since ?? 0) ? b : a));
}

export function buildAgentNotices(agent: AgentState, t: I18nHandle["t"]): readonly Notice[] {
  const visual = agentVisualState(agent);
  if (visual === "offline") {
    return [{ id: "agent-offline", tone: "muted", title: t("detail.offlineBanner"), persistent: false }];
  }
  if (visual === "waiting") {
    const top = mostRecentPrompt(agent.prompts);
    const title =
      typeof top?.title === "string" && top.title.trim() !== "" ? ` — "${clip(top.title.trim(), 120)}"` : "";
    const more = agent.prompts.length > 1 ? ` ${t("detail.waitingMore", { n: agent.prompts.length - 1 })}` : "";
    return [
      {
        id: "agent-waiting",
        tone: "warn",
        title: t("detail.waitingOnDialog"),
        body: `${top?.kind ?? ""}${title}${more}`.trim(),
        persistent: false,
      },
    ];
  }
  if (visual === "stale") {
    return [{ id: "agent-stale", tone: "warn", title: t("detail.staleBanner"), persistent: false }];
  }
  return [];
}
