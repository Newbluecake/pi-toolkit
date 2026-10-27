/**
 * `AgentState` → `AgentCardView` mapping (vue-plan.md v2.1 §3.2, §5.1, §5.2 — P3 exclusive,
 * `components/agents/**`). `AgentListProps.cards` is frozen (`contracts.ts`) as already-derived
 * view models — `DashboardView.vue` calls `toAgentCardView()` once per visible agent inside a
 * `computed()`, so `AgentList.vue`/`AgentCard.vue` themselves stay pure presentation. Mirrors
 * the legacy `@logic/render/agents.js`'s `agentCardModel`/`shortCwd`/`costLabel` (same field
 * priority order), re-expressed against the frozen `AgentState`/`AgentCardView` shapes and the
 * shared `common.status.*` i18n vocabulary instead of hard-coded English badge text.
 */
import { normalizeAlias, XS_ALIAS_MAX_GRAPHEMES } from "@protocol/xs-alias.js";
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

/** ui-design.md §5.1's per-card status pill — only shown for a "worth flagging" state.
 *  2026-10-27 outdated chip 收敛：pill 只表达真实运行状态；outdated 不再顶替它，卡片上
 *  由唯一的「需更新」chip（tooltip 带完整说明、点击即 reload）承担。 */
function statusLabelOf(visual: RunVisualState, t: I18nHandle["t"]): string | null {
  if (visual === "offline") return t("common.status.offline");
  if (visual === "waiting") return t("common.status.waiting");
  if (visual === "stale") return t("common.status.stale");
  if (visual === "running") return t("common.status.running");
  return null;
}

function costTitleOf(agent: AgentState, t: I18nHandle["t"]): { costTitle: string } | undefined {
  const title = agentCostTitle(agent, t);
  return title === undefined ? undefined : { costTitle: title };
}

