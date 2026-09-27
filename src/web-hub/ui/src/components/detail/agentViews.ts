/**
 * Typed views over `AgentState`'s deliberately loose `card`/`session`/`status`
 * `Record<string, unknown>` fields (vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
 * `components/detail/**`). `types.ts` (P0 frozen) keeps those three fields structurally loose
 * on purpose — see its own header comment — so every consumer that wants the concrete wire
 * shape (`AgentCard` / `SessionInfo` / `StatusInfo` from `@protocol/*`) does its own minimal
 * shape check here instead of blindly casting at each call site.
 */
import type { AgentCard } from "@protocol/http-contract.js";
import type { SessionInfo, StatusInfo } from "@protocol/messages.js";
import type { AgentState } from "../../types.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function sessionOf(agent: Pick<AgentState, "session">): SessionInfo | undefined {
  const s = agent.session;
  if (!isRecord(s) || typeof s["sessionId"] !== "string" || typeof s["cwd"] !== "string") return undefined;
  return s as unknown as SessionInfo;
}

export function cardOf(agent: Pick<AgentState, "card">): AgentCard | undefined {
  const c = agent.card;
  if (!isRecord(c) || typeof c["agentKey"] !== "string") return undefined;
  return c as unknown as AgentCard;
}

export function statusOf(agent: Pick<AgentState, "status">): StatusInfo | undefined {
  const s = agent.status;
  if (!isRecord(s)) return undefined;
  return s as unknown as StatusInfo;
}
