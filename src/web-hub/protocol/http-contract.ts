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
import { WTDIFF_FILE_PATH, WTDIFF_FILES_PATH } from "./worktree-diff.js";
import type { CompleteItemWire } from "./command-args.js";

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
  // sysload plan §7.1: the hub's direct-send host-load snapshot (§7.2). Must stay BEFORE
  // "spawns" for the same reason run_history/run_ev/run_end do — this file's own
  // `.at(-1) === "spawns"` pin (see `spawn.test.ts:225`) must keep holding. Slotted in BEFORE
  // "agent_removed" (rather than after) so `agent-remove.test.ts`'s existing "agent_removed
  // sits immediately before spawns" adjacency pin keeps holding untouched.
  "load",
  // scheduled-reports plan r3 §5.6 (H1): the hub-global schedule projection snapshot
  // (SchedulesPayloadWire, fingerprint-gated direct-send — never the replay ring, no `id:`;
  // the connect burst sends it right AFTER `load`, W1's §7.2「随 agents 重发快照」). Slotted
  // here (after `load`, before `privacy`) purely to keep the two tail pins below untouched;
  // the relative order against privacy/load carries no protocol meaning. Only sent while
  // `sched.v1` is a live hub cap (config.schedule absent ⇒ this event is NEVER emitted,
  // byte-identical hub).
  "schedules",
  // web-hub-privacy plan v2.1 (P1): the hub-global locked-sessionId set (full snapshot,
  // direct-send only — never the replay ring; connect burst sends it BEFORE `agents`). Slotted
  // BEFORE "agent_removed" for the same reason `load` is — `agent-remove.test.ts`'s
  // "agent_removed sits immediately before spawns" adjacency pin and `spawn.test.ts`'s
  // `.at(-1) === "spawns"` pin both keep holding untouched.
  "privacy",
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
  // worktree-diff plan v3 §1.4 (D0): worktree-diff endpoint error codes (tail-append after
  // delete-session's E_AGENT_ONLINE, same append-only / never-reorder rule). `E_STALE_CTX`
  // (409) is REUSED — only its body reason is new (`WtDiffStaleReason`, protocol/worktree-diff.ts).
  "E_WTDIFF_DENIED", // 403 — membership / denylist / virtual-fs refusal (body carries reason: WtDiffDenyReason)
  "E_WTDIFF_UNSUPPORTED", // 415 — unborn / symlink / filter-config; 503 — git-too-old / git-unavailable
  // web-hub-avatar plan v2.1 §2.1 (A0): append-only avatar upload errors.
  "E_AVATAR_TOO_LARGE", // 413 — request body exceeds AVATAR_MAX_BYTES
  "E_AVATAR_UNSUPPORTED", // 415 — strict PNG walk or hub-side IDAT validation rejected it
  // web-hub spawn-relaunch: the relaunch target's session file is gone/unusable — refusal,
  // record untouched (body carries reason: "session-missing" | "session-invalid").
  "E_SPAWN_GONE", // 410
  // web-hub-proxy plan v2 §3.8 (X1c): port-proxy refusals (tail-append, append-only). Body carries
  // reason: `ProxyDenyReason` (+ `ProxyUnavailableExtraReason` for E_PROXY_UNAVAILABLE).
  "E_PROXY_DENIED", // 400/403 — target grammar / address-class refusal
  "E_PROXY_UNAVAILABLE", // 409/503 — reverse-proxy mint, ports store, port busy, closing, DNS timeout
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
  /** web-hub-version plan §2 (V0 frozen face): the agent's own `buildId`
   *  (`<version>@<git %h>[*]`, as announced in its hello). V1's `hub/registry.ts` copies it
   *  through from the record; absent on pre-feature agents — V2's `agent-drift` finding (§4)
   *  degrades to 无法验证 without it, exactly like every other optional card field. UX gating
   *  only, same pattern as `pluginVersion`/`outdated`; never a security boundary. */
  buildId?: string;
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
  /** web-hub-steer-recall plan §2.3 S3: the agent currently advertises `hold.v1` (derived from
   *  its hello caps, same pattern as `control`) — busy web steer/followUp may be held agent-side
   *  and are recallable through `POST /api/cmd {op:"recall"}`. Absent ⇒ the agent never holds
   *  (feature off / pre-feature build): the UI hides every recall affordance and renders the
   *  queue exactly as before. The hub re-checks the live caps on every recall request anyway
   *  (requiredCaps("recall") = [cmd.v1, hold.v1]) — this field is UX gating, not admission. */
  hold?: true;
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

