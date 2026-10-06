/**
 * Agent↔hub wire types and frame decoding (plan §包 A — frozen interface).
 *
 * Validation posture (plan 实现要点): `hello` is validated strictly (every
 * field, incl. a 16–64 char base64url `agentId.nonce`); `ev.e` and `WireMessage`
 * payloads are same-user trusted and only checked for the `type`/`role`
 * literal plus total serialized size (≤ MAX_FRAME_BYTES). Unknown frame types —
 * including RESERVED_FRAME_TYPES — decode to `undefined` and are ignored.
 */
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { MAX_FRAME_BYTES } from "./ndjson.js";
import {
  type RunEndFrame,
  RunEndSchema,
  type RunEvFrame,
  RunEvSchema,
  type RunGapFrame,
  RunGapSchema,
  type RunTxReplyFrame,
  RunTxReplySchema,
  type RunTxReqFrame,
  RunTxReqSchema,
  type RunWatchFrame,
  RunWatchSchema,
} from "./run-transcript.js";
import type { LanStatus } from "./lan.js";

// ---------------------------------------------------------------------------
// data types
// ---------------------------------------------------------------------------

export type AgentId = { pid: number; nonce: string };
export type AgentKind = "tui" | "rpc";

export interface WireMessage {
  role: string;
  timestamp?: number;
  toolCallId?: string;
  customType?: string;
  [k: string]: unknown;
}

export interface WireEntry {
  id: string;
  parentId: string | null;
  type:
    | "message"
    | "custom_message"
    | "custom"
    | "compaction"
    | "branch_summary"
    | "model_change"
    | "thinking_level_change"; // custom(data) 投影为不渲染条目（无 data，仅 customType + dataKey），参与对账不参与显示
  timestamp: string;
  message?: WireMessage;
  summary?: string;
  firstKeptEntryId?: string;
  customType?: string;
  content?: unknown; // custom_message 的载荷（渲染用）
  dataKey?: string; // custom(data)：customKey(customType, data) 预算值，data 本体不下发
  display?: boolean;
  truncated?: boolean;
  provider?: string; // model_change
  modelId?: string; // model_change
  thinkingLevel?: string; // thinking_level_change
}

export interface ModelOptionWire {
  provider: string;
  id: string;
  name?: string;
  ctx?: number;
  reasoning?: true;
  scoped?: true;
}

export interface SessionModelsWire {
  status: string;
  items: ModelOptionWire[];
  total: number;
  omitted?: number;
  invalid?: number;
  scoped?: true;
  levels?: string[];
  policy: { model: string; thinking: string };
  shadowed?: { model?: true; thinking?: true };
  sampledAt: number;
}
export interface SessionInfo {
  sessionId: string;
  sessionFile?: string;
  name?: string;
  cwd: string;
  reason: string;
  leafId: string | null;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  mode: "tui" | "rpc";
  models?: SessionModelsWire;
}

export interface QueueItemWire {
  id: string;
  text: string;
  deliver: "steer" | "followUp";
  source: "web" | "tui" | "extension";
  cmdId?: string;
  at: number;
}

/**
 * todo-web plan §3.1 (T2): one task row of `StatusInfo.todo`. `metadata`, `blocks`
 * and `createdAt` deliberately stay agent-side (display-invisible; metadata is
 * arbitrary agent data — never crossing the process boundary shrinks the
 * injection surface). `blockedBy` carries `activeBlockers` (open blockers
 * only), matching the TUI widget's `[blocked by #n]` line.
 */
export interface TodoTaskWire {
  id: number;
  subject: string; // ≤200 chars (todo's own createTask bound, passed through)
  status: "pending" | "in_progress" | "completed";
  owner?: string; // passed through (≤200 chars)
  activeForm?: string;
  blockedBy: number[];
  /** Truncated to 240 UTF-8 bytes by the projection; empty string omitted. */
  description?: string;
  /** Present only when `description` was truncated. */
  descTruncated?: true;
}

/** `StatusInfo.todo`'s body: a bounded, orderTasks-ordered projection of the main session's task list. */
export interface TodoWire {
  /** ≤ TODO_WIRE_MAX_TASKS (32), orderTasks order (completed sink to the bottom). */
  tasks: TodoTaskWire[];
  /** Full-population task count (includes capped-away rows); always = counts open+inProgress+completed. */
  total: number;
  /** Full-population counts; `blocked` = non-completed tasks with open blockers (TUI widget's gauge). */
  counts: { open: number; inProgress: number; completed: number; blocked: number };
  /** total - tasks.length, when the 32-task cap or the byte budget dropped rows. */
  omitted?: number;
  /** max(updatedAt) over the projected tasks ("recently updated" display). */
  updatedAt: number;
}

/**
 * worktree-web plan §3.1 (W2): one row of `StatusInfo.worktrees` (ranked: current → main →
 * others → `pi-agent-*` → prunable). Deliberately **open** (no `additionalProperties:false`,
 * see `WorktreesWireSchema`) — a `decodeWith` failure drops the *whole* status frame, and the hub
 * replacement window can leave a new agent talking to an old hub for up to 30 min (control-plan
 * D25), so a closed nested schema would freeze this shape across every future field addition.
 */
export interface WorktreeRowWire {
  label: string; // home-abbreviated path (`~/ai/pi-toolkit`), projection cap 200 B
  path?: string; // absolute path, projection cap 1024 B; FIRST field dropped under budget pressure (pass 2)
  branch?: string; // `refs/heads/` stripped, projection cap 200 B; absent ⇒ detached or bare
  head?: string; // 7-char short sha; absent for bare / unborn
  current?: true; // realpath(row.path) === realpath(toplevel)
  main?: true; // first entry of `git worktree list` (the main worktree)
  agentRunId?: string; // branch `pi-agent-<id>` ⇒ `<id>` (safeRunId form), projection cap 64 B
  bare?: true;
  locked?: true;
  prunable?: true; // never probed
  dirty?: number; // status probe produced a count (exact, or a lower bound when dirtyCapped)
  dirtyCapped?: true; // status stdout hit the 64 KiB cap: dirty is a LOWER BOUND (UI `*N+`)
  untrackedSkipped?: true; // degraded probe (`-uno`): untracked files not counted (UI `~`)
  ahead?: number; // probe OK AND upstream configured only
  behind?: number;
  unprobed?: "cap" | "timeout" | "error"; // no dirty/ab: beyond probe cap / probe timed out / probe failed
}

/**
 * worktree-web plan §3.1 (W2): `StatusInfo.worktrees`' body. Absent ⇒ cwd not in a git repo /
 * not sampled yet / web-hub off. `rows` is the ≤24-row, ranked, byte-budgeted projection;
 * `total`/`probed`/`dirtyCount`/`agentCount` are full-population counts (never trimmed by the
 * 16 KiB wire budget or the 24-row cap).
 */