export function toAgentCardView(agent: AgentState, t: I18nHandle["t"], home?: string): AgentCardView {
  const card = record(agent.card);
  const runningSubCount = runningSubCountOf(agent);
  const runningBashCount = runningBashCountOf(agent);
  // 2026-10-23 user ruling: the LIST marks a session "running" whenever the main session is busy
  // OR it still has background work (running sub-agents / background bash jobs) — an idle main
  // turn with live background work is not "idle". offline/waiting/stale keep precedence.
  const base = agentVisualState(agent);
  const visual: RunVisualState = base === "idle" && (runningSubCount > 0 || runningBashCount > 0) ? "running" : base;
  return {
    key: agent.key,
    kind: card["kind"] === "rpc" ? "rpc" : "tui",
    shortCwd: shortCwd(cwdOf(agent), home ?? homeFromAgent(agent)),
    cwdFull: cwdOf(agent),
    sessionLabel: sessionLabel(agent, t),
    modelShort: modelShortOf(agent),
    contextPercent: contextPercentOf(agent),
    runningSubCount,
    runningBashCount,
    costLabel: agentCostLabel(agent),
    ...(costTitleOf(agent, t) ?? {}),
    visualState: visual,
    statusLabel: statusLabelOf(visual, t),
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

// ---------------------------------------------------------------------------
// alias-plan r4 (ALU): session alias display + suggestion model. Cap-gated on
// `xs.alias.v1` (mirrors `XS_ALIAS_HUB_CAP` in protocol/xs.ts — the UI bundle keeps a local
// constant, same precedent as XS_CHANNEL_CAP above); no cap or no `status.xs.alias` field ⇒
// every helper is inert and the UI renders byte-identical to the pre-alias shape.
// ---------------------------------------------------------------------------

export const XS_ALIAS_CAP = "xs.alias.v1";

/** Q8 (revised 2026-10-27, user report: `@claude2a…` clipped a 10-char alias while the row had room):
 *  the card chip shows the whole alias — the cap equals the protocol maximum (16 clusters), so
 *  truncation is only a defensive backstop against an out-of-contract wire value. */
export const XS_ALIAS_CARD_GRAPHEMES = XS_ALIAS_MAX_GRAPHEMES;

/** The session's held alias (`status.xs.alias`, written only while held). undefined = no cap /
 *  no field / malformed — the caller renders nothing. Length-capped defensively: the wire caps
 *  it at 48 bytes, a longer string here is not an alias the hub would have stamped. */
export function xsAliasOf(agent: AgentState | undefined, hubCaps: unknown): string | undefined {
  if (!Array.isArray(hubCaps) || !hubCaps.includes(XS_ALIAS_CAP) || !agent) return undefined;
  const raw = record(record(agent.status)["xs"])["alias"];
  return typeof raw === "string" && raw !== "" && raw.length <= 128 ? raw : undefined;
}

/** First `max` grapheme clusters of `s` (Intl.Segmenter; code-point fallback). */
export function truncateGraphemes(s: string, max: number): { readonly text: string; readonly truncated: boolean } {
  const Seg = (
    globalThis as {
      Intl?: {
        Segmenter?: new (
          l?: string,
          o?: { granularity: "grapheme" },
        ) => { segment(x: string): Iterable<{ segment: string }> };
      };
    }
  ).Intl?.Segmenter;
  if (typeof Seg !== "function") {
    const cps = Array.from(s);
    return { text: cps.slice(0, max).join(""), truncated: cps.length > max };
  }
  let text = "";
  let n = 0;
  let truncated = false;
  for (const part of new Seg(undefined, { granularity: "grapheme" }).segment(s)) {
    if (n >= max) {
      truncated = true;
      break;
    }
    text += part.segment;
    n++;
  }
  return { text, truncated };
}

/** Card chip text: `@` + the whole alias (≤ protocol max), `…` only for an out-of-contract value (Q8 r2);
 *  narrow layouts are clipped by CSS (`.chip-xs-alias`), the title keeps the full text. */
export function aliasChipText(alias: string): string {
  const t = truncateGraphemes(alias, XS_ALIAS_CARD_GRAPHEMES);
  return `@${t.text}${t.truncated ? "\u2026" : ""}`;
}

export interface AliasSuggestion {
  readonly alias: string;
  /** Another online session currently reports this alias (hint only — the hub decides). */
  readonly taken: boolean;
}

/** One maximal run of characters an alias may contain (mirrors the xs-alias whitelist:
 *  ASCII word chars + `-`, Han, kana, ー, precomposed Hangul syllables). */
const ALIAS_RUN_RE = /[A-Za-z0-9_\-\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u{30FC}\u{AC00}-\u{D7A3}]+/u;
/** CJK run inside a cwd segment (for the 「cwd 里的中文段」 suggestion). */
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u;

function candidateOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = normalizeAlias(raw);
  return n.ok ? n.alias : undefined; // too_long/invalid ⇒ dropped, never truncated mid-word
}

/** §7.1 suggestion chips: cwd basename → first alias-char run of the session name → first CJK
 *  run of the last cwd segment that has one. Deduped, the current alias skipped, at most 3;
 *  `taken` marks aliases another session currently reports (greyed but still clickable — the
 *  hub is the authority, and a `taken` reply is what opens the take path). */
export function aliasSuggestions(
  self: AgentState | undefined,
  agents: ReadonlyMap<string, AgentState> | undefined,
  hubCaps: unknown,
): readonly AliasSuggestion[] {
  if (self === undefined || !Array.isArray(hubCaps) || !hubCaps.includes(XS_ALIAS_CAP)) return [];
  const current = xsAliasOf(self, hubCaps);
  const raw: Array<string | undefined> = [];
  const cwd = cwdOf(self);
  const segments = cwd.split("/").filter((s) => s !== "");
  raw.push(segments[segments.length - 1]);
  const name = record(self.session)["name"];
  if (typeof name === "string") raw.push(ALIAS_RUN_RE.exec(name)?.[0]);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg === undefined) continue;
    const m = CJK_RUN_RE.exec(seg);
    if (m !== null) {
      raw.push(m[0]);
      break;
    }
  }
  const out: AliasSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const alias = candidateOf(r);
    if (alias === undefined || alias === current || seen.has(alias)) continue;
    seen.add(alias);
    let taken = false;
    if (agents !== undefined) {
      for (const other of agents.values()) {
        if (other !== self && xsAliasOf(other, hubCaps) === alias) {
          taken = true;
          break;
        }
      }
    }
    out.push({ alias, taken });
    if (out.length >= 3) break;
  }
  return out;
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
