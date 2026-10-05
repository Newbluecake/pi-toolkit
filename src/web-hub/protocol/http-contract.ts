/**
 * hub↔browser contract (plan §包 A — frozen interface).
 *
 * The frontend (package E) mirrors these by hand in `web/contract.js`; E's
 * tests compare against these arrays to catch drift.
 */
import type {
  AgentKind,
  CommandInfoWire,
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
  "spawns", // web-hub-spawn arch §8.2: `SpawnsPayload` snapshot/broadcast (Public projection only)
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
  // web-hub-upload plan §1.2: upload endpoint error codes (v3 #4/#8 add E_UPLOAD_CONFLICT/E_UPLOAD_GONE).
  "E_UPLOAD_TOO_LARGE",
  "E_UPLOAD_QUOTA",
  "E_UPLOAD_OFFSET",
  "E_UPLOAD_DISABLED",
  "E_UPLOAD_CONFLICT",
  "E_UPLOAD_GONE",
  // web-hub-spawn plan §SP1 / arch §8.2: spawn endpoint error codes (added after upload's
  // six, per the §2.3 hot-file window rule — tail-append only).
  "E_SPAWN_DENIED", // 403 — policy/platform refusal before any record is created
  "E_DIR", // 400 — cwd admission / pin failures (reason in message)
  "E_LIMIT", // 409 — global / per-principal / starting-slot caps
  "E_LAUNCHER", // 503 — launcher fingerprint / persist / reaper unavailable
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
  /** accfix-N2: mirrors `dialogs` — the last known `commands` slot value, so a browser tab
   * that attaches (or reattaches) AFTER the agent already announced its commands doesn't have
   * to wait for a fresh live `commands` SSE event (which may never come again on its own) to
   * enter command mode. */
  commands?: CommandInfoWire[];
  /** web-hub-upload plan §5.1/U1 #10: whether this agent currently advertises `upload.v1` /
   * `upload.lan.v1` (derived from its hello caps, same pattern as `control`). */
  upload?: boolean;
  uploadLan?: boolean;
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