export interface WorktreesWire {
  rows: WorktreeRowWire[]; // ≤ WT_MAX_ROWS (24), ranked
  total: number; // full parsed `git worktree list` population (a lower bound when listCapped)
  listCapped?: true; // `worktree list` stdout hit its cap; only complete records were parsed
  omitted?: number; // total - rows.length, when > 0
  probed: number; // full-population rows with a dirty count
  dirtyCount: number; // probed rows with dirty > 0
  agentCount: number; // full-population pi-agent-* rows
  sampledAt: number; // agent-clock epoch ms of the successful sample that produced this content
  staleMin?: number; // agent-computed: whole minutes since sampledAt, present only when > 90 s
}

/**
 * bash-jobs-panel plan §2 (包 A0, D2/D2a): one row of `StatusInfo.bashJobs` — the session's own
 * background bash jobs only (no child sessions, D1). `cmd` and `tail` are agent-side redacted
 * (`redactSecrets`, best-effort hygiene — NOT a security boundary, D2a) and byte/char capped by
 * the projection (cmd ≤200 chars / ≤600 B, tail ≤1024 B / ≤10 lines, D6). Deliberately **open**
 * (no `additionalProperties:false`, see `BashJobsWireSchema`): same posture as `WorktreeRowWire`.
 * `logPath` was cut in plan v2 (#2) — it never crosses the wire; the notification card already
 * carries it. `status` is the agent's job-status literal as a plain string (open enum: a future
 * status value must not be dropped by an older peer; unknown values render generic in the UI, D4).
 */
export interface BashJobRowWire {
  id: string; // projection cap 32 B
  cmd: string; // redacted, ≤200 chars / ≤600 B
  /** Present only when `cmd` was char-truncated by the projection (D6 caps). */
  cmdTruncated?: true;
  status: string; // e.g. "running" | "exited" | "failed" | "timeout" | "orphaned" | "exited_unknown" …
  exitCode: number | null; // null while running / killed without a code
  createdAt: number; // agent-clock epoch ms
  endedAt?: number; // terminal rows only
  elapsedMs: number; // agent clock at projection − createdAt (terminal rows freeze at endedAt)
  logBytes: number; // record's known log size; `+`-truncated view ⇒ logTruncated
  /** Tail starts mid-file (read offset > 0): earlier output existed but is not in `tail`. */
  logTruncated?: true;
  grace?: true; // job entered a bash-job timeout-grace window (deadline.ts)
  tail?: string; // redacted, ≤1024 B / ≤10 lines
  tailAt?: number; // agent clock when that tail was sampled
  tailBytes?: number; // file size seen by that sample (footer-race detection, D3-2)
  /** Sampler gave up (read failures ×3) at the recorded logBytes; never co-present with tailCurrent. */
  tailUnavailable?: true;
  /** Agent-judged freshness (D3-3): UI must NOT compare clocks itself — sampling…/stale markers derive from this flag (+ tailAt age). */
  tailCurrent?: true;
}

/**
 * bash-jobs-panel plan §2 (包 A0): `StatusInfo.bashJobs`' body. Absent ⇒ no background jobs /
 * bash-jobs disabled / web-hub disabled / source manager missing (byte-equal to the pre-feature
 * status shape, D5). `rows` is the ≤20-row, ranked (running first, then terminal newest-first),
 * byte-budgeted (24 KiB, D6) projection; `total`/`running`/`failed` are full-population counts
 * over the selected rows' source set — never trimmed by the row cap or the wire budget.
 */
export interface BashJobsWire {
  rows: BashJobRowWire[]; // ≤ 20 (D1); schema headroom 64
  total: number; // selected rows before the 20/12 caps (D1)
  running: number; // non-terminal rows
  failed: number; // terminal rows the agent counts as failed
  /** Dropped by the 20-row/12-terminal caps (D1) or the five-pass byte budget (D6); absent when 0. */
  omitted?: number;
  sampledAt: number; // agent-clock epoch ms of the projection that produced this content
}

export interface StatusInfo {
  leafId: string | null; // spike K7④：leaf 变化是 idle custom_message 的唯一信号（不经扩展事件）
  busy: boolean;
  pending: boolean;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  costUsd?: number;
  subagentCostUsd?: number;
  queue?: QueueItemWire[];
  queueDropped?: string[];
  /** todo-web plan §2.1/D1 (T2): optional main-session task-list summary riding the existing
   *  status slot lifecycle. Absent = no tasks / todo disabled / web-hub disabled (byte-equal to
   *  the pre-feature shape). Decode side stays open-ended: `StatusFrameSchema` deliberately has
   *  no `additionalProperties:false`, so older hubs pass newer frames through untouched. */
  todo?: TodoWire;
  /** worktree-web plan §3 (W2): optional git-worktree summary of the session cwd's repo,
   *  riding the same status slot lifecycle as `todo`/`models`. Absent = cwd not in a git repo /
   *  not sampled yet / web-hub disabled. */
  worktrees?: WorktreesWire;
  /** bash-jobs-panel plan §2 (包 A0): optional read-only background-bash-jobs summary of the
   *  session's own BashJobManager, riding the same status slot lifecycle as `todo`/`worktrees`.
   *  Absent = no background jobs / bash-jobs disabled / web-hub disabled / source missing
   *  (byte-equal to the pre-feature shape, D5). Decode side stays open-ended (same as `todo`). */
  bashJobs?: BashJobsWire;
}

export interface FleetRowWire {
  runId: string;
  label?: string;
  type?: string;
  model?: string;
  status: string;
  phaseLabel: string;
  parentRunId?: string;
  elapsedMs: number;
  phaseMs: number;
  costUsd?: number;
  toolTrail?: string;
  streamLine?: string;
  highlight: "none" | "warn" | "crit";
  terminal: boolean;
}

/**
 * web-hub-fleet-drawer plan §3.2/#12: counts of fleet rows the 64-active/8-terminal projection
 * caps dropped from `fleet.runs` ("另有 N 个未列出" / “父 run 未列出” UI derives from this).
 * Optional on the `fleet` frame — absent when nothing was omitted.
 */
export interface FleetOmitted {
  active: number;
  terminal: number;
}

export interface WireEvent {
  type: (typeof FORWARDED_EVENTS)[number];
  [k: string]: unknown;
} // payload 只校验 type + 大小

export const FORWARDED_EVENTS = [
  /* arch §4.1.1 白名单 */ "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_compact",
  "session_compact_failed",
  "model_select",
  "thinking_level_select",
  "session_info_changed",
  "input",
  "ui_prompt_start",
  "ui_prompt_end",
] as const;