// ---------------------------------------------------------------------------
// worktree-diff plan v3 §1.2/§1.4 (D0 — frozen endpoint SHAPE only; the paths, caps, envelope
// types, validators and parsers live in `protocol/worktree-diff.ts`; this block pins the HTTP
// face the hub's dispatcher (D3) and the UI transports (D4) code against).
// ---------------------------------------------------------------------------

/**
 * The two worktree-diff endpoints (§1.2): `GET`-only, both require the `X-PWH: 1` header
 * (same header discipline as `GET /api/preview`) and answer
 * `Cache-Control: no-store` + `Cross-Origin-Resource-Policy: same-origin`. Loopback is always
 * dispatched; LAN only when the preview mode is `"on"` (D6). 200 bodies are `WtDiffFileList` /
 * `WtDiffFilePayload`; refusals carry the `E_WTDIFF_*` codes above (plus reused `E_STALE_CTX`,
 * `E_RATE`, `E_BUSY`, `E_DEADLINE`, …) with a `reason` from `protocol/worktree-diff.ts`.
 */
export const WTDIFF_ENDPOINTS = [
  { method: "GET", path: WTDIFF_FILES_PATH },
  { method: "GET", path: WTDIFF_FILE_PATH },
] as const;

// ---------------------------------------------------------------------------
// sysload plan (docs/dev/sysload/plan.md) §7.1/§7.3 (frozen protocol face): the single
// `GET /api/load/top` endpoint. `LoadWire`/`LoadTopWire` themselves live in `protocol/
// messages.ts` (same convention as every other wire DTO in that file); this block only pins the
// path — the request has no body and the response envelope is just `LoadTopWire` itself.
// ---------------------------------------------------------------------------

/**
 * `GET /api/load/top` path (§7.3): on-demand top-process refresh/read, same auth-before-IO,
 * single-flight + 2s cache, per-principal rate limit (1 req/s burst 3) and ≤8-waiter /
 * 1.5s-deadline discipline as the rest of the LAN-equal-width endpoints (Q5). Requires the same
 * `X-PWH: 1` CSRF-hygiene header as `GET /api/preview`/the worktree-diff endpoints.
 */
export const LOAD_TOP_PATH = "/api/load/top";

// ---------------------------------------------------------------------------
// web-hub-slash-args plan §4.2/§9 (P0 frozen surface — the browser-facing HTTP face of the
// `/` command argument-completion channel). The agent↔hub frames + budget block live in
// `protocol/command-args.ts`; the PATH lives HERE because `ui/src/logic/contract.js` imports
// this module (command-args.ts carries runtime typebox schemas, which must not reach the
// browser bundle — same bundler-line rule as run-transcript.ts). NO new API_ERRORS entries:
// the route reuses existing codes — 400 E_BAD_REQUEST (bad name/prefix), 404 E_UNSUPPORTED
// (agent offline / missing cmd.args.v1 cap / route not constructed), 429 E_RATE (+Retry-After),
// 503 E_BUSY (hub in-flight cap), and the agent's reply codes (E_UNKNOWN_COMMAND /
// E_COMMAND_DENIED / E_RATE / E_DEADLINE, already in the list) pass through the 200-or-error
// envelope below. `Cache-Control: no-store`; never enters the /api/cmd idempotency ledger.
// ---------------------------------------------------------------------------

/** `POST /api/command/complete` path (§4.2): JSON body + `X-PWH: 1` + strictCsrf (same
 *  discipline as `/api/cmd`; POST keeps the prefix out of URLs / reverse-proxy logs). Same
 *  authorize() as `/api/cmd` — LAN and loopback same-width while the feature is on. */
export const COMMAND_COMPLETE_PATH = "/api/command/complete";

/** Request body (§4.2): `name` reuses the command-name grammar, `prefix` ≤1 KiB without
 *  \r\n / control chars (hub validates; `CompleteReqSchema` re-checks shape defensively). */
export interface CommandCompleteRequest {
  agentKey: string;
  name: string;
  prefix: string;
}

/** 200 body: items already trimmed by the agent (§4.3 #6); the hub re-trims defensively
 *  (≤50 items / ≤16 KiB). `source` mirrors the reply frame's. */
export interface CommandCompleteResult {
  items: CompleteItemWire[];
  truncated?: true;
  source: "own" | "tui";
}
