/**
 * Agent card view model (vue-plan.md v2.1 §3.1, §5.2 — P5b cleanup): one card per connected pi
 * process — kind / cwd / session name / busy / cost / stale (greyed) / down / outdated.
 *
 * DOM rendering (`renderAgentList`, built on the legacy `render/dom.js`'s `el()`) is deleted
 * here (P5b, §3.1's disposition table: "保留 agentCardModel/shortCwd/costLabel；
 * renderAgentList P5b 删") — the Vue UI renders the same fields with `AgentList.vue`/
 * `AgentCard.vue` (`components/agents/agentCardModel.ts`'s TS port, §3.2/§5.2 P3).
 */
import { formatUsd } from "../format";
import { bannerText } from "./banner.js";

/**
 * @typedef {{ key: string, title: string, kind: string, cwd: string, session: string,
 *   busy: boolean, cost: string, stale: boolean, down: boolean, outdated: boolean,
 *   blocked: boolean, state: "live" | "stale" | "down" }} CardModel
 */

/** Last path segment(s) of a cwd for the card title. @param {string} cwd */
export function shortCwd(cwd) {
  const parts = String(cwd ?? "")
    .split("/")
    .filter((p) => p !== "");
  if (parts.length === 0) return "/";
  return parts.slice(-2).join("/");
}

/**
 * Total cost label: own + subagents, `—` until the agent reports it.
 * @param {any} status
 */
export function costLabel(status) {
  if (!status || typeof status.costUsd !== "number") return "—";
  const sub = typeof status.subagentCostUsd === "number" && status.subagentCostUsd > 0 ? status.subagentCostUsd : 0;
  return sub > 0 ? `${formatUsd(status.costUsd + sub)} (sub ${formatUsd(sub)})` : formatUsd(status.costUsd);
}

/**
 * @param {import("./state.js").AgentState} a
 * @returns {CardModel}
 */
export function agentCardModel(a) {
  const card = a.card ?? {};
  const session = a.session ?? card.session;
  const status = a.status ?? card.status;
  const cwd = String(session?.cwd ?? card.cwd ?? "");
  const state = a.down ? "down" : card.state === "stale" ? "stale" : "live";
  return {
    key: a.key,
    title: shortCwd(cwd),
    kind: String(card.kind ?? "?"),
    cwd,
    session:
      typeof session?.name === "string" && session.name !== ""
        ? session.name
        : String(session?.sessionId ?? "").slice(0, 8),
    busy: status?.busy === true,
    cost: costLabel(status),
    stale: state !== "live",
    down: a.down,
    outdated: card.outdated === true,
    blocked: bannerText(a.prompts) !== null,
    state,
  };
}