export interface InflightState {
  message?: WireMessage;
  tools: Array<{ toolCallId: string; toolName: string; args: unknown; partial?: string }>;
}

export interface SnapshotReplyBody {
  seq: number;
  leafId: string | null;
  sessionFile?: string;
  recent: Array<{ seq: number; message: WireMessage }>;
  inflight?: InflightState;
  prompts: Array<{ kind: string; title?: string; since: number }>;
  status: StatusInfo;
  fleet: FleetRowWire[];
}

// ---------------------------------------------------------------------------
// P2 control-plane frames (§3.2). These are additive to the P1 wire surface.
// ---------------------------------------------------------------------------
export type CmdOp =
  "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "dialog_answer" | "dialog_cancel" | "command";

export interface CmdOrigin {
  listener: "loopback" | "lan";
  ip: string;
  user?: string;
  reqId: string;
}
export interface CmdExpect {
  sessionId?: string;
}
export interface DialogAnswerWire {
  selected: string[];
  other: string | null;
}
export interface AskUserOptionWire {
  label: string;
  description?: string;
}
export interface AskUserQuestionWire {
  question: string;
  header?: string;
  context?: string;
  options: AskUserOptionWire[];
  multiSelect?: boolean;
  allowOther?: boolean;
}
export type CmdArgs =
  | { op: "prompt"; text: string; deliver: "steer" | "followUp"; expect?: CmdExpect }
  | { op: "abort"; expect?: CmdExpect }
  | { op: "steer_subagent"; runId: string; text: string }
  | { op: "abort_subagent"; runId: string }
  | { op: "dialog_answer"; dialogId: string; epoch: string; answers: DialogAnswerWire[] }
  | { op: "dialog_cancel"; dialogId: string; epoch: string }
  | { op: "command"; name: string; args: string; confirm?: true; deliver?: "steer" | "followUp"; expect?: CmdExpect };
export interface CommandOutputEntry {
  kind: "notify" | "widget" | "status" | "text" | "error" | "interactive";
  level?: "info" | "warning" | "error";
  key?: string;
  title?: string;
  text: string;
  clipped?: true;
}
export interface CommandOutputWire {
  entries: CommandOutputEntry[];
  truncated?: { droppedEntries: number; droppedBytes: number };
  needsTerminal?: true;
}
export type PromptDelivery = "observed" | "unobserved";
export type CmdData =
  | { op: "prompt"; delivery: PromptDelivery; behavior?: "idle" | "steer" | "followUp" }
  | { op: "abort"; wasBusy: boolean }
  | { op: "steer_subagent" }
  | { op: "abort_subagent"; escalatedTo?: "L2" | "L3" | "L4"; alreadyTerminal?: boolean }
  | { op: "dialog_answer" | "dialog_cancel" }
  | {
      op: "command";
      kind: "extension" | "template" | "builtin";
      completion: "sync" | "async" | "unknown" | "timeout";
      captured?: boolean;
      output?: CommandOutputWire;
    }
  | { op: "query"; state: "running" | "ok" | "failed"; late?: true; result?: CmdResultBody };
export type CmdErrorCode =
  | "E_UNSUPPORTED"
  | "E_STALE_CTX"
  | "E_BUSY_COMPACTING"
  | "E_BUSY_STEER"
  | "E_SESSION_CHANGED"
  | "E_BAD_REQUEST"
  | "E_NOT_FOUND"
  | "E_UNKNOWN_ID"
  | "E_NOT_RUNNING"
  | "E_SUBAGENT_REJECTED"
  | "E_DIALOG_CLOSED"
  | "E_BAD_ANSWER"
  | "E_UNKNOWN_COMMAND"
  | "E_COMMAND_DENIED"
  | "E_CONFIRM_REQUIRED"
  | "E_DEADLINE"
  | "E_HUB_RESTARTING"
  | "E_RATE"; // todo #32 finding 4 / §4.5 rule 3: 16-in-flight ledger capacity, agent-side (not the
// hub-level login-throttle E_RATE from protocol/http-contract.ts's API_ERRORS, though the wire
// string is the same).
export type CmdEffect = "none" | "unknown";
export type CmdResultBody =
  | { ok: true; dup?: true; data: CmdData }
  | { ok: false; code: CmdErrorCode; message?: string; retryable: boolean; effect: CmdEffect };
export interface CmdFrame {
  t: "cmd";
  rid: string;
  id: string;
  deadlineMs: number;
  origin: CmdOrigin;
  queryOnly?: true;
  retry?: true;
  cmd: CmdArgs;
}
export type CmdResultFrame = { t: "cmd_result"; rid: string; id: string } & CmdResultBody;
export type CmdLateFrame = { t: "cmd_late"; id: string; op: CmdOp; at: number } & CmdResultBody;
export interface DialogWire {
  dialogId: string;
  source: "ask_user";
  toolCallId: string;
  questions: AskUserQuestionWire[];
  allowCancel: boolean;
  openedAt: number;
}
export interface DialogClosedWire {
  dialogId: string;
  /** Who closed the dialog. `"background"` (ask-user-async plan §7.2, P3) is ask_user's
   *  background-completion interrupt close; hubs gate it on the `dialog.bg.v1` cap and the
   *  agent bridge degrades it to `"abort"` for hubs that did not advertise the cap
   *  (src/web-hub/agent/dialogs.ts) — an un-upgraded hub's runtime schema below drops the
   *  whole dialogs frame on unknown `by` values. */
  by: "tui" | "web" | "abort" | "session" | "error" | "background";
  outcome: "answered" | "cancelled" | "aborted";
  cmdId?: string;
  at: number;
}
export interface DialogsFrame {
  t: "dialogs";
  epoch: string;
  open: DialogWire[];
  closed: DialogClosedWire[];
}
export interface CtlItemWire {
  cmdId: string;
  op: CmdOp;
  state:
    | "dispatched"
    | "observed"
    | "started"
    | "queued"
    | "consumed"
    | "dropped"
    | "unconfirmed"
    | "running"
    | "ok"
    | "failed"
    | "late_ok"
    | "late_failed";
  behavior?: "idle" | "steer" | "followUp";
  reason?: "unobserved" | "not-started" | "not-delivered" | "session" | "timeout";
  code?: CmdErrorCode;
  at: number;
  updatedAt: number;
}
export interface CtlFrame {
  t: "ctl";
  epoch: string;
  sessionId: string;
  items: CtlItemWire[];
}
export interface CommandInfoWire {
  name: string;
  kind: "extension" | "template" | "skill" | "builtin";
  description?: string;
  policy: "allow" | "confirm" | "deny";
  policyBusy?: "allow" | "confirm" | "deny";
  output?: "captured" | "terminal";
}
export interface CommandsFrame {
  t: "commands";
  epoch: string;
  items: CommandInfoWire[];
}
export interface SupersededFrame {
  t: "superseded";
  nextVersion: string;
  yieldMs: number;
  forced?: true;
  openDialogs?: number;
}

