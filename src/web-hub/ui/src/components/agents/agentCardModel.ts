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
import { bashJobsOf, summaryCounts } from "../detail/bashJobsView.js";

function record(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Home directory of the hub machine, recovered from a worktree row that carries both the raw
 * `path` and its home-abbreviated `label` (`~/x` ⇒ path ends with `/x`). No protocol field
 * carries the home dir, so this is best-effort: `undefined` ⇒ callers show the absolute path.
 */
export function homeFromAgent(agent: AgentState): string | undefined {
  const rows = record(record(agent.status)["worktrees"])["rows"];
  if (!Array.isArray(rows)) return undefined;
  for (const raw of rows) {
    const row = record(raw);
    const label = row["label"];
    const path = row["path"];
    if (typeof label !== "string" || typeof path !== "string" || !label.startsWith("~")) continue;
    const rest = label.slice(1);
    if (rest === "") return path === "" ? undefined : path;
    if (rest.startsWith("/") && path.length > rest.length && path.endsWith(rest)) return path.slice(0, -rest.length);
  }
  return undefined;
}

/** First home dir any agent can prove (all agents of one hub share a machine). */
export function homeFromAgents(agents: Iterable<AgentState>): string | undefined {
  for (const a of agents) {
    const h = homeFromAgent(a);
    if (h !== undefined) return h;
  }
  return undefined;
}

/** Full cwd with a leading `~` when it lives under `home`; absolute path otherwise. */
export function shortCwd(cwd: string, home?: string): string {
  if (cwd === "") return "/";
  if (home !== undefined && home !== "") {
    if (cwd === home) return "~";
    if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  }
  return cwd;
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

/** 2026-10-15 会话列表也展示运行中的命令:the session's own RUNNING background bash jobs.
 * `agent.status.bashJobs` is broadcast for every card (not just the open session); narrowed via
 * `bashJobsOf` (absent/malformed/empty wire ⇒ 0). The wire's `running` is the agent-side
 * non-terminal row count (staged included) — exactly the 「仍在跑」 semantics. */
function runningBashCountOf(agent: AgentState): number {
  const wire = bashJobsOf(agent);
  return wire === undefined ? 0 : summaryCounts(wire).running;
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

export function toAgentCardView(agent: AgentState, t: I18nHandle["t"], home?: string): AgentCardView {
  const card = record(agent.card);
  const visual = agentVisualState(agent);
  return {
    key: agent.key,
    kind: card["kind"] === "rpc" ? "rpc" : "tui",
    shortCwd: shortCwd(cwdOf(agent), home ?? homeFromAgent(agent)),
    cwdFull: cwdOf(agent),
    sessionLabel: sessionLabel(agent, t),
    modelShort: modelShortOf(agent),
    contextPercent: contextPercentOf(agent),
    runningSubCount: runningSubCountOf(agent),
    runningBashCount: runningBashCountOf(agent),
    costLabel: agentCostLabel(agent),
    ...(costTitleOf(agent, t) ?? {}),
    visualState: visual,
    statusLabel: statusLabelOf(agent, visual, t),
    stale: visual === "stale",
    down: agent.down,
    outdated: card["outdated"] === true,
  };
}

/** Unread cross-session inbox count (§12.6): hub cap `xs.v1` ∧ `status.xsInbox.unread` ≥ 1.
 *  Returns the integer count, or undefined (absent/malformed ⇒ nothing renders). */
export function xsUnreadOf(agent: AgentState | undefined, hubCaps: unknown): number | undefined {
  if (!Array.isArray(hubCaps) || !hubCaps.includes("xs.v1") || !agent) return undefined;
  const n = record(record(agent.status)["xsInbox"])["unread"];
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** Compact badge text: counts above 99 saturate to `99+`. */
export function xsUnreadLabel(n: number): string {
  return n > 99 ? "99+" : String(n);
}

export type XsReceive = "wake" | "deliver" | "replies" | "off";

/** Channel-plan §2.1/§3.1: hub/agent cap and default channel (UI mirror constants, same
 *  precedent as `SESSION_REF_LEN` — the protocol module is not importable from the UI bundle). */
export const XS_CHANNEL_CAP = "xs.channel.v1";
export const XS_DEFAULT_CHANNEL = "default";

/** Effective channel set of an agent (§3.2: `status.xs.channels`, absent ∧ joined ⇒ `[default]`).
 *  Requires hub caps ∋ `xs.channel.v1`; undefined = no cap / not a member / malformed. */
export function xsChannelsOf(agent: AgentState | undefined, hubCaps: unknown): readonly string[] | undefined {
  if (!Array.isArray(hubCaps) || !hubCaps.includes(XS_CHANNEL_CAP) || !agent) return undefined;
  const xs = record(record(agent.status)["xs"]);
  const raw = xs["channels"];
  if (Array.isArray(raw)) {
    const names = raw.filter((c): c is string => typeof c === "string" && c !== "");
    if (names.length > 0) return names;
  }
  return xs["joined"] === true ? [XS_DEFAULT_CHANNEL] : undefined;
}

/** Channels worth a chip: only a set that differs from `[default]` renders (§7). */
export function xsChannelChipOf(agent: AgentState | undefined, hubCaps: unknown): readonly string[] | undefined {
  const set = xsChannelsOf(agent, hubCaps);
  if (set === undefined) return undefined;
  return set.length === 1 && set[0] === XS_DEFAULT_CHANNEL ? undefined : set;
}

/** Read-only xs badge. Hub cap is required; absent/malformed membership status is inert.
 *  A session that only sits in named channels reports `joined:false` (§3.2) — with the channel
 *  cap and a non-empty `channels` it still counts as a member. */
export function xsBadgeOf(agent: AgentState | undefined, hubCaps: unknown): XsReceive | undefined {
  if (!Array.isArray(hubCaps) || !hubCaps.includes("xs.v1") || !agent) return undefined;
  const xs = record(record(agent.status)["xs"]);
  if (xs["joined"] !== true && xsChannelsOf(agent, hubCaps) === undefined) return undefined;
  const receive = xs["receive"];
  return receive === "wake" || receive === "deliver" || receive === "replies" || receive === "off"
    ? receive
    : undefined;
}
