/**
 * Agent list (left column, plan §包 E): one card per connected pi process —
 * kind / cwd / session name / busy / cost / stale (greyed) / down / outdated.
 */
import { clip, el, formatUsd } from "./dom.js";
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
 * @param {import("../state.js").AgentState} a
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

/**
 * @param {Document} doc
 * @param {import("../state.js").State} s
 * @param {(agentKey: string) => void} onSelect
 * @returns {HTMLElement}
 */
export function renderAgentList(doc, s, onSelect) {
  const ul = el(doc, "ul", { class: "agent-list", role: "listbox", "aria-label": "agents" });
  if (s.order.length === 0) {
    ul.appendChild(el(doc, "li", { class: "agent-empty" }, "no pi agents connected"));
    return ul;
  }
  for (const key of s.order) {
    const a = s.agents.get(key);
    if (!a) continue;
    const m = agentCardModel(a);
    const selected = s.selected === key;
    const classes = ["agent-card", `state-${m.state}`, selected ? "selected" : "", m.busy ? "busy" : ""].filter(
      Boolean,
    );
    const li = el(
      doc,
      "li",
      {
        class: classes.join(" "),
        role: "option",
        tabindex: "0",
        "data-key": key,
        "data-state": m.state,
        "aria-current": selected ? "true" : undefined,
        title: m.cwd,
      },
      [
        el(doc, "div", { class: "agent-head" }, [
          el(doc, "span", { class: "agent-title" }, clip(m.title, 40)),
          el(doc, "span", { class: `badge kind-${m.kind}` }, m.kind),
          m.busy ? el(doc, "span", { class: "badge badge-busy" }, "busy") : null,
          m.blocked ? el(doc, "span", { class: "badge badge-blocked" }, "dialog") : null,
          m.state !== "live" ? el(doc, "span", { class: `badge badge-${m.state}` }, m.state) : null,
          m.outdated
            ? el(doc, "span", { class: "badge badge-outdated", title: "plugin newer than hub" }, "outdated")
            : null,
        ]),
        el(doc, "div", { class: "agent-session" }, m.session === "" ? "(no session)" : clip(m.session, 60)),
        el(doc, "div", { class: "agent-meta" }, [
          el(doc, "span", { class: "agent-cwd" }, clip(m.cwd, 60)),
          el(doc, "span", { class: "agent-cost" }, m.cost),
        ]),
      ],
    );
    li.addEventListener("click", () => onSelect(key));
    li.addEventListener("keydown", (/** @type {any} */ ev) => {
      if (ev && (ev.key === "Enter" || ev.key === " ")) onSelect(key);
    });
    ul.appendChild(li);
  }
  return ul;
}