// agent→hub
export type AgentFrame =
  | {
      t: "hello";
      proto: { major: number; minor: number };
      pluginVersion: string;
      buildId: string;
      agentId: AgentId; // 进程级纯数据，跨重激活不变
      epoch: string; // = 模块实例 nonce；hub 见 epoch 变化 ⇒ 向订阅者推 gap 触发重新快照
      kind: AgentKind;
      ticket?: string;
      launcher: [string, string];
      cwd: string;
      caps: string[];
    }
  | { t: "bye"; reason: "quit" | "handover" | "detach-timeout" | string } // handover = 同进程新模块实例接手，hub 进入 10s 静默认领窗口
  | ({ t: "session" } & SessionInfo)
  | { t: "session_detached"; reason: string }
  | { t: "ev"; seq: number; e: WireEvent }
  | ({ t: "status" } & StatusInfo)
  | { t: "fleet"; runs: FleetRowWire[]; omitted?: FleetOmitted }
  | ({ t: "snapshot_reply"; rid: string } & SnapshotReplyBody)
  | { t: "branch_reply"; rid: string; entries: WireEntry[]; truncated: boolean }
  | { t: "gap"; fromSeq: number }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | CmdResultFrame
  | CmdLateFrame
  | DialogsFrame
  | CtlFrame
  | CommandsFrame
  // web-hub-fleet-drawer plan §3.1 (F0): run-transcript frames — schema bodies and the
  // authoritative interfaces live in protocol/run-transcript.ts; only folded in here.
  | RunTxReplyFrame
  | RunEvFrame
  | RunGapFrame
  | RunEndFrame
  | LanReqFrame
  | HubCtlFrame;

// ---- S1 LAN control-plane frames (§8.1; 同一个 unix socket，hello 之后才接受，不进 registry/bus/普通日志，不做额外鉴权——同 uid 完全可信) ----

export type LanReqFrame =
  | { t: "lan_req"; rid: string; op: "info" }
  | { t: "lan_req"; rid: string; op: "passwd"; username: string; password: string }
  | { t: "lan_req"; rid: string; op: "unlock" };

export type HubCtlFrame =
  | { t: "hub_ctl"; rid: string; op: "shutdown"; reason: "restart" | "stop" }
  | { t: "hub_ctl"; rid: string; op: "rotate_token" };

export interface HubCtlAckFrame {
  t: "hub_ctl_ack";
  rid: string;
  revoked?: { loopback: number; lan: number };
}

/** `lan_res{ok:true}.info` (§8.1); `lan` 字段是 `hub.json.lan` 同样的 `LanStatus`（定义在 `protocol/lan.ts`，避免与 `hub/ports.ts` 循环引用）。 */
export interface LanInfoPayload {
  username: string;
  initialPassword?: string;
  initialLogin?: { ip: string; at: number };
  lan: LanStatus;
}

export type LanResFrame =
  | { t: "lan_res"; rid: string; ok: true; info?: LanInfoPayload }
  | { t: "lan_res"; rid: string; ok: false; code: string; message: string };

// hub→agent
export type HubFrame =
  | {
      t: "hello_ack";
      hubVersion: string;
      buildId: string;
      proto: { major: number; minor: number };
      agentKey: string;
      pingMs: number;
      leaseMs: number;
      http: { port: number };
      caps?: string[]; // S1: "ctl.v1"（始终带）/ "lan.v1"（收到 config.lan 时带），只在装配了 admin 端口时输出
    }
  | { t: "hello_reject"; code: "E_PROTO" | "E_BAD_HELLO" | "E_TICKET"; message: string; retryAfterMs: number }
  | { t: "snapshot_req"; rid: string }
  | { t: "branch_req"; rid: string; maxBytes: number }
  | RunTxReqFrame
  | RunWatchFrame
  | CmdFrame
  | SupersededFrame
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | LanResFrame
  | HubCtlAckFrame;

export const TIMING = {
  connectMs: 1_000,
  helloAckMs: 2_000,
  pingMs: 10_000,
  silenceMs: 30_000,
  staleMs: 30_000,
  reapMs: 60_000,
  detachGraceMs: 10_000,
  snapshotMs: 5_000,
  backoffMinMs: 500,
  backoffMaxMs: 30_000,
  spawnThrottleMs: 30_000,
  spawnWindowMs: 8_000,
} as const;

export const LIMITS = {
  writeQueueBytes: 1 << 20,
  textTruncateBytes: 64 << 10,
  recentMessages: 64,
  branchReplyBytes: 2 << 20,
  hardQueueBytes: 4 << 20,
  deltaCoalesceMs: 50,
  toolUpdateMs: 250,
  fleetMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// schemas (runtime validation only; the exported interfaces above are the
// authoritative shapes — behavioral tests pin schema/interface agreement)
// ---------------------------------------------------------------------------

const WireMessageSchema = Type.Object({ role: Type.String() }, { additionalProperties: true });

const eventTypeLiterals = FORWARDED_EVENTS.map((e) => Type.Literal(e));
const WireEventSchema = Type.Object({ type: Type.Union(eventTypeLiterals) }, { additionalProperties: true });

const WireEntrySchema = Type.Object(
  {
    id: Type.String(),
    parentId: Type.Union([Type.String(), Type.Null()]),
    type: Type.Union([
      Type.Literal("message"),
      Type.Literal("custom_message"),
      Type.Literal("custom"),
      Type.Literal("compaction"),
      Type.Literal("branch_summary"),
      Type.Literal("model_change"),
      Type.Literal("thinking_level_change"),
    ]),
    timestamp: Type.String(),
  },
  { additionalProperties: true },
);

const ModelOptionSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1, maxLength: 256 }),
    id: Type.String({ minLength: 1, maxLength: 256 }),
    name: Type.Optional(Type.String({ maxLength: 192 })),
    ctx: Type.Optional(Type.Number({ minimum: 0 })),
    reasoning: Type.Optional(Type.Boolean()),
    scoped: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
