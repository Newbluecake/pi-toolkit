/**
 * hub↔browser contract (plan §包 A — frozen interface).
 *
 * The frontend (package E) mirrors these by hand in `web/contract.js`; E's
 * tests compare against these arrays to catch drift.
 */
import type {
  AgentKind,
  InflightState,
  SessionInfo,
  StatusInfo,
  SnapshotReplyBody,
  WireEntry,
  WireMessage,
} from "./messages.js";

export const SSE_EVENTS = [
  "hello",
  "hub",
  "agents",
  "agent_up",
  "agent_down",
  "agent_stale",
  "session",
  "history",
  "ev",
  "status",
  "fleet",
  "prompt",
  "gap",
  "resync",
  "append", // spike K7④：hub 从会话文件尾部补出的、事件流未覆盖的条目 {agentKey, entries: WireEntry[]}
  "ping",
] as const;

export const API_ERRORS = [
  "E_AUTH",
  "E_CSRF",
  "E_HOST",
  "E_RATE",
  "E_NOT_FOUND",
  "E_BAD_REQUEST",
  "E_DEADLINE",
  "E_AGENT_GONE",
  "E_NOT_IMPLEMENTED",
] as const;

export interface AgentCard {
  agentKey: string;
  kind: AgentKind;
  pid: number;
  cwd: string;
  state: "live" | "stale";
  pluginVersion: string;
  outdated: boolean;
  session?: SessionInfo;
  status?: StatusInfo;
  prompts: SnapshotReplyBody["prompts"];
}

export interface HistoryPayload {
  agentKey: string;
  entries: WireEntry[];
  tailMessages: WireMessage[];
  inflight?: InflightState;
  fromSeq: number;
  hasMore: boolean;
  oldestEntryId?: string;
  source: "file" | "agent";
}
