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
  "auth", // S1: 会话撤销/到期（用户密码登录，限 LAN listener）{reason:"revoked"|"expired"}
  "dialogs",
  "ctl",
  "commands",
  "cmd_late",
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
  "E_BUSY", // S1: IPC 准入拒绝（在途 64 / 排队 128 满）
  "E_DB", // S1: SQLite 子进程不可用 / 超时
  "E_LOCKED",
  "E_HUB_RESTARTING",
  "E_UNSUPPORTED",
  "E_STALE_CTX",
  "E_BUSY_COMPACTING",
  "E_BUSY_STEER",
  "E_SESSION_CHANGED",
  "E_NOT_RUNNING",
  "E_SUBAGENT_REJECTED",
  "E_DIALOG_CLOSED",
  "E_BAD_ANSWER",
  "E_UNKNOWN_ID",
  "E_UNKNOWN_COMMAND",
  "E_COMMAND_DENIED",
  "E_CONFIRM_REQUIRED", // S1 (LC review fix, lan-plan.md §15.9 #4, additive exception): LAN 登录 §6.2 每 IP
  // 退避锁定 — 之前登录 429 一律 E_RATE，令前端 §10 的倒计时/不自动重试分支永远不可达。
] as const;

/** LAN SSE `event: auth` payload (revoke / expiry — §4.2). */
export interface SseAuthPayload {
  reason: "revoked" | "expired";
}

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
  control?: boolean;
  epoch?: string;
  dialogs?: unknown;
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