export const SessionModelsSchema = Type.Object(
  {
    status: Type.String({ maxLength: 32 }),
    items: Type.Array(ModelOptionSchema, { maxItems: 320 }),
    total: Type.Integer({ minimum: 0 }),
    omitted: Type.Optional(Type.Integer({ minimum: 0 })),
    invalid: Type.Optional(Type.Integer({ minimum: 0 })),
    scoped: Type.Optional(Type.Boolean()),
    levels: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 16 })),
    policy: Type.Object(
      { model: Type.String({ maxLength: 16 }), thinking: Type.String({ maxLength: 16 }) },
      { additionalProperties: true },
    ),
    shadowed: Type.Optional(
      Type.Object(
        { model: Type.Optional(Type.Boolean()), thinking: Type.Optional(Type.Boolean()) },
        { additionalProperties: true },
      ),
    ),
    sampledAt: Type.Number(),
  },
  { additionalProperties: true },
);

const SessionInfoSchema = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  cwd: Type.String(),
  reason: Type.String(),
  leafId: Type.Union([Type.String(), Type.Null()]),
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  thinkingLevel: Type.Optional(Type.String()),
  mode: Type.Union([Type.Literal("tui"), Type.Literal("rpc")]),
  models: Type.Optional(SessionModelsSchema),
});

