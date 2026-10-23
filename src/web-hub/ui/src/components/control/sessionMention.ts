/**
 * Composer @mention — cross-session ("@session:<ref>") entries (todo #10).
 *
 * Pure projection of the hub's agent list into completion rows. Gating mirrors AgentCard's xs
 * badge (hub caps `xs.v1` ∧ `status.xs.joined`), and the CURRENT session must itself be joined
 * (pi side: not joined ⇒ `@session:` passes through to pi, so offering it would be a lie).
 * `ref` = sessionId's first 12 chars — hub `router.ts` `REF_LEN`/`refOf`, resolved by
 * `resolveTarget`'s prefix tier (≥ XS_RESOLVE_PREFIX_MIN) — never the name, which may collide.
 */
import type { I18nHandle } from "../../composables/useI18n.js";
import type { AgentState } from "../../types.js";
import { toAgentCardView, xsAliasOf, xsBadgeOf, xsChannelsOf, type XsReceive } from "../agents/agentCardModel.js";

/** Mirrors hub/xs/router.ts `REF_LEN` (the hub is not importable from the UI bundle). */
export const SESSION_REF_LEN = 12;

export interface SessionMentionTarget {
  readonly key: string;
  readonly ref: string;
  /** Session name, or "" when unnamed. */
  readonly name: string;
  /** `~`-shortened cwd for display. */
  readonly cwd: string;
  readonly cwdFull: string;
  readonly receive: XsReceive;
  /** alias-plan r4 §7.2 (ALU): hub-verified alias for DISPLAY/filtering only — the inserted
   *  value stays `session:<ref>` (R1-12: the browser cannot do the label/file checks). */
  readonly alias?: string;
}

function sessionIdOf(agent: AgentState | undefined): string {
  const id = (agent?.session as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === "string" ? id : "";
}

export function sessionMentionTargets(
  agents: ReadonlyMap<string, AgentState>,
  hubCaps: unknown,
  selfKey: string | null,
  t: I18nHandle["t"],
): readonly SessionMentionTarget[] {
  const self = selfKey === null ? undefined : agents.get(selfKey);
  if (xsBadgeOf(self, hubCaps) === undefined) return [];
  const selfSessionId = sessionIdOf(self);
  // channel-plan §7: with hub cap `xs.channel.v1` only sessions sharing a channel are offered
  // (a UI hint — the hub's list/send authorization is authoritative). No cap ⇒ undefined ⇒ no filter.
  const selfChannels = xsChannelsOf(self, hubCaps);
  const out: SessionMentionTarget[] = [];
  const seen = new Set<string>();
  for (const [key, agent] of agents) {
    if (key === selfKey) continue;
    const receive = xsBadgeOf(agent, hubCaps);
    if (receive === undefined) continue;
    const sid = sessionIdOf(agent);
    if (sid === "" || sid === selfSessionId || seen.has(sid)) continue;
    if (selfChannels !== undefined) {
      const theirs = xsChannelsOf(agent, hubCaps);
      if (theirs === undefined || !theirs.some((c) => selfChannels.includes(c))) continue;
    }
    const view = toAgentCardView(agent, t);
    if (view.visualState === "offline" || view.visualState === "stale") continue;
    seen.add(sid);
    const rawName = (agent.session as { name?: unknown } | undefined)?.name;
    const alias = xsAliasOf(agent, hubCaps);
    out.push({
      key,
      ref: sid.slice(0, SESSION_REF_LEN),
      name: typeof rawName === "string" ? rawName : "",
      cwd: view.shortCwd,
      cwdFull: view.cwdFull ?? "",
      receive,
      ...(alias === undefined ? {} : { alias }),
    });
  }
  return out;
}

/** Case-insensitive prefix match on name / alias / ref / cwd basename; an explicit
 *  `session:` lead is ignored. The alias participates in FILTERING only (§7.2). */
export function filterSessionTargets(
  targets: readonly SessionMentionTarget[],
  query: string,
): readonly SessionMentionTarget[] {
  let q = query.toLowerCase();
  if (q.startsWith("session:")) q = q.slice("session:".length);
  if (q.startsWith("@")) q = q.slice(1); // typing `@前端` filters by alias too
  if (q === "") return targets;
  return targets.filter((s) => {
    const base = s.cwdFull.replace(/\/+$/, "").split("/").pop() ?? "";
    return [s.name, s.alias ?? "", s.ref, base].some((f) => f !== "" && f.toLowerCase().startsWith(q));
  });
}
