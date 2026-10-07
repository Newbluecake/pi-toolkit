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
  // web-hub-fleet-drawer §3.4 (F0): the three run-transcript browser events (direct-send
  // only, never into the replay ring). Slot in BEFORE "spawns" rather than at the tail:
  // tests/web-hub/protocol/spawn.test.ts pins `SSE_EVENTS.at(-1) === "spawns"`, and that
  // file is frozen for F0 — existing entries keep their relative order, spawn keeps the tail.
  "run_history",
  "run_ev",
  "run_end",
  // web-hub-delete-session plan v2 §2.3/§4.3: card removal (agent or managed-session) broadcast.
  // Must stay BEFORE "spawns" for the same reason run_history/run_ev/run_end do — this file's
  // own `.at(-1) === "spawns"` pin (see `spawn.test.ts:225`) must keep holding.
  "agent_removed",
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
  // web-hub-preview plan v3 §4.1 (PV1): preview endpoint error codes (tail-append after
  // spawn's four, same §2.3 hot-file window rule — append only, never reorder).
  "E_PREVIEW_DENIED", // 403 — cwd/upload admission refusal (body carries reason: PreviewDenyReason)
  "E_PREVIEW_UNSUPPORTED", // 415 — sniffed binary / non-regular file / unknown image dims
  "E_PREVIEW_TOO_LARGE", // 413 — over the byte or pixel cap (body: size/max/reason/dims)
  "E_PREVIEW_CHANGED", // 409 — content identity (or sha256) changed during the preview
  // web-hub-delete-session plan v2 §2.4/§4.1/§4.3: the process may still be alive — refusal,
  // record/卡片 untouched (body carries reason: AgentRemoveErrorReason, "online" | "exit-unconfirmed").
  "E_AGENT_ONLINE",
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
  /** web-hub-fleet-drawer plan §3.2/§7.1 (F0): whether this agent advertises `runtx.v1` /
   * `runtx.lan.v1` (derived from its hello caps, same pattern as `upload`/`uploadLan`).
   * UX-only — the hub re-checks the cap per-request by listener; the UI hides the drawer's
   * transcript entry when the field for the active listener is absent (a missing entry is
   * never a security boundary, §7.1 layer 3). */
  runTranscript?: boolean;
  runTranscriptLan?: boolean;
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
  /** web-hub-session-switch plan §1.2 D2-7(c): forwarded from the agent's snapshot_reply —
   *  the browser drops an in-flight history whose session no longer matches the agent's
   *  current one (a /new //resume //fork racing the snapshot). Optional: an old agent never
   *  supplies it and the client passes such frames through (compat window). Do NOT bump the
   *  proto version for this — additive optional field, same precedent as `StatusInfo.todo`. */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// web-hub-delete-session plan v2 §4.3 (frozen protocol face — P1/P2 import these, never
// redefine the literals): POST /api/agents/remove, its request/response/error shapes, and the
// `agent_removed` SSE payload.
// ---------------------------------------------------------------------------

/** `POST /api/agents/remove` path (§4.1). */
export const AGENT_REMOVE_PATH = "/api/agents/remove";

/**
 * `POST /api/agents/remove` body (§4.1): exactly one of the two target forms — `agentKey` for
 * an `AgentCard`, `spawnId` for a `SpawnRow`. Validation (pattern, `additionalProperties:
 * false`) is the hub's own job (§2.9 `hub/agent-remove.ts`); this is the wire shape only.
 */
export type AgentRemoveRequest = { agentKey: string } | { spawnId: string };

/**
 * `POST /api/agents/remove` success bodies (§2.4 table rows 2/3/5, §4.1): 200 when the target
 * is gone (deletion done, or already absent — idempotent), 202 when a managed session entered
 * (or was already in) the stop grace and will be deleted once its death is confirmed.
 */
export type AgentRemoveResult =
  { removed: true } | { removed: false; pending: true; spawnId: string; state: "stopping" };

/**
 * Shared reason union for the remove endpoint's two refusal codes (§2.4 table rows 3-6, §4.1):
 * `E_AGENT_ONLINE` carries `"online"` (registry says connected) or `"exit-unconfirmed"`
 * (terminal record but death not confirmed — process may still be alive, B-alive); the LAN
 * policy gate reuses `E_SPAWN_DENIED` with `"lan-off"` instead of inventing a third code.
 */
export type AgentRemoveErrorReason = "online" | "exit-unconfirmed" | "lan-off";

/**
 * `agent_removed` SSE payload (§2.3): the browser drops `agentKey` from `agents`/`order`,
 * records it in the reducer's `removed` set, and clears any scoped subscription for it.
 */
export interface AgentRemovedPayload {
  agentKey: string;
}