const QueueItemSchema = Type.Object(
  {
    id: Type.String(),
    text: Type.String(),
    deliver: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
    source: Type.Union([Type.Literal("web"), Type.Literal("tui"), Type.Literal("extension")]),
    cmdId: Type.Optional(Type.String()),
    at: Type.Number(),
  },
  { additionalProperties: false },
);
// todo-web plan §3.1 (T2): same nested-payload posture as QueueItemSchema above — the
// task-row/todo bodies are pinned (additionalProperties:false) while the enclosing
// StatusFrameSchema stays open-ended for forward compatibility.
const TodoTaskSchema = Type.Object(
  {
    id: Type.Integer(),
    subject: Type.String(),
    status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    owner: Type.Optional(Type.String()),
    activeForm: Type.Optional(Type.String()),
    blockedBy: Type.Array(Type.Integer()),
    description: Type.Optional(Type.String()),
    descTruncated: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
const TodoWireSchema = Type.Object(
  {
    tasks: Type.Array(TodoTaskSchema),
    total: Type.Integer(),
    counts: Type.Object(
      { open: Type.Integer(), inProgress: Type.Integer(), completed: Type.Integer(), blocked: Type.Integer() },
      { additionalProperties: false },
    ),
    omitted: Type.Optional(Type.Integer()),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);
// worktree-web plan §3.2 (W2): deliberately open (Q4) — see WorktreeRowWire's docstring for why.
// `maxLength`/`maxItems`/`minimum` are hard safety upper bounds, wider than the projection's own
// cap (table in plan §3.2), left as evolution headroom so a future field addition cannot shrink
// these and reject frames an older/newer peer already emits.
const WorktreeRowSchema = Type.Object(
  {
    label: Type.String({ maxLength: 512 }),
    path: Type.Optional(Type.String({ maxLength: 4096 })),
    branch: Type.Optional(Type.String({ maxLength: 512 })),
    head: Type.Optional(Type.String({ maxLength: 64 })),
    current: Type.Optional(Type.Literal(true)),
    main: Type.Optional(Type.Literal(true)),
    agentRunId: Type.Optional(Type.String({ maxLength: 128 })),
    bare: Type.Optional(Type.Literal(true)),
    locked: Type.Optional(Type.Literal(true)),
    prunable: Type.Optional(Type.Literal(true)),
    dirty: Type.Optional(Type.Integer({ minimum: 0 })),
    dirtyCapped: Type.Optional(Type.Literal(true)),
    untrackedSkipped: Type.Optional(Type.Literal(true)),
    ahead: Type.Optional(Type.Integer({ minimum: 0 })),
    behind: Type.Optional(Type.Integer({ minimum: 0 })),
    // Open-ended enum (vs. a Union of literals): an older UI must not reject a future reason value;
    // an unrecognized string just displays as "error" (plan §3.2).
    unprobed: Type.Optional(Type.String({ maxLength: 32 })),
  },
  { additionalProperties: true },
);
export const WorktreesWireSchema = Type.Object(
  {
    rows: Type.Array(WorktreeRowSchema, { maxItems: 64 }),
    total: Type.Integer({ minimum: 0 }),
    listCapped: Type.Optional(Type.Literal(true)),
    omitted: Type.Optional(Type.Integer({ minimum: 0 })),
    probed: Type.Integer({ minimum: 0 }),
    dirtyCount: Type.Integer({ minimum: 0 }),
    agentCount: Type.Integer({ minimum: 0 }),
    sampledAt: Type.Number({ minimum: 0 }),
    staleMin: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
);
// bash-jobs-panel plan §2/§3 包 A0 (D5): same open posture as WorktreesWireSchema above (Q4
// precedent) — a `decodeWith` failure drops the WHOLE status frame, and the hub replacement
// window can pair a new agent with an old hub, so the nested schemas stay open with hard safety
// upper bounds deliberately WIDER than the projection's own caps (rows ≤20, cmd ≤200 chars/
// 600 B, tail ≤1024 B/10 lines, id ≤32 B, status ≤32 B — plan §2/D6): a future field addition
// cannot shrink these and reject frames an older/newer peer already emits. Schema bounds named
// by the plan: rows maxItems 64, cmd maxLength 1024, tail maxLength 8192, status 32.
export const BashJobRowSchema = Type.Object(
  {
    id: Type.String({ maxLength: 128 }),
    cmd: Type.String({ maxLength: 1024 }),
    cmdTruncated: Type.Optional(Type.Literal(true)),
    // Open-ended (vs. a Union of literals): same reasoning as WorktreeRowSchema.unprobed —
    // an older peer must not reject a future job status; unknown values display generic (D4).
    status: Type.String({ maxLength: 32 }),
    exitCode: Type.Union([Type.Number(), Type.Null()]),
    createdAt: Type.Number(),
    endedAt: Type.Optional(Type.Number()),
    elapsedMs: Type.Number({ minimum: 0 }),
    logBytes: Type.Integer({ minimum: 0 }),
    logTruncated: Type.Optional(Type.Literal(true)),
    grace: Type.Optional(Type.Literal(true)),
    tail: Type.Optional(Type.String({ maxLength: 8192 })),
    tailAt: Type.Optional(Type.Number()),
    tailBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    tailUnavailable: Type.Optional(Type.Literal(true)),
    tailCurrent: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: true },
);
export const BashJobsWireSchema = Type.Object(
  {
    rows: Type.Array(BashJobRowSchema, { maxItems: 64 }),
    total: Type.Integer({ minimum: 0 }),
    running: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    omitted: Type.Optional(Type.Integer({ minimum: 0 })),
    sampledAt: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: true },
);
const StatusInfoSchema = Type.Object({
  leafId: Type.Union([Type.String(), Type.Null()]),
  busy: Type.Boolean(),
  pending: Type.Boolean(),
  contextUsage: Type.Optional(
    Type.Object({ tokens: Type.Number(), contextWindow: Type.Number(), percent: Type.Number() }),
  ),
  costUsd: Type.Optional(Type.Number()),
  subagentCostUsd: Type.Optional(Type.Number()),
  queue: Type.Optional(Type.Array(QueueItemSchema)),
  queueDropped: Type.Optional(Type.Array(Type.String())),
  todo: Type.Optional(TodoWireSchema),
  worktrees: Type.Optional(WorktreesWireSchema),
  bashJobs: Type.Optional(BashJobsWireSchema),
});

const FleetRowSchema = Type.Object({
  runId: Type.String(),
  label: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  status: Type.String(),
  phaseLabel: Type.String(),
  parentRunId: Type.Optional(Type.String()),
  elapsedMs: Type.Number(),
  phaseMs: Type.Number(),
  costUsd: Type.Optional(Type.Number()),
  toolTrail: Type.Optional(Type.String()),
  streamLine: Type.Optional(Type.String()),
  highlight: Type.Union([Type.Literal("none"), Type.Literal("warn"), Type.Literal("crit")]),
  terminal: Type.Boolean(),
});

const PromptSchema = Type.Object({
  kind: Type.String(),
  title: Type.Optional(Type.String()),
  since: Type.Number(),
});

const InflightSchema = Type.Object({
  message: Type.Optional(WireMessageSchema),
  tools: Type.Array(
    Type.Object({
      toolCallId: Type.String(),
      toolName: Type.String(),
      args: Type.Unknown(),
      partial: Type.Optional(Type.String()),
    }),
  ),
});

const ProtoSchema = Type.Object({ major: Type.Integer(), minor: Type.Integer() });

// --- agent→hub frames ---

const HelloSchema = Type.Object({
  t: Type.Literal("hello"),
  proto: ProtoSchema,
  pluginVersion: Type.String(),
  buildId: Type.String(),
  agentId: Type.Object({
    pid: Type.Integer(),
    nonce: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }), // base64url, 16–64 chars
  }),
  epoch: Type.String(),
  kind: Type.Union([Type.Literal("tui"), Type.Literal("rpc")]),
  ticket: Type.Optional(Type.String()),
  launcher: Type.Tuple([Type.String(), Type.String()]),
  cwd: Type.String(),
  caps: Type.Array(Type.String()),
});

const ByeSchema = Type.Object({ t: Type.Literal("bye"), reason: Type.String() });

const SessionFrameSchema = Type.Object({ t: Type.Literal("session"), ...SessionInfoSchema.properties });

const SessionDetachedSchema = Type.Object({ t: Type.Literal("session_detached"), reason: Type.String() });

const EvSchema = Type.Object({
  t: Type.Literal("ev"),
  seq: Type.Integer(),
  e: WireEventSchema,
});

const StatusFrameSchema = Type.Object({ t: Type.Literal("status"), ...StatusInfoSchema.properties });

const FleetFrameSchema = Type.Object({
  t: Type.Literal("fleet"),
  runs: Type.Array(FleetRowSchema),
  // fleet-drawer §3.2 (F0): optional visibility block — present only when rows were dropped.
  omitted: Type.Optional(
    Type.Object({ active: Type.Integer(), terminal: Type.Integer() }, { additionalProperties: false }),
  ),
});

const SnapshotReplySchema = Type.Object({
  t: Type.Literal("snapshot_reply"),
  rid: Type.String(),
  seq: Type.Integer(),
  leafId: Type.Union([Type.String(), Type.Null()]),
  sessionFile: Type.Optional(Type.String()),
  recent: Type.Array(Type.Object({ seq: Type.Integer(), message: WireMessageSchema })),
  inflight: Type.Optional(InflightSchema),
  prompts: Type.Array(PromptSchema),
  status: StatusInfoSchema,
  fleet: Type.Array(FleetRowSchema),
});

const BranchReplySchema = Type.Object({
  t: Type.Literal("branch_reply"),
  rid: Type.String(),
  entries: Type.Array(WireEntrySchema),
  truncated: Type.Boolean(),
});

const GapSchema = Type.Object({ t: Type.Literal("gap"), fromSeq: Type.Integer() });
const PingSchema = Type.Object({ t: Type.Literal("ping"), ts: Type.Number() });
const PongSchema = Type.Object({ t: Type.Literal("pong"), ts: Type.Number() });

// --- hub→agent frames ---

const HelloAckSchema = Type.Object({
  t: Type.Literal("hello_ack"),
  hubVersion: Type.String(),
  buildId: Type.String(),
  proto: ProtoSchema,
  agentKey: Type.String(),
  pingMs: Type.Number(),
  leaseMs: Type.Number(),
  http: Type.Object({ port: Type.Integer() }),
  caps: Type.Optional(Type.Array(Type.String())),
});

const HelloRejectSchema = Type.Object({
  t: Type.Literal("hello_reject"),
  code: Type.Union([Type.Literal("E_PROTO"), Type.Literal("E_BAD_HELLO"), Type.Literal("E_TICKET")]),
  message: Type.String(),
  retryAfterMs: Type.Number(),
});

const SnapshotReqSchema = Type.Object({ t: Type.Literal("snapshot_req"), rid: Type.String() });

const BranchReqSchema = Type.Object({
  t: Type.Literal("branch_req"),
  rid: Type.String(),
  maxBytes: Type.Number(),
});

// --- S1 LAN control-plane frames (§8.1): each op / ok variant is its own strict
// (additionalProperties:false) schema, matching the discriminated-union TS types above
// exactly — "passwd" requires username+password and rejects them on "info"/"unlock";
// "ok:true" and "ok:false" are mutually exclusive (the latter requires code+message,
// the former forbids them) (review fix #4). ---

const LanReqInfoSchema = Type.Object(
  { t: Type.Literal("lan_req"), rid: Type.String(), op: Type.Literal("info") },
  { additionalProperties: false },
);
const LanReqPasswdSchema = Type.Object(
  {
    t: Type.Literal("lan_req"),
    rid: Type.String(),
    op: Type.Literal("passwd"),
    username: Type.String(),
    password: Type.String(),
  },
  { additionalProperties: false },
);
const LanReqUnlockSchema = Type.Object(
  { t: Type.Literal("lan_req"), rid: Type.String(), op: Type.Literal("unlock") },
  { additionalProperties: false },
);
const LanReqSchema = Type.Union([LanReqInfoSchema, LanReqPasswdSchema, LanReqUnlockSchema]);

const HubCtlSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal("hub_ctl"),
      rid: Type.String(),
      op: Type.Literal("shutdown"),
      reason: Type.Union([Type.Literal("restart"), Type.Literal("stop")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { t: Type.Literal("hub_ctl"), rid: Type.String(), op: Type.Literal("rotate_token") },
    { additionalProperties: false },
  ),
]);

const HubCtlAckSchema = Type.Object(
  {
    t: Type.Literal("hub_ctl_ack"),
    rid: Type.String(),
    revoked: Type.Optional(Type.Object({ loopback: Type.Integer(), lan: Type.Integer() })),
  },
  { additionalProperties: false },
);

const CmdOriginSchema = Type.Object(
  {
    listener: Type.Union([Type.Literal("loopback"), Type.Literal("lan")]),
    ip: Type.String(),
    user: Type.Optional(Type.String()),
    reqId: Type.String(),
  },
  { additionalProperties: false },
);
const CmdExpectSchema = Type.Object({ sessionId: Type.Optional(Type.String()) }, { additionalProperties: false });
const DialogAnswerSchema = Type.Object(
  { selected: Type.Array(Type.String()), other: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: false },
);
const CommandOutputEntrySchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("notify"),
      Type.Literal("widget"),
      Type.Literal("status"),
      Type.Literal("text"),
      Type.Literal("error"),
      Type.Literal("interactive"),
    ]),
    level: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")])),
    key: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    text: Type.String(),
    clipped: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
