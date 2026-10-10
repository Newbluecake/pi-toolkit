/**
 * `AgentState` → `AgentCardView` mapping (vue-plan.md v2.1 §3.2, §5.1, §5.2 — P3 exclusive,
 * `components/agents/**`). `AgentListProps.cards` is frozen (`contracts.ts`) as already-derived
 * view models — `DashboardView.vue` calls `toAgentCardView()` once per visible agent inside a
 * `computed()`, so `AgentList.vue`/`AgentCard.vue` themselves stay pure presentation. Mirrors
 * the legacy `@logic/render/agents.js`'s `agentCardModel`/`shortCwd`/`costLabel` (same field
 * priority order), re-expressed against the frozen `AgentState`/`AgentCardView` shapes and the
 * shared `common.status.*` i18n vocabulary instead of hard-coded English badge text.
 */
import { agentVisualState } from "../../composables/visual-state.js";
import type { I18nHandle } from "../../composables/useI18n.js";
import { formatUsd } from "../../format.js";
import type { AgentCardView, AgentState, RunVisualState } from "../../types.js";

function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Last one or two non-empty path segments of a cwd, mirrors `@logic/render/agents.js`'s `shortCwd`. */
export function shortCwd(cwd: string): string {
  const parts = cwd.split("/").filter((p) => p !== "");
  if (parts.length === 0) return "/";
  return parts.slice(-2).join("/");
}

function cwdOf(agent: AgentState): string {
  const session = record(agent.session);
  const card = record(agent.card);
  const cwd = session["cwd"] ?? card["cwd"];
  return typeof cwd === "string" ? cwd : "";
}

function sessionLabel(agent: AgentState, t: I18nHandle["t"]): string {
  const session = record(agent.session);
  const name = session["name"];
  if (typeof name === "string" && name !== "") return name;
  const sessionId = session["sessionId"];
  if (typeof sessionId === "string" && sessionId !== "") return sessionId.slice(0, 8);
  return t("agents.noSessionName");
}

function modelShortOf(agent: AgentState): string {
  const session = record(agent.session);
  const model = record(session["model"]);
  const id = model["id"];
  return typeof id === "string" ? id : "";
}

/** Own + subagent TOTAL (2026-10-10: the old `total (sub)` label overflowed the card row and
 * squeezed the cwd title to nothing — the breakdown now lives in `agentCostTitle`'s tooltip). */
export function agentCostLabel(agent: AgentState): string {
  const status = record(agent.status);
  const own = status["costUsd"];
  if (typeof own !== "number") return "—";
  const subRaw = status["subagentCostUsd"];
  const sub = typeof subRaw === "number" && subRaw > 0 ? subRaw : 0;
  return formatUsd(own + sub);
}

/** Tooltip breakdown, only when subagents cost anything. */
export function agentCostTitle(agent: AgentState, t: I18nHandle["t"]): string | undefined {
  const status = record(agent.status);
  const own = status["costUsd"];
  const subRaw = status["subagentCostUsd"];
  if (typeof own !== "number" || typeof subRaw !== "number" || subRaw <= 0) return undefined;
  return t("agents.costTitle", { own: formatUsd(own), sub: formatUsd(subRaw) });
}

function contextPercentOf(agent: AgentState): number | null {
  const status = record(agent.status);
  const usage = record(status["contextUsage"]);
  const p = usage["percent"];
  return typeof p === "number" ? p : null;
}

function runningSubCountOf(agent: AgentState): number {
  const fleet = agent.fleet as ReadonlyArray<unknown>;
  let n = 0;
  for (const row of fleet) {
    const r = record(row);
    if (r["terminal"] !== true && r["status"] === "running") n++;
  }
  return n;
}

/** ui-design.md §5.1's per-card status pill — only shown for a "worth flagging" state. */
function statusLabelOf(agent: AgentState, visual: RunVisualState, t: I18nHandle["t"]): string | null {
  const card = record(agent.card);
  if (visual === "offline") return t("common.status.offline");
  if (visual === "waiting") return t("common.status.waiting");
  if (visual === "stale") return t("common.status.stale");
  if (card["outdated"] === true) return t("common.status.outdated");
  if (visual === "running") return t("common.status.running");
  return null;
}

function costTitleOf(agent: AgentState, t: I18nHandle["t"]): { costTitle: string } | undefined {
  const title = agentCostTitle(agent, t);
  return title === undefined ? undefined : { costTitle: title };
}

export function toAgentCardView(agent: AgentState, t: I18nHandle["t"]): AgentCardView {
  const card = record(agent.card);
  const visual = agentVisualState(agent);
  return {
    key: agent.key,
    kind: card["kind"] === "rpc" ? "rpc" : "tui",
    shortCwd: shortCwd(cwdOf(agent)),
    sessionLabel: sessionLabel(agent, t),
    modelShort: modelShortOf(agent),
    contextPercent: contextPercentOf(agent),
    runningSubCount: runningSubCountOf(agent),
    costLabel: agentCostLabel(agent),
    ...(costTitleOf(agent, t) ?? {}),
    visualState: visual,
    statusLabel: statusLabelOf(agent, visual, t),
    stale: visual === "stale",
    down: agent.down,
    outdated: card["outdated"] === true,
  };
}