const CommandOutputSchema = Type.Object(
  {
    entries: Type.Array(CommandOutputEntrySchema),
    truncated: Type.Optional(Type.Object({ droppedEntries: Type.Integer(), droppedBytes: Type.Integer() })),
    needsTerminal: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
const PromptArgsSchema = Type.Object(
  {
    op: Type.Literal("prompt"),
    text: Type.String(),
    deliver: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
    expect: Type.Optional(CmdExpectSchema),
  },
  { additionalProperties: false },
);
const AbortArgsSchema = Type.Object(
  { op: Type.Literal("abort"), expect: Type.Optional(CmdExpectSchema) },
  { additionalProperties: false },
);
const SteerArgsSchema = Type.Object(
  { op: Type.Literal("steer_subagent"), runId: Type.String(), text: Type.String() },
  { additionalProperties: false },
);
const StopArgsSchema = Type.Object(
  { op: Type.Literal("abort_subagent"), runId: Type.String() },
  { additionalProperties: false },
);
const DialogAnswerArgsSchema = Type.Object(
  {
    op: Type.Literal("dialog_answer"),
    dialogId: Type.String(),
    epoch: Type.String(),
    answers: Type.Array(DialogAnswerSchema),
  },
  { additionalProperties: false },
);
const DialogCancelArgsSchema = Type.Object(
  { op: Type.Literal("dialog_cancel"), dialogId: Type.String(), epoch: Type.String() },
  { additionalProperties: false },
);
const CommandArgsSchema = Type.Object(
  {
    op: Type.Literal("command"),
    name: Type.String({ pattern: "^[A-Za-z0-9:_.-]{1,64}$" }),
    args: Type.String(),
    confirm: Type.Optional(Type.Literal(true)),
    deliver: Type.Optional(Type.Union([Type.Literal("steer"), Type.Literal("followUp")])),
    expect: Type.Optional(CmdExpectSchema),
  },
  { additionalProperties: false },
);
const CmdSchema = Type.Object(
  {
    t: Type.Literal("cmd"),
    rid: Type.String(),
    id: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }),
    deadlineMs: Type.Number(),
    origin: CmdOriginSchema,
    queryOnly: Type.Optional(Type.Literal(true)),
    retry: Type.Optional(Type.Literal(true)),
    cmd: Type.Union([
      PromptArgsSchema,
      AbortArgsSchema,
      SteerArgsSchema,
      StopArgsSchema,
      DialogAnswerArgsSchema,
      DialogCancelArgsSchema,
      CommandArgsSchema,
    ]),
  },
  { additionalProperties: false },
);
const CmdDataSchema = Type.Unknown();
const CmdResultSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal("cmd_result"),
      rid: Type.String(),
      id: Type.String(),
      ok: Type.Literal(true),
      dup: Type.Optional(Type.Literal(true)),
      data: CmdDataSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      t: Type.Literal("cmd_result"),
      rid: Type.String(),
      id: Type.String(),
      ok: Type.Literal(false),
      code: Type.String(),
      message: Type.Optional(Type.String()),
      retryable: Type.Boolean(),
      effect: Type.Union([Type.Literal("none"), Type.Literal("unknown")]),
    },
    { additionalProperties: false },
  ),
]);
const CmdLateSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal("cmd_late"),
      id: Type.String(),
      op: Type.String(),
      at: Type.Number(),
      ok: Type.Literal(true),
      dup: Type.Optional(Type.Literal(true)),
      data: CmdDataSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      t: Type.Literal("cmd_late"),
      id: Type.String(),
      op: Type.String(),
      at: Type.Number(),
      ok: Type.Literal(false),
      code: Type.String(),
      message: Type.Optional(Type.String()),
      retryable: Type.Boolean(),
      effect: Type.Union([Type.Literal("none"), Type.Literal("unknown")]),
    },
    { additionalProperties: false },
  ),
]);
const AskQuestionSchema = Type.Object(
  {
    question: Type.String(),
    header: Type.Optional(Type.String()),
    context: Type.Optional(Type.String()),
    options: Type.Array(
      Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }, { additionalProperties: false }),
    ),
    multiSelect: Type.Optional(Type.Boolean()),
    allowOther: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const DialogOpenSchema = Type.Object(
  {
    dialogId: Type.String(),
    source: Type.Literal("ask_user"),
    toolCallId: Type.String(),
    questions: Type.Array(AskQuestionSchema),
    allowCancel: Type.Boolean(),
    openedAt: Type.Number(),
  },
  { additionalProperties: false },
);
const DialogClosedSchema = Type.Object(
  {
    dialogId: Type.String(),
    by: Type.Union([
      Type.Literal("tui"),
      Type.Literal("web"),
      Type.Literal("abort"),
      Type.Literal("session"),
      Type.Literal("error"),
      // ask-user-async §7.2 (P3): keep in lockstep with DialogClosedWire.by above; hubs that
      // predate it reject the value, so agents downgrade it via the dialog.bg.v1 hub cap.
      Type.Literal("background"),
    ]),
    outcome: Type.Union([Type.Literal("answered"), Type.Literal("cancelled"), Type.Literal("aborted")]),
    cmdId: Type.Optional(Type.String()),
    at: Type.Number(),
  },
  { additionalProperties: false },
);
const DialogsSchema = Type.Object(
  {
    t: Type.Literal("dialogs"),
    epoch: Type.String(),
    open: Type.Array(DialogOpenSchema),
    closed: Type.Array(DialogClosedSchema),
  },
  { additionalProperties: false },
);
const CtlItemSchema = Type.Object(
  {
    cmdId: Type.String(),
    op: Type.Union([
      Type.Literal("prompt"),
      Type.Literal("abort"),
      Type.Literal("steer_subagent"),
      Type.Literal("abort_subagent"),
      Type.Literal("dialog_answer"),
      Type.Literal("dialog_cancel"),
      Type.Literal("command"),
    ]),
    state: Type.Union([
      Type.Literal("dispatched"),
      Type.Literal("observed"),
      Type.Literal("started"),
      Type.Literal("queued"),
      Type.Literal("consumed"),
      Type.Literal("dropped"),
      Type.Literal("unconfirmed"),
      Type.Literal("running"),
      Type.Literal("ok"),
      Type.Literal("failed"),
      Type.Literal("late_ok"),
      Type.Literal("late_failed"),
    ]),
    behavior: Type.Optional(Type.Union([Type.Literal("idle"), Type.Literal("steer"), Type.Literal("followUp")])),
    reason: Type.Optional(
      Type.Union([
        Type.Literal("unobserved"),
        Type.Literal("not-started"),
        Type.Literal("not-delivered"),
        Type.Literal("session"),
        Type.Literal("timeout"),
      ]),
    ),
    code: Type.Optional(Type.String()),
    at: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);
const CtlSchema = Type.Object(
  { t: Type.Literal("ctl"), epoch: Type.String(), sessionId: Type.String(), items: Type.Array(CtlItemSchema) },
  { additionalProperties: false },
);
const CommandInfoSchema = Type.Object(
  {
    name: Type.String(),
    kind: Type.Union([
      Type.Literal("extension"),
      Type.Literal("template"),
      Type.Literal("skill"),
      Type.Literal("builtin"),
    ]),
    description: Type.Optional(Type.String()),
    policy: Type.Union([Type.Literal("allow"), Type.Literal("confirm"), Type.Literal("deny")]),
    policyBusy: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("confirm"), Type.Literal("deny")])),
    output: Type.Optional(Type.Union([Type.Literal("captured"), Type.Literal("terminal")])),
  },
  { additionalProperties: false },
);
const CommandsSchema = Type.Object(
  { t: Type.Literal("commands"), epoch: Type.String(), items: Type.Array(CommandInfoSchema) },
  { additionalProperties: false },
);
const SupersededSchema = Type.Object(
  {
    t: Type.Literal("superseded"),
    nextVersion: Type.String(),
    yieldMs: Type.Number(),
    forced: Type.Optional(Type.Literal(true)),
    openDialogs: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

// `info.lan` is validated loosely (`Type.Unknown()`): `LanStatus` is a discriminated union
// pinned by the exported TS type and by `tests/web-hub/contract/types.test-d.ts`, not
// duplicated here — the same posture as `WireMessageSchema`/`WireEventSchema` for same-
// user-trusted payloads. Every other field is strict (additionalProperties:false).
const LanInfoPayloadSchema = Type.Object(
  {
    username: Type.String(),
    initialPassword: Type.Optional(Type.String()),
    initialLogin: Type.Optional(Type.Object({ ip: Type.String(), at: Type.Number() }, { additionalProperties: false })),
    lan: Type.Unknown(),
  },
  { additionalProperties: false },
);

const LanResOkSchema = Type.Object(
  {
    t: Type.Literal("lan_res"),
    rid: Type.String(),
    ok: Type.Literal(true),
    info: Type.Optional(LanInfoPayloadSchema),
  },
  { additionalProperties: false },
);
const LanResErrSchema = Type.Object(
  {
    t: Type.Literal("lan_res"),
    rid: Type.String(),
    ok: Type.Literal(false),
    code: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);
const LanResSchema = Type.Union([LanResOkSchema, LanResErrSchema]);

const agentFrameSchemas: Readonly<Record<string, TSchema>> = {
  hello: HelloSchema,
  bye: ByeSchema,
  session: SessionFrameSchema,
  session_detached: SessionDetachedSchema,
  ev: EvSchema,
  status: StatusFrameSchema,
  fleet: FleetFrameSchema,
  snapshot_reply: SnapshotReplySchema,
  branch_reply: BranchReplySchema,
  gap: GapSchema,
  ping: PingSchema,
  pong: PongSchema,
  lan_req: LanReqSchema,
  hub_ctl: HubCtlSchema,
  cmd_result: CmdResultSchema,
  cmd_late: CmdLateSchema,
  dialogs: DialogsSchema,
  ctl: CtlSchema,
  commands: CommandsSchema,
  // fleet-drawer §3.1 (F0): schemas imported from protocol/run-transcript.ts
  run_tx_reply: RunTxReplySchema,
  run_ev: RunEvSchema,
  run_gap: RunGapSchema,
  run_end: RunEndSchema,
};

const hubFrameSchemas: Readonly<Record<string, TSchema>> = {
  hello_ack: HelloAckSchema,
  hello_reject: HelloRejectSchema,
  snapshot_req: SnapshotReqSchema,
  branch_req: BranchReqSchema,
  // fleet-drawer §3.1 (F0): schemas imported from protocol/run-transcript.ts
  run_tx_req: RunTxReqSchema,
  run_watch: RunWatchSchema,
  cmd: CmdSchema,
  superseded: SupersededSchema,
  ping: PingSchema,
  pong: PongSchema,
  lan_res: LanResSchema,
  hub_ctl_ack: HubCtlAckSchema,
};

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/** Parse an agent→hub frame; unknown/invalid/oversized frames return undefined (ignored). */
export function decodeAgentFrame(raw: unknown): AgentFrame | undefined {
  return decodeWith(agentFrameSchemas, raw) as AgentFrame | undefined;
}

/** Parse a hub→agent frame; unknown/invalid/oversized frames return undefined (ignored). */
export function decodeHubFrame(raw: unknown): HubFrame | undefined {
  return decodeWith(hubFrameSchemas, raw) as HubFrame | undefined;
}

function decodeWith(schemas: Readonly<Record<string, TSchema>>, raw: unknown): object | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  if (!withinFrameBudget(raw)) return undefined;
  const t = (raw as Record<string, unknown>)["t"];
  if (typeof t !== "string") return undefined;
  const schema = schemas[t];
  if (schema === undefined) return undefined; // unknown t + RESERVED_FRAME_TYPES
  return Value.Check(schema, raw) ? (raw as object) : undefined;
}

/** Total-size guard: serialized length must stay within the ndjson frame budget. */
function withinFrameBudget(raw: unknown): boolean {
  try {
    return JSON.stringify(raw).length <= MAX_FRAME_BYTES;
  } catch {
    return false; // circular / unserializable
  }
}
